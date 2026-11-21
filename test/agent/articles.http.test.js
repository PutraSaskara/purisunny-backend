// backend/test/agent/articles.http.test.js
//
// HTTP contract for /api/agent/v1/articles. The service layer is stubbed so
// this suite pins routing, scopes, confirmation, sanitisation, idempotency and
// the agent envelope without requiring MySQL.

require('../helpers/env');
process.env.AGENT_API_ENABLED = '1';
process.env.AGENT_RATE_LIMIT_READ = '500';
process.env.AGENT_RATE_LIMIT_WRITE = '500';

const test = require('node:test');
const assert = require('node:assert/strict');

const apiKeys = require('../../services/apiKeys');
const auth = require('../../agent/auth');
const idempotency = require('../../agent/idempotency');
const audit = require('../../agent/audit');
const articles = require('../../services/articles');
const { httpError } = require('../../services/errors');
const { startApp } = require('../helpers/app');

const originals = {
  list: articles.list,
  getBySlug: articles.getBySlug,
  getById: articles.getById,
  create: articles.create,
  patch: articles.patch,
  validate: articles.validate,
  upsert: articles.upsert,
  remove: articles.remove,
};

const state = {
  created: [],
  upsertCreate: true,
};

function makeDb() {
  const idem = new Map();
  const audits = [];
  let nextIdem = 1;
  return {
    idem,
    audits,
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM api_keys k/i.test(text)) {
        const prefix = params && params[0];
        return [allRows.filter((row) => row.key_prefix === prefix)];
      }
      if (/UPDATE api_keys SET last_used_at/i.test(text)) return [{ affectedRows: 1 }];

      if (text.startsWith('SELECT id, request_hash')) {
        const [apiKeyId, key] = params;
        const row = idem.get(`${apiKeyId}:${key}`);
        return [row ? [row] : []];
      }
      if (text.startsWith('INSERT INTO idempotency_keys')) {
        const [apiKeyId, key, method, path, hash, expiresAt] = params;
        const storeKey = `${apiKeyId}:${key}`;
        if (idem.has(storeKey)) {
          const error = new Error('Duplicate entry');
          error.code = 'ER_DUP_ENTRY';
          throw error;
        }
        const row = {
          id: nextIdem += 1,
          method,
          path,
          request_hash: hash,
          status_code: null,
          response_body: null,
          expires_at: expiresAt,
        };
        idem.set(storeKey, row);
        return [{ insertId: row.id }];
      }
      if (text.startsWith('UPDATE idempotency_keys')) {
        const [statusCode, body, apiKeyId, key] = params;
        const row = idem.get(`${apiKeyId}:${key}`);
        if (!row) return [{ affectedRows: 0 }];
        row.status_code = statusCode;
        row.response_body = body;
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith('DELETE FROM idempotency_keys')) {
        if (params.length === 2) {
          idem.delete(`${params[0]}:${params[1]}`);
        } else {
          for (const [key, row] of idem) {
            if (row.id === params[0]) idem.delete(key);
          }
        }
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith('INSERT INTO agent_audit_log')) {
        audits.push(params);
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };
}

function rowFor({ id, name, role, scopes }) {
  const generated = apiKeys.generateApiKey();
  return {
    generated,
    row: {
      id,
      name,
      key_prefix: generated.prefix,
      key_hash: generated.hash,
      user_id: role === 'admin' ? 1 : 2,
      scopes: JSON.stringify(scopes),
      is_active: 1,
      expires_at: null,
      last_used_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
      revoked_at: null,
      username: role === 'admin' ? 'zz-test-admin' : 'zz-test-editor',
      role,
    },
  };
}

const admin = rowFor({
  id: 1,
  name: 'articles-admin',
  role: 'admin',
  scopes: ['articles:read', 'articles:write', 'articles:feature', 'articles:delete'],
});
const editor = rowFor({
  id: 2,
  name: 'articles-editor',
  role: 'editor',
  scopes: ['articles:read', 'articles:write'],
});
const noRead = rowFor({
  id: 3,
  name: 'articles-write-only',
  role: 'editor',
  scopes: ['articles:write'],
});

const allRows = [admin, editor, noRead].map((entry) => entry.row);

let app;
let db;

function bearer(key) {
  return { Authorization: `Bearer ${key}` };
}

function payload(overrides = {}) {
  return {
    title: 'Agent article',
    slug: 'agent-article',
    content: '<p>body</p><script>alert(1)</script>',
    excerpt: 'excerpt',
    author: 'Agent',
    cover_image: '',
    read_time: 5,
    is_featured: false,
    ...overrides,
  };
}

