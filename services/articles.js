// backend/services/articles.js
//
// Business logic for /api/articles. Express-free: routes only authenticate,
// parse route params, and translate the errors thrown here into responses.
//
// The SQL, validation ordering, transactions, FAQ replacement, slug redirects,
// Cloudinary cleanup and revalidation calls are the same as the original route
// implementation so the external contract is unchanged.

const realDb = require('../config/db');
const {
  MAX_TITLE_LENGTH,
  MAX_AUTHOR_LENGTH,
  MAX_COVER_IMAGE_LENGTH,
  isDuplicateEntry,
  optionalString,
  requiredString,
  validateSlug,
  coerceBoolean,
  coerceInteger,
  parseId,
  clampLegacyLimit,
} = require('../utils/validate');
const { normalizeSeoFields } = require('../utils/validateSeo');
const { normalizeKeywords } = require('../utils/validateKeywords');
const { validateArticleFaqs } = require('../utils/validateArticleFaq');
const {
  cleanupCloudinaryAssets,
  extractContentImageUrls,
} = require('../utils/cloudinaryCleanup');
const { triggerRevalidateSafe, triggerRedirectRevalidateSafe } = require('../utils/revalidate');
const { httpError } = require('./errors');

// Database pool used by the service. Tests swap in a fake via
// __setDbForTests so service logic can run without a live MySQL; production
// always uses config/db.
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

// ---------------------------------------------------------------------------
// Cloudinary cleanup candidates
// ---------------------------------------------------------------------------
// Values that changed between the stored row and the incoming body. Both
// sides may be null/empty; equal values (including both empty) contribute
// nothing. The DB-reference check inside cleanupCloudinaryAssets still runs,
// so a URL that moved to another field is protected as well.
function changedValue(oldValue, newValue) {
  const before = oldValue == null ? '' : oldValue;
  const after = newValue == null ? '' : newValue;
  return before === after ? [] : [before];
}

// Content images present in the old HTML but gone from the new HTML.
function removedContentImages(oldContent, newContent) {
  const next = new Set(extractContentImageUrls(newContent));
  return extractContentImageUrls(oldContent).filter((url) => !next.has(url));
}

// ---------------------------------------------------------------------------
// Article FAQ helpers
// ---------------------------------------------------------------------------
// FAQs are stored in their own table (article_faq_items, ON DELETE CASCADE).
// The public shape is exactly { id, question, answer, position }.

// Ordered read: position, then id (stable when two rows share a position).
async function fetchArticleFaqs(articleId, connection = db) {
  const [rows] = await connection.query(
    'SELECT id, question, answer, position FROM article_faq_items WHERE article_id = ? ORDER BY position ASC, id ASC',
    [articleId]
  );
  return rows;
}

// Replace ALL FAQ rows of one article (delete + insert). MUST be called inside
// an open transaction: the caller owns commit/rollback so a failed FAQ insert
// leaves the previous list intact (same policy as the page FAQ PUT).
async function replaceArticleFaqs(connection, articleId, faqItems) {
  await connection.query('DELETE FROM article_faq_items WHERE article_id = ?', [articleId]);

  if (faqItems.length === 0) return;

  const placeholders = faqItems.map(() => '(?, ?, ?, ?)').join(', ');
  const flatValues = [];
  for (const item of faqItems) {
    flatValues.push(articleId, item.question, item.answer, item.position);
  }
  await connection.query(
    `INSERT INTO article_faq_items (article_id, question, answer, position) VALUES ${placeholders}`,
    flatValues
  );
}

// Merge the article-field + SEO + FAQ errors into the standard 400 body.
// FAQ errors use the `faqs[...]`-prefixed wording from validateArticleFaq.
function collectArticleErrors(fieldErrors, seoErrors, faqErrors) {
  return [...fieldErrors, ...seoErrors, ...faqErrors];
}

