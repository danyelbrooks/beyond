/**
 * notion-import.js — One-time import from Notion into the BPM SOP system
 *
 * Pulls every SOP page from BPM UNIVERSITY HQ in Notion and inserts them
 * into the sops table in Supabase, mapped to the correct category.
 *
 * Usage:
 *   node src/import/notion-import.js
 *
 * Required env vars (.env):
 *   NOTION_TOKEN       — Internal Integration Token from notion.so/my-integrations
 */

import 'dotenv/config'
import { Client }     from '@notionhq/client'
import { createClient } from '@supabase/supabase-js'

const notion   = new Client({ auth: process.env.NOTION_TOKEN })
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// =============================================================================
// CATEGORY MAPPING — Notion page title → our sop_categories.name
// =============================================================================

const CATEGORY_MAP = {
  'ACCOUNTING':                  'Accounting',
  'BANKING':                     'Banking',
  'BANKING: ENTERPRISE BANK':    'Banking',
  'BPM BEST PRACTICES':          'BPM Best Practices',
  'BPM TASK MAP':                'BPM Task Map',
  'BUSINESS OPERATING':          'Business Operating',
  'CHECKS & BALANCES':           'Checks & Balances',
  'EMPLOYEE MANUAL':             'Employee Manual',
  'EMPLOYEE ROLES':              'Employee Roles',
  'HOW TO / TRAINING':           'How To / Training',
  'K.P.I. / E.O.S. TRAINING':   'KPI / EOS Training',
  'KPI / EOS TRAINING':          'KPI / EOS Training',
  'LEAD SIMPLE':                 'LeadSimple',
  'LEADSIMPLE':                  'LeadSimple',
  'MAINTENANCE':                 'Maintenance',
  'MAINTENANCE COMPANY':         'Maintenance Company',
  'OFFICE SUPPLIES':             'Office Supplies',
  'REAL ESTATE':                 'Real Estate',
  'RESIDENT FEES':               'Resident Fees',
  'RESIDENT FEES PROCEDURES':    'Resident Fees Procedures',
  'RESIDENT FEES PROCEDUR':      'Resident Fees Procedures',
  'SOFTWARE- HOW TO':            'Software How-To',
  'SOFTWARE HOW TO':             'Software How-To',
  'SOFTWARE HOW-TO':             'Software How-To',
  'TENANT & LANDLORD LAW':       'Tenant & Landlord Law',
  'TENANT & LANDLORD LA':        'Tenant & Landlord Law',
  'VENDORS':                     'Vendors',
}

// =============================================================================
// MAIN
// =============================================================================

async function run() {
  console.log('=== BPM Notion Import ===')
  console.log('Connecting to Notion...')

  // 1. Load all our category IDs from Supabase
  const { data: cats, error: catErr } = await supabase
    .from('sop_categories')
    .select('id, name')
  if (catErr) { console.error('Could not load categories:', catErr.message); process.exit(1) }

  const categoryIdByName = {}
  for (const c of cats) categoryIdByName[c.name] = c.id
  console.log(`Loaded ${cats.length} categories from Supabase.`)

  // 2. Search Notion for all pages the integration can access
  console.log('\nSearching Notion for all accessible pages...')
  const allPages = await searchAllPages()
  console.log(`Found ${allPages.length} total pages in Notion.`)

  let totalImported = 0
  let totalSkipped  = 0

  // 3. For each page, check if its title matches one of our categories
  //    If yes → it's a category page; import its children as SOPs
  //    If no  → check if its PARENT title matches a category; if so import it directly
  const categoryPageIds = new Set()
  const categoryPageMap = {} // pageId → categoryName

  for (const page of allPages) {
    const title = getPageTitle(page).trim().toUpperCase()
    const ourCatName = findCategory(title)
    if (ourCatName && categoryIdByName[ourCatName]) {
      categoryPageIds.add(page.id)
      categoryPageMap[page.id] = ourCatName
    }
  }

  console.log(`Matched ${categoryPageIds.size} category pages.`)

  // 4. Import child pages of each category
  for (const page of allPages) {
    const parentId = page.parent?.page_id || page.parent?.block_id
    if (!parentId || !categoryPageIds.has(parentId)) continue

    const catName    = categoryPageMap[parentId]
    const categoryId = categoryIdByName[catName]
    const title      = getPageTitle(page) || 'Untitled'

    try {
      await importPage(page.id, title, categoryId)
      console.log(`  ✓ [${catName}] ${title}`)
      totalImported++
    } catch (err) {
      console.error(`  ✗ [${catName}] ${title}: ${err.message}`)
      totalSkipped++
    }
  }

  // Also import any category pages that are themselves SOPs (flat structure)
  for (const [pageId, catName] of Object.entries(categoryPageMap)) {
    const children = allPages.filter(p => (p.parent?.page_id || p.parent?.block_id) === pageId)
    if (children.length === 0) {
      // No children — the category page itself is an SOP
      const page  = allPages.find(p => p.id === pageId)
      const title = page ? getPageTitle(page) : catName
      try {
        await importPage(pageId, title, categoryIdByName[catName])
        console.log(`  ✓ [${catName}] ${title} (standalone)`)
        totalImported++
      } catch (err) {
        console.error(`  ✗ [${catName}] ${title}: ${err.message}`)
        totalSkipped++
      }
    }
  }

  console.log(`\n=== Done ===`)
  console.log(`Imported: ${totalImported}  |  Skipped: ${totalSkipped}`)
}