test.before(async () => {
  db = makeDb();
  apiKeys.__setDbForTests(db);
  auth.__setDbForTests(db);
  idempotency.__setDbForTests(db);
  audit.__setDbForTests(db);

  articles.list = async (query) => ({
    items: [{ id: 1, title: 'One', slug: 'one' }],
    total: 1,
    page: Number(query.page) || 1,
    per_page: Number(query.per_page) || 20,
    total_pages: 1,
  });
  articles.getBySlug = async (slug) => (slug === 'missing'
    ? null
    : { article: { id: 1, slug, faqs: [] }, related: [] });
  articles.getById = async (id) => {
    if (Number(id) === 999) throw httpError(404, { message: 'Article not found' });
    return {
      article: {
        id: Number(id),
        title: 'Stored',
        slug: 'stored-slug',
        excerpt: 'stored-excerpt',
        faqs: [],
      },
      related: [],
    };
  };
  articles.create = async (body) => {
    state.created.push(body);
    return { id: 101 };
  };
  articles.patch = async (id, body) => {
    if (Number(id) === 999) throw httpError(404, { message: 'Article not found' });
    return { article: { id: Number(id), ...body, faqs: [] }, related: [] };
  };
  articles.validate = async (body) => {
    if (!body.title) throw httpError(400, { message: 'title is required', errors: ['title is required'] });
    return { valid: true };
  };
  articles.upsert = async () => (state.upsertCreate
    ? { created: true, id: 102 }
    : { created: false, id: 5 });
  articles.remove = async (id) => {
    if (Number(id) === 999) throw httpError(404, { message: 'Article not found' });
    return { slug: 'stored-slug' };
  };

  app = await startApp();
});

test.after(async () => {
  if (app) await app.close();
  for (const [name, fn] of Object.entries(originals)) articles[name] = fn;
  auth.__setDbForTests(null);
  apiKeys.__setDbForTests(null);
  idempotency.__setDbForTests(null);
  audit.__setDbForTests(null);
  delete process.env.AGENT_RATE_LIMIT_READ;
  delete process.env.AGENT_RATE_LIMIT_WRITE;
});

function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('article routes require an API key and articles:read', async () => {
  const anonymous = await app.request('GET', '/api/agent/v1/articles');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error.code, 'UNAUTHORIZED');

  const forbidden = await app.request('GET', '/api/agent/v1/articles', {
    headers: bearer(noRead.generated.key),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error.code, 'FORBIDDEN');
  assert.equal(forbidden.json.error.context.required_scope, 'articles:read');
});

test('GET /articles: defaults, filters and pagination metadata', async () => {
  const res = await app.request('GET', '/api/agent/v1/articles?q=coffee&updated_since=2026-01-01', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.data.items.length, 1);
  assert.equal(res.json.meta.page, 1);
  assert.equal(res.json.meta.per_page, 20);
  assert.equal(res.json.meta.total, 1);
  assert.equal(res.json.meta.total_pages, 1);
});

