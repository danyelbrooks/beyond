import 'dotenv/config'
import { supabase } from '../db/server-client.js'

const TALKROUTE_API_KEY = process.env.TALKROUTE_API_KEY
const CALL_THRESHOLD   = 3   // calls within LOOKBACK_DAYS = risk signal
const LOOKBACK_DAYS    = 30

// ---------------------------------------------------------------------------
// Normalize any phone number to 10 digits (US)
// ---------------------------------------------------------------------------
function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '')
  const normalized = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  return normalized.length === 10 ? normalized : null
}

// ---------------------------------------------------------------------------
// Fetch all inbound calls from Talkroute for the last LOOKBACK_DAYS days
// ---------------------------------------------------------------------------
async function fetchCallHistory() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19) + '+00:00'

  const calls = []
  let page = 1

  while (true) {
    const params = new URLSearchParams({
      direction: 'inbound',
      pageSize:  '100',
      page:      String(page),
      after,
    })

    const res = await fetch(`https://api.talkroute.com/api/v2/call-history?${params}`, {
      headers: { Authorization: `Bearer ${TALKROUTE_API_KEY}` },
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Talkroute API ${res.status}: ${body}`)
    }

    const json = await res.json()
    if (!json.data?.length) break
    calls.push(...json.data)

    if (page >= (json.pagination?.totalPages ?? 1)) break
    page++
  }

  return calls
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[${new Date().toISOString()}] Talkroute Call Sync — START`)

  // 1. Pull call history
  const calls = await fetchCallHistory()
  console.log(`Inbound calls (last ${LOOKBACK_DAYS}d): ${calls.length}`)

  // 2. Count calls per normalized caller number
  const callCounts = new Map()
  for (const call of calls) {
    const phone = normalizePhone(call.externalNumber)
    if (!phone) continue
    callCounts.set(phone, (callCounts.get(phone) || 0) + 1)
  }

  // 3. Load owners with phone numbers
  const { data: owners, error: ownersErr } = await supabase
    .from('owners')
    .select('id, name, phone')
    .not('phone', 'is', null)

  if (ownersErr) throw new Error(ownersErr.message)

  // 4. Load existing call_frequency signals (for dedup — don't double-flag this week)
  const weekAgo = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data: existingSignals } = await supabase
    .from('owner_signals')
    .select('owner_id')
    .eq('signal_type', 'call_frequency')
    .gte('detected_at', weekAgo)

  const alreadyFlagged = new Set((existingSignals ?? []).map(s => s.owner_id))

  // 5. Match callers to owners and build new signals
  const signals = []

  for (const owner of owners) {
    if (alreadyFlagged.has(owner.id)) continue

    // Parse all phone numbers from the owner.phone field
    // AppFolio stores them as: "Mobile: (858) 888-3347, Home: (310) 637-2859"
    const rawPhones = (owner.phone || '').match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || []
    const ownerPhones = rawPhones.map(normalizePhone).filter(Boolean)

    for (const phone of ownerPhones) {
      const count = callCounts.get(phone) || 0
      if (count >= CALL_THRESHOLD) {
        signals.push({
          owner_id:      owner.id,
          signal_type:   'call_frequency',
          signal_keyword: `${count}_calls_${LOOKBACK_DAYS}d`,
          email_id:      null,
          email_subject: `Called ${count} times in ${LOOKBACK_DAYS} days`,
          detected_at:   new Date().toISOString(),
          is_active:     true,
        })
        console.log(`  FLAGGED: ${owner.name} — ${count} calls in ${LOOKBACK_DAYS} days`)
        break
      }
    }
  }

  console.log(`\nOwners flagged: ${signals.length}`)

  // 6. Save signals
  if (signals.length > 0) {
    const { error: insertErr } = await supabase
      .from('owner_signals')
      .insert(signals)

    if (insertErr) throw new Error(insertErr.message)
    console.log('Signals saved to owner_signals.')
  }

  console.log(`[${new Date().toISOString()}] DONE`)
}

main().catch(err => { console.error(err); process.exit(1) })
