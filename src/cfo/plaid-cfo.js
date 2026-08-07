/**
 * plaid-cfo.js — Plaid bank account integration for the Personal CFO Dashboard
 *
 * Wraps the Plaid Node SDK to:
 *   1. Create a Link token (used by the browser to open Plaid Link)
 *   2. Exchange a public_token for a permanent access_token
 *   3. Sync all linked accounts and recent transactions
 *   4. Detect recurring subscription charges
 *
 * Access tokens are stored in cfo_plaid_items (DB) and NEVER returned to the browser.
 * Only the link_token (temporary, 30-min lifetime) is safe to send to the browser.
 *
 * Required env vars:
 *   PLAID_CLIENT_ID  — from Plaid dashboard > Team Settings > Keys
 *   PLAID_SECRET     — from Plaid dashboard > Team Settings > Keys
 *   PLAID_ENV        — 'sandbox' | 'development' | 'production' (defaults to 'sandbox')
 */

import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid'
import { supabase } from '../db/server-client.js'

// Build a configured Plaid API client from env vars.
// Called fresh each request so env changes take effect without restart.
function getClient() {
  const configuration = new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET':    process.env.PLAID_SECRET,
      },
    },
  })
  return new PlaidApi(configuration)
}

// ─────────────────────────────────────────────────────────────────────────────
// isConfigured()
// Returns true if both Plaid credentials are present in the environment.
// ─────────────────────────────────────────────────────────────────────────────
export function isConfigured() {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET)
}

// ─────────────────────────────────────────────────────────────────────────────
// createLinkToken()
//
// Creates a short-lived (30-min) Plaid Link token. The browser uses this to
// open the Plaid Link modal. The token is safe to send to the frontend.
//
// Returns: the link_token string
// ─────────────────────────────────────────────────────────────────────────────
export async function createLinkToken() {
  const client = getClient()
  const response = await client.linkTokenCreate({
    user:          { client_user_id: 'danyel-brooks' },
    client_name:   'BPM CFO Dashboard',
    products:      [Products.Transactions, Products.Auth],
    country_codes: [CountryCode.Us],
    language:      'en',
  })
  return response.data.link_token
}

