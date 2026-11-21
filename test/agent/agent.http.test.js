// backend/test/agent/agent.http.test.js
//
// HTTP contract for /api/agent/v1 meta endpoints. Uses a fake DB row set, so
// no MySQL is required.

require('../helpers/env');
process.env.AGENT_API_ENABLED = '1';
process.env.AGENT_BODY_LIMIT = '1kb';
process.env.AGENT_RATE_LIMIT_READ = '2';
process.env.AGENT_RATE_LIMIT_WRITE = '30';
delete process.env.PUBLIC_API_BASE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');

const apiKeys = require('../../services/apiKeys');
const auth = require('../../agent/auth');
const { startApp } = require('../helpers/app');

function rowFor({ id, name, role, scopes, expiresAt = null, revokedAt = null, isActive = 1 }) {
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
      is_active: isActive,
      expires_at: expiresAt,
      last_used_at: null,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      revoked_at: revokedAt,
      username: role === 'admin' ? 'zz-test-admin' : 'zz-test-editor',
      role,
    },
  };
}

const admin = rowFor({
  id: 1,
  name: 'n8n',
  role: 'admin',
  scopes: ['articles:read', 'articles:write', 'contacts:read'],
});
const editor = rowFor({
  id: 2,
  name: 'editor-key',
  role: 'editor',
  scopes: ['articles:read', 'seo:write'],
});
const expired = rowFor({
  id: 3,
  name: 'expired',
  role: 'admin',
  scopes: ['articles:read'],
  expiresAt: new Date(Date.now() - 60_000),
});
const revoked = rowFor({
  id: 4,
  name: 'revoked',
  role: 'admin',
  scopes: ['articles:read'],
  revokedAt: new Date(),
});
const inactive = rowFor({
  id: 5,
  name: 'inactive',
  role: 'admin',
  scopes: ['articles:read'],
  isActive: 0,
});
const rateLimited = rowFor({
  id: 6,
  name: 'rate-limited',
  role: 'admin',
  scopes: ['articles:read'],
});

const allRows = [admin, editor, expired, revoked, inactive, rateLimited].map((entry) => entry.row);

