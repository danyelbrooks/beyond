/**
 * classify.js — Hello@ Forwarding
 *
 * Reads new mail that landed in hello@bpmsd.com and decides which BPM inbox
 * should own it. Runs right after the email sync, every minute.
 *
 * Usage:
 *   node src/email/classify.js
 *
 * How it decides, in order:
 *   1. RULES  — the rules Danyel manages on the Routing Rules page. Free,
 *               instant, and identical every time. First match wins.
 *   2. AI     — anything no rule matched goes to Claude with the routing
 *               instructions stored in routing_settings.ai_prompt.
 *
 * What it does with the decision:
 *   High confidence      -> forwards to that inbox and logs it
 *   Medium or low        -> leaves it alone for a human to read
 *   Spam / marketing     -> marks it, never forwards it
 *   Newsletter           -> adds it to the unsubscribe list for a person to clear
 *
 * SHADOW MODE
 *   While routing_settings.shadow_mode is true, every decision is recorded but
 *   nothing is ever sent. That is the setting this ships in. Flipping it off is
 *   what takes the system live.
 *
 * This script uses the service role key, which bypasses RLS.
 * Never run it in the browser.
 */

import 'dotenv/config'
import Anthropic        from '@anthropic-ai/sdk'
import { pathToFileURL } from 'node:url'
import { supabase }     from '../db/server-client.js'
import { forwardEmail, isBpmInbox } from './forward.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// The model that reads the emails. Haiku is fast and inexpensive, which matters
// when every email in the inbox goes through it. If shadow mode shows it is not
// accurate enough, change this one line to 'claude-sonnet-5'.
const MODEL = 'claude-haiku-4-5-20251001'

// Most emails a single run will handle. Keeps one run from taking forever if a
// large batch arrives at once — the leftovers are picked up a minute later.
const BATCH_SIZE = 25

// =============================================================================
// MAIN
// =============================================================================

async function run() {
  console.log('=== Hello@ Forwarding ===')
  console.log('Started:', new Date().toLocaleString())

  const settings = await loadSettings()
  if (!settings) return

  if (!settings.enabled) {
    console.log('Routing is switched off (routing_settings.enabled = false). Nothing to do.')
    return
  }

  console.log(`Inbox: ${settings.source_inbox}`)
  console.log(settings.shadow_mode
    ? 'Mode:  SHADOW — decisions are recorded, nothing is sent'
    : 'Mode:  LIVE — high-confidence emails will be forwarded')

  const rules  = await loadRules()
  const emails = await loadUnroutedEmails(settings)

  console.log(`Rules loaded: ${rules.length}`)
  console.log(`Emails to classify: ${emails.length}`)
  console.log('')

  if (emails.length === 0) {
    console.log('Nothing new. Done.')
    return
  }

  const tally = { forwarded: 0, held: 0, ignored: 0, failed: 0 }

  for (const email of emails) {
    try {
      const outcome = await classifyOne(email, rules, settings)
      tally[outcome] += 1
    } catch (err) {
      // One bad email must never stop the rest of the batch
      tally.failed += 1
      console.error(`  ERROR on "${email.subject}": ${err.message || String(err)}`)
      await recordFailure(email, err)
    }
  }

  console.log('')
  console.log(`Forwarded: ${tally.forwarded}   Held for a human: ${tally.held}   Ignored as junk: ${tally.ignored}   Failed: ${tally.failed}`)
  console.log('Finished:', new Date().toLocaleString())
}

// =============================================================================
// CLASSIFY ONE EMAIL
// Returns 'forwarded' | 'held' | 'ignored'
// =============================================================================

