// backend/test/agent/resources.http.test.js
//
// HTTP contract for the Phase 2B Agent API resources:
//   /api/agent/v1/categories
//   /api/agent/v1/seo-pages
//   /api/agent/v1/redirects
//
// The service layer is stubbed so this suite pins routing, scopes, delete
// confirmation, envelope shape, idempotency and audit wiring without MySQL.

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
const categories = require('../../services/categories');
const seo = require('../../services/seo');
const redirects = require('../../services/redirects');
const { httpError } = require('../../services/errors');
const { startApp } = require('../helpers/app');

const originals = {
  categories: {
    list: categories.list,
    get: categories.get,
    create: categories.create,
    patch: categories.patch,
    remove: categories.remove,
  },
  seo: {
    list: seo.list,
    get: seo.get,
    upsert: seo.upsert,
    remove: seo.remove,
  },
  redirects: {
    list: redirects.list,
    get: redirects.get,
    create: redirects.create,
    update: redirects.update,
    remove: redirects.remove,
  },
};

const state = {
  createdCategories: [],
  categoryRows: new Map(),
  patchedCategories: [],
  upserts: [],
  createdRedirects: [],
  patchedRedirects: [],
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

const ALL_SCOPES = [
  'articles:read', 'articles:write', 'articles:feature', 'articles:delete',
  'categories:read', 'categories:write', 'categories:delete',
  'seo:read', 'seo:write', 'seo:delete',
  'redirects:read', 'redirects:write', 'redirects:delete',
];

const admin = rowFor({ id: 1, name: 'resources-admin', role: 'admin', scopes: ALL_SCOPES });
const editor = rowFor({
  id: 2,
  name: 'resources-editor',
  role: 'editor',
  scopes: [
    'articles:read', 'articles:write',
    'categories:read',
    'seo:read', 'seo:write',
    'redirects:read',
  ],
});
const reader = rowFor({
  id: 3,
  name: 'resources-reader',
  role: 'editor',
  scopes: ['categories:read'],
});
const noCategoryRead = rowFor({
  id: 4,
  name: 'resources-seo-reader',
  role: 'editor',
  scopes: ['seo:read'],
});

const allRows = [admin, editor, reader, noCategoryRead].map((entry) => entry.row);

let app;
let db;

function bearer(key) {
  return { Authorization: `Bearer ${key}` };
}

function categoryRow(overrides = {}) {
  return { id: 1, name: 'Stay', slug: 'stay', description: 'Rooms', created_at: null, ...overrides };
}

function redirectRow(overrides = {}) {
  return {
    id: 1,
    from_path: '/old',
    to_path: '/new',
    status: 301,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

test.before(async () => {
  db = makeDb();
  apiKeys.__setDbForTests(db);
  auth.__setDbForTests(db);
  idempotency.__setDbForTests(db);
  audit.__setDbForTests(db);

  categories.list = async () => [categoryRow()];
  categories.get = async (id) => {
    if (Number(id) === 999) return null;
    return state.categoryRows.get(Number(id)) || categoryRow({ id: Number(id) });
  };
  categories.create = async (body) => {
    state.createdCategories.push(body);
    if (!body.name) throw httpError(400, { message: 'name is required', errors: ['name is required'] });
    const row = categoryRow({
      id: 200 + state.createdCategories.length,
      name: body.name,
      slug: body.slug,
      description: body.description ?? null,
    });
    state.categoryRows.set(row.id, row);
    return row;
  };
  categories.patch = async (id, body) => {
    state.patchedCategories.push({ id: Number(id), body });
    if (Number(id) === 999) throw httpError(404, { message: 'Category not found' });
    if (body.slug === 'dup') {
      throw httpError(409, {
        message: 'A category with this slug already exists',
        errors: ['slug must be unique'],
      });
    }
    return categoryRow({ id: Number(id), ...body });
  };
  categories.remove = async (id) => {
    if (Number(id) === 999) throw httpError(404, { message: 'Category not found' });
    if (Number(id) === 5) {
      throw httpError(409, {
        message: 'Cannot delete category "Stay": 2 articles still reference it. Reassign or delete those articles first.',
        articleCount: 2,
      });
    }
    return { id: Number(id) };
  };

  seo.list = async () => ({
    pages: seo.VALID_PAGE_KEYS.map((pageKey) => ({
      page_key: pageKey,
      meta_title: null,
      meta_description: null,
      og_image: null,
      noindex: 0,
      keywords: null,
      faqs: [],
      created_at: null,
      updated_at: null,
    })),
  });
  seo.get = async (pageKey) => (pageKey === 'page:gallery' ? null : {
    page_key: pageKey,
    meta_title: 'Title',
    meta_description: null,
    og_image: null,
    noindex: 0,
    keywords: null,
    faqs: [],
    created_at: null,
    updated_at: null,
  });
  seo.upsert = async (pageKey, body) => {
    state.upserts.push({ pageKey, body });
    return {
      page_key: pageKey,
      meta_title: body.meta_title ?? null,
      meta_description: body.meta_description ?? null,
      og_image: body.og_image ?? null,
      noindex: body.noindex === undefined ? 0 : body.noindex,
      keywords: body.keywords ?? null,
      faqs: (body.faqs || []).map((faq, index) => ({ ...faq, position: index })),
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:00:00',
    };
  };
  seo.remove = async (pageKey) => {
    if (pageKey === 'page:reviews') throw httpError(404, { message: 'Page not found' });
    return { pageKey };
  };

  redirects.list = async () => [redirectRow()];
  redirects.get = async (id) => (Number(id) === 999 ? null : redirectRow({ id: Number(id) }));
  redirects.create = async (body) => {
    state.createdRedirects.push(body);
    if (body.from_path === body.to_path) {
      throw httpError(400, {
        message: 'from_path and to_path must be different',
        errors: ['from_path and to_path must be different'],
      });
    }
    if (body.from_path === '/stay') {
      throw httpError(400, {
        message: 'from_path shadows an existing route',
        errors: ['from_path shadows an existing route'],
      });
    }
    if (body.from_path === '/taken') {
      throw httpError(409, {
        message: 'A redirect with this from_path already exists',
        errors: ['from_path must be unique'],
      });
    }
    return redirectRow({ id: 301, from_path: body.from_path, to_path: body.to_path, status: body.status || 301 });
  };
  redirects.update = async (id, body) => {
    state.patchedRedirects.push({ id: Number(id), body });
    if (Number(id) === 999) throw httpError(404, { message: 'Redirect not found' });
    if (body.to_path === '/old') {
      throw httpError(400, {
        message: 'from_path and to_path must be different',
        errors: ['from_path and to_path must be different'],
      });
    }
    return redirectRow({ id: Number(id), ...body });
  };
  redirects.remove = async (id) => {
    if (Number(id) === 999) throw httpError(404, { message: 'Redirect not found' });
    return { id: Number(id) };
  };

  app = await startApp();
});

test.after(async () => {
  if (app) await app.close();
  for (const [name, fn] of Object.entries(originals.categories)) categories[name] = fn;
  for (const [name, fn] of Object.entries(originals.seo)) seo[name] = fn;
  for (const [name, fn] of Object.entries(originals.redirects)) redirects[name] = fn;
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

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

test('categories: key and categories:read are required', async () => {
  const anonymous = await app.request('GET', '/api/agent/v1/categories');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error.code, 'UNAUTHORIZED');

  const forbidden = await app.request('GET', '/api/agent/v1/categories', {
    headers: bearer(noCategoryRead.generated.key),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error.code, 'FORBIDDEN');
  assert.equal(forbidden.json.error.context.required_scope, 'categories:read');
});

test('GET /categories: envelope with data.items', async () => {
  const res = await app.request('GET', '/api/agent/v1/categories', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.data.items.length, 1);
  assert.equal(res.json.data.items[0].slug, 'stay');
  assert.equal(typeof res.json.meta.request_id, 'string');
});

test('GET /categories/:id: invalid -> 400, missing -> 404', async () => {
  const invalid = await app.request('GET', '/api/agent/v1/categories/abc', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'VALIDATION_ERROR');

  const missing = await app.request('GET', '/api/agent/v1/categories/999', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
});

test('POST /categories: reader without categories:write -> 403', async () => {
  const res = await app.request('POST', '/api/agent/v1/categories', {
    headers: bearer(reader.generated.key),
    body: { name: 'Dining', slug: 'dining' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.context.required_scope, 'categories:write');
});

test('POST /categories: 201, created data and an audit row', async () => {
  state.createdCategories.length = 0;
  const requestId = 'zz-http-category-create';
  db.audits.length = 0;

  const res = await app.request('POST', '/api/agent/v1/categories', {
    headers: { ...bearer(admin.generated.key), 'X-Request-Id': requestId },
    body: { name: 'Dining', slug: 'dining', description: 'Food' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.data.slug, 'dining');
  assert.equal(state.createdCategories.length, 1);

  await wait();
  const row = db.audits.find((params) => params[7] === requestId);
  assert.ok(row, 'successful category audit row missing');
  assert.equal(row[4], 'category');
  assert.equal(String(row[5]), '201');
  assert.equal(row[6], 201);
});

test('PATCH /categories/:id: partial body reaches the service; duplicate slug -> 409', async () => {
  state.patchedCategories.length = 0;
  const res = await app.request('PATCH', '/api/agent/v1/categories/1', {
    headers: bearer(admin.generated.key),
    body: { description: null },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(state.patchedCategories[0], { id: 1, body: { description: null } });
  assert.equal(res.json.data.description, null);

  const duplicate = await app.request('PATCH', '/api/agent/v1/categories/1', {
    headers: bearer(admin.generated.key),
    body: { slug: 'dup' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, 'CONFLICT');
  assert.deepEqual(duplicate.json.error.details, [{ message: 'slug must be unique' }]);
});

test('DELETE /categories/:id: confirmation, delete scope and referenced 409', async () => {
  const missingHeader = await app.request('DELETE', '/api/agent/v1/categories/1', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(missingHeader.status, 400);
  assert.equal(missingHeader.json.error.code, 'CONFIRMATION_REQUIRED');
  assert.deepEqual(missingHeader.json.error.context, { header: 'X-Confirm-Delete' });

  const editorDelete = await app.request('DELETE', '/api/agent/v1/categories/1', {
    headers: { ...bearer(editor.generated.key), 'X-Confirm-Delete': 'true' },
  });
  assert.equal(editorDelete.status, 403);
  assert.equal(editorDelete.json.error.context.required_scope, 'categories:delete');

  const referenced = await app.request('DELETE', '/api/agent/v1/categories/5', {
    headers: { ...bearer(admin.generated.key), 'X-Confirm-Delete': 'true' },
  });
  assert.equal(referenced.status, 409);
  assert.equal(referenced.json.error.context.articleCount, 2);

  const deleted = await app.request('DELETE', '/api/agent/v1/categories/1', {
    headers: { ...bearer(admin.generated.key), 'X-Confirm-Delete': '1' },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json.data, { id: 1, deleted: true });
});

// ---------------------------------------------------------------------------
// seo-pages
// ---------------------------------------------------------------------------

test('GET /seo-pages: data.items holds the 18 official entries', async () => {
  const res = await app.request('GET', '/api/agent/v1/seo-pages', {
    headers: bearer(editor.generated.key),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.items.length, 18);
  assert.equal(res.json.data.items[0].page_key, 'page:home');
});

test('GET /seo-pages/:pageKey: invalid -> 400 with validKeys, missing -> 404', async () => {
  const invalid = await app.request('GET', '/api/agent/v1/seo-pages/page:not-real', {
    headers: bearer(editor.generated.key),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'VALIDATION_ERROR');
  assert.equal(invalid.json.error.context.validKeys.length, 18);

  const missing = await app.request('GET', '/api/agent/v1/seo-pages/page:gallery', {
    headers: bearer(editor.generated.key),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
});

test('GET /seo-pages/:pageKey accepts a URL-encoded colon', async () => {
  const res = await app.request('GET', '/api/agent/v1/seo-pages/page%3Ahome', {
    headers: bearer(editor.generated.key),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.page_key, 'page:home');
});

test('PUT /seo-pages/:pageKey: 200 with the updated page and faqs', async () => {
  state.upserts.length = 0;
  const res = await app.request('PUT', '/api/agent/v1/seo-pages/page:home', {
    headers: bearer(editor.generated.key),
    body: { meta_title: 'Home', meta_description: 'Welcome', faqs: [{ question: 'Q?', answer: 'A.' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.page_key, 'page:home');
  assert.equal(res.json.data.meta_title, 'Home');
  assert.equal(res.json.data.faqs.length, 1);
  assert.equal(state.upserts.length, 1);
});

test('DELETE /seo-pages/:pageKey: confirmation, delete scope, missing row', async () => {
  const missingHeader = await app.request('DELETE', '/api/agent/v1/seo-pages/page:home', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(missingHeader.status, 400);
  assert.equal(missingHeader.json.error.code, 'CONFIRMATION_REQUIRED');

  const editorDelete = await app.request('DELETE', '/api/agent/v1/seo-pages/page:home', {
    headers: { ...bearer(editor.generated.key), 'X-Confirm-Delete': 'true' },
  });
  assert.equal(editorDelete.status, 403);
  assert.equal(editorDelete.json.error.context.required_scope, 'seo:delete');

  const missing = await app.request('DELETE', '/api/agent/v1/seo-pages/page:reviews', {
    headers: { ...bearer(admin.generated.key), 'X-Confirm-Delete': 'true' },
  });
  assert.equal(missing.status, 404);

  const deleted = await app.request('DELETE', '/api/agent/v1/seo-pages/page:home', {
    headers: { ...bearer(admin.generated.key), 'X-Confirm-Delete': 'true' },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json.data, { page_key: 'page:home', deleted: true });
});

// ---------------------------------------------------------------------------
// redirects
// ---------------------------------------------------------------------------

test('redirects: list, invalid id, missing row', async () => {
  const list = await app.request('GET', '/api/agent/v1/redirects', {
    headers: bearer(editor.generated.key),
  });
  assert.equal(list.status, 200);
  assert.equal(list.json.data.items.length, 1);

  const invalid = await app.request('GET', '/api/agent/v1/redirects/abc', {
    headers: bearer(editor.generated.key),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'VALIDATION_ERROR');

  const missing = await app.request('GET', '/api/agent/v1/redirects/999', {
    headers: bearer(editor.generated.key),
  });
  assert.equal(missing.status, 404);
});

test('POST /redirects: 201; self-loop, shadowed route and duplicate -> 400/400/409', async () => {
  const created = await app.request('POST', '/api/agent/v1/redirects', {
    headers: bearer(admin.generated.key),
    body: { from_path: '/old-home', to_path: '/', status: 301 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.from_path, '/old-home');

  const loop = await app.request('POST', '/api/agent/v1/redirects', {
    headers: bearer(admin.generated.key),
    body: { from_path: '/same', to_path: '/same' },
  });
  assert.equal(loop.status, 400);
  assert.equal(loop.json.error.code, 'VALIDATION_ERROR');

  const shadow = await app.request('POST', '/api/agent/v1/redirects', {
    headers: bearer(admin.generated.key),
    body: { from_path: '/stay', to_path: '/rooms' },
  });
  assert.equal(shadow.status, 400);
  assert.equal(shadow.json.error.message, 'from_path shadows an existing route');

  const duplicate = await app.request('POST', '/api/agent/v1/redirects', {
    headers: bearer(admin.generated.key),
    body: { from_path: '/taken', to_path: '/new' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, 'CONFLICT');
});

test('PATCH /redirects/:id: partial body reaches the service; merged self-loop -> 400', async () => {
  state.patchedRedirects.length = 0;
  const patched = await app.request('PATCH', '/api/agent/v1/redirects/1', {
    headers: bearer(admin.generated.key),
    body: { status: 302 },
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(state.patchedRedirects[0], { id: 1, body: { status: 302 } });

  const loop = await app.request('PATCH', '/api/agent/v1/redirects/1', {
    headers: bearer(admin.generated.key),
    body: { to_path: '/old' },
  });
  assert.equal(loop.status, 400);
});

test('DELETE /redirects/:id: confirmation, delete scope, 404 and success', async () => {
  const missingHeader = await app.request('DELETE', '/api/agent/v1/redirects/1', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(missingHeader.status, 400);
  assert.equal(missingHeader.json.error.code, 'CONFIRMATION_REQUIRED');
  assert.deepEqual(missingHeader.json.error.context, { header: 'X-Confirm-Delete' });

  const editorDelete = await app.request('DELETE', '/api/agent/v1/redirects/1', {
    headers: { ...bearer(editor.generated.key), 'X-Confirm-Delete': 'true' },
  });
  assert.equal(editorDelete.status, 403);
  assert.equal(editorDelete.json.error.context.required_scope, 'redirects:delete');

  const missing = await app.request('DELETE', '/api/agent/v1/redirects/999', {
    headers: { ...bearer(admin.generated.key), 'X-Confirm-Delete': 'true' },
  });
  assert.equal(missing.status, 404);

  const deleted = await app.request('DELETE', '/api/agent/v1/redirects/1', {
    headers: { ...bearer(admin.generated.key), 'X-Confirm-Delete': 'true' },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json.data, { id: 1, deleted: true });
});

// ---------------------------------------------------------------------------
// idempotency + audit
// ---------------------------------------------------------------------------

test('POST /categories: idempotent replay returns the stored response and skips the handler', async () => {
  state.createdCategories.length = 0;
  const headers = { ...bearer(admin.generated.key), 'Idempotency-Key': 'zz-http-idem-category' };
  const body = { name: 'Replay', slug: 'replay' };

  const first = await app.request('POST', '/api/agent/v1/categories', { headers, body });
  assert.equal(first.status, 201);
  await wait();

  const second = await app.request('POST', '/api/agent/v1/categories', { headers, body });
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(second.json, first.json);
  assert.equal(state.createdCategories.length, 1);
});

test('failed category mutations are audited once by the agent error handler', async () => {
  const requestId = 'zz-http-category-audit-failure';
  db.audits.length = 0;

  const res = await app.request('POST', '/api/agent/v1/categories', {
    headers: { ...bearer(admin.generated.key), 'X-Request-Id': requestId },
    body: {},
  });
  assert.equal(res.status, 400);
  await wait();

  const rows = db.audits.filter((params) => params[7] === requestId);
  assert.equal(rows.length, 1, 'failed mutation must produce exactly one audit row');
  assert.equal(rows[0][4], 'category');
  assert.equal(rows[0][6], 400);
});

test('successful SEO and redirect mutations write the matching audit resource types', async () => {
  const seoRequestId = 'zz-http-seo-audit';
  const redirectRequestId = 'zz-http-redirect-audit';
  db.audits.length = 0;

  const page = await app.request('PUT', '/api/agent/v1/seo-pages/page:home', {
    headers: { ...bearer(editor.generated.key), 'X-Request-Id': seoRequestId },
    body: { meta_title: 'Home' },
  });
  assert.equal(page.status, 200);

  const redirect = await app.request('POST', '/api/agent/v1/redirects', {
    headers: { ...bearer(admin.generated.key), 'X-Request-Id': redirectRequestId },
    body: { from_path: '/audit-old', to_path: '/audit-new' },
  });
  assert.equal(redirect.status, 201);
  await wait();

  const seoRow = db.audits.find((params) => params[7] === seoRequestId);
  assert.ok(seoRow, 'SEO audit row missing');
  assert.equal(seoRow[4], 'seo_page');
  assert.equal(String(seoRow[5]), 'page:home');
  assert.equal(seoRow[6], 200);

  const redirectRowAudit = db.audits.find((params) => params[7] === redirectRequestId);
  assert.ok(redirectRowAudit, 'redirect audit row missing');
  assert.equal(redirectRowAudit[4], 'redirect');
  assert.equal(redirectRowAudit[6], 201);
});
