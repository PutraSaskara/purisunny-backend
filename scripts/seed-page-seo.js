// backend/scripts/seed-page-seo.js
//
// Idempotent seed for the SEO dashboard data:
//   • page_seo  — one row for each official page key defined in pageSeo.js
//   • faq_items — English FAQs for room:deluxe-room (3) and page:stay-camp (2)
//
// SINGLE SOURCE OF TRUTH: the title / description values are read AT RUNTIME
// from frontend/lib/pageSeo.js (PAGE_SEO_DEFAULTS). They are NOT duplicated
// here, so the seed can never drift from the frontend defaults again.
//
// pageSeo.js is an ESM module that also imports `react` (next/cache helper), so
// it cannot be required directly from this CommonJS script. We therefore read
// the file, isolate the `PAGE_SEO_DEFAULTS = { ... }` object literal and
// evaluate just that literal. This is robust to the surrounding module code and
// to how many other exports the file gains over time. Only FAQ content (real
// seed data) is kept inline below.
//
// Behaviour:
//   • page_seo upsert: INSERT … ON DUPLICATE KEY UPDATE meta_title/meta_description
//     ONLY. Existing rows keep their og_image / noindex; new rows get NULL / 0.
//   • faq_items: FAQs are fully replaced (DELETE + INSERT) for the two keys that
//     have them, preserving position.
//   • After the writes, fire the frontend revalidation webhook
//     (POST /api/revalidate, type 'page') for every key.
//
// Usage (from the repo root or backend/):
//   node backend/scripts/seed-page-seo.js
//
// Safe to run repeatedly.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../config/db');

const PAGE_SEO_FILE = path.join(__dirname, '..', '..', 'frontend', 'lib', 'pageSeo.js');

const FRONTEND_INTERNAL_URL = (process.env.FRONTEND_INTERNAL_URL || 'http://localhost:3000').replace(/\/+$/, '');
const REVALIDATE_SECRET = process.env.REVALIDATE_SECRET;

// ── Extract a balanced {...} object literal starting at `openIndex` ──
// Handles quoted strings (with escapes) and line/block comments, so it is not
// fooled by braces or quotes appearing inside them. More robust than scanning
// for a trailing "};", which breaks if the file is reformatted.
function extractObjectLiteral(src, openIndex) {
  if (src[openIndex] !== '{') {
    throw new Error('extractObjectLiteral: expected "{" at openIndex');
  }

  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }

    // Comments (skip entirely).
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i + 2);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close === -1) throw new Error('Unterminated block comment');
      i = close + 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openIndex, i + 1);
    }
  }

  throw new Error('Unterminated object literal for PAGE_SEO_DEFAULTS');
}

// ── Load PAGE_SEO_DEFAULTS from frontend/lib/pageSeo.js at runtime ──
function loadPageSeoDefaults() {
  const src = fs.readFileSync(PAGE_SEO_FILE, 'utf8');

  const declIndex = src.indexOf('export const PAGE_SEO_DEFAULTS');
  if (declIndex === -1) {
    throw new Error(`PAGE_SEO_DEFAULTS not found in ${PAGE_SEO_FILE}`);
  }
  const openIndex = src.indexOf('{', declIndex);
  if (openIndex === -1) {
    throw new Error('Could not locate the start of PAGE_SEO_DEFAULTS');
  }

  const literal = extractObjectLiteral(src, openIndex);
  const objectSource = `module.exports = ${literal};`;

  // Evaluate only the object literal — no module imports, no side effects.
  const mod = { exports: {} };
  new Function('module', 'exports', objectSource)(mod, mod.exports);

  const defaults = mod.exports;
  const keys = Object.keys(defaults);
  if (keys.length === 0) {
    throw new Error('PAGE_SEO_DEFAULTS evaluated to an empty object');
  }
  for (const key of keys) {
    const entry = defaults[key];
    if (!entry || typeof entry.title !== 'string' || typeof entry.description !== 'string') {
      throw new Error(`PAGE_SEO_DEFAULTS["${key}"] is missing a title/description`);
    }
  }
  return defaults;
}

