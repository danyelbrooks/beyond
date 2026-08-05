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

// =============================================================================
// PROPERTY GROUP IDs  (queried from GET /property_groups 2026-08-05)
// =============================================================================
const PG = {
  surevestor:    '8479aaf6-15c3-11ee-b1b4-064024c5b8e5',
  tpo:           '900626db-e86f-11ec-aad1-069cac18f164',
  hoaYes:        '89b6ee27-f3f2-11ef-be47-0e89a8475669',
  hoaNo:         '95733583-f3f2-11ef-be47-0e89a8475669',
  poolSpaInUnit:     '9982cedf-101e-11ed-9b0a-029486758335',
  ftbWithholding:    '900611a1-e86f-11ec-aad1-069cac18f164',
  ftbCa590:          '556a1064-767f-11ed-9b0a-029486758335',

  // Referral source groups
  referral: {
    currentClient:   '8f01b353-eca0-11ee-b1b4-064024c5b8e5',
    realtorOther:    'c065a2a3-eca0-11ee-b1b4-064024c5b8e5',
    pastResident:    'f32455ca-eca0-11ee-b1b4-064024c5b8e5',
    onlineOther:     'faae78d9-eca0-11ee-b1b4-064024c5b8e5',
    google:          '0d00fdc7-eca1-11ee-b1b4-064024c5b8e5',
    yelp:            '13644ee7-eca1-11ee-b1b4-064024c5b8e5',
    unknown:         'c0a241fa-eca1-11ee-b1b4-064024c5b8e5',
    danyelsFriend:   'ec1b82d0-eca3-11ee-b1b4-064024c5b8e5',
    // Named realtors — keyed by lowercase keyword in referralContact
    realtors: {
      'melissa tucci':    '9f64d930-eca0-11ee-b1b4-064024c5b8e5',
      'greg cummings':    'a7cc96cf-eca0-11ee-b1b4-064024c5b8e5',
      'jeff sills':       'b1108977-eca0-11ee-b1b4-064024c5b8e5',
      'tammy robbins':    'b8e9b6e1-eca0-11ee-b1b4-064024c5b8e5',
      'bryan devore':     'e181530a-eca0-11ee-b1b4-064024c5b8e5',
      'wendy fleming':    '8130e7b2-21d8-11ef-b1b4-064024c5b8e5',
      'stephanie rivera': '994c3866-7797-11ef-b1b4-064024c5b8e5',
      'jennifer anderson':'bf075551-a7b3-11ef-be47-0e89a8475669',
      'judith slaten':    'e0bb7b36-a948-11ef-be47-0e89a8475669',
    },
  },

  // Additionally insured — keyed by lowercase keyword found in insurance company name
  insurance: {
    'state farm':          '9d0b7093-15c3-11ee-b1b4-064024c5b8e5',
    'pacific specialty':   'ab0133ba-15c4-11ee-b1b4-064024c5b8e5',
    'american banker':     'e8b334b6-15ee-11ee-b1b4-064024c5b8e5',
    'mercury':             'b925a09e-1c26-11ee-b1b4-064024c5b8e5',
    'foremost':            'db966d65-2113-11ee-b1b4-064024c5b8e5',
    'spinnaker':           '5fecc70d-21f4-11ee-b1b4-064024c5b8e5',
    'usaa':                '97b7d4fa-2279-11ee-b1b4-064024c5b8e5',
    'liberty mutual':      '3d3708f7-36fb-11ee-b1b4-064024c5b8e5',
    'mount vernon':        '91e24221-4229-11ee-b1b4-064024c5b8e5',
    'bamboo':              '4f1754f2-422a-11ee-b1b4-064024c5b8e5',
    'travelers':           'fe463074-4782-11ee-b1b4-064024c5b8e5',
    'farmers':             'f539a6f9-4786-11ee-b1b4-064024c5b8e5',
    'sutton national':     'ab897011-6e6a-11f0-be47-0e89a8475669',
    'sutton':              'e5ad8a97-4788-11ee-b1b4-064024c5b8e5',
    'american national':   '2b920f54-4e79-11ee-b1b4-064024c5b8e5',
    'ken may':             'efac3bfd-64bf-11ee-b1b4-064024c5b8e5',
    'safeco':              '246e12be-64c0-11ee-b1b4-064024c5b8e5',
    'allstate':            '1fbcde35-6dd0-11ee-b1b4-064024c5b8e5',
    'assurant':            'eeaa184c-889b-11ee-b1b4-064024c5b8e5',
    'first cap':           'ab0a5cc7-9884-11ee-b1b4-064024c5b8e5',
    'standard fire':       '427e3c95-477f-11ee-b1b4-064024c5b8e5',
    'kw specialty':        '2935a1e2-c098-11ee-b1b4-064024c5b8e5',
    'aaa':                 'f655149a-068c-11ef-b1b4-064024c5b8e5',
    'acord':               '5cfb5c9b-5c17-11ef-b1b4-064024c5b8e5',
    'evanston':            '79713987-6574-11ef-b1b4-064024c5b8e5',
    'accelerant':          '5777d38d-70a7-11ef-b1b4-064024c5b8e5',
    'kirk miller':         '0d8b09fc-f644-11ef-be47-0e89a8475669',
    'michael kennedy':     'b8ee4744-1670-11f0-be47-0e89a8475669',
    'amica':               '76ecf4a4-62a6-11f0-be47-0e89a8475669',
    'stillwater':          'a2c300dc-6987-11f0-be47-0e89a8475669',
    'california capital':  'd9241958-6dab-11f0-be47-0e89a8475669',
    'obie':                '50d77f81-88f7-11f0-be47-0e89a8475669',
    'atlantic casualty':   '7e528008-9a8e-11f0-be47-0e89a8475669',
  },
}