// Validate the non-SEO article fields on create/update.
// Returns { errors: string[], values: { ...column values } }.
// 400-level only — the category existence check (which needs the DB) stays
// below so a missing category can answer 404.
function validateArticleFields(body) {
  const errors = [];
  const values = {};

  const title = requiredString(body.title, 'title', MAX_TITLE_LENGTH);
  if (title.error) errors.push(title.error);
  else values.title = title.value;

  const slug = validateSlug(body.slug);
  if (slug.error) errors.push(slug.error);
  else values.slug = slug.value;

  // content / excerpt are LONGTEXT / TEXT: type-checked, never length-capped.
  const content = optionalString(body.content, 'content');
  if (content.error) errors.push(content.error);
  else values.content = content.value;

  const excerpt = optionalString(body.excerpt, 'excerpt');
  if (excerpt.error) errors.push(excerpt.error);
  else values.excerpt = excerpt.value;

  const author = optionalString(body.author, 'author', MAX_AUTHOR_LENGTH);
  if (author.error) errors.push(author.error);
  else values.author = author.value;

  const coverImage = optionalString(body.cover_image, 'cover_image', MAX_COVER_IMAGE_LENGTH);
  if (coverImage.error) errors.push(coverImage.error);
  else values.cover_image = coverImage.value;

  // read_time: integer, minimum 1 (the column defaults to 5). A literal 0 is
  // accepted only because the column allows it; it is no longer silently
  // rewritten to 5 by `read_time || 5`.
  const readTime = coerceInteger(body.read_time, 'read_time', {
    min: 0,
    max: 10000,
    fallback: 5,
  });
  if (readTime.error) errors.push(readTime.error);
  else values.read_time = readTime.value;

  const isFeatured = coerceBoolean(body.is_featured, 'is_featured', 0);
  if (isFeatured.error) errors.push(isFeatured.error);
  else values.is_featured = isFeatured.value;

  // category_id: optional FK. Absent/empty -> null; otherwise must be a
  // positive integer (existence is verified below).
  if (body.category_id === undefined || body.category_id === null || body.category_id === '') {
    values.category_id = null;
  } else if (typeof body.category_id === 'number' || typeof body.category_id === 'string') {
    const raw = String(body.category_id).trim();
    const id = parseId(raw);
    if (id === null) {
      errors.push('category_id must be a positive integer');
    } else {
      values.category_id = id;
    }
  } else {
    errors.push('category_id must be a positive integer');
  }

  return { errors, values };
}

// ---------------------------------------------------------------------------
// Article slug change -> SEO redirect (SEO Task A)
// ---------------------------------------------------------------------------
// A rename breaks every indexed link to the old URL, so it leaves a permanent
// redirect behind:
//
//   /journal/<old-slug> --301--> /journal/<new-slug>
//
//   - If `from_path` already has a redirect row, that operator-created entry is
//     kept as-is (DELETE only a row that would now redirect to itself, see
//     below); otherwise a new 301 row is inserted. Insert-only means the
//     automatic path can never collide on the UNIQUE index or overwrite a
//     dashboard decision.
//   - Renaming back (A -> B, then B -> A) would make /journal/<A> redirect to
//     itself, so that row is deleted (two hops would bounce forever).
//   - Any other failure is logged and swallowed: the article UPDATE already
//     committed, so a redirect problem must not turn a successful save into a
//     user-visible error.
// The redirect revalidate webhook is fired only when the map actually changed.
async function upsertSlugRedirect(previousSlug, nextSlug) {
  const fromPath = `/journal/${previousSlug}`;
  const toPath = `/journal/${nextSlug}`;

  try {
    const [existing] = await db.query('SELECT id, to_path FROM redirects WHERE from_path = ?', [fromPath]);

    if (existing.length > 0) {
      const { id, to_path: currentTarget } = existing[0];
      if (currentTarget !== fromPath) {
        // An existing redirect wins over the automatic one: the dashboard
        // already decided where that URL belongs (possibly a different page),
        // and the new /journal/<new-slug> keeps working on its own.
        return;
      }
      // Renaming back (A -> B, then B -> A): the old path would redirect to
      // itself, so the row is removed instead of creating a loop.
      await db.query('DELETE FROM redirects WHERE id = ?', [id]);
      triggerRedirectRevalidateSafe();
      return;
    }

    await db.query(
      'INSERT INTO redirects (from_path, to_path, status) VALUES (?, ?, 301)',
      [fromPath, toPath]
    );
    triggerRedirectRevalidateSafe();
  } catch (error) {
    // Never let a redirect hiccup fail the article save.
    console.error(`Update slug redirect error (${fromPath} -> ${toPath}):`, error.code || error.message);
  }
}

// Escape LIKE wildcards so a search for "100%" does not match everything.
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (character) => `\\${character}`);
}

