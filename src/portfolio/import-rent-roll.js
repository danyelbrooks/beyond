/**
 * import-rent-roll.js — Import an AppFolio Rent Roll CSV into the `units` table.
 *
 * HOW TO EXPORT FROM APPFOLIO:
 *   1. Go to Reports → Rent Roll (or search "Rent Roll" in AppFolio reports)
 *   2. Run the report for all properties
 *   3. Click Export → CSV (or Excel, then save as CSV)
 *   4. Save the file as:  src/portfolio/import/rent-roll.csv
 *   5. Run:  npm run import:rent-roll
 *
 * The script prints every column it finds on the first run so you can
 * verify the mapping looks right before committing anything to the database.
 */

import 'dotenv/config'
import { readFileSync, existsSync } from 'fs'
import { supabase } from '../db/server-client.js'

const CSV_PATH = 'src/portfolio/import/rent-roll.csv'

// ============================================================================
// CSV PARSER
// Handles quoted fields, commas inside quotes, and Windows line endings.
// ============================================================================
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const rows  = []

  for (const line of lines) {
    if (!line.trim()) continue
    const fields = []
    let current  = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i++) {
      const ch   = line[i]
      const next = line[i + 1]

      if (ch === '"' && inQuotes && next === '"') {
        current += '"'; i++       // escaped quote inside quoted field
      } else if (ch === '"') {
        inQuotes = !inQuotes      // toggle quoted mode
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim()); current = ''
      } else {
        current += ch
      }
    }
    fields.push(current.trim())
    rows.push(fields)
  }

  if (rows.length < 2) return []

  const headers = rows[0].map(h => h.toLowerCase().trim())
  return rows.slice(1).map(row => {
    const obj = {}
    headers.forEach((h, i) => { obj[h] = row[i] ?? '' })
    return obj
  })
}

// ============================================================================
// COLUMN FINDER
// AppFolio column names vary by report version. We match flexibly.
// ============================================================================
function find(row, candidates) {
  for (const candidate of candidates) {
    const key = Object.keys(row).find(k =>
      k.toLowerCase().includes(candidate.toLowerCase())
    )
    if (key && row[key] !== undefined && row[key] !== '') return row[key]
  }
  return null
}

// ============================================================================
// MAP CSV ROW → units table row
// ============================================================================
function mapRow(row, runStamp) {
  // _property and _unit are pre-parsed from the AppFolio unit string
  const property = row._property || find(row, ['property name', 'property', 'building'])
  const unit     = row._unit     || find(row, ['unit number', 'unit no'])
  const status   = find(row, ['status', 'occupancy', 'lease status'])
  const rent     = find(row, ['market rent', 'market rate', 'scheduled rent', 'rent amount'])
  const moveOut  = find(row, ['move-out', 'move out', 'lease to', 'lease end', 'end date'])
  const moveIn   = find(row, ['move-in', 'move in', 'lease from', 'lease start', 'start date'])

  if (!property) return null   // skip summary/blank rows

  // Determine occupancy status
  let mappedStatus = 'unknown'
  if (status) {
    const s = status.toLowerCase()
    if      (s.includes('vacant') || s.includes('empty'))   mappedStatus = 'vacant'
    else if (s.includes('notice') || s.includes('moving'))  mappedStatus = 'notice'
    else if (s.includes('occupied') || s.includes('current') || s.includes('active')) mappedStatus = 'occupied'
    else if (s.includes('leased') && !s.includes('occupied')) mappedStatus = 'leased_not_occupied'
  } else {
    // If no status column, infer from whether there's a tenant name
    const tenant = find(row, ['tenant', 'resident', 'lessee'])
    if (tenant && tenant.length > 1) mappedStatus = 'occupied'
    else mappedStatus = 'vacant'
  }

  // Parse market rent — strip $, commas, spaces
  const rawRent   = rent ? parseFloat(rent.replace(/[$,\s]/g, '')) : null
  const marketRent = rawRent && !isNaN(rawRent) && rawRent > 0 ? rawRent : null

  // Vacant since — use move-out date if status is vacant
  let vacantSince = null
  if (mappedStatus === 'vacant' && moveOut) {
    const d = new Date(moveOut)
    if (!isNaN(d.getTime())) vacantSince = d.toISOString().split('T')[0]
  }

  // Unique ID: property + unit (no AppFolio ID in report exports)
  const appfolioUnitId = `csv-${property.trim().toLowerCase().replace(/\s+/g, '-')}-${(unit || '').trim().toLowerCase().replace(/\s+/g, '-')}`

  return {
    appfolio_unit_id: appfolioUnitId,
    property_name:    property.trim(),
    unit_number:      (unit || '').trim(),
    market_rent:      marketRent,
    status:           mappedStatus,
    vacant_since:     vacantSince,
    raw_payload:      row,
    last_synced_at:   runStamp,
  }
}

// ============================================================================
// MAIN
// ============================================================================
const runStamp = new Date().toISOString()

if (!existsSync(CSV_PATH)) {
  console.error(`
File not found: ${CSV_PATH}

To export from AppFolio:
  1. Go to Reports → Rent Roll
  2. Run it for all properties
  3. Export → CSV
  4. Save the file here:  ${CSV_PATH}

Then run this script again.
`)
  process.exit(1)
}

console.log(`import-rent-roll starting at ${runStamp}`)
console.log(`Reading ${CSV_PATH}...\n`)

