// backend/test/db/articleFaqs.test.js
//
// Optional per-article FAQ list (article_faq_items) through the real stack:
//   - POST article with faqs -> detail (by slug) returns ordered faqs
//   - GET /api/articles list carries faq_count (0 when none)
//   - PUT with faqs -> replace-all; PUT without faqs -> untouched
//   - validation 400s (over 20 / empty question / oversize answer) keep state
//   - DELETE article -> FK CASCADE removes its FAQs
//
// Skips (does not fail) when no scratch MySQL is available, like the rest of
// test/db/. The page-level FAQ flow (faq_items / routes/seo.js) is NOT touched.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

const SLUG_PREFIX = 'zz-nodetest-faqs-';

let ctx = null;

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }
  // Newer table than tryGetDb() checks for: skip rather than fail when the
  // scratch database predates migrate-article-faq.js.
  try {
    await db.query('SELECT 1 FROM article_faq_items LIMIT 1');
  } catch (err) {
    ctx = { skip: true, reason: `article_faq_items missing (${err.code || err.message}) — run node scripts/setup-test-db.js` };
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
    // Only this suite's fixture prefix; FAQ rows go with their articles via
    // ON DELETE CASCADE.
    await ctx.db.query(`DELETE FROM articles WHERE slug LIKE '${SLUG_PREFIX}%'`);
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
function payload(overrides = {}) {
  seq += 1;
  return {
    title: 'Node test FAQ article',
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

async function create(body) {
  const res = await ctx.app.request('POST', '/api/articles', { token: ctx.app.adminToken, body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.id;
}

async function detailBySlug(slug) {
  const res = await ctx.app.request('GET', `/api/articles/${slug}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.article;
}

async function faqIdsFor(articleId) {
  const [rows] = await ctx.db.query(
    'SELECT id FROM article_faq_items WHERE article_id = ? ORDER BY id',
    [articleId]
  );
  return rows.map((r) => r.id);
}

// The list is ordered by published_at DESC, id DESC. Several suites run in
// parallel against one scratch database and published_at has second precision,
// so a row from another suite could tie and be ordered ahead. Push the rows
// under test to the top via the ORDINAL column (server-side, no timezone
// conversion), so the list assertions are deterministic.
async function pinToTop(...ids) {
  for (const id of ids) {
    await ctx.db.query(
      'UPDATE articles SET published_at = DATE_ADD(NOW(), INTERVAL 10 SECOND) WHERE id = ?',
      [id]
    );
  }
}

dbTest('POST with faqs -> public detail returns ordered faqs', async () => {
  const body = payload({
    faqs: [
      { question: '  First?  ', answer: '  One.  ' },
      { question: 'Second?', answer: 'Two.' },
      { question: 'Third?', answer: 'Three.' },
    ],
  });
  const id = await create(body);
  const article = await detailBySlug(body.slug);

  assert.equal(article.id, id);
  assert.ok(Array.isArray(article.faqs));
  assert.equal(article.faqs.length, 3);
  assert.deepEqual(
    article.faqs.map((f) => [f.question, f.answer, f.position]),
    [
      ['First?', 'One.', 0],
      ['Second?', 'Two.', 1],
      ['Third?', 'Three.', 2],
    ]
  );
  for (const faq of article.faqs) {
    assert.equal(typeof faq.id, 'number');
    assert.deepEqual(Object.keys(faq).sort(), ['answer', 'id', 'position', 'question']);
  }
});

dbTest('POST without faqs -> detail returns faqs: [] and list faq_count 0', async () => {
  const body = payload();
  const id = await create(body);
  await pinToTop(id);
  const article = await detailBySlug(body.slug);
  assert.deepEqual(article.faqs, []);

  const res = await ctx.app.request('GET', '/api/articles?per_page=2');
  const listed = res.json.items.find((a) => a.slug === body.slug);
  assert.equal(listed.faq_count, 0);
});

dbTest('GET /api/articles list includes integer faq_count', async () => {
  const withFaqs = payload({ faqs: [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }] });
  const without = payload();
  const withId = await create(withFaqs);
  const withoutId = await create(without);
  await pinToTop(withId, withoutId);

  const res = await ctx.app.request('GET', '/api/articles?page=1&per_page=2');
  assert.equal(res.status, 200);
  const bySlug = new Map(res.json.items.map((a) => [a.slug, a]));
  assert.equal(bySlug.get(withFaqs.slug).faq_count, 2);
  assert.equal(typeof bySlug.get(withFaqs.slug).faq_count, 'number');
  assert.equal(bySlug.get(without.slug).faq_count, 0);

  // Legacy (non-paginated) array mode carries it too.
  const legacy = await ctx.app.request('GET', '/api/articles?limit=2');
  assert.equal(legacy.status, 200);
  assert.ok(Array.isArray(legacy.json));
  const legacyItem = legacy.json.find((a) => a.slug === withFaqs.slug);
  assert.equal(legacyItem.faq_count, 2);
});

dbTest('PUT with faqs replaces all rows', async () => {
  const body = payload({
    faqs: [{ question: 'Old A', answer: 'old a' }, { question: 'Old B', answer: 'old b' }],
  });
  const id = await create(body);
  const oldIds = await faqIdsFor(id);
  assert.equal(oldIds.length, 2);

  const put = await ctx.app.request('PUT', `/api/articles/${id}`, {
    token: ctx.app.adminToken,
    body: payload({ slug: body.slug, faqs: [{ question: 'Only new', answer: 'new answer' }] }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));

  const article = await detailBySlug(body.slug);
  assert.deepEqual(article.faqs.map((f) => [f.question, f.answer, f.position]), [['Only new', 'new answer', 0]]);
  const newIds = await faqIdsFor(id);
  assert.equal(newIds.length, 1);
  assert.ok(!oldIds.includes(newIds[0]), 'old rows must be deleted, not reused');
});

dbTest('PUT with faqs: [] clears all rows', async () => {
  const body = payload({ faqs: [{ question: 'Q', answer: 'A' }] });
  const id = await create(body);

  const put = await ctx.app.request('PUT', `/api/articles/${id}`, {
    token: ctx.app.adminToken,
    body: payload({ slug: body.slug, faqs: [] }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await faqIdsFor(id), []);

  // Read back by id (an authed PUT) rather than by slug: this suite shares a
  // scratch database with other parallel suites, so slug reads are only used
  // where nothing else can remove the row.
  const again = await ctx.app.request('PUT', `/api/articles/${id}`, {
    token: ctx.app.adminToken,
    body: payload({ slug: body.slug, faqs: [] }),
  });
  assert.equal(again.status, 200);
});

dbTest('PUT without the faqs key leaves them untouched', async () => {
  const body = payload({ faqs: [{ question: 'Keep me', answer: 'Yes' }] });
  const id = await create(body);
  const before = await faqIdsFor(id);

  const put = await ctx.app.request('PUT', `/api/articles/${id}`, {
    token: ctx.app.adminToken,
    body: payload({ slug: body.slug, title: 'Renamed title' }),
  });
  assert.equal(put.status, 200);

  const article = await detailBySlug(body.slug);
  assert.equal(article.title, 'Renamed title');
  assert.deepEqual(article.faqs.map((f) => [f.question, f.answer]), [['Keep me', 'Yes']]);
  assert.deepEqual(await faqIdsFor(id), before);
});

dbTest('validation: over 20 items -> 400 + errors[], nothing written', async () => {
  const faqs = Array.from({ length: 21 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` }));
  const body = payload({ faqs });
  const res = await ctx.app.request('POST', '/api/articles', { token: ctx.app.adminToken, body });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.json.errors));
  assert.ok(res.json.errors.some((e) => /at most 20 items/.test(e)));
  assert.equal(res.json.message, res.json.errors[0]);
  const [rows] = await ctx.db.query('SELECT id FROM articles WHERE slug = ?', [body.slug]);
  assert.equal(rows.length, 0, 'article must not be created when its faqs are invalid');
});

