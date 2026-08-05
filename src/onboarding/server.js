/**
 * server.js — BPM Owner Onboarding Portal API
 *
 * Runs on port 3006 (completely independent of the main server on 3005).
 * Serves both the staff management API and the owner-facing portal.
 *
 * Staff routes:  /api/onboarding/*  — require Supabase JWT (requireAuth)
 * Owner routes:  /api/onboard/*     — token-gated (requireToken)
 * Static portal: /onboard/*         — served from src/onboard/
 */

import 'dotenv/config'
import express        from 'express'
import cors           from 'cors'
import multer         from 'multer'
import rateLimit      from 'express-rate-limit'
import { createClient } from '@supabase/supabase-js'
import path           from 'path'
import { fileURLToPath } from 'url'
import { createReadStream, existsSync } from 'fs'

import { generateToken }             from './token.js'
import { lookupByAddress, lookupPropertyDetails, lookupFloodZone } from './arcgis.js'
import { createSubfolder, uploadBuffer } from './drive-uploader.js'
import {
  generateSignatureCertificate,
  generateW9,
  generateCA590,
  generateCA588,
  generateAppFolioEntrySheet,
  generateQuestionnairePDF,
  generateIntakeSummary,
} from './pdf-generator.js'
import Anthropic from '@anthropic-ai/sdk'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

// =============================================================================
// MULTER — memory storage only, never writes to disk
// =============================================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 },  // 15 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png']
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Invalid file type — PDF, JPG, or PNG only'))
    }
    cb(null, true)
  },
})

function validateMagicBytes(buffer, mimetype) {
  if (mimetype === 'application/pdf') return buffer.slice(0, 4).toString() === '%PDF'
  if (mimetype === 'image/jpeg')      return buffer[0] === 0xFF && buffer[1] === 0xD8
  if (mimetype === 'image/png')       return buffer.slice(0, 8).toString('hex') === '89504e470d0a1a0a'
  return false
}

// =============================================================================
// APP SETUP
// =============================================================================

const app = express()

app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:3002', 'http://localhost:3006', 'https://portal.beyondpropertymanagement.com'] }))
app.use(express.json({ limit: '10mb' }))

// Rate limiters
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false })
const staffLimiter  = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false })

app.use('/api/onboard/',    publicLimiter)
app.use('/api/onboarding/', staffLimiter)

// =============================================================================
// SUPABASE — service role for all server-side DB operations
// =============================================================================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PORTAL_BASE  = process.env.PORTAL_BASE_URL || 'http://localhost:3006'
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// =============================================================================
// INPUT VALIDATION MIDDLEWARE
// =============================================================================

function validateStrings(limits) {
  return (req, res, next) => {
    for (const [field, maxLen] of Object.entries(limits)) {
      if (req.body[field] !== undefined) {
        if (typeof req.body[field] !== 'string') {
          return res.status(400).json({ error: `${field} must be a string` })
        }
        if (req.body[field].length > maxLen) {
          return res.status(400).json({ error: `${field} exceeds maximum length` })
        }
      }
    }
    next()
  }
}

// =============================================================================
// AUTH MIDDLEWARE — staff routes require valid Supabase JWT
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

// =============================================================================
// TOKEN MIDDLEWARE — owner routes require a valid onboarding token
// =============================================================================