const text = readFileSync(CSV_PATH, 'utf8')
const rows = parseCSV(text)

if (rows.length === 0) {
  console.error('CSV appears empty or could not be parsed. Check the file and try again.')
  process.exit(1)
}

// AppFolio Rent Roll exports alternate rows:
//   Odd rows:  "unit" column contains the property + address string
//   Even rows: tenant, status, rent, etc. (unit column is empty)
// We pair them up before mapping.
function pairRows(rows) {
  const paired = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    const unitStr = (row.unit || '').trim()
    if (unitStr.startsWith('->') || unitStr.length > 5) {
      // This is a header row — grab the data from the next row
      const data = rows[i + 1] || {}
      paired.push({ _unit_str: unitStr, ...data })
      i += 2
    } else {
      i++
    }
  }
  return paired
}

// Parse the AppFolio unit string into property_name + unit_number.
// Format: "-> Shorthand (Owner) - Full Address"
// Example: "-> 10th Ave. 253 #328 (David) - 253 10th Avenue Unit 328 San Diego, CA 92101"
function parseUnitStr(str) {
  const cleaned = str.replace(/^->\s*/, '').trim()

  // Split on " - " to separate shorthand from full address
  const dashIdx = cleaned.lastIndexOf(' - ')
  const fullAddress = dashIdx >= 0 ? cleaned.slice(dashIdx + 3).trim() : cleaned

  // Extract unit number from full address ("Unit 328" or "#328")
  const unitMatch = fullAddress.match(/\bUnit\s+([^\s,]+)/i) || fullAddress.match(/#([^\s,]+)/)
  const unitNumber = unitMatch ? unitMatch[1] : ''

  // Property name = everything in full address before "Unit" or end of street (no city/state)
  // Strip ", City, ST ZIP" and "Unit X" from the address
  let propertyName = fullAddress
    .replace(/,\s*[A-Z][a-zA-Z\s]+,\s*[A-Z]{2}\s*\d{5}(-\d{4})?$/, '')  // strip ", San Diego, CA 92101"
    .replace(/\s+Unit\s+\S+/i, '')                                           // strip "Unit 328"
    .replace(/\s+#\S+/, '')                                                  // strip "#328"
    .trim()

  return { propertyName, unitNumber }
}

const paired = pairRows(rows)
console.log(`Paired into ${paired.length} unit records.\n`)

// Show first 3 to verify
console.log('Sample parsed records (verify these look right):')
paired.slice(0, 3).forEach((r, i) => {
  const { propertyName, unitNumber } = parseUnitStr(r._unit_str || '')
  console.log(`\n  Unit ${i + 1}:`)
  console.log(`    property_name: ${propertyName}`)
  console.log(`    unit_number:   ${unitNumber}`)
  console.log(`    tenant:        ${r.tenant || '(vacant)'}`)
  console.log(`    status:        ${r.status || '(none)'}`)
  console.log(`    market rent:   ${r['market rent'] || '(none)'}`)
})
console.log()

// Map rows — now using paired records with parsed property/unit
const mapped = paired.map(r => {
  const { propertyName, unitNumber } = parseUnitStr(r._unit_str || '')
  if (!propertyName) return null
  // Inject property/unit into the row so mapRow() can find them
  return mapRow({ ...r, _property: propertyName, _unit: unitNumber }, runStamp)
}).filter(Boolean)

if (mapped.length === 0) {
  console.error('No valid unit rows found. Make sure the CSV has a "Property" or "Property Name" column.')
  process.exit(1)
}

// Show sample mapping
const sample = mapped[0]
console.log('Sample mapping (first row — verify this looks right):')
console.log(`  property_name:    ${sample.property_name}`)
console.log(`  unit_number:      ${sample.unit_number}`)
console.log(`  status:           ${sample.status}`)
console.log(`  market_rent:      ${sample.market_rent ?? '(not found)'}`)
console.log(`  vacant_since:     ${sample.vacant_since ?? 'null'}`)
console.log()

// Status breakdown before upsert
const byStatus = {}
for (const r of mapped) byStatus[r.status] = (byStatus[r.status] || 0) + 1
console.log('Status breakdown:')
for (const [s, n] of Object.entries(byStatus)) console.log(`  ${s}: ${n}`)
console.log()

// Upsert in batches of 50
let synced = 0
let errors = 0
const BATCH = 50

for (let i = 0; i < mapped.length; i += BATCH) {
  const batch = mapped.slice(i, i + BATCH)
  const { error } = await supabase
    .from('units')
    .upsert(batch, { onConflict: 'appfolio_unit_id' })

  if (error) {
    console.error(`  Batch ${Math.floor(i / BATCH) + 1} error: ${error.message}`)
    errors += batch.length
  } else {
    synced += batch.length
    process.stdout.write(`\r  Saved ${synced}/${mapped.length} units...`)
  }
}

console.log(`\n\n=== Import Complete ===`)
console.log(`Units loaded:   ${synced}`)
if (errors > 0) console.log(`Errors:         ${errors}`)

const withRent = mapped.filter(r => r.market_rent !== null).length
console.log(`With rent data: ${withRent} / ${synced}`)

if (withRent === 0) {
  console.log(`
NOTE: No market rent found. The vacancy cost card will show $0.
Look at the column list above and find the rent column name,
then check the find() call for 'market rent' in this script
and add your column name to the list.
`)
}

console.log(`\nOpen your KPI Dashboard — the Morning Pulse cards should now show real data.`)
