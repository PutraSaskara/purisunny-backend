// backend/test/agent/hardening.http.test.js
//
// Release-hardening HTTP checks:
//   * Cache-Control: no-store on public, protected, 401 and 404 responses
//   * CORS preflight allows the Agent API custom headers and exposes the
//     response headers integrators need
//   * 5xx responses never expose stack traces, SQL text or internals
//
// A fake API-key row set keeps the suite MySQL-free.

require('../helpers/env');
process.env.AGENT_API_ENABLED = '1';
process.env.AGENT_RATE_LIMIT_READ = '500';
process.env.AGENT_RATE_LIMIT_WRITE = '500';
process.env.CORS_ORIGIN = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');

const apiKeys = require('../../services/apiKeys');
const auth = require('../../agent/auth');
const articles = require('../../services/articles');
const { startApp } = require('../helpers/app');

const ORIGIN = 'http://localhost:3000';
const ALL_SCOPES = ['articles:read', 'articles:write', 'articles:delete', 'articles:feature'];

function makeRow(id, scopes) {
  const generated = apiKeys.generateApiKey();
  return {
    generated,
    row: {
      id,
      name: 'hardening-admin',
      key_prefix: generated.prefix,
      key_hash: generated.hash,
      user_id: 1,
      scopes: JSON.stringify(scopes),
      is_active: 1,
      expires_at: null,
      last_used_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
      revoked_at: null,
      username: 'zz-test-admin',
      role: 'admin',
    },
  };
}

const admin = makeRow(1, ALL_SCOPES);
const allRows = [admin.row];

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

const originalList = articles.list;
let app;

test.before(async () => {
  apiKeys.__setDbForTests(fakeDb);
  auth.__setDbForTests(fakeDb);
  app = await startApp();
});

test.after(async () => {
  if (app) await app.close();
  articles.list = originalList;
  auth.__setDbForTests(null);
  apiKeys.__setDbForTests(null);
  delete process.env.AGENT_RATE_LIMIT_READ;
  delete process.env.AGENT_RATE_LIMIT_WRITE;
  delete process.env.CORS_ORIGIN;
});

function bearer() {
  return { Authorization: `Bearer ${admin.generated.key}` };
}

test('public, protected and error responses carry Cache-Control: no-store', async () => {
  const publicRes = await app.request('GET', '/api/agent/v1/health');
  assert.equal(publicRes.status, 200);
  assert.equal(publicRes.headers.get('cache-control'), 'no-store');
  assert.equal(typeof publicRes.headers.get('x-request-id'), 'string');

  const protectedRes = await app.request('GET', '/api/agent/v1/me', { headers: bearer() });
  assert.equal(protectedRes.status, 200);
  assert.equal(protectedRes.headers.get('cache-control'), 'no-store');

  const unauthorized = await app.request('GET', '/api/agent/v1/me');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('cache-control'), 'no-store');

  const notFound = await app.request('GET', '/api/agent/v1/does-not-exist', { headers: bearer() });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers.get('cache-control'), 'no-store');
});

test('CORS preflight allows Content-Type, Authorization and Agent API headers', async () => {
  const res = await app.request('OPTIONS', '/api/agent/v1/articles', {
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key,x-confirm-delete,x-request-id',
    },
  });

  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const allowed = String(res.headers.get('access-control-allow-headers') || '').toLowerCase();
  for (const header of ['content-type', 'authorization', 'idempotency-key', 'x-confirm-delete', 'x-request-id']) {
    assert.ok(allowed.includes(header), `missing allowed header: ${header} (got ${allowed})`);
  }
});

test('CORS exposes X-Request-Id, Idempotent-Replayed and rate-limit headers', async () => {
  const res = await app.request('GET', '/api/agent/v1/health', { headers: { Origin: ORIGIN } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const exposed = String(res.headers.get('access-control-expose-headers') || '').toLowerCase();
  for (const header of ['x-request-id', 'idempotent-replayed', 'ratelimit', 'ratelimit-policy']) {
    assert.ok(exposed.includes(header), `missing exposed header: ${header} (got ${exposed})`);
  }
});

test('a 5xx response masks the stack, SQL and provider internals', async () => {
  articles.list = async () => {
    const error = new Error('SECRET-SQL SELECT * FROM api_keys WHERE key_hash = "zz"');
    error.stack = `${error.message}\n    at secret-internal-file.js:1:1`;
    throw error;
  };

  try {
    const res = await app.request('GET', '/api/agent/v1/articles', { headers: bearer() });
    assert.equal(res.status, 500);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error.code, 'INTERNAL_ERROR');
    assert.equal(res.json.error.message, 'Internal server error');
    assert.equal(res.json.error.stack, undefined);
    assert.equal(res.text.includes('SECRET-SQL'), false);
    assert.equal(res.text.includes('SELECT'), false);
    assert.equal(res.text.includes('secret-internal-file'), false);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    articles.list = originalList;
  }
});
