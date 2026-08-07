/**
 * import-owners-csv.js — Import owners from an AppFolio CSV export
 *
 * Run:
 *   node src/portfolio/import-owners-csv.js "C:\path\to\Owner Health Worksheet.csv"
 *   npm run import:owners-csv -- "C:\path\to\file.csv"
 *
 * Reads columns: Name, Phone Numbers, Email, Properties Owned,
 *   Last Payment Date, Last Packet Sent, FTB Type,
 *   Owner Last Personalized Update, Owner Last Phone Call, Referred By
 */

import 'dotenv/config'
import { readFile } from 'fs/promises'
import { supabase } from '../db/server-client.js'

// ============================================================================
// CSV PARSER — handles quoted fields with commas inside
// ============================================================================
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length < 2) throw new Error('CSV has no data rows')

  const headers = splitLine(lines[0]).map(h => h.trim())

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const values = splitLine(line)
    const obj = {}
    headers.forEach((h, idx) => { obj[h] = (values[idx] ?? '').trim() })
    rows.push(obj)
  }
  return rows
}

function splitLine(line) {
  const fields = []
  let cur = '', inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      fields.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  fields.push(cur)
  return fields
}

// ============================================================================
// COLUMN MAPPING — handles header name variations
// ============================================================================
const COL_CANDIDATES = {
  name:         ['name', 'owner name', 'full name', 'display name'],
  phone:        ['phone numbers', 'phone', 'phone number', 'cell phone'],
  email:        ['email', 'email address', 'primary email'],
  properties:   ['properties owned', 'properties', 'managed properties', 'property'],
  last_payment: ['last payment date', 'last payment'],
  last_packet:  ['last packet sent', 'packet sent'],
  ftb_type:     ['ftb type', 'ftb'],
  last_update:  ['owner last personalized update', 'last personalized update'],
  last_call:    ['owner last phone call', 'last phone call', 'last call'],
  referred_by:  ['referred by', 'referral'],
}

function findCol(headers, key) {
  const candidates = COL_CANDIDATES[key] || []
  return headers.find(h => candidates.includes(h.toLowerCase())) ?? null
}

// ============================================================================
// PROPERTY NAME PARSER
//
// AppFolio formats "Properties Owned" as:
//   Street Address (OwnerNickname) (50%), Another Address (Nick) (100%)
//
// This function splits on the (NN%), delimiter and strips the (Nick) (NN%)
// suffix from each piece to return clean address strings.
// ============================================================================
function parsePropertyNames(raw) {
  if (!raw?.trim()) return []

  // Split on "(NN%)," — each property ends with a percentage
  const pieces = raw.split(/(?<=\(\d+%\))\s*,\s*/)

  return pieces
    .map(p => p
      // Strip trailing (Nickname) (NN%) — the parenthetical owner name + pct
      .replace(/\s*(?:\([^)]+\)\s*)?\(\d+%\)\s*$/, '')
      .trim()
    )
    .filter(p => p.length > 0)
}

