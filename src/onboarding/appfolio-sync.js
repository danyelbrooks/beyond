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

const AF_TRUST_ACCOUNT_ID = process.env.APPFOLIO_TRUST_ACCOUNT_ID || 'e6bec046-8097-11eb-8ad9-06457bb955b6'

const PROP_TYPE_MAP = {
  detached_house:    'Single-Family',
  condo:             'Single-Family',
  mobile_home:       'Single-Family',
  '2_4_units':       'Multi-Family',
  apartment_complex: 'Multi-Family',
}

/**
 * POST one owner record to AppFolio.
 * Returns the new owner's AppFolio Id string, or null on failure.
 */
async function createAppFolioOwner(authHeader, payload) {
  const res = await fetch(`${AF_BASE}/owners`, {
    method:  'POST',
    headers: {
      'Authorization':          authHeader,
      'Content-Type':           'application/json',
      'X-AppFolio-Developer-ID': process.env.APPFOLIO_DEVELOPER_ID || '',
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
 * Uses AppFolio's expected top-level address fields.
 */
function buildOwnerPayload({ firstName, lastName, email, phone, street, city, state, zip, isCompany, companyName }) {
  const payload = {}
  if (firstName)   payload.FirstName   = firstName
  if (lastName)    payload.LastName    = lastName
  if (email)       payload.Email       = email
  if (phone)       payload.PhoneNumber = phone
  if (isCompany)   payload.IsCompany   = true
  if (companyName) payload.CompanyName = companyName
  if (street)      payload.Address1    = street
  if (city)        payload.City        = city
  if (state)       payload.State       = state
  if (zip)         payload.Zip         = zip
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
 * Parse a short_address string into components.
 * Expects format: "123 Main St, San Diego CA 92101"
 * or "123 Main St, San Diego, CA 92101"
 */
function parseAddress(shortAddress) {
  if (!shortAddress) return {}
  // Try "Street, City, ST 12345" or "Street, City ST 12345"
  const match = shortAddress.match(/^(.+?),\s*(.+?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/)
  if (match) {
    return { address1: match[1].trim(), city: match[2].trim(), state: match[3].trim(), zip: match[4].trim() }
  }
  // Fallback: use full string as address1 only
  return { address1: shortAddress }
}

/**
 * POST a property to AppFolio via the bulk endpoint (array of one).
 * Returns the new property's AppFolio PropertyId string, or null on failure.
 */
async function createAppFolioProperty(authHeader, onboarding, propType) {
  const { address1, city, state, zip } = parseAddress(onboarding.property_address || onboarding.short_address)

  if (!address1) throw new Error('No address available for property creation')

  const afType = PROP_TYPE_MAP[propType] || 'Single-Family'

  const payload = {
    data: [{
      Name:                     address1,
      ReferenceId:              String(onboarding.id),
      PropertyType:             afType,
      Address1:                 address1,
      City:                     city  || '',
      State:                    state || 'CA',
      Zip:                      zip   || '',
      OperatingCashBankAccountId: AF_TRUST_ACCOUNT_ID,
      EscrowCashBankAccountId:    AF_TRUST_ACCOUNT_ID,
    }],
  }

  const res = await fetch(`${AF_BASE}/properties/bulk`, {
    method:  'POST',
    headers: {
      'Authorization':           authHeader,
      'Content-Type':            'application/json',
      'X-AppFolio-Developer-ID': process.env.APPFOLIO_DEVELOPER_ID || '',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`AppFolio property create failed (${res.status}): ${body.slice(0, 200)}`)
  }

  const data = await res.json()
  return data?.data?.[0]?.PropertyId || null
}

/**
 * Fetch the direct AppFolio URL for a property by its ID.
 * Returns null if the lookup fails — non-fatal.
 */
async function getAppFolioPropertyLink(authHeader, propertyId) {
  try {
    const res = await fetch(`${AF_BASE}/properties?filters[Id]=${propertyId}`, {
      headers: {
        'Authorization':           authHeader,
        'X-AppFolio-Developer-ID': process.env.APPFOLIO_DEVELOPER_ID || '',
      },
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.data?.[0]?.Link || null
  } catch {
    return null
  }
}

// =============================================================================
// CUSTOM FIELD OPTION IDs  (queried from GET /custom_fields 2026-08-05)
// =============================================================================
const CF = {
  additionallyInsured: {
    id:      '6aa49645-670e-11f0-be47-0e89a8475669',
    yes:     'c4e87928-a96c-4d75-81b3-32a039d01bcb',
    no:      '31f3c984-af46-4cd1-a3f7-06d80e70a9be',
    unsure:  '0acaa8b4-d8b9-435d-8f1f-15329fcf69ca',
  },
  surevestor: {
    id:          'da0c8d92-7d7b-11f0-be47-0e89a8475669',
    yes:         '7249c806-8c00-464a-8591-8ea6d87199ee',
    noAddlIns:   '0ab49502-81b2-4505-aa99-b3b98ac60ec5',
    unsure:      '0e77075a-c408-49b4-bb3e-5875097e1061',
  },
  water: {
    id:     '891280ef-650d-11f0-be47-0e89a8475669',
    tenant: '9b79382d-49a7-4337-a8cd-404654dd38c7',
    owner:  '2a209feb-bd46-4839-81a4-428dec3c45ff',
  },
  electricity: {
    id:     '549d9789-650e-11f0-be47-0e89a8475669',
    tenant: '4274b181-efff-4570-a642-c94672563e9d',
    owner:  'f40ece28-c8c3-435b-a9ea-36e22b88eb64',
  },
  gas: {
    id:     'b9a734f7-7194-11f0-be47-0e89a8475669',
    tenant: 'cda3c9eb-6a35-4b22-8fdb-378331367183',
    owner:  'a0a0ef28-6327-41f1-aa17-10bedcd17da9',
  },
  trash: {
    id:     '91fc8198-7193-11f0-be47-0e89a8475669',
    tenant: 'fd643095-6fd9-4922-8ed8-4b0c4012c04a',
    owner:  '0696348c-448c-476a-9eff-9e6794c233cd',
  },
  sewer: {
    id:     '09630e7b-7194-11f0-be47-0e89a8475669',
    tenant: '6e497683-dc45-4975-9e7b-93804996ff7e',
    owner:  '9826abdb-e884-42f3-83cb-3029793a3362',
  },
  solar: {
    id:         '0d176225-650f-11f0-be47-0e89a8475669',
    na:         '0c826b5c-c485-4429-8cf6-24798b2f6070',
    tenantFlat: '9e177289-7616-4b62-bd13-cd42b044b494',
    owner:      '3d4094a4-2e47-4c22-8528-332f9f285ec9',
  },
  hoaName:   { id: '3239eab4-6443-11f0-be47-0e89a8475669' },
  pmaDate:   { id: '242da7bd-6698-11f0-be47-0e89a8475669' },
  poolSpa: {
    id:       'c4d82192-7185-11f0-be47-0e89a8475669',
    pool:     '9dd3fceb-ff0b-4209-b1d7-23955ea475bb',
    spa:      '6d2a4bac-a7b9-4667-8fe4-0ea60ce0513b',
    both:     'dc5e2449-db6a-446a-b96e-26fb961a8bbc',
    na:       'e2c53075-c2b6-43ff-9409-c1d13276659d',
  },
  mgmtType: {
    id:       '65bf5370-007f-11f1-be47-0e89a8475669',
    full:     'aafb6dca-2e8b-468e-9643-f9ac116abf3d',
    tpo:      'e0f2d3d6-1368-475d-9565-53da120f1c31',
    unknown:  'b979cdf7-5406-4f8d-8f8f-02d78fab62c7',
  },
  rentControlled: {
    id:     'c254117b-65bc-11f0-be47-0e89a8475669',
    unsure: '399dde9d-b019-47ab-8bf0-3dfb0cb9b52b',
  },
}

/**
 * Build the custom fields object for PATCH /properties.
 * Each key is a custom field UUID; each value is an option UUID or plain value.
 */
function buildCustomFields(onboarding, s2, insuranceStatus, surevestorApproved) {
  const cf  = {}
  const tp  = Array.isArray(s2.tenantPays) ? s2.tenantPays : []
  const op  = Array.isArray(s2.ownerPays)  ? s2.ownerPays  : []

  // Additionally Insured?
  if (insuranceStatus === 'ADDITIONALLY_INSURED') {
    cf[CF.additionallyInsured.id] = CF.additionallyInsured.yes
  } else if (insuranceStatus) {
    cf[CF.additionallyInsured.id] = CF.additionallyInsured.no
  } else {
    cf[CF.additionallyInsured.id] = CF.additionallyInsured.unsure
  }

  // Surevestor?
  if (surevestorApproved) {
    cf[CF.surevestor.id] = CF.surevestor.yes
  } else if (insuranceStatus === 'ADDITIONALLY_INSURED') {
    cf[CF.surevestor.id] = CF.surevestor.noAddlIns
  } else {
    cf[CF.surevestor.id] = CF.surevestor.unsure
  }

  // Utilities — only set if we know who pays
  if (tp.includes('water'))       cf[CF.water.id]       = CF.water.tenant
  else if (op.includes('water'))  cf[CF.water.id]       = CF.water.owner

  if (tp.includes('electricity'))       cf[CF.electricity.id] = CF.electricity.tenant
  else if (op.includes('electricity'))  cf[CF.electricity.id] = CF.electricity.owner

  if (tp.includes('gas'))       cf[CF.gas.id] = CF.gas.tenant
  else if (op.includes('gas'))  cf[CF.gas.id] = CF.gas.owner

  if (tp.includes('trash'))       cf[CF.trash.id] = CF.trash.tenant
  else if (op.includes('trash'))  cf[CF.trash.id] = CF.trash.owner

  if (tp.includes('sewer'))       cf[CF.sewer.id] = CF.sewer.tenant
  else if (op.includes('sewer'))  cf[CF.sewer.id] = CF.sewer.owner

  // Solar
  const solarStatus = s2.solarStatus || ''
  if (!solarStatus) {
    cf[CF.solar.id] = CF.solar.na
  } else if (tp.includes('solar')) {
    cf[CF.solar.id] = CF.solar.tenantFlat
  } else {
    cf[CF.solar.id] = CF.solar.owner
  }

  // HOA Name (text)
  if (s2.hoaName) cf[CF.hoaName.id] = s2.hoaName

  // PMA effective date = today
  cf[CF.pmaDate.id] = new Date().toISOString().split('T')[0]

  // Pool / Spa
  const amen    = Array.isArray(s2.amenities) ? s2.amenities : []
  const hasPool = amen.includes('amen-backyard-pool')
  const hasSpa  = amen.includes('amen-backyard-spa')
  if (hasPool && hasSpa)   cf[CF.poolSpa.id] = CF.poolSpa.both
  else if (hasPool)        cf[CF.poolSpa.id] = CF.poolSpa.pool
  else if (hasSpa)         cf[CF.poolSpa.id] = CF.poolSpa.spa
  else                     cf[CF.poolSpa.id] = CF.poolSpa.na

  // Management Type
  const agType = onboarding.agreement_type || ''
  cf[CF.mgmtType.id] = agType === 'full_management' ? CF.mgmtType.full
                      : agType === 'tenant_placement' ? CF.mgmtType.tpo
                      : CF.mgmtType.unknown

  // Rent Controlled — default Unsure (cannot be determined from form alone)
  cf[CF.rentControlled.id] = CF.rentControlled.unsure

  return cf
}

/**
 * PATCH an existing property with full details from the onboarding form.
 */
async function updateAppFolioProperty(authHeader, propertyId, onboarding, s2, insuranceStatus, surevestorApproved) {
  const customFields = buildCustomFields(onboarding, s2, insuranceStatus, surevestorApproved)

  const body = { CustomFields: customFields }

  if (s2.yearBuilt)               body.YearBuilt             = parseInt(s2.yearBuilt) || undefined
  if (onboarding.insurance_expiration_date) body.InsuranceExpiration = onboarding.insurance_expiration_date

  // Management start date — today
  body.ManagementStartDate = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

  // Home warranty
  if (s2.homeWarranty === 'yes' || s2.homeWarranty === true) {
    body.HomeWarrantyInfo = {
      CompanyName:   s2.warrantyCompany  || null,
      ContactNumber: s2.warrantyPhone    || null,
      PolicyNumber:  s2.warrantyPolicy   || null,
      Expiration:    s2.warrantyExpiry   || null,
    }
  }

  const res = await fetch(`${AF_BASE}/properties/${propertyId}`, {
    method:  'PATCH',
    headers: {
      'Authorization':           authHeader,
      'Content-Type':            'application/json',
      'X-AppFolio-Developer-ID': process.env.APPFOLIO_DEVELOPER_ID || '',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AppFolio property update failed (${res.status}): ${text.slice(0, 300)}`)
  }
  return true
}

/**
 * Create units for the property via POST /units/bulk.
 * Creates one unit per onboarding.units count.
 * Single-unit: named after the address. Multi-unit: Unit 1, Unit 2, etc.
 */
async function createAppFolioUnits(authHeader, onboarding, s2, propertyId) {
  const { address1, city, state, zip } = parseAddress(onboarding.property_address || onboarding.short_address)
  const unitCount = Math.max(1, parseInt(onboarding.units) || 1)

  const bedroomsRaw = s2.bedrooms || ''
  const bedrooms    = bedroomsRaw === '6+' ? 6 : (parseInt(bedroomsRaw) || undefined)
  const fullBaths   = parseFloat(s2.fullBaths  || 0)
  const halfBaths   = parseFloat(s2.halfBaths  || 0)
  const bathrooms   = (fullBaths + halfBaths * 0.5) || undefined
  const sqft        = parseFloat(s2.squareFootage) || undefined
  const marketRent  = s2.rentAmount ? String(s2.rentAmount) : undefined
  const deposit     = s2.depositType === 'custom' && s2.depositAmountCustom
                        ? parseFloat(s2.depositAmountCustom) || undefined
                        : undefined

  const units = []
  for (let i = 1; i <= unitCount; i++) {
    const name = unitCount === 1
      ? (onboarding.short_address || address1)
      : `Unit ${i}`

    const unit = {
      Name:        name,
      ReferenceId: `${onboarding.id}-unit-${i}`,
      PropertyId:  propertyId,
      Address1:    address1 || '',
      City:        city  || '',
      State:       state || 'CA',
      Zip:         zip   || '',
    }

    if (bedrooms  !== undefined) unit.Bedrooms   = bedrooms
    if (bathrooms !== undefined) unit.Bathrooms  = bathrooms
    if (sqft      !== undefined) unit.SquareFeet = sqft
    if (marketRent)              unit.MarketRent = marketRent
    if (deposit   !== undefined) unit.Deposit    = deposit

    units.push(unit)
  }

  const res = await fetch(`${AF_BASE}/units/bulk`, {
    method:  'POST',
    headers: {
      'Authorization':           authHeader,
      'Content-Type':            'application/json',
      'X-AppFolio-Developer-ID': process.env.APPFOLIO_DEVELOPER_ID || '',
    },
    body: JSON.stringify({ data: units }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AppFolio units create failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  return (data?.data || []).map(u => u.UnitId).filter(Boolean)
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
        const entityType  = onboarding.entity_type || 'individual'
        const isCompany   = entityType === 'business'
        const companyName = isCompany ? onboarding.owner_name : null

        const primaryPayload = buildOwnerPayload({
          firstName: onboarding.owner_first_name || firstName,
          lastName,
          email:       onboarding.owner_email || s2.owner1Email  || null,
          phone:       onboarding.owner_phone || s2.owner1Phone  || null,
          street:      s2.owner1Street || null,
          city:        s2.owner1City   || null,
          state:       s2.owner1State  || null,
          zip:         s2.owner1Zip    || null,
          isCompany,
          companyName,
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
    // D. Create property record in AppFolio
    // -------------------------------------------------------------------------
    let appfolioPropertyId = null
    let appfolioPropertyLink = null

    if (authHeader) {
      try {
        const propType = s2.propType || s2['prop-type'] || ''
        appfolioPropertyId = await createAppFolioProperty(authHeader, onboarding, propType)
        if (appfolioPropertyId) {
          appfolioPropertyLink = await getAppFolioPropertyLink(authHeader, appfolioPropertyId)
          await supabase
            .from('onboardings')
            .update({ appfolio_property_id: String(appfolioPropertyId) })
            .eq('id', onboarding.id)
          console.log(`[AppFolio sync] Property created: ${appfolioPropertyId} for ${onboarding.short_address}`)

          // Update property with full details
          try {
            await updateAppFolioProperty(authHeader, appfolioPropertyId, onboarding, s2, insuranceStatus, surevestorApproved)
            console.log(`[AppFolio sync] Property updated with form details for ${onboarding.short_address}`)
          } catch (err) {
            console.error('[AppFolio sync] Property update failed:', err.message)
            await supabase.from('onboarding_flags').insert({
              onboarding_id: onboarding.id,
              flag_type:     'appfolio_sync_error',
              message:       `AppFolio property update failed for ${onboarding.short_address}: ${err.message}`,
            })
          }

          // Create units with rental details (one per onboarding.units count)
          try {
            const unitIds = await createAppFolioUnits(authHeader, onboarding, s2, appfolioPropertyId)
            if (unitIds.length) console.log(`[AppFolio sync] ${unitIds.length} unit(s) created for ${onboarding.short_address}`)
          } catch (err) {
            console.error('[AppFolio sync] Unit create failed:', err.message)
            await supabase.from('onboarding_flags').insert({
              onboarding_id: onboarding.id,
              flag_type:     'appfolio_sync_error',
              message:       `AppFolio unit create failed for ${onboarding.short_address}: ${err.message}`,
            })
          }
        }
      } catch (err) {
        console.error('[AppFolio sync] Property create failed:', err.message)
        await supabase.from('onboarding_flags').insert({
          onboarding_id: onboarding.id,
          flag_type:     'appfolio_sync_error',
          message:       `AppFolio property create failed for ${onboarding.short_address}: ${err.message}`,
        })
      }
    }

    // -------------------------------------------------------------------------
    // E. Build property entry To Do flag for staff
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

    const propertyNote = appfolioPropertyId
      ? `• AppFolio Property ID: ${appfolioPropertyId} (auto-created ✓)`
      : `• AppFolio property NOT auto-created — enter manually`

    const propertyLinkLine = appfolioPropertyLink
      ? `  1. Open property directly: ${appfolioPropertyLink}`
      : `  1. Open AppFolio → Properties → search "${addr}"`

    const lines = [
      `AppFolio setup for ${addr} (${owner}):`,
      ``,
      `ACTION REQUIRED — Link owner to property:`,
      propertyLinkLine,
      `  2. Open the property → Owners tab → Add Owner`,
      `  3. Search for "${owner}" → set ownership % → Save`,
      ``,
      `Property details:`,
      `• Beds: ${beds}  Baths: ${fullB} full / ${halfB} half`,
      `• Sq Ft: ${sqft}  Year Built: ${yr}`,
      `• Additionally Insured?: ${addlInsured ? 'Yes' : 'No — see insurance flag'}`,
      `• Property Group: ${propertyGroup}`,
      `• Owner ACH bank account: see AppFolio Entry Sheet PDF in Drive`,
      propertyNote,
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
