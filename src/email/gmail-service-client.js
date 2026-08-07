/**
 * gmail-service-client.js — Gmail API client using a Google service account
 *
 * Uses domain-wide delegation to impersonate any inbox on the bpmsd.com domain.
 * This replaces the per-user OAuth2 approach for multi-inbox sync.
 *
 * Required:
 *   GOOGLE_SERVICE_ACCOUNT_PATH — path to the service account JSON key file
 *   (set in .env, default: ./bpm-service-account.json)
 *
 * The service account must have domain-wide delegation enabled in Google Workspace
 * Admin → Security → API Controls → Domain-wide delegation.
 */

import 'dotenv/config'
import { readFile } from 'fs/promises'
import { google }   from 'googleapis'

// =============================================================================
// CONFIG
// =============================================================================

const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './bpm-service-account.json'

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
]

// =============================================================================
// AUTH
// =============================================================================

/**
 * Returns an authenticated Gmail API client that acts as the given inbox.
 *
 * @param {string} emailAddress  The inbox to impersonate, e.g. "help@bpmsd.com"
 * @returns {google.gmail}       Authenticated Gmail API client
 */
export async function getGmailClientForInbox(emailAddress) {
  let keyFile
  // On Render (production), the JSON is stored as an env var to avoid file system issues.
  // Locally, it falls back to the file path in GOOGLE_SERVICE_ACCOUNT_PATH.
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      keyFile = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    } catch (err) {
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is set but not valid JSON: ${err.message}`)
    }
  } else {
    try {
      const raw = await readFile(SERVICE_ACCOUNT_PATH, 'utf8')
      keyFile = JSON.parse(raw)
    } catch (err) {
      throw new Error(
        `Could not read service account key at "${SERVICE_ACCOUNT_PATH}": ${err.message}\n` +
        'Make sure GOOGLE_SERVICE_ACCOUNT_PATH is set in your .env file.'
      )
    }
  }

  const auth = new google.auth.JWT({
    email:   keyFile.client_email,
    key:     keyFile.private_key,
    scopes:  SCOPES,
    subject: emailAddress  // impersonate this inbox
  })

  return google.gmail({ version: 'v1', auth })
}

// =============================================================================
// SEND REPLY
// =============================================================================

/**
 * Send a reply to an email, from the inbox the email was delivered to.
 *
 * @param {string} toAddress   The inbox to send from (e.g. "help@bpmsd.com") — must match
 *                             the to_address the original email was delivered to
 * @param {string} messageId   The Gmail message ID of the email being replied to
 * @param {string} replyBody   The plain-text reply body
 */
export async function sendReply(toAddress, messageId, replyBody, { subject, cc, bcc } = {}) {
  const gmail = await getGmailClientForInbox(toAddress)

  // Fetch the original message to get reply headers
  const origRes = await gmail.users.messages.get({
    userId: 'me',
    id:     messageId,
    format: 'full'
  })

  const orig = origRes.data

  const originalSubject = getHeader(orig, 'Subject')    || ''
  const originalFrom    = getHeader(orig, 'From')       || ''
  const originalMsgId   = getHeader(orig, 'Message-ID') || ''
  const originalRefs    = getHeader(orig, 'References') || ''
  const threadId        = orig.threadId

  const replySubject = subject?.trim()
    || (originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`)

  // Chain the References header so Gmail threads the reply correctly
  const references = originalRefs
    ? `${originalRefs} ${originalMsgId}`.trim()
    : originalMsgId

  // Construct the raw RFC 2822 email
  const rawLines = [
    `From: ${toAddress}`,
    `To: ${originalFrom}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${originalMsgId}`,
    `References: ${references}`,
    'Content-Type: text/plain; charset=utf-8',
  ]
  if (cc?.trim())  rawLines.push(`Cc: ${cc.trim()}`)
  if (bcc?.trim()) rawLines.push(`Bcc: ${bcc.trim()}`)
  rawLines.push('', replyBody)

  const rawEmail = rawLines.join('\r\n')

  // Gmail requires base64url encoding
  const encodedRaw = Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw:      encodedRaw,
      threadId: threadId
    }
  })
}

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/** Find a header value by name (case-insensitive) from a Gmail message. */
function getHeader(message, name) {
  const headers = message.payload?.headers || []
  const lower   = name.toLowerCase()
  const found   = headers.find(h => h.name.toLowerCase() === lower)
  return found?.value ?? null
}
