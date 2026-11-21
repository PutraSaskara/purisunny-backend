// backend/services/seo.js
//
// Business logic for the SEO dashboard API (18 page keys).
// Express-free: routes only authenticate and translate thrown errors.

const realDb = require('../config/db');
const { normalizeSeoFields } = require('../utils/validateSeo');
const { normalizeKeywords } = require('../utils/validateKeywords');
const { cleanupCloudinaryAssets } = require('../utils/cloudinaryCleanup');
const { triggerRevalidateSafe } = require('../utils/revalidate');
const { httpError } = require('./errors');

// ── The 18 official page keys — validated on mutation ──
const VALID_PAGE_KEYS = [
  'page:home',
  'page:our-story',
  'page:stay',
  'page:stay-guest-house',
  'page:stay-camp',
  'page:rooms',
  'page:experience',
  'page:explore-munduk',
  'page:journal',
  'page:reviews',
  'page:gallery',
  'page:contact',
  'room:deluxe-room',
  'room:superior-room',
  'room:standard-double',
  'room:standard-twin',
  'room:standard-camp',
  'room:family-camp',
];

const MAX_FAQS = 20;

let db = realDb;

function __setDbForTests(fake) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setDbForTests is not available in production');
  }
  if (fake === null || fake === undefined) {
    db = realDb;
    return;
  }
  if (typeof fake.query !== 'function' || typeof fake.getConnection !== 'function') {
    throw new Error('db fake must expose query() and getConnection()');
  }
  db = fake;
}

function invalidPageKey(pageKey) {
  return httpError(400, {
    message: `Invalid page_key "${pageKey}". Must be one of the 18 official keys.`,
    validKeys: VALID_PAGE_KEYS,
  });
}

// ── Validate array of FAQ items ──
function validateFaqs(faqs) {
  const errors = [];
  if (!Array.isArray(faqs)) {
    return { errors: ['faqs must be an array'], items: [] };
  }
  if (faqs.length > MAX_FAQS) {
    errors.push(`faqs must have at most ${MAX_FAQS} items`);
    return { errors, items: [] };
  }

  const items = [];
  for (let i = 0; i < faqs.length; i++) {
    const faq = faqs[i];
    if (!faq || typeof faq !== 'object') {
      errors.push(`faqs[${i}] must be an object`);
      continue;
    }
    const question = typeof faq.question === 'string' ? faq.question.trim() : '';
    const answer = typeof faq.answer === 'string' ? faq.answer.trim() : '';

    if (!question) {
      errors.push(`faqs[${i}].question is required and must be a non-empty string`);
    }
    if (!answer) {
      errors.push(`faqs[${i}].answer is required and must be a non-empty string`);
    }
    if (question.length > 255) {
      errors.push(`faqs[${i}].question must be at most 255 characters`);
    }

    items.push({ question, answer, position: i });
  }

  return { errors, items };
}

// ── Helper: fetch one page_seo + its faqs ──
async function fetchPageWithFaqs(pageKey) {
  const [rows] = await db.query(
    'SELECT page_key, meta_title, meta_description, og_image, noindex, keywords, created_at, updated_at FROM page_seo WHERE page_key = ?',
    [pageKey]
  );
  if (rows.length === 0) return null;

  const [faqs] = await db.query(
    'SELECT question, answer, position FROM faq_items WHERE page_key = ? ORDER BY position ASC',
    [pageKey]
  );

  const page = rows[0];
  return {
    page_key: page.page_key,
    meta_title: page.meta_title,
    meta_description: page.meta_description,
    og_image: page.og_image,
    noindex: page.noindex,
    keywords: page.keywords,
    faqs: faqs.map((f) => ({
      question: f.question,
      answer: f.answer,
      position: f.position,
    })),
    // Timestamps back the sitemap lastmod and the dashboard's "last edited".
    created_at: page.created_at,
    updated_at: page.updated_at,
  };
}

// GET /api/seo — public, list ALL 18 pages (with faqs)
async function list() {
  const [pages] = await db.query(
    'SELECT page_key, meta_title, meta_description, og_image, noindex, keywords, created_at, updated_at FROM page_seo ORDER BY page_key ASC'
  );

  // Build a map of existing entries for O(1) lookup
  const pageMap = {};
  for (const page of pages) {
    pageMap[page.page_key] = page;
  }

  // Fetch all faqs in one query and group by page_key
  const [allFaqs] = await db.query('SELECT * FROM faq_items ORDER BY page_key ASC, position ASC');
  const faqMap = {};
  for (const faq of allFaqs) {
    if (!faqMap[faq.page_key]) faqMap[faq.page_key] = [];
    faqMap[faq.page_key].push({
      question: faq.question,
      answer: faq.answer,
      position: faq.position,
    });
  }

  // Build response for all 18 keys — existing values or null defaults.
  // Timestamps are null for keys that have no page_seo row yet.
  const result = VALID_PAGE_KEYS.map((pageKey) => {
    const page = pageMap[pageKey];
    return {
      page_key: pageKey,
      meta_title: page ? page.meta_title : null,
      meta_description: page ? page.meta_description : null,
      og_image: page ? page.og_image : null,
      noindex: page ? page.noindex : 0,
      keywords: page ? page.keywords : null,
      faqs: faqMap[pageKey] || [],
      created_at: page ? page.created_at : null,
      updated_at: page ? page.updated_at : null,
    };
  });

  return { pages: result };
}