async function requireToken(req, res, next) {
  const { token } = req.params
  if (!token || token.length !== 64) {
    return res.status(404).json({ error: 'Link not found' })
  }

  const { data: onboarding, error } = await supabase
    .from('onboardings')
    .select('*')
    .eq('token', token)
    .single()

  if (error || !onboarding) return res.status(404).json({ error: 'Link not found or expired' })
  if (onboarding.status === 'revoked') {
    return res.status(403).json({ error: 'This onboarding link has been revoked. Please contact help@bpmsd.com.' })
  }

  req.onboarding = onboarding
  next()
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/** Upload to Drive — never throws; returns null fileId on failure. */
async function safeUpload(buffer, filename, mimeType, folderId) {
  if (!folderId) return null
  try {
    const { fileId } = await uploadBuffer(buffer, filename, mimeType, folderId)
    return fileId
  } catch (err) {
    console.error(`[Drive] Upload failed for "${filename}" (non-fatal):`, err.message)
    return null
  }
}

/** Returns true if all steps are complete or skipped. */
async function checkAllComplete(onboardingId) {
  const { data: steps } = await supabase
    .from('onboarding_steps')
    .select('status')
    .eq('onboarding_id', onboardingId)
  if (!steps) return false
  return steps.every(s => s.status === 'complete' || s.status === 'skipped')
}

/** Mark onboarding complete: generate entry sheet, update status, flag staff. */
async function completeOnboarding(onboardingId) {
  const { data: onboarding } = await supabase
    .from('onboardings')
    .select('*')
    .eq('id', onboardingId)
    .single()

  const { data: steps } = await supabase
    .from('onboarding_steps')
    .select('*')
    .eq('onboarding_id', onboardingId)

  try {
    const pdfBuffer = await generateAppFolioEntrySheet(onboarding, steps || [])
    const filename  = `${onboarding.short_address} AppFolio Entry Sheet.pdf`

    if (onboarding.google_drive_folder_id) {
      const fileId = await safeUpload(pdfBuffer, filename, 'application/pdf', onboarding.google_drive_folder_id)
      await supabase.from('onboarding_documents').insert({
        onboarding_id:        onboardingId,
        document_type:        'appfolio_entry_sheet',
        filename,
        google_drive_file_id: fileId,
        uploaded_by_owner:    false,
      })
    }
  } catch (err) {
    console.error('[Onboarding] Entry sheet generation error:', err.message)
  }

  // Intake summary — full snapshot of everything the owner submitted
  try {
    const summaryBuffer = await generateIntakeSummary(onboarding, steps || [])
    const summaryFilename = `${onboarding.short_address} Intake Summary.pdf`
    if (onboarding.google_drive_folder_id) {
      const fileId = await safeUpload(summaryBuffer, summaryFilename, 'application/pdf', onboarding.google_drive_folder_id)
      await supabase.from('onboarding_documents').insert({
        onboarding_id:        onboardingId,
        document_type:        'intake_summary',
        filename:             summaryFilename,
        google_drive_file_id: fileId,
        uploaded_by_owner:    false,
      })
    }
  } catch (err) {
    console.error('[Onboarding] Intake summary generation error:', err.message)
  }

  await supabase
    .from('onboardings')
    .update({ status: 'complete', completed_at: new Date().toISOString() })
    .eq('id', onboardingId)

  await supabase.from('onboarding_flags').insert({
    onboarding_id: onboardingId,
    flag_type:     'onboarding_complete',
    message:       `Onboarding complete for ${onboarding.short_address} — review AppFolio Entry Sheet in Drive`,
  })

  // AppFolio sync — non-fatal
  try {
    const { syncToAppFolio } = await import('./appfolio-sync.js')
    await syncToAppFolio(onboarding, supabase)
  } catch (err) {
    console.error('[Onboarding] AppFolio sync error:', err.message)
  }
}

/** Bump last_activity_at on the onboarding record. */
async function touchActivity(onboardingId) {
  await supabase
    .from('onboardings')
    .update({ last_activity_at: new Date().toISOString() })
    .eq('id', onboardingId)
}

/** Mark a step complete and set completed_at. */
async function markStepComplete(onboardingId, stepNumber) {
  await supabase
    .from('onboarding_steps')
    .update({ status: 'complete', completed_at: new Date().toISOString() })
    .eq('onboarding_id', onboardingId)
    .eq('step_number', stepNumber)
}

/** Save data_json to a step (merges with existing). */
async function saveStepData(onboardingId, stepNumber, data) {
  await supabase
    .from('onboarding_steps')
    .update({ data_json: data })
    .eq('onboarding_id', onboardingId)
    .eq('step_number', stepNumber)
}

/** Find the next non-skipped, non-complete step number. */
function nextStepNumber(steps, afterStep) {
  const remaining = steps
    .filter(s => s.step_number > afterStep && s.status !== 'skipped' && s.status !== 'complete')
    .sort((a, b) => a.step_number - b.step_number)
  return remaining[0]?.step_number || null
}

// =============================================================================
// STAFF ROUTES — all require requireAuth
// =============================================================================

// GET /api/onboarding/arcgis?address=...
// ArcGIS parcel lookup — called by the New Onboarding form
app.get('/api/onboarding/arcgis', requireAuth, async (req, res) => {
  const { address } = req.query
  if (!address?.trim()) return res.status(400).json({ error: 'address is required' })

  const result = await lookupByAddress(address.trim())
  if (!result) return res.json({ found: false })
  res.json({ found: true, ...result })
})

// POST /api/onboarding/create
app.post(
  '/api/onboarding/create',
  requireAuth,
  validateStrings({
    propertyAddress:     200,
    shortAddress:        80,
    ownerName:           120,
    ownerEmail:          120,
    ownerPhone:          30,
    agreementType:       30,
    ownerFirstName:      60,
    ownerMailingAddress: 200,
    entityType:          20,
    apn:                 30,
  }),
  async (req, res) => {
    const {
      propertyAddress, shortAddress, ownerName, ownerEmail, ownerPhone,
      agreementType, units = 1, ownerFirstName, ownerMailingAddress,
      entityType = 'individual', apn,
      managementStartDate, agreementTerminationDate,
    } = req.body

    if (!propertyAddress || !ownerName || !agreementType) {
      return res.status(400).json({ error: 'propertyAddress, ownerName, and agreementType are required' })
    }
    if (!['full_management', 'tenant_placement'].includes(agreementType)) {
      return res.status(400).json({ error: 'Invalid agreementType' })
    }

    const token = generateToken()

    // 1. Insert onboarding row
    const { data: onboarding, error: obErr } = await supabase
      .from('onboardings')
      .insert({
        token,
        property_address:       propertyAddress,
        short_address:          shortAddress || propertyAddress.split(',')[0].trim(),
        apn:                    apn || null,
        owner_name:             ownerName,
        owner_first_name:       ownerFirstName || ownerName.split(' ')[0],
        owner_mailing_address:  ownerMailingAddress || null,
        owner_email:            ownerEmail || null,
        owner_phone:            ownerPhone || null,
        agreement_type:         agreementType,
        units:                  Number(units) || 1,
        entity_type:            entityType,
        management_start_date:      managementStartDate || null,
        agreement_termination_date: agreementTerminationDate || null,
        created_by:             req.user.id,
        status:                 'pending',
      })
      .select()
      .single()

    if (obErr) {
      console.error('[Onboarding create] Insert error:', obErr.message)
      return res.status(500).json({ error: 'Failed to create onboarding' })
    }

    // 2. Insert 7 step rows
    // Step 4 (entity docs) is skipped for individuals
    const stepDefs = [
      { step_number: 1, step_name: 'Management Agreement',    status: 'not_started' },
      { step_number: 2, step_name: 'Property Questionnaire',  status: 'not_started' },
      { step_number: 3, step_name: 'Tax Forms (W-9 & CA)',    status: 'not_started' },
      { step_number: 4, step_name: 'Entity Documents',        status: entityType === 'individual' ? 'skipped' : 'not_started' },
      { step_number: 5, step_name: 'Insurance Verification',  status: 'not_started' },
      { step_number: 6, step_name: 'Reserve Deposit',         status: 'not_started' },
      { step_number: 7, step_name: 'Occupied Units Addendum', status: 'not_started' },
    ].map(s => ({ ...s, onboarding_id: onboarding.id }))

    const { error: stepsErr } = await supabase.from('onboarding_steps').insert(stepDefs)
    if (stepsErr) console.error('[Onboarding create] Steps insert error:', stepsErr.message)

    // 3. Create Google Drive subfolder
    const unitCount = Number(units) || 1
    const firstName = ownerFirstName || ownerName.split(' ')[0]
    const sa        = shortAddress || propertyAddress.split(',')[0].trim()
    const folderName = unitCount > 1
      ? `${sa} #${unitCount} (${firstName})`
      : `${sa} (${firstName})`

    let folderId = null
    try {
      folderId = await createSubfolder(folderName)
      await supabase
        .from('onboardings')
        .update({ google_drive_folder_id: folderId, google_drive_folder_name: folderName })
        .eq('id', onboarding.id)
    } catch (err) {
      console.error('[Onboarding create] Drive folder error:', err.message)
      // Non-fatal — onboarding still created, Drive folder can be created manually
    }

    // Lookup property details + flood zone using the APN (both free public APIs, no key needed)
    let propertyDetails = null
    let floodZoneData   = null
    if (apn) {
      propertyDetails = await lookupPropertyDetails(apn)
      if (propertyDetails?.lat && propertyDetails?.lng) {
        floodZoneData = await lookupFloodZone(propertyDetails.lat, propertyDetails.lng)
      }
    }

    res.json({
      id:         onboarding.id,
      token,
      portalLink: `${PORTAL_BASE}/onboard/${token}`,
      folderId,
      propertyDetails: {
        yearBuilt:  propertyDetails?.yearBuilt  || null,
        sqFt:       propertyDetails?.sqFt       || null,
        bedrooms:   propertyDetails?.bedrooms   || null,
        bathrooms:  propertyDetails?.bathrooms  || null,
        floodZone:  floodZoneData?.floodZone    || null,
        sfha:       floodZoneData?.sfha         || false,
      },
    })
  }
)

// GET /api/onboarding/list
app.get('/api/onboarding/list', requireAuth, async (_req, res) => {
  const { data, error } = await supabase
    .from('onboardings')
    .select(`
      id, property_address, short_address, owner_name, owner_email,
      status, units, entity_type, agreement_type, deposit_amount,
      created_at, last_activity_at, completed_at, token,
      onboarding_steps ( step_number, status ),
      onboarding_flags ( id, flag_type, resolved_at )
    `)
    .order('last_activity_at', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })

  const result = (data || []).map(ob => {
    const steps       = ob.onboarding_steps || []
    const completed   = steps.filter(s => s.status === 'complete' || s.status === 'skipped').length
    const flags       = (ob.onboarding_flags || []).filter(f => !f.resolved_at)
    const currentStep = steps
      .filter(s => s.status === 'not_started' || s.status === 'in_progress')
      .sort((a, b) => a.step_number - b.step_number)[0]

    return {
      id:                  ob.id,
      token:               ob.token,
      propertyAddress:     ob.property_address,
      shortAddress:        ob.short_address,
      ownerName:           ob.owner_name,
      ownerEmail:          ob.owner_email,
      status:              ob.status,
      units:               ob.units,
      entityType:          ob.entity_type,
      agreementType:       ob.agreement_type,
      depositAmount:       ob.deposit_amount,
      createdAt:           ob.created_at,
      lastActivityAt:      ob.last_activity_at,
      completedAt:         ob.completed_at,
      stepsCompleted:      completed,
      stepsTotal:          steps.filter(s => s.status !== 'skipped').length,
      openFlagCount:       flags.length,
      currentStepNumber:   currentStep?.step_number || null,
      portalLink:          `${PORTAL_BASE}/onboard/${ob.token}`,
    }
  })

  res.json(result)
})

