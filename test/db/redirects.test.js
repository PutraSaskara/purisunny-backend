// backend/test/db/redirects.test.js
//
// DB-backed redirects contract (SEO Task A):
//   POST -> 201 { redirect }         GET (public) -> row present + timestamps
//   PUT  -> 200 { redirect }         DELETE -> 200 { message }
//   404 for unknown ids              409 for a duplicate from_path
//   automatic 301 when an article slug changes (and no self-loop on rename back)
//   SEO list/detail payloads carry created_at / updated_at
//   meta length caps answer 400 through the real routes
//
// Skips (does not fail) when no scratch MySQL is available.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

let ctx = null;

const FROM_PREFIX = '/zz-nodetest-redirect-';
const ARTICLE_PREFIX = 'zz-nodetest-redirect-art-';

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }
  // The redirects table must exist (schema.sql + migrate-redirects.js).
  const [tables] = await db.query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'redirects'"
  );
  if (tables.length === 0) {
    ctx = { skip: true, reason: 'redirects table missing (run node database/migrate-redirects.js)' };
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
    await ctx.db.query(`DELETE FROM redirects WHERE from_path LIKE '${FROM_PREFIX}%'`);
    await ctx.db.query("DELETE FROM redirects WHERE from_path LIKE '/journal/zz-nodetest-redirect-%'");
    await ctx.db.query(`DELETE FROM articles WHERE slug LIKE '${ARTICLE_PREFIX}%'`);
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

function stamp() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function articlePayload(slug) {
  return {
    title: 'Node test redirect article',
    slug,
    content: '<p>body</p>',
    excerpt: 'excerpt',
    author: 'Verifier',
    cover_image: '',
    read_time: 5,
    is_featured: false,
  };
}

dbTest('redirects CRUD: 201 -> 200 public list -> 200 update -> 200 delete -> 404s', async () => {
  const s = stamp();
  const from = `${FROM_PREFIX}${s}`;
  const to = `/zz-nodetest-redirect-target-${s}`;

  const created = await ctx.app.request('POST', '/api/redirects', {
    token: ctx.app.adminToken,
    body: { from_path: from, to_path: to },
  });
  assert.equal(created.status, 201);
  const row = created.json.redirect;
  assert.equal(row.from_path, from);
  assert.equal(row.to_path, to);
  assert.equal(row.status, 301);
  assert.ok(row.created_at, 'created_at missing');
  assert.ok(row.updated_at, 'updated_at missing');

  // Public GET — no token.
  const list = await ctx.app.request('GET', '/api/redirects');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.redirects));
  const found = list.json.redirects.find((r) => r.id === row.id);
  assert.ok(found, 'created redirect not in public list');
  assert.deepEqual(
    Object.keys(found).sort(),
    ['created_at', 'from_path', 'id', 'status', 'to_path', 'updated_at']
  );
  // Ordered by id.
  const ids = list.json.redirects.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));

  const updated = await ctx.app.request('PUT', `/api/redirects/${row.id}`, {
    token: ctx.app.adminToken,
    body: { status: 302, to_path: `${to}-v2` },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.redirect.status, 302);
  assert.equal(updated.json.redirect.to_path, `${to}-v2`);
  // Unsupplied field unchanged.
  assert.equal(updated.json.redirect.from_path, from);

  const del = await ctx.app.request('DELETE', `/api/redirects/${row.id}`, { token: ctx.app.adminToken });
  assert.equal(del.status, 200);
  assert.equal(typeof del.json.message, 'string');

  const gone = await ctx.app.request('PUT', `/api/redirects/${row.id}`, {
    token: ctx.app.adminToken,
    body: { to_path: to },
  });
  assert.equal(gone.status, 404);
  const goneDel = await ctx.app.request('DELETE', `/api/redirects/${row.id}`, { token: ctx.app.adminToken });
  assert.equal(goneDel.status, 404);
});

dbTest('redirects: duplicate from_path -> 409', async () => {
  const s = stamp();
  const from = `${FROM_PREFIX}dup-${s}`;
  const first = await ctx.app.request('POST', '/api/redirects', {
    token: ctx.app.adminToken,
    body: { from_path: from, to_path: '/gallery' },
  });
  assert.equal(first.status, 201);
  const dup = await ctx.app.request('POST', '/api/redirects', {
    token: ctx.app.adminToken,
    body: { from_path: from, to_path: '/rooms' },
  });
  assert.equal(dup.status, 409);
  assert.ok(Array.isArray(dup.json.errors));

  // PUT onto another row's from_path is also a 409.
  const other = await ctx.app.request('POST', '/api/redirects', {
    token: ctx.app.adminToken,
    body: { from_path: `${FROM_PREFIX}other-${s}`, to_path: '/gallery' },
  });
  assert.equal(other.status, 201);
  const clash = await ctx.app.request('PUT', `/api/redirects/${other.json.redirect.id}`, {
    token: ctx.app.adminToken,
    body: { from_path: from },
  });
  assert.equal(clash.status, 409);
});

