/**
 * drive-uploader.js — Google Drive uploads for the owner onboarding portal.
 *
 * Uses a SEPARATE service account from the Gmail service account.
 * Key file path: process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY
 * Scope: drive.file only (cannot read/modify files it did not create).
 *
 * Never writes anything to disk — buffers go straight from memory to Drive.
 */

import { readFile }  from 'fs/promises'
import { Readable }  from 'stream'
import { google }    from 'googleapis'

const DRIVE_SCOPE     = 'https://www.googleapis.com/auth/drive'
const DEFAULT_FOLDER  = '0AIFTYoJhulNLUk9PVA'

// =============================================================================
// AUTH
// =============================================================================

async function getAuth() {
  const keyValue = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY
  if (!keyValue) {
    throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY is not set in environment')
  }

  let keyFile
  // If the value starts with '{' it is the JSON content (Render / production).
  // Otherwise treat it as a file path (local dev with bpm-drive-account.json).
  if (keyValue.trim().startsWith('{')) {
    try {
      keyFile = JSON.parse(keyValue)
    } catch (err) {
      throw new Error(`GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY is not valid JSON: ${err.message}`)
    }
  } else {
    try {
      const raw = await readFile(keyValue, 'utf8')
      keyFile = JSON.parse(raw)
    } catch (err) {
      throw new Error(`Could not read Drive service account key at "${keyValue}": ${err.message}`)
    }
  }

  return new google.auth.JWT({
    email:  keyFile.client_email,
    key:    keyFile.private_key,
    scopes: [DRIVE_SCOPE],
    // No subject — Drive service account does not need domain-wide delegation
  })
}

// =============================================================================
// EXPORTS
// =============================================================================

/**
 * Create a subfolder inside the BPM onboarding parent folder.
 *
 * Naming convention:
 *   Single unit:  "Ash 123 (Sarah)"
 *   Multi-unit:   "Ash 123 #4 (Sarah)"  (where 4 = number of units)
 *
 * @param {string} folderName  Pre-formatted folder name
 * @returns {Promise<string>}  The new folder's Google Drive ID
 */
export async function createSubfolder(folderName) {
  const auth  = await getAuth()
  const drive = google.drive({ version: 'v3', auth })
  const parentId = process.env.GOOGLE_DRIVE_ONBOARDING_FOLDER_ID || DEFAULT_FOLDER

  const response = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name:     folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents:  [parentId],
    },
    fields: 'id',
  })

  return response.data.id
}

/**
 * Upload a .docx buffer to Drive, convert it to PDF via Google Docs export,
 * save the PDF to folderId, and delete the intermediate Google Doc.
 *
 * @param {Buffer} docxBuffer  Filled .docx contents in memory
 * @param {string} pdfFilename Filename for the saved PDF (e.g. "123 Main St Management Agreement.pdf")
 * @param {string} folderId    Owner's Google Drive folder ID
 * @returns {Promise<{ fileId: string, webViewLink: string }>}
 */
export async function uploadDocxAsPdf(docxBuffer, pdfFilename, folderId) {
  const auth  = await getAuth()
  const drive = google.drive({ version: 'v3', auth })

  // Step 1: upload .docx → Google Docs (Drive converts automatically)
  const uploadStream = new Readable()
  uploadStream.push(docxBuffer)
  uploadStream.push(null)

  const uploaded = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name:     pdfFilename.replace(/\.pdf$/, ''),
      mimeType: 'application/vnd.google-apps.document',
    },
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      body:     uploadStream,
    },
    fields: 'id',
  })

  const tempDocId = uploaded.data.id

  try {
    // Step 2: export as PDF
    const exported = await drive.files.export(
      { fileId: tempDocId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    )

    const pdfBuffer = Buffer.from(exported.data)

    // Step 3: upload the PDF to the owner's folder
    const result = await uploadBuffer(pdfBuffer, pdfFilename, 'application/pdf', folderId)
    return result
  } finally {
    // Step 4: always clean up the temp Google Doc
    await drive.files.delete({ fileId: tempDocId, supportsAllDrives: true }).catch(() => {})
  }
}

/**
 * Upload a buffer directly to Google Drive without writing to disk.
 *
 * @param {Buffer} buffer      File contents in memory
 * @param {string} filename    Filename as it will appear in Drive
 * @param {string} mimeType    e.g. 'application/pdf'
 * @param {string} folderId    Target folder ID in Drive
 * @returns {Promise<{ fileId: string, webViewLink: string }>}
 */
export async function uploadBuffer(buffer, filename, mimeType, folderId) {
  const auth  = await getAuth()
  const drive = google.drive({ version: 'v3', auth })

  // Convert buffer to a readable stream — never touches disk
  const stream = new Readable()
  stream.push(buffer)
  stream.push(null)

  const response = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name:    filename,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: 'id, webViewLink',
  })

  return {
    fileId:      response.data.id,
    webViewLink: response.data.webViewLink || null,
  }
}