// =============================================================================
// IMPORT ONE PAGE
// =============================================================================

async function importPage(pageId, title, categoryId) {
  // Get page metadata for description (first paragraph)
  const blocks  = await getAllChildren(pageId)
  const html    = blocksToHtml(blocks)
  const desc    = extractDescription(blocks)

  // Check if already imported (by title + category to avoid duplicates on re-run)
  const { data: existing } = await supabase
    .from('sops')
    .select('id')
    .eq('title', title)
    .eq('category_id', categoryId)
    .limit(1)

  if (existing && existing.length > 0) {
    // Update existing rather than duplicate
    await supabase
      .from('sops')
      .update({ content: html, description: desc, updated_at: new Date().toISOString() })
      .eq('id', existing[0].id)
    return
  }

  await supabase.from('sops').insert({
    title,
    description: desc,
    category_id: categoryId,
    content:     html,
  })
}

// =============================================================================
// NOTION BLOCK → HTML CONVERTER
// =============================================================================

function blocksToHtml(blocks) {
  const parts = []
  let inBulletList    = false
  let inNumberedList  = false

  const closeLists = () => {
    if (inBulletList)   { parts.push('</ul>');  inBulletList   = false }
    if (inNumberedList) { parts.push('</ol>');  inNumberedList = false }
  }

  for (const block of blocks) {
    const type = block.type

    if (type !== 'bulleted_list_item' && inBulletList)   { parts.push('</ul>');  inBulletList   = false }
    if (type !== 'numbered_list_item' && inNumberedList) { parts.push('</ol>');  inNumberedList = false }

    switch (type) {
      case 'paragraph': {
        const text = richTextToHtml(block.paragraph?.rich_text)
        if (text.trim()) parts.push(`<p>${text}</p>`)
        else parts.push('<br>')
        break
      }
      case 'heading_1':
        parts.push(`<h1>${richTextToHtml(block.heading_1?.rich_text)}</h1>`)
        break
      case 'heading_2':
        parts.push(`<h2>${richTextToHtml(block.heading_2?.rich_text)}</h2>`)
        break
      case 'heading_3':
        parts.push(`<h3>${richTextToHtml(block.heading_3?.rich_text)}</h3>`)
        break
      case 'bulleted_list_item':
        if (!inBulletList) { parts.push('<ul>'); inBulletList = true }
        parts.push(`<li>${richTextToHtml(block.bulleted_list_item?.rich_text)}</li>`)
        break
      case 'numbered_list_item':
        if (!inNumberedList) { parts.push('<ol>'); inNumberedList = true }
        parts.push(`<li>${richTextToHtml(block.numbered_list_item?.rich_text)}</li>`)
        break
      case 'to_do': {
        const checked = block.to_do?.checked ? ' checked' : ''
        const text    = richTextToHtml(block.to_do?.rich_text)
        parts.push(`<p><input type="checkbox"${checked} disabled> ${text}</p>`)
        break
      }
      case 'toggle': {
        const summary = richTextToHtml(block.toggle?.rich_text)
        parts.push(`<details><summary>${summary}</summary></details>`)
        break
      }
      case 'quote':
        parts.push(`<blockquote>${richTextToHtml(block.quote?.rich_text)}</blockquote>`)
        break
      case 'callout': {
        const emoji = block.callout?.icon?.emoji || 'ℹ️'
        const text  = richTextToHtml(block.callout?.rich_text)
        parts.push(`<div style="background:#f0f6ff;border-left:4px solid #3498db;padding:12px 16px;margin:8px 0;border-radius:4px;">${emoji} ${text}</div>`)
        break
      }
      case 'code': {
        const code = block.code?.rich_text?.map(t => escHtml(t.plain_text)).join('')
        parts.push(`<pre style="background:#1e293b;color:#e2e8f0;padding:12px;border-radius:6px;overflow-x:auto;"><code>${code}</code></pre>`)
        break
      }
      case 'divider':
        parts.push('<hr>')
        break
      case 'image': {
        const url = block.image?.file?.url || block.image?.external?.url || ''
        const cap = block.image?.caption?.map(t => t.plain_text).join('') || ''
        if (url) parts.push(`<figure><img src="${escHtml(url)}" alt="${escHtml(cap)}" style="max-width:100%;border-radius:6px;"></figure>`)
        break
      }
      case 'bookmark':
      case 'link_preview': {
        const url     = block.bookmark?.url || block.link_preview?.url || ''
        const caption = block.bookmark?.caption?.map(t => t.plain_text).join('') || url
        if (url) parts.push(`<p><a href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(caption || url)}</a></p>`)
        break
      }
      case 'embed': {
        const url = block.embed?.url || ''
        if (url) parts.push(`<p><a href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(url)}</a></p>`)
        break
      }
      case 'child_page':
        // Sub-pages: show as a link placeholder
        parts.push(`<p><strong>📄 Sub-page: ${escHtml(block.child_page?.title || 'Untitled')}</strong></p>`)
        break
      default:
        break
    }
  }

  closeLists()
  return parts.join('\n')
}