dbTest('redirects: editor writes are 403 and leave the row untouched', async () => {
  const s = stamp();
  const from = `${FROM_PREFIX}role-${s}`;
  const created = await ctx.app.request('POST', '/api/redirects', {
    token: ctx.app.adminToken,
    body: { from_path: from, to_path: '/gallery' },
  });
  assert.equal(created.status, 201);
  const id = created.json.redirect.id;

  const editorPut = await ctx.app.request('PUT', `/api/redirects/${id}`, {
    token: ctx.app.editorToken,
    body: { to_path: '/rooms' },
  });
  assert.equal(editorPut.status, 403);
  const editorDel = await ctx.app.request('DELETE', `/api/redirects/${id}`, { token: ctx.app.editorToken });
  assert.equal(editorDel.status, 403);

  const [rows] = await ctx.db.query('SELECT to_path FROM redirects WHERE id = ?', [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].to_path, '/gallery');
});

dbTest('article slug change -> automatic 301 in redirects', async () => {
  const s = stamp();
  const oldSlug = `${ARTICLE_PREFIX}${s}-old`;
  const newSlug = `${ARTICLE_PREFIX}${s}-new`;

  const created = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: articlePayload(oldSlug),
  });
  assert.equal(created.status, 201);

  const rename = await ctx.app.request('PUT', `/api/articles/${created.json.id}`, {
    token: ctx.app.adminToken,
    body: articlePayload(newSlug),
  });
  assert.equal(rename.status, 200);

  const [rows] = await ctx.db.query('SELECT from_path, to_path, status FROM redirects WHERE from_path = ?', [
    `/journal/${oldSlug}`,
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].to_path, `/journal/${newSlug}`);
  assert.equal(rows[0].status, 301);

  // A pre-existing redirect at the same from_path is left untouched: the
  // dashboard decision wins over the automatic one (and the eventual explicit
  // POST/PUT on that from_path answers 409, same as categories/articles).
  const unrelatedTarget = `/journal/zz-nodetest-redirect-elsewhere-${s}`;
  await ctx.db.query('DELETE FROM redirects WHERE from_path = ?', [`/journal/${oldSlug}`]);
  await ctx.db.query(
    'INSERT INTO redirects (from_path, to_path, status) VALUES (?, ?, 302)',
    [`/journal/${oldSlug}`, unrelatedTarget]
  );
  const thirdSlug = `${oldSlug}-final`;
  const rename3 = await ctx.app.request('PUT', `/api/articles/${created.json.id}`, {
    token: ctx.app.adminToken,
    body: articlePayload(thirdSlug),
  });
  assert.equal(rename3.status, 200, `body=${JSON.stringify(rename3.json)}`);
  const [again] = await ctx.db.query('SELECT to_path, status FROM redirects WHERE from_path = ?', [
    `/journal/${oldSlug}`,
  ]);
  assert.equal(again.length, 1, 'existing redirect must not be duplicated');
  assert.equal(again[0].to_path, unrelatedTarget, 'existing redirect must be preserved');
  assert.equal(again[0].status, 302);
  // The intermediate hop still gets its own 301.
  const [hop] = await ctx.db.query('SELECT to_path FROM redirects WHERE from_path = ?', [`/journal/${newSlug}`]);
  assert.equal(hop.length, 1);

  // Renaming back to `oldSlug` turns the earlier /journal/<newSlug> hop into a
  // plain 301 towards /journal/<oldSlug>; no row may ever point a path at
  // itself (that would bounce the visitor forever).
  const back = await ctx.app.request('PUT', `/api/articles/${created.json.id}`, {
    token: ctx.app.adminToken,
    body: articlePayload(oldSlug),
  });
  assert.equal(back.status, 200);
  const [hops] = await ctx.db.query('SELECT from_path, to_path FROM redirects WHERE from_path LIKE ?', [`/journal/${ARTICLE_PREFIX}${s}%`]);
  for (const row of hops) {
    assert.notEqual(row.from_path, row.to_path, `self-redirect left behind: ${row.from_path}`);
  }
  const [backHop] = await ctx.db.query('SELECT to_path FROM redirects WHERE from_path = ?', [`/journal/${thirdSlug}`]);
  assert.equal(backHop.length, 1, 'rename back must leave a fresh 301 at the previous slug');
  assert.equal(backHop[0].to_path, `/journal/${oldSlug}`);
});

