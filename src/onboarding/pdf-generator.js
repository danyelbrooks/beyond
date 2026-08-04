/**
 * pdf-generator.js — PDF generation for the owner onboarding portal.
 *
 * CRITICAL SECURITY RULES:
 * - SSN, EIN, routing number, account number, and signature PNG exist ONLY
 *   during PDF generation. They go req.body → pdfkit → buffer → Drive. Period.
 * - They NEVER touch the database, NEVER appear in any log statement,
 *   and NEVER get written to disk.
 * - Do NOT add console.log anywhere near TIN or signature data.
 */

import PDFDocument from 'pdfkit'

// =============================================================================
// INTERNAL HELPER — wraps pdfkit's stream API into a promise-based buffer
// =============================================================================

function buildPDF(drawFn) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: 'LETTER' })
    const chunks = []
    doc.on('data',  chunk => chunks.push(chunk))
    doc.on('end',   ()    => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    drawFn(doc)
    doc.end()
  })
}

function hr(doc) {
  doc.moveDown(0.5)
    .moveTo(50, doc.y)
    .lineTo(562, doc.y)
    .stroke()
  doc.moveDown(0.5)
}

function sectionHeader(doc, title) {
  hr(doc)
  doc.fontSize(9)
    .font('Helvetica-Bold')
    .fillColor('#444')
    .text(title.toUpperCase())
    .font('Helvetica')
    .fillColor('#000')
    .fontSize(10)
  doc.moveDown(0.3)
}

function field(doc, label, value) {
  if (!value && value !== 0) return
  doc.font('Helvetica-Bold').text(`${label}: `, { continued: true })
    .font('Helvetica').text(String(value))
}

// =============================================================================
// EXPORT 1: Signature Certificate
// =============================================================================

/**
 * Generate a 1-page Certificate of Electronic Signature.
 *
 * @param {object} data
 *   propertyAddress, ownerName, documentName, timestamp, ipAddress,
 *   userAgent, sessionId, consentStatement, documentHash
 * @returns {Promise<Buffer>}
 */
export function generateSignatureCertificate(data) {
  return buildPDF(doc => {
    // Header
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text('Beyond Property Management', { align: 'right' })
    doc.moveDown(0.5)

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#000')
      .text('Certificate of Electronic Signature', { align: 'center' })
    doc.moveDown(0.5)

    doc.fontSize(10).font('Helvetica').fillColor('#555')
      .text(
        'This certificate confirms that an electronic signature was applied to the document ' +
        'listed below in compliance with the California Uniform Electronic Transactions Act (UETA).',
        { align: 'center' }
      )

    sectionHeader(doc, 'Document Information')
    field(doc, 'Document', data.documentName)
    field(doc, 'Property', data.propertyAddress)
    field(doc, 'Signer',   data.ownerName)

    sectionHeader(doc, 'Signature Details')
    field(doc, 'Timestamp (UTC)',    data.timestamp)
    field(doc, 'IP Address',         data.ipAddress)
    field(doc, 'Session Reference',  data.sessionId ? data.sessionId.slice(0, 16) + '...' : 'N/A')

    sectionHeader(doc, 'Consent')
    doc.fontSize(9).font('Helvetica').fillColor('#333')
      .text(data.consentStatement || 'Signer agreed to sign electronically under California UETA.')
    doc.moveDown(0.3)
    field(doc, 'Consent Given', 'Yes')

    sectionHeader(doc, 'Document Integrity')
    doc.fontSize(8).font('Helvetica').fillColor('#555')
      .text(`SHA-256 Hash: ${data.documentHash || 'N/A'}`)

    sectionHeader(doc, 'User Agent')
    doc.fontSize(8).font('Helvetica').fillColor('#666')
      .text(data.userAgent || 'Not recorded', { lineBreak: true })

    hr(doc)
    doc.moveDown(0.5)
    doc.fontSize(8).fillColor('#888')
      .text(
        'This certificate was generated automatically by Beyond Property Management. ' +
        'It is a record of the electronic signature event and does not substitute for the signed document.',
        { align: 'center' }
      )
  })
}

// =============================================================================
// EXPORT 2: W-9 Summary PDF
// NOTE: TIN is embedded here and NEVER stored in the database.
// =============================================================================

/**
 * @param {object} data
 *   legalName, businessName, taxClassification, exemptPayeeCode,
 *   address, city, state, zip, tinType ('ssn'|'ein'), tin,
 *   signedAt
 * @returns {Promise<Buffer>}
 */