async function classifyOne(email, rules, settings) {
  const label = `"${(email.subject || '(no subject)').slice(0, 55)}" from ${email.from_address}`

  // ---- Step 1: the rules ---------------------------------------------------
  let decision = matchRules(email, rules)

  // ---- Step 2: the AI, only if no rule matched -----------------------------
  if (!decision) {
    decision = await askClaude(email, settings)
  }

  // ---- Step 3: check the answer is one we are willing to act on ------------
  decision = validate(decision, settings)

  // ---- Step 4: write the decision down -------------------------------------
  await supabase
    .from('email_cache')
    .update({
      routed_to:           decision.destination,
      routing_department:  decision.department,
      routing_reason:      decision.reason,
      routing_topic:       decision.primary_topic,
      routing_sender_type: decision.sender_type,
      routing_confidence:  decision.confidence,
      routing_source:      decision.source,
      routing_rule_id:     decision.rule_id ?? null,
      needs_unsubscribe:   decision.unsubscribe === true,
      routed_at:           new Date().toISOString()
    })
    .eq('id', email.id)

  await logAction(email.id, 'auto_routed', decision)

  if (decision.rule_id) await bumpRuleHitCount(decision.rule_id)

  // ---- Step 5: act on it ---------------------------------------------------

  // Junk. Recorded, never sent anywhere.
  if (decision.destination === 'none') {
    console.log(`  IGNORED   ${label}`)
    console.log(`            ${decision.reason}`)
    return 'ignored'
  }

  // Not confident enough. A person reads it and adds a rule.
  if (decision.confidence !== 'high') {
    console.log(`  HELD      ${label}`)
    console.log(`            would go to ${decision.destination} — ${decision.confidence} confidence — ${decision.reason}`)
    await logAction(email.id, 'routing_held', decision)
    return 'held'
  }

  // Confident. Send it — unless we are in shadow mode.
  if (settings.shadow_mode) {
    console.log(`  [shadow]  ${label}`)
    console.log(`            would forward to ${decision.destination} — ${decision.reason}`)
    return 'forwarded'
  }

  await forwardEmail(email, decision.destination, {
    fullBody: true,
    note: `Routed automatically by Hello@ Forwarding — ${decision.reason}`
  })

  await supabase
    .from('email_cache')
    .update({ forward_sent: true, forwarded_to: decision.destination, status: 'assigned' })
    .eq('id', email.id)

  await logAction(email.id, 'auto_forwarded', decision)

  console.log(`  FORWARDED ${label}`)
  console.log(`            to ${decision.destination} — ${decision.reason}`)
  return 'forwarded'
}

// =============================================================================
// STEP 1 — RULES
// =============================================================================

/**
 * Walk the rules in priority order and return the first one that matches.
 * Returns null when nothing matches, which sends the email on to the AI.
 */
function matchRules(email, rules) {
  const subject = lower(email.subject)
  const body    = lower(plainBody(email))
  const from    = lower(email.from_address)
  const domain  = from.includes('@') ? from.split('@').pop() : ''
  const opening = body.slice(0, 250)   // greetings live at the very top

  for (const rule of rules) {
    const needle = lower(rule.match_text)
    if (!needle) continue

    let hit = false

    switch (rule.match_field) {
      case 'greeting_name':
        hit = matchesGreeting(opening, needle)
        break
      case 'from_address':
        hit = from.includes(needle)
        break
      case 'from_domain':
        hit = domain.includes(needle)
        break
      case 'subject':
        hit = subject.includes(needle)
        break
      case 'body':
        hit = body.includes(needle)
        break
      case 'subject_or_body':
        hit = subject.includes(needle) || body.includes(needle)
        break
    }

    if (hit) {
      return {
        destination:   rule.destination,
        department:    rule.label,
        reason:        `Matched your rule "${rule.label}".`,
        primary_topic: rule.label,
        sender_type:   'Unknown',
        confidence:    'high',      // a rule is a certainty, not a guess
        unsubscribe:   false,
        source:        'rule',
        rule_id:       rule.id
      }
    }
  }

  return null
}

/**
 * Does this email open by addressing someone by name?
 *
 * Matches "Hi Laura", "Hello Laura,", "Dear Laura", "Good morning Laura" and a
 * bare "Laura," on the first line. Deliberately strict: it only looks at the
 * opening of the email, so a passing mention of a name further down the message
 * never triggers a route.
 */
function matchesGreeting(opening, name) {
  const n = escapeRegex(name)
  const greeted = new RegExp(`\\b(?:hi|hello|hey|dear|good\\s+(?:morning|afternoon|evening))\\b[,\\s]+${n}\\b`, 'i')
  const bare    = new RegExp(`^\\s*${n}\\s*[,:]`, 'i')
  return greeted.test(opening) || bare.test(opening)
}

// =============================================================================
// STEP 2 — THE AI
// =============================================================================

async function askClaude(email, settings) {
  const body = plainBody(email).slice(0, 6000)

  const emailBlock = [
    `From: ${email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}`,
    `Subject: ${email.subject || '(no subject)'}`,
    `Received: ${email.received_at}`,
    ``,
    body || '(this email has no readable body)'
  ].join('\n')

  const response = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: 400,
    system:     settings.ai_prompt,
    messages: [{
      role: 'user',
      content: `Route this email. Reply with JSON only.\n\n<email>\n${emailBlock}\n</email>`
    }]
  })

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')

  const parsed = parseJson(text)

  return {
    destination:   String(parsed.destination || '').toLowerCase().trim(),
    department:    parsed.department    || '',
    reason:        parsed.reason        || '',
    primary_topic: parsed.primary_topic || '',
    sender_type:   parsed.sender_type   || 'Unknown',
    confidence:    String(parsed.confidence || '').toLowerCase().trim(),
    unsubscribe:   parsed.unsubscribe === true,
    source:        'ai',
    rule_id:       null
  }
}

/**
 * Pull the JSON object out of the model's reply.
 * Tolerates a ```json fence or a stray sentence around it.
 */