dbTest('article PUT without a slug change creates no redirect', async () => {
  const s = stamp();
  const slug = `${ARTICLE_PREFIX}${s}-same`;
  const created = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: articlePayload(slug),
  });
  assert.equal(created.status, 201);
  const upd = await ctx.app.request('PUT', `/api/articles/${created.json.id}`, {
    token: ctx.app.adminToken,
    body: { ...articlePayload(slug), title: 'Same slug, new title' },
  });
  assert.equal(upd.status, 200);
  const [rows] = await ctx.db.query('SELECT id FROM redirects WHERE from_path = ?', [`/journal/${slug}`]);
  assert.equal(rows.length, 0);
});

dbTest('GET /api/seo includes created_at/updated_at per page', async () => {
  const list = await ctx.app.request('GET', '/api/seo');
  assert.equal(list.status, 200);
  assert.equal(list.json.pages.length, 18);
  for (const page of list.json.pages) {
    assert.ok('created_at' in page, `${page.page_key} missing created_at`);
    assert.ok('updated_at' in page, `${page.page_key} missing updated_at`);
  }
});

dbTest('GET /api/seo/:pageKey includes timestamps after an upsert', async () => {
  const pageKey = 'page:gallery';
  const [before] = await ctx.db.query('SELECT * FROM page_seo WHERE page_key = ?', [pageKey]);
  const [beforeFaqs] = await ctx.db.query(
    'SELECT question, answer, position FROM faq_items WHERE page_key = ? ORDER BY position',
    [pageKey]
  );

  try {
    const put = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(pageKey)}`, {
      token: ctx.app.adminToken,
      body: { meta_title: 'ZZ nodetest', meta_description: '', og_image: '', noindex: 0, faqs: [] },
    });
    assert.equal(put.status, 200);
    assert.ok(put.json.data.created_at, 'PUT response missing created_at');
    assert.ok(put.json.data.updated_at, 'PUT response missing updated_at');

    const one = await ctx.app.request('GET', `/api/seo/${encodeURIComponent(pageKey)}`);
    assert.equal(one.status, 200);
    assert.ok(one.json.created_at);
    assert.ok(one.json.updated_at);
  } finally {
    await ctx.db.query('DELETE FROM faq_items WHERE page_key = ?', [pageKey]);
    await ctx.db.query('DELETE FROM page_seo WHERE page_key = ?', [pageKey]);
    for (const row of before) {
      await ctx.db.query(
        'INSERT INTO page_seo (page_key, meta_title, meta_description, og_image, noindex, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        [row.page_key, row.meta_title, row.meta_description, row.og_image, row.noindex, row.keywords]
      );
    }
    for (const row of beforeFaqs) {
      await ctx.db.query(
        'INSERT INTO faq_items (page_key, question, answer, position) VALUES (?, ?, ?, ?)',
        [pageKey, row.question, row.answer, row.position]
      );
    }
  }
});

dbTest('meta length caps -> 400 through articles and SEO upsert', async () => {
  const pageKey = 'page:gallery';
  const [before] = await ctx.db.query('SELECT * FROM page_seo WHERE page_key = ?', [pageKey]);
  const [beforeFaqs] = await ctx.db.query(
    'SELECT question, answer, position FROM faq_items WHERE page_key = ? ORDER BY position',
    [pageKey]
  );

  try {
    const titleOver = await ctx.app.request('POST', '/api/articles', {
      token: ctx.app.adminToken,
      body: { ...articlePayload(`${ARTICLE_PREFIX}${stamp()}-cap`), meta_title: 'x'.repeat(256) },
    });
    assert.equal(titleOver.status, 400);
    assert.ok(titleOver.json.errors.some((e) => /meta_title must be at most 255/.test(e)));

    const descOver = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(pageKey)}`, {
      token: ctx.app.adminToken,
      body: { meta_description: 'y'.repeat(501) },
    });
    assert.equal(descOver.status, 400);
    assert.ok(descOver.json.errors.some((e) => /meta_description must be at most 500/.test(e)));

    // Exact-cap values must be accepted (boundary, not off-by-one).
    const atCap = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(pageKey)}`, {
      token: ctx.app.adminToken,
      body: { meta_description: 'y'.repeat(500), meta_title: 'x'.repeat(255) },
    });
    assert.equal(atCap.status, 200);
  } finally {
    await ctx.db.query('DELETE FROM faq_items WHERE page_key = ?', [pageKey]);
    await ctx.db.query('DELETE FROM page_seo WHERE page_key = ?', [pageKey]);
    for (const row of before) {
      await ctx.db.query(
        'INSERT INTO page_seo (page_key, meta_title, meta_description, og_image, noindex, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        [row.page_key, row.meta_title, row.meta_description, row.og_image, row.noindex, row.keywords]
      );
    }
    for (const row of beforeFaqs) {
      await ctx.db.query(
        'INSERT INTO faq_items (page_key, question, answer, position) VALUES (?, ?, ?, ?)',
        [pageKey, row.question, row.answer, row.position]
      );
    }
  }
});
