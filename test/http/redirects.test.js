// backend/test/http/redirects.test.js
//
// Redirects API contract without MySQL:
//   - public GET works (500 without a DB, never 401/403 — the route is public)
//   - editor is denied on POST/PUT/DELETE with 403 + required_roles ['admin']
//   - anonymous writes are 401
//   - validation (path grammar, status, self-loop, shadowed routes) answers 400
//     with `errors[]` BEFORE any DB access, so no database is required
//   - the `redirect` revalidate type reaches the redirects cache tag
//
// The DB-backed half (201/200/404/409/auto-redirect) lives in test/db/redirects.test.js.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startApp } = require('../helpers/app');

let app;
test.before(async () => { app = await startApp(); });
test.after(async () => { if (app) await app.close(); });

// ---------------------------------------------------------------------------
// Role matrix
// ---------------------------------------------------------------------------

test('redirects: public GET is not blocked by auth (no token)', async () => {
  const res = await app.request('GET', '/api/redirects');
  assert.ok(![401, 403].includes(res.status), `status=${res.status}`);
});

test('redirects: editor is denied on POST/PUT/DELETE with 403', async () => {
  const cases = [
    ['POST', '/api/redirects', { from_path: '/zz-a', to_path: '/zz-b' }],
    ['PUT', '/api/redirects/1', { to_path: '/zz-b' }],
    ['DELETE', '/api/redirects/1'],
  ];
  for (const [method, url, body] of cases) {
    const res = await app.request(method, url, { token: app.editorToken, body });
    assert.equal(res.status, 403, `${method} ${url}`);
    assert.deepEqual(res.json.required_roles, ['admin'], `${method} ${url}`);
  }
});

test('redirects: anonymous writes are 401', async () => {
  const cases = [
    ['POST', '/api/redirects', { from_path: '/zz-a', to_path: '/zz-b' }],
    ['PUT', '/api/redirects/1', { to_path: '/zz-b' }],
    ['DELETE', '/api/redirects/1'],
  ];
  for (const [method, url, body] of cases) {
    const res = await app.request(method, url, { body });
    assert.equal(res.status, 401, `${method} ${url}`);
  }
});

// ---------------------------------------------------------------------------
// Validation (400 before any DB access)
// ---------------------------------------------------------------------------

test('redirects: 400 + errors[] for invalid paths', async () => {
  const cases = [
    ['missing to_path', { from_path: '/zz-a' }],
    ['no leading slash', { from_path: 'zz-a', to_path: '/zz-b' }],
    ['scheme/host', { from_path: 'https://evil.example/x', to_path: '/zz-b' }],
    ['hash', { from_path: '/zz-a#frag', to_path: '/zz-b' }],
    ['identical paths', { from_path: '/zz-a', to_path: '/zz-a' }],
    ['too long', { from_path: `/${'a'.repeat(256)}`, to_path: '/zz-b' }],
    ['bad status', { from_path: '/zz-a', to_path: '/zz-b', status: 307 }],
    ['internal target', { from_path: '/zz-a', to_path: '/api/articles' }],
  ];
  for (const [label, body] of cases) {
    const res = await app.request('POST', '/api/redirects', { token: app.adminToken, body });
    assert.equal(res.status, 400, `${label}: status=${res.status}`);
    assert.ok(Array.isArray(res.json.errors), `${label}: errors missing`);
    assert.equal(typeof res.json.message, 'string');
  }
});

test('redirects: 400 for from_path values that shadow a live route', async () => {
  const shadowed = ['/', '/gallery', '/stay', '/stay/rooms/deluxe-room', '/journal/page/2', '/api/health', '/sitemap.xml'];
  for (const fromPath of shadowed) {
    const res = await app.request('POST', '/api/redirects', {
      token: app.adminToken,
      body: { from_path: fromPath, to_path: '/zz-target' },
    });
    assert.equal(res.status, 400, `${fromPath}: status=${res.status}`);
    assert.ok(
      res.json.errors.includes('from_path shadows an existing route'),
      `${fromPath}: errors=${JSON.stringify(res.json.errors)}`
    );
  }
});