dbTest('validation: empty question, oversize answer/question, non-object item -> 400', async () => {
  const cases = [
    [[{ question: '   ', answer: 'A' }], /faqs\[0\]\.question is required/],
    [[{ question: 'Q', answer: '' }], /faqs\[0\]\.answer is required/],
    [[{ question: 'Q', answer: 'a'.repeat(1001) }], /faqs\[0\]\.answer must be at most 1000 characters/],
    [[{ question: 'q'.repeat(256), answer: 'A' }], /faqs\[0\]\.question must be at most 255 characters/],
    [['nope'], /faqs\[0\] must be an object/],
    ['not-an-array', /faqs must be an array/],
  ];
  for (const [faqs, pattern] of cases) {
    const body = payload({ faqs });
    const res = await ctx.app.request('POST', '/api/articles', { token: ctx.app.adminToken, body });
    assert.equal(res.status, 400, `${JSON.stringify(faqs)} -> ${res.status}`);
    assert.ok(Array.isArray(res.json.errors));
    assert.ok(res.json.errors.some((e) => pattern.test(e)), res.json.errors.join(' | '));
  }
});

dbTest('PUT validation failure keeps the previous faqs and article', async () => {
  const body = payload({ faqs: [{ question: 'Original', answer: 'Kept' }] });
  const id = await create(body);

  for (const faqs of [
    Array.from({ length: 21 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` })),
    [{ question: 'Q', answer: 'a'.repeat(1001) }],
    [{ question: '', answer: 'A' }],
  ]) {
    const res = await ctx.app.request('PUT', `/api/articles/${id}`, {
      token: ctx.app.adminToken,
      body: payload({ slug: body.slug, faqs }),
    });
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.json.errors));
  }

  const article = await detailBySlug(body.slug);
  assert.deepEqual(article.faqs.map((f) => [f.question, f.answer]), [['Original', 'Kept']]);
});

dbTest('unknown extra keys in FAQ items are ignored', async () => {
  const body = payload({
    faqs: [{ question: 'Q', answer: 'A', id: 12345, article_id: 999, junk: true }],
  });
  const id = await create(body);
  const article = await detailBySlug(body.slug);
  assert.equal(article.faqs.length, 1);
  assert.notEqual(article.faqs[0].id, 12345);
  assert.deepEqual(Object.keys(article.faqs[0]).sort(), ['answer', 'id', 'position', 'question']);
  assert.equal(article.faqs[0].position, 0);
  const ids = await faqIdsFor(id);
  assert.deepEqual(ids, [article.faqs[0].id]);
});

dbTest('editor can author FAQs (same role rules as the article routes)', async () => {
  const body = payload({ faqs: [{ question: 'Editor Q', answer: 'Editor A' }] });
  const res = await ctx.app.request('POST', '/api/articles', { token: ctx.app.editorToken, body });
  assert.equal(res.status, 201, JSON.stringify(res.json));

  const put = await ctx.app.request('PUT', `/api/articles/${res.json.id}`, {
    token: ctx.app.editorToken,
    body: payload({ slug: body.slug, faqs: [{ question: 'Editor Q2', answer: 'Editor A2' }] }),
  });
  assert.equal(put.status, 200);
  const article = await detailBySlug(body.slug);
  assert.deepEqual(article.faqs.map((f) => f.question), ['Editor Q2']);
});

dbTest('DELETE article cascades its FAQs away', async () => {
  const body = payload({
    faqs: [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }],
  });
  const id = await create(body);
  assert.equal((await faqIdsFor(id)).length, 2);

  const del = await ctx.app.request('DELETE', `/api/articles/${id}`, { token: ctx.app.adminToken });
  assert.equal(del.status, 200);

  const [rows] = await ctx.db.query('SELECT id FROM article_faq_items WHERE article_id = ?', [id]);
  assert.equal(rows.length, 0);
  const gone = await ctx.app.request('GET', `/api/articles/${body.slug}`);
  assert.equal(gone.status, 404);
});
