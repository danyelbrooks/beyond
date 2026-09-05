// sync-owner-updates.js
// Runs every Sunday at 11:59pm.
// Checks whether each owner with an active-status property received a weekly
// update email from their BPM team inbox (Monday 12am → Sunday 11:59pm).
// Writes evidence to the KPI Google Sheet (@BEYOND, @HELP, @SUCCESS tabs).
// Writes "sent/total" text to the scorecard for beyond, rubin, and mark.
//
// Usage:
//   node src/scorecard/sync-owner-updates.js
//   node src/scorecard/sync-owner-updates.js --dry-run

import 'dotenv/config'
import { readFileSync } from 'fs'
import { google }       from 'googleapis'
import { supabase }     from '../db/server-client.js'

const DRY_RUN  = process.argv.includes('--dry-run')
const LS_KEY   = process.env.LEADSIMPLE_API_KEY
const LS_BASE  = 'https://api.leadsimple.com/rest'
const SHEET_ID = '1PxbQTzL_C3YBhlUt0mCVPJliBNDX4BjSeOTqpdDYhQg'

// Unit nickname keywords that require a weekly owner update
const TRIGGER_KEYWORDS = ['OFFBOARDING','NP','TPO','MO','VACANT','MI','DOWN','PROJECT','INS']

// LeadSimple pipeline IDs
const LS_PIPELINE_TENANTS = '71ad644f-6562-4995-8fe1-b817ff94a685'  // AppFolio Tenants
const LS_PIPELINE_OWNERS  = '107b373d-bca5-4b45-b95a-1cc3200a7d32'  // AppFolio Owner Contracts

// Team config
const TEAMS = [
  { assigneeEmail: 'beyond@bpmsd.com', personKey: 'beyond', sheetTab: '@BEYOND', label: 'Green Team' },
  { assigneeEmail: 'help@bpmsd.com',   personKey: 'rubin',  sheetTab: '@HELP',   label: 'Yellow Team' },
  { assigneeEmail: 'success@bpmsd.com',personKey: 'mark',   sheetTab: '@SUCCESS',label: 'Blue Team'   },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function getWeekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function toDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}

function normalizeAddress(addr) {
  return (addr || '').toLowerCase().replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim()
}

// Keywords must appear as whole words (\b word boundary) so "MI" matches "MI" or "MI-"
// but not "Michael" or "Mitchell". Case-insensitive.
const KW_REGEX = new RegExp(`\\b(${TRIGGER_KEYWORDS.join('|')})\\b`, 'i')

function hasKeyword(str) {
  return KW_REGEX.test(str || '')
}

function matchedKeyword(str) {
  const m = (str || '').match(KW_REGEX)
  return m ? m[1].toUpperCase() : ''
}

// ── LeadSimple paginated fetch ────────────────────────────────────────────────

async function fetchLSAllPages(endpoint, params = {}, label = endpoint) {
  const rows = []
  let page = 1
  while (true) {
    const url = new URL(`${LS_BASE}/${endpoint}`)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    let res, data
    for (let attempt = 1; attempt <= 3; attempt++) {
      res  = await fetch(url.toString(), { headers: { Authorization: `Bearer ${LS_KEY}` } })
      data = await res.json()
      if (res.status === 429 || data?.error?.toLowerCase?.().includes('rate limit')) {
        const wait = attempt * 65000
        console.log(`  Rate limited on ${label} page ${page} — waiting ${wait/1000}s (attempt ${attempt}/3)`)
        await new Promise(r => setTimeout(r, wait))
      } else break
    }

    if (!res.ok || data?.error) {
      throw new Error(`LeadSimple ${label} page ${page} failed (${res.status}): ${JSON.stringify(data).slice(0, 200)}`)
    }

    const items = data.data || []
    rows.push(...items)
    if (!data.meta?.total_pages || page >= data.meta.total_pages) break
    page++
  }
  return rows
}

// ── Google Sheets auth ────────────────────────────────────────────────────────

function getSheetsClient() {
  const keyPath = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY
  if (!keyPath) throw new Error('Missing GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY in .env')
  const key  = JSON.parse(readFileSync(keyPath, 'utf8'))
  const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
  return google.sheets({ version: 'v4', auth })
}