// GET /api/articles — public, with optional category filter and optional pagination.
// When query includes `page` or `per_page`, returns { items, total, page, per_page, total_pages }.
// Otherwise returns plain array (backward-compatible).
// Validasi: page/per_page non-integer atau <1 di-clamp ke default (1 / 9).
// per_page di-clamp ke 1–50. Legacy `limit` (non-paginated mode) juga di-clamp
// ke 1–50; nilai tidak valid -> default tanpa LIMIT.
async function list(query = {}) {
  const { category, featured, limit, q, updated_since: updatedSince } = query;
  const hasPagination = query.page !== undefined || query.per_page !== undefined;

  // Clamp pagination params to defaults when missing or invalid
  let page = 1;
  let perPage = 9;
  if (hasPagination) {
    const rawPage = parseInt(query.page, 10);
    const rawPerPage = parseInt(query.per_page, 10);
    if (!Number.isNaN(rawPage) && rawPage >= 1) page = rawPage;
    if (!Number.isNaN(rawPerPage) && rawPerPage >= 1) {
      perPage = Math.min(rawPerPage, 50);
    }
  }

  let countSql = `
    SELECT COUNT(*) as total
    FROM articles a
    LEFT JOIN categories c ON a.category_id = c.id
    WHERE 1=1
  `;
  let sql = `
    SELECT a.*, c.name as category_name, c.slug as category_slug,
           (SELECT COUNT(*) FROM article_faq_items f WHERE f.article_id = a.id) AS faq_count
    FROM articles a
    LEFT JOIN categories c ON a.category_id = c.id
    WHERE 1=1
  `;
  const params = [];

  if (category) {
    sql += ' AND c.slug = ?';
    countSql += ' AND c.slug = ?';
    params.push(category);
  }

  if (featured === 'true') {
    sql += ' AND a.is_featured = 1';
    countSql += ' AND a.is_featured = 1';
  }

  // Agent API filters. Invalid/absent values are ignored so the legacy
  // /api/articles contract (and its callers) is unchanged.
  const searchTerm = typeof q === 'string' ? q.trim() : '';
  if (searchTerm !== '') {
    const like = `%${escapeLike(searchTerm)}%`;
    sql += ' AND (a.title LIKE ? OR a.excerpt LIKE ?)';
    countSql += ' AND (a.title LIKE ? OR a.excerpt LIKE ?)';
    params.push(like, like);
  }

  const updatedAfter = typeof updatedSince === 'string' ? new Date(updatedSince) : null;
  if (updatedAfter && !Number.isNaN(updatedAfter.getTime())) {
    sql += ' AND a.updated_at >= ?';
    countSql += ' AND a.updated_at >= ?';
    params.push(updatedAfter);
  }

  sql += ' ORDER BY a.published_at DESC, a.id DESC';

  if (hasPagination) {
    // Count total matching rows (without limit/offset)
    const [[{ total }]] = await db.query(countSql, params);

    const offset = (page - 1) * perPage;
    sql += ' LIMIT ? OFFSET ?';
    params.push(perPage, offset);

    const [rows] = await db.query(sql, params);
    return {
      items: rows,
      total,
      page,
      per_page: perPage,
      total_pages: Math.ceil(total / perPage) || 0,
    };
  }

  // Legacy mode — plain array (backward-compatible).
  // `limit` is clamped to 1..50 exactly like `per_page`; a missing or invalid
  // value keeps the unbounded default instead of `LIMIT NaN` (which MySQL
  // turns into `LIMIT NULL` → 500) or an unbounded dump.
  const legacyLimit = clampLegacyLimit(limit);
  if (legacyLimit !== null) {
    sql += ' LIMIT ?';
    params.push(legacyLimit);
  }

  const [rows] = await db.query(sql, params);
  return rows;
}

// GET /api/articles/:slug — public, single article (+ its FAQs, ordered)
async function getBySlug(slug) {
  const [rows] = await db.query(
    'SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.slug = ?',
    [slug]
  );

  if (rows.length === 0) return null;

  // Optional per-article FAQ list (0..20 rows). Same ordering everywhere:
  // position, then id as a stable tiebreaker.
  const faqs = await fetchArticleFaqs(rows[0].id);

  // Get related articles (same category, exclude current)
  const [related] = await db.query(
    'SELECT id, title, slug, cover_image, excerpt, read_time, published_at FROM articles WHERE category_id = ? AND id != ? ORDER BY published_at DESC LIMIT 3',
    [rows[0].category_id, rows[0].id]
  );

  return { article: { ...rows[0], faqs }, related };
}