// ── English FAQs (translated from the Indonesian originals; kept inline) ──
// Facts preserved exactly: 30 sqm, double bed, extra bed on request, open-air
// bathroom, rice-field / Mount Batukaru / garden balcony views, 12 rooms on
// Petaluh Street, shared outdoor stone-and-bamboo bathrooms with hot water.
const FAQ_EN = {
  'room:deluxe-room': [
    {
      question: 'Does the Deluxe Room have a balcony?',
      answer:
        'Yes, every Deluxe Room has a private balcony with views of the terraced rice fields, Mount Batukaru, or the garden. The balcony is fitted with wide glass doors that open directly from the room.',
    },
    {
      question: 'What is the size of the Deluxe Room and how many guests can it accommodate?',
      answer:
        'The Deluxe Room is 30 square metres with a double bed and can accommodate up to 3 guests (an extra bed is available on request at an additional charge).',
    },
    {
      question: 'Does the Deluxe Room have an en-suite bathroom?',
      answer:
        'The Deluxe Room has an open-air bathroom with a toilet and a shower open to the sky, surrounded by natural stone walls for a unique outdoor bathing experience.',
    },
  ],
  'page:stay-camp': [
    {
      question: 'What is the difference between Puri Sunny Camp and the Guest House?',
      answer:
        'Puri Sunny Camp sits on the river valley edge of Petaluh Street with 12 rooms surrounded by rice fields and gardens. Unlike the Guest House, which is set high on the ridge, the Camp offers a simpler, closer-to-nature stay with handcrafted bamboo and timber rooms and a large natural spring pool.',
    },
    {
      question: 'Are the bathrooms at the Camp shared facilities?',
      answer:
        'Yes, the bathrooms and toilets at Puri Sunny Camp are outdoor and shared with fellow Camp guests. They are located in a clean stone and bamboo pavilion with hot water, washbasins, and Western seated toilets, surrounded by lush tropical foliage.',
    },
  ],
};

async function upsertPage({ key, title, description }) {
  await db.query(
    `INSERT INTO page_seo (page_key, meta_title, meta_description, og_image, noindex)
     VALUES (?, ?, ?, NULL, 0)
     ON DUPLICATE KEY UPDATE
       meta_title = VALUES(meta_title),
       meta_description = VALUES(meta_description)`,
    [key, title, description]
  );
}

async function replaceFaqs(pageKey, faqs) {
  await db.query('DELETE FROM faq_items WHERE page_key = ?', [pageKey]);
  if (!faqs || faqs.length === 0) return;
  const placeholders = faqs.map(() => '(?, ?, ?, ?)').join(', ');
  const values = [];
  faqs.forEach((faq, i) => {
    values.push(pageKey, faq.question, faq.answer, i);
  });
  await db.query(
    `INSERT INTO faq_items (page_key, question, answer, position) VALUES ${placeholders}`,
    values
  );
}

async function revalidate(pageKey) {
  if (!REVALIDATE_SECRET) {
    console.warn('[revalidate] REVALIDATE_SECRET not set; skipping');
    return false;
  }
  try {
    const res = await fetch(`${FRONTEND_INTERNAL_URL}/api/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-revalidate-secret': REVALIDATE_SECRET,
      },
      body: JSON.stringify({ slug: pageKey, type: 'page' }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[revalidate] ${pageKey} -> ${res.status} ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[revalidate] ${pageKey} failed: ${err.message}`);
    return false;
  }
}

async function seed() {
  const defaults = loadPageSeoDefaults();
  const pages = Object.keys(defaults).map((key) => ({
    key,
    title: defaults[key].title,
    description: defaults[key].description,
  }));

  console.log(`Loaded ${pages.length} page keys from ${PAGE_SEO_FILE}\n`);
  console.log('Seeding page_seo…\n');

  let warnings = 0;
  for (const page of pages) {
    const tLen = page.title.length;
    const dLen = page.description.length;
    const flags = [];
    if (tLen > 60) flags.push(`TITLE>${60}`);
    if (dLen > 155) flags.push(`DESC>${155}`);
    if (flags.length) warnings++;

    await upsertPage(page);
    console.log(
      `  ${page.key.padEnd(24)} title=${String(tLen).padStart(3)} desc=${String(dLen).padStart(3)} ${flags.join(' ') || 'OK'}`
    );
  }

  console.log('\nfaq_items (English):');
  for (const [pageKey, faqs] of Object.entries(FAQ_EN)) {
    await replaceFaqs(pageKey, faqs);
    console.log(`  ${pageKey.padEnd(24)} ${faqs.length} FAQs`);
  }

  console.log('\nRevalidating frontend (type=page)…');
  let ok = 0;
  for (const page of pages) {
    if (await revalidate(page.key)) ok++;
  }
  console.log(`  ${ok}/${pages.length} revalidated`);

  const faqTotal = Object.values(FAQ_EN).reduce((n, f) => n + f.length, 0);
  console.log(`\nSeed complete. ${pages.length} page keys, ${faqTotal} FAQs.`);
  if (warnings) {
    console.warn(`WARNING: ${warnings} value(s) exceed the recommended length limits.`);
  }
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed error:', err.message);
    process.exit(1);
  });