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
 * @param {object}   data           The questionnaire data_json from step 2
 * @param {string}   shortAddress   e.g. "Ash 123"
 * @param {Array}    bankingByOwner [{routing, account}, ...] — one entry per owner (index 0 = owner 1).
 *                                  Empty entries are null. NEVER stored in DB — PDF only.
 * @returns {Promise<Buffer>}
 */
export function generateQuestionnairePDF(data, shortAddress, bankingByOwner) {
  function listField(doc, label, arr) {
    if (!Array.isArray(arr) || arr.length === 0) return
    const clean = arr.map(v => v.replace(/^(appl-|amen-|comm-|park-)/, '').replace(/-/g, ' '))
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true })
      .font('Helvetica').text(clean.join(', '))
  }

  return buildPDF(doc => {
    // ── Header ────────────────────────────────────────────────────────────────
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text('Beyond Property Management', { align: 'right' })
    doc.moveDown(0.5)

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#000')
      .text(`Property Questionnaire — ${shortAddress}`, { align: 'center' })
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text(`Submitted: ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`, { align: 'center' })

    // ── 1. Property Details ───────────────────────────────────────────────────
    sectionHeader(doc, 'Property Details')
    field(doc, 'Property Type',  data.propertyType || data.propertyTypeOther)
    field(doc, 'Year Built',     data.yearBuilt)
    field(doc, 'Square Footage', data.squareFootage)
    field(doc, 'Bedrooms',       data.bedrooms)
    field(doc, 'Full Baths',     data.fullBaths)
    field(doc, 'Half Baths',     data.halfBaths)
    field(doc, 'Neighborhood',   data.neighborhood)

    // ── 2. Rental Terms ───────────────────────────────────────────────────────
    sectionHeader(doc, 'Rental Terms')
    field(doc, 'Lease Term',   data.leaseTerm)
    field(doc, 'Rent Type',    data.rentType)
    field(doc, 'Rent Amount',  data.rentAmount ? `$${data.rentAmount}` : null)
    field(doc, 'Deposit Type', data.depositType)
    if (data.depositType === 'custom') field(doc, 'Custom Deposit Amount', data.depositAmountCustom ? `$${data.depositAmountCustom}` : null)
    field(doc, 'Furnished',    data.furnished)

    // ── 3. Unit Occupancy ─────────────────────────────────────────────────────
    const units = Array.isArray(data.unitOccupancy) ? data.unitOccupancy : []
    if (units.length > 0) {
      sectionHeader(doc, 'Unit Occupancy')
      units.forEach(u => {
        const unitLabel = units.length > 1 ? `Unit ${u.unit}` : 'Occupancy'
        field(doc, `${unitLabel} Status`, u.occupancy)
        if (u.occupancy === 'staying' || u.occupancy === 'leaving') {
          if (u.tenantName)      field(doc, `${unitLabel} Tenant Name`,      u.tenantName)
          if (u.tenantPhone)     field(doc, `${unitLabel} Tenant Phone`,     u.tenantPhone)
          if (u.tenantEmail)     field(doc, `${unitLabel} Tenant Email`,     u.tenantEmail)
          if (u.rent)            field(doc, `${unitLabel} Monthly Rent`,     `$${u.rent}`)
          if (u.securityDeposit) field(doc, `${unitLabel} Security Deposit`, `$${u.securityDeposit}`)
          if (u.moveOutDate)     field(doc, `${unitLabel} Move-Out Date`,    u.moveOutDate)
        }
      })
    }

    // ── 4. Appliances & Features ──────────────────────────────────────────────
    if (data.appliances?.length || data.amenities?.length || data.communityFeatures?.length) {
      sectionHeader(doc, 'Appliances & Features')
      listField(doc, 'Appliances',         data.appliances)
      listField(doc, 'Amenities',          data.amenities)
      listField(doc, 'Community Features', data.communityFeatures)
    }

    // ── 5. Access & Keys ──────────────────────────────────────────────────────
    sectionHeader(doc, 'Access & Keys')
    field(doc, 'Front Door Keys',    data.keysFrontDoor)
    field(doc, 'Common Area Keys',   data.keysCommon)
    field(doc, 'Mailbox Keys',       data.keysMailbox)
    field(doc, 'Parking Keys',       data.keysParking)
    field(doc, 'Garage Remotes',     data.keysGarageRemote)
    field(doc, 'Garage Keypad Code', data.garageKeypadCode)
    field(doc, 'Gate Code',          data.gateCode)
    field(doc, 'Alarm Code',         data.alarmCode)
    field(doc, 'Mailbox Location',   data.mailboxLocation)
    field(doc, 'Mailbox Number',     data.mailboxNumber)
    if (data.keysOtherCount) {
      field(doc, 'Other Keys Count', data.keysOtherCount)
      field(doc, 'Other Keys Desc',  data.keysOtherDesc)
    }

    // ── 6. Parking ────────────────────────────────────────────────────────────
    if (data.parking?.length || data.parkingRestrictions) {
      sectionHeader(doc, 'Parking')
      listField(doc, 'Parking Types', data.parking)
      field(doc, 'Restrictions',      data.parkingRestrictions)
      field(doc, 'Garage Space #s',   data.garageSpaceNumbers)
      field(doc, 'Garage Location',   data.garageLocation)
    }

    // ── 7. HOA ────────────────────────────────────────────────────────────────
    if (data.hasHoa === 'yes' || data.hoaName) {
      sectionHeader(doc, 'HOA')
      field(doc, 'HOA Name',           data.hoaName)
      field(doc, 'Management Company', data.hoaCompany)
      field(doc, 'Phone',              data.hoaPhone)
      field(doc, 'Email',              data.hoaEmail)
      field(doc, 'Website',            data.hoaWebsite)
      field(doc, 'Portal Login',       data.hoaLoginName)
      field(doc, 'Portal Password',    data.hoaLoginPassword)
    }

    // ── 8. Utilities ──────────────────────────────────────────────────────────
    sectionHeader(doc, 'Utilities')
    if (data.tenantPays?.length) field(doc, 'Tenant Pays', data.tenantPays.join(', '))
    if (data.ownerPays?.length)  field(doc, 'Owner Pays',  data.ownerPays.join(', '))
    field(doc, 'Sewer Type', data.sewerType)
    if (data.septicTank) field(doc, 'Septic Tank', data.septicTank === 'yes' ? 'Yes' : 'No')
    if (data.gasType) {
      const gasLabel = data.gasType === 'natural' ? 'Natural Gas (SDG&E)' : data.gasType === 'propane' ? 'Propane' : 'None — all electric'
      field(doc, 'Gas Type', gasLabel)
      if (data.gasType === 'natural' && data.gasBillType) {
        field(doc, 'Gas Bill', data.gasBillType === 'combined' ? 'Combined with electricity' : 'Separate gas bill')
      }
      if (data.gasType === 'propane') {
        const co = data.gasPropaneCompany === 'Other' ? data.gasPropaneOther : data.gasPropaneCompany
        if (co) field(doc, 'Propane Provider', co)
        if (data.gasPropaneLogin) field(doc, 'Propane Login', data.gasPropaneLogin)
        if (data.gasPropanePassword) field(doc, 'Propane Password', data.gasPropanePassword)
      }
    }

    // ── 9. Utility Accounts ───────────────────────────────────────────────────
    if (data.waterCompanyName || data.trashCompany || data.elecCompanyName || data.solarStatus || data.solarCompanyName) {
      sectionHeader(doc, 'Utility Accounts')
      if (data.waterCompanyName) {
        field(doc, 'Water Company',   data.waterCompanyName)
        field(doc, 'Water Website',   data.waterWebsite)
        field(doc, 'Water Login',     data.waterLoginName)
        field(doc, 'Water Password',  data.waterLoginPassword)
        if (data.waterMeteringType) field(doc, 'Water Metering', data.waterMeteringType === 'individual' ? 'Individually metered per unit' : 'One master meter — RUBS')
      }
      const trashCo = data.trashCompany === 'other' ? data.trashCompanyOther : data.trashCompany
      if (trashCo) {
        field(doc, 'Trash Company',   trashCo)
        field(doc, 'Trash Website',   data.trashWebsite)
        field(doc, 'Trash Login',     data.trashLoginName)
        field(doc, 'Trash Password',  data.trashLoginPassword)
      }
      if (data.elecCompanyName) {
        field(doc, 'Electric Company',  data.elecCompanyName)
        field(doc, 'Electric Website',  data.elecWebsite)
        field(doc, 'Electric Login',    data.elecLoginName)
        field(doc, 'Electric Password', data.elecLoginPassword)
        if (data.elecMeteringType) field(doc, 'Elec Metering', data.elecMeteringType === 'individual' ? 'Individually metered per unit' : 'One master meter — RUBS')
        if (data.elecHouseMeter)   field(doc, 'House Meter',   data.elecHouseMeter === 'yes' ? 'Yes' : 'No')
      }
      if (data.solarCompanyName || data.solarStatus) {
        field(doc, 'Solar Status',   data.solarStatus)
        field(doc, 'Solar Company',  data.solarCompanyName)
        field(doc, 'Solar URL',      data.solarCompanyUrl)
        field(doc, 'Solar Login',    data.solarLoginName)
        field(doc, 'Solar Password', data.solarLoginPassword)
      }
    }

    // ── 10. Pool Vendor ───────────────────────────────────────────────────────
    if (data.poolVendorName || data.ownerPays?.includes('pool')) {
      sectionHeader(doc, 'Pool Vendor')
      field(doc, 'Pool Vendor',         data.poolVendorName)
      field(doc, 'Pool Vendor Email',   data.poolVendorEmail)
      field(doc, 'Pool Vendor Website', data.poolVendorWebsite)
      field(doc, 'Pool Vendor Phone',   data.poolVendorPhone)
    }

    // ── 11. Gardener ──────────────────────────────────────────────────────────
    if (data.gardenerName || data.gardenerBpmBid) {
      sectionHeader(doc, 'Gardener')
      field(doc, 'Gardener',       data.gardenerBpmBid ? 'BPM to bid' : data.gardenerName)
      field(doc, 'Gardener Phone', data.gardenerPhone)
      field(doc, 'Gardener Email', data.gardenerEmail)
      field(doc, 'Gardener URL',   data.gardenerUrl)
    }

    // ── 12. Disclosures ───────────────────────────────────────────────────────
    sectionHeader(doc, 'Disclosures')
    field(doc, 'Lead Paint',            data.leadPaint)
    field(doc, 'Flood Zone',            data.floodZone)
    field(doc, 'Asbestos',              data.asbestos)
    field(doc, 'Bed Bugs',              data.bedBugs)
    field(doc, 'Mold',                  data.mold)
    if (data.moldOther)                 field(doc, 'Mold Detail', data.moldOther)
    field(doc, 'Death on Property',     data.deathOnProperty)
    if (data.deathDetail)               field(doc, 'Death Detail', data.deathDetail)
    field(doc, 'Tankless Water Heater', data.tanklessWaterHeater)
    if (data.tanklessServiceDate)       field(doc, 'Tankless Service Date', data.tanklessServiceDate)
    if (data.tanklessOther)             field(doc, 'Tankless Notes', data.tanklessOther)
    field(doc, 'Heat Source',           data.heatSource || data.heatSourceOther)
    if (data.heaterFilterCount) {
      field(doc, 'Heater Filter Count', data.heaterFilterCount)
      if (data.heaterFilterSizes?.length) field(doc, 'Filter Sizes', data.heaterFilterSizes.join(', '))
    }

    // ── 13. Home Warranty ─────────────────────────────────────────────────────
    if (data.homeWarranty === 'yes') {
      sectionHeader(doc, 'Home Warranty')
      field(doc, 'Warranty Company',  data.warrantyCompany)
      field(doc, 'Warranty Phone',    data.warrantyPhone)
      field(doc, 'Warranty Policy #', data.warrantyPolicy)
      field(doc, 'Warranty Expires',  data.warrantyExpiry)
      field(doc, 'Warranty URL',      data.warrantyUrl)
      field(doc, 'Warranty Login',    data.warrantyLoginName)
      field(doc, 'Warranty Password', data.warrantyLoginPassword)
    }

    // ── 14. Current Management ────────────────────────────────────────────────
    if (data.currentlyManaged === 'yes') {
      sectionHeader(doc, 'Current Management Company')
      field(doc, 'Company Name', data.mgmtCompanyName)
      field(doc, 'Website',      data.mgmtCompanyUrl)
      field(doc, 'Phone',        data.mgmtCompanyPhone)
      field(doc, 'Contact Name', data.mgmtContactName)
      field(doc, 'Email',        data.mgmtCompanyEmail)
    }

    // ── 15. Owner Draw & Banking (CRITICAL — only copy of routing/account) ────
    const numOwners = parseInt(data.numOwners) || 1
    const banking   = Array.isArray(bankingByOwner) ? bankingByOwner : []
    sectionHeader(doc, 'Owner Draw & Banking')
    doc.fontSize(9).fillColor('#b45309')
      .text('CONFIDENTIAL — Contains banking information. Do not distribute. Shred after entering into AppFolio.')
      .fillColor('#000').fontSize(10)
    doc.moveDown(0.3)
    field(doc, 'Draw Method', data.ownerDrawMethod || 'ACH')
    for (let i = 0; i < numOwners; i++) {
      const prefix  = i === 0 ? 'owner' : `owner${i + 1}`
      const name    = [data[`${prefix}First`], data[`${prefix}Last`]].filter(Boolean).join(' ')
      const acctKey = i === 0 ? 'ownerDrawAccountType' : `owner${i + 1}DrawAccountType`
      const label   = numOwners > 1 ? `Owner ${i + 1}` : 'Owner'
      if (name) field(doc, `${label} Name`,         name)
      field(doc, `${label} Account Type`,   data[acctKey] || 'checking')
      field(doc, `${label} Routing Number`, banking[i]?.routing || 'Not provided')
      field(doc, `${label} Account Number`, banking[i]?.account || 'Not provided')
    }
    doc.moveDown(0.3)
    doc.fontSize(9).font('Helvetica').fillColor('#888')
      .text('This PDF is the only record of these numbers — they are not stored in the database.')
      .fillColor('#000').fontSize(10)

    // ── 16. Preferred Vendors ─────────────────────────────────────────────────
    if (Array.isArray(data.preferredVendors) && data.preferredVendors.length > 0) {
      sectionHeader(doc, 'Preferred Vendors')
      data.preferredVendors.forEach((v, i) => {
        const label = data.preferredVendors.length > 1 ? `Vendor ${i + 1}` : 'Preferred Vendor'
        if (v.name)    field(doc, `${label} Name`,    v.name)
        if (v.email)   field(doc, `${label} Email`,   v.email)
        if (v.website) field(doc, `${label} Website`, v.website)
      })
    }

    // ── 17. Additional Notes ──────────────────────────────────────────────────
    if (data.additionalNotes) {
      sectionHeader(doc, 'Additional Notes')
      field(doc, 'Notes', data.additionalNotes)
    }

    // ── 18. Referral ──────────────────────────────────────────────────────────
    if (data.referralSource) {
      sectionHeader(doc, 'Referral Source')
      const refLabel = data.referralSource === 'other' ? data.referralOther : data.referralSource
      field(doc, 'How They Found Us', refLabel)
      field(doc, 'Referral Contact',  data.referralContact)
    }

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

// =============================================================================
// EXPORT 7: Onboarding Intake Summary
// Full snapshot of every field submitted — for BPM files and reference.
// NOTE: Routing/account numbers are never stored in the DB (they go to the
//       Questionnaire PDF in memory only). TIN is never stored either.
// =============================================================================

/**
 * @param {object} onboarding   Full onboardings row from DB
 * @param {Array}  steps        All onboarding_steps rows for this onboarding
 * @returns {Promise<Buffer>}
 */
export function generateIntakeSummary(onboarding, steps) {
  const s2 = steps.find(s => s.step_number === 2)?.data_json || {}
  const s3 = steps.find(s => s.step_number === 3)?.data_json || {}
  const s5 = steps.find(s => s.step_number === 5)?.data_json || {}

  const numOwners = parseInt(s2.numOwners) || 1
  const insuranceTypeLabel = s5.insuranceType === 'interest_only'
    ? 'Interest Only (Surevestor required)'
    : s5.insuranceType === 'additionally_insured' ? 'Additionally Insured' : 'Not provided'

  function listField(doc, label, arr) {
    if (!Array.isArray(arr) || arr.length === 0) return
    const clean = arr.map(v => v.replace(/^(appl-|amen-|comm-|park-)/, '').replace(/-/g, ' '))
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true })
      .font('Helvetica').text(clean.join(', '))
  }

  return buildPDF(doc => {
    // ── Header ────────────────────────────────────────────────────────────────
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text('Beyond Property Management', { align: 'right' })
    doc.moveDown(0.3)
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#000')
      .text('Onboarding Intake Summary', { align: 'center' })
    doc.fontSize(10).font('Helvetica').fillColor('#555')
      .text(onboarding.property_address, { align: 'center' })
    doc.fontSize(9).fillColor('#888')
      .text(`Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`, { align: 'center' })

    // ── Property & Agreement ──────────────────────────────────────────────────
    sectionHeader(doc, 'Property & Agreement')
    field(doc, 'Address',         onboarding.property_address)
    field(doc, 'APN',             onboarding.apn || 'Not provided')
    field(doc, 'Property Type',   s2.propertyType || s2.propertyTypeOther || 'Not specified')
    field(doc, 'Year Built',      s2.yearBuilt)
    field(doc, 'Square Footage',  s2.squareFootage)
    field(doc, 'Bedrooms',        s2.bedrooms)
    field(doc, 'Full Baths',      s2.fullBaths)
    field(doc, 'Half Baths',      s2.halfBaths)
    field(doc, 'Neighborhood',    s2.neighborhood)
    field(doc, 'Units',           onboarding.units)
    field(doc, 'Agreement Type',
      onboarding.agreement_type === 'full_management'
        ? 'Full Management Agreement'
        : 'Tenant Placement / Lease Listing')
    field(doc, 'Entity Type',     onboarding.entity_type)
    field(doc, 'Reserve Deposit', onboarding.deposit_amount ? `$${onboarding.deposit_amount}` : null)

    // ── Rental Terms ──────────────────────────────────────────────────────────
    sectionHeader(doc, 'Rental Terms')
    field(doc, 'Lease Term',      s2.leaseTerm)
    field(doc, 'Rent Type',       s2.rentType)
    field(doc, 'Rent Amount',     s2.rentAmount ? `$${s2.rentAmount}` : null)
    field(doc, 'Deposit Type',    s2.depositType)
    if (s2.depositType === 'custom') field(doc, 'Custom Deposit Amount', s2.depositAmountCustom ? `$${s2.depositAmountCustom}` : null)
    field(doc, 'Furnished',       s2.furnished)

    // ── Occupancy (per unit) ──────────────────────────────────────────────────
    const units = Array.isArray(s2.unitOccupancy) ? s2.unitOccupancy : []
    if (units.length > 0) {
      sectionHeader(doc, 'Unit Occupancy')
      units.forEach(u => {
        const unitLabel = units.length > 1 ? `Unit ${u.unit}` : 'Occupancy'
        field(doc, `${unitLabel} Status`, u.occupancy)
        if (u.occupancy === 'staying' || u.occupancy === 'leaving') {
          if (u.tenantName)      field(doc, `${unitLabel} Tenant Name`,     u.tenantName)
          if (u.tenantPhone)     field(doc, `${unitLabel} Tenant Phone`,    u.tenantPhone)
          if (u.tenantEmail)     field(doc, `${unitLabel} Tenant Email`,    u.tenantEmail)
          if (u.rent)            field(doc, `${unitLabel} Monthly Rent`,    `$${u.rent}`)
          if (u.securityDeposit) field(doc, `${unitLabel} Security Deposit`, `$${u.securityDeposit}`)
          if (u.moveOutDate)     field(doc, `${unitLabel} Move-Out Date`,   u.moveOutDate)
        }
      })
    }

    // ── Appliances & Features ─────────────────────────────────────────────────
    if ((s2.appliances?.length || s2.amenities?.length || s2.communityFeatures?.length)) {
      sectionHeader(doc, 'Appliances & Features')
      listField(doc, 'Appliances',          s2.appliances)
      listField(doc, 'Amenities',           s2.amenities)
      listField(doc, 'Community Features',  s2.communityFeatures)
    }

    // ── Access & Keys ─────────────────────────────────────────────────────────
    sectionHeader(doc, 'Access & Keys')
    field(doc, 'Front Door Keys',   s2.keysFrontDoor)
    field(doc, 'Common Area Keys',  s2.keysCommon)
    field(doc, 'Mailbox Keys',      s2.keysMailbox)
    field(doc, 'Parking Keys',      s2.keysParking)
    field(doc, 'Garage Remotes',    s2.keysGarageRemote)
    field(doc, 'Garage Keypad Code', s2.garageKeypadCode)
    field(doc, 'Gate Code',         s2.gateCode)
    field(doc, 'Alarm Code',        s2.alarmCode)
    field(doc, 'Mailbox Location',  s2.mailboxLocation)
    field(doc, 'Mailbox Number',    s2.mailboxNumber)
    if (s2.keysOtherCount) {
      field(doc, 'Other Keys Count', s2.keysOtherCount)
      field(doc, 'Other Keys Desc',  s2.keysOtherDesc)
    }

    // ── Parking ───────────────────────────────────────────────────────────────
    if (s2.parking?.length || s2.parkingRestrictions) {
      sectionHeader(doc, 'Parking')
      listField(doc, 'Parking Types', s2.parking)
      field(doc, 'Restrictions',      s2.parkingRestrictions)
      field(doc, 'Garage Space #s',   s2.garageSpaceNumbers)
      field(doc, 'Garage Location',   s2.garageLocation)
    }

    // ── HOA ───────────────────────────────────────────────────────────────────
    if (s2.hasHoa === 'yes' || s2.hoaName) {
      sectionHeader(doc, 'HOA')
      field(doc, 'HOA Name',          s2.hoaName)
      field(doc, 'Management Company', s2.hoaCompany)
      field(doc, 'Phone',             s2.hoaPhone)
      field(doc, 'Email',             s2.hoaEmail)
      field(doc, 'Website',           s2.hoaWebsite)
      field(doc, 'Portal Login',      s2.hoaLoginName)
      field(doc, 'Portal Password',   s2.hoaLoginPassword)
    }

    // ── Utilities ─────────────────────────────────────────────────────────────
    sectionHeader(doc, 'Utilities')
    if (s2.tenantPays?.length) field(doc, 'Tenant Pays',   s2.tenantPays.join(', '))
    if (s2.ownerPays?.length)  field(doc, 'Owner Pays',    s2.ownerPays.join(', '))
    field(doc, 'Sewer Type',    s2.sewerType)
    if (s2.septicTank) field(doc, 'Septic Tank', s2.septicTank === 'yes' ? 'Yes' : 'No')
    if (s2.gasType) {
      const gasLabel = s2.gasType === 'natural' ? 'Natural Gas (SDG&E)' : s2.gasType === 'propane' ? 'Propane' : 'None — all electric'
      field(doc, 'Gas Type', gasLabel)
      if (s2.gasType === 'natural' && s2.gasBillType) {
        field(doc, 'Gas Bill', s2.gasBillType === 'combined' ? 'Combined with electricity' : 'Separate gas bill')
      }
      if (s2.gasType === 'propane') {
        const co = s2.gasPropaneCompany === 'Other' ? s2.gasPropaneOther : s2.gasPropaneCompany
        if (co) field(doc, 'Propane Provider', co)
        if (s2.gasPropaneLogin)    field(doc, 'Propane Login',    s2.gasPropaneLogin)
        if (s2.gasPropanePassword) field(doc, 'Propane Password', s2.gasPropanePassword)
      }
    }
    if (s2.waterCompanyName) {
      field(doc, 'Water Company',       s2.waterCompanyName)
      field(doc, 'Water Website',       s2.waterWebsite)
      field(doc, 'Water Login',         s2.waterLoginName)
      field(doc, 'Water Password',      s2.waterLoginPassword)
      if (s2.waterMeteringType) field(doc, 'Water Metering', s2.waterMeteringType === 'individual' ? 'Individually metered per unit' : 'One master meter — RUBS')
    }
    const trashCo = s2.trashCompany === 'other' ? s2.trashCompanyOther : s2.trashCompany
    if (trashCo) {
      field(doc, 'Trash Company',       trashCo)
      field(doc, 'Trash Website',       s2.trashWebsite)
      field(doc, 'Trash Login',         s2.trashLoginName)
      field(doc, 'Trash Password',      s2.trashLoginPassword)
    }
    if (s2.elecCompanyName) {
      field(doc, 'Electric Company',    s2.elecCompanyName)
      field(doc, 'Electric Website',    s2.elecWebsite)
      field(doc, 'Electric Login',      s2.elecLoginName)
      field(doc, 'Electric Password',   s2.elecLoginPassword)
      if (s2.elecMeteringType) field(doc, 'Elec Metering', s2.elecMeteringType === 'individual' ? 'Individually metered per unit' : 'One master meter — RUBS')
      if (s2.elecHouseMeter)   field(doc, 'House Meter',   s2.elecHouseMeter === 'yes' ? 'Yes' : 'No')
    }
    if (s2.solarCompanyName || s2.solarStatus) {
      field(doc, 'Solar Status',        s2.solarStatus)
      field(doc, 'Solar Company',       s2.solarCompanyName)
      field(doc, 'Solar URL',           s2.solarCompanyUrl)
      field(doc, 'Solar Login',         s2.solarLoginName)
      field(doc, 'Solar Password',      s2.solarLoginPassword)
    }
    if (s2.poolVendorName || s2.ownerPays?.includes('pool')) {
      field(doc, 'Pool Vendor',         s2.poolVendorName)
      field(doc, 'Pool Vendor Email',   s2.poolVendorEmail)
      field(doc, 'Pool Vendor Website', s2.poolVendorWebsite)
      field(doc, 'Pool Vendor Phone',   s2.poolVendorPhone)
    }
    if (s2.gardenerName || s2.gardenerBpmBid) {
      field(doc, 'Gardener',            s2.gardenerBpmBid ? 'BPM to bid' : s2.gardenerName)
      field(doc, 'Gardener Phone',      s2.gardenerPhone)
      field(doc, 'Gardener Email',      s2.gardenerEmail)
      field(doc, 'Gardener URL',        s2.gardenerUrl)
    }

    // ── Disclosures ───────────────────────────────────────────────────────────
    sectionHeader(doc, 'Disclosures')
    field(doc, 'Lead Paint',        s2.leadPaint)
    field(doc, 'Flood Zone',        s2.floodZone)
    field(doc, 'Asbestos',          s2.asbestos)
    field(doc, 'Bed Bugs',          s2.bedBugs)
    field(doc, 'Mold',              s2.mold)
    if (s2.moldOther)               field(doc, 'Mold Detail', s2.moldOther)
    field(doc, 'Death on Property', s2.deathOnProperty)
    if (s2.deathDetail)             field(doc, 'Death Detail', s2.deathDetail)
    field(doc, 'Tankless Water Heater', s2.tanklessWaterHeater)
    if (s2.tanklessServiceDate)     field(doc, 'Tankless Service Date', s2.tanklessServiceDate)
    if (s2.tanklessOther)           field(doc, 'Tankless Notes', s2.tanklessOther)
    field(doc, 'Heat Source',       s2.heatSource || s2.heatSourceOther)
    if (s2.heaterFilterCount) {
      field(doc, 'Heater Filter Count', s2.heaterFilterCount)
      if (s2.heaterFilterSizes?.length) field(doc, 'Filter Sizes', s2.heaterFilterSizes.join(', '))
    }
    if (s2.homeWarranty === 'yes') {
      field(doc, 'Home Warranty',     'Yes')
      field(doc, 'Warranty Company',  s2.warrantyCompany)
      field(doc, 'Warranty Phone',    s2.warrantyPhone)
      field(doc, 'Warranty Policy #', s2.warrantyPolicy)
      field(doc, 'Warranty Expires',  s2.warrantyExpiry)
      field(doc, 'Warranty URL',      s2.warrantyUrl)
      field(doc, 'Warranty Login',    s2.warrantyLoginName)
      field(doc, 'Warranty Password', s2.warrantyLoginPassword)
    } else {
      field(doc, 'Home Warranty', 'No')
    }

    // ── Current Management ────────────────────────────────────────────────────
    if (s2.currentlyManaged === 'yes') {
      sectionHeader(doc, 'Current Management Company')
      field(doc, 'Company Name',   s2.mgmtCompanyName)
      field(doc, 'Website',        s2.mgmtCompanyUrl)
      field(doc, 'Phone',          s2.mgmtCompanyPhone)
      field(doc, 'Contact Name',   s2.mgmtContactName)
      field(doc, 'Email',          s2.mgmtCompanyEmail)
    }

    // ── Owner Draw & Banking ──────────────────────────────────────────────────
    sectionHeader(doc, 'Owner Draw & Banking Setup')
    doc.fontSize(9).font('Helvetica').fillColor('#888')
      .text('Routing and account numbers are not stored — see Questionnaire PDF in this Drive folder.')
      .fillColor('#000').fontSize(10)
    doc.moveDown(0.3)
    field(doc, 'Draw Method', s2.ownerDrawMethod || 'ACH')
    for (let i = 1; i <= numOwners; i++) {
      const prefix  = i === 1 ? 'owner' : `owner${i}`
      const first   = s2[`${prefix}First`]  || (i === 1 ? onboarding.owner_name?.split(' ')[0] : '')
      const last    = s2[`${prefix}Last`]   || ''
      const name    = [first, last].filter(Boolean).join(' ')
      const acctKey = i === 1 ? 'ownerDrawAccountType' : `owner${i}DrawAccountType`
      const label   = numOwners > 1 ? `Owner ${i}` : 'Owner'
      if (name) field(doc, `${label} Name`,         name)
      field(doc, `${label} Account Type`, s2[acctKey] || 'checking')
      field(doc, `${label} Routing/Account`, 'On file in Questionnaire PDF')
    }

    // ── Tax & W-9 ─────────────────────────────────────────────────────────────
    sectionHeader(doc, 'Tax & W-9')
    doc.fontSize(9).font('Helvetica').fillColor('#888')
      .text('TIN (SSN/EIN) is not stored in the database — see W-9 PDF and CA 590/588 PDF in this Drive folder.')
      .fillColor('#000').fontSize(10)
    doc.moveDown(0.3)
    field(doc, 'Number of W-9s', s3.numW9s)
    field(doc, 'Same Last Name', s3.sameLastName === true ? 'Yes' : s3.sameLastName === false ? 'No' : null)
    const s3owners = Array.isArray(s3.owners) ? s3.owners : []
    if (s3owners.length > 0) {
      s3owners.forEach((o, i) => {
        const label = s3owners.length > 1 ? `Owner ${i + 1}` : 'Owner'
        field(doc, `${label} Legal Name`,         o.legalName)
        if (o.businessName)    field(doc, `${label} Business Name`,    o.businessName)
        field(doc, `${label} Tax Classification`, o.taxClassification)
        if (o.exemptPayeeCode) field(doc, `${label} Exempt Payee Code`, o.exemptPayeeCode)
        field(doc, `${label} TIN Type`,           o.tinType === 'ssn' ? 'SSN' : o.tinType === 'ein' ? 'EIN' : o.tinType)
        field(doc, `${label} CA Resident`,        o.caResident === true ? 'Yes (Form 590)' : o.caResident === false ? 'No (Form 588)' : 'TBD')
        if (o.tinMismatch)     field(doc, `${label} TIN Mismatch Flag`, 'Yes — review needed')
        const addr = [o.address, o.city, o.state, o.zip].filter(Boolean).join(', ')
        if (addr) field(doc, `${label} Mailing Address`, addr)
      })
    }

    // ── Insurance ─────────────────────────────────────────────────────────────
    sectionHeader(doc, 'Insurance')
    field(doc, 'Coverage Type',       insuranceTypeLabel)
    field(doc, 'Coverage Status',     onboarding.insurance_coverage_status)
    field(doc, 'Insurance Company',   onboarding.insurance_company)
    field(doc, 'Policy Number',       onboarding.insurance_policy_number)
    field(doc, 'Expiration Date',     onboarding.insurance_expiration_date)
    if (onboarding.insurance_deadline) field(doc, 'Correction Deadline', onboarding.insurance_deadline)
    if (onboarding.insurance_surevestor_approved !== null && onboarding.insurance_surevestor_approved !== undefined) {
      field(doc, 'Surevestor Enrolled', onboarding.insurance_surevestor_approved ? 'Yes' : 'No')
    }

    // ── Referral Source ───────────────────────────────────────────────────────
    if (s2.referralSource) {
      sectionHeader(doc, 'Referral Source')
      const refLabel = s2.referralSource === 'other' ? s2.referralOther : s2.referralSource
      field(doc, 'How They Found Us', refLabel)
      field(doc, 'Referral Contact',  s2.referralContact)
    }

    // ── Additional Notes ──────────────────────────────────────────────────────
    if ((Array.isArray(s2.preferredVendors) && s2.preferredVendors.length > 0) || s2.additionalNotes) {
      sectionHeader(doc, 'Additional Notes')
      if (Array.isArray(s2.preferredVendors) && s2.preferredVendors.length > 0) {
        s2.preferredVendors.forEach((v, i) => {
          const label = s2.preferredVendors.length > 1 ? `Vendor ${i + 1}` : 'Preferred Vendor'
          if (v.name)    field(doc, `${label} Name`,    v.name)
          if (v.email)   field(doc, `${label} Email`,   v.email)
          if (v.website) field(doc, `${label} Website`, v.website)
        })
      }
      if (s2.additionalNotes) field(doc, 'Additional Notes', s2.additionalNotes)
    }

    // ── Signatures & Completion Timeline ─────────────────────────────────────
    sectionHeader(doc, 'Signatures & Completion Timeline')
    const fmt = iso => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : null
    const step1 = steps.find(s => s.step_number === 1)
    const step6 = steps.find(s => s.step_number === 6)
    const step7 = steps.find(s => s.step_number === 7)
    const s6data = step6?.data_json || {}
    field(doc, 'Management Agreement Signed', fmt(step1?.completed_at))
    field(doc, 'Questionnaire Submitted',     fmt(steps.find(s => s.step_number === 2)?.completed_at))
    field(doc, 'W-9 / Tax Forms Submitted',   fmt(steps.find(s => s.step_number === 3)?.completed_at))
    field(doc, 'Insurance Uploaded',          fmt(steps.find(s => s.step_number === 5)?.completed_at))
    field(doc, 'Reserve Deposit Confirmed',   s6data.depositConfirmedByOwner ? fmt(s6data.confirmedAt) : null)
    if (step7?.status === 'complete') {
      field(doc, 'Occupied Units Addendum Signed', fmt(step7.completed_at))
    }
    field(doc, 'Onboarding Completed',        fmt(onboarding.completed_at))

    hr(doc)
    doc.fontSize(8).fillColor('#888')
      .text(
        `Generated via BPM Onboarding Portal on ${new Date().toLocaleDateString('en-US')}. ` +
        'Internal reference document — do not distribute.',
        { align: 'center' }
      )
  })
}

function ordinal(n) {
  const num = parseInt(n, 10)
  if (num === 1 || num === 21 || num === 31) return 'st'
  if (num === 2 || num === 22) return 'nd'
  if (num === 3 || num === 23) return 'rd'
  return 'th'
}