// GET /agent/v1/articles/:id — positive integer id, same public shape as
// getBySlug so an agent client can use one article representation everywhere.
async function getById(id) {
  const [rows] = await db.query(
    'SELECT a.*, c.name as category_name, c.slug as category_slug FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.id = ?',
    [id]
  );

  if (rows.length === 0) {
    throw httpError(404, { message: 'Article not found' });
  }

  const faqs = await fetchArticleFaqs(rows[0].id);
  const [related] = await db.query(
    'SELECT id, title, slug, cover_image, excerpt, read_time, published_at FROM articles WHERE category_id = ? AND id != ? ORDER BY published_at DESC LIMIT 3',
    [rows[0].category_id, rows[0].id]
  );

  return { article: { ...rows[0], faqs }, related };
}

// Resolve a slug to its primary key without loading the whole row. Used by the
// agent upsert flow.
async function findIdBySlug(slug) {
  const [rows] = await db.query('SELECT id FROM articles WHERE slug = ? LIMIT 1', [slug]);
  return rows.length > 0 ? rows[0].id : null;
}

// POST /api/articles — any authenticated user; admin-only for feature flagging
async function create(body = {}) {
  const { errors: fieldErrors, values: fields } = validateArticleFields(body);

  const { errors: seoErrors, values: seo } = normalizeSeoFields(body);

  // Optional meta keywords. Missing -> error stays null (treated below like
  // the other SEO fields, i.e. written as NULL).
  const keywords = normalizeKeywords(body.keywords);

  const { errors: faqErrors, items: faqItems } = validateArticleFaqs(body.faqs);

  const errors = collectArticleErrors(fieldErrors, seoErrors, faqErrors);
  if (keywords.error) errors.push(keywords.error);
  if (errors.length > 0) {
    throw httpError(400, { message: errors[0], errors });
  }

  try {
    // Category must exist before the article is written (400 if the id is
    // unusable, 404 if it points at nothing). Done before any write so no
    // orphan/overwritten row can be left behind.
    if (fields.category_id !== null) {
      const [categoryRows] = await db.query('SELECT id FROM categories WHERE id = ?', [fields.category_id]);
      if (categoryRows.length === 0) {
        throw httpError(404, {
          message: `Category not found: ${fields.category_id}`,
          errors: [`category_id ${fields.category_id} does not exist`],
        });
      }
    }

    // Article row + optional FAQs share ONE transaction: an article is never
    // persisted with a half-written FAQ list.
    const connection = await db.getConnection();
    let articleId;
    try {
      await connection.beginTransaction();

      const [result] = await connection.query(
        'INSERT INTO articles (title, slug, content, excerpt, cover_image, category_id, author, read_time, is_featured, meta_title, meta_description, og_image, noindex, keywords) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [fields.title, fields.slug, fields.content, fields.excerpt, fields.cover_image, fields.category_id, fields.author, fields.read_time, fields.is_featured, seo.meta_title, seo.meta_description, seo.og_image, seo.noindex, keywords.value]
      );
      articleId = result.insertId;

      if (faqItems.length > 0) {
        await replaceArticleFaqs(connection, articleId, faqItems);
      }

      await connection.commit();
    } catch (txError) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Create article rollback error:', rollbackError.message);
      }
      throw txError;
    } finally {
      // Always hand the connection back, otherwise the pool starves.
      connection.release();
    }

    // Fire-and-forget: invalidate the frontend cache for this article (detail
    // page + the journal list pages, see utils/revalidate.js). FAQ changes need
    // no extra type: they live inside the article payload, so this same call
    // purges them (`article:<slug>` + `article-list`).
    triggerRevalidateSafe(fields.slug);

    return { id: articleId };
  } catch (error) {
    if (isDuplicateEntry(error)) {
      throw httpError(409, {
        message: 'An article with this slug already exists',
        errors: ['slug must be unique'],
      });
    }
    throw error;
  }
}

