/**
 * cfo-dashboard.js — Personal CFO Dashboard data layer
 *
 * Runs after the HTML is parsed (loaded with `defer`). Fetches data from the
 * API server at localhost:3005, populates the dashboard, and wires the save button.
 *
 * Does NOT handle auth — auth is done in the page's inline module script.
 * This file just populates/reads DOM elements and calls the API.
 */

;(function () {

  const API = window.location.hostname === 'localhost'
    ? 'http://localhost:3005'
    : 'https://bpm-api.onrender.com'

  // ── Human-readable labels for each form field.
  // Sent to the API as display_label when upserting new rows.
  // Keys match the data-field attributes on the HTML inputs.
  const FIELD_LABELS = {
    mortgage_robertson:           '110 W Robertson, Ridgecrest',
    mortgage_lincoln:             '7987-89 Lincoln, Lemon Grove',
    mortgage_weslaco:             'Weslaco TX (Unilaco) — your share',
    mortgage_mcallen32:           'McAllen 32-unit, McNorth — your share',
    mortgage_mcallen35:           'McAllen 35-unit, McDove — your share',
    mortgage_cherryhill:          'Cherry Hill 105-unit — your share',
    insurance_transamerica_main:  'Transamerica Main Policy (cash value)',
    insurance_transamerica_mason: 'Transamerica Mason Policy (cash value)',
    insurance_prudential:         'Prudential (cash value)',
    vehicle_sprinter_2025:        'Mercedes Sprinter AWD 2025 (KBB)',
    vehicle_santafe_2017:         'Santa Fe Hyundai 2017 (KBB)',
    vehicle_priusc_2012:          'Toyota Prius C 2012 (KBB)',
  }

  // ── Maps each HTML multifamily row key to its matching DB row.
  // Matching is by substring of property_name (case-insensitive).
  const MF_ROW_MAP = [
    { htmlKey: 'weslaco',    dbMatch: n => n.toLowerCase().includes('weslaco')   },
    { htmlKey: 'mcallen32',  dbMatch: n => n.toLowerCase().includes('mcallen') || n.toLowerCase().includes('mc allen') },
    { htmlKey: 'mcallen35',  dbMatch: n => n.toLowerCase().includes('dove')      },
    { htmlKey: 'cherryhill', dbMatch: n => n.toLowerCase().includes('cherry')    },
  ]

  // Loaded multifamily DB rows keyed by htmlKey — populated on load, read on save.
  const mfRowsLoaded = {}

  // Last 12 months of AppFolio owner distributions — stored for use by the
  // Step 9 passive income bar chart when it is built.
  let passiveIncomeHistory = []

  // Last-loaded Plaid status — used by the cash bucket detail panel renderer.
  let plaidStatus = null

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // Formats a number as US dollars: $1,234,567
  // Returns '—' for null/undefined/NaN.
  function formatDollars(n) {
    if (n == null || isNaN(Number(n))) return '—'
    const num = Math.round(Math.abs(Number(n)))
    return (Number(n) < 0 ? '-' : '') + '$' + num.toLocaleString('en-US')
  }

  // Strips $, commas, and % from a string and returns the number.
  function parseNum(str) {
    if (!str) return 0
    return parseFloat(String(str).replace(/[$,%]/g, '').replace(/,/g, '')) || 0
  }

  // Sets textContent of an element by ID. No-ops if element doesn't exist.
  function setText(id, val) {
    const el = document.getElementById(id)
    if (el) el.textContent = val
  }

  // ── Load: manual inputs ───────────────────────────────────────────────────────
  // Fetches all saved values and pre-fills the monthly entry panel inputs.

  async function loadManualInputs() {
    try {
      const res = await fetch(`${API}/api/cfo/manual-inputs`)
      if (!res.ok) return

      const inputs = await res.json()

      // Build a lookup: field_key → numeric value
      const byKey = {}
      for (const row of inputs) {
        byKey[row.field_key] = Number(row.value)
      }

      // Pre-fill every input that has a data-field attribute
      document.querySelectorAll('[data-field]').forEach(input => {
        const key = input.getAttribute('data-field')
        const val = byKey[key]
        if (val != null && val !== 0 && !isNaN(val)) {
          // Skip multifamily NOI/cap fields — those are handled by loadMultifamilyValuations
          if (key.startsWith('mf_')) return
          input.value = '$' + Math.round(val).toLocaleString('en-US')
        }
      })

    } catch (err) {
      console.error('CFO: loadManualInputs failed:', err)
    }
  }

  // ── Load: multifamily valuations ──────────────────────────────────────────────
  // Fetches DB rows, stores them for later saving, pre-fills the MF table inputs.

  async function loadMultifamilyValuations() {
    try {
      const res = await fetch(`${API}/api/cfo/multifamily-valuations`)
      if (!res.ok) return

      const rows = await res.json()

      for (const entry of MF_ROW_MAP) {
        const dbRow = rows.find(r => entry.dbMatch(r.property_name))
        if (!dbRow) continue

        // Store so we can use the ID when saving
        mfRowsLoaded[entry.htmlKey] = dbRow

        const noiEl = document.getElementById(`entry-mf-noi-${entry.htmlKey}`)
        const capEl = document.getElementById(`entry-mf-cap-${entry.htmlKey}`)

        if (noiEl && dbRow.t12_noi && Number(dbRow.t12_noi) !== 0) {
          noiEl.value = '$' + Math.round(Number(dbRow.t12_noi)).toLocaleString('en-US')
        }
        if (capEl && dbRow.cap_rate && Number(dbRow.cap_rate) !== 0) {
          // DB stores decimal (0.065); display as percent (6.5%)
          capEl.value = (Number(dbRow.cap_rate) * 100).toFixed(1) + '%'
        }

        // Fire the input event so the HTML's live cap-rate calculator runs
        // and populates the readonly "Est. Value" column
        if (noiEl) noiEl.dispatchEvent(new Event('input', { bubbles: true }))
      }

    } catch (err) {
      console.error('CFO: loadMultifamilyValuations failed:', err)
    }
  }

  // ── Load: net worth snapshot ──────────────────────────────────────────────────
  // Fetches the calculated snapshot and populates the hero, buckets, and projections.

  async function loadSnapshot() {
    try {
      const res = await fetch(`${API}/api/cfo/snapshot/current`)
      if (!res.ok) return

      const snap = await res.json()

      // ── Hero numbers
      setText('net-worth-total',   formatDollars(snap.net_worth))
      setText('total-assets',      formatDollars(snap.total_assets))
      setText('total-liabilities', formatDollars(snap.total_liabilities))

      // "as of Month Year"
      const now      = new Date()
      const monthStr = now.toLocaleString('en-US', { month: 'long', year: 'numeric' })
      setText('net-worth-month', `as of ${monthStr}`)

      // ── Liabilities total in the collapsible header
      setText('liabilities-total-summary', `Total: ${formatDollars(snap.total_liabilities)}`)

      // ── Populate mortgage balance cells from manual inputs for the liabilities table
      // (The liabilities section shows the saved values as a read-only summary)
      populateLiabilitiesTable()

      // ── Asset buckets
      const buckets = snap.buckets || {}
      for (const [key, data] of Object.entries(buckets)) {
        const equityEl = document.getElementById(`bucket-equity-${key}`)
        const valueEl  = document.getElementById(`bucket-value-${key}`)

        if (equityEl) {
          if (data.source === 'pending') {
            equityEl.textContent = '—'
          } else {
            equityEl.textContent = formatDollars(data.equity ?? data.value ?? 0)
          }
        }

        if (valueEl) {
          if (data.source === 'pending') {
            valueEl.textContent = 'Connecting...'
          } else {
            const equity = data.equity ?? data.value ?? 0
            valueEl.textContent = `Value: ${formatDollars(equity)}`
          }
        }
      }

      // ── Projections
      const proj = snap.projections || {}
      setText('projection-1yr',        formatDollars(proj.one_year))
      setText('projection-5yr',        formatDollars(proj.five_year))
      setText('projection-retirement', formatDollars(proj.retirement))

      // ── Passive income tiles
      setText('passive-income-total', formatDollars(snap.passive_income_month))
      setText('passive-rental-net',   '—')
      setText('passive-dividends',    '—')

      // ── Status bar
      if (snap.last_pulled_at) {
        const d = new Date(snap.last_pulled_at)
        setText('cfoStatusPulled', `Data last pulled: ${d.toLocaleDateString('en-US')}`)
      }

      // ── Attention banner: show if there are pending (unconnected) buckets
      const missing = snap.missing_fields || []
      if (missing.length > 0) {
        const banner = document.getElementById('cfoAttentionBanner')
        const msg    = document.getElementById('cfoAttentionMsg')
        if (banner && msg) {
          msg.textContent = `${missing.length} data source${missing.length === 1 ? '' : 's'} not yet connected — net worth is partial`
          banner.classList.add('visible')
        }
      }

    } catch (err) {
      console.error('CFO: loadSnapshot failed:', err)
    }
  }

  // Reads saved mortgage values from the form inputs and writes them into
  // the read-only liabilities table in Section 5.
  function populateLiabilitiesTable() {
    const MORTGAGE_CELLS = [
      { inputId: 'entry-mortgage-robertson', cellId: 'mortgage-robertson-balance' },
      { inputId: 'entry-mortgage-lincoln',   cellId: 'mortgage-lincoln-balance'   },
      { inputId: 'entry-mortgage-weslaco',   cellId: 'mortgage-weslaco-balance'   },
      { inputId: 'entry-mortgage-mcallen32', cellId: 'mortgage-mcallen32-balance' },
      { inputId: 'entry-mortgage-mcallen35', cellId: 'mortgage-mcallen35-balance' },
      { inputId: 'entry-mortgage-cherryhill',cellId: 'mortgage-cherryhill-balance'},
    ]
    for (const { inputId, cellId } of MORTGAGE_CELLS) {
      const inputEl = document.getElementById(inputId)
      const cellEl  = document.getElementById(cellId)
      if (!inputEl || !cellEl) continue
      const val = parseNum(inputEl.value)
      cellEl.textContent = val > 0 ? formatDollars(val) : '—'
    }
  }

  // ── Load: Plaid status ───────────────────────────────────────────────────────
  // Checks whether Plaid is configured and how many accounts are linked.
  // Updates the Cash bucket card subtitle so Danyel can see at a glance whether
  // his bank is connected. Never blocks page load — errors are swallowed silently.

  async function loadPlaidStatus() {
    try {
      const res = await fetch(`${API}/api/cfo/plaid/status`)
      if (!res.ok) return

      plaidStatus = await res.json()

      if (plaidStatus.linked_accounts > 0) {
        // Show account count in the Cash bucket card subtitle.
        const valueEl = document.getElementById('bucket-value-cash')
        if (valueEl) {
          const n   = plaidStatus.linked_accounts
          valueEl.textContent = `${n} account${n > 1 ? 's' : ''} linked`
        }
      }
    } catch (err) {
      console.debug('CFO: loadPlaidStatus failed (non-fatal):', err.message)
    }
  }

  // ── Plaid Link flow ───────────────────────────────────────────────────────────
  // Opens the Plaid Link modal. On success, exchanges the public_token for an
  // access_token, triggers a sync, and refreshes the dashboard numbers.

  async function initPlaidLink() {
    const btn = document.getElementById('plaid-link-btn')
    if (btn) { btn.disabled = true; btn.textContent = 'Opening...' }

    try {
      // Step 1: fetch a short-lived link token from the server.
      const tokenRes = await fetch(`${API}/api/cfo/plaid/link-token`, { method: 'POST' })
      if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({}))
        throw new Error(err.error || 'Could not get link token')
      }
      const { link_token } = await tokenRes.json()

      // Step 2: open the Plaid Link modal using the token.
      // Plaid.create is injected by the Plaid CDN script in <head>.
      const handler = Plaid.create({
        token: link_token,

        onSuccess: async (public_token, metadata) => {
          const institution_name = metadata.institution?.name || 'Unknown Bank'

          try {
            // Step 3: exchange public_token for a permanent access_token (server stores it).
            const exchRes = await fetch(`${API}/api/cfo/plaid/exchange-token`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ public_token, institution_name }),
            })
            if (!exchRes.ok) throw new Error('Token exchange failed')

            // Step 4: sync accounts and transactions right away.
            await fetch(`${API}/api/cfo/plaid/sync`)

            // Step 5: refresh the dashboard so hero numbers and Cash bucket reflect live data.
            await loadPlaidStatus()
            await loadSnapshot()

            // Re-render the cash bucket detail panel if it's still open.
            const panel = document.getElementById('bucket-detail-panel')
            if (panel && panel.getAttribute('data-active-bucket') === 'cash') {
              renderCashBucketDetail()
            }
          } catch (err) {
            console.error('CFO: Plaid exchange/sync failed:', err.message)
            if (btn) { btn.disabled = false; btn.textContent = 'Connect Bank Accounts' }
          }
        },

        onExit: (err, metadata) => {
          // User closed the modal or Plaid returned an error.
          console.log('CFO: Plaid Link exited', err?.error_message || '', metadata?.status || '')
          if (btn) { btn.disabled = false; btn.textContent = 'Connect Bank Accounts' }
        },
      })

      handler.open()

    } catch (err) {
      console.error('CFO: initPlaidLink failed:', err.message)
      if (btn) { btn.disabled = false; btn.textContent = 'Connect Bank Accounts' }
    }
  }

  // ── Cash bucket detail panel ──────────────────────────────────────────────────
  // Renders the expandable detail panel content when Danyel clicks the Cash card.
  // Shows linked account count + last sync time, plus the Connect/Add button.

  function renderCashBucketDetail() {
    const content = document.getElementById('bucket-detail-content')
    if (!content) return

    const linked   = plaidStatus ? plaidStatus.linked_accounts : 0
    const lastSync = plaidStatus && plaidStatus.last_sync
      ? new Date(plaidStatus.last_sync).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : null

    let statusHtml
    if (linked > 0) {
      statusHtml = `<p style="margin:0 0 14px;font-size:0.875rem;color:var(--color-text-muted);">
        ${linked} bank account${linked > 1 ? 's' : ''} connected${lastSync ? ` &middot; Last synced ${lastSync}` : ''}.
        You can add another institution below.
      </p>`
    } else {
      statusHtml = `<p style="margin:0 0 14px;font-size:0.875rem;color:var(--color-text-muted);">
        No bank accounts connected yet. Link your checking and savings accounts to see live cash balances here.
      </p>`
    }

    content.innerHTML = `
      ${statusHtml}
      <button id="plaid-link-btn"
        style="background:var(--color-primary);color:#fff;border:none;border-radius:6px;
               padding:9px 18px;font-size:0.875rem;font-weight:600;cursor:pointer;
               transition:opacity .15s;">
        Connect Bank Accounts
      </button>
    `

    // Wire the button each time the panel is rendered (innerHTML replaces the old node).
    document.getElementById('plaid-link-btn').addEventListener('click', initPlaidLink)
  }

  // ── Load: AppFolio status ─────────────────────────────────────────────────────
  // Checks whether AppFolio credentials are configured and the last sync time.
  // If a BPM value is already stored from a previous sync, populates the Business
  // bucket card so it shows a real number instead of "—".
  // Never blocks page load — errors are swallowed silently.

  async function loadAppfolioStatus() {
    try {
      const res = await fetch(`${API}/api/cfo/appfolio/status`)
      if (!res.ok) return

      const status = await res.json()

      if (status.configured && status.bpm_value != null && status.bpm_value > 0) {
        // Populate the Business bucket card with the last synced BPM value.
        const equityEl = document.getElementById('bucket-equity-business')
        const valueEl  = document.getElementById('bucket-value-business')
        if (equityEl) equityEl.textContent = formatDollars(status.bpm_value)
        if (valueEl)  valueEl.textContent  = `Value: ${formatDollars(status.bpm_value)}`
      }

      // If AppFolio is configured and we have never synced (or it's been a while),
      // trigger a background sync so data stays fresh without blocking the page.
      if (status.configured && !status.last_sync) {
        triggerAppfolioSync()
      }
    } catch (err) {
      // Non-fatal — dashboard works without AppFolio.
      console.debug('CFO: loadAppfolioStatus failed (non-fatal):', err.message)
    }
  }

  // Fires a background GET to /api/cfo/appfolio/sync and updates the Business
  // bucket card when the response arrives. Does not block the caller.
  function triggerAppfolioSync() {
    fetch(`${API}/api/cfo/appfolio/sync`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return

        // Store the 12-month history for the Step 9 passive income chart.
        if (Array.isArray(data.last_12_months)) {
          passiveIncomeHistory = data.last_12_months
        }

        // Update the Business bucket card if we got a real value.
        if (data.bpm_value != null && data.bpm_value > 0) {
          const equityEl = document.getElementById('bucket-equity-business')
          const valueEl  = document.getElementById('bucket-value-business')
          if (equityEl) equityEl.textContent = formatDollars(data.bpm_value)
          if (valueEl)  valueEl.textContent  = `Value: ${formatDollars(data.bpm_value)}`
        }

        // Update passive income tile if AppFolio returned a non-zero value.
        if (data.passive_income_month > 0) {
          setText('passive-income-total', formatDollars(data.passive_income_month))
          setText('passive-rental-net',   formatDollars(data.passive_income_month))
        }
      })
      .catch(err => {
        console.debug('CFO: triggerAppfolioSync failed (non-fatal):', err.message)
      })
  }

  // ── Save All ──────────────────────────────────────────────────────────────────
  // Called when the HTML dispatches the 'cfo-save-all' custom event.
  // 1. Bulk-saves all manual entry panel inputs.
  // 2. Updates each multifamily row in the DB.
  // 3. Refreshes the snapshot display.

  async function saveAll() {
    const btn = document.getElementById('cfoSaveAllBtn')

    try {
      // ── 1. Collect all [data-field] inputs from the monthly entry panel,
      //       excluding the multifamily NOI/cap/val fields (those go separately).
      const panel = document.getElementById('monthlyEntryBody')
      const inputs = []

      if (panel) {
        panel.querySelectorAll('[data-field]').forEach(el => {
          const key = el.getAttribute('data-field')
          if (!key || key.startsWith('mf_')) return  // skip MF fields
          const val = parseNum(el.value)
          inputs.push({
            field_key:     key,
            display_label: FIELD_LABELS[key] || key.replace(/_/g, ' '),
            value:         val,
          })
        })
      }

      if (inputs.length > 0) {
        const bulkRes = await fetch(`${API}/api/cfo/manual-inputs/bulk`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ inputs }),
        })
        if (!bulkRes.ok) {
          const err = await bulkRes.json().catch(() => ({}))
          throw new Error(err.error || 'Bulk save failed')
        }
      }

      // ── 2. Save multifamily valuations — one POST per row that has a loaded ID.
      const mfSavePromises = []

      for (const entry of MF_ROW_MAP) {
        const dbRow = mfRowsLoaded[entry.htmlKey]
        if (!dbRow) continue  // no matching DB row loaded — skip

        const noiEl = document.getElementById(`entry-mf-noi-${entry.htmlKey}`)
        const capEl = document.getElementById(`entry-mf-cap-${entry.htmlKey}`)
        const valEl = document.getElementById(`entry-mf-val-${entry.htmlKey}`)
        if (!noiEl || !capEl) continue

        const t12_noi       = parseNum(noiEl.value)
        // Convert percentage string to decimal: "6.5%" → 0.065
        const cap_rate      = parseNum(capEl.value) / 100
        // The HTML live-calculator already computed Danyel's share into the readonly field
        const danyels_equity = parseNum(valEl ? valEl.value : '0')

        mfSavePromises.push(
          fetch(`${API}/api/cfo/multifamily-valuations/${dbRow.id}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ t12_noi, cap_rate, danyels_equity }),
          })
        )
      }

      await Promise.all(mfSavePromises)

      // ── 3. Refresh snapshot so the hero/buckets/projections reflect the new values.
      await loadSnapshot()

      // ── 4. Success feedback.
      // The HTML's click handler set text="Saving..." and will reset text+disabled after 3s.
      // We override text and background here, and clear the background after 2s so it
      // doesn't linger when the HTML's 3s fallback puts the button back to normal.
      if (btn) {
        btn.textContent      = 'Saved!'
        btn.style.background = '#22c55e'
        setTimeout(() => { btn.style.background = '' }, 2000)
      }

      // ── 5. Refresh AppFolio data in the background after save.
      // Non-blocking — runs after the UI is already showing "Saved!" so the user
      // doesn't wait for an AppFolio network call before seeing the confirmation.
      triggerAppfolioSync()

    } catch (err) {
      console.error('CFO: saveAll failed:', err)
      if (btn) {
        btn.textContent      = 'Save failed — try again'
        btn.style.background = '#ef4444'
        btn.disabled         = false
      }
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  // Load data on page load, listen for save events from the HTML.

  document.addEventListener('DOMContentLoaded', async () => {
    // Load manual inputs, MF rows, AppFolio status, and Plaid status in parallel, then snapshot.
    await Promise.all([
      loadManualInputs(),
      loadMultifamilyValuations(),
      loadAppfolioStatus(),
      loadPlaidStatus(),
    ])
    await loadSnapshot()

    // Wire the bucket detail panel — when the Cash card is clicked, render the
    // Plaid connection UI. Other buckets can be wired here in future steps.
    const detailPanel = document.getElementById('bucket-detail-panel')
    if (detailPanel) {
      detailPanel.addEventListener('bucket-changed', (e) => {
        if (e.detail.bucket === 'cash') {
          renderCashBucketDetail()
        }
      })
    }
  })

  // The HTML's save button dispatches this event; we handle the actual API calls.
  document.addEventListener('cfo-save-all', saveAll)

})()
