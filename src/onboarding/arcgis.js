/**
 * arcgis.js — San Diego County parcel lookup via ArcGIS.
 * No API key required — uses the county's public map server.
 *
 * Export: lookupByAddress(address) → { apn, ownerName, propertyAddress, entityType }
 */

const ARCGIS_URL =
  'https://webmaps.sandiego.gov/arcgis/rest/services/GeocoderMerged/MapServer/1/query'

/**
 * Detect entity type from owner name string.
 * Returns 'trust', 'business', or 'individual'.
 */
function detectEntityType(name) {
  if (!name) return 'individual'
  const upper = name.toUpperCase()

  const trustKeywords = ['TRUST', ' TR ', ' TR,', 'TTEE', 'TRUSTEE', 'LIVING TRUST', 'REVOCABLE']
  if (trustKeywords.some(k => upper.includes(k))) return 'trust'

  const bizKeywords = ['LLC', 'INC', 'CORP', 'LTD', ' L.P.', ' LP,', ' LP ', ', LP', ', INC', ', LLC']
  if (bizKeywords.some(k => upper.includes(k))) return 'business'

  return 'individual'
}

/**
 * Look up parcel data by street address.
 *
 * @param {string} address  Full or partial street address, e.g. "123 Ash St"
 * @returns {{ apn, ownerName, propertyAddress, entityType } | null}
 *          Returns null if no match found or on network error.
 */
export async function lookupByAddress(address) {
  const params = new URLSearchParams({
    where: `UPPER(FULLADDR) LIKE UPPER('%${address.replace(/'/g, "''")}%')`,
    outFields: 'APN,OWNER1,OWNER2,SITUS_ADDR,ADDR_NUM,STREET_DIR,STREET_NAME,STREET_TYPE,ZIP_CODE',
    returnGeometry: 'false',
    f: 'json',
    resultRecordCount: '1',
  })

  const url = `${ARCGIS_URL}?${params.toString()}`

  let data
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`)
    data = await res.json()
  } catch (err) {
    console.error('[ArcGIS] Fetch error:', err.message)
    return null
  }

  const features = data?.features
  if (!features || features.length === 0) return null

  const attrs = features[0].attributes

  // Combine OWNER1 + OWNER2 when both are present
  const owner1 = (attrs.OWNER1 || '').trim()
  const owner2 = (attrs.OWNER2 || '').trim()
  const ownerName = owner1 && owner2 ? `${owner1} & ${owner2}` : owner1 || owner2

  // Build situs address from components
  const parts = [
    attrs.ADDR_NUM,
    attrs.STREET_DIR,
    attrs.STREET_NAME,
    attrs.STREET_TYPE,
    attrs.ZIP_CODE ? `San Diego CA ${attrs.ZIP_CODE}` : 'San Diego CA',
  ].filter(Boolean)
  const propertyAddress = attrs.SITUS_ADDR || parts.join(' ')

  return {
    apn:             attrs.APN || null,
    ownerName:       ownerName || null,
    propertyAddress: propertyAddress || null,
    entityType:      detectEntityType(ownerName),
  }
}

/**
 * Look up property characteristics (year built, sq ft, beds, baths) from SANDAG.
 *
 * @param {string} apn  Assessor Parcel Number, e.g. "530-431-08"
 * @returns {{ yearBuilt, sqFt, bedrooms, bathrooms, hasPool, garageStalls, lat, lng } | null}
 */
export async function lookupPropertyDetails(apn) {
  if (!apn) return null
  const params = new URLSearchParams({
    where:          `apn='${apn.replace(/'/g, "''")}'`,
    outFields:      'year_effective,total_lvg_area,bedrooms,baths,x_coord,y_coord,pool,garage_stalls',
    returnGeometry: 'false',
    f:              'json',
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

/**
 * Look up FEMA flood zone at a lat/lng coordinate.
 *
 * @param {number} lat  Latitude
 * @param {number} lng  Longitude
 * @returns {{ floodZone, sfha, zoneDesc } | null}
 *          sfha: true = property is in a Special Flood Hazard Area (high risk)
 */
export async function lookupFloodZone(lat, lng) {
  if (!lat || !lng) return null
  const params = new URLSearchParams({
    geometry:       `${lng},${lat}`,
    geometryType:   'esriGeometryPoint',
    inSR:           '4326',
    spatialRel:     'esriSpatialRelIntersects',
    outFields:      'FLD_ZONE,ZONE_SUBTY,SFHA_TF',
    returnGeometry: 'false',
    f:              'json',
  })
  const url = `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?${params}`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const a = data?.features?.[0]?.attributes
    if (!a) return null
    return {
      floodZone: a.FLD_ZONE  || null,   // e.g. "X", "AE", "A"
      sfha:      a.SFHA_TF === 'T' || a.SFHA_TF === true,  // true = high-risk flood zone
      zoneDesc:  a.ZONE_SUBTY || null,
    }
  } catch { return null }
}