// GET /api/onboarding/:id
app.get('/api/onboarding/:id', requireAuth, async (req, res) => {
  const { id } = req.params

  const { data, error } = await supabase
    .from('onboardings')
    .select(`
      *,
      onboarding_steps ( * ),
      onboarding_documents ( * ),
      onboarding_flags ( * )
    `)
    .eq('id', id)
    .single()

  if (error || !data) return res.status(404).json({ error: 'Not found' })

  res.json({
    ...data,
    portalLink: `${PORTAL_BASE}/onboard/${data.token}`,
  })
})

// GET /api/onboarding/:id/intake-pdf  — download intake summary on demand
app.get('/api/onboarding/:id/intake-pdf', requireAuth, async (req, res) => {
  const { id } = req.params
  const { data: onboarding, error: obErr } = await supabase
    .from('onboardings')
    .select('*')
    .eq('id', id)
    .single()
  if (obErr || !onboarding) return res.status(404).json({ error: 'Not found' })

  const { data: steps } = await supabase
    .from('onboarding_steps')
    .select('*')
    .eq('onboarding_id', id)

  try {
    const buffer   = await generateIntakeSummary(onboarding, steps || [])
    const filename = `${onboarding.short_address} Intake Summary.pdf`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(buffer)
  } catch (err) {
    console.error('[intake-pdf] Generation error:', err.message)
    res.status(500).json({ error: 'Failed to generate PDF' })
  }
})

