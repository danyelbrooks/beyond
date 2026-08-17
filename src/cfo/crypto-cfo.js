/**
 * crypto-cfo.js — Coinbase + Kraken balance fetching for the CFO Dashboard
 *
 * Both exchanges require HMAC-signed requests using their respective secrets.
 *
 * Coinbase signing:
 *   message = timestamp (Unix seconds, string) + 'GET' + '/v2/accounts' + ''
 *   sign    = HMAC-SHA256(COINBASE_API_SECRET, message) → hex string
 *
 * Kraken signing:
 *   sha256_hash = SHA256(nonce + postData) → binary
 *   message     = path_bytes + sha256_hash_bytes
 *   sign        = HMAC-SHA512(base64decode(KRAKEN_API_SECRET), message) → base64 string
 *
 * Required env vars (per exchange, only if that exchange is used):
 *   COINBASE_API_KEY, COINBASE_API_SECRET
 *   KRAKEN_API_KEY, KRAKEN_API_SECRET
 */

import 'dotenv/config'
import crypto from 'crypto'

// =============================================================================
// COINBASE
// =============================================================================

export async function getCoinbaseBalance() {
  const apiKey    = process.env.COINBASE_API_KEY
  const apiSecret = process.env.COINBASE_API_SECRET

  if (!apiKey || !apiSecret) {
    return { balance: 0, configured: false }
  }

  const method    = 'GET'
  const path      = '/v2/accounts'
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const body      = ''

  // HMAC-SHA256: sign the concatenation of timestamp + method + path + body
  const message = timestamp + method + path + body
  const sign    = crypto
    .createHmac('sha256', apiSecret)
    .update(message)
    .digest('hex')

  try {
    const res = await fetch(`https://api.coinbase.com${path}`, {
      headers: {
        'CB-ACCESS-KEY':       apiKey,
        'CB-ACCESS-SIGN':      sign,
        'CB-ACCESS-TIMESTAMP': timestamp,
        'CB-VERSION':          '2016-02-18',
      },
    })

    if (!res.ok) {
      const text = await res.text()
      console.error(`[Coinbase] API error: ${res.status} ${text.slice(0, 200)}`)
      return { balance: 0, configured: true, error: `API ${res.status}` }
    }

    const data     = await res.json()
    const accounts = data.data || []

    // Each account has a native_balance field already converted to the account's
    // home currency (USD for US accounts). Sum all of them.
    let totalUSD = 0
    for (const account of accounts) {
      const nativeAmount = Number(account.native_balance?.amount) || 0
      if (!isNaN(nativeAmount)) totalUSD += nativeAmount
    }

    return { balance: totalUSD, configured: true }
  } catch (err) {
    console.error('[Coinbase] fetch failed:', err.message)
    return { balance: 0, configured: true, error: err.message }
  }
}

// =============================================================================
// KRAKEN
// =============================================================================

export async function getKrakenBalance() {
  const apiKey    = process.env.KRAKEN_API_KEY
  const apiSecret = process.env.KRAKEN_API_SECRET

  if (!apiKey || !apiSecret) {
    return { balance: 0, configured: false }
  }

  const path     = '/0/private/Balance'
  const nonce    = Date.now().toString()
  const postData = `nonce=${nonce}`

  // Step 1: SHA256 of (nonce + postData), returned as binary buffer
  const sha256Result = crypto.createHash('sha256').update(nonce + postData).digest()

  // Step 2: HMAC-SHA512 of (path_bytes + sha256_binary), using base64-decoded API secret
  const pathBuf   = Buffer.from(path, 'utf-8')
  const message   = Buffer.concat([pathBuf, sha256Result])
  const secretBuf = Buffer.from(apiSecret, 'base64')
  const sign      = crypto.createHmac('sha512', secretBuf).update(message).digest('base64')

  try {
    const res = await fetch(`https://api.kraken.com${path}`, {
      method:  'POST',
      headers: {
        'API-Key':      apiKey,
        'API-Sign':     sign,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: postData,
    })

    if (!res.ok) {
      const text = await res.text()
      console.error(`[Kraken] API error: ${res.status} ${text.slice(0, 200)}`)
      return { balance: 0, configured: true, error: `API ${res.status}` }
    }

    const data = await res.json()

    if (data.error && data.error.length > 0) {
      console.error('[Kraken] API returned errors:', data.error)
      return { balance: 0, configured: true, error: data.error.join(', ') }
    }

    // Kraken returns balances keyed by asset code: { ZUSD: "500.00", XXBT: "0.01", ... }
    // ZUSD = US Dollar. We sum USD-equivalent keys only to avoid needing live price quotes.
    const balances = data.result || {}
    let totalUSD   = 0

    for (const [key, val] of Object.entries(balances)) {
      // ZUSD is the main USD key. Also catch USD.M (money market) and similar.
      if (key === 'ZUSD' || key.startsWith('USD') || key.endsWith('USD')) {
        totalUSD += Number(val) || 0
      }
    }

    return { balance: totalUSD, configured: true, raw: balances }
  } catch (err) {
    console.error('[Kraken] fetch failed:', err.message)
    return { balance: 0, configured: true, error: err.message }
  }
}

// =============================================================================
// COMBINED — call both exchanges and return a summary
// =============================================================================

export async function getCryptoTotal() {
  const [coinbase, kraken] = await Promise.all([
    getCoinbaseBalance(),
    getKrakenBalance(),
  ])

  return {
    coinbase:            coinbase.balance,
    kraken:              kraken.balance,
    total:               coinbase.balance + kraken.balance,
    coinbase_configured: coinbase.configured,
    kraken_configured:   kraken.configured,
  }
}
