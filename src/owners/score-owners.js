import { supabase } from '../db/server-client.js'

// ---------------------------------------------------------------------------
// Constants — exported so tests can import them without running the script
// ---------------------------------------------------------------------------

export const LOOKBACK_DAYS = 90
export const BPM_DOMAIN = 'bpmsd.com'

export const TONE_PHASE_1 = [
  'still waiting', "still haven't", 'following up', '2nd request',
  'overcharge', 'any news', 'just checking', 'can you explain',
  "why wasn't i", 'where is',
]

export const TONE_PHASE_2 = [
  'concerned', 'concern', 'frustrated', 'urgent', 'not happy',
  'disappointed', 'unacceptable', 'refund', 'dispute', 'need to speak with',
  'who is responsible', 'unhappy', 'delayed approvals',
]

export const TONE_PHASE_3 = [
  'terminate', 'termination', 'cancellation', 'leaving management',
  'switch management', 'new management', 'another management', 'sue', 'attorney',
  'lawyer', 'breach', 'send me the contract',
]

export const TRUST_OPENERS = [
  "i've been thinking", "i've noticed", "i'm concerned",
  "i just have a few questions", "another company reached out",
  "we're evaluating",
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripReplyPrefix(subject) {
  return (subject ?? '').replace(/^(re|fwd|re|fw):\s*/gi, '').trim().toLowerCase()
}

function daysBetween(later, earlier) {
  return (new Date(later) - new Date(earlier)) / (1000 * 60 * 60 * 24)
}

function hoursApart(later, earlier) {
  return (new Date(later) - new Date(earlier)) / (1000 * 60 * 60)
}

// ---------------------------------------------------------------------------
// Scoring — exported so tests can call it directly
//
// Parameters:
//   owner           — row from owners table
//   ownerEmails     — emails from_address === owner.email (in lookback window)
//   bpmEmails       — all emails from_address contains BPM_DOMAIN (in lookback window)
//   profile         — owner_profiles row, or null
//   existingSignalKeys — Set of "${email_id}::${signal_type}::${signal_keyword}" for dedup
// ---------------------------------------------------------------------------

export function scoreOwner(owner, ownerEmails, bpmEmails, profile, existingSignalKeys) {
  const now = new Date()
  const signals = []

  // ---- Category A — BPM Response Time (max deduction: 25) ----------------
  // NOTE: Currently disabled. email_cache only captures inbound emails from
  // owners — BPM's outgoing replies are not synced. Enabling this without
  // sent-folder data would incorrectly penalise every active owner.
  // Re-enable once the Sent folder sync is built.

  const catA = 0

  // ---- Category B — Owner Engagement (max deduction: 20) -----------------

  let catB = 0
  let lastOwnerEmailAt = null
  let lastBpmReplyAt = null
  let daysSinceContact = null

  if (ownerEmails.length > 0) {
    const latest = ownerEmails.reduce((a, b) =>
      new Date(a.received_at) > new Date(b.received_at) ? a : b
    )
    lastOwnerEmailAt = latest.received_at
    daysSinceContact = daysBetween(now, new Date(lastOwnerEmailAt))
  }

  if (bpmEmails.length > 0) {
    const latestBpm = bpmEmails.reduce((a, b) =>
      new Date(a.received_at) > new Date(b.received_at) ? a : b
    )
    lastBpmReplyAt = latestBpm.received_at
  }

  if (daysSinceContact === null || daysSinceContact > 60) {
    catB += 15
    signals.push({ signal_type: 'engagement_drop', signal_keyword: 'silence_60d', email_id: null, email_subject: null })
  } else if (daysSinceContact > 14) {
    catB += 10
    signals.push({ signal_type: 'engagement_drop', signal_keyword: 'silence_14d', email_id: null, email_subject: null })
  }

  if (ownerEmails.length >= 5) {
    const sorted = [...ownerEmails].sort((a, b) => new Date(a.received_at) - new Date(b.received_at))
    let totalGap = 0
    for (let i = 1; i < sorted.length; i++) {
      totalGap += daysBetween(new Date(sorted[i].received_at), new Date(sorted[i - 1].received_at))
    }
    const avgGap = totalGap / (sorted.length - 1)
    if (avgGap > 7) catB += 5
  }

  catB = Math.min(catB, 20)

  // ---- Category C — Email Tone Signals (max deduction: 20) ---------------

  let catC = 0
  let phase1Count = 0
  let phase2Count = 0

  for (const msg of ownerEmails) {
    if (!msg.body_preview) continue
    const body = msg.body_preview.toLowerCase()

    for (const keyword of TONE_PHASE_1) {
      if (phase1Count < 3 && body.includes(keyword)) {
        catC += 3
        phase1Count++
        signals.push({ signal_type: 'phase_1', signal_keyword: keyword, email_id: msg.id, email_subject: msg.subject })
      }
    }

    for (const keyword of TONE_PHASE_2) {
      if (phase2Count < 2 && body.includes(keyword)) {
        catC += 7
        phase2Count++
        signals.push({ signal_type: 'phase_2', signal_keyword: keyword, email_id: msg.id, email_subject: msg.subject })
      }
    }

    for (const keyword of TONE_PHASE_3) {
      if (body.includes(keyword)) {
        catC += 15
        signals.push({ signal_type: 'phase_3', signal_keyword: keyword, email_id: msg.id, email_subject: msg.subject })
      }
    }

    const trimmedBody = msg.body_preview.toLowerCase().trim()
    for (const opener of TRUST_OPENERS) {
      if (trimmedBody.startsWith(opener)) {
        catC += 10
        signals.push({ signal_type: 'trust_request', signal_keyword: opener, email_id: msg.id, email_subject: msg.subject })
      }
    }
  }

  catC = Math.min(catC, 20)

  // ---- Category D — Property Performance (max deduction: 15) -------------

  let catD = 0

  if (profile) {
    const openWO = profile.open_work_orders ?? 0
    catD += Math.min(openWO, 2) * 5

    if (profile.last_vacancy_date) {
      const daysSinceVacancy = daysBetween(now, new Date(profile.last_vacancy_date))
      if (daysSinceVacancy <= 45) catD += 8
    }

    const daysSinceInspection = profile.last_inspection_date
      ? daysBetween(now, new Date(profile.last_inspection_date))
      : null
    if (daysSinceInspection === null || daysSinceInspection > 365) catD += 5
  }

  catD = Math.min(catD, 15)

  // ---- Category E — Relationship Bonus (max bonus: +20) ------------------

  let catE = 0

  if (profile) {
    const yearsBonus = Math.min(10, (profile.years_as_client ?? 0) * 2)
    const referralBonus = Math.min(10, (profile.referrals_sent ?? 0) * 5)
    catE += yearsBonus + referralBonus

    const propCount = profile.property_count ?? 0
    if (propCount >= 4) catE += 5
    else if (propCount >= 2) catE += 3

    if (profile.avg_approval_time_hours != null && profile.avg_approval_time_hours < 24) {
      catE += 3
    }
  }

  catE = Math.min(catE, 20)

  // ---- Final Score --------------------------------------------------------

  const rawScore = 100 - (catA + catB + catC + catD) + catE
  const score = Math.max(0, Math.min(100, Math.round(rawScore)))
  const tier =
    score >= 90 ? 'champion' :
    score >= 75 ? 'healthy' :
    score >= 60 ? 'watch' :
    'at_risk'

  const newSignals = signals.filter(s => {
    const key = `${s.email_id ?? 'null'}::${s.signal_type}::${s.signal_keyword ?? ''}`
    return !existingSignalKeys.has(key)
  })

  return {
    score,
    tier,
    score_bpm_response: catA,
    score_owner_engagement: catB,
    score_tone_signals: catC,
    score_property_performance: catD,
    score_relationship_bonus: catE,
    days_since_last_contact: daysSinceContact !== null ? Math.round(daysSinceContact) : null,
    last_owner_email_at: lastOwnerEmailAt,
    last_bpm_reply_at: lastBpmReplyAt,
    newSignals,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = new Date().toISOString()
  console.log(`[${startedAt}] Owner Health Scoring — START`)

  // 1. Load all owners with left-joined owner_profiles
  const { data: owners, error: ownersError } = await supabase
    .from('owners')
    .select('*, owner_profiles ( * )')

  if (ownersError) {
    console.error('Failed to load owners:', ownersError.message)
    process.exit(1)
  }

  console.log(`Owners loaded: ${owners.length}`)

  // 2. Load ALL emails in the lookback window — paginated to bypass Supabase's 1,000-row default cap
  const lookbackDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const PAGE_SIZE = 1000
  const allEmails = []
  let page = 0

  while (true) {
    const from = page * PAGE_SIZE
    const to = from + PAGE_SIZE - 1

    const { data: batch, error: emailsError } = await supabase
      .from('email_cache')
      .select('id, from_address, subject, body_preview, received_at')
      .gte('received_at', lookbackDate)
      .range(from, to)

    if (emailsError) {
      console.error('Failed to load emails:', emailsError.message)
      process.exit(1)
    }

    allEmails.push(...batch)
    if (batch.length < PAGE_SIZE) break
    page++
  }

  console.log(`Emails scanned (last ${LOOKBACK_DAYS}d): ${allEmails.length}`)

  // Split emails into owner-sent vs BPM-sent buckets
  const bpmEmails = allEmails.filter(e =>
    (e.from_address ?? '').toLowerCase().includes(BPM_DOMAIN)
  )

  const emailsByOwner = new Map()
  for (const email of allEmails) {
    if (!email.from_address) continue
    const key = email.from_address.toLowerCase().trim()
    if (!emailsByOwner.has(key)) emailsByOwner.set(key, [])
    emailsByOwner.get(key).push(email)
  }

  // 3. Load existing signals — for dedup AND call_frequency scoring
  const { data: existingSignals, error: signalsError } = await supabase
    .from('owner_signals')
    .select('owner_id, email_id, signal_type, signal_keyword')
    .gte('detected_at', lookbackDate)

  if (signalsError) {
    console.warn('Warning: could not load existing signals for dedup:', signalsError.message)
  }

  const existingSignalKeys = new Set(
    (existingSignals ?? []).map(s =>
      `${s.email_id ?? 'null'}::${s.signal_type}::${s.signal_keyword ?? ''}`
    )
  )

  // Build a set of owner IDs with active call_frequency signals
  const callFlaggedOwners = new Set(
    (existingSignals ?? [])
      .filter(s => s.signal_type === 'call_frequency')
      .map(s => s.owner_id)
  )

  // 4. Score each owner
  const now = new Date()
  const scoreRows = []
  const allNewSignals = []
  const tierCounts = { champion: 0, healthy: 0, watch: 0, at_risk: 0 }

  for (const owner of owners) {
    try {
      const ownerEmailKey = (owner.email ?? '').toLowerCase().trim()
      const profile = owner.owner_profiles ?? null
      const ownerEmails = ownerEmailKey ? (emailsByOwner.get(ownerEmailKey) ?? []) : []

      const result = scoreOwner(owner, ownerEmails, bpmEmails, profile, existingSignalKeys)

      // Apply call frequency penalty — owner called 3+ times in 7 days
      // Force a minimum tier of Watch regardless of base score
      if (callFlaggedOwners.has(owner.id)) {
        result.score = Math.min(result.score, 74)  // cap at top of Watch band
        result.tier = result.score >= 60 ? 'watch' : 'at_risk'
      }

      tierCounts[result.tier]++

      scoreRows.push({
        owner_id: owner.id,
        score: result.score,
        tier: result.tier,
        score_bpm_response: result.score_bpm_response,
        score_owner_engagement: result.score_owner_engagement,
        score_tone_signals: result.score_tone_signals,
        score_property_performance: result.score_property_performance,
        score_relationship_bonus: result.score_relationship_bonus,
        days_since_last_contact: result.days_since_last_contact,
        last_owner_email_at: result.last_owner_email_at,
        last_bpm_reply_at: result.last_bpm_reply_at,
        scored_at: now.toISOString(),
      })

      for (const sig of result.newSignals) {
        allNewSignals.push({
          owner_id: owner.id,
          signal_type: sig.signal_type,
          signal_keyword: sig.signal_keyword,
          email_id: sig.email_id ?? null,
          email_subject: sig.email_subject ?? null,
          detected_at: now.toISOString(),
          is_active: true,
        })
      }
    } catch (err) {
      console.error(`Error scoring owner "${owner.name}" (${owner.id}):`, err.message)
    }
  }

  // 5. Batch INSERT score rows
  const { error: insertScoresError } = await supabase
    .from('owner_health_scores')
    .insert(scoreRows)

  if (insertScoresError) {
    console.error('Failed to insert owner_health_scores:', insertScoresError.message)
    process.exit(1)
  }

  // 5.5 — Update risk_since in owner_profiles
  // Set when owner first enters at_risk or watch; clear when they recover.
  const riskSinceUpdates = []
  for (const owner of owners) {
    const row = scoreRows.find(r => r.owner_id === owner.id)
    if (!row) continue
    const profile = owner.owner_profiles ?? null
    const wasUnhappy = profile?.risk_since != null
    const isUnhappy  = row.tier === 'at_risk' || row.tier === 'watch'

    if (isUnhappy && !wasUnhappy) {
      // Newly unhappy — stamp the start date
      riskSinceUpdates.push({ owner_id: owner.id, risk_since: now.toISOString() })
    } else if (!isUnhappy && wasUnhappy) {
      // Recovered — clear the date
      riskSinceUpdates.push({ owner_id: owner.id, risk_since: null })
    }
    // If wasUnhappy and still unhappy: keep existing risk_since (no change)
  }

  for (const upd of riskSinceUpdates) {
    const { error: rErr } = await supabase
      .from('owner_profiles')
      .upsert({ owner_id: upd.owner_id, risk_since: upd.risk_since }, { onConflict: 'owner_id' })
    if (rErr) console.warn(`  Warning: risk_since update failed for ${upd.owner_id}:`, rErr.message)
  }

  if (riskSinceUpdates.length > 0)
    console.log(`Risk-since updates: ${riskSinceUpdates.length}`)

  // 6. Batch INSERT new signals (non-fatal if this fails)
  if (allNewSignals.length > 0) {
    const { error: insertSignalsError } = await supabase
      .from('owner_signals')
      .insert(allNewSignals)

    if (insertSignalsError) {
      console.warn('Warning: failed to insert owner_signals:', insertSignalsError.message)
    }
  }

  // 7. Print summary
  const doneAt = new Date().toISOString()
  console.log('\n--- Results ---')
  console.log(`Champion (90-100):  ${String(tierCounts.champion).padStart(2)}`)
  console.log(`Healthy  (75-89):   ${String(tierCounts.healthy).padStart(2)}`)
  console.log(`Watch    (60-74):   ${String(tierCounts.watch).padStart(2)}`)
  console.log(`At Risk  (<60):     ${String(tierCounts.at_risk).padStart(2)}`)
  console.log(`\nNew signals detected: ${allNewSignals.length}`)
  console.log(`Scores written: ${scoreRows.length}`)
  console.log(`\n[${doneAt}] DONE`)
}

main().catch(err => { console.error(err); process.exit(1) })
