// sync-residents.js
// Pulls current tenants from AppFolio Stack API → residents table.
// Safe to re-run — upserts by appfolio_tenant_id.
//
// Usage: node src/residents/sync-residents.js
//        node src/residents/sync-residents.js --dry-run

import 'dotenv/config'
import { supabase } from '../db/server-client.js'

const DRY_RUN      = process.argv.includes('--dry-run')
const CLIENT_ID    = process.env.APPFOLIO_STACK_CLIENT_ID
const CLIENT_SECRET = process.env.APPFOLIO_STACK_CLIENT_SECRET
const DEVELOPER_ID = process.env.APPFOLIO_DEVELOPER_ID
const BASIC_AUTH   = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
const BASE         = 'https://api.appfolio.com/api/v0'

// ── AppFolio Stack API fetch (paginated) ────────────────────────────────────

async function fetchAll(endpoint, params = {}) {
  const results = []
  let pageNum = 1
  while (true) {
    const url = new URL(`${BASE}/${endpoint}`)
    const allParams = { ...params, 'page[number]': pageNum, 'page[size]': 500 }
    for (const [k, v] of Object.entries(allParams)) url.searchParams.set(k, String(v))

    const res = await fetch(url.toString(), {
      headers: {
        Authorization:             `Basic ${BASIC_AUTH}`,
        'X-AppFolio-Developer-ID': DEVELOPER_ID,
        Accept:                    'application/json',
      },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Stack API /${endpoint} failed (${res.status}): ${body.slice(0, 300)}`)
    }
    const data  = await res.json()
    const items = data.data || []
    results.push(...items)
    if (!data.next_page_path || items.length < 500) break
    pageNum++
  }
  return results
}

// ── Build property address lookup from Stack API ─────────────────────────────

async function buildAddressLookup() {
  // Fetch all units to get PropertyId per unit UUID
  const allUnits = await fetchAll('units', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' })
  console.log(`Stack units fetched: ${allUnits.length}`)

  // Fetch all properties to get the street address per PropertyId
  const allProps = await fetchAll('properties', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' })
  console.log(`Stack properties fetched: ${allProps.length}`)

  // Log the first property so we can see the field shape
  if (allProps.length > 0) {
    console.log('Sample property fields:', JSON.stringify(allProps[0], null, 2).slice(0, 400))
  }

  // Build property → formatted address string
  // AppFolio Stack API uses flat fields: Address1, City, State directly on the property object
  const propAddr = {}
  for (const p of allProps) {
    const street = p.Address1 || p.Street || p.AddressLine1 || ''
    const city   = p.City   || ''
    const state  = p.State  || ''
    if (street) propAddr[p.Id] = [street, city, state].filter(Boolean).join(', ')
  }

  // Build unit UUID → { propertyAddress, propertyName }
  const unitAddr = {}
  for (const u of allUnits) {
    const propId = u.PropertyId || u.propertyId
    unitAddr[u.Id] = {
      propertyAddress: propAddr[propId] || null,
      propertyName:    u.PropertyName || u.propertyName || null,
    }
  }

  return unitAddr
}

// ── Map AppFolio tenant → residents table row ───────────────────────────────

function mapTenant(t, unitLookup, stackUnitLookup) {
  const name  = [t.FirstName, t.MiddleName, t.LastName].filter(Boolean).join(' ') || 'Unknown'
  const email = t.Email
    || (Array.isArray(t.Emails) && t.Emails.length > 0 ? t.Emails[0].Address : null)
    || null

  const unit      = unitLookup[t.UnitId]      || null
  const stackUnit = stackUnitLookup[t.UnitId] || null

  return {
    appfolio_tenant_id: t.Id,
    unit_id:            unit?.id            || null,
    appfolio_unit_id:   t.UnitId            || null,
    name,
    email,
    move_in_date:       t.MoveInOn          || null,
    lease_start:        t.LeaseStartDate    || null,
    lease_end:          t.LeaseEndDate      || null,
    property_name:      stackUnit?.propertyName || unit?.property_name || null,
    property_address:   stackUnit?.propertyAddress || null,
    unit_number:        unit?.unit_number   || null,
    late_count:         0,
    past_due_cents:     0,
    updated_at:         new Date().toISOString(),
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Resident Sync — AppFolio Stack API (${DRY_RUN ? 'DRY RUN' : 'LIVE'})\n`)

  if (!CLIENT_ID || !CLIENT_SECRET || !DEVELOPER_ID) {
    console.error('Missing APPFOLIO_STACK_CLIENT_ID, APPFOLIO_STACK_CLIENT_SECRET, or APPFOLIO_DEVELOPER_ID in .env')
    process.exit(1)
  }

  // Load our units table for ID matching
  const { data: units } = await supabase
    .from('units')
    .select('id, appfolio_unit_id, property_name, unit_number')
  const unitLookup = Object.fromEntries((units || []).map(u => [u.appfolio_unit_id, u]))
  console.log(`Units in database: ${Object.keys(unitLookup).length}`)

  // Pull all tenants from AppFolio
  console.log('Fetching tenants from AppFolio...')
  const allTenants = await fetchAll('tenants', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' })
  console.log(`Total tenants from AppFolio: ${allTenants.length}`)

  // Filter to current tenants only
  const current = allTenants.filter(t => t.Status === 'Current')
  console.log(`Current tenants: ${current.length}`)

  // Build property address lookup from Stack API
  console.log('\nFetching property addresses from AppFolio...')
  let stackUnitLookup = {}
  try {
    stackUnitLookup = await buildAddressLookup()
    const withAddr = Object.values(stackUnitLookup).filter(u => u.propertyAddress).length
    console.log(`Property addresses resolved: ${withAddr} / ${Object.keys(stackUnitLookup).length} units`)
  } catch (err) {
    console.warn('Could not fetch property addresses:', err.message)
    console.warn('Continuing without addresses — re-run after fixing.')
  }

  // Map to table rows
  const rows = current.map(t => mapTenant(t, unitLookup, stackUnitLookup))

  // Stats
  const withEmail   = rows.filter(r => r.email).length
  const withUnit    = rows.filter(r => r.unit_id).length
  console.log(`\nWith email:    ${withEmail} / ${rows.length}`)
  console.log(`Matched to unit: ${withUnit} / ${rows.length}`)
  console.log('\nSample (first 3):')
  rows.slice(0, 3).forEach(r => {
    console.log(`  ${r.name} | ${r.email || '(no email)'} | ${r.property_name || '(unit unmatched)'} #${r.unit_number || '?'}`)
  })

  if (DRY_RUN) {
    console.log('\n[DRY RUN — nothing written]\n')
    return
  }

  // Upsert in batches of 100
  const BATCH = 100
  let saved = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const { error } = await supabase
      .from('residents')
      .upsert(batch, { onConflict: 'appfolio_tenant_id', ignoreDuplicates: false })
    if (error) { console.error(`Batch ${i} error:`, error.message); process.exit(1) }
    saved += batch.length
    process.stdout.write(`\rSaved ${saved}/${rows.length}...`)
  }

  console.log(`\n\nSync complete — ${saved} residents in database.`)
  console.log(`Next: node src/residents/score-residents.js\n`)
}

main().catch(err => { console.error(err); process.exit(1) })
