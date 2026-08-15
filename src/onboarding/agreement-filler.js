/**
 * agreement-filler.js — fills <<placeholder>> tokens in pma.docx / lease-listing.docx
 * and returns a filled .docx buffer ready for Drive upload + PDF export.
 *
 * Placeholders replaced:
 *   <<Owner Name(s)>>             — owner_name from onboarding row
 *   <<Company Name>>              — "Beyond Property Management, Inc." (always fixed)
 *   <<Property Address>>          — property_address
 *   <<Management Start Date>>     — today's date (date of signing)
 *   <<Agreement Termination Date>> — one year from today
 */

import { readFile } from 'fs/promises'
import path         from 'path'
import { fileURLToPath } from 'url'
import AdmZip       from 'adm-zip'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const COMPANY_NAME = 'Beyond Property Management, Inc.'

function formatDate(date) {
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

// XML-encode a value so it's safe to drop into document.xml
function xmlEncode(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Generate a filled .docx buffer for the given onboarding record.
 *
 * @param {object} ob   Row from the onboardings table (needs owner_name, property_address, agreement_type)
 * @returns {Promise<Buffer>}  Filled .docx as an in-memory buffer
 */
export async function generateFilledAgreement(ob) {
  const templateName = ob.agreement_type === 'full_management'
    ? 'pma.docx'
    : 'lease-listing.docx'

  const templatePath = path.join(__dirname, 'templates', templateName)
  const templateBytes = await readFile(templatePath)

  const startDate = new Date()
  const endDate   = new Date(startDate)
  endDate.setFullYear(endDate.getFullYear() + 1)

  const replacements = {
    '&lt;&lt;Owner Name(s)&gt;&gt;':              xmlEncode(ob.owner_name || ''),
    '&lt;&lt;Company Name&gt;&gt;':               xmlEncode(COMPANY_NAME),
    '&lt;&lt;Property Address&gt;&gt;':           xmlEncode(ob.property_address || ''),
    '&lt;&lt;Management Start Date&gt;&gt;':      xmlEncode(formatDate(startDate)),
    '&lt;&lt;Agreement Termination Date&gt;&gt;': xmlEncode(formatDate(endDate)),
  }

  const zip = new AdmZip(templateBytes)
  const docXmlEntry = zip.getEntry('word/document.xml')
  if (!docXmlEntry) throw new Error('word/document.xml not found in template')

  let xml = docXmlEntry.getData().toString('utf8')

  for (const [placeholder, value] of Object.entries(replacements)) {
    xml = xml.replaceAll(placeholder, value)
  }

  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'))

  return zip.toBuffer()
}
