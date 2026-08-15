/**
 * find-placeholders.mjs — one-time utility
 * Finds the exact PDF coordinates of <<placeholder>> tokens in both agreement templates.
 * Run: node src/onboarding/find-placeholders.mjs
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TEMPLATES = [
  { name: 'pma.pdf',          label: 'PMA' },
  { name: 'lease-listing.pdf', label: 'Lease Listing' },
]

const PLACEHOLDERS = [
  '<<Owner Name(s)>>',
  '<<Company Name>>',
  '<<Property Address>>',
  '<<Management Start Date>>',
  '<<Agreement Termination Date>>',
]

async function findInTemplate(filename, label) {
  const filepath = path.join(__dirname, 'templates', filename)
  const data = new Uint8Array(readFileSync(filepath))
  const doc  = await getDocument({ data }).promise

  console.log(`\n=== ${label} (${filename}) — ${doc.numPages} pages ===`)

  const results = []

  for (let pageNum = 1; pageNum <= Math.min(doc.numPages, 3); pageNum++) {
    const page    = await doc.getPage(pageNum)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()

    // pdfjs returns individual text items; some placeholders may be split across items
    // Reconstruct a combined view with positions
    const items = content.items.filter(i => i.str && i.str.trim())

    // Build a concatenated string with position map for multi-item tokens
    for (const item of items) {
      for (const ph of PLACEHOLDERS) {
        if (item.str.includes(ph)) {
          const tx = item.transform
          // tx = [scaleX, skewY, skewX, scaleY, translateX, translateY]
          // PDF y=0 is bottom; pdfjs uses bottom-left origin
          const x    = tx[4]
          const yBot = tx[5]
          const yTop = yBot + (item.height || Math.abs(tx[3]))
          const pdfH = viewport.height

          results.push({
            placeholder: ph,
            page: pageNum,
            x: Math.round(x),
            y_bottom: Math.round(yBot),
            y_top: Math.round(yTop),
            pdf_height: Math.round(pdfH),
            // For pdf-lib: y=0 is bottom, same as pdfjs
            text_snippet: item.str.substring(0, 80),
          })
          console.log(`  [page ${pageNum}] ${ph}`)
          console.log(`    x=${Math.round(x)}, y_bottom=${Math.round(yBot)}, y_top=${Math.round(yTop)}, page_height=${Math.round(pdfH)}`)
          console.log(`    in: "${item.str.substring(0, 80)}"`)
        }
      }
    }
  }

  return results
}

for (const t of TEMPLATES) {
  await findInTemplate(t.name, t.label)
}
