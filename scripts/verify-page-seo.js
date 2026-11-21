// backend/scripts/verify-page-seo.js
//
// Verification for the page_seo seed:
//   1. GET /api/seo/<key> returns 200 for every official key.
//   2. meta_title / meta_description match frontend/lib/pageSeo.js EXACTLY.
//   3. Lengths (raw values) reported; flags >60 / >155.
//   4. FAQs present + English for room:deluxe-room and page:stay-camp.
//
// Usage: node backend/scripts/verify-page-seo.js

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.NEXT_PUBLIC_API_URL || process.env.API_BASE || 'http://localhost:5000/api';
const PAGE_SEO_FILE = path.join(__dirname, '..', '..', 'frontend', 'lib', 'pageSeo.js');

function loadDefaults() {
  const src = fs.readFileSync(PAGE_SEO_FILE, 'utf8');
  const start = src.indexOf('export const PAGE_SEO_DEFAULTS = {');
  if (start === -1) throw new Error('PAGE_SEO_DEFAULTS not found');
  const end = src.indexOf('\n};', start);
  if (end === -1) throw new Error('end of PAGE_SEO_DEFAULTS not found');
  let body = src.slice(start, end + 3).replace('export const PAGE_SEO_DEFAULTS =', 'module.exports =');
  const m = { exports: {} };
  new Function('module', 'exports', body)(m, m.exports);
  return m.exports;
}

async function main() {
  const defs = loadDefaults();
  const keys = Object.keys(defs);
  const results = [];

  for (const key of keys) {
    const url = `${API_BASE}/seo/${encodeURIComponent(key)}`;
    let status = 0;
    let json = null;
    try {
      const res = await fetch(url);
      status = res.status;
      json = res.ok ? await res.json() : null;
    } catch (err) {
      status = `ERR:${err.message}`;
    }

    const def = defs[key];
    const titleMatch = json && json.meta_title === def.title;
    const descMatch = json && json.meta_description === def.description;
    results.push({
      key,
      status,
      tLen: json ? (json.meta_title || '').length : '-',
      dLen: json ? (json.meta_description || '').length : '-',
      titleMatch,
      descMatch,
      faqs: json ? json.faqs.length : '-',
      ogImage: json ? json.og_image : '-',
      noindex: json ? json.noindex : '-',
      dbTitle: json ? json.meta_title : null,
      dbDesc: json ? json.meta_description : null,
      defTitle: def.title,
      defDesc: def.description,
    });
  }

  console.log('KEY'.padEnd(24), 'STAT', 'T', 'D', 'T=', 'D=', 'FAQ', 'noindex');
  let diffs = 0;
  let over = 0;
  for (const r of results) {
    if (!r.titleMatch) diffs++;
    if (!r.descMatch) diffs++;
    if (typeof r.tLen === 'number' && r.tLen > 60) over++;
    if (typeof r.dLen === 'number' && r.dLen > 155) over++;
    console.log(
      r.key.padEnd(24),
      String(r.status).padEnd(4),
      String(r.tLen).padStart(3),
      String(r.dLen).padStart(3),
      (r.titleMatch ? 'ok' : 'XX').padEnd(2),
      (r.descMatch ? 'ok' : 'XX').padEnd(2),
      String(r.faqs).padStart(3),
      String(r.noindex).padEnd(2)
    );
  }

  console.log('\nDetail of any mismatches:');
  for (const r of results) {
    if (!r.titleMatch || !r.descMatch) {
      console.log(`\n${r.key}`);
      if (!r.titleMatch) {
        console.log(`  title DB : ${JSON.stringify(r.dbTitle)}`);
        console.log(`  title def: ${JSON.stringify(r.defTitle)}`);
      }
      if (!r.descMatch) {
        console.log(`  desc  DB : ${JSON.stringify(r.dbDesc)}`);
        console.log(`  desc  def: ${JSON.stringify(r.defDesc)}`);
      }
    }
  }

  console.log(`\nSummary: ${keys.length} keys, ${results.filter((r) => r.status === 200).length} HTTP 200, ` +
    `${diffs} field mismatch(es), ${over} length-limit overflow(s).`);

  // ── FAQ language sanity ──
  const faqTargets = ['room:deluxe-room', 'page:stay-camp'];
  console.log('\nFAQ check:');
  for (const key of faqTargets) {
    const r = results.find((x) => x.key === key);
    console.log(`  ${key}: ${r.faqs} faq(s)`);
    if (Array.isArray(r.dbTitle)) continue;
    const res = await fetch(`${API_BASE}/seo/${encodeURIComponent(key)}`);
    const data = res.ok ? await res.json() : { faqs: [] };
    for (const f of data.faqs) {
      console.log(`    [${f.position}] Q: ${f.question}`);
      console.log(`         A: ${f.answer}`);
    }
  }
}

main().catch((err) => {
  console.error('Verify error:', err.message);
  process.exit(1);
});