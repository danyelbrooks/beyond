/**
 * sync.js — Pull new emails from all BPM inboxes and save them to Supabase
 *
 * Usage:
 *   node src/email/sync.js
 *
 * How it works:
 *   For each inbox in INBOXES:
 *   1. Checks email_cache for the most recent received_at for that inbox
 *   2. Fetches all emails received after that timestamp from the Gmail API
 *   3. Upserts them into email_cache with to_address set to the inbox
 *   4. Logs progress and moves to the next inbox
 *
 * On the very first run for an inbox (no existing rows) it fetches the
 * last 30 days of email as an initial backfill.
 *
 * This script uses the service role key, which bypasses RLS.
 * Never run this in the browser.
 */

import 'dotenv/config'
import { supabase }              from '../db/server-client.js'
import { getGmailClientForInbox } from './gmail-service-client.js'

// =============================================================================
// INBOXES
// =============================================================================

const INBOXES = [
  'danyel@bpmsd.com',
  'help@bpmsd.com',
  'beyond@bpmsd.com',
  'info@bpmsd.com',
  'accounts@bpmsd.com',
  'success@bpmsd.com',
  'home@bpmsd.com',
  'admin@bpmsd.com',
  'hello@bpmsd.com',
  'care@bpmsd.com',
  'results@bpmsd.com'
]

// =============================================================================
// MAIN
// =============================================================================

async function run() {
  console.log('=== BPM Email Sync ===')
  console.log('Started:', new Date().toLocaleString())
  console.log(`Syncing ${INBOXES.length} inboxes...`)
  console.log('')

  let totalNew = 0

  for (const inbox of INBOXES) {
    try {
      const count = await syncInbox(inbox)
      totalNew += count
    } catch (err) {
      // One inbox failing should not stop the others
      console.error(`  ERROR syncing ${inbox}: ${err.message || String(err)}`)
    }
  }

  console.log('')
  console.log(`Sync complete: ${totalNew} new email(s) saved across all inboxes.`)
  console.log('Finished:', new Date().toLocaleString())
}

// =============================================================================
// SYNC ONE INBOX
// =============================================================================

/**
 * Syncs a single inbox. Returns the number of new emails saved.
 *
 * @param {string} inbox  The email address to sync, e.g. "help@bpmsd.com"
 * @returns {number}      Count of new emails saved
 */
async function syncInbox(inbox) {
  process.stdout.write(`Syncing ${inbox}... `)

  // Step 1 — Find the most recent email we already have for this specific inbox
  const { data: latest, error: latestErr } = await supabase
    .from('email_cache')
    .select('received_at')
    .eq('to_address', inbox)
    .order('received_at', { ascending: false })
    .limit(1)
    .single()

  // PGRST116 = no rows found — that's fine on first run
  if (latestErr && latestErr.code !== 'PGRST116') {
    throw new Error('Could not query email_cache: ' + latestErr.message)
  }

  const since = latest?.received_at ?? null

  // Step 2 — Fetch from Gmail API
  const emails = await fetchEmailsForInbox(inbox, since)

  // Step 3 — Upsert in batches of 100 to avoid timeouts
  let savedCount = 0

  if (emails.length > 0) {
    const rows = emails.map(e => ({ ...e, to_address: inbox }))
    const BATCH = 100

    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH)
      const { data: upserted, error: upsertErr } = await supabase
        .from('email_cache')
        .upsert(chunk, { onConflict: 'm365_message_id', ignoreDuplicates: true })
        .select('id')

      if (upsertErr) {
        throw new Error('Could not save emails to Supabase: ' + upsertErr.message)
      }
      savedCount += upserted?.length ?? 0
    }
  }

  console.log(`${savedCount} new email(s)`)

  // Step 4 — Detect emails archived in Gmail and auto-resolve them in Supabase
  try {
    const gmail = await getGmailClientForInbox(inbox)

    // Fetch up to 100 most recent active emails — these are the ones users are working
    const { data: activeEmails } = await supabase
      .from('email_cache')
      .select('id, m365_message_id')
      .in('status', ['new', 'assigned'])
      .eq('to_address', inbox)
      .order('received_at', { ascending: false })
      .limit(100)

    if (activeEmails && activeEmails.length > 0) {
      // Check all messages in parallel — minimal format to keep it fast
      const results = await Promise.all(
        activeEmails.map(async (em) => {
          try {
            const msg = await gmail.users.messages.get({
              userId: 'me',
              id:     em.m365_message_id,
              format: 'minimal'
            })
            const hasInbox = (msg.data.labelIds || []).includes('INBOX')
            return hasInbox ? null : em.id
          } catch (e) {
            // 404 = deleted or trashed — resolve it in the dashboard
            if (e?.response?.status === 404 || e?.code === 404) return em.id
            return null  // other errors — skip
          }
        })
      )

      const archivedIds = results.filter(Boolean)

      if (archivedIds.length > 0) {
        await supabase
          .from('email_cache')
          .update({ status: 'handled' })
          .in('id', archivedIds)

        console.log(`  Auto-resolved ${archivedIds.length} email(s) archived in Gmail`)
      }
    }
  } catch (err) {
    // Archive check is non-fatal — log and continue
    console.warn(`  [archive check] Error for ${inbox}: ${err.message}`)
  }

  return savedCount
}

export { run as syncEmails }

// =============================================================================
// FETCH EMAILS FOR ONE INBOX
// =============================================================================