// GET /api/onboarding/:id/flags
app.get('/api/onboarding/:id/flags', requireAuth, async (req, res) => {
  const { id } = req.params
  const { data, error } = await supabase
    .from('onboarding_flags')
    .select('id, flag_type, message, created_at, resolved_at')
    .eq('onboarding_id', id)
    .order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// PATCH /api/onboarding/:id/notes
app.patch('/api/onboarding/:id/notes', requireAuth, async (req, res) => {
  const { id } = req.params
  const { notes } = req.body

  if (typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' })

  const { error } = await supabase
    .from('onboardings')
    .update({ staff_notes: notes })
    .eq('id', id)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// DELETE /api/onboarding/:id/revoke
app.delete('/api/onboarding/:id/revoke', requireAuth, async (req, res) => {
  const { id } = req.params

  const { error } = await supabase
    .from('onboardings')
    .update({ status: 'revoked' })
    .eq('id', id)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// =============================================================================
// OWNER ROUTES — public, token-gated (no Supabase auth)
// =============================================================================

// GET /api/onboard/:token
app.get('/api/onboard/:token', requireToken, async (req, res) => {
  const ob = req.onboarding

  const { data: steps, error } = await supabase
    .from('onboarding_steps')
    .select('step_number, step_name, status')
    .eq('onboarding_id', ob.id)
    .order('step_number')

  if (error) return res.status(500).json({ error: 'Failed to load steps' })

  const currentStep = (steps || [])
    .filter(s => s.status === 'not_started' || s.status === 'in_progress')
    .sort((a, b) => a.step_number - b.step_number)[0]

  // Fetch step 2 data for owner name pre-fill (step 3 needs it)
  const { data: step2Row } = await supabase
    .from('onboarding_steps')
    .select('data_json')
    .eq('onboarding_id', ob.id)
    .eq('step_number', 2)
    .single()

  const s2 = step2Row?.data_json || {}

  res.json({
    onboardingId:             ob.id,
    propertyAddress:          ob.property_address,
    shortAddress:             ob.short_address,
    ownerName:                ob.owner_name,
    ownerFirstName:           ob.owner_first_name,
    agreementType:            ob.agreement_type,
    depositAmount:            ob.deposit_amount,
    units:                    ob.units,
    entityType:               ob.entity_type,
    status:                   ob.status,
    managementStartDate:      ob.management_start_date,
    agreementTerminationDate: ob.agreement_termination_date,
    currentStep:              currentStep?.step_number || null,
    // Tax roll pre-fill for Step 2 (columns added by migration 030; null if migration not yet run)
    yearBuilt:  ob.year_built  || null,
    sqFt:       ob.sq_ft       || null,
    bedrooms:   ob.bedrooms    || null,
    bathrooms:  ob.bathrooms   || null,
    floodZone:  ob.flood_zone  || null,
    sfha:       ob.sfha        || false,
    steps:          (steps || []).map(s => ({
      stepNumber: s.step_number,
      stepName:   s.step_name,
      status:     s.status,
    })),
    // Owner info from step 2 (for W-9 pre-fill in step 3)
    step2Owners: {
      numOwners:    s2.numOwners    || '1',
      owner1First:  s2.owner1First  || '',
      owner1Last:   s2.owner1Last   || '',
      owner1Email:  s2.owner1Email  || '',
      owner1Street: s2.owner1Street || '',
      owner1City:   s2.owner1City   || '',
      owner1State:  s2.owner1State  || '',
      owner1Zip:    s2.owner1Zip    || '',
      owner2First:  s2.owner2First  || '',
      owner2Last:   s2.owner2Last   || '',
      owner2Email:  s2.owner2Email  || '',
      owner2Street: s2.owner2Street || '',
      owner2City:   s2.owner2City   || '',
      owner2State:  s2.owner2State  || '',
      owner2Zip:    s2.owner2Zip    || '',
    },
  })
})

// POST /api/onboard/:token/step/1 — Management Agreement signature
app.post('/api/onboard/:token/step/1', requireToken, async (req, res) => {
  const ob = req.onboarding
  const { signature, consentGiven, timestamp, userAgent, documentHash } = req.body

  if (!consentGiven) return res.status(400).json({ error: 'Consent is required' })
  if (!signature)    return res.status(400).json({ error: 'Signature is required' })

  const ipAddress = req.headers['x-forwarded-for'] || req.ip || 'unknown'

  try {
    const certBuffer = await generateSignatureCertificate({
      propertyAddress:   ob.property_address,
      ownerName:         ob.owner_name,
      documentName:      ob.agreement_type === 'full_management'
        ? 'Property Management Agreement'
        : 'Lease Listing Agreement',
      timestamp:         timestamp || new Date().toISOString(),
      ipAddress,
      userAgent:         userAgent || 'unknown',
      sessionId:         ob.token,
      consentStatement:  'I agree to sign this document electronically under the California Uniform Electronic Transactions Act (UETA).',
      documentHash:      documentHash || 'not provided',
    })

    const filename = `${ob.short_address} Management Agreement - Signature Certificate.pdf`

    const fileId = await safeUpload(certBuffer, filename, 'application/pdf', ob.google_drive_folder_id)

    await supabase.from('onboarding_documents').insert({
      onboarding_id:        ob.id,
      step_number:          1,
      document_type:        'management_agreement_signature_cert',
      filename,
      google_drive_file_id: fileId,
      uploaded_by_owner:    true,
    })

    await markStepComplete(ob.id, 1)
    await touchActivity(ob.id)
    await supabase.from('onboardings').update({ status: 'in_progress' }).eq('id', ob.id).eq('status', 'pending')

    res.json({ success: true, nextStep: 2 })
  } catch (err) {
    console.error('[Step 1] Error:', err.message)
    res.status(500).json({ error: 'Failed to process signature' })
  }
})

// POST /api/onboard/:token/step/2 — Property Questionnaire
app.post(
  '/api/onboard/:token/step/2',
  requireToken,
  validateStrings({ hoaCompany: 500, hoaPhone: 100, hoaEmail: 200, hoaWebsite: 500, hoaLoginName: 200, hoaLoginPassword: 200, waterCompanyName: 200, waterLoginName: 200, waterLoginPassword: 200, deathDetail: 2000, additionalNotes: 2000, preferredVendors: 1000, parkingRestrictions: 500, gateCode: 500, mgmtCompanyName: 200, mgmtCompanyUrl: 300, mgmtCompanyPhone: 50, mgmtContactName: 120, mgmtCompanyEmail: 200, alarmCode: 100, trashWebsite: 300, trashLoginName: 200, trashLoginPassword: 200, elecCompanyName: 200, elecWebsite: 300, elecLoginName: 200, elecLoginPassword: 200, solarCompanyName: 200, solarCompanyUrl: 300, solarLoginName: 200, solarLoginPassword: 200, warrantyLoginName: 200, warrantyLoginPassword: 200, warrantyUrl: 300 }),
  async (req, res) => {
    const ob = req.onboarding

    // Strip any fields that should never be in the DB
    const safeFields = [
      // rental details
      'leaseTerm', 'rentType', 'rentAmount', 'depositType', 'depositAmountCustom', 'furnished',
      // property details
      'propertyType', 'propertyTypeOther', 'yearBuilt', 'squareFootage',
      'bedrooms', 'fullBaths', 'halfBaths', 'neighborhood', 'deathOnProperty', 'deathDetail',
      // occupancy (multi-unit safe to store)
      'unitOccupancy', 'anyTenantStaying',
      // appliances / amenities
      'appliances', 'amenities', 'communityFeatures',
      // access & keys
      'mailboxLocation', 'mailboxNumber',
      'keysFrontDoor', 'keysCommon', 'keysMailbox', 'keysParking', 'keysGarageRemote',
      'garageKeypadCode', 'gateCode', 'keysOtherCount', 'keysOtherDesc',
      // parking
      'parking', 'parkingRestrictions', 'garageSpaceNumbers', 'garageLocation',
      // HOA
      'hasHoa', 'hoaName', 'hoaCompany', 'hoaPhone', 'hoaEmail', 'hoaWebsite', 'hoaLoginName', 'hoaLoginPassword',
      // utilities
      'tenantPays', 'ownerPays',
      'waterCompanyName', 'waterWebsite', 'waterLoginName', 'waterLoginPassword', 'sewerType',
      'trashCompany', 'trashCompanyOther', 'poolCompany',
      // current management
      'currentlyManaged', 'mgmtCompanyName', 'mgmtCompanyUrl', 'mgmtCompanyPhone', 'mgmtContactName', 'mgmtCompanyEmail',
      // access
      'alarmCode',
      // trash login
      'trashWebsite', 'trashLoginName', 'trashLoginPassword',
      // electricity
      'elecCompanyName', 'elecWebsite', 'elecLoginName', 'elecLoginPassword',
      // solar
      'solarCompanyName', 'solarCompanyUrl', 'solarLoginName', 'solarLoginPassword', 'solarStatus',
      'gardenerBpmBid', 'gardenerName', 'gardenerPhone', 'gardenerEmail', 'gardenerUrl',
      // disclosures
      'leadPaint', 'floodZone', 'asbestos', 'bedBugs', 'mold', 'moldOther',
      'tanklessWaterHeater', 'tanklessServiceDate', 'tanklessOther',
      'heatSource', 'heatSourceOther', 'heaterFilterCount', 'heaterFilterSizes',
      'homeWarranty', 'warrantyCompany', 'warrantyPhone', 'warrantyPolicy', 'warrantyExpiry',
      'warrantyUrl', 'warrantyLoginName', 'warrantyLoginPassword',
      // owner info (no routing/account)
      'numOwners',
      'owner1First', 'owner1Last', 'owner1Email', 'owner1Phone',
      'owner1Street', 'owner1City', 'owner1State', 'owner1Zip',
      'ownerDrawMethod', 'ownerDrawAccountType',
      'owner2First', 'owner2Last', 'owner2Email', 'owner2Phone',
      'owner2Street', 'owner2City', 'owner2State', 'owner2Zip', 'owner2DrawAccountType',
      'owner3First', 'owner3Last', 'owner3Email', 'owner3Phone',
      'owner3Street', 'owner3City', 'owner3State', 'owner3Zip', 'owner3DrawAccountType',
      'owner4First', 'owner4Last', 'owner4Email', 'owner4Phone',
      'owner4Street', 'owner4City', 'owner4State', 'owner4Zip', 'owner4DrawAccountType',
      'referralSource', 'referralOther', 'referralContact',
      // additional
      'preferredVendors', 'additionalNotes',
    ]
    const safeData = {}
    for (const f of safeFields) {
      if (req.body[f] !== undefined) safeData[f] = req.body[f]
    }

    // Extract sensitive ACH fields for PDF generation only — NEVER stored in DB
    const ownerRoutingNumber  = req.body._ownerRoutingNumber  || ''
    const ownerAccountNumber  = req.body._ownerAccountNumber  || ''
    const owner2RoutingNumber = req.body._owner2RoutingNumber || ''
    const owner2AccountNumber = req.body._owner2AccountNumber || ''
    const owner3RoutingNumber = req.body._owner3RoutingNumber || ''
    const owner3AccountNumber = req.body._owner3AccountNumber || ''
    const owner4RoutingNumber = req.body._owner4RoutingNumber || ''
    const owner4AccountNumber = req.body._owner4AccountNumber || ''

    try {
      const pdfBuffer = await generateQuestionnairePDF(safeData, ob.short_address, ownerRoutingNumber, ownerAccountNumber)
      const filename  = `${ob.short_address} Property Questionnaire.pdf`

      const fileId = await safeUpload(pdfBuffer, filename, 'application/pdf', ob.google_drive_folder_id)

      await supabase.from('onboarding_documents').insert({
        onboarding_id:        ob.id,
        step_number:          2,
        document_type:        'questionnaire',
        filename,
        google_drive_file_id: fileId,
        uploaded_by_owner:    true,
      })

      await saveStepData(ob.id, 2, safeData)
      await markStepComplete(ob.id, 2)

      // Determine step 7: skip if tenant is NOT staying
      const tenantStaying = safeData.anyTenantStaying === true || safeData.anyTenantStaying === 'true'
      if (!tenantStaying) {
        await supabase
          .from('onboarding_steps')
          .update({ status: 'skipped' })
          .eq('onboarding_id', ob.id)
          .eq('step_number', 7)
      }

      await touchActivity(ob.id)

      // Fetch updated steps to find nextStep
      const { data: steps } = await supabase
        .from('onboarding_steps')
        .select('step_number, status')
        .eq('onboarding_id', ob.id)
        .order('step_number')

      const next = nextStepNumber(steps || [], 2)
      res.json({ success: true, nextStep: next })
    } catch (err) {
      console.error('[Step 2] Error:', err.message)
      res.status(500).json({ error: 'Failed to save questionnaire' })
    }
  }
)

// POST /api/onboard/:token/step/3 — W-9 + CA Tax Forms
// SENSITIVE: TINs must NEVER be logged and NEVER saved to the database
app.post('/api/onboard/:token/step/3', requireToken, async (req, res) => {
  const ob = req.onboarding

  // Extract TINs immediately — never log, never store
  const tinA = req.body._tin_a || ''
  const tinB = req.body._tin_b || ''
  delete req.body._tin_a
  delete req.body._tin_b

  const { owners, numW9s, sameLastName, w9Signature, timestamp, userAgent } = req.body

  if (!owners || !Array.isArray(owners) || owners.length === 0) {
    return res.status(400).json({ error: 'owners array is required' })
  }

  const tins = [tinA, tinB]

  try {
    // Process each owner's W-9 and CA tax form
    for (let i = 0; i < owners.length; i++) {
      const owner  = owners[i]
      const tin    = tins[i] || ''
      const suffix = owners.length > 1 ? ` — ${owner.legalName}` : ''
      const isCA   = owner.caResident === true || owner.caResident === 'true'

      if (!owner.legalName) return res.status(400).json({ error: 'Legal name is required.' })
      if (!owner.tinType)   return res.status(400).json({ error: 'Please select SSN or EIN.' })
      if (!tin)             return res.status(400).json({ error: 'SSN/TIN Required.' })

      const taxData = {
        legalName:      owner.legalName,
        businessName:   owner.businessName   || '',
        taxClassification: owner.taxClassification || '',
        exemptPayeeCode: owner.exemptPayeeCode || '',
        address:        owner.address || '',
        city:           owner.city    || '',
        state:          owner.state   || '',
        zip:            owner.zip     || '',
        tinType:        owner.tinType,
        tin,
        signedAt:       timestamp || new Date().toISOString(),
      }

      // W-9
      const w9Buffer   = await generateW9(taxData)
      const w9Filename = `${ob.short_address} W9${suffix}.pdf`
      const w9FileId = await safeUpload(w9Buffer, w9Filename, 'application/pdf', ob.google_drive_folder_id)
      await supabase.from('onboarding_documents').insert({
        onboarding_id:        ob.id,
        step_number:          3,
        document_type:        'w9',
        filename:             w9Filename,
        google_drive_file_id: w9FileId,
        uploaded_by_owner:    true,
      })

      // CA 590 or 588
      if (isCA) {
        const caBuffer   = await generateCA590(taxData)
        const caFilename = `${ob.short_address} CA Form 590${suffix}.pdf`
        const caFileId = await safeUpload(caBuffer, caFilename, 'application/pdf', ob.google_drive_folder_id)
        await supabase.from('onboarding_documents').insert({
          onboarding_id:        ob.id,
          step_number:          3,
          document_type:        'ca_590',
          filename:             caFilename,
          google_drive_file_id: caFileId,
          uploaded_by_owner:    true,
        })
      } else {
        const caBuffer   = await generateCA588(taxData)
        const caFilename = `${ob.short_address} CA Form 588${suffix}.pdf`
        const caFileId = await safeUpload(caBuffer, caFilename, 'application/pdf', ob.google_drive_folder_id)
        await supabase.from('onboarding_documents').insert({
          onboarding_id:        ob.id,
          step_number:          3,
          document_type:        'ca_588',
          filename:             caFilename,
          google_drive_file_id: caFileId,
          uploaded_by_owner:    true,
        })
        await supabase.from('onboarding_flags').insert({
          onboarding_id: ob.id,
          flag_type:     'ca_588_pending_ftb',
          message:       `${owner.legalName} is a non-CA resident. Submit FTB Form 588 to request withholding waiver. Begin 7% withholding on owner distributions until approval received.`,
        })
      }

      // TIN mismatch flag (Partnership or Trust submitted SSN)
      if (owner.tinMismatch) {
        await supabase.from('onboarding_flags').insert({
          onboarding_id: ob.id,
          flag_type:     'tin_type_mismatch',
          message:       `${owner.legalName} classified as ${owner.taxClassification} but submitted SSN. Partnership and Trust accounts should use EIN. Call owner to confirm.`,
        })
      }
    }

    // Save non-sensitive data only — no TIN fields
    const safeOwners = owners.map(o => ({
      legalName:         o.legalName,
      businessName:      o.businessName,
      taxClassification: o.taxClassification,
      exemptPayeeCode:   o.exemptPayeeCode,
      address:           o.address,
      city:              o.city,
      state:             o.state,
      zip:               o.zip,
      tinType:           o.tinType,
      caResident:        o.caResident === true || o.caResident === 'true',
      tinMismatch:       !!o.tinMismatch,
    }))

    await saveStepData(ob.id, 3, { numW9s, sameLastName, owners: safeOwners })
    await markStepComplete(ob.id, 3)
    await touchActivity(ob.id)

    const { data: steps } = await supabase
      .from('onboarding_steps')
      .select('step_number, status')
      .eq('onboarding_id', ob.id)
      .order('step_number')

    const next = nextStepNumber(steps || [], 3)
    res.json({ success: true, nextStep: next })
  } catch (err) {
    console.error('[Step 3] Error:', err.message)
    res.status(500).json({ error: 'Failed to process tax forms' })
  }
})

// POST /api/onboard/:token/step/4 — Entity Documents (file upload)
app.post('/api/onboard/:token/step/4', requireToken, upload.single('document'), async (req, res) => {
  const ob = req.onboarding

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

  const { buffer, mimetype, originalname } = req.file

  if (!validateMagicBytes(buffer, mimetype)) {
    return res.status(400).json({ error: 'File contents do not match the declared type' })
  }

  // Only PDFs for entity documents
  if (mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'Entity documents must be PDF' })
  }

  const docType   = ob.entity_type === 'trust' ? 'Trust Document' : 'LLC Document'
  const filename  = `${ob.short_address} ${docType}.pdf`

  try {
    const fileId = await safeUpload(buffer, filename, 'application/pdf', ob.google_drive_folder_id)

    await supabase.from('onboarding_documents').insert({
      onboarding_id:        ob.id,
      step_number:          4,
      document_type:        'entity_document',
      filename,
      google_drive_file_id: fileId,
      uploaded_by_owner:    true,
    })

    await markStepComplete(ob.id, 4)
    await touchActivity(ob.id)

    const { data: steps } = await supabase
      .from('onboarding_steps')
      .select('step_number, status')
      .eq('onboarding_id', ob.id)
      .order('step_number')

    const next = nextStepNumber(steps || [], 4)
    res.json({ success: true, nextStep: next })
  } catch (err) {
    console.error('[Step 4] Error:', err.message)
    res.status(500).json({ error: 'Failed to upload document' })
  }
})

// POST /api/onboard/:token/step/5 — Insurance Verification (AI scan)
app.post('/api/onboard/:token/step/5', requireToken, upload.single('insuranceDoc'), async (req, res) => {
  const ob = req.onboarding

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

  const { buffer, mimetype } = req.file

  if (!validateMagicBytes(buffer, mimetype)) {
    return res.status(400).json({ error: 'File contents do not match the declared type' })
  }

  const ext      = mimetype === 'application/pdf' ? 'pdf' : mimetype === 'image/jpeg' ? 'jpg' : 'png'
  const filename = `${ob.short_address} Insurance Declaration.${ext}`
  const bpmAddress = process.env.BPM_MAILING_ADDRESS || 'Beyond Property Management, Inc.'

  // Compute 15-day deadline (Day 3 and Day 12 follow-up dates)
  const now       = new Date()
  const deadline  = new Date(now); deadline.setUTCDate(deadline.getUTCDate() + 15)
  const day3      = new Date(now); day3.setUTCDate(day3.getUTCDate() + 3)
  const day12     = new Date(now); day12.setUTCDate(day12.getUTCDate() + 12)
  const fmtDate   = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const deadlineISO       = deadline.toISOString().split('T')[0]
  const deadlineFormatted = fmtDate(deadline)
  const day3Fmt   = fmtDate(day3)
  const day12Fmt  = fmtDate(day12)

  // --- AI scan (failure degrades to SCAN_ERROR, does not abort) ---
  let scanResult  = 'SCAN_ERROR'
  let scanDetails = {}
  try {
    const docBlock = mimetype === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
      : { type: 'image',    source: { type: 'base64', media_type: mimetype,            data: buffer.toString('base64') } }

    const prompt = `Examine this property insurance document.

Find where "Beyond Property Management" (also check "BPM SD", "BPM", or partial company name matches) appears.

Determine the coverage status — use exactly one of these values:
- ADDITIONALLY_INSURED: Beyond Property Management is listed as an Additional Insured
- CERTIFICATE_HOLDER: Beyond Property Management is listed as Certificate Holder but NOT as Additional Insured
- NOT_FOUND: Beyond Property Management does not appear on this document

Also extract the insurance company name, policy number, and policy expiration date.

Respond ONLY with valid JSON and no other text:
{"status":"ADDITIONALLY_INSURED","company":"...","policyNumber":"...","expirationDate":"..."}`

    const aiRes = await anthropic.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 256,
      messages:   [{ role: 'user', content: [docBlock, { type: 'text', text: prompt }] }],
    })

    const raw   = aiRes.content[0]?.text?.trim() || ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0])
      if (['ADDITIONALLY_INSURED', 'CERTIFICATE_HOLDER', 'NOT_FOUND'].includes(parsed.status)) {
        scanResult  = parsed.status
        scanDetails = {
          company:        parsed.company        || null,
          policyNumber:   parsed.policyNumber   || null,
          expirationDate: parsed.expirationDate || null,
        }
      }
    }
  } catch (aiErr) {
    console.error('[Step 5] AI scan error:', aiErr.message)
    // scanResult stays 'SCAN_ERROR' — handled below
  }

  // --- DB + Drive (always runs even on SCAN_ERROR) ---
  try {
    const fileId = await safeUpload(buffer, filename, mimetype, ob.google_drive_folder_id)

    await supabase.from('onboarding_documents').insert({
      onboarding_id:        ob.id,
      step_number:          5,
      document_type:        'insurance_certificate',
      filename,
      google_drive_file_id: fileId,
      uploaded_by_owner:    true,
    })

    // Store scan results on the onboarding row
    const needsDeadline = scanResult === 'CERTIFICATE_HOLDER' || scanResult === 'NOT_FOUND'
    await supabase.from('onboardings').update({
      insurance_coverage_status:  scanResult,
      insurance_company:          scanDetails.company          || null,
      insurance_policy_number:    scanDetails.policyNumber     || null,
      insurance_expiration_date:  scanDetails.expirationDate   || null,
      insurance_deadline:         needsDeadline ? deadlineISO  : null,
    }).eq('id', ob.id)

    // Staff alert — always created
    const detailStr = [
      scanDetails.company        ? `Carrier: ${scanDetails.company}.`        : '',
      scanDetails.expirationDate ? `Expires: ${scanDetails.expirationDate}.` : '',
    ].filter(Boolean).join(' ')
    await supabase.from('onboarding_flags').insert({
      onboarding_id: ob.id,
      flag_type:     'insurance_scan_complete',
      message:       `Insurance scan for ${ob.owner_name} (${ob.short_address}): ${scanResult}.${detailStr ? ' ' + detailStr : ''}`,
    })

    // Day 3 and Day 12 follow-up todos for CERTIFICATE_HOLDER or NOT_FOUND
    if (needsDeadline) {
      await supabase.from('onboarding_flags').insert([
        {
          onboarding_id: ob.id,
          flag_type:     'todo_insurance_followup',
          message:       `[Day 3 follow-up — ${day3Fmt}] Check with ${ob.owner_name} (${ob.short_address}): Has their insurance agent added BPM as Additionally Insured? Deadline: ${deadlineFormatted}`,
        },
        {
          onboarding_id: ob.id,
          flag_type:     'todo_insurance_followup',
          message:       `[Day 12 follow-up — ${day12Fmt}] Final reminder for ${ob.owner_name} (${ob.short_address}): 3 days until insurance deadline (${deadlineFormatted}). Request updated certificate immediately.`,
        },
      ])
    }

    // Only mark complete on a clean scan result
    const stepComplete = scanResult !== 'SCAN_ERROR'
    if (stepComplete) {
      await saveStepData(ob.id, 5, { scanResult, ...scanDetails })
      await markStepComplete(ob.id, 5)
    }
    await touchActivity(ob.id)

    if (!stepComplete) {
      return res.json({ success: true, scanResult })
    }

    const { data: steps } = await supabase
      .from('onboarding_steps')
      .select('step_number, status')
      .eq('onboarding_id', ob.id)
      .order('step_number')

    return res.json({
      success:    true,
      scanResult,
      deadline:   deadlineFormatted,
      bpmAddress,
      nextStep:   nextStepNumber(steps || [], 5),
    })
  } catch (err) {
    console.error('[Step 5] Error:', err.message)
    return res.status(500).json({ error: 'Failed to process insurance document' })
  }
})

