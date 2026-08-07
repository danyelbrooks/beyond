/**
 * appfolio-cfo.js — AppFolio data fetcher for the Personal CFO Dashboard
 *
 * Pulls two pieces of data from AppFolio:
 *   1. BPM gross revenue (trailing 12 months) — feeds the Business bucket valuation
 *   2. Owner distributions by month — feeds the passive income tracker
 *
 * NOTE: The existing AppFolio integration in this codebase uses CSV file exports,
 * not the REST API. The REST API credentials are not yet in .env.
 * Both functions below return zero-value mock data in the correct shape until
 * credentials are added and the real API calls are wired in.
 *
 * To enable real data, add these three variables to .env:
 *   APPFOLIO_CLIENT_ID     — your AppFolio company/client ID (from AppFolio > Settings > API)
 *   APPFOLIO_CLIENT_SECRET — your AppFolio API secret/password
 *   APPFOLIO_DEVELOPER_ID  — already present (ba023937-...)
 *
 * Once those are set, replace the stub bodies under each TODO comment.
 */

const APPFOLIO_BASE = 'https://api.appfolio.com/api/v2'

/**
 * Build an Authorization header for AppFolio REST API.
 * AppFolio v2 uses HTTP Basic Auth: username = client_id, password = client_secret.
 * Returns null if credentials are missing.
 */
function getAuthHeader() {
  const clientId     = process.env.APPFOLIO_CLIENT_ID
  const clientSecret = process.env.APPFOLIO_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  const token = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  return `Basic ${token}`
}

// Build the ISO date string for the first day of a given month offset from today.
// offset = -11 gives 12 months ago (inclusive of the current month = trailing 12).
function firstOfMonth(monthOffset) {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() + monthOffset)
  return d.toISOString().split('T')[0]
}

