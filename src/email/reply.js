/**
 * reply.js — Send a reply to an email and log the action
 *
 * Usage:
 *   node src/email/reply.js <email_cache_id> "<reply body>"
 *
 * Arguments:
 *   email_cache_id   The UUID of the row in email_cache to reply to
 *   reply body       The text of the reply (quote it if it contains spaces)
 *
 * What it does:
 *   1. Looks up the email in email_cache by ID to get the m365_message_id
 *   2. Sends the reply via the Gmail API
 *   3. Inserts a row in email_actions (action_type = 'replied')
 *   4. Updates the email status to 'handled' in email_cache
 *
 * The ADMIN_USER_ID env var should be set to Danyel's Supabase auth user ID.
 * This is the ID that gets recorded in email_actions.performed_by when the
 * reply is sent from the command line rather than from the browser.
 *
 * Find your user ID in Supabase > Authentication > Users after creating
 * your account, then add it to .env as ADMIN_USER_ID.
 */

import 'dotenv/config'
import { supabase } from '../db/server-client.js'
import { sendReply } from './gmail-client.js'

// =============================================================================
// PARSE ARGUMENTS
// =============================================================================

const [,, emailCacheId, replyBody] = process.argv

if (!emailCacheId || !replyBody) {
  console.error(`
Usage: node src/email/reply.js <email_cache_id> "<reply body>"

Arguments:
  email_cache_id   The UUID from the email_cache table (shown in the Command Center)
  reply body       The text of your reply — wrap it in quotes

Example:
  node src/email/reply.js "abc123-..." "Hi, I have looked into this and will follow up shortly."
`)
  process.exit(1)
}

const ADMIN_USER_ID = process.env.ADMIN_USER_ID
if (!ADMIN_USER_ID) {
  console.error(
    'Error: ADMIN_USER_ID is not set in your .env file.\n' +
    'This should be your Supabase auth user ID (found in Supabase > Authentication > Users).\n' +
    'Add it to .env as: ADMIN_USER_ID=your-user-uuid-here'
  )
  process.exit(1)
}

// =============================================================================
// MAIN
// =============================================================================

async function run() {
  console.log('=== BPM Email Reply ===')
  console.log(`Email cache ID: ${emailCacheId}`)
  console.log('')

  try {
    // Step 1 — Look up the email row to get the Graph API message ID
    const { data: emailRow, error: lookupErr } = await supabase
      .from('email_cache')
      .select('id, m365_message_id, subject, status')
      .eq('id', emailCacheId)
      .single()

    if (lookupErr) {
      if (lookupErr.code === 'PGRST116') {
        throw new Error(`No email found with ID: ${emailCacheId}`)
      }
      throw new Error('Could not look up email: ' + lookupErr.message)
    }

    console.log(`Subject: ${emailRow.subject}`)
    console.log(`Status:  ${emailRow.status}`)
    console.log('')
    console.log('Sending reply...')

    // Step 2 — Send the reply via Graph API
    await sendReply(emailRow.m365_message_id, replyBody)
    console.log('Reply sent.')

    // Step 3 — Log the action in email_actions
    const { error: actionErr } = await supabase
      .from('email_actions')
      .insert({
        email_id:     emailCacheId,
        action_type:  'replied',
        performed_by: ADMIN_USER_ID,
        reply_body:   replyBody
      })

    if (actionErr) {
      // Don't abort — the reply was already sent. Just warn.
      console.warn('Warning: reply sent but could not log to email_actions:', actionErr.message)
    } else {
      console.log('Action logged in email_actions.')
    }

    // Step 4 — Mark the email as handled
    const { error: updateErr } = await supabase
      .from('email_cache')
      .update({ status: 'handled' })
      .eq('id', emailCacheId)

    if (updateErr) {
      console.warn('Warning: could not update email status to "handled":', updateErr.message)
    } else {
      console.log('Email marked as handled.')
    }

    console.log('')
    console.log('Done.')

  } catch (err) {
    console.error('')
    console.error('Reply failed:', err.message || String(err))
    console.error('')
    process.exit(1)
  }
}

run()
