import { supabase } from '../db/server-client.js'
import { readFileSync } from 'fs'

const CSV_PATH = 'C:\\Users\\sagei\\Downloads\\property_directory-20260722.csv'
const TODAY = new Date('2026-07-22')
const DRY_RUN = !process.argv.includes('--insert')

const SKIP_NAMES = new Set(['beyond property management', 'total', ''])

function parseDate(str) {
  if (!str) return null
  const parts = str.trim().split('/')
  if (parts.length !== 3) return null
  const [m, d, y] = parts
  const dt = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
  return isNaN(dt) ? null : dt
}

function calcYears(startDate) {
  return Math.floor((TODAY - startDate) / (1000 * 60 * 60 * 24 * 365.25))
}

function normName(s) {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

const ENTITY_KEYWORDS = /\b(trust|llc|corp|inc|ltd|group|properties|investments|holdings|acquisition|acquisitions|bank)\b/i
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv'])
const ENTITY_STOP   = new Set(['trust', 'family', 'living', 'revocable', 'irrevocable', 'dated', 'executed', 'group', 'management'])

// Normalize a name to clean alphabetic words (>=2 chars); joins hyphens so El-Tayeb -> eltayeb
function normWords(s) {
  return s.toLowerCase()
    .replace(/-/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length >= 2)
}

// Last word of each comma-segment (skipping Jr/Sr/etc) -> last name(s) from a CSV entry
function csvLastNames(csvName) {
  const results = new Set()
  for (const segment of csvName.split(',')) {
    const words = normWords(segment.replace(/&/g, ' '))
    for (let i = words.length - 1; i >= 0; i--) {
      if (!NAME_SUFFIXES.has(words[i])) { results.add(words[i]); break }
    }
  }
  return results
}

// All words before the last-name word in each CSV segment -> first/middle names
function csvFirstNames(csvName) {
  const results = new Set()
  for (const segment of csvName.split(',')) {
    const words = normWords(segment.replace(/&/g, ' '))
    let lnIdx = words.length - 1
    while (lnIdx > 0 && NAME_SUFFIXES.has(words[lnIdx])) lnIdx--
    for (let i = 0; i < lnIdx; i++) {
      if (!NAME_SUFFIXES.has(words[i])) results.add(words[i])
    }
  }
  return results
}

// First-name words from a DB entry (everything after the comma, if present)
function dbFirstNames(name) {
  const idx = name.indexOf(',')
  const part = idx > 0 ? name.slice(idx + 1) : name
  return new Set(normWords(part.replace(/&/g, ' ')))
}

// Entity-identifying words (long, non-generic)
function entityWords(s) {
  return normWords(s).filter(w => w.length >= 6 && !ENTITY_STOP.has(w))
}

// Match CSV entry to DB owner -- returns "none" | "lastonly" | "full"
function matchStrength(csvName, dbName) {
  // Step 1: exact match catches identical names and no-comma DB entries
  if (normName(csvName) === normName(dbName)) return 'full'

  const csvIsEntity = ENTITY_KEYWORDS.test(csvName)
  const dbIsEntity  = ENTITY_KEYWORDS.test(dbName)

  // Step 2: entity-vs-entity -- share a significant unique word (>=6 chars, non-generic)
  if (csvIsEntity && dbIsEntity) {
    const wa = entityWords(csvName)
    const wb = entityWords(dbName)
    return wa.some(w => wb.includes(w)) ? 'full' : 'none'
  }

  // Step 3: person-vs-person -- last name appears as a word anywhere in the DB name,
  // then disambiguate with first name
  if (!csvIsEntity && !dbIsEntity) {
    const csvLNs = csvLastNames(csvName)
    const dbWords = new Set(normWords(dbName))

    const lastNameMatch = csvLNs.size > 0 && [...csvLNs].some(ln => dbWords.has(ln))
    if (!lastNameMatch) return 'none'

    const csvFNs = csvFirstNames(csvName)
    const dbFNs  = dbFirstNames(dbName)
    const firstMatch = csvFNs.size > 0 && [...csvFNs].some(w => dbFNs.has(w))
    return firstMatch ? 'full' : 'lastonly'
  }

  return 'none'
}

// Minimal CSV parser that handles quoted fields with embedded commas
function parseCSV(content) {
  const rows = []
  const lines = content.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const fields = []
    let field = ''
    let inQ = false
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      if (ch === '"') { inQ = !inQ }
      else if (ch === ',' && !inQ) { fields.push(field); field = '' }
      else { field += ch }
    }
    fields.push(field)
    rows.push(fields)
  }
  return rows
}

