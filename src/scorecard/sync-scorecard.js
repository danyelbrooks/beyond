// sync-scorecard.js
// Pulls automated scorecard data for the current week and upserts
// into scorecard_entries. One failing source does not stop the others.
//
// Usage:
//   node src/scorecard/sync-scorecard.js
//   node src/scorecard/sync-scorecard.js --dry-run

import 'dotenv/config'
import { readFileSync } from 'fs'
import { google }       from 'googleapis'
import { supabase }     from '../db/server-client.js'

const SHEET_ID = '1PxbQTzL_C3YBhlUt0mCVPJliBNDX4BjSeOTqpdDYhQg'

function getSheetsClient() {
  const keyPath = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY
  if (!keyPath) return null
  try {
    const key  = JSON.parse(readFileSync(keyPath, 'utf8'))
    const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
    return google.sheets({ version: 'v4', auth })
  } catch { return null }
}

const DRY_RUN       = process.argv.includes('--dry-run')
const CLIENT_ID     = process.env.APPFOLIO_STACK_CLIENT_ID
const CLIENT_SECRET = process.env.APPFOLIO_STACK_CLIENT_SECRET
const DEVELOPER_ID  = process.env.APPFOLIO_DEVELOPER_ID
const LS_KEY        = process.env.LEADSIMPLE_API_KEY
const BASIC_AUTH    = CLIENT_ID && CLIENT_SECRET
  ? Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  : null
const BASE          = 'https://api.appfolio.com/api/v0'
const LS_BASE       = 'https://api.leadsimple.com/rest'

// ── Week calculation ─────────────────────────────────────────────────────────

function getWeekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function toDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function weekRange(weekStart) {
  const start = new Date(weekStart)
  const end   = new Date(weekStart)
  end.setDate(end.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  return { start: start.toISOString(), end: end.toISOString() }
}

// ── Results tracker ──────────────────────────────────────────────────────────

const results = { written: 0, sources: {} }
function logSource(key, status) { results.sources[key] = status }

// ── Upsert helper ────────────────────────────────────────────────────────────

async function upsertEntry(weekStart, personKey, metricKey, value, { valueText = null, isAuto = true } = {}) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] ${personKey} / ${metricKey} = ${value ?? valueText}`)
    results.written++
    return
  }
  const { error } = await supabase
    .from('scorecard_entries')
    .upsert(
      {
        week_start: weekStart,
        person_key: personKey,
        metric_key: metricKey,
        value:      value !== undefined ? value : null,
        value_text: valueText,
        is_auto:    isAuto,
        entered_by: 'sync-scorecard',
      },
      { onConflict: 'week_start,person_key,metric_key' }
    )
  if (error) {
    console.error(`  Error upserting ${personKey}/${metricKey}:`, error.message)
  } else {
    results.written++
  }
}

// ── AppFolio Stack API fetch (paginated) ─────────────────────────────────────

async function fetchAll(endpoint, params = {}) {
  if (!BASIC_AUTH) throw new Error('Missing APPFOLIO_STACK_CLIENT_ID or APPFOLIO_STACK_CLIENT_SECRET in .env')
  const rows = []
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
    rows.push(...items)
    if (!data.next_page_path || items.length < 500) break
    pageNum++
  }
  return rows
}

// ── AppFolio property-group map ───────────────────────────────────────────────
// Builds a map of propertyId → group key ('green_team'|'yellow_team'|'blue_team')
// so we can filter AppFolio results per team lead.

let _propGroupMap = null

async function getPropertyGroupMap() {
  if (_propGroupMap) return _propGroupMap
  _propGroupMap = {}
  try {
    const props = await fetchAll('properties', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' })
    let mapped = 0
    for (const p of props) {
      const id    = p.Id || p.PropertyID || p.id
      const group = (p.PropertyGroupName || p.GroupName || p.Group || p.PropertyGroup || '').toLowerCase()
      if (!id) continue
      if (group.includes('green'))  { _propGroupMap[id] = 'green_team';  mapped++ }
      else if (group.includes('yellow')) { _propGroupMap[id] = 'yellow_team'; mapped++ }
      else if (group.includes('blue'))   { _propGroupMap[id] = 'blue_team';   mapped++ }
    }
    console.log(`  Property group map built: ${props.length} properties, ${mapped} grouped`)
  } catch (err) {
    console.warn('  Could not build property group map:', err.message)
  }
  return _propGroupMap
}

function filterByGroup(items, groupKey, propGroupMap, propIdField = null) {
  if (!propIdField || Object.keys(propGroupMap).length === 0) return items
  return items.filter(item => {
    const pid = item[propIdField]
    return propGroupMap[pid] === groupKey
  })
}

// ── LeadSimple API fetch (calls) ──────────────────────────────────────────────
// LeadSimple does not support date filtering — we paginate from the last page
// backwards and stop once we go past 7 days ago.

async function fetchLSCallsLastDays(days = 7) {
  if (!LS_KEY) throw new Error('Missing LEADSIMPLE_API_KEY in .env')
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Get total page count
  const first = await fetch(`${LS_BASE}/calls?per_page=50&page=1`, {
    headers: { Authorization: `Bearer ${LS_KEY}` },
  })
  const firstData = await first.json()
  const totalPages = firstData.meta?.total_pages || 1

  const recentCalls = []
  let page = totalPages
  let done = false

  while (page >= 1 && !done) {
    const res = await fetch(`${LS_BASE}/calls?per_page=50&page=${page}`, {
      headers: { Authorization: `Bearer ${LS_KEY}` },
    })
    const data  = await res.json()
    const calls = data.data || []

    // Page is oldest-first — iterate newest to oldest
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i]
      if (new Date(call.created_at) < cutoff) { done = true; break }
      recentCalls.push(call)
    }

    // If the oldest call on this page is already before our cutoff, stop
    if (!done && calls.length > 0 && new Date(calls[0].created_at) < cutoff) done = true

    page--
  }

  return recentCalls
}

// ── SOURCE: email_count ───────────────────────────────────────────────────────

async function syncEmailCounts(weekStart) {
  console.log('\n[email_count] Counting this-week emails per inbox…')
  const { start, end } = weekRange(new Date(weekStart))

  const inboxMap = {
    beyond:   'beyond@bpmsd.com',
    rubin:    'help@bpmsd.com',
    mark:     'success@bpmsd.com',
    gael:     'home@bpmsd.com',
    ella:     'admin@bpmsd.com',
    moira:    'accounts@bpmsd.com',
    nayelie:  'info@bpmsd.com',
  }

  let teamTotal = 0

  for (const [personKey, email] of Object.entries(inboxMap)) {
    try {
      const { count, error } = await supabase
        .from('email_cache')
        .select('id', { count: 'exact', head: true })
        .ilike('from_address', `%${email}%`)
        .gte('received_at', start)
        .lte('received_at', end)

      if (error) throw error
      console.log(`  ${personKey} (${email}): ${count} emails`)
      await upsertEntry(weekStart, personKey, 'emails', count)
      teamTotal += count || 0
    } catch (err) {
      console.warn(`  Warning — could not count emails for ${personKey}:`, err.message)
    }
  }

  console.log(`  Team total emails: ${teamTotal}`)
  await upsertEntry(weekStart, 'moira', 'team_total_emails', teamTotal)
  logSource('email_count', 'ok')
}

// ── SOURCE: turning_points_email ──────────────────────────────────────────────
// Count emails FROM danyel@ with subject containing 'turning' this week.
// Same total written to all three team leads.

async function syncTurningPointsEmail(weekStart) {
  console.log('\n[turning_points_email] Counting Danyel escalation emails…')
  const { start, end } = weekRange(new Date(weekStart))

  try {
    const { count, error } = await supabase
      .from('email_cache')
      .select('id', { count: 'exact', head: true })
      .ilike('from_address', '%danyel@%')
      .ilike('subject', '%turning%')
      .gte('received_at', start)
      .lte('received_at', end)

    if (error) throw error
    console.log(`  Turning point escalations this week: ${count}`)

    await upsertEntry(weekStart, 'beyond', 'turning_points', count)
    await upsertEntry(weekStart, 'rubin',  'turning_points', count)
    await upsertEntry(weekStart, 'mark',   'turning_points', count)
    logSource('turning_points_email', 'ok')
  } catch (err) {
    console.warn('  turning_points_email failed:', err.message)
    logSource('turning_points_email', `error: ${err.message}`)
  }
}

// ── SOURCE: appfolio_security_deposits ────────────────────────────────────────
// Count tenants where move-in was >21 days ago and no security deposit recorded.
// Filtered per team (beyond=green, rubin=yellow, mark=blue).

async function syncSecurityDeposits(weekStart) {
  console.log('\n[appfolio_security_deposits] Checking security deposits…')
  try {
    const [tenants, propGroupMap] = await Promise.all([
      fetchAll('tenants', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' }),
      getPropertyGroupMap(),
    ])

    const current = tenants.filter(t => t.Status === 'Current')
    const cutoff  = new Date()
    cutoff.setDate(cutoff.getDate() - 21)

    const over21    = current.filter(t => {
      const moveIn = t.MoveInOn || t.MoveInDate
      return moveIn && new Date(moveIn) <= cutoff
    })
    // Check if AppFolio actually returns deposit data — if every tenant shows null,
    // the field isn't exposed in this plan and we can't calculate this metric.
    const hasDepositField = over21.some(t =>
      t.SecurityDepositAmount !== undefined ||
      t.SecurityDeposit !== undefined ||
      t.DepositAmount !== undefined
    )
    if (!hasDepositField) {
      console.log('  Security deposit field not available in AppFolio API — manual entry needed.')
      logSource('appfolio_security_deposits', 'not available — manual entry needed')
      return
    }

    const noDeposit = over21.filter(t => {
      const dep = t.SecurityDepositAmount ?? t.SecurityDeposit ?? t.DepositAmount
      return dep === null || dep === undefined || Number(dep) === 0
    })

    if (over21.length === 0) {
      console.log('  No tenants past 21 days — skipping.')
      logSource('appfolio_security_deposits', 'skipped — no tenants past 21 days')
      return
    }

    const grouped = groupByTeam(noDeposit, propGroupMap, 'PropertyID')
    console.log(`  >21 days no deposit: green=${grouped.green_team} | yellow=${grouped.yellow_team} | blue=${grouped.blue_team} | total=${noDeposit.length}`)

    await upsertEntry(weekStart, 'beyond', 'security_deposits_past_21', grouped.green_team)
    await upsertEntry(weekStart, 'rubin',  'security_deposits_past_21', grouped.yellow_team)
    await upsertEntry(weekStart, 'mark',   'security_deposits_past_21', grouped.blue_team)
    logSource('appfolio_security_deposits', 'ok')
  } catch (err) {
    console.warn('  appfolio_security_deposits failed:', err.message)
    logSource('appfolio_security_deposits', `error: ${err.message}`)
  }
}

// ── SOURCE: appfolio_wo ───────────────────────────────────────────────────────
// Open work orders per property, filtered per team.

async function syncWorkOrdersPerProperty(weekStart) {
  console.log('\n[appfolio_wo] Calculating work orders per property…')
  try {
    const [workOrders, properties, propGroupMap] = await Promise.all([
      fetchAll('workorders', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' }),
      fetchAll('properties', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' }),
      getPropertyGroupMap(),
    ])

    const open = workOrders.filter(wo =>
      !['Completed', 'Closed', 'Cancelled'].includes(wo.Status || wo.status || '')
    )

    const propsByGroup = {
      green_team:  properties.filter(p => propGroupMap[p.Id || p.PropertyID] === 'green_team'),
      yellow_team: properties.filter(p => propGroupMap[p.Id || p.PropertyID] === 'yellow_team'),
      blue_team:   properties.filter(p => propGroupMap[p.Id || p.PropertyID] === 'blue_team'),
    }

    const openByGroup = {
      green_team:  open.filter(wo => propGroupMap[wo.PropertyID] === 'green_team'),
      yellow_team: open.filter(wo => propGroupMap[wo.PropertyID] === 'yellow_team'),
      blue_team:   open.filter(wo => propGroupMap[wo.PropertyID] === 'blue_team'),
    }

    const calc = (group) => {
      const pc = propsByGroup[group].length || properties.length || 1
      const wc = openByGroup[group].length || 0
      // If no group mapping found, fall back to company-wide
      const propCount = propsByGroup[group].length > 0 ? propsByGroup[group].length : properties.length
      const woCount   = openByGroup[group].length > 0 || Object.keys(propGroupMap).length > 0
        ? openByGroup[group].length
        : open.length
      return propCount > 0 ? parseFloat((woCount / propCount).toFixed(2)) : 0
    }

    const green  = calc('green_team')
    const yellow = calc('yellow_team')
    const blue   = calc('blue_team')
    console.log(`  WO/property: beyond=${green} | rubin=${yellow} | mark=${blue}`)

    await upsertEntry(weekStart, 'beyond', 'wo_per_property', green)
    await upsertEntry(weekStart, 'rubin',  'wo_per_property', yellow)
    await upsertEntry(weekStart, 'mark',   'wo_per_property', blue)
    logSource('appfolio_wo', 'ok')
  } catch (err) {
    if (err.message.includes('404') || err.message.includes('not found')) {
      console.log('  /workorders not available on this AppFolio plan — manual entry needed.')
      logSource('appfolio_wo', 'not available — manual entry needed')
    } else {
      console.warn('  appfolio_wo failed:', err.message)
      logSource('appfolio_wo', `error: ${err.message}`)
    }
  }
}

// ── SOURCE: days_on_market ────────────────────────────────────────────────────
// Reads listing_first_seen (populated daily by sync-listing-dates.js) to get
// start dates. End date = AppFolio "Future" tenant move-in date if assigned,
// otherwise today. Groups by team via AppFolio property group map.

async function fetchFutureTenants() {
  const tenants = []
  let page = 1
  while (true) {
    const url = new URL(`${BASE}/tenants`)
    url.searchParams.set('page[number]', String(page))
    url.searchParams.set('page[size]', '500')
    url.searchParams.set('filters[LastUpdatedAtFrom]', '1970-01-01T00:00:00Z')
    const res = await fetch(url.toString(), {
      headers: {
        Authorization:             `Basic ${BASIC_AUTH}`,
        'X-AppFolio-Developer-ID': DEVELOPER_ID,
        Accept:                    'application/json',
      },
    })
    if (!res.ok) break
    const data  = await res.json()
    const items = data.data || []
    tenants.push(...items.filter(t => t.Status === 'Future'))
    if (!data.next_page_path || items.length < 500) break
    page++
  }
  return tenants
}

async function syncDaysOnMarket(weekStart) {
  console.log('\n[days_on_market] Reading listing_first_seen table…')
  try {
    // Read listings seen in the last 60 days (active + recently leased)
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - 60)
    const cutoff = cutoffDate.toISOString().split('T')[0]

    const { data: listings, error: dbErr } = await supabase
      .from('listing_first_seen')
      .select('listing_id, address, unit_id, property_id, first_seen, last_seen')
      .gte('last_seen', cutoff)

    if (dbErr) throw dbErr
    if (!listings || listings.length === 0) {
      console.log('  No listings in database yet — run sync-listing-dates.js first.')
      logSource('days_on_market', 'no data — listing_first_seen table empty')
      return
    }
    console.log(`  Found ${listings.length} listing(s) active in last 60 days`)

    // Fetch Future tenants from AppFolio → unit_id → MoveInOn
    console.log('  Fetching AppFolio Future tenants…')
    const futureTenants = await fetchFutureTenants()
    const unitMoveIn = {}
    for (const t of futureTenants) {
      if (t.UnitId && t.MoveInOn) unitMoveIn[t.UnitId] = t.MoveInOn
    }
    console.log(`  Future tenants with move-in dates: ${Object.keys(unitMoveIn).length}`)

    // Build property group map for team assignment
    const propGroupMap = await getPropertyGroupMap()

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // Calculate DOM for each listing
    const enriched = []
    for (const l of listings) {
      const firstSeen  = new Date(l.first_seen)
      const moveInDate = l.unit_id ? unitMoveIn[l.unit_id] : null
      const endDate    = moveInDate ? new Date(moveInDate) : today
      const dom        = Math.max(0, Math.round((endDate - firstSeen) / (1000 * 60 * 60 * 24)))

      const team = l.property_id ? (propGroupMap[l.property_id] || 'unknown') : 'unknown'

      const teamLabel = { green_team: 'Green (Beyond)', yellow_team: 'Yellow (Help)', blue_team: 'Blue (Success)' }[team] || 'Unassigned'
      console.log(`    [${l.listing_id}] ${l.address} | team=${teamLabel} | DOM=${dom}d | first_seen=${l.first_seen}${moveInDate ? ' | move_in='+moveInDate : ''}`)

      enriched.push({ ...l, team, dom, moveInDate })
    }

    // Average DOM per team
    function teamAvg(t) {
      const rows = enriched.filter(l => l.team === t)
      if (rows.length === 0) return null
      return Math.round(rows.reduce((s, l) => s + l.dom, 0) / rows.length)
    }

    const greenAvg  = teamAvg('green_team')
    const yellowAvg = teamAvg('yellow_team')
    const blueAvg   = teamAvg('blue_team')
    const allAvg    = enriched.length > 0
      ? Math.round(enriched.reduce((s, l) => s + l.dom, 0) / enriched.length)
      : null

    console.log(`  Avg DOM: beyond=${greenAvg ?? 'n/a'} | rubin=${yellowAvg ?? 'n/a'} | mark=${blueAvg ?? 'n/a'} | gael/all=${allAvg ?? 'n/a'}`)

    // Write to scorecard
    if (greenAvg  !== null) await upsertEntry(weekStart, 'beyond', 'days_on_market', greenAvg)
    if (yellowAvg !== null) await upsertEntry(weekStart, 'rubin',  'days_on_market', yellowAvg)
    if (blueAvg   !== null) await upsertEntry(weekStart, 'mark',   'days_on_market', blueAvg)
    if (allAvg    !== null) await upsertEntry(weekStart, 'gael',   'days_on_market', allAvg)

    // Write breakdown to Google Sheet "Days on Market" tab
    const sheets = getSheetsClient()
    if (sheets && !DRY_RUN) {
      try {
        const TEAM_ORDER = ['green_team', 'yellow_team', 'blue_team', 'unknown']
        const TEAM_LABEL = {
          green_team:  'Green (Beyond)',
          yellow_team: 'Yellow (Help)',
          blue_team:   'Blue (Success)',
          unknown:     'Unassigned',
        }
        const header = [
          ['Days on Market — ' + weekStart, '', '', '', '', ''],
          ['', '', '', '', '', ''],
          ['How calculated: Start = date first listed on BPM website. End = AppFolio future move-in date (if signed) or today.', '', '', '', '', ''],
          ['', '', '', '', '', ''],
          ['Property Address', 'Team', 'First Listed', 'End Date', 'Days on Market', 'Notes'],
        ]
        const rows = TEAM_ORDER.flatMap(t => {
          const group = enriched.filter(l => l.team === t)
          if (group.length === 0) return []
          const avg = Math.round(group.reduce((s, l) => s + l.dom, 0) / group.length)
          return [
            [TEAM_LABEL[t], '', '', `Team avg: ${avg} days`, '', ''],
            ...group.map(l => [
              l.address,
              TEAM_LABEL[l.team],
              l.first_seen,
              l.moveInDate || 'Active (today)',
              l.dom,
              '',
            ]),
            ['', '', '', '', '', ''],
          ]
        })
        const values = [...header, ...rows]
        await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: 'Days on Market!A1:F300' })
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID, range: 'Days on Market!A1',
          valueInputOption: 'RAW', requestBody: { values },
        })
        console.log('  Wrote DOM breakdown to Google Sheet "Days on Market" tab')
      } catch (sheetErr) {
        console.warn('  Sheet write failed:', sheetErr.message)
      }
    }

    logSource('days_on_market', `ok — ${enriched.length} listings, avg all=${allAvg ?? 'n/a'}d`)
  } catch (err) {
    console.warn('  days_on_market failed:', err.message)
    logSource('days_on_market', `error: ${err.message}`)
  }
}

// ── SOURCE: resident_health ───────────────────────────────────────────────────
// Count at-risk residents from v_resident_health view.

async function syncResidentHealth(weekStart) {
  console.log('\n[resident_health] Counting at-risk residents…')
  try {
    const { count, error } = await supabase
      .from('v_resident_health')
      .select('resident_id', { count: 'exact', head: true })
      .eq('tier', 'at_risk')

    if (error) throw error
    console.log(`  At-risk residents: ${count}`)
    await upsertEntry(weekStart, 'beyond', 'resident_health_at_risk', count)
    await upsertEntry(weekStart, 'rubin',  'resident_health_at_risk', count)
    await upsertEntry(weekStart, 'mark',   'resident_health_at_risk', count)
    logSource('resident_health', 'ok')
  } catch (err) {
    console.warn('  resident_health failed:', err.message)
    logSource('resident_health', `error: ${err.message}`)
  }
}

// ── SOURCE: owner_health ──────────────────────────────────────────────────────
// Count at-risk owners from v_owner_health view.

async function syncOwnerHealth(weekStart) {
  console.log('\n[owner_health] Counting at-risk owners…')
  try {
    const { count, error } = await supabase
      .from('v_owner_health')
      .select('owner_id', { count: 'exact', head: true })
      .eq('tier', 'at_risk')

    if (error) throw error
    console.log(`  At-risk owners: ${count}`)
    await upsertEntry(weekStart, 'beyond', 'owner_health_at_risk', count)
    await upsertEntry(weekStart, 'rubin',  'owner_health_at_risk', count)
    await upsertEntry(weekStart, 'mark',   'owner_health_at_risk', count)
    logSource('owner_health', 'ok')
  } catch (err) {
    console.warn('  owner_health failed:', err.message)
    logSource('owner_health', `error: ${err.message}`)
  }
}

// ── SOURCE: call_answer_rate ──────────────────────────────────────────────────
// Pull inbound calls from LeadSimple for the past 7 days.
// Group by deal.assignee.email to get per-person answer rate.
// Answered = outcome === 'answered'. Total = all inbound calls.

async function syncCallAnswerRate(weekStart) {
  console.log('\n[call_answer_rate] Pulling LeadSimple inbound calls (last 7 days)…')
  if (!LS_KEY) {
    console.log('  No LEADSIMPLE_API_KEY — skipping.')
    logSource('call_answer_rate', 'skipped — no LEADSIMPLE_API_KEY')
    return
  }

  const emailToPersonKey = {
    'beyond@bpmsd.com':   'beyond',
    'help@bpmsd.com':     'rubin',
    'success@bpmsd.com':  'mark',
    'home@bpmsd.com':     'gael',
    'admin@bpmsd.com':    'ella',
    'accounts@bpmsd.com': 'moira',
    'info@bpmsd.com':     'nayelie',
  }

  const tally = {}
  for (const pk of Object.values(emailToPersonKey)) {
    tally[pk] = { answered: 0, total: 0 }
  }

  try {
    const calls = await fetchLSCallsLastDays(7)
    console.log(`  Fetched ${calls.length} calls from last 7 days`)

    for (const call of calls) {
      if (call.direction !== 'inbound') continue
      const email = call.deal?.assignee?.email?.toLowerCase()
      const pk    = email ? emailToPersonKey[email] : null
      if (!pk) continue

      tally[pk].total++
      if (call.outcome === 'answered') tally[pk].answered++
    }

    for (const [pk, { answered, total }] of Object.entries(tally)) {
      if (total === 0) {
        console.log(`  ${pk}: no inbound calls — skipping`)
        continue
      }
      const rate = Math.round((answered / total) * 100)
      console.log(`  ${pk}: ${answered}/${total} answered = ${rate}%`)
      await upsertEntry(weekStart, pk, 'call_answer_rate', rate)
    }

    logSource('call_answer_rate', 'ok')
  } catch (err) {
    console.warn('  call_answer_rate failed:', err.message)
    logSource('call_answer_rate', `error: ${err.message}`)
  }
}

// ── SOURCE: resident_satisfaction ────────────────────────────────────────────
// Pull active tenant deals from LeadSimple (AppFolio Tenants pipeline,
// stages: Signed Lease + Notice). Map each resident's email to a team via
// deal.assignee.email. Join to v_resident_health scores. Average per team
// and convert the 0–100 health score to a 1–5 satisfaction scale.

const LS_APPFOLIO_TENANTS_PIPELINE = '71ad644f-6562-4995-8fe1-b817ff94a685'
const ACTIVE_STAGES = new Set(['Signed Lease', 'Notice'])

async function fetchLSDealsAllPages(pipelineId) {
  const rows = []
  let page = 1
  while (true) {
    const res = await fetch(
      `${LS_BASE}/deals?per_page=100&pipeline_id=${pipelineId}&page=${page}`,
      { headers: { Authorization: `Bearer ${LS_KEY}` } }
    )
    const data  = await res.json()
    const items = data.data || []
    rows.push(...items)
    if (!data.meta?.total_pages || page >= data.meta.total_pages) break
    page++
  }
  return rows
}

async function syncResidentSatisfaction(weekStart) {
  console.log('\n[resident_satisfaction] Scoring residents by team from LeadSimple…')
  if (!LS_KEY) {
    console.log('  No LEADSIMPLE_API_KEY — skipping.')
    logSource('resident_satisfaction', 'skipped — no LEADSIMPLE_API_KEY')
    return
  }

  const emailToTeam = {
    'beyond@bpmsd.com':  'green_team',
    'help@bpmsd.com':    'yellow_team',
    'success@bpmsd.com': 'blue_team',
  }
  const teamToPersonKey = {
    green_team:  'beyond',
    yellow_team: 'rubin',
    blue_team:   'mark',
  }

  try {
    // Step 1: build resident email → team map from active LS deals
    const deals = await fetchLSDealsAllPages(LS_APPFOLIO_TENANTS_PIPELINE)
    const activeDeals = deals.filter(d => ACTIVE_STAGES.has(d.stage?.name))
    console.log(`  Active deals (Signed Lease + Notice): ${activeDeals.length}`)

    const emailTeamMap = {}
    for (const deal of activeDeals) {
      const team = emailToTeam[deal.assignee?.email?.toLowerCase()]
      if (!team) continue
      for (const contact of deal.contacts || []) {
        for (const email of contact.emails || []) {
          if (email) emailTeamMap[email.toLowerCase()] = team
        }
      }
    }
    console.log(`  Resident emails mapped to teams: ${Object.keys(emailTeamMap).length}`)

    // Step 2: pull all resident health scores
    const { data: healthRows, error } = await supabase
      .from('v_resident_health')
      .select('resident_email, score')
      .not('resident_email', 'is', null)
      .not('score', 'is', null)

    if (error) throw error
    console.log(`  Residents with health scores: ${healthRows.length}`)

    // Step 3: group scores by team
    const teamScores = { green_team: [], yellow_team: [], blue_team: [] }
    let matched = 0

    for (const row of healthRows) {
      const email = row.resident_email?.toLowerCase()
      const team  = email ? emailTeamMap[email] : null
      if (!team) continue
      teamScores[team].push(row.score)
      matched++
    }
    console.log(`  Matched ${matched} residents to teams`)

    // Step 4: average and convert 0–100 → 1–5 (one decimal)
    for (const [team, scores] of Object.entries(teamScores)) {
      const pk = teamToPersonKey[team]
      if (scores.length === 0) {
        console.log(`  ${pk} (${team}): no matched residents — skipping`)
        continue
      }
      const avg100 = scores.reduce((a, b) => a + b, 0) / scores.length
      const avg5   = parseFloat((avg100 / 20).toFixed(1))
      console.log(`  ${pk} (${team}): ${scores.length} residents | avg score ${avg100.toFixed(0)}/100 = ${avg5}/5`)
      await upsertEntry(weekStart, pk, 'resident_satisfaction', avg5)
    }

    logSource('resident_satisfaction', 'ok')
  } catch (err) {
    console.warn('  resident_satisfaction failed:', err.message)
    logSource('resident_satisfaction', `error: ${err.message}`)
  }
}

// ── Helper: group items by team ──────────────────────────────────────────────

function groupByTeam(items, propGroupMap, propIdField) {
  const counts = { green_team: 0, yellow_team: 0, blue_team: 0 }
  const hasMapping = Object.keys(propGroupMap).length > 0

  if (!hasMapping) {
    // No group map — assign total to all three
    const n = items.length
    return { green_team: n, yellow_team: n, blue_team: n }
  }

  for (const item of items) {
    const pid   = item[propIdField]
    const group = propGroupMap[pid]
    if (group && counts[group] !== undefined) counts[group]++
  }
  return counts
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const weekStart = toDateStr(getWeekStart())
  const weekEnd   = toDateStr(new Date(new Date(weekStart).getTime() + 6 * 86400000))
  const mode      = DRY_RUN ? 'DRY RUN' : 'LIVE'

  console.log('══════════════════════════════════════════')
  console.log(`  Scorecard Sync — ${mode}`)
  console.log(`  Week: ${weekStart} → ${weekEnd}`)
  console.log('══════════════════════════════════════════')

  await syncEmailCounts(weekStart)
  await syncTurningPointsEmail(weekStart)
  await syncSecurityDeposits(weekStart)
  await syncWorkOrdersPerProperty(weekStart)
  await syncDaysOnMarket(weekStart)
  await syncResidentHealth(weekStart)
  await syncResidentSatisfaction(weekStart)
  await syncOwnerHealth(weekStart)
  await syncCallAnswerRate(weekStart)

  console.log('\n══════════════════════════════════════════')
  console.log(`  Entries written: ${results.written}`)
  console.log('\n  Source results:')
  for (const [source, status] of Object.entries(results.sources)) {
    const icon = status === 'ok' ? '✓' : status.startsWith('not available') || status.startsWith('skipped') ? '─' : '✗'
    console.log(`  ${icon}  ${source}: ${status}`)
  }
  console.log('══════════════════════════════════════════\n')
}

main().catch(err => { console.error(err); process.exit(1) })
