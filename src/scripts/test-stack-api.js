/**
 * test-stack-api.js — Verify AppFolio Stack API connection
 *
 * Usage: node src/scripts/test-stack-api.js
 */

import 'dotenv/config'

const DEVELOPER_ID  = process.env.APPFOLIO_DEVELOPER_ID

// Try both credential sets — Stack creds vs existing AppFolio API creds
const CRED_SETS = [
  { label: 'Stack creds',    id: process.env.APPFOLIO_STACK_CLIENT_ID,  secret: process.env.APPFOLIO_STACK_CLIENT_SECRET },
  { label: 'Existing creds', id: process.env.APPFOLIO_CLIENT_ID,         secret: process.env.APPFOLIO_CLIENT_SECRET },
]

if (!DEVELOPER_ID || DEVELOPER_ID === 'paste-your-developer-id-here') {
  console.error('Missing APPFOLIO_DEVELOPER_ID in .env')
  process.exit(1)
}

async function run() {
  console.log('=== AppFolio Stack API Connection Test ===')
  console.log(`Developer ID: ${DEVELOPER_ID.slice(0, 8)}...`)

  const url = `https://api.appfolio.com/api/v0/tenants?filters[LastUpdatedAtFrom]=1970-01-01T00:00:00Z&page[number]=1&page[size]=3`

  for (const creds of CRED_SETS) {
    if (!creds.id || !creds.secret) continue
    const auth = Buffer.from(`${creds.id}:${creds.secret}`).toString('base64')
    console.log(`\n[${creds.label}] ${creds.id.slice(0, 8)}...`)

    const res  = await fetch(url, {
      headers: {
        Authorization:             `Basic ${auth}`,
        'X-AppFolio-Developer-ID': DEVELOPER_ID,
        Accept:                    'application/json',
      }
    })
    const body = await res.text()
    console.log(`Status: ${res.status}`)

    if (res.ok) {
      const items = JSON.parse(body).data || []
      console.log(`✓ Connected! ${items.length} tenant(s) returned.`)
      if (items.length > 0) console.log('\nFirst tenant:\n', JSON.stringify(items[0], null, 2))
      return
    } else {
      console.log(`Response: ${body.slice(0, 200)}`)
    }
  }
}

run().catch(err => { console.error(err); process.exit(1) })