// POST /api/onboard/:token/step/5/surevestor — Record owner's Surevestor enrollment decision
app.post('/api/onboard/:token/step/5/surevestor', requireToken, async (req, res) => {
  const ob = req.onboarding
  const { approved } = req.body

  if (typeof approved !== 'boolean') {
    return res.status(400).json({ error: 'approved must be a boolean' })
  }

  try {
    await supabase.from('onboardings').update({
      insurance_surevestor_approved: approved,
    }).eq('id', ob.id)

    if (approved) {
      await supabase.from('onboarding_flags').insert({
        onboarding_id: ob.id,
        flag_type:     'surevestor_setup_needed',
        message:       `Add ${ob.owner_name} (${ob.short_address}) to Surevestor group in AppFolio. Set up $25 recurring charge on the 27th of each month. Owner enrolled via onboarding portal.`,
      })
    }

    await touchActivity(ob.id)

    const { data: steps } = await supabase
      .from('onboarding_steps')
      .select('step_number, status')
      .eq('onboarding_id', ob.id)
      .order('step_number')

    return res.json({ success: true, nextStep: nextStepNumber(steps || [], 5) })
  } catch (err) {
    console.error('[Step 5 Surevestor] Error:', err.message)
    return res.status(500).json({ error: 'Failed to record Surevestor preference' })
  }
})

