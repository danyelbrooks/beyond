/**
 * server.js — BPM Email API
 *
 * A small backend server that handles Gmail sending on behalf of the Command Center.
 * The browser cannot call Gmail directly (credentials must stay on the server),
 * so this acts as the bridge.
 *
 * Endpoints:
 *   POST /api/reply   — send a reply to an email via Gmail
 *   POST /api/forward — forward an email to another BPM inbox via Gmail
 *
 * Usage:
 *   npm run start:api
 *
 * Runs on port 3005 (Command Center is on 3000).
 */

import 'dotenv/config'
import express        from 'express'
import cors           from 'cors'
import Anthropic      from '@anthropic-ai/sdk'
import fetch          from 'node-fetch'
import { sendReply, getGmailClientForInbox } from '../email/gmail-service-client.js'
import { createClient }                       from '@supabase/supabase-js'
import { getBPMGrossRevenue, getPropertyPassiveIncome, isConfigured as appfolioConfigured } from '../cfo/appfolio-cfo.js'
import { isConfigured as plaidConfigured, createLinkToken, exchangePublicToken, syncAllAccounts, syncTransactions, detectRecurringCharges } from '../cfo/plaid-cfo.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// =============================================================================
// LEADSIMPLE HELPER
// =============================================================================

const LS_BASE = 'https://api.leadsimple.com/rest'

async function lsFetch(path) {
  const res = await fetch(`${LS_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${process.env.LEADSIMPLE_API_KEY}`,
      'Content-Type':  'application/json'
    }
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LeadSimple ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

const app = express()

// Allow requests from the Command Center on port 3000
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3002',
    'https://bpm-command-center.onrender.com',
    'https://app.bpmsd.com'
  ]
}))
app.use(express.json())

// Service-role Supabase client — only used to read email details
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// =============================================================================
// AUTH MIDDLEWARE
// Verifies the Supabase session token sent by the Command Center browser client.
// Apply to all staff-only routes; skip for health check and public endpoints.
// =============================================================================

async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const token = authHeader.slice(7)
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Unauthorized' })
    req.user = user
    next()
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

// Protect all staff routes before any route handlers are registered
app.use('/api/reply',   requireAuth)
app.use('/api/forward', requireAuth)
app.use('/api/compose', requireAuth)
app.use('/api/cfo',     requireAuth)
app.use('/api/insurance', requireAuth)

// =============================================================================
// POST /api/reply
// Body: { emailId: string, replyBody: string }
//
// Sends a reply to the original sender, from the inbox that received the email.
// =============================================================================

