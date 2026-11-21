// backend/test/db/articles.test.js
//
// Paket C status-code contract through the real stack (400 / 404 / 409),
// plus the admin/editor split on destructive routes.
//
// Skips (does not fail) when no scratch MySQL is available.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

let ctx = null;

// Keep first slugs under this suite's own prefix: the old broad
// "DELETE ... WHERE slug LIKE 'zz-nodetest-%'" would delete fixtures created by
// the other DB suites (agentArticles, keywords, articleFaqs, ...) that run in
// parallel processes against the same scratch database.
const ART_PREFIX = 'zz-nodetest-art-';

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }
  const { startApp } = require('../helpers/app');
  const { createDbLock } = require('../helpers/db');
  const app = await startApp();
  const lock = createDbLock(db);
  await lock.acquire();
  ctx = { skip: false, db, app, lock };
});

test.after(async () => {
  if (!ctx || ctx.skip) return;
  try {
    await ctx.db.query(`DELETE FROM articles WHERE slug LIKE '${ART_PREFIX}%'`);
    await ctx.db.query(`DELETE FROM categories WHERE slug LIKE '${ART_PREFIX}%'`);
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

function payload(overrides = {}) {
  return {
    title: 'Node test article',
    slug: `${ART_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    content: '<p>body</p>',
    excerpt: 'excerpt',
    author: 'Verifier',
    cover_image: '',
    read_time: 5,
    is_featured: false,
    ...overrides,
  };
}

dbTest('POST article missing title -> 400', async () => {
  const res = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: payload({ title: '' }),
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.json.errors));
});

dbTest('POST article bad slug -> 400', async () => {
  const res = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: payload({ slug: 'Not A Slug' }),
  });
  assert.equal(res.status, 400);
});

dbTest('POST duplicate slug -> 409', async () => {
  const body = payload();
  const first = await ctx.app.request('POST', '/api/articles', { token: ctx.app.adminToken, body });
  assert.equal(first.status, 201);
  const dup = await ctx.app.request('POST', '/api/articles', { token: ctx.app.adminToken, body });
  assert.equal(dup.status, 409);
});

dbTest('PUT nonexistent article -> 404', async () => {
  const res = await ctx.app.request('PUT', '/api/articles/99999999', {
    token: ctx.app.adminToken,
    body: payload(),
  });
  assert.equal(res.status, 404);
});

dbTest('DELETE nonexistent article -> 404', async () => {
  const res = await ctx.app.request('DELETE', '/api/articles/99999999', { token: ctx.app.adminToken });
  assert.equal(res.status, 404);
});

dbTest('POST article with unknown category_id -> 404', async () => {
  const res = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: payload({ category_id: 99999999 }),
  });
  assert.equal(res.status, 404);
});

dbTest('non-numeric article id -> 400', async () => {
  const res = await ctx.app.request('DELETE', '/api/articles/abc', { token: ctx.app.adminToken });
  assert.equal(res.status, 400);
});

dbTest('editor can create content but cannot delete it (403)', async () => {
  const res = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.editorToken,
    body: payload(),
  });
  assert.equal(res.status, 201);
  const del = await ctx.app.request('DELETE', `/api/articles/${res.json.id}`, { token: ctx.app.editorToken });
  assert.equal(del.status, 403);
  // Admin can.
  const adminDel = await ctx.app.request('DELETE', `/api/articles/${res.json.id}`, { token: ctx.app.adminToken });
  assert.equal(adminDel.status, 200);
});

dbTest('GET articles pagination still works', async () => {
  const res = await ctx.app.request('GET', '/api/articles?page=1&per_page=2');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.items));
  assert.equal(typeof res.json.total, 'number');
});