// POST /api/onboard/:token/step/6 — Reserve Deposit Confirmation
app.post('/api/onboard/:token/step/6', requireToken, async (req, res) => {
  const ob = req.onboarding

  if (!req.body.confirmed) return res.status(400).json({ error: 'confirmed is required' })

  try {
    await saveStepData(ob.id, 6, {
      depositConfirmedByOwner: true,
      confirmedAt:             new Date().toISOString(),
      depositAmount:           ob.deposit_amount,
    })

    await supabase.from('onboarding_flags').insert({
      onboarding_id: ob.id,
      flag_type:     'verify_deposit',
      message:       `Verify ${ob.owner_name} reserve deposit of $${ob.deposit_amount} received in AppFolio.`,
    })

    await markStepComplete(ob.id, 6)
    await touchActivity(ob.id)

    const { data: steps } = await supabase
      .from('onboarding_steps')
      .select('step_number, status')
      .eq('onboarding_id', ob.id)
      .order('step_number')

    const next = nextStepNumber(steps || [], 6)

    // If no next step, check for completion
    if (!next) {
      const allDone = await checkAllComplete(ob.id)
      if (allDone) {
        await completeOnboarding(ob.id)
        return res.json({ success: true, nextStep: null, complete: true })
      }
    }

    res.json({ success: true, nextStep: next })
  } catch (err) {
    console.error('[Step 6] Error:', err.message)
    res.status(500).json({ error: 'Failed to confirm deposit' })
  }
})

