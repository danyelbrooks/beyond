/**
 * gmail-client.js — Gmail API client for email sync
 *
 * Handles authentication and email operations against Danyel's Gmail
 * (danyel@bpmsd.com) using OAuth2 with a saved refresh token.
 *
 * Before this will work, you must run the one-time authorization script:
 *
 *   node src/email/gmail-auth.js
 *
 * Required environment variables (add to .env):
 *   GOOGLE_OAUTH_CLIENT_PATH  — path to the OAuth client JSON from Google Cloud Console
 *   GOOGLE_TOKEN_PATH         — path to the saved token file (created by gmail-auth.js)
 *   GOOGLE_DELEGATED_EMAIL    — the Gmail address to send from (danyel@bpmsd.com)
 */

import 'dotenv/config'
import { readFile, writeFile } from 'fs/promises'
import { google }              from 'googleapis'

// =============================================================================
// CONFIG
// =============================================================================

const CLIENT_PATH     = process.env.GOOGLE_OAUTH_CLIENT_PATH
const TOKEN_PATH      = process.env.GOOGLE_TOKEN_PATH
const DELEGATED_EMAIL = process.env.GOOGLE_DELEGATED_EMAIL

function assertConfig() {
  const missing = []
  if (!CLIENT_PATH)     missing.push('GOOGLE_OAUTH_CLIENT_PATH')
  if (!TOKEN_PATH)      missing.push('GOOGLE_TOKEN_PATH')
  if (!DELEGATED_EMAIL) missing.push('GOOGLE_DELEGATED_EMAIL')

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Add them to your .env file. See .env.example for details.'
    )
  }
}

// =============================================================================
// AUTH
// =============================================================================

/**
 * Returns an authenticated Gmail API client using the saved OAuth2 token.
 * Automatically refreshes the access token when it expires and saves the
 * updated token back to disk so the next run still works.
 */
export async function getGmailClient() {
  assertConfig()

  // Read the OAuth client credentials (client_id and client_secret)
  let creds
  try {
    const raw = await readFile(CLIENT_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    creds = parsed.web || parsed.installed
    if (!creds) throw new Error('Unrecognized file format.')
  } catch (err) {
    throw new Error(
      `Could not read OAuth client file at "${CLIENT_PATH}": ${err.message}\n` +
      'Make sure GOOGLE_OAUTH_CLIENT_PATH points to the JSON file downloaded from Google Cloud Console.'
    )
  }

  // Create the OAuth2 client
  const oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    'urn:ietf:wg:oauth:2.0:oob'
  )

  // Read the saved token (created by gmail-auth.js)
  let token
  try {
    const raw = await readFile(TOKEN_PATH, 'utf8')
    token = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `You haven't authorized Gmail yet. Run: node src/email/gmail-auth.js\n` +
      `(Could not read token file at "${TOKEN_PATH}": ${err.message})`
    )
  }

  oauth2Client.setCredentials(token)

  // When the access token is automatically refreshed, save the new token to disk
  // so the refresh token keeps working on future runs.
  oauth2Client.on('tokens', async newTokens => {
    const merged = { ...token, ...newTokens }
    try {
      await writeFile(TOKEN_PATH, JSON.stringify(merged, null, 2), 'utf8')
    } catch (err) {
      // Non-fatal — the current run will still work, but the next run may need re-auth.
      console.warn(`Warning: Could not save refreshed token to "${TOKEN_PATH}": ${err.message}`)
    }
  })

  return google.gmail({ version: 'v1', auth: oauth2Client })
}

// =============================================================================
// FETCH NEW EMAILS
// =============================================================================

/**
 * Fetch emails received after the given timestamp.
 *
 * @param {string|null} since  ISO 8601 datetime string (e.g. "2026-06-01T00:00:00Z").
 *                             Pass null/undefined to fetch the last 30 days.
 * @returns {Array} Normalized email objects ready to upsert into email_cache.
 */
export async function fetchNewEmails(since) {
  const gmail = await getGmailClient()

  // Build the Gmail search query.
  // Gmail's "after:" operator takes a Unix timestamp in seconds.
  let afterTs
  if (since) {
    afterTs = Math.floor(new Date(since).getTime() / 1000)
  } else {
    // Default: last 30 days
    afterTs = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000)
  }

  const query = `after:${afterTs} in:inbox`

  // Step 1 — list message IDs matching the query
  const listRes = await gmail.users.messages.list({
    userId:     'me',
    q:          query,
    maxResults: 50
  })

  const messageItems = listRes.data.messages || []

  if (messageItems.length === 0) {
    return []
  }

  // Step 2 — fetch full message details for each ID
  const emails = []
  for (const item of messageItems) {
    const msgRes = await gmail.users.messages.get({
      userId: 'me',
      id:     item.id,
      format: 'full'
    })

    const msg = msgRes.data
    const subject   = getHeader(msg, 'Subject') || '(no subject)'
    const fromRaw   = getHeader(msg, 'From')    || ''
    const dateRaw   = getHeader(msg, 'Date')    || ''
    const { name: fromName, address: fromAddress } = parseFrom(fromRaw)
    const { html, text } = getBody(msg)

    // body_preview — first 150 chars of plain text
    const bodyPreview = (text || stripHtml(html) || '').slice(0, 150)

    // body_html — prefer HTML, fall back to plain text in <pre>
    const bodyHtml = html || (text ? `<pre>${escapeHtml(text)}</pre>` : '')

    // received_at — prefer internalDate (ms epoch from Gmail) over Date header
    const receivedAt = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : (dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString())

    emails.push({
      m365_message_id: msg.id,       // reusing this field name — stores Gmail message ID
      subject,
      from_address:    fromAddress,
      from_name:       fromName,
      body_preview:    bodyPreview,
      body_html:       bodyHtml,
      received_at:     receivedAt
    })
  }

  return emails
}