// PUT /api/articles/:id — any authenticated user; admin-only for feature flagging
//
// `options.allowNoop` is set only by the agent PATCH flow. MySQL reports
// affectedRows = 0 when an UPDATE changes nothing, which the legacy PUT treats
// as "row vanished" (404). The agent contract wants a PATCH that changes
// nothing to succeed with the current article, so patch() opts into the
// no-op-aware branch. The default preserves the legacy behaviour exactly.
async function updateFull(id, body = {}, options = {}) {
  const { allowNoop = false } = options;
  const { errors: fieldErrors, values: fields } = validateArticleFields(body);

  const { errors: seoErrors, values: seo } = normalizeSeoFields(body);

  // `keywords` is a plain article-row column (like meta_title): it is always
  // part of the UPDATE, and an absent field is written as NULL.
  const keywords = normalizeKeywords(body.keywords);

  // `faqs` present -> replace-all (delete + insert in the same transaction as
  // the article row). `faqs` absent -> the article's FAQs are untouched.
  const { present: faqsPresent, errors: faqErrors, items: faqItems } = validateArticleFaqs(body.faqs);

  const errors = collectArticleErrors(fieldErrors, seoErrors, faqErrors);
  if (keywords.error) errors.push(keywords.error);
  if (errors.length > 0) {
    throw httpError(400, { message: errors[0], errors });
  }

  try {
    // Capture the current row: the slug for revalidation/redirects, and the
    // image fields so replaced/removed assets can be cleaned up after commit.
    const [existing] = await db.query(
      'SELECT slug, cover_image, og_image, content FROM articles WHERE id = ?',
      [id]
    );
    if (existing.length === 0) {
      throw httpError(404, { message: 'Article not found' });
    }
    const previousSlug = existing[0].slug;

    if (fields.category_id !== null) {
      const [categoryRows] = await db.query('SELECT id FROM categories WHERE id = ?', [fields.category_id]);
      if (categoryRows.length === 0) {
        throw httpError(404, {
          message: `Category not found: ${fields.category_id}`,
          errors: [`category_id ${fields.category_id} does not exist`],
        });
      }
    }

    // Article UPDATE + optional FAQ replace share one transaction: a failed FAQ
    // insert rolls the article row back too, so the previous state survives.
    // affectedRows counts matched rows unless the data actually changes —
    // either way 0 means the row vanished between the SELECT and the UPDATE.
    let updated = true;
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const [result] = await connection.query(
        'UPDATE articles SET title=?, slug=?, content=?, excerpt=?, cover_image=?, category_id=?, author=?, read_time=?, is_featured=?, meta_title=?, meta_description=?, og_image=?, noindex=?, keywords=? WHERE id=?',
        [fields.title, fields.slug, fields.content, fields.excerpt, fields.cover_image, fields.category_id, fields.author, fields.read_time, fields.is_featured, seo.meta_title, seo.meta_description, seo.og_image, seo.noindex, keywords.value, id]
      );

      if (result.affectedRows === 0) {
        if (allowNoop) {
          // A no-op UPDATE and a missing row both report 0. Check existence so
          // PATCH can return 200 for an unchanged article while still 404ing
          // when the row really disappeared.
          const [stillExists] = await connection.query(
            'SELECT id FROM articles WHERE id = ?',
            [id]
          );
          if (stillExists.length === 0) {
            updated = false;
            await connection.rollback();
          } else {
            if (faqsPresent) {
              await replaceArticleFaqs(connection, id, faqItems);
            }
            await connection.commit();
          }
        } else {
          updated = false;
          await connection.rollback();
        }
      } else {
        if (faqsPresent) {
          await replaceArticleFaqs(connection, id, faqItems);
        }
        await connection.commit();
      }
    } catch (txError) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Update article rollback error:', rollbackError.message);
      }
      throw txError;
    } finally {
      // Always hand the connection back, otherwise the pool starves.
      connection.release();
    }

    if (!updated) {
      throw httpError(404, { message: 'Article not found' });
    }

    // Fire-and-forget: invalidate the frontend cache for the (possibly renamed)
    // article, plus the old URL when the slug changed. A rename also leaves a
    // permanent 301 behind at /journal/<old-slug>.
    // FAQ changes ride along: one call purges `article:<slug>`, which is the
    // tag backing the detail payload (article + faqs) the frontend renders.
    triggerRevalidateSafe(fields.slug);
    if (previousSlug && previousSlug !== fields.slug) {
      triggerRevalidateSafe(previousSlug);
      await upsertSlugRedirect(previousSlug, fields.slug);
    }

    // Images the save may have orphaned: changed cover/og plus content images
    // that disappeared from the HTML. Runs only after the commit and never
    // throws, so a Cloudinary hiccup cannot fail the save.
    await cleanupCloudinaryAssets([
      ...changedValue(existing[0].cover_image, fields.cover_image),
      ...changedValue(existing[0].og_image, seo.og_image),
      ...removedContentImages(existing[0].content, fields.content),
    ], { db });

    return { previousSlug, slug: fields.slug };
  } catch (error) {
    if (isDuplicateEntry(error)) {
      throw httpError(409, {
        message: 'An article with this slug already exists',
        errors: ['slug must be unique'],
      });
    }
    throw error;
  }
}

