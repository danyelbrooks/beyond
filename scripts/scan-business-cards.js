/**
 * scan-business-cards.js
 *
 * Reads business card images from a Google Drive folder, extracts contact info
 * using Claude vision, and writes one row per card to a Google Sheet.
 *
 * Usage: node scripts/scan-business-cards.js
 *
 * Required .env values:
 *   ANTHROPIC_API_KEY
 *   GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY  (path to service account JSON)
 *   GOOGLE_BUSINESS_CARDS_SHEET_ID    (leave blank on first run — will be logged to console)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';

// ─── Config ──────────────────────────────────────────────────────────────────

const DRIVE_FOLDER_ID = '19Tw0qWzioJFOPMfqI0_0ebaW5xOcHE02';
const PROCESSED_FILE = path.resolve('data/business-cards-processed.json');
const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];

// Image MIME types Drive will return for business card photos
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/gif',
]);

// Claude media types it accepts (heic not supported — falls back gracefully)
const CLAUDE_MEDIA_MAP = {
  'image/jpeg': 'image/jpeg',
  'image/jpg':  'image/jpeg',
  'image/png':  'image/png',
  'image/webp': 'image/webp',
  'image/gif':  'image/gif',
  'image/heic': 'image/jpeg', // Claude doesn't accept heic; we'll try as jpeg
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

function buildGoogleAuth() {
  const keyPath = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY;
  if (!keyPath || !fs.existsSync(keyPath)) {
    console.error(`Service account key not found at: ${keyPath}`);
    console.error('Set GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY in .env to the path of your service account JSON.');
    process.exit(1);
  }
  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  return new google.auth.GoogleAuth({ credentials: key, scopes: SCOPES });
}

// ─── Processed-file tracking ──────────────────────────────────────────────────

function loadProcessed() {
  if (!fs.existsSync(PROCESSED_FILE)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function saveProcessed(processed) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processed], null, 2));
}

// ─── Google Drive helpers ─────────────────────────────────────────────────────

async function listImageFiles(drive) {
  let files = [];
  let pageToken = null;

  try {
    do {
      const res = await drive.files.list({
        q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 100,
        pageToken: pageToken || undefined,
      });
      files = files.concat(res.data.files || []);
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (err.code === 403 || err.code === 404) {
      console.error('Could not access Google Drive folder. Make sure the service account has been shared on the folder.');
      process.exit(1);
    }
    throw err;
  }

  return files.filter(f => IMAGE_MIME_TYPES.has(f.mimeType));
}

async function downloadFileAsBase64(drive, fileId, mimeType) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  const buffer = Buffer.from(res.data);
  return buffer.toString('base64');
}

// ─── Google Sheets helpers ────────────────────────────────────────────────────

const SHEET_HEADERS = [
  'Name', 'Title', 'Company', 'Phone', 'Email',
  'Address', 'Website', 'Notes', 'Source File', 'Date Added',
];

async function ensureSheet(sheets) {
  let sheetId = process.env.GOOGLE_BUSINESS_CARDS_SHEET_ID?.trim();

  if (!sheetId) {
    // Create a new spreadsheet
    const res = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: 'Business Card Leads' },
        sheets: [{
          properties: { title: 'Leads' },
          data: [{
            startRow: 0,
            startColumn: 0,
            rowData: [{
              values: SHEET_HEADERS.map(h => ({ userEnteredValue: { stringValue: h } })),
            }],
          }],
        }],
      },
    });
    sheetId = res.data.spreadsheetId;
    console.log('');
    console.log('New Google Sheet created.');
    console.log(`Sheet ID: ${sheetId}`);
    console.log('Paste this into your .env file as: GOOGLE_BUSINESS_CARDS_SHEET_ID=' + sheetId);
    console.log('');
    return sheetId;
  }

  return sheetId;
}

async function appendRow(sheets, sheetId, rowData) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Leads!A:J',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [rowData],
    },
  });
}

// ─── Claude vision extraction ─────────────────────────────────────────────────

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_PROMPT = `You are reading a business card image for a property management company's contact database.

Extract every piece of contact information you can see on this business card. Return ONLY a JSON object with these exact keys — no markdown, no explanation, just the raw JSON:

{
  "name": "",
  "title": "",
  "company": "",
  "phone": "",
  "email": "",
  "address": "",
  "website": "",
  "notes": ""
}

Rules:
- If a field is not visible on the card, leave it as an empty string "".
- For "phone", include the first/primary phone number. If there are multiple, put them all separated by " | ".
- For "notes", capture anything else on the card worth keeping: taglines, social handles, license numbers, certifications, handwritten notes, etc.
- If the image is too blurry or damaged to read, put "Could not read clearly" in the "notes" field and fill in whatever you can see.
- Do not guess or invent information that isn't on the card.`;

async function extractCardInfo(base64Image, mimeType, fileName) {
  const claudeMime = CLAUDE_MEDIA_MAP[mimeType] || 'image/jpeg';

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: claudeMime,
              data: base64Image,
            },
          },
          {
            type: 'text',
            text: EXTRACTION_PROMPT,
          },
        ],
      },
    ],
  });

  const raw = response.content[0]?.text?.trim() || '{}';

  // Strip any accidental markdown fences
  const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // If Claude returned something we can't parse, note it
    return {
      name: '', title: '', company: '', phone: '',
      email: '', address: '', website: '',
      notes: `Could not parse extraction result: ${raw.slice(0, 200)}`,
    };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`
scan-business-cards.js

Reads business card images from Google Drive, extracts contact info using Claude AI,
and writes one row per card to a Google Sheet.

Usage:
  node scripts/scan-business-cards.js

Required environment variables (.env):
  ANTHROPIC_API_KEY                    Claude API key
  GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY     Path to Google service account JSON
  GOOGLE_BUSINESS_CARDS_SHEET_ID       Leave blank on first run; paste the ID after it's created

The script tracks which files it has already processed in:
  data/business-cards-processed.json

Re-running the script is safe — already-processed files are skipped.
    `);
    process.exit(0);
  }

  // Build Google clients
  const auth = buildGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  // Load processed file list
  const processed = loadProcessed();

  // List image files in the Drive folder
  console.log('Checking Google Drive folder for business card images...');
  const files = await listImageFiles(drive);

  if (files.length === 0) {
    console.log('No image files found in the folder.');
    return;
  }

  const toProcess = files.filter(f => !processed.has(f.id));
  console.log(`Found ${files.length} image(s). ${toProcess.length} new to process.`);

  if (toProcess.length === 0) {
    console.log('Nothing new to process. Done.');
    return;
  }

  // Ensure the Google Sheet exists
  const sheetId = await ensureSheet(sheets);

  // Process each card
  let successCount = 0;
  let errorCount = 0;

  for (const file of toProcess) {
    process.stdout.write(`Processing: ${file.name} → `);

    try {
      // Download image
      const base64 = await downloadFileAsBase64(drive, file.id, file.mimeType);

      // Extract info with Claude
      const info = await extractCardInfo(base64, file.mimeType, file.name);

      const displayName = [info.name, info.company].filter(Boolean).join(', ') || '(no name found)';
      console.log(displayName);

      // Build the row
      const dateAdded = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const row = [
        info.name    || '',
        info.title   || '',
        info.company || '',
        info.phone   || '',
        info.email   || '',
        info.address || '',
        info.website || '',
        info.notes   || '',
        file.name,
        dateAdded,
      ];

      // Append to sheet
      await appendRow(sheets, sheetId, row);

      // Mark as processed
      processed.add(file.id);
      saveProcessed(processed);
      successCount++;

    } catch (err) {
      console.log(`ERROR — ${err.message}`);
      errorCount++;
      // Don't mark as processed so it retries next run
    }
  }

  console.log('');
  console.log(`Done. ${successCount} card(s) added to the sheet. ${errorCount > 0 ? `${errorCount} error(s) — those files will retry next run.` : ''}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