const fakeDb = {
  async query(sql, params) {
    if (/FROM api_keys k/i.test(sql)) {
      const prefix = params && params[0];
      return [allRows.filter((row) => row.key_prefix === prefix)];
    }
    if (/UPDATE api_keys SET last_used_at/i.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  },
};

let app;

test.before(async () => {
  apiKeys.__setDbForTests(fakeDb);
  auth.__setDbForTests(fakeDb);
  app = await startApp();
});

test.after(async () => {
  if (app) await app.close();
  auth.__setDbForTests(null);
  apiKeys.__setDbForTests(null);
  delete process.env.AGENT_BODY_LIMIT;
  delete process.env.AGENT_RATE_LIMIT_READ;
});

function bearer(key) {
  return { Authorization: `Bearer ${key}` };
}

test('GET /health: public success envelope + request id header', async () => {
  const res = await app.request('GET', '/api/agent/v1/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.data.status, 'ok');
  assert.equal(typeof res.json.data.timestamp, 'string');
  assert.match(res.json.data.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof res.json.meta.request_id, 'string');
  assert.equal(res.headers.get('x-request-id'), res.json.meta.request_id);
  assert.equal(typeof res.json.data.request_id, 'undefined');
});

test('GET /manifest: documents auth, scopes, rate limits and implemented tools', async () => {
  const res = await app.request('GET', '/api/agent/v1/manifest');
  assert.equal(res.status, 200);
  const manifest = res.json.data;
  assert.equal(manifest.name, 'Puri Sunny Agent API');
  assert.equal(manifest.base_url, '/api/agent/v1');
  assert.equal(manifest.auth.type, 'bearer');
  assert.ok(manifest.scopes.includes('articles:read'));
  assert.ok(manifest.scopes.includes('media:write'));
  assert.equal(manifest.scopes.includes('*'), false);
  assert.equal(manifest.rate_limits.read.limit, 2); // test app overrides the 120/min default
  assert.deepEqual(
    manifest.tools.map((tool) => `${tool.method} ${tool.path}`).sort(),
    [
      'DELETE /articles/{id}',
      'DELETE /categories/{id}',
      'DELETE /contacts/{id}',
      'DELETE /redirects/{id}',
      'DELETE /seo-pages/{pageKey}',
      'GET /articles',
      'GET /articles/by-slug/{slug}',
      'GET /articles/{id}',
      'GET /categories',
      'GET /categories/{id}',
      'GET /contacts',
      'GET /contacts/{id}',
      'GET /health',
      'GET /manifest',
      'GET /me',
      'GET /openapi.json',
      'GET /redirects',
      'GET /redirects/{id}',
      'GET /seo-pages',
      'GET /seo-pages/{pageKey}',
      'PATCH /articles/{id}',
      'PATCH /categories/{id}',
      'PATCH /contacts/{id}',
      'PATCH /redirects/{id}',
      'POST /articles',
      'POST /articles/upsert',
      'POST /articles/validate',
      'POST /categories',
      'POST /contacts',
      'POST /media',
      'POST /redirects',
      'PUT /seo-pages/{pageKey}',
    ]
  );
  for (const tool of manifest.tools) {
    assert.equal(typeof tool.operation_id, 'string');
    assert.ok(Object.prototype.hasOwnProperty.call(tool, 'required_scope'));
  }
});

test('GET /openapi.json: raw OpenAPI 3.1 document with bearer security and article paths', async () => {
  const res = await app.request('GET', '/api/agent/v1/openapi.json');
  assert.equal(res.status, 200);
  assert.equal(typeof res.headers.get('x-request-id'), 'string');
  const doc = res.json; // raw document, not an envelope
  assert.equal(doc.ok, undefined);
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.components.securitySchemes.bearerAuth.type, 'http');
  assert.equal(doc.components.securitySchemes.bearerAuth.scheme, 'bearer');
  assert.ok(doc.paths['/me']);
  assert.deepEqual(doc.paths['/me'].get.security, [{ bearerAuth: [] }]);
  assert.deepEqual(doc.paths['/health'].get.security, []);
  for (const path of [
    '/articles',
    '/articles/{id}',
    '/articles/by-slug/{slug}',
    '/articles/validate',
    '/articles/upsert',
    '/contacts',
    '/contacts/{id}',
    '/media',
  ]) {
    assert.ok(doc.paths[path], path);
  }
  assert.ok(doc.paths['/media'].post.requestBody.content['multipart/form-data']);
  assert.ok(doc.paths['/media'].post.requestBody.content['application/json']);
  assert.deepEqual(doc.paths['/contacts'].post.security, [{ bearerAuth: [] }]);
  assert.equal(doc.paths['/contacts'].post['x-required-scope'], 'contacts:write');
  assert.equal(doc.paths['/contacts/{id}'].delete['x-required-scope'], 'contacts:delete');

  // Every article operation documents the agent error surface + bearer auth.
  for (const path of ['/articles', '/articles/{id}', '/articles/by-slug/{slug}', '/articles/validate', '/articles/upsert']) {
    for (const operation of Object.values(doc.paths[path])) {
      for (const status of ['400', '401', '403', '404', '409', '429', '503']) {
        assert.ok(operation.responses[status], `${path} missing ${status}`);
      }
      assert.deepEqual(operation.security, [{ bearerAuth: [] }], path);
      assert.equal(typeof operation['x-required-scope'], 'string', path);
    }
  }
});

test('manifest tools match the OpenAPI operation ids, methods and paths', async () => {
  const manifest = (await app.request('GET', '/api/agent/v1/manifest')).json.data;
  const doc = (await app.request('GET', '/api/agent/v1/openapi.json')).json;

  for (const tool of manifest.tools) {
    const operation = doc.paths[tool.path] && doc.paths[tool.path][tool.method.toLowerCase()];
    assert.ok(operation, `${tool.method} ${tool.path} missing from OpenAPI`);
    assert.equal(operation.operationId, tool.operation_id, `${tool.method} ${tool.path}`);
  }
});

test('GET /me: missing key -> 401 generic envelope', async () => {
  const res = await app.request('GET', '/api/agent/v1/me');
  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error.code, 'UNAUTHORIZED');
  assert.equal(res.json.error.message, 'Unauthorized');
  assert.equal(typeof res.json.meta.request_id, 'string');
});

