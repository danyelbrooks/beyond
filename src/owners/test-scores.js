import { supabase } from '../db/server-client.js'

console.log('=== Owner Health DB Verification ===\n')

// 1. Bottom 5 owners by score
const { data: bottom5, error: e1 } = await supabase
  .from('v_owner_health')
  .select('owner_name, score, tier, score_owner_engagement, score_tone_signals, score_property_performance, score_relationship_bonus, days_since_last_contact, active_signal_count')
  .order('score', { ascending: true })
  .limit(5)

console.log('Bottom 5 owners (worst scores):')
if (e1) console.error('ERROR:', e1.message)
else console.log(JSON.stringify(bottom5, null, 2))

// 2. Top 5 owners by score
const { data: top5, error: e2 } = await supabase
  .from('v_owner_health')
  .select('owner_name, score, tier, score_owner_engagement, score_tone_signals, score_property_performance, score_relationship_bonus, days_since_last_contact, active_signal_count')
  .order('score', { ascending: false })
  .limit(5)

console.log('\nTop 5 owners (best scores):')
if (e2) console.error('ERROR:', e2.message)
else console.log(JSON.stringify(top5, null, 2))

// 3. Tier distribution
const { data: allScores, error: e3 } = await supabase
  .from('owner_health_scores')
  .select('tier, score')
  .order('score', { ascending: true })

if (e3) {
  console.error('\nERROR loading tier distribution:', e3.message)
} else {
  const tally = { champion: 0, healthy: 0, watch: 0, at_risk: 0 }
  let minScore = Infinity
  let maxScore = -Infinity
  let impossible = []
  for (const row of allScores ?? []) {
    tally[row.tier] = (tally[row.tier] ?? 0) + 1
    if (row.score < minScore) minScore = row.score
    if (row.score > maxScore) maxScore = row.score
    if (row.score < 0 || row.score > 100) impossible.push(row.score)
  }
  console.log('\nTier distribution:', tally)
  console.log(`Score range: ${minScore} – ${maxScore}`)
  if (impossible.length > 0) console.error('IMPOSSIBLE SCORES (bug!):', impossible)
  else console.log('No impossible scores (0 < score <= 100): OK')
}

// 4. Signal count
const { count: signalCount, error: e4 } = await supabase
  .from('owner_signals')
  .select('*', { count: 'exact', head: true })

console.log(`\nSignals in owner_signals table: ${signalCount ?? 'ERROR: ' + e4?.message}`)

// 5. Verify row count matches owners loaded
const { count: scoreRowCount, error: e5 } = await supabase
  .from('owner_health_scores')
  .select('*', { count: 'exact', head: true })

console.log(`Rows in owner_health_scores: ${scoreRowCount ?? 'ERROR: ' + e5?.message}`)

// 6. Check v_owner_health returns proper data (no null scores)
const { data: nullCheck, error: e6 } = await supabase
  .from('v_owner_health')
  .select('owner_name, score, tier')
  .is('score', null)
  .limit(5)

console.log(`\nOwners with NULL score in view: ${nullCheck?.length ?? 'ERROR: ' + e6?.message}`)
if (nullCheck?.length > 0) console.log('Sample null-score rows:', JSON.stringify(nullCheck, null, 2))

// 7. Check email_cache row count to flag potential pagination cap
const { count: emailTotal, error: e7 } = await supabase
  .from('email_cache')
  .select('*', { count: 'exact', head: true })

console.log(`\nTotal rows in email_cache: ${emailTotal ?? 'ERROR: ' + e7?.message}`)
if (emailTotal > 1000) {
  console.warn(`WARNING: email_cache has ${emailTotal} rows but scoring engine only loaded 1000 (Supabase default page cap). Owners with older emails may be under-scored.`)
}

console.log('\n=== Done ===')