// GET /api/seo/:pageKey — public, single page + faqs
async function get(pageKey) {
  return fetchPageWithFaqs(pageKey);
}

// PUT /api/seo/:pageKey — authenticated, UPSERT page + replace faqs
async function upsert(pageKey, body = {}) {
  // Validate page_key against the official list
  if (!VALID_PAGE_KEYS.includes(pageKey)) {
    throw invalidPageKey(pageKey);
  }

  // Validate SEO fields
  const { errors: seoErrors, values } = normalizeSeoFields(body);
  if (seoErrors.length > 0) {
    throw httpError(400, { message: seoErrors[0], errors: seoErrors });
  }

  // Optional meta keywords: same contract as the article routes.
  const keywords = normalizeKeywords(body.keywords);
  if (keywords.error) {
    throw httpError(400, { message: keywords.error, errors: [keywords.error] });
  }

  // Validate faqs
  const faqsInput = body.faqs !== undefined ? body.faqs : [];
  const { errors: faqErrors, items: faqItems } = validateFaqs(faqsInput);
  if (faqErrors.length > 0) {
    throw httpError(400, { message: faqErrors[0], errors: faqErrors });
  }

  // Previous og_image, so a replacement can release the old asset (if our
  // cleanup later finds it unreferenced and tagged).
  const [previousRows] = await db.query('SELECT og_image FROM page_seo WHERE page_key = ?', [pageKey]);
  const previousOgImage = previousRows.length > 0 ? previousRows[0].og_image : null;

  // ── Atomic write: page_seo upsert + faq_items replace ──
  // Both statements run on one pool connection inside a transaction so a
  // failed FAQ insert (e.g. oversized answer, deadlock) rolls back the
  // page_seo upsert too — the previous SEO state (page + faqs) stays intact.
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Upsert page_seo
    await connection.query(
      `INSERT INTO page_seo (page_key, meta_title, meta_description, og_image, noindex, keywords)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         meta_title = VALUES(meta_title),
         meta_description = VALUES(meta_description),
         og_image = VALUES(og_image),
         noindex = VALUES(noindex),
         keywords = VALUES(keywords)`,
      [pageKey, values.meta_title, values.meta_description, values.og_image, values.noindex, keywords.value]
    );

    // Replace ALL faqs for this page_key (delete old, insert new)
    await connection.query('DELETE FROM faq_items WHERE page_key = ?', [pageKey]);

    if (faqItems.length > 0) {
      const placeholders = faqItems.map(() => '(?, ?, ?, ?)').join(', ');
      const flatValues = [];
      for (const item of faqItems) {
        flatValues.push(pageKey, item.question, item.answer, item.position);
      }
      await connection.query(
        `INSERT INTO faq_items (page_key, question, answer, position) VALUES ${placeholders}`,
        flatValues
      );
    }

    await connection.commit();
  } catch (txError) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('Upsert page SEO rollback error:', rollbackError.message);
    }
    throw txError;
  } finally {
    // Always hand the connection back, otherwise the pool starves.
    connection.release();
  }

  // Fire-and-forget: revalidate frontend cache for this page_key with type 'page'
  triggerRevalidateSafe(pageKey, 'page');

  // A replaced og_image may now be orphaned. Cleanup runs post-commit, never
  // throws, and skips anything still referenced elsewhere or untagged.
  const previousOg = previousOgImage == null ? '' : previousOgImage;
  const nextOg = values.og_image == null ? '' : values.og_image;
  if (previousOg !== nextOg) {
    await cleanupCloudinaryAssets([previousOg], { db });
  }

  return fetchPageWithFaqs(pageKey);
}

// DELETE /api/seo/:pageKey — admin only, delete page + faqs
async function remove(pageKey) {
  // Validate page_key against the official list
  if (!VALID_PAGE_KEYS.includes(pageKey)) {
    throw invalidPageKey(pageKey);
  }

  const [existing] = await db.query('SELECT page_key, og_image FROM page_seo WHERE page_key = ?', [pageKey]);
  if (existing.length === 0) {
    throw httpError(404, { message: 'Page not found' });
  }
  const deletedOgImage = existing[0].og_image;

  // faq_items.page_key has an ON DELETE CASCADE FK, so deleting the page also
  // removes its FAQs. The explicit FAQ delete is kept as belt-and-braces for
  // databases that have not run migrate-page-seo-fk-index.js yet (same final
  // state either way), and it keeps this statement independent of FK ordering.
  await db.query('DELETE FROM faq_items WHERE page_key = ?', [pageKey]);
  await db.query('DELETE FROM page_seo WHERE page_key = ?', [pageKey]);

  // Fire-and-forget: revalidate frontend cache with type 'page'
  triggerRevalidateSafe(pageKey, 'page');

  // The row is gone; release its og_image if nothing else uses it.
  await cleanupCloudinaryAssets([deletedOgImage], { db });

  return { pageKey };
}

module.exports = {
  VALID_PAGE_KEYS,
  invalidPageKey,
  list,
  get,
  upsert,
  remove,
  __setDbForTests,
};
