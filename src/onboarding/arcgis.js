/**
 * arcgis.js — San Diego County parcel lookup via ArcGIS.
 * No API key required — uses the county's public map server.
 *
 * Actual field names discovered from MapServer/1 layer metadata:
 *   OWN_NAME1, OWN_NAME2, SITUS_ADDRESS (int), SITUS_PRE_DIR, SITUS_STREET,
 *   SITUS_SUFFIX, SITUS_COMMUNITY, SITUS_ZIP, APN (10-digit, no dashes)
 */

const ARCGIS_URL =
  'https://webmaps.sandiego.gov/arcgis/rest/services/GeocoderMerged/MapServer/1/query'

const OUT_FIELDS =
  'APN,OWN_NAME1,OWN_NAME2,SITUS_ADDRESS,SITUS_PRE_DIR,SITUS_STREET,SITUS_SUFFIX,SITUS_COMMUNITY,SITUS_ZIP'

// =============================================================================
// HELPERS
// =============================================================================

function detectEntityType(name) {
  if (!name) return 'individual'
  const upper = name.toUpperCase()
  const trustKeywords = ['TRUST', ' TR ', ' TR,', 'TTEE', 'TRUSTEE', 'LIVING TRUST', 'REVOCABLE']
  if (trustKeywords.some(k => upper.includes(k))) return 'trust'
  const bizKeywords = ['LLC', 'INC', 'CORP', 'LTD', ' L.P.', ' LP,', ' LP ', ', LP', ', INC', ', LLC']
  if (bizKeywords.some(k => upper.includes(k))) return 'business'
  return 'individual'
}

function buildResult(attrs) {
  const owner1 = (attrs.OWN_NAME1 || '').trim()
  const owner2 = (attrs.OWN_NAME2 || '').trim()
  const ownerName = owner1 && owner2 ? `${owner1} & ${owner2}` : owner1 || owner2

  // Build address — ZIP stored as "92103-1234", strip the suffix
  const zip = (attrs.SITUS_ZIP || '').split('-')[0]
  const community = (attrs.SITUS_COMMUNITY || '').trim()
  const cityZip = [community, 'CA', zip].filter(Boolean).join(' ')

  const parts = [
    attrs.SITUS_ADDRESS,
    attrs.SITUS_PRE_DIR,
    attrs.SITUS_STREET,
    attrs.SITUS_SUFFIX,
    cityZip,
  ].filter(Boolean)
  const propertyAddress = parts.join(' ')

  return {
    apn:             attrs.APN             || null,
    ownerName:       ownerName             || null,
    propertyAddress: propertyAddress       || null,
    entityType:      detectEntityType(ownerName),
  }
}