// POST /api/onboard/:token/step/7 — Occupied Units Addendum signature
app.post('/api/onboard/:token/step/7', requireToken, async (req, res) => {
  const ob = req.onboarding
  const { signature, consentGiven, timestamp, userAgent, documentHash } = req.body

  if (!consentGiven) return res.status(400).json({ error: 'Consent is required' })
  if (!signature)    return res.status(400).json({ error: 'Signature is required' })

  const ipAddress = req.headers['x-forwarded-for'] || req.ip || 'unknown'

  try {
    const certBuffer = await generateSignatureCertificate({
      propertyAddress:  ob.property_address,
      ownerName:        ob.owner_name,
      documentName:     'Occupied Units Addendum',
      timestamp:        timestamp || new Date().toISOString(),
      ipAddress,
      userAgent:        userAgent || 'unknown',
      sessionId:        ob.token,
      consentStatement: 'I agree to sign the Occupied Units Addendum electronically under California UETA.',
      documentHash:     documentHash || 'not provided',
    })

    const filename = `${ob.short_address} Occupied Units Addendum - Signature Certificate.pdf`
    const fileId = await safeUpload(certBuffer, filename, 'application/pdf', ob.google_drive_folder_id)

    await supabase.from('onboarding_documents').insert({
      onboarding_id:        ob.id,
      step_number:          7,
      document_type:        'occupied_units_addendum_signature_cert',
      filename,
      google_drive_file_id: fileId,
      uploaded_by_owner:    true,
    })

    await markStepComplete(ob.id, 7)
    await touchActivity(ob.id)

    const allDone = await checkAllComplete(ob.id)
    if (allDone) {
      await completeOnboarding(ob.id)
      return res.json({ success: true, complete: true })
    }

    res.json({ success: true, complete: false })
  } catch (err) {
    console.error('[Step 7] Error:', err.message)
    res.status(500).json({ error: 'Failed to process signature' })
  }
})

