/**
 * qbo-cfo.js — QuickBooks Online integration for the CFO Dashboard
 *
 * Handles OAuth 2.0 flow, token storage, and account balance fetching.
 * Uses native fetch — no intuit-oauth package required.
 *
 * Required env vars: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REALM_ID
 * Optional: QBO_SANDBOX=true (uses sandbox API instead of production)
 */

import 'dotenv/config'
import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Tokens are stored in the project root — never committed (added to .gitignore).
const TOKEN_FILE = path.resolve(__dirname, '../../qbo-token.json')

const QBO_TOKEN_URL  = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const QBO_REDIRECT   = process.env.QBO_REDIRECT_URI || 'http://localhost:3005/api/cfo/qbo/callback'
const QBO_SCOPE      = 'com.intuit.quickbooks.accounting'

const QBO_API_BASE = process.env.QBO_SANDBOX === 'true'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com'

// Returns true if the two required env vars are set.
// QBO_REALM_ID is captured automatically from the OAuth callback — not required upfront.
export function isConfigured() {
  return !!(
    process.env.QBO_CLIENT_ID &&
    process.env.QBO_CLIENT_SECRET
  )
}

// Returns true if a token file exists with a refresh_token (i.e. Danyel has authorized QBO).
export async function isConnected() {
  if (!existsSync(TOKEN_FILE)) return false
  try {
    const raw  = await readFile(TOKEN_FILE, 'utf-8')
    const data = JSON.parse(raw)
    return !!(data && data.refresh_token)
  } catch {
    return false
  }
}

// Returns the full QuickBooks OAuth 2.0 authorization URL.
// Redirect this URL in the browser to start the QBO login flow.
export function getAuthUrl() {
  const params = new URLSearchParams({
    client_id:     process.env.QBO_CLIENT_ID,
    redirect_uri:  QBO_REDIRECT,
    response_type: 'code',
    scope:         QBO_SCOPE,
    state:         'cfo-dashboard',
  })
  return `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`
}

// Exchanges the one-time authorization code for access + refresh tokens.
// realmId comes from Intuit's OAuth callback query string — saved to qbo-token.json.
// Stores tokens in qbo-token.json. Returns { access_token, refresh_token, expires_in }.
export async function exchangeCodeForToken(code, realmId) {
  const credentials = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64')

  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: QBO_REDIRECT,
  })

  const res = await fetch(QBO_TOKEN_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Accept':        'application/json',
    },
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`QBO token exchange failed: ${res.status} ${text.slice(0, 300)}`)
  }

  const data = await res.json()

  await writeFile(TOKEN_FILE, JSON.stringify({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_in:    data.expires_in,
    fetched_at:    Date.now(),
    realm_id:      realmId,
  }, null, 2))

  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_in:    data.expires_in,
  }
}

// Reads the stored refresh_token, calls the token endpoint for a fresh access_token,
// updates qbo-token.json, and returns the new access_token.
export async function refreshAccessToken() {
  const raw    = await readFile(TOKEN_FILE, 'utf-8')
  const stored = JSON.parse(raw)

  if (!stored.refresh_token) {
    throw new Error('No refresh_token in qbo-token.json — re-authorize QBO via /api/cfo/qbo/auth')
  }

  const credentials = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64')

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: stored.refresh_token,
  })

  const res = await fetch(QBO_TOKEN_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Accept':        'application/json',
    },
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`QBO token refresh failed: ${res.status} ${text.slice(0, 300)}`)
  }

  const data = await res.json()

  // Intuit may return a new refresh_token; fall back to the stored one if not.
  // Preserve realm_id so it survives token refreshes.
  await writeFile(TOKEN_FILE, JSON.stringify({
    access_token:  data.access_token,
    refresh_token: data.refresh_token || stored.refresh_token,
    expires_in:    data.expires_in,
    fetched_at:    Date.now(),
    realm_id:      stored.realm_id,
  }, null, 2))

  return data.access_token
}

// Fetches all active accounts from QBO.
// Returns array of { name, accountType, accountSubType, currentBalance }.
export async function getAccountBalances() {
  const accessToken = await refreshAccessToken()

  // realm_id is captured during OAuth and stored in the token file.
  const raw     = await readFile(TOKEN_FILE, 'utf-8')
  const stored  = JSON.parse(raw)
  const realmId = stored.realm_id || process.env.QBO_REALM_ID
  if (!realmId) throw new Error('QBO realm_id not found — reconnect QBO via the dashboard')

  const query = 'SELECT * FROM Account WHERE Active = true'
  const url   = `${QBO_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept':        'application/json',
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`QBO accounts fetch failed: ${res.status} ${text.slice(0, 300)}`)
  }

  const data     = await res.json()
  const accounts = data?.QueryResponse?.Account || []

  return accounts.map(a => ({
    name:           a.Name,
    accountType:    a.AccountType,
    accountSubType: a.AccountSubType || '',
    currentBalance: Number(a.CurrentBalance) || 0,
  }))
}

// Maps an array of QBO accounts to CFO dashboard buckets.
// Returns { cash: [{name, balance}], investments: [{name, balance}], credit: [{name, balance}] }
export function mapAccountsToBuckets(accounts) {
  const result = { cash: [], investments: [], credit: [] }

  for (const { name, accountType, accountSubType, currentBalance: balance } of accounts) {
    if (accountType === 'Bank') {
      result.cash.push({ name, balance })
    } else if (accountType === 'Credit Card') {
      result.credit.push({ name, balance })
    } else if (
      accountType === 'Investment' ||
      ['Brokerage', 'Retirement', 'Investment'].some(sub =>
        (accountSubType || '').includes(sub)
      )
    ) {
      result.investments.push({ name, balance })
    }
    // Other Asset and everything else: skipped per spec
  }

  return result
}
