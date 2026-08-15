/**
 * proof-log.js — BPM KPI Proof Log (Google Sheets)
 *
 * Creates "BPM KPI Proof Log" in Google Drive (service account) on first run,
 * shares it with danyel@bpmsd.com, then appends one row per metric per week.
 *
 * Columns: Week | Category | Metric | Value | Target | Status | Source | Screenshot URL | Entered At
 */

import { google }  from 'googleapis'
import { readFile } from 'fs/promises'

const SHEET_TITLE = 'BPM KPI Proof Log'
const TAB_NAME    = 'KPI Log'
const HEADERS     = [
  'Week', 'Category', 'Metric', 'Value Entered',
  'Target', 'Status', 'Source', 'Screenshot URL', 'Entered At (PT)'
]

const CATEGORY_SOURCE = {
  leasing:       'AppFolio',
  business_dev:  'Google / Yelp / AppFolio',
  renewals:      'AppFolio',
  delinquencies: 'AppFolio',
  maintenance:   'AppFolio',
  financials:    'QuickBooks / AppFolio',
  celebration:   'Manual',
  wellness:      'Manual',
  relationships: 'Supabase / AppFolio',
}

let _cachedSheetId = null

async function buildAuth() {
  const keyValue = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY
  let key
  if (keyValue && keyValue.trim().startsWith('{')) {
    key = JSON.parse(keyValue)
  } else {
    const path = keyValue || './bpm-drive-account.json'
    key = JSON.parse(await readFile(path, 'utf8'))
  }
  return new google.auth.JWT({
    email:  key.client_email,
    key:    key.private_key,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  })
}

async function getOrCreateSheet(client) {
  if (_cachedSheetId) return _cachedSheetId

  if (process.env.GOOGLE_KPI_PROOF_SHEET_ID) {
    _cachedSheetId = process.env.GOOGLE_KPI_PROOF_SHEET_ID
    return _cachedSheetId
  }

  const drive  = google.drive({ version: 'v3', auth: client })
  const sheets = google.sheets({ version: 'v4', auth: client })

  // Search for existing sheet in Drive
  const { data: found } = await drive.files.list({
    q:      `name='${SHEET_TITLE}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  })

  if (found.files && found.files.length > 0) {
    _cachedSheetId = found.files[0].id
    console.log(`[KPI Proof Log] Found existing sheet: ${_cachedSheetId}`)
    return _cachedSheetId
  }

  // Create the spreadsheet with a header row
  const { data: created } = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: SHEET_TITLE },
      sheets: [{
        properties: { title: TAB_NAME, gridProperties: { frozenRowCount: 1 } },
        data: [{
          startRow: 0, startColumn: 0,
          rowData: [{
            values: HEADERS.map(h => ({
              userEnteredValue:  { stringValue: h },
              userEnteredFormat: { textFormat: { bold: true } }
            }))
          }]
        }]
      }]
    }
  })

  _cachedSheetId = created.spreadsheetId
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${_cachedSheetId}/edit`
  console.log(`[KPI Proof Log] Created sheet: ${sheetUrl}`)
  console.log(`[KPI Proof Log] Add this to .env → GOOGLE_KPI_PROOF_SHEET_ID=${_cachedSheetId}`)

  // Share with danyel@bpmsd.com so he can open it
  try {
    await drive.permissions.create({
      fileId:                _cachedSheetId,
      sendNotificationEmail: false,
      requestBody: { role: 'writer', type: 'user', emailAddress: 'danyel@bpmsd.com' },
    })
    console.log('[KPI Proof Log] Shared with danyel@bpmsd.com')
  } catch (err) {
    console.warn('[KPI Proof Log] Share failed:', err.message)
  }

  return _cachedSheetId
}

// status helpers — same thresholds as the dashboard
function computeStatus(value, target, direction) {
  if (target == null) return ''
  if (direction === 'above') {
    if (value >= target)         return 'Green'
    if (value >= target * 0.8)   return 'Yellow'
    return 'Red'
  }
  if (value <= target)           return 'Green'
  if (value <= target * 1.2)     return 'Yellow'
  return 'Red'
}

/**
 * Append KPI rows to the proof log sheet.
 *
 * @param {string}  weekLabel   e.g. "Aug 9–15, 2026"
 * @param {Array}   entries     [{ category, metric_key, display_name, metric_value,
 *                                 target_value, target_direction, target_label }]
 * @returns {{ sheetId, sheetUrl, rowsAdded }}
 */
export async function appendKpiRows(weekLabel, entries) {
  const client  = await buildAuth()
  const sheetId = await getOrCreateSheet(client)
  const sheets     = google.sheets({ version: 'v4', auth: client })

  const enteredAt = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  })

  const values = entries.map(e => [
    weekLabel,
    e.category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    e.display_name,
    e.metric_value ?? '',
    e.target_label || '',
    computeStatus(e.metric_value, e.target_value, e.target_direction),
    CATEGORY_SOURCE[e.category] || '',
    '',     // Screenshot URL — Claudette fills this in
    enteredAt,
  ])

  await sheets.spreadsheets.values.append({
    spreadsheetId:   sheetId,
    range:           `${TAB_NAME}!A:I`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  })

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`
  return { sheetId, sheetUrl, rowsAdded: values.length }
}
