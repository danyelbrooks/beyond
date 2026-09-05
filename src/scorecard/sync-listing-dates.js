// sync-listing-dates.js
// Daily job: scrapes the BPM website for active rental listings, records
// each listing ID the first time it appears, and updates last_seen daily.
// This builds the "first_seen" dates that sync-scorecard.js uses for DOM.
//
// Usage:
//   node src/scorecard/sync-listing-dates.js
//   node src/scorecard/sync-listing-dates.js --dry-run

import 'dotenv/config'
import { supabase } from '../db/server-client.js'

const DRY_RUN       = process.argv.includes('--dry-run')
const CLIENT_ID     = process.env.APPFOLIO_STACK_CLIENT_ID
const CLIENT_SECRET = process.env.APPFOLIO_STACK_CLIENT_SECRET
const DEVELOPER_ID  = process.env.APPFOLIO_DEVELOPER_ID
const BASIC_AUTH    = CLIENT_ID && CLIENT_SECRET
  ? Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  : null
const AF_BASE       = 'https://api.appfolio.com/api/v0'
const BPM_URL       = 'https://www.beyondpropertymanagement.com/san-diego-homes-for-rent'

// ── Scrape BPM website for active listing IDs ────────────────────────────────

async function scrapeListings() {
  const res  = await fetch(BPM_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  const html = await res.text()

  // Links look like: href="/_system/listings/148/1465-C-Street--Unit-3615-..."
  const matches = [...html.matchAll(/href="\/\_system\/listings\/(\d+)\/([^"]+)"/g)]

  const seen = new Set()
  const listings = []

  for (const [, id, slug] of matches) {
    if (seen.has(id)) continue
    seen.add(id)
    // Exclude the "1234 Application" fake test listing by address, not ID
    // (its listing ID changes; the address always contains "1234")
    const address = parseAddressFromSlug(slug)
    if (address.toLowerCase().includes('1234')) continue

    listings.push({ listing_id: id, address })
  }

  return listings
}

function parseAddressFromSlug(slug) {
  // Slug: "1465-C-Street--Unit-3615-San-Diego-CA-92101-US"
  // Take the street portion before the city (marked by double-hyphen),
  // then strip trailing US/state/zip fragments.
  return slug
    .replace(/-US$/, '')
    .replace(/-\d{5}$/, '')
    .replace(/-[A-Z]{2}$/, '')
    .split('--')[0]
    .replace(/-/g, ' ')
    .trim()
}

// ── AppFolio: fetch all units ────────────────────────────────────────────────

async function fetchAllUnits() {
  if (!BASIC_AUTH) return []
  const units = []
  let page = 1
  while (true) {
    const url = new URL(`${AF_BASE}/units`)
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
    units.push(...items)
    if (!data.next_page_path || items.length < 500) break
    page++
  }
  return units
}

// ── Address normalization and matching ───────────────────────────────────────

function normalizeAddr(addr) {
  return (addr || '')
    .toLowerCase()
    .replace(/[,#.]/g, '')
    .replace(/\bst\b/g, 'street').replace(/\bave\b/g, 'avenue')
    .replace(/\bblvd\b/g, 'boulevard').replace(/\bdr\b/g, 'drive')
    .replace(/\brd\b/g, 'road').replace(/\bhwy\b/g, 'highway')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchUnitToListing(listingAddr, units) {
  const normListing = normalizeAddr(listingAddr)
  // Extract just the street portion: number + first two words of street name
  const parts      = normListing.split(' ')
  const listingNum = parts[0]
  const streetKey  = parts.slice(0, 3).join(' ')  // e.g. "2153 drescher street"

  // 1. Exact match on normalized address
  const exact = units.find(u => normalizeAddr(u.Address1) === normListing)
  if (exact) return exact

  // 2. Unit address contains the street key (handles "VACANT NOT RENTED 2153 Drescher" prefix)
  const byKey = units.filter(u => normalizeAddr(u.Address1).includes(streetKey))
  if (byKey.length === 1) return byKey[0]

  // 3. Listing address is a prefix of the unit address
  const prefix = units.find(u => normalizeAddr(u.Address1).startsWith(normListing))
  if (prefix) return prefix

  // 4. Street number match — only if exactly one unit has that number
  const byNum = units.filter(u => normalizeAddr(u.Address1).includes(' ' + listingNum + ' ') ||
                                   normalizeAddr(u.Address1).startsWith(listingNum + ' '))
  if (byNum.length === 1) return byNum[0]

  return null
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().split('T')[0]

  console.log('══════════════════════════════════════════')
  console.log(`  Listing Dates Sync — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  console.log(`  Date: ${today}`)
  console.log('══════════════════════════════════════════')

  console.log('\n[scrape] Fetching BPM website listings…')
  const listings = await scrapeListings()
  console.log(`  Found ${listings.length} active listings`)
  listings.forEach(l => console.log(`  [${l.listing_id}] ${l.address}`))

  if (listings.length === 0) {
    console.log('  No listings found — nothing to do.')
    return
  }

  console.log('\n[appfolio] Fetching all units for address matching…')
  const units = await fetchAllUnits()
  console.log(`  Fetched ${units.length} AppFolio units`)

  for (const listing of listings) {
    const unit = matchUnitToListing(listing.address, units)
    if (unit) {
      listing.unit_id     = unit.Id
      listing.property_id = unit.PropertyId
      console.log(`  Matched [${listing.listing_id}] "${listing.address}" → ${unit.Address1}`)
    } else {
      console.log(`  No match  [${listing.listing_id}] "${listing.address}"`)
    }
  }

  console.log('\n[supabase] Updating listing_first_seen…')

  const listingIds = listings.map(l => l.listing_id)

  // Find which listing IDs already exist in the table
  const { data: existing = [] } = await supabase
    .from('listing_first_seen')
    .select('listing_id')
    .in('listing_id', listingIds)

  const existingIds = new Set((existing || []).map(r => r.listing_id))
  const newListings = listings.filter(l => !existingIds.has(l.listing_id))
  const oldListings = listings.filter(l =>  existingIds.has(l.listing_id))

  console.log(`  New listings: ${newListings.length} | Already tracked: ${oldListings.length}`)

  if (DRY_RUN) {
    newListings.forEach(l => console.log(`  [DRY RUN] INSERT listing_id=${l.listing_id} first_seen=${today}`))
    oldListings.forEach(l => console.log(`  [DRY RUN] UPDATE last_seen=${today} for listing_id=${l.listing_id}`))
    return
  }

  // Insert new listings (first_seen = today)
  if (newListings.length > 0) {
    const { error } = await supabase.from('listing_first_seen').insert(
      newListings.map(l => ({
        listing_id:  l.listing_id,
        address:     l.address,
        unit_id:     l.unit_id || null,
        property_id: l.property_id || null,
        first_seen:  today,
        last_seen:   today,
      }))
    )
    if (error) console.error('  Insert error:', error.message)
    else console.log(`  Inserted ${newListings.length} new listing(s)`)
  }

  // Update last_seen for existing listings
  if (oldListings.length > 0) {
    const { error } = await supabase
      .from('listing_first_seen')
      .update({ last_seen: today })
      .in('listing_id', oldListings.map(l => l.listing_id))
    if (error) console.error('  Update error:', error.message)
    else console.log(`  Updated last_seen for ${oldListings.length} existing listing(s)`)
  }

  console.log('══════════════════════════════════════════\n')
}

main().catch(err => { console.error(err); process.exit(1) })