// Article columns accepted by the partial-update flow. A field absent from the
// PATCH body keeps the stored value; an explicit null clears it. Required
// columns (title, slug) are still rejected by the normal validators when null.
const PATCH_FIELDS = Object.freeze([
  'title',
  'slug',
  'content',
  'excerpt',
  'author',
  'cover_image',
  'read_time',
  'is_featured',
  'category_id',
  'meta_title',
  'meta_description',
  'og_image',
  'noindex',
  'keywords',
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// PATCH /agent/v1/articles/:id — merge the stored row with the supplied
// fields, then reuse the full-update path so transactions, FAQ replacement,
// slug redirects, Cloudinary cleanup and revalidation stay identical.
async function patch(id, body = {}) {
  const [rows] = await db.query('SELECT * FROM articles WHERE id = ?', [id]);
  if (rows.length === 0) {
    throw httpError(404, { message: 'Article not found' });
  }

  const current = rows[0];
  const merged = {};
  for (const field of PATCH_FIELDS) {
    merged[field] = hasOwn(body, field) ? body[field] : current[field];
  }

  // FAQs: absent preserves the stored list; [] replaces it with an empty list.
  if (hasOwn(body, 'faqs')) merged.faqs = body.faqs;

  await updateFull(id, merged, { allowNoop: true });
  return getById(id);
}

// Validate a complete article payload without writing. Same validators and
// error shape as create/updateFull, plus the category existence check.
async function validate(body = {}) {
  const { errors: fieldErrors, values: fields } = validateArticleFields(body);
  const { errors: seoErrors, values: seo } = normalizeSeoFields(body);
  const keywords = normalizeKeywords(body.keywords);
  const { errors: faqErrors, items: faqItems } = validateArticleFaqs(body.faqs);

  const errors = collectArticleErrors(fieldErrors, seoErrors, faqErrors);
  if (keywords.error) errors.push(keywords.error);
  if (errors.length > 0) {
    throw httpError(400, { message: errors[0], errors });
  }

  if (fields.category_id !== null) {
    const [categoryRows] = await db.query('SELECT id FROM categories WHERE id = ?', [fields.category_id]);
    if (categoryRows.length === 0) {
      throw httpError(404, {
        message: `Category not found: ${fields.category_id}`,
        errors: [`category_id ${fields.category_id} does not exist`],
      });
    }
  }

  return {
    valid: true,
    values: { ...fields, ...seo, keywords: keywords.value, faqs: faqItems },
  };
}

// Upsert by slug: create a new article when the slug is free, otherwise apply
// a partial patch to the existing row. Returns { created, id }.
async function upsert(body = {}) {
  const slug = validateSlug(body.slug);
  if (slug.error) {
    throw httpError(400, { message: slug.error, errors: [slug.error] });
  }

  const existingId = await findIdBySlug(slug.value);
  if (existingId === null) {
    const created = await create(body);
    return { created: true, id: created.id };
  }

  await patch(existingId, body);
  return { created: false, id: existingId };
}

// DELETE /api/articles/:id — admin only (destructive; audit P3-7)
async function remove(id) {
  // Resolve the row before deletion so the frontend can invalidate its cache
  // and the article's images can be released afterwards.
  const [existing] = await db.query(
    'SELECT slug, cover_image, og_image, content FROM articles WHERE id = ?',
    [id]
  );
  if (existing.length === 0) {
    throw httpError(404, { message: 'Article not found' });
  }
  const { slug: deletedSlug } = existing[0];

  const [result] = await db.query('DELETE FROM articles WHERE id = ?', [id]);
  if (result.affectedRows === 0) {
    // Deleted concurrently between the SELECT and the DELETE.
    throw httpError(404, { message: 'Article not found' });
  }

  // The row is gone, so its own references no longer protect these assets;
  // anything still used elsewhere (another article or page_seo) is skipped
  // by the cleanup helper. Runs after the DELETE and never throws.
  await cleanupCloudinaryAssets([
    existing[0].cover_image,
    existing[0].og_image,
    ...extractContentImageUrls(existing[0].content),
  ], { db });

  // Fire-and-forget: invalidate the frontend cache for the removed article.
  triggerRevalidateSafe(deletedSlug);

  return { slug: deletedSlug };
}

module.exports = {
  list,
  getBySlug,
  getById,
  findIdBySlug,
  create,
  updateFull,
  patch,
  validate,
  upsert,
  remove,
  __setDbForTests,
};
