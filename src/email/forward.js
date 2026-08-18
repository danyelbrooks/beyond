/**
 * forward.js — Forward an email from one BPM inbox to another
 *
 * Used by two callers:
 *   - src/api/server.js       when a person clicks Forward on the triage board
 *   - src/email/classify.js   when Hello@ Forwarding routes an email on its own
 *
 * The email is sent FROM the inbox that originally received it, so replies
 * from the person who picks it up go back to the right place.
 */

import { getGmailClientForInbox } from './gmail-service-client.js'

// =============================================================================
// THE INBOXES WE ARE ALLOWED TO FORWARD TO
//
// This list is the safety net. Nothing can be forwarded anywhere else, so a
// bad rule or a confused AI can never send a resident's email outside BPM.
// =============================================================================

export const BPM_INBOXES = [
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

export function isBpmInbox(address) {
  return BPM_INBOXES.includes(String(address || '').toLowerCase().trim())
}

// =============================================================================
// FORWARD
// =============================================================================

/**
 * Forward one email to another BPM inbox.
 *
 * @param {object}  email             Row from email_cache. Needs to_address,
 *                                    m365_message_id, subject, from_address,
 *                                    from_name, received_at, body_preview,
 *                                    and body_html when fullBody is true.
 * @param {string}  toInbox           Destination BPM inbox.
 * @param {object}  [options]
 * @param {boolean} [options.fullBody=false]  true sends the whole original
 *                                    email as HTML. false sends only the short
 *                                    preview as plain text, which is what the
 *                                    manual Forward button has always done.
 * @param {string}  [options.note]    Optional line added above the forwarded
 *                                    message, e.g. why it was routed here.
 * @returns {Promise<void>}
 * @throws  {Error} if the destination is not a BPM inbox, or Gmail rejects it
 */
export async function forwardEmail(email, toInbox, { fullBody = false, note = '' } = {}) {
  if (!isBpmInbox(toInbox)) {
    throw new Error(`Refusing to forward: ${toInbox} is not a BPM inbox`)
  }
  if (!email?.to_address) {
    throw new Error('Refusing to forward: email has no originating inbox')
  }

  const gmail = await getGmailClientForInbox(email.to_address)

  const subject = email.subject || '(no subject)'
  const fwdSubject = subject.startsWith('Fwd:') ? subject : `Fwd: ${subject}`

  const dateStr = new Date(email.received_at).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  })

  const fromLine = email.from_name
    ? `${email.from_name} <${email.from_address}>`
    : email.from_address

  const raw = fullBody
    ? buildHtmlForward({ email, toInbox, fwdSubject, dateStr, fromLine, subject, note })
    : buildTextForward({ email, toInbox, fwdSubject, dateStr, fromLine, subject })

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: base64Url(raw) }
  })
}

// =============================================================================
// MESSAGE BUILDERS
// =============================================================================

/**
 * Plain-text forward carrying only the preview.
 * This is the original behaviour of the manual Forward button, unchanged.
 */
function buildTextForward({ email, toInbox, fwdSubject, dateStr, fromLine, subject }) {
  const body = [
    `---------- Forwarded message ---------`,
    `From: ${fromLine}`,
    `Date: ${dateStr}`,
    `Subject: ${subject}`,
    `To: ${email.to_address}`,
    ``,
    email.body_preview || '(no preview available)'
  ].join('\r\n')

  return [
    `From: ${email.to_address}`,
    `To: ${toInbox}`,
    `Subject: ${encodeHeader(fwdSubject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrap76(Buffer.from(body, 'utf8').toString('base64'))
  ].join('\r\n')
}

/**
 * HTML forward carrying the entire original email, so whoever receives it can
 * act on it without going back to look up the original.
 */
function buildHtmlForward({ email, toInbox, fwdSubject, dateStr, fromLine, subject, note }) {
  const noteBlock = note
    ? `<p style="margin:0 0 16px 0; padding:10px 12px; background:#f1f5f9; border-left:3px solid #94a3b8; font:14px/1.5 -apple-system,Segoe UI,sans-serif; color:#334155;">${escapeHtml(note)}</p>`
    : ''

  const originalBody = email.body_html
    || (email.body_preview ? `<pre>${escapeHtml(email.body_preview)}</pre>`
                           : '<p><em>(no content)</em></p>')

  const body = [
    `<div style="font:14px/1.5 -apple-system,Segoe UI,sans-serif; color:#0f172a;">`,
    noteBlock,
    `<p style="margin:0 0 4px 0; color:#64748b;">---------- Forwarded message ---------</p>`,
    `<p style="margin:0 0 16px 0; color:#64748b;">`,
    `<strong>From:</strong> ${escapeHtml(fromLine)}<br>`,
    `<strong>Date:</strong> ${escapeHtml(dateStr)}<br>`,
    `<strong>Subject:</strong> ${escapeHtml(subject)}<br>`,
    `<strong>To:</strong> ${escapeHtml(email.to_address)}`,
    `</p>`,
    `<hr style="border:none; border-top:1px solid #e2e8f0; margin:0 0 16px 0;">`,
    originalBody,
    `</div>`
  ].join('')

  return [
    `From: ${email.to_address}`,
    `To: ${toInbox}`,
    `Subject: ${encodeHeader(fwdSubject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrap76(Buffer.from(body, 'utf8').toString('base64'))
  ].join('\r\n')
}

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Email headers must be plain ASCII. A subject containing an accent or an emoji
 * has to be encoded or Gmail rejects the message.
 */
function encodeHeader(value) {
  const str = String(value || '')
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(str)) return str
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`
}

/** Base64 bodies must be broken into lines of at most 76 characters. */
function wrap76(b64) {
  return (b64.match(/.{1,76}/g) || []).join('\r\n')
}

/** Gmail's send endpoint wants base64url, not standard base64. */
function base64Url(raw) {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