// ─────────────────────────────────────────────────────────────────────────────
// exchangePublicToken(public_token)
//
// Exchanges the one-time public_token from Plaid Link for a permanent
// access_token. The access_token is what we use for all future API calls.
//
// Returns: { access_token, item_id }
// The caller (server.js) is responsible for storing these in cfo_plaid_items.
// ─────────────────────────────────────────────────────────────────────────────
export async function exchangePublicToken(public_token) {
  const client   = getClient()
  const response = await client.itemPublicTokenExchange({ public_token })
  return {
    access_token: response.data.access_token,
    item_id:      response.data.item_id,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// syncAllAccounts()
//
// Loads all active access_tokens from cfo_plaid_items, fetches live balances
// from Plaid for each, and returns a flat array of accounts.
//
// Return shape per account:
//   {
//     institution_name: string,
//     account_name:     string,
//     account_type:     'depository' | 'investment' | 'credit' | 'loan' | 'other',
//     account_subtype:  string (e.g. 'checking', 'savings', 'credit card'),
//     balance_current:  number | null,
//     balance_available: number | null,
//     account_id:       string (Plaid account_id, stable identifier),
//   }
// ─────────────────────────────────────────────────────────────────────────────
export async function syncAllAccounts() {
  const { data: items, error } = await supabase
    .from('cfo_plaid_items')
    .select('id, access_token, institution_name')
    .eq('is_active', true)

  if (error) throw error
  if (!items || items.length === 0) return []

  const client  = getClient()
  const results = []
  const now     = new Date().toISOString()

  for (const item of items) {
    try {
      const response = await client.accountsBalanceGet({ access_token: item.access_token })

      for (const account of response.data.accounts) {
        results.push({
          institution_name:  item.institution_name,
          account_name:      account.name,
          account_type:      account.type,        // 'depository' | 'investment' | 'credit' | 'loan' | 'other'
          account_subtype:   account.subtype,
          balance_current:   account.balances.current,
          balance_available: account.balances.available,
          account_id:        account.account_id,
        })
      }

      // Stamp the sync time on the item row so the status endpoint can report it.
      await supabase
        .from('cfo_plaid_items')
        .update({ last_synced_at: now })
        .eq('id', item.id)

    } catch (err) {
      // One bad item shouldn't block the others — log and keep going.
      console.error(`[Plaid] syncAllAccounts failed for item ${item.id}:`, err.message)
    }
  }

  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// syncTransactions(days)
//
// Fetches transactions from the last N days across all linked accounts.
// Returns the raw Plaid transaction array (used for subscription detection).
// ─────────────────────────────────────────────────────────────────────────────
export async function syncTransactions(days = 90) {
  const { data: items, error } = await supabase
    .from('cfo_plaid_items')
    .select('id, access_token')
    .eq('is_active', true)

  if (error) throw error
  if (!items || items.length === 0) return []

  const client    = getClient()
  const endDate   = new Date().toISOString().split('T')[0]
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const allTransactions = []

  for (const item of items) {
    try {
      const response = await client.transactionsGet({
        access_token: item.access_token,
        start_date:   startDate,
        end_date:     endDate,
        options:      { count: 500, offset: 0 },
      })
      allTransactions.push(...response.data.transactions)
    } catch (err) {
      console.error(`[Plaid] syncTransactions failed for item ${item.id}:`, err.message)
    }
  }

  return allTransactions
}

// ─────────────────────────────────────────────────────────────────────────────
// detectRecurringCharges(transactions)
//
// Takes the raw Plaid transaction array and finds merchants that appear 2+
// times with consistent charge amounts. Returns potential subscriptions.
//
// Detection logic:
//   - Group by merchant_name (falls back to transaction name)
//   - Require count >= 2
//   - Require all amounts within $1 of the group median (consistent charge)
//   - Estimate frequency from average gap between charges
//
// Return shape per recurring charge:
//   { merchant_name, amount, frequency, last_charged_date }
// ─────────────────────────────────────────────────────────────────────────────
export function detectRecurringCharges(transactions) {
  const byMerchant = {}

  for (const txn of transactions) {
    // Use merchant_name when available; fall back to transaction name.
    const rawName = (txn.merchant_name || txn.name || '').trim()
    if (!rawName) continue
    const key = rawName.toLowerCase()

    if (!byMerchant[key]) {
      byMerchant[key] = { merchant_name: rawName, amounts: [], dates: [] }
    }
    byMerchant[key].amounts.push(Math.abs(txn.amount))
    byMerchant[key].dates.push(txn.date)
  }

  const recurring = []

  for (const group of Object.values(byMerchant)) {
    if (group.amounts.length < 2) continue

    // Check consistency: all amounts within $1 of the median.
    const sorted   = [...group.amounts].sort((a, b) => a - b)
    const median   = sorted[Math.floor(sorted.length / 2)]
    const consistent = group.amounts.every(a => Math.abs(a - median) <= 1)
    if (!consistent) continue

    // Sort dates chronologically; compute average gap.
    group.dates.sort()
    const lastDate       = group.dates[group.dates.length - 1]
    const daySpan        = (new Date(lastDate) - new Date(group.dates[0])) / (1000 * 60 * 60 * 24)
    const avgGap         = group.amounts.length > 1 ? daySpan / (group.amounts.length - 1) : 30

    let frequency = 'irregular'
    if (avgGap <= 10)       frequency = 'weekly'
    else if (avgGap <= 35)  frequency = 'monthly'
    else if (avgGap <= 370) frequency = 'annual'

    recurring.push({
      merchant_name:     group.merchant_name,
      amount:            median,
      frequency,
      last_charged_date: lastDate,
    })
  }

  return recurring
}
