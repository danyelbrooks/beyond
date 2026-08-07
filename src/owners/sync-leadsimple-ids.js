// sync-leadsimple-ids.js
// Looks up each owner in LeadSimple by email (or name fallback)
// and stores their LeadSimple contact ID so the dashboard can link directly.
//
// Usage: node src/owners/sync-leadsimple-ids.js
//        node src/owners/sync-leadsimple-ids.js --dry-run

import 'dotenv/config'
import { supabase } from '../db/server-client.js'

const DRY_RUN = process.argv.includes('--dry-run')
const LS_KEY  = process.env.LEADSIMPLE_API_KEY

if (!LS_KEY) {
  console.error('Missing LEADSIMPLE_API_KEY in .env')
  process.exit(1)
}

const LS_BASE = 'https://api.leadsimple.com/rest'

// ── Discover which auth header LeadSimple accepts ────────────────────────────

async function discoverEndpoint() {
  const candidates = [
    { url: `${LS_BASE}/contacts?per_page=1`, auth: `Bearer ${LS_KEY}`,   headerName: 'Authorization' },
    { url: `${LS_BASE}/contacts?per_page=1`, auth: LS_KEY,               headerName: 'Authorization' },
    { url: `${LS_BASE}/contacts?per_page=1`, auth: LS_KEY,               headerName: 'X-Api-Key' },
    { url: `${LS_BASE}/contacts?per_page=1`, auth: LS_KEY,               headerName: 'X-LeadSimple-Token' },
    { url: `${LS_BASE}/contacts?per_page=1&api_key=${LS_KEY}`, auth: null, headerName: null },
  ]
  for (const c of candidates) {
    const headers = { Accept: 'application/json' }
    if (c.auth && c.headerName) headers[c.headerName] = c.auth
    const res  = await fetch(c.url, { headers })
    const body = await res.text()
    console.log(`  ${res.status} — ${c.headerName || 'query param'}: ${c.url.replace(LS_KEY, '***')}`)
    if (res.ok) {
      console.log(`  ✓ Working! Header: ${c.headerName || 'api_key query param'}`)
      console.log(`  Sample (600 chars): ${body.slice(0, 600)}\n`)
      return { url: c.url, auth: c.auth }
    }
  }
  return null
}

let _endpoint = null

// ── LeadSimple API search ────────────────────────────────────────────────────

async function searchContact(query) {
  if (!_endpoint) throw new Error('No working endpoint — run discovery first')
  const base    = _endpoint.url.split('?')[0]
  const fullUrl = `${base}?search=${encodeURIComponent(query)}&per_page=5`
  const headers = { Accept: 'application/json' }
  if (_endpoint.auth) headers['Authorization'] = _endpoint.auth
  const res = await fetch(fullUrl, { headers })
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`LeadSimple API error (${res.status}): ${body.slice(0, 200)}`)
  }
  const data  = await res.json()
  const items = Array.isArray(data) ? data : (data.data || data.leads || data.contacts || [])
  return items.length > 0 ? items[0] : null
}

function extractId(contact) {
  // The `link` field contains the full contact URL — extract the encoded ID from it
  // e.g. "https://app.leadsimple.com/v2/contacts/S9p36UEKM0_..."
  if (contact?.link) {
    const parts = contact.link.split('/contacts/')
    if (parts.length > 1 && parts[1]) return parts[1]
  }
  // Fallback to UUID id (won't build the right URL but better than nothing)
  return contact?.id || null
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`LeadSimple Contact ID Sync (${DRY_RUN ? 'DRY RUN' : 'LIVE'})\n`)

  // Load owners who don't have a LeadSimple ID yet
  const { data: owners, error } = await supabase
    .from('owners')
    .select('id, name, email, leadsimple_contact_id')
    .is('leadsimple_contact_id', null)

  if (error) { console.error('Failed to load owners:', error.message); process.exit(1) }
  console.log(`Owners without LeadSimple ID: ${owners.length}`)

  if (owners.length === 0) {
    console.log('All owners already have LeadSimple IDs. Done.')
    return
  }

  // Discover which endpoint and auth format LeadSimple accepts
  console.log('\nDiscovering LeadSimple API endpoint...')
  try {
    _endpoint = await discoverEndpoint()
    if (!_endpoint) {
      console.error('No working LeadSimple endpoint found. Paste the output above and send it to Jarvis.')
      process.exit(1)
    }
  } catch (err) {
    console.error('Could not reach LeadSimple API:', err.message)
    process.exit(1)
  }

  let matched = 0, notFound = 0, failed = 0
  const updates = []

  for (const r of owners) {
    try {
      let contact = null

      // Try email first (more precise)
      if (r.email) {
        contact = await searchContact(r.email)
      }
      // Fall back to name
      if (!contact && r.name) {
        contact = await searchContact(r.name)
      }

      const lsId = extractId(contact)

      if (lsId) {
        matched++
        updates.push({ id: r.id, leadsimple_contact_id: String(lsId) })
        process.stdout.write(`\r  Matched ${matched} | Not found ${notFound} | Failed ${failed}`)
      } else {
        notFound++
        process.stdout.write(`\r  Matched ${matched} | Not found ${notFound} | Failed ${failed}`)
      }

      // Gentle rate limiting — LeadSimple allows ~60 req/min
      await new Promise(r => setTimeout(r, 1100))
    } catch (err) {
      failed++
      console.error(`\n  Error for ${r.name || r.email}: ${err.message}`)
    }
  }

  console.log(`\n\nResults: ${matched} matched · ${notFound} not found · ${failed} failed`)

  if (DRY_RUN || updates.length === 0) {
    if (DRY_RUN) console.log('[DRY RUN — nothing written]')
    return
  }

  // Write IDs in batches
  let saved = 0
  for (const u of updates) {
    const { error: uErr } = await supabase
      .from('owners')
      .update({ leadsimple_contact_id: u.leadsimple_contact_id })
      .eq('id', u.id)
    if (uErr) console.error(`  Save failed for ${u.id}:`, uErr.message)
    else saved++
  }

  console.log(`Saved ${saved} LeadSimple contact IDs.`)
  console.log('\nOwner Health dashboard LeadSimple links will now go directly to each contact.')
}

main().catch(err => { console.error(err); process.exit(1) })