// ─────────────────────────────────────────────────────────────────────────────
// getBPMGrossRevenue()
//
// Returns trailing 12-month gross revenue for Beyond Property Management.
// BPM is valued at 1x gross revenue (per the CFO Dashboard spec).
//
// Return shape:
//   {
//     gross_revenue_trailing_12: number,
//     calculated_at:             string (ISO),
//     is_mock:                   boolean,
//   }
// ─────────────────────────────────────────────────────────────────────────────
export async function getBPMGrossRevenue() {
  const auth = getAuthHeader()

  if (!auth) {
    console.log('[AppFolio] APPFOLIO_CLIENT_ID or APPFOLIO_CLIENT_SECRET not set — returning zero mock data')
    return {
      gross_revenue_trailing_12: 0,
      calculated_at: new Date().toISOString(),
      is_mock: true,
    }
  }

  // TODO: Wire up the real AppFolio API call.
  //
  // The correct endpoint is likely one of:
  //   GET /api/v2/reports/income_statement
  //   GET /api/v2/reports/owner_summary
  //
  // Required parameters:
  //   from_date   — first day of 12 months ago, e.g. "2024-07-01"
  //   to_date     — last day of current month,  e.g. "2025-06-30"
  //
  // The response will include gross income broken down by category.
  // Sum all management fee, leasing fee, and other income line items
  // to get BPM's total gross revenue for the period.
  //
  // Skeleton:
  //   const fromDate = firstOfMonth(-11)
  //   const toDate   = firstOfMonth(1)   // first of next month — API treats as exclusive
  //   const url = `${APPFOLIO_BASE}/reports/income_statement?from_date=${fromDate}&to_date=${toDate}`
  //   const res = await fetch(url, {
  //     headers: {
  //       Authorization:  auth,
  //       'Content-Type': 'application/json',
  //       'X-Appfolio-Developer-Id': process.env.APPFOLIO_DEVELOPER_ID,
  //     },
  //   })
  //   if (!res.ok) throw new Error(`AppFolio income_statement: ${res.status} ${res.statusText}`)
  //   const body = await res.json()
  //   const grossRevenue = body.total_income ?? body.gross_revenue ?? 0
  //   return {
  //     gross_revenue_trailing_12: Number(grossRevenue),
  //     calculated_at:             new Date().toISOString(),
  //     is_mock:                   false,
  //   }

  console.log('[AppFolio] getBPMGrossRevenue: credentials present but real API call not yet implemented')
  return {
    gross_revenue_trailing_12: 0,
    calculated_at: new Date().toISOString(),
    is_mock: true,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getPropertyPassiveIncome()
//
// Returns the last 12 months of net owner distributions for Danyel's rental
// properties (Sunset Trust LLC: Robertson 6-plex and Lincoln duplex).
// Used for the passive income tracker and the 12-month bar chart.
//
// Return shape:
//   {
//     monthly_totals:    [{ month: 'YYYY-MM', amount: number }, ...],  // 12 entries
//     current_month_net: number,
//     is_mock:           boolean,
//   }
// ─────────────────────────────────────────────────────────────────────────────
export async function getPropertyPassiveIncome() {
  const auth = getAuthHeader()

  if (!auth) {
    console.log('[AppFolio] APPFOLIO_CLIENT_ID or APPFOLIO_CLIENT_SECRET not set — returning zero mock passive income')
    return buildEmptyPassiveIncome()
  }

  // TODO: Wire up the real AppFolio API call.
  //
  // The correct endpoint is likely:
  //   GET /api/v2/owner_ledger_entries
  //   or GET /api/v2/owner_statements
  //
  // Required parameters:
  //   from_date   — first day of 12 months ago
  //   to_date     — today or last day of current month
  //   entry_type  — 'owner_distribution' (confirm the exact string with AppFolio docs)
  //
  // The response is a list of distribution entries, each with a date and amount.
  // Group by YYYY-MM (the first 7 chars of entry.date) and sum amounts.
  //
  // Skeleton:
  //   const fromDate = firstOfMonth(-11)
  //   const toDate   = new Date().toISOString().split('T')[0]
  //   const url = `${APPFOLIO_BASE}/owner_ledger_entries?from_date=${fromDate}&to_date=${toDate}&entry_type=owner_distribution`
  //   const res = await fetch(url, {
  //     headers: {
  //       Authorization: auth,
  //       'X-Appfolio-Developer-Id': process.env.APPFOLIO_DEVELOPER_ID,
  //     },
  //   })
  //   if (!res.ok) throw new Error(`AppFolio owner_ledger_entries: ${res.status} ${res.statusText}`)
  //   const { entries } = await res.json()
  //
  //   const byMonth = {}
  //   for (const e of entries) {
  //     const month = String(e.date).slice(0, 7)
  //     byMonth[month] = (byMonth[month] || 0) + Number(e.amount)
  //   }
  //
  //   const monthly_totals = buildMonthRange().map(month => ({
  //     month,
  //     amount: byMonth[month] || 0,
  //   }))
  //
  //   const currentMonth = new Date().toISOString().slice(0, 7)
  //   return {
  //     monthly_totals,
  //     current_month_net: byMonth[currentMonth] || 0,
  //     is_mock: false,
  //   }

  console.log('[AppFolio] getPropertyPassiveIncome: credentials present but real API call not yet implemented')
  return buildEmptyPassiveIncome()
}

// ─────────────────────────────────────────────────────────────────────────────
// isConfigured()
// Returns true if AppFolio REST credentials are present in the environment.
// ─────────────────────────────────────────────────────────────────────────────
export function isConfigured() {
  return !!(process.env.APPFOLIO_CLIENT_ID && process.env.APPFOLIO_CLIENT_SECRET)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Generates an array of the last 12 months as 'YYYY-MM' strings, oldest first.
function buildMonthRange() {
  const months = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date()
    d.setDate(1)
    d.setMonth(d.getMonth() - i)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return months
}

// Returns the zero-value shape for passive income (12 months all at $0).
function buildEmptyPassiveIncome() {
  return {
    monthly_totals: buildMonthRange().map(month => ({ month, amount: 0 })),
    current_month_net: 0,
    is_mock: true,
  }
}
