/**
 * Owner Warning Period Analysis
 * For each recently offboarded owner: how many days before their last payment
 * did the first red-flag email appear?
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const supabase = createClient(
  'https://kyekqaxuzpozuhyhibcn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5ZWtxYXh1enBvenVoeWhpYmNuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjUwMTUyOSwiZXhwIjoyMDk4MDc3NTI5fQ.TNKF9DGJ0BpQcEjD-I1peu_aZY464tFKxsodBSOP_G4'
)

// Red flag signal terms
const RED_FLAGS = [
  'concern', 'disappoint', 'terminat', 'cancel', 'not happy', 'frustrat',
  'still waiting', 'still haven', "why haven", 'urgent', 'complaint',
  'unhappy', 'unacceptable', 'lawyer', 'attorney', 'legal', 'sue',
  'leave', 'leaving', 'another management', 'switch', 'other company',
  'not satisfied', 'poor service', 'breach', 'demand', 'refund', 'overcharge',
  'looking into', 'reviewing our options', 'reconsidering', 'not renewing',
  'STILL', 'URGENT', 'UNRESOLVED', 'disappointed', 'concerned'
]

function parseDate(str) {
  if (!str || str.trim() === '') return null
  const d = new Date(str.trim())
  return isNaN(d.getTime()) ? null : d
}

function extractEmails(emailStr) {
  if (!emailStr) return []
  return emailStr.split(',').map(e => e.trim().toLowerCase()).filter(e => e && e.includes('@') && !e.includes('bpmsd.com'))
}

function isOffboarded(propertiesStr, lastPaymentStr) {
  if (!propertiesStr) return false
  const props = propertiesStr.toUpperCase()
  const hasHide = props.includes('HIDE') || props.includes('OFFBOARDING') || props.includes('DOWN')
  if (!hasHide) return false

  // Check if last payment is more than 60 days ago (to exclude very recent ones that might have some active props)
  const lastPay = parseDate(lastPaymentStr)
  if (!lastPay) return true // no payment date = definitely offboarded
  const today = new Date('2026-07-21')
  const daysSince = (today - lastPay) / (1000 * 60 * 60 * 24)
  return daysSince > 60
}

async function run() {
  console.log('\n=== OWNER WARNING PERIOD ANALYSIS ===\n')
  console.log('Today: 2026-07-21\n')

  // Parse the CSV
  let csvLines
  try {
    const csv = readFileSync('C:\\Users\\sagei\\OneDrive - Beyond Property Management\\Desktop\\Owner Directory.csv', 'utf8')
    csvLines = csv.split('\n').slice(1) // skip header
  } catch (e) {
    console.log('Could not read CSV:', e.message)
    return
  }

  // Extract recently offboarded owners with emails (last payment within ~24 months)
  const cutoffDate = new Date('2024-01-01')
  const recentlyOffboarded = []

  for (const line of csvLines) {
    if (!line.trim()) continue
    // Simple CSV parse (handles quoted fields)
    const parts = []
    let current = ''
    let inQuote = false
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote }
      else if (ch === ',' && !inQuote) { parts.push(current); current = '' }
      else { current += ch }
    }
    parts.push(current)

    const [name, properties, emailsRaw, lastPayStr] = parts
    if (!name || !properties) continue

    const lastPay = parseDate(lastPayStr)
    if (!isOffboarded(properties, lastPayStr)) continue
    if (lastPay && lastPay < cutoffDate) continue // too old, unlikely to have emails

    const emails = extractEmails(emailsRaw)
    if (emails.length === 0) continue

    recentlyOffboarded.push({
      name: name.trim().replace(/^"/, '').replace(/"$/, ''),
      properties: properties.trim(),
      emails,
      lastPayment: lastPay
    })
  }

  console.log(`Found ${recentlyOffboarded.length} recently offboarded owners with emails\n`)

  // For each owner, find their emails in the database and detect warning signals
  const results = []

  for (const owner of recentlyOffboarded) {
    // Look for emails from this owner in the 180 days before their last payment
    const searchEnd = owner.lastPayment ? owner.lastPayment : new Date('2026-07-21')
    const searchStart = new Date(searchEnd)
    searchStart.setDate(searchStart.getDate() - 180)

    const { data: emails } = await supabase
      .from('email_cache')
      .select('from_address, subject, body_preview, received_at, from_name')
      .in('from_address', owner.emails)
      .gte('received_at', searchStart.toISOString())
      .lte('received_at', searchEnd.toISOString())
      .order('received_at', { ascending: true })

    if (!emails || emails.length === 0) continue

    // Find the first red-flag email
    let firstFlagEmail = null
    let firstFlagDate = null
    let firstFlagTerms = []

    for (const email of emails) {
      const text = ((email.subject || '') + ' ' + (email.body_preview || ''))
      const matched = RED_FLAGS.filter(t => text.toLowerCase().includes(t.toLowerCase()))
      if (matched.length > 0 && !firstFlagEmail) {
        firstFlagEmail = email
        firstFlagDate = new Date(email.received_at)
        firstFlagTerms = matched
      }
    }

    const daysWarning = firstFlagDate && owner.lastPayment
      ? Math.round((owner.lastPayment - firstFlagDate) / (1000 * 60 * 60 * 24))
      : null

    results.push({
      name: owner.name,
      lastPayment: owner.lastPayment ? owner.lastPayment.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown',
      totalEmails: emails.length,
      firstFlagDate: firstFlagDate ? firstFlagDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null,
      firstFlagSubject: firstFlagEmail?.subject || null,
      firstFlagTerms,
      daysWarning,
      allSubjects: emails.slice(0, 5).map(e => e.subject)
    })
  }

  // Sort by days of warning (ascending = shortest warning = most dangerous)
  results.sort((a, b) => {
    if (a.daysWarning === null) return 1
    if (b.daysWarning === null) return -1
    return a.daysWarning - b.daysWarning
  })

  console.log('=== OWNERS WITH EMAIL ACTIVITY BEFORE DEPARTURE ===\n')

  const withWarnings = results.filter(r => r.firstFlagDate)
  const withoutWarnings = results.filter(r => !r.firstFlagDate && r.totalEmails > 0)
  const silent = results.filter(r => r.totalEmails === 0)

  if (withWarnings.length > 0) {
    console.log(`--- ${withWarnings.length} OWNERS WITH RED-FLAG EMAILS BEFORE LEAVING ---\n`)
    for (const r of withWarnings) {
      console.log(`${r.name}`)
      console.log(`  Last payment: ${r.lastPayment}`)
      console.log(`  First flag:   ${r.firstFlagDate} — "${r.firstFlagSubject}"`)
      console.log(`  Signals:      ${r.firstFlagTerms.join(', ')}`)
      console.log(`  Warning window: ${r.daysWarning !== null ? r.daysWarning + ' days' : 'unknown'}`)
      console.log(`  Total emails in window: ${r.totalEmails}`)
      console.log()
    }

    const validDays = withWarnings.filter(r => r.daysWarning !== null).map(r => r.daysWarning)
    if (validDays.length > 0) {
      const avg = Math.round(validDays.reduce((a, b) => a + b, 0) / validDays.length)
      const min = Math.min(...validDays)
      const max = Math.max(...validDays)
      console.log(`=== SUMMARY ===`)
      console.log(`Average warning window: ${avg} days`)
      console.log(`Shortest warning:       ${min} days`)
      console.log(`Longest warning:        ${max} days`)
      console.log()
    }
  }

  if (withoutWarnings.length > 0) {
    console.log(`--- ${withoutWarnings.length} OWNERS WHO EMAILED BUT NO RED FLAGS DETECTED ---\n`)
    for (const r of withoutWarnings) {
      console.log(`${r.name} | Last payment: ${r.lastPayment} | ${r.totalEmails} emails | Subjects: ${r.allSubjects.join(' / ')}`)
    }
    console.log()
  }

  if (silent.length > 0) {
    console.log(`--- ${silent.length} SILENT CHURNERS (left without sending emails in our database) ---\n`)
    for (const r of silent) {
      console.log(`${r.name} | Last payment: ${r.lastPayment}`)
    }
  }

  console.log('\n=== DONE ===\n')
}

run().catch(console.error)