/**
 * Determine which AppFolio property groups this property belongs in,
 * then add it to each one. Non-fatal per group — a failure on one group
 * does not stop the others.
 *
 * PATCH /property_groups replaces the full PropertyIds array, so we must
 * read the current list first, append, then write back.
 */
async function addToAppFolioPropertyGroups(authHeader, propertyId, onboarding, s2, s3, insuranceStatus, surevestorApproved) {
  const headers = {
    'Authorization':           authHeader,
    'Content-Type':            'application/json',
    'X-AppFolio-Developer-ID': process.env.APPFOLIO_DEVELOPER_ID || '',
  }

  // Build the list of group IDs this property should belong to
  const targets = []

  if (surevestorApproved) targets.push(PG.surevestor)

  if (insuranceStatus === 'ADDITIONALLY_INSURED' && onboarding.insurance_company) {
    const lower = onboarding.insurance_company.toLowerCase()
    // Check 'sutton national' before 'sutton' so the longer match wins
    for (const [keyword, groupId] of Object.entries(PG.insurance)) {
      if (lower.includes(keyword)) { targets.push(groupId); break }
    }
  }

  if (onboarding.agreement_type === 'tenant_placement') targets.push(PG.tpo)

  const hasHoa = !!(s2.hoaName || (Array.isArray(s2.ownerPays) && s2.ownerPays.includes('hoa')))
  targets.push(hasHoa ? PG.hoaYes : PG.hoaNo)

  const amen = Array.isArray(s2.amenities) ? s2.amenities : []
  if (amen.includes('amen-backyard-pool') || amen.includes('amen-backyard-spa')) {
    targets.push(PG.poolSpaInUnit)
  }

  // Referral source
  const refSource  = s2.referralSource || ''
  const refContact = (s2.referralContact || '').toLowerCase()
  if (refSource === 'current_client') {
    targets.push(PG.referral.currentClient)
  } else if (refSource === 'google') {
    targets.push(PG.referral.google)
  } else if (refSource === 'yelp') {
    targets.push(PG.referral.yelp)
  } else if (refSource === 'realtor') {
    let matched = false
    for (const [name, groupId] of Object.entries(PG.referral.realtors)) {
      if (refContact.includes(name)) { targets.push(groupId); matched = true; break }
    }
    if (!matched) targets.push(PG.referral.realtorOther)
  } else if (refSource === 'other') {
    targets.push(PG.referral.onlineOther)
  } else {
    targets.push(PG.referral.unknown)
  }

  // FTB withholding — based on CA residency answers from step 3
  const s3owners = Array.isArray(s3?.owners) ? s3.owners : []
  if (s3owners.length > 0) {
    const anyNonResident = s3owners.some(o => o.caResident === false)
    if (anyNonResident) {
      targets.push(PG.ftbWithholding)
    } else if (s3owners.every(o => o.caResident === true)) {
      targets.push(PG.ftbCa590)
    }
  }

  for (const groupId of targets) {
    try {
      // Read current group membership
      const getRes = await fetch(
        `${AF_BASE}/property_groups?filters[Id]=${groupId}&page[size]=1`,
        { headers }
      )
      if (!getRes.ok) throw new Error(`GET group failed (${getRes.status})`)
      const getData = await getRes.json()
      const group = getData?.data?.[0]
      if (!group) throw new Error(`Group ${groupId} not found`)

      // PropertyIds comes back as array-of-arrays; flatten and dedupe
      const current = (group.PropertyIds || []).flat().filter(Boolean)
      if (current.includes(propertyId)) {
        console.log(`[AppFolio sync] Property already in group: ${group.Name}`)
        continue
      }

      const patchRes = await fetch(`${AF_BASE}/property_groups/${groupId}`, {
        method:  'PATCH',
        headers,
        body: JSON.stringify({ PropertyIds: [...current, propertyId] }),
      })
      if (!patchRes.ok) {
        const text = await patchRes.text().catch(() => '')
        throw new Error(`PATCH group failed (${patchRes.status}): ${text.slice(0, 200)}`)
      }
      console.log(`[AppFolio sync] Added to group: ${group.Name}`)
    } catch (err) {
      console.error(`[AppFolio sync] Property group ${groupId} failed:`, err.message)
    }
  }
}