function richTextToHtml(richText = []) {
  return richText.map(t => {
    let text = escHtml(t.plain_text)
    if (t.href)             text = `<a href="${escHtml(t.href)}" target="_blank" rel="noopener">${text}</a>`
    if (t.annotations?.bold)          text = `<strong>${text}</strong>`
    if (t.annotations?.italic)        text = `<em>${text}</em>`
    if (t.annotations?.strikethrough) text = `<s>${text}</s>`
    if (t.annotations?.underline)     text = `<u>${text}</u>`
    if (t.annotations?.code)          text = `<code>${text}</code>`
    return text
  }).join('')
}

function extractDescription(blocks) {
  for (const b of blocks) {
    if (b.type === 'paragraph') {
      const text = b.paragraph?.rich_text?.map(t => t.plain_text).join('').trim()
      if (text && text.length > 10) return text.slice(0, 200)
    }
  }
  return null
}

// =============================================================================
// NOTION API HELPERS
// =============================================================================

async function searchAllPages() {
  const results = []
  let cursor    = undefined

  do {
    const res = await notion.search({
      filter:       { property: 'object', value: 'page' },
      start_cursor: cursor,
      page_size:    100,
    })
    results.push(...res.results)
    cursor = res.next_cursor
  } while (cursor)

  return results
}

function getPageTitle(page) {
  const props = page.properties || {}
  const titleProp = props.title || props.Name || Object.values(props).find(p => p.type === 'title')
  if (titleProp?.title) return titleProp.title.map(t => t.plain_text).join('')
  return page.child_page?.title || ''
}

async function getAllChildren(blockId) {
  const results = []
  let cursor    = undefined

  do {
    const res = await notion.blocks.children.list({
      block_id:    blockId,
      start_cursor: cursor,
      page_size:   100
    })
    results.push(...res.results)
    cursor = res.next_cursor
  } while (cursor)

  return results
}

function findCategory(notionTitle) {
  // Exact match first
  if (CATEGORY_MAP[notionTitle]) return CATEGORY_MAP[notionTitle]
  // Partial match (handles truncated titles like "BANKING: ENTERPRISE BANK ...")
  for (const [key, val] of Object.entries(CATEGORY_MAP)) {
    if (notionTitle.startsWith(key) || key.startsWith(notionTitle)) return val
  }
  return null
}

function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// =============================================================================
// RUN
// =============================================================================

run().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
