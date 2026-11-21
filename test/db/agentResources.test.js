// backend/test/db/agentResources.test.js
//
// DB-backed Phase 2B Agent API checks: category CRUD (including the referenced
// delete guard), SEO list/get/upsert/delete, redirect CRUD and audit rows.
//
// Skips (does not fail) when no scratch MySQL is available.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

let ctx = null;

// Keep this prefix unique per suite: DB suites run in parallel processes on the
// same scratch database and clean up by their own prefixes only.
const SLUG_PREFIX = 'zz-nodetest-agentres-';
const KEY_PREFIX = 'zz-nodetest-agentres-';
const REDIRECT_PREFIX = '/zz-nodetest-agentres-';
const SEO_PAGE_KEY = 'page:contact';

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }

  const [admins] = await db.query(
    "SELECT id, username, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"
  );
  const [fallbackUsers] = await db.query('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
  const user = (admins && admins[0]) || (fallbackUsers && fallbackUsers[0]);
  if (!user) {
    ctx = { skip: true, reason: 'scratch database has no users (run node scripts/setup-test-db.js)' };
    return;
  }
  if (user.role !== 'admin') {
    ctx = { skip: true, reason: 'scratch database has no admin user, cannot issue delete scopes' };
    return;
  }

  // Acquire the advisory lock BEFORE creating the API key so another suite's
  // cleanup cannot touch it while setup writes to the scratch database.
  const lock = createDbLock(db);
  const { startApp } = require('../helpers/app');
  await withTestDbLock(lock, async () => {
    const { migrate } = require('../../database/migrate-agent-foundation');
    await migrate();

    const apiKeys = require('../../services/apiKeys');
    const created = await apiKeys.createApiKey({
      name: `${KEY_PREFIX}${Date.now().toString(36)}`,
      userId: user.id,
      scopes: [
        'articles:read', 'articles:write', 'articles:delete',
        'categories:read', 'categories:write', 'categories:delete',
        'seo:read', 'seo:write', 'seo:delete',
        'redirects:read', 'redirects:write', 'redirects:delete',
      ],
      expiresAt: null,
    });

    const app = await startApp();
    ctx = {
      skip: false,
      db,
      app,
      lock,
      user,
      apiKey: created.key,
      keyId: created.apiKey.id,
    };
  });
});