function parseJson(text) {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error(`Could not read the AI's answer as JSON: ${cleaned.slice(0, 200)}`)
  }
}

// =============================================================================
// STEP 3 — VALIDATE
//
// Everything below is a guardrail. Nothing here trusts the AI's answer.
// =============================================================================

function validate(decision, settings) {
  const held = (reason) => ({
    ...decision,
    confidence: 'low',
    reason:     reason,
    source:     decision.source === 'rule' ? 'rule' : 'error'
  })

  // "none" means junk. That is a valid answer and needs no destination check.
  if (decision.destination === 'none') {
    return { ...decision, confidence: 'high', department: decision.department || 'Not assigned' }
  }

  // Never send to an address outside BPM. A confused answer or a bad rule must
  // not be able to mail a resident's message to a stranger.
  if (!isBpmInbox(decision.destination)) {
    return held(`Wanted to send this to "${decision.destination}", which is not a BPM inbox. Held for a person.`)
  }

  // Never forward hello@ back to hello@ — that loops forever.
  if (decision.destination === settings.source_inbox) {
    return held(`Chose ${settings.source_inbox}, the same inbox it arrived in. Held for a person.`)
  }

  // Anything other than the three confidence levels is treated as uncertain.
  if (!['high', 'medium', 'low'].includes(decision.confidence)) {
    return held(`Gave an unclear confidence level. Held for a person.`)
  }

  return decision
}

// =============================================================================
// LOADING
// =============================================================================

async function loadSettings() {
  const { data, error } = await supabase
    .from('routing_settings')
    .select('shadow_mode, enabled, source_inbox, classify_from, ai_prompt')
    .eq('id', 1)
    .single()

  if (error) {
    console.error('Could not load routing settings:', error.message)
    console.error('Has migration 036_hello_forwarding.sql been run in Supabase?')
    return null
  }
  return data
}

async function loadRules() {
  const { data, error } = await supabase
    .from('routing_rules')
    .select('id, label, match_field, match_text, destination, priority')
    .eq('active', true)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw new Error('Could not load routing rules: ' + error.message)
  return data || []
}

/**
 * New mail waiting on a decision.
 *
 * classify_from is the guard that matters here: it is set to the moment the
 * migration ran, so the years of existing hello@ history already sitting in
 * email_cache are never picked up and never forwarded.
 */
async function loadUnroutedEmails(settings) {
  const { data, error } = await supabase
    .from('email_cache')
    .select('id, subject, from_address, from_name, to_address, m365_message_id, body_preview, body_html, received_at')
    .eq('to_address', settings.source_inbox)
    .is('routed_at', null)
    .gte('received_at', settings.classify_from)
    .order('received_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (error) throw new Error('Could not load emails: ' + error.message)
  return data || []
}

// =============================================================================
// WRITING
// =============================================================================

/**
 * Append to the permanent audit log. performed_by is left empty and actor is
 * 'system', which is how a decision made by this script is told apart from one
 * a team member made by clicking something.
 */
async function logAction(emailId, actionType, decision) {
  const { error } = await supabase.from('email_actions').insert({
    email_id:     emailId,
    action_type:  actionType,
    actor:        'system',
    performed_by: null,
    forwarded_to: decision.destination === 'none' ? null : decision.destination,
    reply_body:   null
  })
  if (error) console.warn(`  [audit] Could not log ${actionType}: ${error.message}`)
}

async function bumpRuleHitCount(ruleId) {
  const { data } = await supabase
    .from('routing_rules')
    .select('hit_count')
    .eq('id', ruleId)
    .single()

  await supabase
    .from('routing_rules')
    .update({ hit_count: (data?.hit_count ?? 0) + 1, last_hit_at: new Date().toISOString() })
    .eq('id', ruleId)
}

/**
 * Something went wrong on this email — a Gmail error, an unreadable AI reply.
 * Mark it so it shows up in the "needs a human" queue instead of silently
 * disappearing, and so the next run does not try it again forever.
 */
async function recordFailure(email, err) {
  await supabase
    .from('email_cache')
    .update({
      routed_to:          null,
      routing_reason:     `Could not classify this one: ${String(err.message || err).slice(0, 300)}`,
      routing_confidence: 'low',
      routing_source:     'error',
      routed_at:          new Date().toISOString()
    })
    .eq('id', email.id)
}

// =============================================================================
// SMALL HELPERS
// =============================================================================

function lower(str) {
  return String(str || '').toLowerCase()
}

/** The email as readable text, with any HTML markup stripped out. */
function plainBody(email) {
  if (email.body_html) {
    return email.body_html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return email.body_preview || ''
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export { run as classifyHelloEmails }

// Run only when started directly (node src/email/classify.js).
// When the API server imports it, the server decides when it runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