// ============================================================================
// MAIN
// ============================================================================
async function run() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: node src/portfolio/import-owners-csv.js "<path to CSV>"')
    process.exit(1)
  }

  console.log(`Reading: ${filePath}`)
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (err) {
    console.error(`Could not read file: ${err.message}`)
    process.exit(1)
  }

  const rows = parseCSV(text)
  console.log(`Parsed ${rows.length} rows\n`)

  const headers       = Object.keys(rows[0] || {})
  const colName       = findCol(headers, 'name')
  const colEmail      = findCol(headers, 'email')
  const colPhone      = findCol(headers, 'phone')
  const colProps      = findCol(headers, 'properties')
  const colLastPay    = findCol(headers, 'last_payment')
  const colLastPkt    = findCol(headers, 'last_packet')
  const colFtb        = findCol(headers, 'ftb_type')
  const colLastUpd    = findCol(headers, 'last_update')
  const colLastCall   = findCol(headers, 'last_call')
  const colReferred   = findCol(headers, 'referred_by')

  console.log('Column mapping:')
  console.log(`  Name        → ${colName || '(not found)'}`)
  console.log(`  Email       → ${colEmail || '(not found)'}`)
  console.log(`  Phone       → ${colPhone || '(not found)'}`)
  console.log(`  Properties  → ${colProps || '(not found)'}`)
  console.log()

  if (!colName) {
    console.error('Could not find a "Name" column in the CSV. Check the headers and try again.')
    process.exit(1)
  }

  const runStamp      = new Date().toISOString()
  let imported        = 0
  let skipped         = 0
  let propLinked      = 0
  const warnings      = []

  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i]
    const name = row[colName]?.trim()

    if (!name) {
      skipped++
      continue
    }

    // First email in list (AppFolio sometimes has "email1, email2")
    const rawEmail = colEmail ? row[colEmail]?.trim() : null
    const email    = rawEmail
      ? rawEmail.split(',')[0].trim().toLowerCase() || null
      : null

    const phone = colPhone ? (row[colPhone]?.trim() || null) : null

    // Stable ID: prefer email so re-imports don't duplicate
    const stableKey  = email || name.toLowerCase().replace(/[^a-z0-9]/g, '_')
    const appfolioId = `csv_import_${stableKey}`

    // Extra fields → raw_payload
    const rawPayload = {}
    if (colLastPay  && row[colLastPay])   rawPayload.last_payment_date              = row[colLastPay]
    if (colLastPkt  && row[colLastPkt])   rawPayload.last_packet_sent               = row[colLastPkt]
    if (colFtb      && row[colFtb])       rawPayload.ftb_type                       = row[colFtb]
    if (colLastUpd  && row[colLastUpd])   rawPayload.owner_last_personalized_update = row[colLastUpd]
    if (colLastCall && row[colLastCall])  rawPayload.owner_last_phone_call          = row[colLastCall]
    if (colReferred && row[colReferred])  rawPayload.referred_by                    = row[colReferred]

    // Upsert owner
    const { data: upserted, error: ownerErr } = await supabase
      .from('owners')
      .upsert(
        {
          appfolio_owner_id: appfolioId,
          name,
          email,
          phone,
          raw_payload:    Object.keys(rawPayload).length ? rawPayload : null,
          last_synced_at: runStamp,
        },
        { onConflict: 'appfolio_owner_id' }
      )
      .select('id')
      .single()

    if (ownerErr) {
      warnings.push(`  ✗ "${name}": ${ownerErr.message}`)
      skipped++
      continue
    }

    imported++
    const ownerId   = upserted.id
    const propsRaw  = colProps ? (row[colProps]?.trim() || '') : ''
    const propNames = parsePropertyNames(propsRaw)

    for (const propName of propNames) {
      const { error: propErr } = await supabase
        .from('owner_properties')
        .upsert(
          { owner_id: ownerId, property_name: propName },
          { ignoreDuplicates: true }
        )
      if (!propErr) {
        propLinked++
      } else {
        warnings.push(`    ✗ Property link "${propName}": ${propErr.message}`)
      }
    }

    process.stdout.write(`\r  Importing ${i + 1}/${rows.length} — ${name.slice(0, 40).padEnd(40)}`)
  }

  console.log('\n')
  console.log('=== Import Complete ===')
  console.log(`Owners imported:    ${imported}`)
  console.log(`Property links:     ${propLinked}`)
  if (skipped > 0) console.log(`Skipped:            ${skipped}`)
  if (warnings.length > 0) {
    console.log('\nWarnings:')
    warnings.forEach(w => console.log(w))
  }
  console.log('\nOpen Owner Health to see your dashboard:')
  console.log('  http://localhost:3002/owner-health.html')
}

run().catch(err => {
  console.error('\nImport failed:', err.message)
  process.exit(1)
})
