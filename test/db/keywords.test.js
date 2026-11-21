// backend/test/db/keywords.test.js
//
// Optional meta-keywords field (page_seo.keywords + articles.keywords) through
// the real stack:
//   - GET /api/seo list + detail carry `keywords` (string or null)
//   - PUT /api/seo/:pageKey roundtrips, trims, empty -> NULL, 256 -> 400
//   - GET /api/articles list + detail carry `keywords`
//   - POST/PUT /api/articles roundtrip, trim, empty -> NULL, 256 -> 400
//   - `keywords` absent on PUT is written as NULL (article-row column, like
//     meta_title — NOT like the optional `faqs` replace-all flag)
//
// Skips (does not fail) when no scratch MySQL is available, like the rest of
// test/db/.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

const SLUG_PREFIX = 'zz-nodetest-keywords-';
const PAGE_KEY = 'page:reviews'; // an official key; restored after the SEO checks

let ctx = null;

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }
  // Newer column than tryGetDb() checks for: skip rather than fail when the
  // scratch database predates migrate-keywords.js (or schema.sql).
  try {
    await db.query('SELECT keywords FROM page_seo LIMIT 1');
    await db.query('SELECT keywords FROM articles LIMIT 1');
  } catch (err) {
    ctx = { skip: true, reason: `keywords column missing (${err.code || err.message}) — run node scripts/setup-test-db.js or node database/migrate-keywords.js` };
    return;
  }
  const { startApp } = require('../helpers/app');
  const app = await startApp();
  const lock = createDbLock(db);
  await lock.acquire();
  ctx = { skip: false, db, app, lock };
});

test.after(async () => {
  if (!ctx || ctx.skip) return;
  try {
    await ctx.db.query(`DELETE FROM articles WHERE slug LIKE '${SLUG_PREFIX}%'`);
    await ctx.db.query("DELETE FROM redirects WHERE from_path LIKE '/journal/zz-nodetest-keywords-%'");
  } catch { /* best effort */ }
  if (ctx.lock) await ctx.lock.close();
  await ctx.app.close();
  try { await ctx.db.end(); } catch { /* already closed */ }
});

function dbTest(name, fn) {
  test(name, async (t) => {
    if (ctx.skip) return t.skip(`DB tests skipped: ${ctx.reason}`);
    return withTestDbLock(ctx.lock, () => fn(t));
  });
}

let seq = 0;
function articlePayload(overrides = {}) {
  seq += 1;
  return {
    title: 'Node test keywords article',
    slug: `${SLUG_PREFIX}${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 6)}`,
    content: '<p>body</p>',
    excerpt: 'excerpt',
    author: 'Verifier',
    cover_image: '',
    read_time: 5,
    is_featured: false,
    ...overrides,
  };
}