test('redirects: shadow check is segment-aware (/apiary is allowed)', async () => {
  // Validation passes, so the handler runs and (without a DB) fails at the
  // query: any non-400 status proves the path was not rejected as a shadow.
  const res = await app.request('POST', '/api/redirects', {
    token: app.adminToken,
    body: { from_path: '/apiary', to_path: '/gallery' },
  });
  assert.notEqual(res.status, 400, `status=${res.status} body=${JSON.stringify(res.json)}`);
});

test('redirects: PUT validates supplied fields only', async () => {
  const res = await app.request('PUT', '/api/redirects/1', {
    token: app.adminToken,
    body: { to_path: 'nope' },
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.json.errors));

  const shadow = await app.request('PUT', '/api/redirects/1', {
    token: app.adminToken,
    body: { from_path: '/rooms' },
  });
  assert.equal(shadow.status, 400);
  assert.ok(shadow.json.errors.includes('from_path shadows an existing route'));
});

test('redirects: non-numeric id -> 400', async () => {
  for (const method of ['PUT', 'DELETE']) {
    const res = await app.request(method, '/api/redirects/abc', { token: app.adminToken, body: { to_path: '/zz-b' } });
    assert.equal(res.status, 400, `${method}: status=${res.status}`);
  }
});

// ---------------------------------------------------------------------------
// Revalidate: type 'redirect'
// ---------------------------------------------------------------------------

function loadRevalidateRoute() {
  const routeFile = path.join(__dirname, '..', '..', '..', 'frontend', 'app', 'api', 'revalidate', 'route.js');
  const source = fs.readFileSync(routeFile, 'utf8');
  const patched = source
    .replace(/^import \{ revalidateTag, revalidatePath \} from 'next\/cache';$/m, '')
    .replace(/^import \{ createHash, timingSafeEqual \} from 'node:crypto';$/m, '')
    .replace(/^import \{ pageKeyToPath \} from '@\/lib\/pageSeo';$/m, '')
    .replace(/^export async function POST/m, 'async function POST');

  const calls = [];
  const body = `
    const { createHash, timingSafeEqual } = __stubs.crypto;
    const { revalidateTag, revalidatePath } = __stubs.cache;
    const pageKeyToPath = __stubs.pageKeyToPath;
    const fetch = __stubs.fetch;
    ${patched}
    return { POST };
  `;
  const factory = new Function('__stubs', body);
  const { POST } = factory({
    cache: {
      revalidateTag: (tag, profile) => calls.push({ kind: 'tag', tag, profile }),
      revalidatePath: (p, type) => calls.push({ kind: 'path', path: p, type }),
    },
    crypto: require('node:crypto'),
    pageKeyToPath: (key) => (key.startsWith('page:') ? `/${key.slice(5)}` : null),
    fetch: async () => ({ status: 200, ok: true }),
  });
  return { POST, calls };
}

function makeNextRequest({ secret, body }) {
  const headers = new Map();
  if (secret !== undefined) headers.set('x-revalidate-secret', secret);
  return {
    headers: { get: (name) => (headers.has(name) ? headers.get(name) : null) },
    json: async () => body,
  };
}

test('revalidate: type=redirect (no slug) -> 200 + redirects tag', async () => {
  const { POST, calls } = loadRevalidateRoute();
  const res = await POST(makeNextRequest({
    secret: process.env.REVALIDATE_SECRET,
    body: { type: 'redirect' },
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { revalidated: true });
  assert.deepEqual(calls.map((c) => c.tag), ['redirects']);
});

test('revalidate: type=redirect still requires the secret', async () => {
  const { POST, calls } = loadRevalidateRoute();
  const res = await POST(makeNextRequest({ secret: 'wrong', body: { type: 'redirect' } }));
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('revalidate: missing slug still 400 for article/page types', async () => {
  const { POST } = loadRevalidateRoute();
  for (const type of [undefined, 'article', 'page']) {
    const res = await POST(makeNextRequest({
      secret: process.env.REVALIDATE_SECRET,
      body: type ? { type } : {},
    }));
    assert.equal(res.status, 400, `type=${type}`);
  }
});

test('revalidate: redirect type is advertised in the unsupported-type message', async () => {
  const { POST } = loadRevalidateRoute();
  const res = await POST(makeNextRequest({
    secret: process.env.REVALIDATE_SECRET,
    body: { slug: 'x', type: 'bogus' },
  }));
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.message, /redirect/);
});