async function main() {
  const content = readFileSync(CSV_PATH, 'utf8')
  const rows = parseCSV(content)

  // Group by owner: track earliest start date and property count
  // Key = normalized owner name from CSV
  const ownerMap = new Map() // normName -> { rawName, earliest, count }

  for (const fields of rows) {
    const rawOwner = fields[0]?.trim() ?? ''
    const dateStr  = fields[3]?.trim() ?? ''
    const normOwner = normName(rawOwner)

    if (SKIP_NAMES.has(normOwner)) continue
    if (normOwner.startsWith('beyond property management')) continue

    const date = parseDate(dateStr)
    if (!date) continue

    if (!ownerMap.has(normOwner)) {
      ownerMap.set(normOwner, { rawName: rawOwner, earliest: date, count: 1 })
    } else {
      const entry = ownerMap.get(normOwner)
      if (date < entry.earliest) entry.earliest = date
      entry.count++
    }
  }

  console.log(`Unique owners in CSV: ${ownerMap.size}`)

  // Load all owners from Supabase
  const { data: dbOwners, error: dbErr } = await supabase
    .from('owners')
    .select('id, name, email')

  if (dbErr) { console.error('Failed to load owners:', dbErr.message); process.exit(1) }
  console.log(`Owners in database:   ${dbOwners.length}\n`)

  // Match CSV entries to DB owners
  // Uses word-level matching to handle "First Last" (CSV) vs "Last, First" (DB)
  const matched = []
  const unmatched = []

  for (const [, { rawName, earliest, count }] of ownerMap) {
    // Score each DB owner against this CSV entry
    const scored = dbOwners
      .map(db => ({ db, strength: matchStrength(rawName, db.name ?? '') }))
      .filter(r => r.strength !== 'none')

    // Prefer full matches (last + first name); fall back to last-only if no full match
    const fullHits = scored.filter(r => r.strength === 'full').map(r => r.db)
    const hits = fullHits.length > 0
      ? fullHits
      : scored.filter(r => r.strength === 'lastonly').map(r => r.db)

    if (hits.length === 0) {
      unmatched.push({ rawName, earliest, count })
    } else {
      for (const db of hits) {
        matched.push({
          owner_id:       db.id,
          db_name:        db.name,
          csv_name:       rawName,
          start_date:     earliest,
          years_as_client: calcYears(earliest),
          property_count: count,
        })
      }
    }
  }

  // Print matches
  console.log(`--- MATCHED (${matched.length}) ---`)
  for (const m of matched) {
    console.log(
      `  OK "${m.db_name}"  <-  "${m.csv_name}"\n` +
      `    Started: ${m.start_date.toISOString().slice(0, 10)}  |  ` +
      `${m.years_as_client} yrs  |  ${m.property_count} propert${m.property_count === 1 ? 'y' : 'ies'}`
    )
  }

  if (unmatched.length > 0) {
    console.log(`\n--- UNMATCHED -- no database record found (${unmatched.length}) ---`)
    for (const u of unmatched) {
      console.log(`  X "${u.rawName}"  |  ${u.earliest.toISOString().slice(0, 10)}  |  ${calcYears(u.earliest)} yrs`)
    }
  }

  // Deduplicate: if the same DB owner was matched by multiple CSV entries
  // (e.g. an owner with 3 LLCs), keep the EARLIEST start date and highest property count
  const byOwner = new Map()
  for (const m of matched) {
    const prev = byOwner.get(m.owner_id)
    if (!prev || m.start_date < prev.start_date) {
      byOwner.set(m.owner_id, m)
    } else if (m.property_count > prev.property_count) {
      prev.property_count = m.property_count
    }
  }

  console.log(`\nUnique DB owners to update: ${byOwner.size}`)
  console.log(`Unmatched: ${unmatched.length}`)

  if (DRY_RUN) {
    console.log('\n[DRY RUN -- nothing written. Run with --insert to save.]\n')
    return
  }

  // Upsert into owner_profiles
  const upsertRows = [...byOwner.values()].map(m => ({
    owner_id:       m.owner_id,
    years_as_client: m.years_as_client,
    property_count: m.property_count,
  }))

  const { error: upsertErr } = await supabase
    .from('owner_profiles')
    .upsert(upsertRows, { onConflict: 'owner_id' })

  if (upsertErr) { console.error('Upsert failed:', upsertErr.message); process.exit(1) }

  console.log(`\nSaved ${upsertRows.length} owner profiles (years_as_client + property_count).`)
  console.log('Run `npm run score:owners` to recalculate scores with the new relationship bonus.\n')
}

main().catch(err => { console.error(err); process.exit(1) })