async function createArticle(body) {
  const res = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function articleDetail(slug) {
  const res = await ctx.app.request('GET', `/api/articles/${slug}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.article;
}

// Pin to the top of the published_at DESC, id DESC list (same helper idea as
// articleFaqs.test.js) so the list assertions are deterministic.
async function pinToTop(...ids) {
  for (const id of ids) {
    await ctx.db.query(
      'UPDATE articles SET published_at = DATE_ADD(NOW(), INTERVAL 10 SECOND) WHERE id = ?',
      [id]
    );
  }
}

// ---------------------------------------------------------------------------
// page_seo
// ---------------------------------------------------------------------------

dbTest('GET /api/seo list carries keywords for every page (string or null)', async () => {
  const res = await ctx.app.request('GET', '/api/seo');
  assert.equal(res.status, 200);
  assert.equal(res.json.pages.length, 18);
  for (const page of res.json.pages) {
    assert.ok('keywords' in page, `${page.page_key} missing keywords`);
    assert.ok(
      page.keywords === null || typeof page.keywords === 'string',
      `${page.page_key} keywords must be string|null, got ${typeof page.keywords}`
    );
  }
});

dbTest('PUT /api/seo roundtrips keywords, trims, and empty -> NULL', async () => {
  const [before] = await ctx.db.query('SELECT * FROM page_seo WHERE page_key = ?', [PAGE_KEY]);
  const [beforeFaqs] = await ctx.db.query(
    'SELECT question, answer, position FROM faq_items WHERE page_key = ? ORDER BY position',
    [PAGE_KEY]
  );

  try {
    // 1. set (padded -> trimmed)
    const put = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(PAGE_KEY)}`, {
      token: ctx.app.adminToken,
      body: { meta_title: 'ZZ keywords', keywords: '  bali, munduk , puri sunny  ', faqs: [] },
    });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.data.keywords, 'bali, munduk , puri sunny');

    const one = await ctx.app.request('GET', `/api/seo/${encodeURIComponent(PAGE_KEY)}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.keywords, 'bali, munduk , puri sunny');

    // 2. whitespace-only -> NULL (both in the response and in the column)
    const blank = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(PAGE_KEY)}`, {
      token: ctx.app.adminToken,
      body: { meta_title: 'ZZ keywords', keywords: '   ', faqs: [] },
    });
    assert.equal(blank.status, 200, JSON.stringify(blank.json));
    assert.equal(blank.json.data.keywords, null);
    const [rows] = await ctx.db.query('SELECT keywords FROM page_seo WHERE page_key = ?', [PAGE_KEY]);
    assert.equal(rows[0].keywords, null);

    // 3. omitted -> NULL as well (optional field, same as meta_description)
    const omitted = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(PAGE_KEY)}`, {
      token: ctx.app.adminToken,
      body: { meta_title: 'ZZ keywords', faqs: [] },
    });
    assert.equal(omitted.status, 200, JSON.stringify(omitted.json));
    assert.equal(omitted.json.data.keywords, null);
  } finally {
    // Restore the pre-test snapshot (redirects.test.js does the same).
    await ctx.db.query('DELETE FROM faq_items WHERE page_key = ?', [PAGE_KEY]);
    await ctx.db.query('DELETE FROM page_seo WHERE page_key = ?', [PAGE_KEY]);
    for (const row of before) {
      await ctx.db.query(
        'INSERT INTO page_seo (page_key, meta_title, meta_description, og_image, noindex, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        [row.page_key, row.meta_title, row.meta_description, row.og_image, row.noindex, row.keywords]
      );
    }
    for (const row of beforeFaqs) {
      await ctx.db.query(
        'INSERT INTO faq_items (page_key, question, answer, position) VALUES (?, ?, ?, ?)',
        [PAGE_KEY, row.question, row.answer, row.position]
      );
    }
  }
});

dbTest('PUT /api/seo keywords cap: 255 accepted, 256 -> 400 + errors[]', async () => {
  const [before] = await ctx.db.query('SELECT * FROM page_seo WHERE page_key = ?', [PAGE_KEY]);
  const [beforeFaqs] = await ctx.db.query(
    'SELECT question, answer, position FROM faq_items WHERE page_key = ? ORDER BY position',
    [PAGE_KEY]
  );

  try {
    const exact = 'x'.repeat(255);
    const ok = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(PAGE_KEY)}`, {
      token: ctx.app.adminToken,
      body: { meta_title: 'ZZ keywords', keywords: exact, faqs: [] },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.data.keywords, exact);

    const over = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(PAGE_KEY)}`, {
      token: ctx.app.adminToken,
      body: { meta_title: 'ZZ keywords', keywords: 'y'.repeat(256), faqs: [] },
    });
    assert.equal(over.status, 400);
    assert.equal(over.json.message, 'keywords must be at most 255 characters');
    assert.deepEqual(over.json.errors, ['keywords must be at most 255 characters']);

    // The rejected value must not have been written.
    const [rows] = await ctx.db.query('SELECT keywords FROM page_seo WHERE page_key = ?', [PAGE_KEY]);
    assert.equal(rows[0].keywords, exact);

    const wrongType = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(PAGE_KEY)}`, {
      token: ctx.app.adminToken,
      body: { meta_title: 'ZZ keywords', keywords: 123, faqs: [] },
    });
    assert.equal(wrongType.status, 400);
    assert.deepEqual(wrongType.json.errors, ['keywords must be a string']);
  } finally {
    await ctx.db.query('DELETE FROM faq_items WHERE page_key = ?', [PAGE_KEY]);
    await ctx.db.query('DELETE FROM page_seo WHERE page_key = ?', [PAGE_KEY]);
    for (const row of before) {
      await ctx.db.query(
        'INSERT INTO page_seo (page_key, meta_title, meta_description, og_image, noindex, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        [row.page_key, row.meta_title, row.meta_description, row.og_image, row.noindex, row.keywords]
      );
    }
    for (const row of beforeFaqs) {
      await ctx.db.query(
        'INSERT INTO faq_items (page_key, question, answer, position) VALUES (?, ?, ?, ?)',
        [PAGE_KEY, row.question, row.answer, row.position]
      );
    }
  }
});

// ---------------------------------------------------------------------------
// articles
// ---------------------------------------------------------------------------

dbTest('POST /api/articles stores keywords: trim, empty -> NULL, omitted -> NULL', async () => {
  const padded = articlePayload({ keywords: '  bali, munduk  ' });
  const empty = articlePayload({ keywords: '' });
  const blank = articlePayload({ keywords: '   ' });
  const omitted = articlePayload();

  const ids = [
    await createArticle(padded),
    await createArticle(empty),
    await createArticle(blank),
    await createArticle(omitted),
  ];
  await pinToTop(...ids);

  const paddedArticle = await articleDetail(padded.slug);
  assert.equal(paddedArticle.keywords, 'bali, munduk');
  assert.equal(typeof paddedArticle.keywords, 'string');

  assert.equal((await articleDetail(empty.slug)).keywords, null);
  assert.equal((await articleDetail(blank.slug)).keywords, null);
  assert.equal((await articleDetail(omitted.slug)).keywords, null);

  // Column-level check (NULL, not '').
  for (const slug of [empty.slug, blank.slug, omitted.slug]) {
    const [rows] = await ctx.db.query('SELECT keywords FROM articles WHERE slug = ?', [slug]);
    assert.equal(rows[0].keywords, null, `${slug} must store NULL`);
  }
});