async function queryArcGIS(where) {
  const params = new URLSearchParams({
    where,
    outFields:         OUT_FIELDS,
    returnGeometry:    'false',
    f:                 'json',
    resultRecordCount: '1',
  })
  const url = `${ARCGIS_URL}?${params.toString()}`
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`)
    const data = await res.json()
    if (data.error) {
      console.error('[ArcGIS] Query error:', data.error.message)
      return null
    }
    return data?.features?.[0]?.attributes || null
  } catch (err) {
    console.error('[ArcGIS] Fetch error:', err.message)
    return null
  }
}

// =============================================================================
// LOOKUP BY ADDRESS
// =============================================================================

/**
 * Look up parcel data by street address.
 *
 * @param {string} address  e.g. "123 Ash St" or "1234 Oak Ave"
 * @returns {{ apn, ownerName, propertyAddress, entityType } | null}
 */
export async function lookupByAddress(address) {
  if (!address) return null

  const tokens = address.trim().split(/\s+/)

  // Split off a leading street number if present
  const numStr  = tokens[0]
  const hasNum  = /^\d+$/.test(numStr)
  const streetTokens = hasNum ? tokens.slice(1) : tokens

  // Remove trailing suffix words (ST, AVE, BLVD, etc.) — they're not in SITUS_STREET
  const SUFFIXES = new Set(['ST','AVE','BLVD','DR','LN','RD','CT','PL','WAY','CIR','TER','TR','HWY','FWY','PKWY'])
  const nameTokens = streetTokens.filter(t => !SUFFIXES.has(t.toUpperCase()))
  const streetName = nameTokens.join(' ').replace(/'/g, "''")

  if (!streetName) return null

  let where
  if (hasNum) {
    where = `SITUS_ADDRESS = ${parseInt(numStr)} AND UPPER(SITUS_STREET) LIKE UPPER('%${streetName}%')`
  } else {
    where = `UPPER(SITUS_STREET) LIKE UPPER('%${streetName}%')`
  }

  const attrs = await queryArcGIS(where)
  if (!attrs) return null
  return buildResult(attrs)
}

// =============================================================================
// LOOKUP BY APN
// =============================================================================

/**
 * Look up parcel data by APN (Assessor Parcel Number).
 *
 * San Diego County stores APNs as 10-digit strings without dashes.
 * e.g. "530-431-08" → "5304310800", "530-431-08-00" → "5304310800"
 *
 * @param {string} apn  e.g. "530-431-08", "5304310800", or "530-431-08-00"
 * @returns {{ apn, ownerName, propertyAddress, entityType } | null}
 */
export async function lookupByApn(apn) {
  if (!apn) return null

  // Strip dashes, spaces, dots
  const stripped = apn.trim().replace(/[-\s.]/g, '')

  // Build candidate list:
  // - 10 digits as-is
  // - 8 digits → pad to 10 with "00"
  // - 9 digits → pad to 10 with "0" (unlikely but safe)
  const candidates = new Set([stripped])
  if (stripped.length === 8) candidates.add(stripped + '00')
  if (stripped.length === 9) candidates.add(stripped + '0')
  // Also try the raw input in case the layer accepts dashes
  candidates.add(apn.trim())

  for (const candidate of candidates) {
    const safe  = candidate.replace(/'/g, "''")
    const attrs = await queryArcGIS(`APN = '${safe}'`)
    if (attrs) return buildResult(attrs)
  }

  return null
}

// =============================================================================
// PROPERTY DETAILS (SANDAG)
// =============================================================================

/**
 * Look up property characteristics (year built, sq ft, beds, baths) from SANDAG.
 *
 * @param {string} apn  Assessor Parcel Number
 * @returns {{ yearBuilt, sqFt, bedrooms, bathrooms, hasPool, garageStalls, lat, lng } | null}
 */
export async function lookupPropertyDetails(apn) {
  if (!apn) return null
  const params = new URLSearchParams({
    where:     `apn='${apn.replace(/'/g, "''")}'`,
    outFields: 'year_effective,total_lvg_area,bedrooms,baths,x_coord,y_coord,pool,garage_stalls',
    returnGeometry: 'false',
    f:         'json',
  })
  const url = `https://geo.sandag.org/server/rest/services/Hosted/Parcels/FeatureServer/0/query?${params}`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const a = data?.features?.[0]?.attributes
    if (!a) return null
    return {
      yearBuilt:    a.year_effective  || null,
      sqFt:         a.total_lvg_area  || null,
      bedrooms:     a.bedrooms        || null,
      bathrooms:    a.baths           || null,
      hasPool:      a.pool === 'Y'    || a.pool === 1 || false,
      garageStalls: a.garage_stalls   || null,
      lat:          a.y_coord         || null,
      lng:          a.x_coord         || null,
    }
  } catch { return null }
}

// =============================================================================
// FLOOD ZONE (FEMA)
// =============================================================================

/**
 * Look up FEMA flood zone at a lat/lng coordinate.
 *
 * @param {number} lat  Latitude
 * @param {number} lng  Longitude
 * @returns {{ floodZone, sfha, zoneDesc } | null}
 */
export async function lookupFloodZone(lat, lng) {
  if (!lat || !lng) return null
  const params = new URLSearchParams({
    geometry:     `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR:         '4326',
    spatialRel:   'esriSpatialRelIntersects',
    outFields:    'FLD_ZONE,ZONE_SUBTY,SFHA_TF',
    returnGeometry: 'false',
    f:            'json',
  })
  const url = `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?${params}`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const a = data?.features?.[0]?.attributes
    if (!a) return null
    return {
      floodZone: a.FLD_ZONE  || null,
      sfha:      a.SFHA_TF === 'T' || a.SFHA_TF === true,
      zoneDesc:  a.ZONE_SUBTY || null,
    }
  } catch { return null }
}
