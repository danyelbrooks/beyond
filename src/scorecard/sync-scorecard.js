// sync-scorecard.js
// Pulls automated scorecard data for the current week and upserts
// into scorecard_entries. One failing source does not stop the others.
//
// Usage:
//   node src/scorecard/sync-scorecard.js
//   node src/scorecard/sync-scorecard.js --dry-run

import 'dotenv/config'
import { supabase } from '../db/server-client.js'

const DRY_RUN       = process.argv.includes('--dry-run')
const CLIENT_ID     = process.env.APPFOLIO_STACK_CLIENT_ID
const CLIENT_SECRET = process.env.APPFOLIO_STACK_CLIENT_SECRET
const DEVELOPER_ID  = process.env.APPFOLIO_DEVELOPER_ID
const BASIC_AUTH    = CLIENT_ID && CLIENT_SECRET
  ? Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  : null
const BASE          = 'https://api.appfolio.com/api/v0'

// ── Week calculation ────────────────────────────────────────────────────────
// Returns the Monday of the current (or given) week as a Date at 00:00 local.

function getWeekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay() // 0=Sun, 1=Mon … 6=Sat
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

// Returns YYYY-MM-DD string (local date, not UTC) for use as week_start.
function toDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Returns Monday 00:00 and Sunday 23:59:59 of the given week as ISO strings.
function weekRange(weekStart) {
  const start = new Date(weekStart)
  const end   = new Date(weekStart)
  end.setDate(end.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  return { start: start.toISOString(), end: end.toISOString() }
}

// ── Results tracker ─────────────────────────────────────────────────────────

const results = {
  written:  0,
  sources:  {},   // source_key → 'ok' | 'skipped' | error message
}

function logSource(key, status) { results.sources[key] = status }

// ── Upsert helper ───────────────────────────────────────────────────────────

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
        week_start:  weekStart,
        person_key:  personKey,
        metric_key:  metricKey,
        value:       value !== undefined ? value : null,
        value_text:  valueText,
        is_auto:     isAuto,
        entered_by:  'sync-scorecard',
      },
      { onConflict: 'week_start,person_key,metric_key' }
    )

  if (error) {
    console.error(`  Error upserting ${personKey}/${metricKey}:`, error.message)
  } else {
    results.written++
  }
}

// ── AppFolio Stack API fetch (paginated) ────────────────────────────────────
// Copied exactly from src/residents/sync-residents.js