dbTest('GET /api/articles list carries keywords (paginated + legacy array)', async () => {
  const withKeywords = articlePayload({ keywords: 'balinese, villa' });
  const without = articlePayload();
  const withId = await createArticle(withKeywords);
  const withoutId = await createArticle(without);
  await pinToTop(withId, withoutId);

  const paginated = await ctx.app.request('GET', '/api/articles?page=1&per_page=2');
  assert.equal(paginated.status, 200);
  const bySlug = new Map(paginated.json.items.map((a) => [a.slug, a]));
  assert.equal(bySlug.get(withKeywords.slug).keywords, 'balinese, villa');
  assert.equal(bySlug.get(without.slug).keywords, null);

  const legacy = await ctx.app.request('GET', '/api/articles?limit=2');
  assert.equal(legacy.status, 200);
  assert.ok(Array.isArray(legacy.json));
  const legacyItem = legacy.json.find((a) => a.slug === withKeywords.slug);
  assert.equal(legacyItem.keywords, 'balinese, villa');
});

dbTest('PUT /api/articles updates keywords; absent keywords -> NULL (article-row column)', async () => {
  const body = articlePayload({ keywords: 'old, words' });
  const id = await createArticle(body);
  assert.equal((await articleDetail(body.slug)).keywords, 'old, words');

  // 1. explicit update (padded -> trimmed)
  const updated = await ctx.app.request('PUT', `/api/articles/${id}`, {
    token: ctx.app.adminToken,
    body: articlePayload({ slug: body.slug, keywords: '  new, words  ' }),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal((await articleDetail(body.slug)).keywords, 'new, words');

  // 2. whitespace-only -> NULL
  const blanked = await ctx.app.request('PUT', `/api/articles/${id}`, {
    token: ctx.app.adminToken,
    body: articlePayload({ slug: body.slug, keywords: '   ' }),
  });
  assert.equal(blanked.status, 200, JSON.stringify(blanked.json));
  assert.equal((await articleDetail(body.slug)).keywords, null);

  // 3. set again, then omit: like meta_title, an absent keywords field is part
  //    of the row UPDATE and lands as NULL (NOT left untouched like `faqs`).
  await ctx.app.request('PUT', `/api/articles/${id}`, {
    token: ctx.app.adminToken,
    body: articlePayload({ slug: body.slug, keywords: 'set again' }),
  });
  assert.equal((await articleDetail(body.slug)).keywords, 'set again');

  const omitted = await ctx.app.request('PUT', `/api/articles/${id}`, {
    token: ctx.app.adminToken,
    body: articlePayload({ slug: body.slug, title: 'Renamed' }),
  });
  assert.equal(omitted.status, 200, JSON.stringify(omitted.json));
  const article = await articleDetail(body.slug);
  assert.equal(article.title, 'Renamed');
  assert.equal(article.keywords, null);
});

dbTest('POST/PUT /api/articles keywords cap: 255 accepted, 256 -> 400 + errors[]', async () => {
  const exact = 'x'.repeat(255);

  // POST 255 -> accepted
  const okBody = articlePayload({ keywords: exact });
  const id = await createArticle(okBody);
  assert.equal((await articleDetail(okBody.slug)).keywords, exact);

  // POST 256 -> 400 with errors[] and no row written
  const overBody = articlePayload({ keywords: 'y'.repeat(256) });
  const over = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: overBody,
  });
  assert.equal(over.status, 400);
  assert.equal(over.json.message, 'keywords must be at most 255 characters');
  assert.deepEqual(over.json.errors, ['keywords must be at most 255 characters']);
  const [rows] = await ctx.db.query('SELECT id FROM articles WHERE slug = ?', [overBody.slug]);
  assert.equal(rows.length, 0, 'article must not be created when keywords is invalid');

  // POST non-string -> 400 wording
  const wrongType = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: articlePayload({ keywords: ['not', 'a', 'string'] }),
  });
  assert.equal(wrongType.status, 400);
  assert.deepEqual(wrongType.json.errors, ['keywords must be a string']);

  // PUT 256 -> 400, still-present value unchanged
  const put = await ctx.app.request('PUT', `/api/articles/${id}`, {
    token: ctx.app.adminToken,
    body: articlePayload({ slug: okBody.slug, keywords: 'y'.repeat(256) }),
  });
  assert.equal(put.status, 400);
  assert.deepEqual(put.json.errors, ['keywords must be at most 255 characters']);
  assert.equal((await articleDetail(okBody.slug)).keywords, exact);
});

dbTest('editor can author keywords (same role rules as the article routes)', async () => {
  const body = articlePayload({ keywords: 'editor, keywords' });
  const created = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.editorToken,
    body,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal((await articleDetail(body.slug)).keywords, 'editor, keywords');

  const put = await ctx.app.request('PUT', `/api/articles/${created.json.id}`, {
    token: ctx.app.editorToken,
    body: articlePayload({ slug: body.slug, keywords: 'edited, words' }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal((await articleDetail(body.slug)).keywords, 'edited, words');
});