test('GET /me: valid key -> key identity, owner, scopes and rate limits', async () => {
  const res = await app.request('GET', '/api/agent/v1/me', { headers: bearer(admin.generated.key) });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.id, 1);
  assert.equal(res.json.data.name, 'n8n');
  assert.equal(res.json.data.prefix, admin.generated.prefix);
  assert.deepEqual(res.json.data.owner, { username: 'zz-test-admin', role: 'admin' });
  assert.deepEqual(res.json.data.scopes, ['articles:read', 'articles:write', 'contacts:read']);
  assert.equal(res.json.data.expires_at, null);
  assert.equal(res.json.data.rate_limits.read.limit, 2); // test override
  assert.equal(res.json.data.rate_limits.write.limit, 30);
});

test('GET /me: editor key -> 200 (role itself is not a reason to reject)', async () => {
  const res = await app.request('GET', '/api/agent/v1/me', { headers: bearer(editor.generated.key) });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.owner.role, 'editor');
  assert.deepEqual(res.json.data.scopes, ['articles:read', 'seo:write']);
});

test('GET /me: invalid, expired, revoked, inactive keys -> identical 401', async () => {
  const invalid = `psk_live_${admin.generated.prefix}_wrong-secret`;
  for (const key of [invalid, expired.generated.key, revoked.generated.key, inactive.generated.key, 'not-a-key']) {
    const res = await app.request('GET', '/api/agent/v1/me', { headers: bearer(key) });
    assert.equal(res.status, 401, key.slice(0, 24));
    assert.equal(res.json.error.code, 'UNAUTHORIZED');
    assert.equal(res.json.error.message, 'Unauthorized');
  }
});

test('kill switch: AGENT_API_ENABLED=0 -> 503 for public and protected routes', async () => {
  process.env.AGENT_API_ENABLED = '0';
  try {
    for (const path of ['/api/agent/v1/health', '/api/agent/v1/me']) {
      const res = await app.request('GET', path, { headers: bearer(admin.generated.key) });
      assert.equal(res.status, 503, path);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(typeof res.json.meta.request_id, 'string');
    }
  } finally {
    process.env.AGENT_API_ENABLED = '1';
  }
});

test('request id: safe caller value is echoed, unsafe value is replaced', async () => {
  const safe = await app.request('GET', '/api/agent/v1/health', {
    headers: { 'X-Request-Id': 'caller_req-123' },
  });
  assert.equal(safe.json.meta.request_id, 'caller_req-123');
  assert.equal(safe.headers.get('x-request-id'), 'caller_req-123');

  const unsafe = await app.request('GET', '/api/agent/v1/health', {
    headers: { 'X-Request-Id': 'not safe!' },
  });
  assert.match(unsafe.json.meta.request_id, /^[0-9a-f-]{36}$/);
  assert.notEqual(unsafe.json.meta.request_id, 'not safe!');
});

test('unknown agent route with a valid key -> agent 404 envelope', async () => {
  const res = await app.request('GET', '/api/agent/v1/does-not-exist', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(res.status, 404);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error.code, 'NOT_FOUND');
  assert.equal(typeof res.json.meta.request_id, 'string');
});

test('unknown agent route without a key -> 401, not the legacy 404 body', async () => {
  const res = await app.request('GET', '/api/agent/v1/does-not-exist');
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'UNAUTHORIZED');
  assert.equal(typeof res.json.message, 'undefined');
});

test('body larger than AGENT_BODY_LIMIT -> 413 envelope', async () => {
  const huge = JSON.stringify({ payload: 'x'.repeat(2048) });
  const res = await app.request('POST', '/api/agent/v1/me', {
    headers: bearer(admin.generated.key),
    raw: huge,
  });
  assert.equal(res.status, 413);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error.code, 'PAYLOAD_TOO_LARGE');
});

test('per-key read limiter returns a RATE_LIMITED envelope', async () => {
  // Limit is 2/min (set above). Each call uses a dedicated key id.
  const first = await app.request('GET', '/api/agent/v1/me', { headers: bearer(rateLimited.generated.key) });
  const second = await app.request('GET', '/api/agent/v1/me', { headers: bearer(rateLimited.generated.key) });
  const third = await app.request('GET', '/api/agent/v1/me', { headers: bearer(rateLimited.generated.key) });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 429);
  assert.equal(third.json.ok, false);
  assert.equal(third.json.error.code, 'RATE_LIMITED');
  assert.ok(third.headers.get('ratelimit') || third.headers.get('ratelimit-limit'));
});