app.post('/api/reply', async (req, res) => {
  const { emailId, replyBody, subject, cc, bcc } = req.body

  if (!emailId || !replyBody?.trim()) {
    return res.status(400).json({ error: 'emailId and replyBody are required' })
  }

  // Pull email details from Supabase
  const { data: email, error } = await supabase
    .from('email_cache')
    .select('to_address, m365_message_id, subject')
    .eq('id', emailId)
    .single()

  if (error || !email) {
    return res.status(404).json({ error: 'Email not found' })
  }

  try {
    await sendReply(email.to_address, email.m365_message_id, replyBody.trim(), { subject, cc, bcc })
    res.json({ ok: true })
  } catch (err) {
    console.error('Reply error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// =============================================================================
// POST /api/forward
// Body: { emailId: string, toInbox: string }
//
// Forwards the email to another BPM inbox (e.g. "info@bpmsd.com").
// Sends FROM the inbox that originally received the email.
// =============================================================================

app.post('/api/forward', async (req, res) => {
  const { emailId, toInbox } = req.body

  if (!emailId || !toInbox) {
    return res.status(400).json({ error: 'emailId and toInbox are required' })
  }

  // Validate toInbox is a BPM address
  const BPM_INBOXES = [
    'danyel@bpmsd.com', 'help@bpmsd.com', 'beyond@bpmsd.com', 'info@bpmsd.com',
    'accounts@bpmsd.com', 'manager@bpmsd.com', 'success@bpmsd.com', 'home@bpmsd.com',
    'admin@bpmsd.com', 'hello@bpmsd.com', 'care@bpmsd.com'
  ]
  if (!BPM_INBOXES.includes(toInbox)) {
    return res.status(400).json({ error: 'Invalid inbox address' })
  }

  // Pull email details from Supabase
  const { data: email, error } = await supabase
    .from('email_cache')
    .select('to_address, subject, from_address, from_name, received_at, body_preview, body_html')
    .eq('id', emailId)
    .single()

  if (error || !email) {
    return res.status(404).json({ error: 'Email not found' })
  }

  try {
    const gmail = await getGmailClientForInbox(email.to_address)

    const fwdSubject = email.subject?.startsWith('Fwd:')
      ? email.subject
      : `Fwd: ${email.subject || '(no subject)'}`

    const dateStr = new Date(email.received_at).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    })

    const fromLine = email.from_name
      ? `${email.from_name} <${email.from_address}>`
      : email.from_address

    // Plain-text forward block
    const fwdBody = [
      `---------- Forwarded message ---------`,
      `From: ${fromLine}`,
      `Date: ${dateStr}`,
      `Subject: ${email.subject || '(no subject)'}`,
      `To: ${email.to_address}`,
      ``,
      email.body_preview || '(no preview available)'
    ].join('\r\n')

    const rawLines = [
      `From: ${email.to_address}`,
      `To: ${toInbox}`,
      `Subject: ${fwdSubject}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      fwdBody
    ]

    const encodedRaw = Buffer.from(rawLines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedRaw }
    })

    res.json({ ok: true })
  } catch (err) {
    console.error('Forward error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// =============================================================================
// GET /api/leadsimple-context?email=...
//
// Looks up a contact in LeadSimple by email address and returns their
// recent notes, conversations, and deal/process stage for use as AI context.
// Always returns 200 — { found: false } if not in LeadSimple.
// =============================================================================

app.get('/api/leadsimple-context', async (req, res) => {
  const { email } = req.query
  if (!email) return res.status(400).json({ error: 'email is required' })

  try {
    const searchData = await lsFetch(`/contacts?search=${encodeURIComponent(email)}&per_page=25`)
    const list = searchData.data || []

    // Match against the emails array on each contact
    const lc = email.toLowerCase()
    const contact = list.find(c =>
      Array.isArray(c.emails) && c.emails.some(e => e.toLowerCase() === lc)
    )

    if (!contact) {
      return res.json({ found: false })
    }

    const id = contact.id
    const [convResult, dealsResult] = await Promise.allSettled([
      lsFetch(`/conversations?contact_id=${id}&per_page=5`),
      lsFetch(`/deals?contact_id=${id}&per_page=5`),
    ])

    const conversations = convResult.status  === 'fulfilled' ? (convResult.value.data  || []) : []
    const deals         = dealsResult.status === 'fulfilled' ? (dealsResult.value.data || []) : []

    res.json({
      found: true,
      contact: {
        name:  contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' '),
        email: contact.emails?.[0] || email,
        phone: contact.phone_numbers?.[0] || '',
      },
      conversations: conversations.slice(0, 5),
      deals:         deals.slice(0, 5),
    })
  } catch (err) {
    console.error('LeadSimple context error:', err.message)
    res.json({ found: false, error: err.message })
  }
})

// =============================================================================
// POST /api/draft
// Body: { subject: string, body: string, fromName: string, fromAddress: string }
//
// Asks Claude to draft a professional reply to the given email.
// =============================================================================

app.post('/api/draft', async (req, res) => {
  const { subject, body, fromName, fromAddress, leadsimpleContext } = req.body

  if (!body?.trim() && !subject?.trim()) {
    return res.status(400).json({ error: 'subject or body is required' })
  }

  const from = fromName ? `${fromName} <${fromAddress}>` : fromAddress

  // Build optional LeadSimple context block
  let contextBlock = ''
  if (leadsimpleContext?.found) {
    const ctx = leadsimpleContext
    const lines = ['[Contact history from LeadSimple]']
    if (ctx.contact?.name) lines.push(`Name: ${ctx.contact.name}`)
    if (ctx.contact?.phone) lines.push(`Phone: ${ctx.contact.phone}`)

    if (ctx.conversations?.length) {
      lines.push('', 'Recent conversations in LeadSimple:')
      ctx.conversations.forEach(c => {
        const kind   = c.kind || 'message'
        const inbox  = c.inbox ? ` via ${c.inbox}` : ''
        const status = c.status ? ` [${c.status}]` : ''
        lines.push(`- ${kind}${inbox}${status}`)
      })
    }

    if (ctx.deals?.length) {
      lines.push('', 'Active deals/pipelines:')
      ctx.deals.forEach(d => {
        const stage    = d.stage?.name    ? ` — Stage: ${d.stage.name}`       : ''
        const pipeline = d.pipeline?.name ? ` (${d.pipeline.name})`           : ''
        const prop     = d.properties?.[0]?.address ? ` @ ${d.properties[0].address}` : ''
        lines.push(`- ${d.name || 'Deal'}${pipeline}${stage}${prop}`)
      })
    }

    contextBlock = '\n\n' + lines.join('\n')
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `You are a professional property manager at Beyond Property Management in San Diego. Draft a concise, professional reply to the email below. Write only the reply body — no subject line, no greeting like "Dear [name]" unless appropriate, no signature. Be warm but efficient. Use the contact history if provided to personalize the reply.${contextBlock}

Email from: ${from}
Subject: ${subject || '(no subject)'}

${body?.trim() || '(no body)'}

Draft reply:`
      }]
    })

    const draft = message.content[0]?.text?.trim() || ''
    res.json({ draft })
  } catch (err) {
    console.error('Draft error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// =============================================================================
// CFO DASHBOARD — Manual Inputs
// =============================================================================

// Derive a human-readable label from a field_key when none is provided.
// e.g. "mortgage_robertson" → "Mortgage Robertson"
function deriveCfoLabel(fieldKey) {
  return fieldKey
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

// GET /api/cfo/manual-inputs
// Returns all rows from cfo_manual_inputs as a JSON array.
app.get('/api/cfo/manual-inputs', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('cfo_manual_inputs')
      .select('field_key, display_label, value, entered_at, notes')
      .order('field_key')
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    console.error('GET /api/cfo/manual-inputs error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/cfo/manual-inputs
// Body: { field_key, value, notes? }
// Upserts one row. If field_key exists, updates value + entered_at.
app.post('/api/cfo/manual-inputs', async (req, res) => {
  const { field_key, value, notes, display_label } = req.body
  if (!field_key || value == null) {
    return res.status(400).json({ error: 'field_key and value are required' })
  }
  try {
    const { data, error } = await supabase
      .from('cfo_manual_inputs')
      .upsert({
        field_key,
        display_label: display_label || deriveCfoLabel(field_key),
        value:         Number(value),
        entered_at:    new Date().toISOString(),
        notes:         notes || null,
      }, { onConflict: 'field_key' })
      .select()
    if (error) throw error
    res.json({ ok: true, data })
  } catch (err) {
    console.error('POST /api/cfo/manual-inputs error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/cfo/manual-inputs/bulk
// Body: { inputs: [{ field_key, value, display_label? }] }
// Upserts multiple rows at once — used by "Save All Updates" button.
app.post('/api/cfo/manual-inputs/bulk', async (req, res) => {
  const { inputs } = req.body
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return res.status(400).json({ error: 'inputs array is required and must not be empty' })
  }
  try {
    const now = new Date().toISOString()
    const rows = inputs.map(i => ({
      field_key:     i.field_key,
      display_label: i.display_label || deriveCfoLabel(i.field_key),
      value:         Number(i.value) || 0,
      entered_at:    now,
      notes:         i.notes || null,
    }))
    const { error } = await supabase
      .from('cfo_manual_inputs')
      .upsert(rows, { onConflict: 'field_key' })
    if (error) throw error
    res.json({ ok: true, saved: rows.length })
  } catch (err) {
    console.error('POST /api/cfo/manual-inputs/bulk error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// =============================================================================
// CFO DASHBOARD — Multi-Family Valuations
// =============================================================================

// GET /api/cfo/multifamily-valuations
// Returns all rows from cfo_multifamily_valuations.
app.get('/api/cfo/multifamily-valuations', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('cfo_multifamily_valuations')
      .select('id, property_name, ownership_pct, t12_noi, cap_rate, full_property_value, danyels_equity, entered_at, notes')
      .order('property_name')
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    console.error('GET /api/cfo/multifamily-valuations error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/cfo/multifamily-valuations/:id
// Body: { t12_noi, cap_rate, danyels_equity, notes? }
// Updates one multifamily property row by its UUID.
app.post('/api/cfo/multifamily-valuations/:id', async (req, res) => {
  const { id } = req.params
  const { t12_noi, cap_rate, danyels_equity, notes } = req.body
  if (t12_noi == null || cap_rate == null) {
    return res.status(400).json({ error: 't12_noi and cap_rate are required' })
  }
  try {
    const { data, error } = await supabase
      .from('cfo_multifamily_valuations')
      .update({
        t12_noi:       Number(t12_noi),
        cap_rate:      Number(cap_rate),
        danyels_equity: danyels_equity != null ? Number(danyels_equity) : null,
        entered_at:    new Date().toISOString(),
        notes:         notes || null,
      })
      .eq('id', id)
      .select()
    if (error) throw error
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Row not found' })
    }
    res.json({ ok: true, data: data[0] })
  } catch (err) {
    console.error(`POST /api/cfo/multifamily-valuations/${id} error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

// =============================================================================
// CFO DASHBOARD — Net Worth Snapshot
// =============================================================================

// GET /api/cfo/snapshot/current
// Calculates net worth on the fly from current manual inputs, multifamily
// valuations, and projection params. Does not write to cfo_snapshots.
app.get('/api/cfo/snapshot/current', async (_req, res) => {
  try {
    // Load all three data sources in parallel
    const [
      { data: manualInputs, error: miErr },
      { data: mfRows,       error: mfErr },
      { data: paramRows,    error: prErr },
    ] = await Promise.all([
      supabase.from('cfo_manual_inputs').select('field_key, value'),
      supabase.from('cfo_multifamily_valuations').select('danyels_equity, t12_noi, cap_rate'),
      supabase.from('cfo_projection_params').select('*').limit(1),
    ])

    if (miErr) throw miErr
    if (mfErr) throw mfErr
    if (prErr) throw prErr

    // Index manual inputs by field_key
    const byKey = {}
    for (const row of (manualInputs || [])) {
      byKey[row.field_key] = Number(row.value) || 0
    }

    // Sum manual inputs by category using field_key prefix conventions.
    // The HTML uses insurance_ prefix; older seed rows use life_insurance_ prefix.
    // We handle both so the snapshot is correct regardless of which was saved.
    let lifeInsuranceValue = 0
    let vehicleValue       = 0
    let totalMortgages     = 0
    for (const [key, val] of Object.entries(byKey)) {
      if (key.startsWith('insurance_') || key.startsWith('life_insurance_')) lifeInsuranceValue += val
      else if (key.startsWith('vehicle_')) vehicleValue += val
      else if (key.startsWith('mortgage_')) totalMortgages += val
    }

    // Sum multifamily equity (Danyel's share in each syndication)
    let multifamilyEquity = 0
    for (const row of (mfRows || [])) {
      multifamilyEquity += Number(row.danyels_equity) || 0
    }

    // Real estate bucket = multifamily equity until Zillow connects single-family
    const realEstateEquity = multifamilyEquity
    const realEstateSource = multifamilyEquity > 0 ? 'manual' : 'pending'

    // Total assets (cash, investments, business = 0 until APIs connect)
    const totalAssets      = realEstateEquity + lifeInsuranceValue + vehicleValue
    const totalLiabilities = totalMortgages
    const netWorth         = totalAssets - totalLiabilities

    // Projection formula — compound each asset class at its growth rate
    const retirementDate  = new Date('2041-09-27')
    const now             = new Date()
    const msPerYear       = 365.25 * 24 * 60 * 60 * 1000
    const yearsToRetire   = Math.max(0, (retirementDate - now) / msPerYear)

    function project(years) {
      return (
        lifeInsuranceValue * Math.pow(1.04, years) +
        vehicleValue       * Math.pow(0.92, years) +
        multifamilyEquity  * Math.pow(1.03, years)
      )
    }

    // Which buckets still need an API integration to be complete
    const missingFields = ['cash', 'investments', 'business']
    if (realEstateSource === 'pending') missingFields.unshift('real_estate')

    res.json({
      net_worth:            netWorth,
      total_assets:         totalAssets,
      total_liabilities:    totalLiabilities,
      passive_income_month: 0,  // pending AppFolio integration
      buckets: {
        real_estate:    { value: realEstateEquity, debt: 0, equity: realEstateEquity, source: realEstateSource },
        cash:           { value: 0, source: 'pending' },
        investments:    { value: 0, source: 'pending' },
        business:       { value: 0, source: 'pending' },
        life_insurance: { value: lifeInsuranceValue, source: lifeInsuranceValue > 0 ? 'manual' : 'pending' },
        vehicles:       { value: vehicleValue,       source: vehicleValue > 0       ? 'manual' : 'pending' },
        other:          { value: 0, source: 'manual' },
      },
      projections: {
        one_year:   project(1),
        five_year:  project(5),
        retirement: project(yearsToRetire),
      },
      last_pulled_at: null,  // will be set once Plaid/AppFolio connects
      is_complete:    false,
      missing_fields: missingFields,
    })

  } catch (err) {
    console.error('GET /api/cfo/snapshot/current error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// =============================================================================
// CFO DASHBOARD — AppFolio Integration
// =============================================================================

// GET /api/cfo/appfolio/status
// Returns whether AppFolio credentials are configured and the last sync time.
// Safe to call on every page load — never triggers an API call to AppFolio.
app.get('/api/cfo/appfolio/status', async (_req, res) => {
  try {
    const configured = appfolioConfigured()

    if (!configured) {
      return res.json({ configured: false, last_sync: null, bpm_value: null })
    }

    // Last sync = most recent pulled_at on the BPM asset line, across any snapshot.
    // We query without a snapshot filter so it works even if the current month
    // snapshot hasn't been created yet.
    const { data: lines, error } = await supabase
      .from('cfo_asset_lines')
      .select('value, pulled_at')
      .eq('bucket', 'business')
      .eq('line_name', 'Beyond Property Management')
      .eq('data_source', 'appfolio')
      .order('pulled_at', { ascending: false })
      .limit(1)

    if (error) throw error

    const lastLine = lines && lines.length > 0 ? lines[0] : null

    res.json({
      configured: true,
      last_sync:  lastLine ? lastLine.pulled_at : null,
      bpm_value:  lastLine ? Number(lastLine.value) : null,
    })
  } catch (err) {
    console.error('GET /api/cfo/appfolio/status error:', err.message)
    // Status errors are non-fatal — always return a usable shape.
    res.json({ configured: false, last_sync: null, bpm_value: null })
  }
})

// GET /api/cfo/appfolio/sync
// Fetches fresh data from AppFolio (or returns mock zeros if not configured),
// upserts the BPM business asset line, and updates the current-month snapshot.
app.get('/api/cfo/appfolio/sync', async (_req, res) => {
  try {
    // Fetch both data points in parallel — each handles its own errors gracefully.
    const [revenueResult, passiveResult] = await Promise.all([
      getBPMGrossRevenue().catch(err => {
        console.error('[AppFolio sync] getBPMGrossRevenue failed:', err.message)
        return { gross_revenue_trailing_12: 0, calculated_at: new Date().toISOString(), is_mock: true }
      }),
      getPropertyPassiveIncome().catch(err => {
        console.error('[AppFolio sync] getPropertyPassiveIncome failed:', err.message)
        return { monthly_totals: [], current_month_net: 0, is_mock: true }
      }),
    ])

    const bpmValue          = Number(revenueResult.gross_revenue_trailing_12) || 0
    const passiveThisMonth  = Number(passiveResult.current_month_net)          || 0
    const now               = new Date().toISOString()

    // ── Find or create the current-month snapshot ──────────────────────────────
    // cfo_asset_lines requires a snapshot_id FK, so we need a snapshot row.
    // Use the first of the current month as the snapshot_date.
    const today         = new Date()
    const snapshotDate  = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`

    let snapshotId

    const { data: existingSnap, error: snapSelectErr } = await supabase
      .from('cfo_snapshots')
      .select('id')
      .eq('snapshot_date', snapshotDate)
      .limit(1)

    if (snapSelectErr) throw snapSelectErr

    if (existingSnap && existingSnap.length > 0) {
      snapshotId = existingSnap[0].id
    } else {
      // Create a minimal snapshot so the asset line has somewhere to live.
      const { data: newSnap, error: snapInsertErr } = await supabase
        .from('cfo_snapshots')
        .insert({ snapshot_date: snapshotDate, passive_income_month: passiveThisMonth })
        .select('id')
      if (snapInsertErr) throw snapInsertErr
      snapshotId = newSnap[0].id
    }

    // ── Upsert the BPM business asset line ────────────────────────────────────
    // cfo_asset_lines has no unique constraint on (snapshot_id, bucket, line_name),
    // so we do a manual select-then-update-or-insert.
    const { data: existingLine, error: lineSelectErr } = await supabase
      .from('cfo_asset_lines')
      .select('id')
      .eq('snapshot_id', snapshotId)
      .eq('bucket', 'business')
      .eq('line_name', 'Beyond Property Management')
      .limit(1)

    if (lineSelectErr) throw lineSelectErr

    if (existingLine && existingLine.length > 0) {
      const { error: updateErr } = await supabase
        .from('cfo_asset_lines')
        .update({ value: bpmValue, data_source: 'appfolio', pulled_at: now })
        .eq('id', existingLine[0].id)
      if (updateErr) throw updateErr
    } else {
      const { error: insertErr } = await supabase
        .from('cfo_asset_lines')
        .insert({
          snapshot_id: snapshotId,
          bucket:      'business',
          line_name:   'Beyond Property Management',
          value:       bpmValue,
          debt:        0,
          data_source: 'appfolio',
          pulled_at:   now,
        })
      if (insertErr) throw insertErr
    }

    // ── Update the snapshot's passive_income_month ────────────────────────────
    if (passiveThisMonth > 0) {
      await supabase
        .from('cfo_snapshots')
        .update({ passive_income_month: passiveThisMonth })
        .eq('id', snapshotId)
      // Non-fatal if this update fails — log and continue.
    }

    res.json({
      ok:                   true,
      bpm_value:            bpmValue,
      passive_income_month: passiveThisMonth,
      last_12_months:       passiveResult.monthly_totals || [],
      is_mock:              !!(revenueResult.is_mock || passiveResult.is_mock),
      synced_at:            now,
    })

  } catch (err) {
    console.error('GET /api/cfo/appfolio/sync error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// =============================================================================
// CFO DASHBOARD — Plaid Bank Integration
// =============================================================================

// GET /api/cfo/plaid/status
// Returns whether Plaid is configured, how many accounts are linked, and when
// they were last synced. Safe to call on every page load — no Plaid API call.
app.get('/api/cfo/plaid/status', async (_req, res) => {
  try {
    const configured = plaidConfigured()
    if (!configured) {
      return res.json({ configured: false, linked_accounts: 0, last_sync: null })
    }

    const { data: items, error } = await supabase
      .from('cfo_plaid_items')
      .select('last_synced_at')
      .eq('is_active', true)

    if (error) throw error

    const linkedAccounts = (items || []).length

    // Most recent sync time across all items.
    const lastSync = (items || [])
      .map(i => i.last_synced_at)
      .filter(Boolean)
      .sort()
      .pop() || null

    res.json({ configured: true, linked_accounts: linkedAccounts, last_sync: lastSync })
  } catch (err) {
    console.error('GET /api/cfo/plaid/status error:', err.message)
    res.json({ configured: false, linked_accounts: 0, last_sync: null })
  }
})

// POST /api/cfo/plaid/link-token
// Creates a short-lived Plaid Link token. The browser uses this to open the
// Plaid Link modal. The token expires in 30 minutes — never stored server-side.
app.post('/api/cfo/plaid/link-token', async (_req, res) => {
  try {
    if (!plaidConfigured()) {
      return res.status(503).json({ error: 'Plaid not configured — add PLAID_CLIENT_ID and PLAID_SECRET to .env' })
    }
    const link_token = await createLinkToken()
    res.json({ link_token })
  } catch (err) {
    console.error('POST /api/cfo/plaid/link-token error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/cfo/plaid/exchange-token
// Body: { public_token: string, institution_name: string }
// Exchanges a one-time public_token from Plaid Link for a permanent access_token.
// Stores the access_token in cfo_plaid_items (server-side only — never returned here).
app.post('/api/cfo/plaid/exchange-token', async (req, res) => {
  const { public_token, institution_name } = req.body
  if (!public_token) {
    return res.status(400).json({ error: 'public_token is required' })
  }
  try {
    const { access_token, item_id } = await exchangePublicToken(public_token)

    const { error } = await supabase
      .from('cfo_plaid_items')
      .insert({
        institution_name: institution_name || 'Unknown Bank',
        access_token,
        item_id,
        linked_at: new Date().toISOString(),
      })

    if (error) throw error

    console.log(`[Plaid] Linked new institution: ${institution_name || 'Unknown Bank'} (item ${item_id})`)
    res.json({ success: true, institution_name: institution_name || 'Unknown Bank' })
  } catch (err) {
    console.error('POST /api/cfo/plaid/exchange-token error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/cfo/plaid/sync
// Fetches live balances and transactions from all linked Plaid accounts.
// Upserts accounts into cfo_asset_lines (cash/investments) or cfo_liability_lines (credit).
// Runs detectRecurringCharges and upserts new findings into cfo_recurring_charges.
// Returns a summary of what was synced.
app.get('/api/cfo/plaid/sync', async (_req, res) => {
  try {
    if (!plaidConfigured()) {
      return res.status(503).json({ error: 'Plaid not configured' })
    }

    // Fetch accounts and transactions in parallel.
    const [accounts, transactions] = await Promise.all([
      syncAllAccounts(),
      syncTransactions(90),
    ])

    if (accounts.length === 0) {
      return res.json({ accounts_synced: 0, cash_total: 0, credit_total: 0, recurring_charges_found: 0 })
    }

    // ── Find or create the current-month snapshot ─────────────────────────────
    // Asset/liability lines require a snapshot_id FK — same pattern as AppFolio sync.
    const today        = new Date()
    const snapshotDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`
    const now          = new Date().toISOString()

    let snapshotId

    const { data: existingSnap, error: snapSelectErr } = await supabase
      .from('cfo_snapshots')
      .select('id')
      .eq('snapshot_date', snapshotDate)
      .limit(1)

    if (snapSelectErr) throw snapSelectErr

    if (existingSnap && existingSnap.length > 0) {
      snapshotId = existingSnap[0].id
    } else {
      const { data: newSnap, error: snapInsertErr } = await supabase
        .from('cfo_snapshots')
        .insert({ snapshot_date: snapshotDate })
        .select('id')
      if (snapInsertErr) throw snapInsertErr
      snapshotId = newSnap[0].id
    }

    // ── Upsert asset lines and credit lines ───────────────────────────────────
    let cashTotal   = 0
    let creditTotal = 0

    for (const account of accounts) {
      const lineName = `${account.institution_name} — ${account.account_name}`
      const balance  = Number(account.balance_current) || 0

      if (account.account_type === 'credit') {
        // Credit cards → liability lines
        creditTotal += balance

        const { data: existing, error: selErr } = await supabase
          .from('cfo_liability_lines')
          .select('id')
          .eq('snapshot_id', snapshotId)
          .eq('external_id', account.account_id)
          .limit(1)

        if (selErr) throw selErr

        if (existing && existing.length > 0) {
          await supabase
            .from('cfo_liability_lines')
            .update({ balance, data_source: 'plaid' })
            .eq('id', existing[0].id)
        } else {
          await supabase
            .from('cfo_liability_lines')
            .insert({
              snapshot_id:    snapshotId,
              liability_type: 'credit_card',
              line_name:      lineName,
              balance,
              data_source:    'plaid',
              external_id:    account.account_id,
            })
        }

      } else {
        // Depository/savings → cash; investment → investments; others → cash
        const bucket = account.account_type === 'investment' ? 'investments' : 'cash'
        if (bucket === 'cash') cashTotal += balance

        const { data: existing, error: selErr } = await supabase
          .from('cfo_asset_lines')
          .select('id')
          .eq('snapshot_id', snapshotId)
          .eq('external_id', account.account_id)
          .limit(1)

        if (selErr) throw selErr

        if (existing && existing.length > 0) {
          await supabase
            .from('cfo_asset_lines')
            .update({ value: balance, data_source: 'plaid', pulled_at: now })
            .eq('id', existing[0].id)
        } else {
          await supabase
            .from('cfo_asset_lines')
            .insert({
              snapshot_id: snapshotId,
              bucket,
              line_name:   lineName,
              value:       balance,
              debt:        0,
              data_source: 'plaid',
              external_id: account.account_id,
              pulled_at:   now,
            })
        }
      }
    }

    // ── Detect and store recurring charges ────────────────────────────────────
    const recurring = detectRecurringCharges(transactions)
    let newChargesFound = 0

    for (const charge of recurring) {
      // Only insert if this merchant isn't already tracked.
      const { data: existing, error: rcSelErr } = await supabase
        .from('cfo_recurring_charges')
        .select('id')
        .ilike('merchant_name', charge.merchant_name)
        .limit(1)

      if (rcSelErr) throw rcSelErr

      if (!existing || existing.length === 0) {
        await supabase
          .from('cfo_recurring_charges')
          .insert({
            merchant_name:      charge.merchant_name,
            amount:             charge.amount,
            frequency:          charge.frequency,
            last_charged_date:  charge.last_charged_date,
            first_detected_date: today.toISOString().split('T')[0],
            status:             'unreviewed',
          })
        newChargesFound++
      } else {
        // Update last_charged_date if we have a more recent one.
        await supabase
          .from('cfo_recurring_charges')
          .update({ last_charged_date: charge.last_charged_date })
          .eq('id', existing[0].id)
          .lt('last_charged_date', charge.last_charged_date)
      }
    }

    res.json({
      accounts_synced:        accounts.length,
      cash_total:             cashTotal,
      credit_total:           creditTotal,
      recurring_charges_found: newChargesFound,
    })

  } catch (err) {
    console.error('GET /api/cfo/plaid/sync error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// =============================================================================
// POST /api/compose
// Body: { to: string, subject: string, body: string }
//
// Sends a brand-new email FROM danyel@bpmsd.com using the Gmail service account.
// =============================================================================

app.post('/api/compose', async (req, res) => {
  const { to, subject, body } = req.body

  if (!to?.trim() || !subject?.trim() || !body?.trim()) {
    return res.status(400).json({ error: 'to, subject, and body are all required' })
  }

  const FROM_INBOX = 'danyel@bpmsd.com'

  try {
    const gmail = await getGmailClientForInbox(FROM_INBOX)

    const rawLines = [
      `From: ${FROM_INBOX}`,
      `To: ${to.trim()}`,
      `Subject: ${subject.trim()}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body.trim()
    ]

    const encodedRaw = Buffer.from(rawLines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedRaw }
    })

    res.json({ ok: true })
  } catch (err) {
    console.error('Compose error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// =============================================================================
// INSURANCE BOARD
// =============================================================================

// Standard invoice line items inserted on every new project.
const STANDARD_INVOICE_ITEMS = [
  { line_item: 'Asbestos',                           is_bpm_fee: false, sort_order: 1  },
  { line_item: 'Asbestos Project Management Fee',    is_bpm_fee: true,  sort_order: 2  },
  { line_item: 'Remediation',                        is_bpm_fee: false, sort_order: 3  },
  { line_item: 'Remediation Project Management Fee', is_bpm_fee: true,  sort_order: 4  },
  { line_item: 'Restoration',                        is_bpm_fee: false, sort_order: 5  },
  { line_item: 'Restoration Project Management Fee', is_bpm_fee: true,  sort_order: 6  },
  { line_item: 'Repairs',                            is_bpm_fee: false, sort_order: 7  },
  { line_item: 'Repairs Project Management Fee',     is_bpm_fee: true,  sort_order: 8  },
  { line_item: 'Plumbing',                           is_bpm_fee: false, sort_order: 9  },
  { line_item: 'Plumbing Project Management Fee',    is_bpm_fee: true,  sort_order: 10 },
  { line_item: 'Cleaning',                           is_bpm_fee: false, sort_order: 11 },
  { line_item: 'Cleaning Project Management Fee',    is_bpm_fee: true,  sort_order: 12 },
  { line_item: 'Other',                              is_bpm_fee: false, sort_order: 13 },
  { line_item: 'Other Project Management Fee',       is_bpm_fee: true,  sort_order: 14 },
  { line_item: 'Tenant Credit',                      is_bpm_fee: false, sort_order: 15 },
]

const TERMITE_EXTRA_ITEMS = [
  { line_item: 'Gardener',                           is_bpm_fee: false, sort_order: 16 },
  { line_item: 'Gardener Project Management Fee',    is_bpm_fee: true,  sort_order: 17 },
]

// GET /api/insurance/projects
// Returns all projects sorted red → yellow → green, then date_opened DESC.
// Adds computed fields: days_open, is_911.
app.get('/api/insurance/projects', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('id, property_address, project_type, status, date_opened, scheduled_close_date, actual_close_date, current_stage, blocking_item, created_at, updated_at')

    if (error) throw error

    const today      = new Date()
    const msPerDay   = 1000 * 60 * 60 * 24
    const statusRank = { red: 0, yellow: 1, green: 2 }

    const projects = (data || [])
      .map(p => ({
        ...p,
        days_open: Math.max(0, Math.floor((today - new Date(p.date_opened)) / msPerDay)),
        is_911:    p.status === 'red',
      }))
      .sort((a, b) => {
        const rankA = statusRank[a.status] ?? 3
        const rankB = statusRank[b.status] ?? 3
        if (rankA !== rankB) return rankA - rankB
        return new Date(b.date_opened) - new Date(a.date_opened)
      })

    res.json(projects)
  } catch (err) {
    console.error('GET /api/insurance/projects error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/insurance/projects
// Creates a project, a checklist row, and the standard invoice line items.
// Required: property_address, project_type
// Optional: scheduled_close_date, current_stage, appfolio_property_id
app.post('/api/insurance/projects', async (req, res) => {
  const { property_address, project_type, scheduled_close_date, current_stage, appfolio_property_id } = req.body

  if (!property_address?.trim()) {
    return res.status(400).json({ error: 'property_address is required' })
  }

  const VALID_TYPES = ['Insurance Claim', 'CapEx', 'Termite', 'Other']
  if (!VALID_TYPES.includes(project_type)) {
    return res.status(400).json({ error: `project_type must be one of: ${VALID_TYPES.join(', ')}` })
  }

  try {
    // 1. Create the project row
    const { data: project, error: projectErr } = await supabase
      .from('projects')
      .insert({
        property_address:     property_address.trim(),
        project_type,
        scheduled_close_date: scheduled_close_date || null,
        current_stage:        current_stage?.trim()        || null,
        appfolio_property_id: appfolio_property_id?.trim() || null,
        created_by:           req.user.id,
      })
      .select()
      .single()

    if (projectErr) throw projectErr

    // 2. Insert the checklist row (all defaults)
    const { error: checklistErr } = await supabase
      .from('project_checklist')
      .insert({ project_id: project.id })

    if (checklistErr) throw checklistErr

    // 3. Build and insert the standard invoice line items
    const invoiceRows = [
      ...STANDARD_INVOICE_ITEMS,
      ...(project_type === 'Termite' ? TERMITE_EXTRA_ITEMS : []),
    ].map(item => ({ ...item, project_id: project.id }))

    const { error: invoiceErr } = await supabase
      .from('project_invoices')
      .insert(invoiceRows)

    if (invoiceErr) throw invoiceErr

    res.status(201).json(project)
  } catch (err) {
    console.error('POST /api/insurance/projects error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/insurance/projects/:id
// Updates allowed fields on a project. Returns the updated project row.
app.patch('/api/insurance/projects/:id', async (req, res) => {
  const { id } = req.params

  const ALLOWED = [
    'property_address', 'project_type', 'status', 'scheduled_close_date',
    'actual_close_date', 'current_stage', 'blocking_item', 'message_to_owner',
    'close_appfolio_complete', 'close_insurance_paid', 'close_owner_email_sent',
  ]

  const updates = {}
  for (const field of ALLOWED) {
    if (req.body[field] !== undefined) updates[field] = req.body[field]
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' })
  }

  try {
    const { data, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Project not found' })

    res.json(data)
  } catch (err) {
    console.error(`PATCH /api/insurance/projects/${id} error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'BPM Email API' }))

// =============================================================================
// START
// =============================================================================

const PORT = process.env.PORT || process.env.API_PORT || 3005
app.listen(PORT, () => {
  console.log(`BPM Email API running on http://localhost:${PORT}`)
  console.log('Endpoints: POST /api/reply  |  POST /api/forward')
})