async function writeToSheet(sheets, tab, weekLabel, rows) {
  // rows: [{ ownerName, property, unitStatus, emailSent }]
  const header = [
    [`Owner Updates — ${weekLabel}`, '', '', '', ''],
    ['Owner Name', 'Property', 'Unit Status', 'Team', 'Email Sent This Week'],
  ]
  const dataRows = rows.map(r => [
    r.ownerName,
    r.property,
    r.unitStatus,
    r.teamLabel,
    r.emailSent ? '✓ YES' : '✗ MISSING',
  ])

  const summary = [`Sent: ${rows.filter(r => r.emailSent).length} / ${rows.length}`, '', '', '', '']

  const values = [summary, ...header, ...dataRows]

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would write ${dataRows.length} rows to ${tab} tab`)
    return
  }

  // Clear existing content then write fresh
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${tab}!A1:E200` })
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  })
  console.log(`  Wrote ${dataRows.length} rows to ${tab}`)
}

// ── Upsert scorecard entry ────────────────────────────────────────────────────

async function upsertEntry(weekStart, personKey, metricKey, value, valueText) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] ${personKey} / ${metricKey} = ${valueText ?? value}`)
    return
  }
  const { error } = await supabase
    .from('scorecard_entries')
    .upsert(
      { week_start: weekStart, person_key: personKey, metric_key: metricKey,
        value, value_text: valueText, is_auto: true, entered_by: 'sync-owner-updates' },
      { onConflict: 'week_start,person_key,metric_key' }
    )
  if (error) console.error(`  Error upserting ${personKey}/${metricKey}:`, error.message)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const weekStart  = toDateStr(getWeekStart())
  const weekEnd    = new Date(getWeekStart())
  weekEnd.setDate(weekEnd.getDate() + 6)
  weekEnd.setHours(23, 59, 59, 999)
  const weekEndStr = weekEnd.toISOString()
  const weekStartISO = new Date(weekStart).toISOString()
  const weekLabel  = `${weekStart} → ${toDateStr(weekEnd)}`
  const mode       = DRY_RUN ? 'DRY RUN' : 'LIVE'

  console.log('══════════════════════════════════════════')
  console.log(`  Owner Updates Sync — ${mode}`)
  console.log(`  Week: ${weekLabel}`)
  console.log('══════════════════════════════════════════')

  if (!LS_KEY) {
    console.error('Missing LEADSIMPLE_API_KEY — aborting.')
    process.exit(1)
  }

  // ── Step 1: Build address → team map from AppFolio Tenants pipeline ─────────
  // Tenants pipeline contains ALL units (active and vacant), each assigned to a
  // team inbox. VACANT units may have no active tenant but still have a deal record.
  console.log('\n[1/4] Building property → team map from AppFolio Tenants…')
  const tenantDeals = await fetchLSAllPages('deals', { pipeline_id: LS_PIPELINE_TENANTS }, 'Tenants pipeline')
  const addressTeamMap = {}   // normalized address → { assigneeEmail, teamLabel }
  const streetNumTeamMap = {} // street number → [{ assigneeEmail, teamLabel }] — loose fallback

  for (const deal of tenantDeals) {
    const teamConfig = TEAMS.find(t => t.assigneeEmail === deal.assignee?.email?.toLowerCase())
    if (!teamConfig) continue
    for (const prop of deal.properties || []) {
      const addr = normalizeAddress(`${prop.address} ${prop.city}`)
      if (addr) {
        addressTeamMap[addr] = { assigneeEmail: teamConfig.assigneeEmail, teamLabel: teamConfig.label }
        // Also index by street number for loose fallback
        const num = addr.split(' ')[0]
        if (num && /^\d/.test(num)) {
          if (!streetNumTeamMap[num]) streetNumTeamMap[num] = []
          streetNumTeamMap[num].push({ assigneeEmail: teamConfig.assigneeEmail, teamLabel: teamConfig.label, addr })
        }
      }
    }
  }
  console.log(`  Address→team map: ${Object.keys(addressTeamMap).length} entries`)

  // ── Step 2: Find owners who need updates (keyword in deal name or unit) ──────
  console.log('\n[2/4] Finding owners with active-status properties…')
  const ownerDeals  = await fetchLSAllPages('deals', { pipeline_id: LS_PIPELINE_OWNERS }, 'Owner Contracts pipeline')

  // Each entry: { ownerName, ownerEmails[], property, normalizedAddr, unitStatus, assigneeEmail, teamLabel }
  const needsUpdate = []

  for (const deal of ownerDeals) {
    // Check deal name or any property unit_number for keywords
    const dealName  = deal.name || ''
    const unitNums  = (deal.properties || []).map(p => p.unit?.unit_number || '')
    const addresses = (deal.properties || []).map(p => normalizeAddress(`${p.address} ${p.city}`))
    const propLabel = (deal.properties || []).map(p => `${p.address}, ${p.city}`).join('; ') || dealName

    const triggerStr = [dealName, ...unitNums].join(' ')
    if (!hasKeyword(triggerStr)) continue

    const ownerEmails = (deal.contacts || []).flatMap(c => c.emails || []).filter(Boolean)
    const keyword     = matchedKeyword(triggerStr)

    // Find team: 1) check Owner Contracts assignee directly
    let teamInfo = null
    const assigneeTeam = TEAMS.find(t => t.assigneeEmail === deal.assignee?.email?.toLowerCase())
    if (assigneeTeam) teamInfo = { assigneeEmail: assigneeTeam.assigneeEmail, teamLabel: assigneeTeam.label }

    // 2) exact address match from Tenants map
    if (!teamInfo) {
      for (const addr of addresses) {
        if (addressTeamMap[addr]) { teamInfo = addressTeamMap[addr]; break }
      }
    }

    // 3) street number loose match (when address formatting differs or unit is vacant)
    if (!teamInfo) {
      for (const addr of addresses) {
        const num = addr.split(' ')[0]
        if (num && streetNumTeamMap[num]?.length === 1) {
          teamInfo = streetNumTeamMap[num][0]; break
        }
      }
    }

    if (!teamInfo) {
      console.log(`  WARN: no team found for "${dealName}" — skipping`)
      continue
    }

    needsUpdate.push({
      ownerName:     deal.name,
      ownerEmails,
      property:      propLabel,
      unitStatus:    keyword,
      assigneeEmail: teamInfo.assigneeEmail,
      teamLabel:     teamInfo.teamLabel,
    })
  }
  console.log(`  Owners needing weekly update: ${needsUpdate.length}`)

  // ── Step 3: Check email_cache for sent emails ────────────────────────────────
  console.log('\n[3/4] Checking email_cache for owner updates sent this week…')

  for (const owner of needsUpdate) {
    if (owner.ownerEmails.length === 0) {
      owner.emailSent = false
      owner.note = 'no email on file'
      continue
    }

    // Check if any email was sent FROM the team inbox TO any of the owner's emails
    let sent = false
    for (const ownerEmail of owner.ownerEmails) {
      const { count, error } = await supabase
        .from('email_cache')
        .select('id', { count: 'exact', head: true })
        .ilike('from_address', `%${owner.assigneeEmail}%`)
        .ilike('to_address',   `%${ownerEmail}%`)
        .gte('received_at', weekStartISO)
        .lte('received_at', weekEndStr)

      if (!error && count > 0) { sent = true; break }
    }
    owner.emailSent = sent
  }

  // ── Step 4: Write to Google Sheet and scorecard ──────────────────────────────
  console.log('\n[4/4] Writing results to Google Sheet and scorecard…')

  let sheets = null
  try { sheets = getSheetsClient() } catch (e) {
    console.warn('  Google Sheets not available:', e.message)
  }

  for (const team of TEAMS) {
    const teamOwners = needsUpdate.filter(o => o.assigneeEmail === team.assigneeEmail)
    const sent  = teamOwners.filter(o => o.emailSent).length
    const total = teamOwners.length
    const text  = `${sent}/${total}`

    console.log(`\n  ${team.sheetTab} (${team.label}): ${text}`)
    teamOwners.forEach(o => {
      const icon = o.emailSent ? '✓' : '✗'
      console.log(`    ${icon} ${o.ownerName} | ${o.property} | ${o.unitStatus}${o.note ? ' | ' + o.note : ''}`)
    })

    // Write to Google Sheet
    if (sheets && teamOwners.length > 0) {
      try {
        await writeToSheet(sheets, team.sheetTab, weekLabel, teamOwners)
      } catch (e) {
        console.warn(`  Sheet write failed for ${team.sheetTab}:`, e.message)
      }
    }

    // Write to scorecard
    await upsertEntry(weekStart, team.personKey, 'owner_updates_sunday', sent, text)
  }

  console.log('\n══════════════════════════════════════════')
  console.log('  Owner Updates Sync complete.')
  console.log('══════════════════════════════════════════\n')
}

main().catch(err => { console.error(err); process.exit(1) })
