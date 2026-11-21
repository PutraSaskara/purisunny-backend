// backend/test/db/agentArticles.test.js
//
// DB-backed Agent API article checks: CRUD, FAQ preservation/replacement,
// slug redirect, duplicate slug, idempotent replay and audit row.
//
// Skips (does not fail) when no scratch MySQL is available.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

let ctx = null;

// IMPORTANT: these prefixes must stay unique per suite. Other DB suites run in
// parallel processes against the same scratch database; a shared prefix let
// agentFoundation's api_keys cleanup delete this suite's key mid-test and made
// every POST return 401. Keep them disjoint (agentfound-, agentart-, agentres-,
// agentcontacts-) and scope every cleanup to exactly what this suite created.
const SLUG_PREFIX = 'zz-nodetest-agentart-';
const KEY_PREFIX = 'zz-nodetest-agentart-';

const apiKeys = require('../../services/apiKeys');

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }

  const [users] = await db.query('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
  if (!users || users.length === 0) {
    ctx = { skip: true, reason: 'scratch database has no users (run node scripts/setup-test-db.js)' };
    return;
  }

  // Acquire the advisory lock BEFORE writing anything (api key, Phase 1
  // tables): GET_LOCK serialises whole suites, so another suite's cleanup
  // cannot delete our key while it is being created or used.
  const lock = createDbLock(db);
  const { startApp } = require('../helpers/app');
  await withTestDbLock(lock, async () => {
    // Ensure Phase 1 tables exist before creating a key.
    const { migrate } = require('../../database/migrate-agent-foundation');
    await migrate();

    const created = await apiKeys.createApiKey({
      name: `${KEY_PREFIX}${Date.now().toString(36)}`,
      userId: users[0].id,
      role: users[0].role,
      scopes: ['articles:read', 'articles:write', 'articles:feature', 'articles:delete'],
      expiresAt: null,
    });

    const app = await startApp();
    ctx = {
      skip: false,
      db,
      app,
      lock,
      user: users[0],
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
    await ctx.db.query(`DELETE FROM redirects WHERE from_path LIKE '/journal/${SLUG_PREFIX}%'`);
    await ctx.db.query(`DELETE FROM articles WHERE slug LIKE '${SLUG_PREFIX}%'`);
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

function uniqueSlug(suffix = '') {
  return `${SLUG_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}${suffix}`;
}

function payload(overrides = {}) {
  return {
    title: 'Agent DB article',
    slug: uniqueSlug(),
    content: '<p>body</p><script>alert(1)</script>',
    excerpt: 'excerpt',
    author: 'Agent',
    cover_image: '',
    read_time: 5,
    is_featured: false,
    faqs: [{ question: 'Q1?', answer: 'A1.' }],
    ...overrides,
  };
}

function wait(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

dbTest('article CRUD through the agent API keeps FAQs and sanitises content', async (t) => {
  const body = payload();
  const created = await ctx.app.request('POST', '/api/agent/v1/articles', {
    headers: headers({ 'X-Request-Id': `${SLUG_PREFIX}create-audit` }),
    body,
  });
  assert.equal(created.status, 201);
  const article = created.json.data.article;
  assert.equal(article.slug, body.slug);
  assert.equal(/script/i.test(article.content), false);
  assert.equal(article.faqs.length, 1);

  const id = article.id;

  const fetched = await ctx.app.request('GET', `/api/agent/v1/articles/${id}`, { headers: headers() });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.data.article.faqs.length, 1);

  // PATCH an unrelated field: FAQs must be preserved.
  const patched = await ctx.app.request('PATCH', `/api/agent/v1/articles/${id}`, {
    headers: headers(),
    body: { excerpt: 'changed excerpt' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.article.excerpt, 'changed excerpt');
  assert.equal(patched.json.data.article.faqs.length, 1);

  // Explicit [] clears the FAQ list.
  const cleared = await ctx.app.request('PATCH', `/api/agent/v1/articles/${id}`, {
    headers: headers(),
    body: { faqs: [] },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.data.article.faqs.length, 0);

  // FAQ replacement with one item.
  const replaced = await ctx.app.request('PATCH', `/api/agent/v1/articles/${id}`, {
    headers: headers(),
    body: { faqs: [{ question: 'Q2?', answer: 'A2.' }] },
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.json.data.article.faqs.length, 1);
  assert.equal(replaced.json.data.article.faqs[0].question, 'Q2?');

  const bySlug = await ctx.app.request(
    'GET',
    `/api/agent/v1/articles/by-slug/${encodeURIComponent(body.slug)}`,
    { headers: headers() }
  );
  assert.equal(bySlug.status, 200);
  assert.equal(bySlug.json.data.article.id, id);

  const deleted = await ctx.app.request('DELETE', `/api/agent/v1/articles/${id}`, {
    headers: headers({ 'X-Confirm-Delete': 'true' }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json.data, { id, slug: body.slug, deleted: true });

  const gone = await ctx.app.request('GET', `/api/agent/v1/articles/${id}`, { headers: headers() });
  assert.equal(gone.status, 404);
});

dbTest('upsert creates then updates by slug', async () => {
  const slug = uniqueSlug('-upsert');
  const first = await ctx.app.request('POST', '/api/agent/v1/articles/upsert', {
    headers: headers(),
    body: payload({ slug, excerpt: 'first' }),
  });
  assert.equal(first.status, 201);
  assert.equal(first.json.data.created, true);

  // Regression: data.article must be the article row, not { article, related }.
  assert.equal(first.json.data.article.slug, slug);
  assert.equal(first.json.data.article.excerpt, 'first');
  assert.equal(first.json.data.article.article, undefined);
  assert.ok(Array.isArray(first.json.data.article.faqs));

  const articleId = first.json.data.article.id;
  const [stored] = await ctx.db.query('SELECT id, slug FROM articles WHERE slug = ?', [slug]);
  assert.equal(stored.length, 1);
  assert.equal(String(stored[0].id), String(articleId));

  const second = await ctx.app.request('POST', '/api/agent/v1/articles/upsert', {
    headers: headers(),
    body: payload({ slug, excerpt: 'second', faqs: [] }),
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.data.created, false);
  assert.equal(second.json.data.article.id, articleId);
  assert.equal(second.json.data.article.excerpt, 'second');
  assert.equal(second.json.data.article.article, undefined);
  assert.equal(second.json.data.article.faqs.length, 0);
});

dbTest('duplicate slug answers 409', async () => {
  const body = payload();
  const first = await ctx.app.request('POST', '/api/agent/v1/articles', { headers: headers(), body });
  assert.equal(first.status, 201);
  const duplicate = await ctx.app.request('POST', '/api/agent/v1/articles', { headers: headers(), body });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, 'CONFLICT');
});

dbTest('slug change leaves a /journal/<old> 301 redirect', async () => {
  const body = payload();
  const created = await ctx.app.request('POST', '/api/agent/v1/articles', { headers: headers(), body });
  assert.equal(created.status, 201);

  const nextSlug = uniqueSlug('-renamed');
  const patched = await ctx.app.request('PATCH', `/api/agent/v1/articles/${created.json.data.article.id}`, {
    headers: headers(),
    body: { slug: nextSlug },
  });
  assert.equal(patched.status, 200);

  const [rows] = await ctx.db.query(
    'SELECT from_path, to_path, status FROM redirects WHERE from_path = ?',
    [`/journal/${body.slug}`]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].to_path, `/journal/${nextSlug}`);
  assert.equal(rows[0].status, 301);
});

dbTest('idempotent create replays the stored response', async () => {
  const key = `${SLUG_PREFIX}idem-${Date.now().toString(36)}`;
  const body = payload();
  const requestHeaders = headers({ 'Idempotency-Key': key });

  const first = await ctx.app.request('POST', '/api/agent/v1/articles', {
    headers: requestHeaders,
    body,
  });
  assert.equal(first.status, 201);
  await wait();

  const second = await ctx.app.request('POST', '/api/agent/v1/articles', {
    headers: requestHeaders,
    body,
  });
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(second.json, first.json);

  const [rows] = await ctx.db.query('SELECT COUNT(*) AS total FROM articles WHERE slug = ?', [body.slug]);
  assert.equal(rows[0].total, 1);
});

dbTest('successful mutation writes an agent_audit_log row', async () => {
  const requestId = `${SLUG_PREFIX}audit-${Date.now().toString(36)}`;
  const created = await ctx.app.request('POST', '/api/agent/v1/articles', {
    headers: headers({ 'X-Request-Id': requestId }),
    body: payload(),
  });
  assert.equal(created.status, 201);

  const [rows] = await ctx.db.query(
    'SELECT resource_type, resource_id, method, status_code FROM agent_audit_log WHERE request_id = ?',
    [requestId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource_type, 'article');
  assert.equal(String(rows[0].resource_id), String(created.json.data.article.id));
  assert.equal(rows[0].method, 'POST');
  assert.equal(rows[0].status_code, 201);
});