async function fetchAll(endpoint, params = {}) {
  if (!BASIC_AUTH) throw new Error('Missing APPFOLIO_STACK_CLIENT_ID or APPFOLIO_STACK_CLIENT_SECRET in .env')

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

// ── SOURCE: email_count ──────────────────────────────────────────────────────
// Count emails sent FROM each team member's inbox this week.

async function syncEmailCounts(weekStart) {
  console.log('\n[email_count] Counting this-week emails per inbox…')
  const { start, end } = weekRange(new Date(weekStart))

  // Persons who have email_count metrics, keyed by person_key → inbox email
  const inboxMap = {
    ana:     'beyond@bpmsd.com',
    ella:    'admin@bpmsd.com',
    mark:    'success@bpmsd.com',
    laura:   'results@bpmsd.com',
    maria_a: 'manager@bpmsd.com',
    moira:   'accounts@bpmsd.com',
    bdm:     'info@bpmsd.com',
    rubin:   'help@bpmsd.com',
    gael:    'home@bpmsd.com',
  }

  // Metric keys for each person's email_count metric
  const metricKeyMap = {
    ana:     'team_total_emails',
    ella:    'emails',
    mark:    'emails',
    laura:   'emails',
    maria_a: 'emails',
    moira:   'emails',
    bdm:     'emails',
    rubin:   'emails',
    gael:    'emails',
  }

  for (const [personKey, email] of Object.entries(inboxMap)) {
    try {
      const { count, error } = await supabase
        .from('email_cache')
        .select('id', { count: 'exact', head: true })
        .ilike('from_address', `%${email}%`)
        .gte('received_at', start)
        .lte('received_at', end)

      if (error) throw error

      const metricKey = metricKeyMap[personKey]
      console.log(`  ${personKey} (${email}): ${count} emails → ${metricKey}`)
      await upsertEntry(weekStart, personKey, metricKey, count)
    } catch (err) {
      console.warn(`  Warning — could not count emails for ${personKey}:`, err.message)
    }
  }
  logSource('email_count', 'ok')
}

// ── SOURCE: appfolio_rent ────────────────────────────────────────────────────
// Fetch current tenants from AppFolio. Approximate rent-collected % as:
// count of tenants with no past-due balance / total current tenants.

async function syncRentCollected(weekStart) {
  console.log('\n[appfolio_rent] Calculating rent collected %…')
  try {
    const tenants  = await fetchAll('tenants', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' })
    const current  = tenants.filter(t => t.Status === 'Current')
    const total    = current.length

    if (total === 0) {
      console.log('  No current tenants found — skipping.')
      logSource('appfolio_rent', 'skipped — no current tenants')
      return
    }

    // Past-due: look for balance fields that indicate money owed
    const pastDue  = current.filter(t => {
      const balance = t.Balance ?? t.PastDueBalance ?? t.TotalBalance ?? 0
      return Number(balance) > 0
    })
    const collected = Math.round(((total - pastDue.length) / total) * 100)
    console.log(`  Current tenants: ${total} | Past-due: ${pastDue.length} | Collected: ${collected}%`)

    // Apply to Laura and Mahalah
    await upsertEntry(weekStart, 'laura',   'rent_collected', collected)
    await upsertEntry(weekStart, 'mahalah', 'rent_collected', collected)
    logSource('appfolio_rent', 'ok')
  } catch (err) {
    console.warn('  appfolio_rent failed:', err.message)
    logSource('appfolio_rent', `error: ${err.message}`)
  }
}

// ── SOURCE: appfolio_wo ─────────────────────────────────────────────────────
// Fetch work orders from AppFolio. Calculate work orders per property.

async function syncWorkOrdersPerProperty(weekStart) {
  console.log('\n[appfolio_wo] Calculating work orders per property…')
  try {
    // Try /workorders endpoint — may not be available on all plans
    const workOrders = await fetchAll('workorders', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' })
    const properties = await fetchAll('properties', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' })

    const propCount = properties.length
    if (propCount === 0) {
      console.log('  No properties found — skipping.')
      logSource('appfolio_wo', 'skipped — no properties')
      return
    }

    // Count open work orders
    const open = workOrders.filter(wo =>
      !['Completed', 'Closed', 'Cancelled'].includes(wo.Status || wo.status || '')
    )
    const perProperty = open.length > 0 ? parseFloat((open.length / propCount).toFixed(2)) : 0
    console.log(`  Properties: ${propCount} | Open WOs: ${open.length} | Per property: ${perProperty}`)

    await upsertEntry(weekStart, 'jermaine', 'wo_per_property', perProperty)
    await upsertEntry(weekStart, 'mark',     'wo_per_property', perProperty)
    logSource('appfolio_wo', 'ok')
  } catch (err) {
    // /workorders endpoint may not exist — this is expected on some plans
    if (err.message.includes('404') || err.message.includes('not found')) {
      console.log('  /workorders endpoint not available on this AppFolio plan — manual entry needed.')
      logSource('appfolio_wo', 'not available — manual entry needed')
    } else {
      console.warn('  appfolio_wo failed:', err.message)
      logSource('appfolio_wo', `error: ${err.message}`)
    }
  }
}

// ── SOURCE: appfolio_security_deposits ──────────────────────────────────────
// Count tenants where move-in was >21 days ago and no security deposit recorded.
// Best-effort: AppFolio Stack may not expose deposit data directly.

async function syncSecurityDeposits(weekStart) {
  console.log('\n[appfolio_security_deposits] Checking security deposits…')
  try {
    const tenants = await fetchAll('tenants', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' })
    const current = tenants.filter(t => t.Status === 'Current')
    const now     = new Date()
    const cutoff  = new Date(now)
    cutoff.setDate(cutoff.getDate() - 21)

    // Tenants who moved in >21 days ago
    const movedInOver21 = current.filter(t => {
      const moveIn = t.MoveInOn || t.MoveInDate
      return moveIn && new Date(moveIn) <= cutoff
    })

    // Count those with no deposit recorded
    // AppFolio Stack may not have a direct SecurityDeposit field —
    // use SecurityDepositAmount, SecurityDeposit, or similar if present.
    const noDeposit = movedInOver21.filter(t => {
      const deposit = t.SecurityDepositAmount ?? t.SecurityDeposit ?? t.DepositAmount
      return deposit === null || deposit === undefined || Number(deposit) === 0
    })

    console.log(`  Tenants >21 days: ${movedInOver21.length} | No deposit on file: ${noDeposit.length}`)

    if (noDeposit.length === 0 && movedInOver21.length === 0) {
      console.log('  Security deposit field not found in API response — manual entry needed.')
      logSource('appfolio_security_deposits', 'not available — manual entry needed')
      return
    }

    await upsertEntry(weekStart, 'ana',     'security_deposits_past_21', noDeposit.length)
    await upsertEntry(weekStart, 'maria_e', 'security_deposits_past_21', noDeposit.length)
    logSource('appfolio_security_deposits', 'ok')
  } catch (err) {
    console.warn('  appfolio_security_deposits failed:', err.message)
    console.log('  → Manual entry needed for Security Deposits Past 21 Days.')
    logSource('appfolio_security_deposits', `error: ${err.message}`)
  }
}

// ── SOURCE: appfolio_turning_points ─────────────────────────────────────────
// Count move-ins this week from AppFolio (turning points = move-ins).

async function syncTurningPoints(weekStart) {
  console.log('\n[appfolio_turning_points] Counting move-ins this week…')
  const { start, end } = weekRange(new Date(weekStart))

  try {
    const tenants = await fetchAll('tenants', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' })

    const moveIns = tenants.filter(t => {
      const moveIn = t.MoveInOn || t.MoveInDate
      if (!moveIn) return false
      const d = new Date(moveIn).toISOString()
      return d >= start && d <= end
    })
    const moveOuts = tenants.filter(t => {
      const moveOut = t.MoveOutOn || t.MoveOutDate
      if (!moveOut) return false
      const d = new Date(moveOut).toISOString()
      return d >= start && d <= end
    })

    console.log(`  Move-ins: ${moveIns.length} | Move-outs: ${moveOuts.length}`)

    await upsertEntry(weekStart, 'ana',     'turning_points', moveIns.length)
    await upsertEntry(weekStart, 'maria_e', 'turning_points', moveIns.length)
    logSource('appfolio_turning_points', 'ok')
  } catch (err) {
    console.warn('  appfolio_turning_points failed:', err.message)
    logSource('appfolio_turning_points', `error: ${err.message}`)
  }
}

// ── SOURCE: appfolio_days_on_market ─────────────────────────────────────────
// Fetch vacant units and calculate average days on market.

async function syncDaysOnMarket(weekStart) {
  console.log('\n[appfolio_days_on_market] Calculating days on market…')
  try {
    const units = await fetchAll('units', { 'filters[LastUpdatedAtFrom]': '1970-01-01T00:00:00Z' })

    // Vacant units: look for IsVacant, Status='Vacant', or similar
    const vacant = units.filter(u =>
      u.IsVacant === true ||
      (u.Status || u.OccupancyStatus || '').toLowerCase().includes('vacant')
    )

    if (vacant.length === 0) {
      console.log('  No vacant units found — days on market not available, manual entry needed.')
      logSource('appfolio_days_on_market', 'not available — manual entry needed')
      return
    }

    const now = new Date()
    const daysOnMarket = vacant
      .map(u => {
        const listed = u.ListedOn || u.AvailableDate || u.DateAvailable
        if (!listed) return null
        const diff = Math.round((now - new Date(listed)) / (1000 * 60 * 60 * 24))
        return diff >= 0 ? diff : null
      })
      .filter(d => d !== null)

    if (daysOnMarket.length === 0) {
      console.log('  Could not calculate days on market — no listing dates available.')
      logSource('appfolio_days_on_market', 'not available — no listing dates in API')
      return
    }

    const avg = Math.round(daysOnMarket.reduce((a, b) => a + b, 0) / daysOnMarket.length)
    console.log(`  Vacant units with dates: ${daysOnMarket.length} | Avg days on market: ${avg}`)

    await upsertEntry(weekStart, 'ellen',  'days_on_market', avg)
    await upsertEntry(weekStart, 'kendra', 'days_on_market', avg)
    logSource('appfolio_days_on_market', 'ok')
  } catch (err) {
    console.warn('  appfolio_days_on_market failed:', err.message)
    console.log('  → Manual entry needed for Days on Market.')
    logSource('appfolio_days_on_market', `error: ${err.message}`)
  }
}

// ── SOURCE: turning_points_email ─────────────────────────────────────────────
// Count emails FROM danyel@bpmsd.com with subject containing 'turning' this week.
// These are Danyel's escalation emails — tracked for both Ana and Mark as a
// company-wide number (same total applied to each person).

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
    await upsertEntry(weekStart, 'ana',  'turning_points', count)
    await upsertEntry(weekStart, 'mark', 'turning_points', count)
    logSource('turning_points_email', 'ok')
  } catch (err) {
    console.warn('  turning_points_email failed:', err.message)
    logSource('turning_points_email', `error: ${err.message}`)
  }
}

// ── SOURCE: resident_health ──────────────────────────────────────────────────
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
    await upsertEntry(weekStart, 'laura', 'resident_health_score', count)
    logSource('resident_health', 'ok')
  } catch (err) {
    console.warn('  resident_health failed:', err.message)
    logSource('resident_health', `error: ${err.message}`)
  }
}

// ── SOURCE: owner_health ─────────────────────────────────────────────────────
// Count at-risk owners from v_owner_health view.

async function syncOwnerHealth(weekStart) {
  console.log('\n[owner_health] Counting at-risk owners…')
  try {
    const { count, error } = await supabase
      .from('v_owner_health')
      .select('id', { count: 'exact', head: true })
      .eq('tier', 'at_risk')

    if (error) throw error
    console.log(`  At-risk owners: ${count}`)
    await upsertEntry(weekStart, 'rubin', 'owner_health_at_risk', count)
    logSource('owner_health', 'ok')
  } catch (err) {
    console.warn('  owner_health failed:', err.message)
    logSource('owner_health', `error: ${err.message}`)
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const weekStart    = toDateStr(getWeekStart())
  const weekEnd      = toDateStr(new Date(new Date(weekStart).getTime() + 6 * 86400000))
  const modeLabel    = DRY_RUN ? 'DRY RUN' : 'LIVE'

  console.log('══════════════════════════════════════════')
  console.log(`  Scorecard Sync — ${modeLabel}`)
  console.log(`  Week: ${weekStart} → ${weekEnd}`)
  console.log('══════════════════════════════════════════')

  // Run all sources. Each is wrapped independently so one failure
  // does not prevent the others from running.
  await syncEmailCounts(weekStart)
  await syncRentCollected(weekStart)
  await syncWorkOrdersPerProperty(weekStart)
  await syncSecurityDeposits(weekStart)
  await syncTurningPoints(weekStart)
  await syncTurningPointsEmail(weekStart)
  await syncDaysOnMarket(weekStart)
  await syncResidentHealth(weekStart)
  await syncOwnerHealth(weekStart)

  // Summary
  console.log('\n══════════════════════════════════════════')
  console.log(`  Entries written: ${results.written}`)
  console.log('\n  Source results:')
  for (const [source, status] of Object.entries(results.sources)) {
    const icon = status === 'ok' ? '✓' : status.startsWith('not available') ? '─' : '✗'
    console.log(`  ${icon}  ${source}: ${status}`)
  }
  console.log('══════════════════════════════════════════\n')
}

main().catch(err => { console.error(err); process.exit(1) })
