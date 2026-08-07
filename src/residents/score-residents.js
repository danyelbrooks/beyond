// score-residents.js
// Resident Health Scores — Service Quality Edition
//
// "Are we taking care of this resident?"
//
//   A — Email response time   40 pts  (how fast we reply to their emails)
//   B — Open threads          30 pts  (how many emails are sitting unresolved)
//   C — Base                  30 pts  (everyone starts here)
//   Total                    100 pts
//
//   911 flag caps the total at 39 (At Risk)
//
// Usage: node src/residents/score-residents.js

import { supabase } from '../db/server-client.js'

const LOOKBACK_DAYS = 90

// ── Scoring functions ───────────────────────────────────────────────────────

function scoreResponseTime(avgHours) {
  if (avgHours === null) return 25   // no emails on file — neutral
  if (avgHours < 4)     return 40   // under 4 hours: excellent
  if (avgHours < 24)    return 30   // same day: good
  if (avgHours < 48)    return 15   // next day: needs work
  if (avgHours < 120)   return 8    // 2–5 days: poor
  return 0                           // over 5 days: very poor
}

function scoreOpenThreads(openCount) {
  if (openCount === 0) return 30
  if (openCount === 1) return 20
  if (openCount === 2) return 10
  return 0
}

function tierFromScore(score, on911) {
  if (on911 || score < 40) return 'at_risk'
  if (score < 60)          return 'watch'
  if (score < 80)          return 'stable'
  return 'advocate'
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Resident Health Scoring — Service Quality\n')

  // Load all residents
  const { data: residents, error: rErr } = await supabase
    .from('residents')
    .select('id, name, email')
  if (rErr) { console.error('Failed to load residents:', rErr.message); process.exit(1) }
  console.log(`Residents loaded: ${residents.length}`)

  // Active 911 flags
  const { data: active911 } = await supabase
    .from('resident_911')
    .select('resident_id')
    .eq('status', 'active')
  const on911Set = new Set((active911 ?? []).map(r => r.resident_id))
  console.log(`Active 911 flags: ${on911Set.size}`)

  // ── Load email data for residents who have an email address ──
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS)
  const cutoffStr = cutoff.toISOString()

  const residentEmailAddrs = [...new Set(
    residents.filter(r => r.email).map(r => r.email.toLowerCase())
  )]

  // email_id → { received_at, status }
  const emailMeta    = {}
  // resident email → list of email_ids
  const emailsByAddr = {}
  // email_id → earliest reply timestamp
  const replyAt      = {}

  if (residentEmailAddrs.length > 0) {
    const { data: emails } = await supabase
      .from('email_cache')
      .select('id, from_address, received_at, status')
      .in('from_address', residentEmailAddrs)
      .gte('received_at', cutoffStr)

    for (const e of (emails || [])) {
      const addr = e.from_address.toLowerCase()
      emailMeta[e.id] = e
      if (!emailsByAddr[addr]) emailsByAddr[addr] = []
      emailsByAddr[addr].push(e.id)
    }

    // Load reply actions for those emails (in batches to avoid huge IN clause)
    const allIds = Object.keys(emailMeta)
    const BATCH  = 500
    for (let i = 0; i < allIds.length; i += BATCH) {
      const slice = allIds.slice(i, i + BATCH)
      const { data: actions } = await supabase
        .from('email_actions')
        .select('email_id, done_at')
        .in('email_id', slice)
        .eq('action_type', 'replied')
      for (const a of (actions || [])) {
        if (!replyAt[a.email_id]) replyAt[a.email_id] = a.done_at
      }
    }
  }

  console.log(`Emails matched to residents (last ${LOOKBACK_DAYS}d): ${Object.keys(emailMeta).length}`)

  // ── Score each resident ──────────────────────────────────────────────────
  const scoreRows = []
  const tally = { advocate: 0, stable: 0, watch: 0, at_risk: 0 }

  for (const resident of residents) {
    const on911  = on911Set.has(resident.id)
    const addr   = (resident.email || '').toLowerCase()
    const eIds   = emailsByAddr[addr] || []

    let totalHours   = 0
    let repliedCount = 0
    let openCount    = 0

    for (const eid of eIds) {
      const e = emailMeta[eid]
      if (!e) continue
      if (e.status !== 'handled') openCount++
      if (replyAt[eid]) {
        const hrs = (new Date(replyAt[eid]) - new Date(e.received_at)) / (1000 * 60 * 60)
        if (hrs >= 0) { totalHours += hrs; repliedCount++ }
      }
    }

    // avgHours:
    //   null       → no emails on file at all (neutral score)
    //   large num  → emails exist but none replied to (poor score)
    const avgHours = repliedCount > 0
      ? totalHours / repliedCount
      : eIds.length > 0 ? 999 : null

    const a = scoreResponseTime(avgHours)
    const b = scoreOpenThreads(openCount)
    const c = 30

    let total = a + b + c
    if (on911) total = Math.min(total, 39)

    const tier = tierFromScore(total, on911)
    tally[tier]++

    scoreRows.push({
      resident_id:           resident.id,
      score:                 Math.max(0, Math.min(100, total)),
      tier,
      score_email_response:  a,
      score_open_threads:    b,
      score_lease_timeline:  0,
      score_payment:         0,
      score_tenure:          0,
      days_until_lease_end:  null,
      legal_threat_detected: false,
      open_thread_days:      null,
      avg_response_hours:    avgHours !== null ? Math.round(avgHours * 10) / 10 : null,
      open_thread_count:     openCount,
      scored_at:             new Date().toISOString(),
    })
  }

  console.log('\nScore distribution:')
  console.log(`  Advocate : ${tally.advocate}`)
  console.log(`  Stable   : ${tally.stable}`)
  console.log(`  Watch    : ${tally.watch}`)
  console.log(`  At Risk  : ${tally.at_risk}`)

  // Write scores in batches
  const BATCH = 100
  let saved = 0
  for (let i = 0; i < scoreRows.length; i += BATCH) {
    const batch = scoreRows.slice(i, i + BATCH)
    const { error } = await supabase.from('resident_health_scores').insert(batch)
    if (error) { console.error(`Batch ${i} failed:`, error.message); process.exit(1) }
    saved += batch.length
    process.stdout.write(`\rWriting scores: ${saved}/${scoreRows.length}`)
  }

  console.log(`\n\nScoring complete — ${saved} scores written.`)

  // Show examples from each tier
  const examples = { advocate: [], stable: [], watch: [], at_risk: [] }
  for (let i = 0; i < residents.length; i++) {
    const s = scoreRows[i]
    if (examples[s.tier].length < 2) examples[s.tier].push({ name: residents[i].name, ...s })
  }
  console.log('\nExamples:')
  for (const [tier, exs] of Object.entries(examples)) {
    for (const ex of exs) {
      const hrs = ex.avg_response_hours !== null ? `${ex.avg_response_hours}h avg response` : 'no emails on file'
      console.log(`  [${tier.toUpperCase().padEnd(8)}] ${ex.name} — score ${ex.score} (resp:${ex.score_email_response} threads:${ex.score_open_threads} | ${hrs}, ${ex.open_thread_count} open)`)
    }
  }
  console.log()
}

main().catch(err => { console.error(err); process.exit(1) })