export function generateW9(data) {
  return buildPDF(doc => {
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text('Beyond Property Management', { align: 'right' })
    doc.moveDown(0.5)

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#000')
      .text('W-9 — Request for Taxpayer Identification Number', { align: 'center' })
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text('Substitute Form W-9 — For use by Beyond Property Management (payer)', { align: 'center' })

    sectionHeader(doc, 'Part I — Identification')
    field(doc, 'Legal Name (as on tax return)', data.legalName)
    if (data.businessName) field(doc, 'Business Name', data.businessName)
    field(doc, 'Federal Tax Classification', data.taxClassification)
    if (data.exemptPayeeCode) field(doc, 'Exempt Payee Code', data.exemptPayeeCode)
    field(doc, 'Address',   data.address)
    field(doc, 'City/State/ZIP', `${data.city}, ${data.state} ${data.zip}`)

    sectionHeader(doc, 'Part II — Taxpayer Identification Number')
    const tinLabel = data.tinType === 'ein' ? 'Employer Identification Number (EIN)' : 'Social Security Number (SSN)'
    field(doc, 'TIN Type', tinLabel)
    // TIN included in this PDF only — never persisted to the database
    doc.font('Helvetica-Bold').text('TIN: ', { continued: true })
      .font('Helvetica').text(data.tin || '')

    sectionHeader(doc, 'Part III — Certification')
    doc.fontSize(9).font('Helvetica').fillColor('#333')
      .text(
        'Under penalties of perjury, I certify that: (1) The number shown on this form is my correct taxpayer ' +
        'identification number; (2) I am not subject to backup withholding; (3) I am a U.S. citizen or other ' +
        'U.S. person; and (4) The FATCA code entered on this form (if any) indicating that I am exempt from ' +
        'FATCA reporting is correct.'
      )
    doc.moveDown(0.5)
    field(doc, 'Signed', data.signedAt || 'N/A')

    hr(doc)
    doc.fontSize(8).fillColor('#888')
      .text('Generated by Beyond Property Management Onboarding Portal.', { align: 'center' })
  })
}

// =============================================================================
// EXPORT 3: California Form 590 Summary (CA Resident)
// =============================================================================

/**
 * @param {object} data  legalName, businessName, address, city, state, zip, tinType, tin, signedAt
 * @returns {Promise<Buffer>}
 */
export function generateCA590(data) {
  return buildPDF(doc => {
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text('Beyond Property Management', { align: 'right' })
    doc.moveDown(0.5)

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#000')
      .text('California Form 590 — Withholding Exemption Certificate', { align: 'center' })
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text('Certification of California Residency', { align: 'center' })

    sectionHeader(doc, 'Payee Information')
    field(doc, 'Legal Name',    data.legalName)
    if (data.businessName) field(doc, 'Business Name', data.businessName)
    field(doc, 'Address',       data.address)
    field(doc, 'City/State/ZIP', `${data.city}, ${data.state} ${data.zip}`)
    const tinLabel = data.tinType === 'ein' ? 'EIN' : 'SSN'
    field(doc, `TIN (${tinLabel})`, data.tin)

    sectionHeader(doc, 'Certification')
    doc.fontSize(9).font('Helvetica').fillColor('#333')
      .text(
        'I certify that the above-named entity or individual is exempt from California withholding because ' +
        'I/the entity is a California resident. I/the entity will file a California income or franchise tax ' +
        'return and pay the tax due on all income subject to withholding.'
      )
    doc.moveDown(0.5)
    field(doc, 'Signed', data.signedAt || 'N/A')

    hr(doc)
    doc.fontSize(8).fillColor('#888')
      .text('This is a summary prepared for BPM records. Consult a tax advisor for official FTB form requirements.', { align: 'center' })
  })
}

// =============================================================================
// EXPORT 4: California Form 588 Summary (Non-CA Resident)
// =============================================================================

/**
 * @param {object} data  legalName, businessName, address, city, state, zip, tinType, tin, signedAt
 * @returns {Promise<Buffer>}
 */
