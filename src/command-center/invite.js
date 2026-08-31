/**
 * invite.js — Send a Supabase Auth invitation to a new team member
 *
 * Usage:
 *   node src/command-center/invite.js "email@domain.com" "Display Name" "staff|manager"
 *
 * Requires the service role key (set in .env as SUPABASE_SERVICE_ROLE_KEY).
 * The invited person receives an email with a link to set their password.
 *
 * Note: The profile row is created automatically by the trg_auth_users_create_profile
 * trigger in migration 004, which uses raw_user_meta_data.display_name if provided.
 * This script then updates the role to whatever was passed in.
 */

import 'dotenv/config'
import { supabase } from '../db/server-client.js'

// =============================================================================
// PARSE ARGUMENTS
// =============================================================================

const [,, email, displayName, role] = process.argv

const VALID_ROLES = ['staff', 'manager', 'onboarding']

if (!email || !displayName || !role) {
  console.error(`
Usage: node src/command-center/invite.js "email@domain.com" "Display Name" "staff|manager|onboarding"

Arguments:
  email        The email address to send the invitation to
  displayName  The person's full name (shown in the Command Center)
  role         One of: staff, manager, onboarding

Note: admin role cannot be granted through this script. Update the role
directly in Supabase or via the admin panel after the account is created.
`)
  process.exit(1)
}

if (!VALID_ROLES.includes(role)) {
  console.error(`Error: role must be "staff", "manager", or "onboarding". Got: "${role}"`)
  console.error('Admin role cannot be granted through the invite script.')
  process.exit(1)
}

// Basic email format check
if (!email.includes('@') || !email.includes('.')) {
  console.error(`Error: "${email}" does not look like a valid email address.`)
  process.exit(1)
}

// =============================================================================
// SEND INVITE
// =============================================================================

console.log(`Inviting: ${email} (${displayName}) as ${role}...`)

try {
  // Step 1 — Send the Supabase Auth invitation email.
  // Supabase will email the user a magic link to set their password.
  // The display_name in raw_user_meta_data is picked up by the
  // trg_auth_users_create_profile trigger and used to pre-fill the profile row.
  const { data: inviteData, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
    email,
    {
      data: { display_name: displayName },
      redirectTo: 'https://app.bpmsd.com',
    }
  )

  if (inviteError) {
    console.error('Invite failed:', inviteError.message)
    process.exit(1)
  }

  const userId = inviteData.user?.id
  if (!userId) {
    console.error('Invite sent but no user ID returned. Check Supabase dashboard.')
    process.exit(1)
  }

  console.log(`Invitation email sent. User ID: ${userId}`)

  // Step 2 — The trigger creates the profile row with role='staff' by default.
  // If the requested role is different, update it now.
  if (role !== 'staff') {
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ role, display_name: displayName })
      .eq('id', userId)

    if (profileError) {
      // The profile may not exist yet if the trigger hasn't fired.
      // Try inserting instead.
      const { error: insertError } = await supabase
        .from('profiles')
        .insert({ id: userId, display_name: displayName, role })

      if (insertError) {
        console.error(`Warning: could not set role to "${role}": ${insertError.message}`)
        console.error('The user was invited but their role defaulted to "staff".')
        console.error('Update their role manually in the Command Center admin panel.')
        process.exit(1)
      }
    }

    console.log(`Role set to: ${role}`)
  } else {
    // Ensure display_name is correct in case trigger fires slightly differently
    await supabase
      .from('profiles')
      .upsert({ id: userId, display_name: displayName, role: 'staff' })
  }

  console.log('')
  console.log('Done. The invitation has been sent to:')
  console.log(`  Email:   ${email}`)
  console.log(`  Name:    ${displayName}`)
  console.log(`  Role:    ${role}`)
  console.log('')
  console.log('They will receive an email to set their password and log in.')

} catch (err) {
  console.error('Unexpected error:', err.message || String(err))
  process.exit(1)
}