// =============================================================================
// SEND NEW EMAIL
// =============================================================================

/**
 * Send a new email (not a reply) from the configured Gmail account.
 *
 * @param {string|string[]} to       Recipient address or array of addresses
 * @param {string}          subject  Email subject line
 * @param {string}          bodyHtml HTML body content
 */
export async function sendEmail(to, subject, bodyHtml) {
  const gmail = await getGmailClient()

  const toList = Array.isArray(to) ? to : [to]
  const toHeader = toList.join(', ')

  const rawLines = [
    `From: ${DELEGATED_EMAIL}`,
    `To: ${toHeader}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    bodyHtml,
  ]

  const rawEmail = rawLines.join('\r\n')

  const encodedRaw = Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  await gmail.users.messages.send({
    userId:      'me',
    requestBody: { raw: encodedRaw },
  })
}

// =============================================================================
// SEND REPLY
// =============================================================================

/**
 * Send a reply to a specific email.
 *
 * @param {string} messageId   The Gmail message ID (stored as m365_message_id)
 * @param {string} replyBody   The plain-text reply body
 */
export async function sendReply(messageId, replyBody) {
  const gmail = await getGmailClient()

  // Fetch the original message to get reply headers
  const origRes = await gmail.users.messages.get({
    userId: 'me',
    id:     messageId,
    format: 'full'
  })

  const orig = origRes.data

  const originalSubject  = getHeader(orig, 'Subject')    || ''
  const originalFrom     = getHeader(orig, 'From')       || ''
  const originalMsgId    = getHeader(orig, 'Message-ID') || ''
  const originalRefs     = getHeader(orig, 'References') || ''
  const threadId         = orig.threadId

  // Build the Re: subject (only add prefix if it isn't there already)
  const replySubject = originalSubject.startsWith('Re:')
    ? originalSubject
    : `Re: ${originalSubject}`

  // Build References header — append the original Message-ID
  const references = originalRefs
    ? `${originalRefs} ${originalMsgId}`.trim()
    : originalMsgId

  // Construct the raw RFC 2822 email
  const rawLines = [
    `From: ${DELEGATED_EMAIL}`,
    `To: ${originalFrom}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${originalMsgId}`,
    `References: ${references}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    replyBody
  ]

  const rawEmail = rawLines.join('\r\n')

  // Gmail requires base64url encoding (no padding issues)
  const encodedRaw = Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw:      encodedRaw,
      threadId: threadId   // keeps the reply in the same Gmail thread
    }
  })
}

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Find a header value by name (case-insensitive) from a Gmail message.
 */
function getHeader(message, name) {
  const headers = message.payload?.headers || []
  const lower   = name.toLowerCase()
  const found   = headers.find(h => h.name.toLowerCase() === lower)
  return found?.value ?? null
}

/**
 * Extract the HTML and plain-text body from a Gmail message payload.
 * Handles simple (non-multipart) and multipart messages.
 * Returns { html, text } — either or both may be null.
 */
function getBody(message) {
  const payload = message.payload
  if (!payload) return { html: null, text: null }

  // Simple non-multipart message
  if (payload.body?.data) {
    const decoded = base64UrlDecode(payload.body.data)
    if (payload.mimeType === 'text/html') return { html: decoded, text: null }
    return { html: null, text: decoded }
  }

  // Multipart — walk the parts array
  const parts = payload.parts || []
  let html = null
  let text = null

  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      html = base64UrlDecode(part.body.data)
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      text = base64UrlDecode(part.body.data)
    } else if (part.mimeType?.startsWith('multipart/') && part.parts) {
      // One level of nesting (e.g. multipart/alternative inside multipart/mixed)
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

/**
 * Parse "Name <email@example.com>" or plain "email@example.com" into parts.
 */
function parseFrom(fromHeader) {
  if (!fromHeader) return { name: '', address: '' }

  const match = fromHeader.match(/^(.*?)\s*<([^>]+)>$/)
  if (match) {
    return {
      name:    match[1].trim().replace(/^["']|["']$/g, ''), // strip surrounding quotes
      address: match[2].trim()
    }
  }

  // No angle brackets — the whole thing is an address
  return { name: '', address: fromHeader.trim() }
}

/** Decode a base64url string to UTF-8 text. */
function base64UrlDecode(data) {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf8')
}

/** Strip HTML tags for plain-text preview generation. */
function stripHtml(html) {
  if (!html) return ''
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Escape HTML special chars for wrapping plain text in <pre>. */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