export function generateCA588(data) {
  return buildPDF(doc => {
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text('Beyond Property Management', { align: 'right' })
    doc.moveDown(0.5)

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#000')
      .text('California Form 588 — Nonresident Withholding Waiver Request', { align: 'center' })
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text('Request for Reduced or Waived Withholding on California-Source Income', { align: 'center' })

    sectionHeader(doc, 'Payee Information')
    field(doc, 'Legal Name',    data.legalName)
    if (data.businessName) field(doc, 'Business Name', data.businessName)
    field(doc, 'Address',       data.address)
    field(doc, 'City/State/ZIP', `${data.city}, ${data.state} ${data.zip}`)
    const tinLabel = data.tinType === 'ein' ? 'EIN' : 'SSN'
    field(doc, `TIN (${tinLabel})`, data.tin)

    sectionHeader(doc, 'Waiver Request')
    doc.fontSize(9).font('Helvetica').fillColor('#333')
      .text(
        'As a non-California resident receiving California-source income, I am requesting a waiver or ' +
        'reduction of the standard 7% withholding requirement. Beyond Property Management will submit ' +
        'this request to the Franchise Tax Board (FTB). Approval typically takes 21 business days. ' +
        'Withholding will continue until written FTB approval is received.'
      )
    doc.moveDown(0.5)
    field(doc, 'Signed', data.signedAt || 'N/A')

    hr(doc)
    doc.fontSize(8).fillColor('#888')
      .text('This is a summary prepared for BPM records. BPM will fax the official FTB 588 form on your behalf.', { align: 'center' })
  })
}

// =============================================================================
// EXPORT 5: Questionnaire PDF Summary
// =============================================================================

/**
 * @param {object} data          The questionnaire data_json from step 2
 * @param {string} shortAddress  e.g. "Ash 123"
 * @returns {Promise<Buffer>}
 */
export function generateQuestionnairePDF(data, shortAddress) {
  return buildPDF(doc => {
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text('Beyond Property Management', { align: 'right' })
    doc.moveDown(0.5)

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#000')
      .text(`Property Questionnaire — ${shortAddress}`, { align: 'center' })
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text(`Submitted: ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`, { align: 'center' })

    sectionHeader(doc, 'Property Details')
    field(doc, 'Property Address',   data.propertyAddress)
    field(doc, 'Units',              data.units)
    field(doc, 'Current Occupancy',  data.tenantOccupancy || 'None')

    if (data.tenantOccupancy === 'staying' || data.tenantOccupancy === 'leaving') {
      sectionHeader(doc, 'Current Tenant')
      field(doc, 'Tenant Name',   data.tenantName)
      field(doc, 'Tenant Phone',  data.tenantPhone)
      field(doc, 'Tenant Email',  data.tenantEmail)
      if (data.tenantOccupancy === 'leaving') {
        field(doc, 'Expected Move-Out', data.moveOutDate)
      }
      if (data.tenantOccupancy === 'staying') {
        field(doc, 'Security Deposit', data.securityDeposit ? `$${data.securityDeposit}` : 'N/A')
        field(doc, 'Past-Due Rent',    data.pastDueRent ? `Yes — $${data.pastDueAmount}` : 'No')
      }
    }

    sectionHeader(doc, 'Property Condition & Access')
    field(doc, 'Known Maintenance Issues', data.maintenanceIssues || 'None reported')
    field(doc, 'Entry Notice',             data.entryNotice || 'Not specified')
    field(doc, 'Maintenance Threshold',    data.maintenanceThreshold ? `$${data.maintenanceThreshold}` : '$300')
    field(doc, 'Key Location',             data.keyLocation || 'Not provided')
    field(doc, 'Gate / Access',            data.gateCode || 'N/A')

    if (data.hoaName || data.hasHoa === 'yes') {
      sectionHeader(doc, 'HOA')
      field(doc, 'HOA Name',       data.hoaName)
      field(doc, 'HOA Contact',    data.hoaContact)
      field(doc, 'HOA Monthly Fee', data.hoaFee ? `$${data.hoaFee}` : 'N/A')
    }

    sectionHeader(doc, 'Pets')
    field(doc, 'Pets Allowed',    data.petsAllowed || 'Not specified')
    if (data.petsAllowed === 'yes' || data.petsAllowed === 'discretion') {
      field(doc, 'Pet Deposit',   data.petDeposit ? `$${data.petDeposit}` : 'N/A')
      field(doc, 'Allowed Breeds/Types', data.petTypes || 'Not specified')
    }

    sectionHeader(doc, 'Special Instructions')
    field(doc, 'Additional Notes',    data.additionalNotes || 'None')
    field(doc, 'Preferred Vendors',   data.preferredVendors || 'None')
    field(doc, 'Emergency Contact',   data.emergencyName
      ? `${data.emergencyName} (${data.emergencyRelation}) — ${data.emergencyPhone}`
      : 'Not provided')

    hr(doc)
    doc.fontSize(8).fillColor('#888')
      .text('Submitted via Beyond Property Management Owner Onboarding Portal.', { align: 'center' })
  })
}

