/**
 * appfolio-sync.js — Push completed onboarding data to AppFolio (Stack API)
 *
 * Called once per onboarding, from completeOnboarding() in server.js.
 * Non-fatal: all errors are caught, logged, and surfaced as onboarding_flags.
 *
 * Stack API base: https://beyondpm.appfolio.com/api/v1
 * Auth: HTTP Basic — base64(clientId:clientSecret)
 *
 * Does NOT use the Reports API (api.appfolio.com) — that is read-only.
 * Does NOT store SSN, EIN, routing numbers, or bank account numbers.
 */

const AF_BASE = 'https://api.appfolio.com/api/v0'

// Build the Basic auth header once at module load.
// Returns null if credentials are missing (will be caught and flagged).
function buildAuthHeader() {
  const clientId     = process.env.APPFOLIO_STACK_CLIENT_ID
  const clientSecret = process.env.APPFOLIO_STACK_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
}

/**
 * POST one owner record to AppFolio.
 * Returns the new owner's AppFolio Id string, or null on failure.
 */
async function createAppFolioOwner(authHeader, payload) {
  const res = await fetch(`${AF_BASE}/owners`, {
    method:  'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`AppFolio owner create failed (${res.status}): ${body.slice(0, 200)}`)
  }

  const data = await res.json()
  // The Stack API returns the created object; Id is the owner identifier.
  return data?.Id || data?.id || null
}

/**
 * Build an owner payload from flat field values.
 * Omits MailingAddress entirely if no street is available.
 */
function buildOwnerPayload({ firstName, lastName, email, phone, street, city, state, zip }) {
  const payload = {}
  if (firstName) payload.FirstName = firstName
  if (lastName)  payload.LastName  = lastName
  if (email)     payload.Email     = email
  if (phone)     payload.Phone     = phone

  if (street) {
    payload.MailingAddress = { Street: street }
    if (city)  payload.MailingAddress.City  = city
    if (state) payload.MailingAddress.State = state
    if (zip)   payload.MailingAddress.Zip   = zip
  }

  return payload
}

/**
 * Derive first/last from a full name string (splits on last space).
 * e.g. "Sarah Jane Smith" → { firstName: "Sarah Jane", lastName: "Smith" }
 */
function splitName(fullName) {
  if (!fullName) return { firstName: '', lastName: '' }
  const idx = fullName.lastIndexOf(' ')
  if (idx === -1) return { firstName: fullName, lastName: '' }
  return {
    firstName: fullName.slice(0, idx).trim(),
    lastName:  fullName.slice(idx + 1).trim(),
  }
}

/**
 * Main export.
 *
 * @param {object} onboarding  — full row from the onboardings table
 * @param {object} supabase    — Supabase client (service role)
 */
export async function syncToAppFolio(onboarding, supabase) {
  try {
    const authHeader = buildAuthHeader()

    // -------------------------------------------------------------------------
    // A. Fetch step 2 data_json for property details and additional owners
    // -------------------------------------------------------------------------
    const { data: step2Row } = await supabase
      .from('onboarding_steps')
      .select('data_json')
      .eq('onboarding_id', onboarding.id)
      .eq('step_number', 2)
      .single()

    const s2 = step2Row?.data_json || {}

    // -------------------------------------------------------------------------
    // B. Fetch step 5 data for insurance status
    // -------------------------------------------------------------------------
    const insuranceStatus   = onboarding.insurance_coverage_status || null
    const insuranceCompany  = onboarding.insurance_company         || null
    const surevestorApproved = onboarding.insurance_surevestor_approved || false

    // -------------------------------------------------------------------------
    // C. Create owner record(s) in AppFolio
    // -------------------------------------------------------------------------
    let primaryOwnerId = null

    if (!authHeader) {
      console.warn('[AppFolio sync] Missing APPFOLIO_STACK_CLIENT_ID or APPFOLIO_STACK_CLIENT_SECRET — skipping owner sync')
    } else {
      // --- Primary owner ---
      try {
        const { firstName, lastName } = splitName(onboarding.owner_name)
        const primaryPayload = buildOwnerPayload({
          firstName,
          lastName,
          email:  onboarding.owner_email  || null,
          phone:  onboarding.owner_phone  || null,
          street: onboarding.owner_mailing_address || null, // single string → Street only
          city:   null,
          state:  null,
          zip:    null,
        })
        primaryOwnerId = await createAppFolioOwner(authHeader, primaryPayload)
        if (primaryOwnerId) {
          await supabase
            .from('onboardings')
            .update({ appfolio_owner_id: String(primaryOwnerId) })
            .eq('id', onboarding.id)
          console.log(`[AppFolio sync] Owner created: ${primaryOwnerId} for ${onboarding.short_address}`)
        }
      } catch (err) {
        console.error('[AppFolio sync] Primary owner create failed:', err.message)
        await supabase.from('onboarding_flags').insert({
          onboarding_id: onboarding.id,
          flag_type:     'appfolio_sync_error',
          message:       `AppFolio primary owner create failed for ${onboarding.short_address}: ${err.message}`,
        })
      }

      // --- Additional owners (2, 3, 4) — present only if owner was entered in step 2 ---
      for (const n of [2, 3, 4]) {
        const first = s2[`owner${n}First`]
        const last  = s2[`owner${n}Last`]
        if (!first && !last) continue

        try {
          const addlPayload = buildOwnerPayload({
            firstName: first || null,
            lastName:  last  || null,
            email:  s2[`owner${n}Email`]  || null,
            phone:  s2[`owner${n}Phone`]  || null,
            street: s2[`owner${n}Street`] || null,
            city:   s2[`owner${n}City`]   || null,
            state:  s2[`owner${n}State`]  || null,
            zip:    s2[`owner${n}Zip`]    || null,
          })
          const addlId = await createAppFolioOwner(authHeader, addlPayload)
          if (addlId) {
            console.log(`[AppFolio sync] Owner ${n} created: ${addlId} for ${onboarding.short_address}`)
          }
        } catch (err) {
          console.error(`[AppFolio sync] Owner ${n} create failed:`, err.message)
          await supabase.from('onboarding_flags').insert({
            onboarding_id: onboarding.id,
            flag_type:     'appfolio_sync_error',
            message:       `AppFolio owner ${n} create failed for ${onboarding.short_address}: ${err.message}`,
          })
        }
      }
    }

    // -------------------------------------------------------------------------
    // D. Build property entry To Do flag for staff
    // -------------------------------------------------------------------------
    const addr    = onboarding.short_address || onboarding.property_address
    const owner   = onboarding.owner_name

    // Property detail fields live in step 2 data_json
    const beds     = s2.bedrooms      || '—'
    const fullB    = s2.fullBaths      || '—'
    const halfB    = s2.halfBaths      || '—'
    const sqft     = s2.squareFootage  || '—'
    const yr       = s2.yearBuilt      || '—'

    const addlInsured = insuranceStatus === 'ADDITIONALLY_INSURED'
    let propertyGroup = ''
    if (addlInsured && insuranceCompany) {
      propertyGroup = insuranceCompany
    } else if (surevestorApproved) {
      propertyGroup = 'Surevestor'
    } else {
      propertyGroup = 'leave as-is'
    }

    const lines = [
      `AppFolio property entry for ${addr} (${owner}):`,
      `• Beds: ${beds}  Baths: ${fullB} full / ${halfB} half`,
      `• Sq Ft: ${sqft}  Year Built: ${yr}`,
      `• Additionally Insured?: ${addlInsured ? 'Yes' : 'No — see insurance flag'}`,
      `• Property Group: ${propertyGroup}`,
      `• Owner ACH bank account: see AppFolio Entry Sheet PDF in Drive`,
    ]

    if (surevestorApproved) {
      lines.push('• Set up $25/mo recurring charge for Surevestor')
    }

    await supabase.from('onboarding_flags').insert({
      onboarding_id: onboarding.id,
      flag_type:     'appfolio_property_entry',
      message:       lines.join('\n'),
    })

    console.log(`[AppFolio sync] Property entry flag created for ${addr}`)

  } catch (err) {
    // Catch-all — this function must never throw
    console.error('[AppFolio sync] Unexpected error:', err.message)
    try {
      await supabase.from('onboarding_flags').insert({
        onboarding_id: onboarding.id,
        flag_type:     'appfolio_sync_error',
        message:       `AppFolio sync unexpected error for ${onboarding.short_address}: ${err.message}`,
      })
    } catch {
      // Nothing left to do if even the flag insert fails
    }
  }
}