/**
 * Create an HOA vendor record in AppFolio using HOA details from step 2.
 * Only fires when hasHoa is true and a company name is available.
 * Returns the new vendor Id, or null if skipped/failed.
 */
async function createAppFolioHoaVendor(authHeader, s2) {
  const companyName = (s2.hoaCompany || s2.hoaName || '').trim()
  if (!companyName) return null

  const payload = {
    IsCompany:                    true,
    UseCompanyNameAsTaxpayerName: true,
    CompanyName:                  companyName,
    Send1099:                     false,
  }

  if (s2.hoaPhone) {
    payload.PhoneNumbers = [{ Number: s2.hoaPhone, IsPrimary: true, Label: 'Office' }]
  }

  if (s2.hoaEmail) {
    payload.Emails = [{ EmailAddress: s2.hoaEmail, IsPrimary: true }]
  }

  if (s2.hoaWebsite) {
    const url = s2.hoaWebsite.startsWith('http') ? s2.hoaWebsite : `https://${s2.hoaWebsite}`
    payload.CompanyURL = url
  }

  const res = await fetch(`${AF_BASE}/vendors`, {
    method:  'POST',
    headers: {
      'Authorization':           authHeader,
      'Content-Type':            'application/json',
      'X-AppFolio-Developer-ID': process.env.APPFOLIO_DEVELOPER_ID || '',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AppFolio HOA vendor create failed (${res.status}): ${text.slice(0, 300)}`)
  }

  const data = await res.json()
  return data?.Id || null
}

/**
 * Create tenant records for occupied units via POST /tenants/bulk.
 * Only fires for units with occupancy status 'staying' or 'move_out'.
 * unitIds is the array returned by createAppFolioUnits() — index 0 = unit 1.
 * Returns the JobId string (async 202), or null if nothing to create.
 */
async function createAppFolioTenants(authHeader, onboarding, s2, unitIds) {
  const occupancy = Array.isArray(s2.unitOccupancy) ? s2.unitOccupancy : []
  const today = new Date().toISOString().split('T')[0]

  const tenants = []
  for (const entry of occupancy) {
    const status  = entry.occupancy || ''
    if (status !== 'staying' && status !== 'move_out') continue

    // unit field is 1-based; map to 0-based unitIds index
    const unitIndex = (parseInt(entry.unit) || 1) - 1
    const unitId    = unitIds[unitIndex]
    if (!unitId) continue

    const { firstName, lastName } = splitName(entry.tenantName || '')
    const refId = `${onboarding.id}-tenant-${entry.unit}`

    const tenant = {
      ReferenceId: refId,
      UnitId:      unitId,
      MoveInOn:    today,
    }

    if (firstName) tenant.FirstName = firstName
    if (lastName)  tenant.LastName  = lastName

    if (entry.tenantPhone) tenant.PhoneNumbers = [{ Number: entry.tenantPhone }]
    if (entry.tenantEmail) tenant.Emails        = [{ Address: entry.tenantEmail }]

    if (entry.moveOutDate) {
      tenant.MoveOutOn      = entry.moveOutDate
      tenant.LeaseEndDate   = entry.moveOutDate
    }

    tenants.push(tenant)
  }

  if (!tenants.length) return null

  const res = await fetch(`${AF_BASE}/tenants/bulk`, {
    method:  'POST',
    headers: {
      'Authorization':           authHeader,
      'Content-Type':            'application/json',
      'X-AppFolio-Developer-ID': process.env.APPFOLIO_DEVELOPER_ID || '',
    },
    body: JSON.stringify({ data: tenants }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AppFolio tenants create failed (${res.status}): ${text.slice(0, 300)}`)
  }

  const data = await res.json()
  return data?.JobId || data?.job_id || null
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
    // A2. Fetch step 3 data_json for FTB / CA residency
    // -------------------------------------------------------------------------
    const { data: step3Row } = await supabase
      .from('onboarding_steps')
      .select('data_json')
      .eq('onboarding_id', onboarding.id)
      .eq('step_number', 3)
      .single()

    const s3 = step3Row?.data_json || {}

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
        const propType = s2.propertyType || s2.propType || s2['prop-type'] || ''
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
          let unitIds = []
          try {
            unitIds = await createAppFolioUnits(authHeader, onboarding, s2, appfolioPropertyId)
            if (unitIds.length) console.log(`[AppFolio sync] ${unitIds.length} unit(s) created for ${onboarding.short_address}`)
          } catch (err) {
            console.error('[AppFolio sync] Unit create failed:', err.message)
            await supabase.from('onboarding_flags').insert({
              onboarding_id: onboarding.id,
              flag_type:     'appfolio_sync_error',
              message:       `AppFolio unit create failed for ${onboarding.short_address}: ${err.message}`,
            })
          }

          // Assign property to the right groups
          try {
            await addToAppFolioPropertyGroups(authHeader, appfolioPropertyId, onboarding, s2, s3, insuranceStatus, surevestorApproved)
          } catch (err) {
            console.error('[AppFolio sync] Property group assignment failed:', err.message)
            await supabase.from('onboarding_flags').insert({
              onboarding_id: onboarding.id,
              flag_type:     'appfolio_sync_error',
              message:       `AppFolio property group assignment failed for ${onboarding.short_address}: ${err.message}`,
            })
          }

          // Create HOA vendor if HOA is present
          const hasHoa = !!(s2.hoaName || s2.hoaCompany)
          if (hasHoa) {
            try {
              const vendorId = await createAppFolioHoaVendor(authHeader, s2)
              if (vendorId) console.log(`[AppFolio sync] HOA vendor created: ${vendorId} for ${onboarding.short_address}`)
            } catch (err) {
              console.error('[AppFolio sync] HOA vendor create failed:', err.message)
              await supabase.from('onboarding_flags').insert({
                onboarding_id: onboarding.id,
                flag_type:     'appfolio_sync_error',
                message:       `AppFolio HOA vendor create failed for ${onboarding.short_address}: ${err.message}`,
              })
            }
          }

          // Create tenants for occupied units
          if (unitIds.length) {
            try {
              const jobId = await createAppFolioTenants(authHeader, onboarding, s2, unitIds)
              if (jobId) console.log(`[AppFolio sync] Tenants queued (JobId: ${jobId}) for ${onboarding.short_address}`)
              else       console.log(`[AppFolio sync] No occupied units — tenants skipped for ${onboarding.short_address}`)
            } catch (err) {
              console.error('[AppFolio sync] Tenant create failed:', err.message)
              await supabase.from('onboarding_flags').insert({
                onboarding_id: onboarding.id,
                flag_type:     'appfolio_sync_error',
                message:       `AppFolio tenant create failed for ${onboarding.short_address}: ${err.message}`,
              })
            }
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