// POST /api/onboard/:token/step/7/skip — owner skips addendum, completes onboarding
app.post('/api/onboard/:token/step/7/skip', requireToken, async (req, res) => {
  const ob = req.onboarding
  try {
    await supabase
      .from('onboarding_steps')
      .update({ status: 'skipped' })
      .eq('onboarding_id', ob.id)
      .eq('step_number', 7)

    await supabase.from('onboarding_flags').insert({
      onboarding_id: ob.id,
      flag_type:     'addendum_not_signed',
      message:       `${ob.owner_name} (${ob.short_address}) skipped the Occupied Units Addendum — send the document and collect signature separately.`,
    })

    await touchActivity(ob.id)

    const allDone = await checkAllComplete(ob.id)
    if (allDone) {
      await completeOnboarding(ob.id)
    }

    res.json({ success: true })
  } catch (err) {
    console.error('[Step 7 skip] Error:', err.message)
    res.status(500).json({ error: 'Failed to skip step' })
  }
})

// POST /api/onboard/:token/upload-document — tenant document uploads from step 2
app.post('/api/onboard/:token/upload-document', requireToken, upload.single('file'), async (req, res) => {
  const ob = req.onboarding
  const { documentType } = req.body

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

  const { buffer, mimetype } = req.file

  if (!validateMagicBytes(buffer, mimetype)) {
    return res.status(400).json({ error: 'File contents do not match the declared type' })
  }

  const allowedTypes = ['current_lease', 'tenant_application', 'move_in_inspection', 'lease_addenda', 'driver_license']
  const dt       = allowedTypes.includes(documentType) ? documentType : 'other_tenant_doc'
  const ext      = mimetype === 'application/pdf' ? 'pdf' : mimetype === 'image/jpeg' ? 'jpg' : 'png'
  const filename = `${ob.short_address} ${dt}.${ext}`

  try {
    const fileId = await safeUpload(buffer, filename, mimetype, ob.google_drive_folder_id)

    await supabase.from('onboarding_documents').insert({
      onboarding_id:        ob.id,
      step_number:          2,
      document_type:        dt,
      filename,
      google_drive_file_id: fileId,
      uploaded_by_owner:    true,
    })

    res.json({ success: true })
  } catch (err) {
    console.error('[upload-document] Error:', err.message)
    res.status(500).json({ error: 'Failed to upload document' })
  }
})

// =============================================================================
// AGREEMENT TEMPLATE SERVING
// Serve placeholder PDFs from src/onboarding/templates/
// Place pma.pdf and lease-listing.pdf here when ready.
// =============================================================================

app.get('/api/onboard/templates/agreement/:type', (req, res) => {
  const { type } = req.params
  const allowed   = ['full_management', 'tenant_placement']
  if (!allowed.includes(type)) return res.status(400).json({ error: 'Invalid agreement type' })

  const fileMap = {
    full_management:    'pma.pdf',
    tenant_placement:   'lease-listing.pdf',
  }
  const filePath = path.join(__dirname, 'templates', fileMap[type])

  if (!existsSync(filePath)) {
    return res.status(404).json({
      error: 'Agreement template not yet configured',
      instruction: `Place the PDF at: src/onboarding/templates/${fileMap[type]}`,
    })
  }

  res.setHeader('Content-Type', 'application/pdf')
  createReadStream(filePath).pipe(res)
})

// =============================================================================
// STATIC SERVING — owner portal SPA
// =============================================================================

app.use('/onboard', express.static(path.join(__dirname, '../../src/onboard')))

// SPA fallback — any /onboard/* path returns index.html
app.get('/onboard/*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../src/onboard/index.html'))
})

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'BPM Onboarding API' }))

// =============================================================================
// START
// =============================================================================

if (process.argv[1] === __filename) {
  const PORT = process.env.ONBOARDING_PORT || 3006
  app.listen(PORT, () => {
    console.log(`[Onboarding] Server running on http://localhost:${PORT}`)
    console.log('  Staff API: /api/onboarding/*')
    console.log('  Owner portal: /onboard/:token')
  })
}

export default app
