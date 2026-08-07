import fs from 'fs';
import path from 'path';

const API_KEY = 'e7f431b6b4e6ff9c2f18c9fee1afc188';
const BASE_URL = 'https://api.jotform.com';
const OUTPUT_DIR = path.join('C:\\', 'JotformExport');

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '-').trim().substring(0, 80);
}

async function api(endpoint, extraParams = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  url.searchParams.set('apiKey', API_KEY);
  url.searchParams.set('limit', '1000');
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const json = await res.json();
  if (json.responseCode !== 200) throw new Error(`API error: ${json.message}`);
  return json.content;
}

async function downloadFile(fileUrl, destPath) {
  try {
    const url = fileUrl.includes('?') ? `${fileUrl}&apiKey=${API_KEY}` : `${fileUrl}?apiKey=${API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(buf));
    return true;
  } catch {
    return false;
  }
}

function submissionsToCSV(submissions) {
  if (!submissions || submissions.length === 0) return 'No submissions found\n';

  const fieldMap = new Map();
  for (const sub of submissions) {
    if (!sub.answers) continue;
    for (const [id, ans] of Object.entries(sub.answers)) {
      if (!fieldMap.has(id)) fieldMap.set(id, ans.text || ans.name || id);
    }
  }

  const metaCols = ['Submission ID', 'Date Submitted', 'IP Address', 'Status'];
  const fieldIds = [...fieldMap.keys()];
  const fieldLabels = fieldIds.map(id => fieldMap.get(id));
  const headers = [...metaCols, ...fieldLabels];

  const escape = v => {
    const s = String(v ?? '').replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
  };

  const rows = submissions.map(sub => {
    const meta = [sub.id || '', sub.created_at || '', sub.ip || '', sub.status || ''];
    const answers = fieldIds.map(id => {
      const ans = sub.answers?.[id];
      if (!ans) return '';
      const val = ans.answer;
      if (Array.isArray(val)) return val.join('; ');
      if (typeof val === 'object' && val !== null) return JSON.stringify(val);
      return val || '';
    });
    return [...meta, ...answers];
  });

  return [headers, ...rows].map(row => row.map(escape).join(',')).join('\n');
}

function isFileUrl(val) {
  if (typeof val !== 'string') return false;
  return val.startsWith('http') && (val.includes('jotform.com/uploads') || val.includes('jotform.io/uploads'));
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Connecting to Jotform...');
  const forms = await api('/user/forms');
  console.log(`Found ${forms.length} forms\n`);

  const log = [];
  let formNum = 0;

  for (const form of forms) {
    formNum++;
    const count = parseInt(form.count) || 0;

    if (count === 0) {
      console.log(`[${formNum}/${forms.length}] SKIP: ${form.title} — 0 submissions`);
      log.push(`SKIPPED | ${form.title} | 0 submissions`);
      continue;
    }

    console.log(`[${formNum}/${forms.length}] Downloading: ${form.title} (${count} submissions)...`);
    const formDir = path.join(OUTPUT_DIR, sanitize(form.title));
    fs.mkdirSync(formDir, { recursive: true });

    try {
      // Paginate submissions
      let allSubs = [];
      let offset = 0;
      while (true) {
        const batch = await api(`/form/${form.id}/submissions`, { offset: String(offset) });
        if (!batch || batch.length === 0) break;
        allSubs = allSubs.concat(batch);
        if (batch.length < 1000) break;
        offset += 1000;
      }

      // Save CSV
      const csv = submissionsToCSV(allSubs);
      fs.writeFileSync(path.join(formDir, 'submissions.csv'), csv, 'utf8');
      console.log(`  ✓ ${allSubs.length} submissions saved`);

      // Download uploaded files
      const filesDir = path.join(formDir, 'uploaded-files');
      let fileCount = 0;
      let fileErrors = 0;

      for (const sub of allSubs) {
        if (!sub.answers) continue;
        for (const [, ans] of Object.entries(sub.answers)) {
          const val = ans.answer;
          if (!val) continue;

          const candidates = Array.isArray(val) ? val : [val];
          for (const candidate of candidates) {
            if (!isFileUrl(candidate)) continue;
            fs.mkdirSync(filesDir, { recursive: true });
            const ext = path.extname(candidate.split('?')[0]) || '';
            const basename = path.basename(candidate.split('?')[0]);
            const filename = `${sub.id}_${basename}`;
            const ok = await downloadFile(candidate, path.join(filesDir, filename));
            if (ok) fileCount++;
            else fileErrors++;
          }
        }
      }

      if (fileCount > 0) console.log(`  ✓ ${fileCount} uploaded files downloaded`);
      if (fileErrors > 0) console.log(`  ⚠ ${fileErrors} files could not be downloaded`);

      log.push(`OK | ${form.title} | ${allSubs.length} submissions | ${fileCount} files`);

    } catch (err) {
      console.error(`  ✗ ERROR: ${err.message}`);
      log.push(`ERROR | ${form.title} | ${err.message}`);
    }
  }

  const summary = [
    '=== JOTFORM EXPORT SUMMARY ===',
    `Date: ${new Date().toLocaleString()}`,
    `Total forms: ${forms.length}`,
    '',
    ...log
  ].join('\n');

  fs.writeFileSync(path.join(OUTPUT_DIR, 'export-log.txt'), summary, 'utf8');

  console.log('\n============================');
  console.log('EXPORT COMPLETE');
  console.log(`Saved to: ${OUTPUT_DIR}`);
  console.log('Check export-log.txt for full summary.');
  console.log('============================');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