/**
 * Fetch emails for a single inbox received after the given timestamp.
 *
 * @param {string}      inbox  The email address to impersonate
 * @param {string|null} since  ISO 8601 string, or null to fetch the last 30 days
 * @returns {Array}            Normalized email objects ready to upsert
 */
async function fetchEmailsForInbox(inbox, since) {
  const gmail = await getGmailClientForInbox(inbox)

  // Gmail's "after:" operator takes a Unix timestamp in seconds
  let afterTs
  if (since) {
    afterTs = Math.floor(new Date(since).getTime() / 1000)
  } else {
    // Default: all emails (from the beginning of Gmail time — Jan 1, 2004)
    afterTs = Math.floor(new Date('2004-01-01').getTime() / 1000)
  }

  const query = `after:${afterTs} -in:spam -in:trash`

  // List ALL message IDs matching the query — paginate until done
  const messageItems = []
  let pageToken = undefined

  do {
    const listRes = await gmail.users.messages.list({
      userId:     'me',
      q:          query,
      maxResults: 500,
      ...(pageToken ? { pageToken } : {})
    })
    const page = listRes.data.messages || []
    messageItems.push(...page)
    pageToken = listRes.data.nextPageToken
    if (pageToken) {
      process.stdout.write(` (${messageItems.length} found so far, fetching more...)`)
    }
  } while (pageToken)

  if (messageItems.length === 0) return []

  // Fetch full message details for each ID
  const emails = []
  for (const item of messageItems) {
    const msgRes = await gmail.users.messages.get({
      userId: 'me',
      id:     item.id,
      format: 'full'
    })

    const msg      = msgRes.data
    const subject  = getHeader(msg, 'Subject') || '(no subject)'
    const fromRaw  = getHeader(msg, 'From')    || ''
    const dateRaw  = getHeader(msg, 'Date')    || ''
    const { name: fromName, address: fromAddress } = parseFrom(fromRaw)
    const { html, text } = getBody(msg)

    const bodyPreview = sanitize((text || stripHtml(html) || '').slice(0, 150))
    const rawHtml     = html || (text ? `<pre>${escapeHtml(text)}</pre>` : '')
    const trimmed     = rawHtml.length > 500000 ? rawHtml.slice(0, 500000) + '<!-- truncated -->' : rawHtml
    const bodyHtml    = sanitize(trimmed)

    const receivedAt = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : (dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString())

    const labelIds  = msg.labelIds || []
    const inInbox   = labelIds.includes('INBOX')
    const attachments = getAttachments(msg)

    emails.push({
      m365_message_id: sanitize(msg.id),
      subject:         sanitize(subject),
      from_address:    sanitize(fromAddress),
      from_name:       sanitize(fromName),
      body_preview:    bodyPreview,
      body_html:       bodyHtml,
      received_at:     receivedAt,
      in_inbox:        inInbox,
      attachments:     attachments.length > 0 ? attachments : null
    })
  }

  return emails
}

// =============================================================================
// PRIVATE HELPERS  (same logic as gmail-client.js)
// =============================================================================

function getHeader(message, name) {
  const headers = message.payload?.headers || []
  const lower   = name.toLowerCase()
  const found   = headers.find(h => h.name.toLowerCase() === lower)
  return found?.value ?? null
}

function getBody(message) {
  const payload = message.payload
  if (!payload) return { html: null, text: null }

  if (payload.body?.data) {
    const decoded = base64UrlDecode(payload.body.data)
    if (payload.mimeType === 'text/html') return { html: decoded, text: null }
    return { html: null, text: decoded }
  }

  const parts = payload.parts || []
  let html = null
  let text = null

  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      html = base64UrlDecode(part.body.data)
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      text = base64UrlDecode(part.body.data)
    } else if (part.mimeType?.startsWith('multipart/') && part.parts) {
      for (const subpart of part.parts) {
        if (subpart.mimeType === 'text/html' && subpart.body?.data && !html) {
          html = base64UrlDecode(subpart.body.data)
        } else if (subpart.mimeType === 'text/plain' && subpart.body?.data && !text) {
          text = base64UrlDecode(subpart.body.data)
        }
      }
    }
  }

  return { html, text }
}

function getAttachments(message) {
  const attachments = []
  function scanParts(parts) {
    for (const part of (parts || [])) {
      if (part.filename && part.filename.length > 0) {
        attachments.push({
          filename:     sanitize(part.filename),
          mimeType:     part.mimeType || 'application/octet-stream',
          size:         part.body?.size || 0,
          attachmentId: part.body?.attachmentId || null
        })
      }
      if (part.parts) scanParts(part.parts)
    }
  }
  scanParts(message.payload?.parts || [])
  return attachments
}

function parseFrom(fromHeader) {
  if (!fromHeader) return { name: '', address: '' }
  const match = fromHeader.match(/^(.*?)\s*<([^>]+)>$/)
  if (match) {
    return {
      name:    match[1].trim().replace(/^["']|["']$/g, ''),
      address: match[2].trim()
    }
  }
  return { name: '', address: fromHeader.trim() }
}

function base64UrlDecode(data) {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf8')
}

function stripHtml(html) {
  if (!html) return ''
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function sanitize(str) {
  if (!str) return ''
  // Remove null bytes and other control characters that break PostgreSQL JSON
  return String(str).replace(/ /g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