test('GET /articles/:id: invalid id -> 400, missing row -> 404', async () => {
  const invalid = await app.request('GET', '/api/agent/v1/articles/abc', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'VALIDATION_ERROR');

  const missing = await app.request('GET', '/api/agent/v1/articles/999', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
});

test('GET /articles/by-slug/:slug stays ahead of /:id', async () => {
  const found = await app.request('GET', '/api/agent/v1/articles/by-slug/stored-slug', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(found.status, 200);
  assert.equal(found.json.data.article.slug, 'stored-slug');

  const missing = await app.request('GET', '/api/agent/v1/articles/by-slug/missing', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(missing.status, 404);
});

test('POST /articles: 201, sanitises content and returns the created article', async () => {
  state.created.length = 0;
  const res = await app.request('POST', '/api/agent/v1/articles', {
    headers: bearer(editor.generated.key),
    body: payload(),
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.data.article.id, 101);
  assert.equal(state.created.length, 1);
  assert.equal(/script/i.test(state.created[0].content), false);
});

test('POST /articles: is_featured=true without articles:feature -> 403', async () => {
  const res = await app.request('POST', '/api/agent/v1/articles', {
    headers: bearer(editor.generated.key),
    body: payload({ is_featured: true }),
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'FORBIDDEN');
  assert.equal(res.json.error.context.required_scope, 'articles:feature');
});

test('POST /articles/validate: invalid payload maps the service 400 envelope', async () => {
  const res = await app.request('POST', '/api/agent/v1/articles/validate', {
    headers: bearer(editor.generated.key),
    body: payload({ title: '' }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error.code, 'VALIDATION_ERROR');
  assert.equal(res.json.error.message, 'title is required');
  assert.deepEqual(res.json.error.details, [{ message: 'title is required' }]);
});

test('failed mutations are audited by the agent error handler', async () => {
  const requestId = 'zz-http-audit-failure';
  db.audits.length = 0;
  const res = await app.request('POST', '/api/agent/v1/articles/validate', {
    headers: { ...bearer(editor.generated.key), 'X-Request-Id': requestId },
    body: payload({ title: '' }),
  });
  assert.equal(res.status, 400);
  await wait();

  const row = db.audits.find((params) => params[7] === requestId);
  assert.ok(row, 'failed mutation audit row missing');
  assert.equal(row[4], 'article');
  assert.equal(row[6], 400);
});

test('PATCH /articles/:id: partial update returns the article', async () => {
  const res = await app.request('PATCH', '/api/agent/v1/articles/5', {
    headers: bearer(editor.generated.key),
    body: { excerpt: 'changed' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.article.id, 5);
  assert.equal(res.json.data.article.excerpt, 'changed');
});

test('DELETE /articles/:id: confirmation header and delete scope are required', async () => {
  const missingHeader = await app.request('DELETE', '/api/agent/v1/articles/5', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(missingHeader.status, 400);
  assert.equal(missingHeader.json.error.code, 'CONFIRMATION_REQUIRED');

  const editorDelete = await app.request('DELETE', '/api/agent/v1/articles/5', {
    headers: { ...bearer(editor.generated.key), 'X-Confirm-Delete': 'true' },
  });
  assert.equal(editorDelete.status, 403);
  assert.equal(editorDelete.json.error.code, 'FORBIDDEN');

  const deleted = await app.request('DELETE', '/api/agent/v1/articles/5', {
    headers: { ...bearer(admin.generated.key), 'X-Confirm-Delete': '1' },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json.data, { id: 5, slug: 'stored-slug', deleted: true });
});

test('POST /articles/upsert: 201 created and 200 updated', async () => {
  state.upsertCreate = true;
  const created = await app.request('POST', '/api/agent/v1/articles/upsert', {
    headers: bearer(editor.generated.key),
    body: payload({ slug: 'new-upsert' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.created, true);

  // Regression: getById returns { article, related }; the upsert response must
  // expose the article row directly as data.article, never data.article.article.
  assert.equal(created.json.data.article.id, 102);
  assert.equal(created.json.data.article.excerpt, 'stored-excerpt');
  assert.equal(created.json.data.article.article, undefined);

  state.upsertCreate = false;
  const updated = await app.request('POST', '/api/agent/v1/articles/upsert', {
    headers: bearer(editor.generated.key),
    body: payload({ slug: 'stored-slug' }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.created, false);
  assert.equal(updated.json.data.article.id, 5);
  assert.equal(updated.json.data.article.excerpt, 'stored-excerpt');
  assert.equal(updated.json.data.article.article, undefined);
});

test('POST /articles: idempotent replay returns the stored response and skips the handler', async () => {
  state.created.length = 0;
  const headers = { ...bearer(admin.generated.key), 'Idempotency-Key': 'http-idem-1' };
  const first = await app.request('POST', '/api/agent/v1/articles', {
    headers,
    body: payload({ slug: 'idempotent-create' }),
  });
  assert.equal(first.status, 201);
  await wait();

  const second = await app.request('POST', '/api/agent/v1/articles', {
    headers,
    body: payload({ slug: 'idempotent-create' }),
  });
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(second.json, first.json);
  assert.equal(state.created.length, 1);
});

test('POST /articles: same key with a different body -> 409 IDEMPOTENCY_CONFLICT', async () => {
  const headers = { ...bearer(admin.generated.key), 'Idempotency-Key': 'http-idem-2' };
  const first = await app.request('POST', '/api/agent/v1/articles', {
    headers,
    body: payload({ slug: 'conflict-one' }),
  });
  assert.equal(first.status, 201);
  await wait();

  const second = await app.request('POST', '/api/agent/v1/articles', {
    headers,
    body: payload({ slug: 'conflict-two' }),
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'IDEMPOTENCY_CONFLICT');
});