// =============================================================================
// EXPORT 6: AppFolio Entry Sheet
// =============================================================================

/**
 * Generate a formatted staff entry sheet for manual AppFolio input.
 *
 * @param {object} onboarding   Full onboardings row from DB
 * @param {Array}  steps        All onboarding_steps rows for this onboarding
 * @returns {Promise<Buffer>}
 */
export function generateAppFolioEntrySheet(onboarding, steps) {
  // Pull data from step rows
  const step2 = steps.find(s => s.step_number === 2)?.data_json || {}
  const step3 = steps.find(s => s.step_number === 3)?.data_json || {}
  const step5 = steps.find(s => s.step_number === 5)?.data_json || {}

  const ftbType      = step3.caResident ? '590' : (step3.caResident === false ? '588' : 'TBD')
  const insuranceType = step5.insuranceType === 'interest_only' ? 'Interest Only' : 'Additionally Insured'
  const surevestor   = step5.insuranceType === 'interest_only' ? 'Yes' : 'No'

  return buildPDF(doc => {
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text(`Generated ${new Date().toLocaleDateString('en-US')} — Enter into AppFolio New Owner screen`, { align: 'right' })
    doc.moveDown(0.5)

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#000')
      .text('AppFolio Entry Sheet', { align: 'center' })
    doc.fontSize(10).font('Helvetica').fillColor('#555')
      .text(`${onboarding.property_address}`, { align: 'center' })

    sectionHeader(doc, 'Owner Information')
    field(doc, 'Name',            onboarding.owner_name)
    field(doc, 'Email',           onboarding.owner_email)
    field(doc, 'Phone',           onboarding.owner_phone)
    field(doc, 'Mailing Address', onboarding.owner_mailing_address)
    field(doc, 'Entity Type',     onboarding.entity_type)

    sectionHeader(doc, 'Property Information')
    field(doc, 'Property Address', onboarding.property_address)
    field(doc, 'APN',              onboarding.apn || 'TBD')
    field(doc, 'Units',            onboarding.units)
    field(doc, 'Agreement Type',
      onboarding.agreement_type === 'full_management'
        ? 'Full Management Agreement'
        : 'Tenant Placement / Lease Listing')

    sectionHeader(doc, 'Financial')
    field(doc, 'Reserve Deposit Amount', `$${onboarding.deposit_amount}`)
    doc.font('Helvetica-Bold').text('Deposit Received: ', { continued: true })
      .font('Helvetica').text('[ ] Yes   [ ] No  — verify in AppFolio')

    sectionHeader(doc, 'Tax & Compliance')
    field(doc, 'FTB Type',                ftbType)
    doc.font('Helvetica-Bold').text('FTB Waiver Till: ', { continued: true })
      .font('Helvetica').text('_______________________  (staff fills)')
    if (ftbType === '588') {
      doc.font('Helvetica-Bold').text('FTB 588 Waiver Faxed On: ', { continued: true })
        .font('Helvetica').text('_______________________  (staff fills)')
    }
    doc.font('Helvetica-Bold').text('1099 Type: ', { continued: true })
      .font('Helvetica').text('_______________________  (staff fills)')

    sectionHeader(doc, 'Flags')
    field(doc, 'Surevestor Fee Required', surevestor)
    field(doc, 'Insurance Type',          insuranceType)
    if (surevestor === 'Yes') {
      doc.fontSize(9).fillColor('#b45309')
        .text('ACTION: Add owner to Surevestor group in AppFolio. Set up $25 recurring charge on the 27th.')
        .fillColor('#000').fontSize(10)
    }

    sectionHeader(doc, 'Questionnaire Summary')
    field(doc, 'Current Occupancy', step2.tenantOccupancy || 'None')
    field(doc, 'Entry Notice',      step2.entryNotice || 'Not specified')
    field(doc, 'Maintenance Threshold', step2.maintenanceThreshold ? `$${step2.maintenanceThreshold}` : '$300')
    field(doc, 'Pets Allowed',      step2.petsAllowed || 'Not specified')
    field(doc, 'Key Location',      step2.keyLocation || 'Not provided')
    if (step2.maintenanceIssues) field(doc, 'Known Issues', step2.maintenanceIssues)

    hr(doc)
    doc.fontSize(8).fillColor('#888')
      .text(
        `Generated ${new Date().toLocaleDateString('en-US')} via BPM Onboarding Portal. ` +
        'Review all fields before entering into AppFolio.',
        { align: 'center' }
      )
  })
}