test.after(async () => {
  if (!ctx || ctx.skip) return;
  try {
    await ctx.db.query('DELETE FROM agent_audit_log WHERE api_key_id = ?', [ctx.keyId]);
    await ctx.db.query('DELETE FROM idempotency_keys WHERE api_key_id = ?', [ctx.keyId]);
    await ctx.db.query(`DELETE FROM redirects WHERE from_path LIKE '${REDIRECT_PREFIX}%'`);
    await ctx.db.query(`DELETE FROM articles WHERE slug LIKE '${SLUG_PREFIX}%'`);
    await ctx.db.query(`DELETE FROM categories WHERE slug LIKE '${SLUG_PREFIX}%'`);
    await ctx.db.query('DELETE FROM api_keys WHERE id = ?', [ctx.keyId]);
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

function headers(extra = {}) {
  return { Authorization: `Bearer ${ctx.apiKey}`, ...extra };
}

function stamp() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function slug(suffix = '') {
  return `${SLUG_PREFIX}${stamp()}${suffix}`;
}

function wait(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

dbTest('category CRUD through the agent API, including patch merge and no-op', async () => {
  const categorySlug = slug('-cat');

  const created = await ctx.app.request('POST', '/api/agent/v1/categories', {
    headers: headers(),
    body: { name: 'Agent category', slug: categorySlug, description: 'First' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.slug, categorySlug);
  const id = created.json.data.id;

  const list = await ctx.app.request('GET', '/api/agent/v1/categories', { headers: headers() });
  assert.equal(list.status, 200);
  assert.ok(list.json.data.items.some((row) => row.id === id));

  const patched = await ctx.app.request('PATCH', `/api/agent/v1/categories/${id}`, {
    headers: headers(),
    body: { name: 'Agent category renamed' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.name, 'Agent category renamed');
  assert.equal(patched.json.data.description, 'First');

  const noop = await ctx.app.request('PATCH', `/api/agent/v1/categories/${id}`, {
    headers: headers(),
    body: {},
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.json.data.slug, categorySlug);

  const cleared = await ctx.app.request('PATCH', `/api/agent/v1/categories/${id}`, {
    headers: headers(),
    body: { description: null },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.data.description, null);

  const noHeader = await ctx.app.request('DELETE', `/api/agent/v1/categories/${id}`, {
    headers: headers(),
  });
  assert.equal(noHeader.status, 400);
  assert.equal(noHeader.json.error.code, 'CONFIRMATION_REQUIRED');

  const deleted = await ctx.app.request('DELETE', `/api/agent/v1/categories/${id}`, {
    headers: headers({ 'X-Confirm-Delete': 'true' }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json.data, { id, deleted: true });

  const gone = await ctx.app.request('GET', `/api/agent/v1/categories/${id}`, { headers: headers() });
  assert.equal(gone.status, 404);
});

dbTest('referenced category cannot be deleted (409) until its article is removed', async () => {
  const categorySlug = slug('-ref-cat');
  const createdCategory = await ctx.app.request('POST', '/api/agent/v1/categories', {
    headers: headers(),
    body: { name: 'Referenced category', slug: categorySlug },
  });
  assert.equal(createdCategory.status, 201);
  const categoryId = createdCategory.json.data.id;

  const articleSlug = slug('-ref-art');
  const createdArticle = await ctx.app.request('POST', '/api/agent/v1/articles', {
    headers: headers(),
    body: {
      title: 'Referenced article',
      slug: articleSlug,
      content: '<p>body</p>',
      category_id: categoryId,
    },
  });
  assert.equal(createdArticle.status, 201);

  const refused = await ctx.app.request('DELETE', `/api/agent/v1/categories/${categoryId}`, {
    headers: headers({ 'X-Confirm-Delete': 'true' }),
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.context.articleCount, 1);

  const deletedArticle = await ctx.app.request(
    'DELETE',
    `/api/agent/v1/articles/${createdArticle.json.data.article.id}`,
    { headers: headers({ 'X-Confirm-Delete': 'true' }) }
  );
  assert.equal(deletedArticle.status, 200);

  const deletedCategory = await ctx.app.request('DELETE', `/api/agent/v1/categories/${categoryId}`, {
    headers: headers({ 'X-Confirm-Delete': 'true' }),
  });
  assert.equal(deletedCategory.status, 200);
});

dbTest('SEO list/get/upsert/delete round-trip preserves faqs', async () => {
  const [before] = await ctx.db.query('SELECT * FROM page_seo WHERE page_key = ?', [SEO_PAGE_KEY]);
  const [beforeFaqs] = await ctx.db.query(
    'SELECT question, answer, position FROM faq_items WHERE page_key = ? ORDER BY position',
    [SEO_PAGE_KEY]
  );

  try {
    const list = await ctx.app.request('GET', '/api/agent/v1/seo-pages', { headers: headers() });
    assert.equal(list.status, 200);
    assert.equal(list.json.data.items.length, 18);

    const upserted = await ctx.app.request('PUT', `/api/agent/v1/seo-pages/${encodeURIComponent(SEO_PAGE_KEY)}`, {
      headers: headers(),
      body: {
        meta_title: 'Agent contact',
        meta_description: 'Agent description',
        faqs: [{ question: 'Agent Q?', answer: 'Agent A.' }],
      },
    });
    assert.equal(upserted.status, 200);
    assert.equal(upserted.json.data.faqs.length, 1);

    const fetched = await ctx.app.request('GET', `/api/agent/v1/seo-pages/${encodeURIComponent(SEO_PAGE_KEY)}`, {
      headers: headers(),
    });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.data.meta_title, 'Agent contact');
    assert.equal(fetched.json.data.faqs[0].question, 'Agent Q?');

    const invalid = await ctx.app.request('GET', '/api/agent/v1/seo-pages/page:not-real', {
      headers: headers(),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.context.validKeys.length, 18);

    const deleted = await ctx.app.request(
      'DELETE',
      `/api/agent/v1/seo-pages/${encodeURIComponent(SEO_PAGE_KEY)}`,
      { headers: headers({ 'X-Confirm-Delete': '1' }) }
    );
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json.data, { page_key: SEO_PAGE_KEY, deleted: true });

    const gone = await ctx.app.request('GET', `/api/agent/v1/seo-pages/${encodeURIComponent(SEO_PAGE_KEY)}`, {
      headers: headers(),
    });
    assert.equal(gone.status, 404);
  } finally {
    await ctx.db.query('DELETE FROM faq_items WHERE page_key = ?', [SEO_PAGE_KEY]);
    await ctx.db.query('DELETE FROM page_seo WHERE page_key = ?', [SEO_PAGE_KEY]);
    for (const row of before) {
      await ctx.db.query(
        'INSERT INTO page_seo (page_key, meta_title, meta_description, og_image, noindex, keywords) VALUES (?, ?, ?, ?, ?, ?)',
        [row.page_key, row.meta_title, row.meta_description, row.og_image, row.noindex, row.keywords]
      );
    }
    for (const row of beforeFaqs) {
      await ctx.db.query(
        'INSERT INTO faq_items (page_key, question, answer, position) VALUES (?, ?, ?, ?)',
        [SEO_PAGE_KEY, row.question, row.answer, row.position]
      );
    }
  }
});

dbTest('redirect CRUD through the agent API keeps validation and revalidate behaviour', async () => {
  const from = `${REDIRECT_PREFIX}${stamp()}`;
  const to = '/gallery';

  const created = await ctx.app.request('POST', '/api/agent/v1/redirects', {
    headers: headers(),
    body: { from_path: from, to_path: to },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.status, 301);
  const id = created.json.data.id;

  const fetched = await ctx.app.request('GET', `/api/agent/v1/redirects/${id}`, { headers: headers() });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.data.from_path, from);

  const list = await ctx.app.request('GET', '/api/agent/v1/redirects', { headers: headers() });
  assert.equal(list.status, 200);
  assert.ok(list.json.data.items.some((row) => row.id === id));

  const patched = await ctx.app.request('PATCH', `/api/agent/v1/redirects/${id}`, {
    headers: headers(),
    body: { status: 302 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.status, 302);
  assert.equal(patched.json.data.from_path, from);

  const loop = await ctx.app.request('PATCH', `/api/agent/v1/redirects/${id}`, {
    headers: headers(),
    body: { to_path: from },
  });
  assert.equal(loop.status, 400);

  const shadow = await ctx.app.request('POST', '/api/agent/v1/redirects', {
    headers: headers(),
    body: { from_path: '/stay', to_path: '/rooms' },
  });
  assert.equal(shadow.status, 400);

  const duplicate = await ctx.app.request('POST', '/api/agent/v1/redirects', {
    headers: headers(),
    body: { from_path: from, to_path: '/rooms' },
  });
  assert.equal(duplicate.status, 409);

  const noHeader = await ctx.app.request('DELETE', `/api/agent/v1/redirects/${id}`, {
    headers: headers(),
  });
  assert.equal(noHeader.status, 400);

  const deleted = await ctx.app.request('DELETE', `/api/agent/v1/redirects/${id}`, {
    headers: headers({ 'X-Confirm-Delete': 'true' }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json.data, { id, deleted: true });

  const gone = await ctx.app.request('GET', `/api/agent/v1/redirects/${id}`, { headers: headers() });
  assert.equal(gone.status, 404);
});

dbTest('every successful Phase 2B mutation writes an audit row with the right resource type', async () => {
  const requestId = `${SLUG_PREFIX}audit-${stamp()}`;
  const categorySlug = slug('-audit-cat');

  const created = await ctx.app.request('POST', '/api/agent/v1/categories', {
    headers: headers({ 'X-Request-Id': requestId }),
    body: { name: 'Audit category', slug: categorySlug },
  });
  assert.equal(created.status, 201);
  const categoryId = created.json.data.id;

  const [rows] = await ctx.db.query(
    'SELECT resource_type, resource_id, method, status_code FROM agent_audit_log WHERE request_id = ?',
    [requestId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource_type, 'category');
  assert.equal(String(rows[0].resource_id), String(categoryId));
  assert.equal(rows[0].method, 'POST');
  assert.equal(rows[0].status_code, 201);

  await ctx.app.request('DELETE', `/api/agent/v1/categories/${categoryId}`, {
    headers: headers({ 'X-Confirm-Delete': 'true' }),
  });
});
