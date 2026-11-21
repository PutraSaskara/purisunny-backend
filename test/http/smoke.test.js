// backend/test/http/smoke.test.js
//
// HTTP smoke tests that do NOT need MySQL:
//   - revalidation contract (wrong secret 401, missing 401, unknown type 400)
//   - upload allowlist (SVG rejected, PNG accepted via the Cloudinary stub)
//   - role matrix (editor denied admin-only routes, admin allowed through to
//     DB-backed handlers which then answer 404/500 for missing rows)
//   - CORS advertises PATCH
//   - 404 catch-all / malformed JSON body
//
// The revalidation checks run against the real frontend route source, the same
// approach as scripts/verify-revalidate.js, but wired into node:test.

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
// Revalidation contract
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

test('revalidate: wrong secret -> 401', async () => {
  const { POST, calls } = loadRevalidateRoute();
  const res = await POST(makeNextRequest({ secret: 'wrong', body: { slug: 'x' } }));
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('revalidate: missing secret header -> 401', async () => {
  const { POST } = loadRevalidateRoute();
  const res = await POST(makeNextRequest({ body: { slug: 'x' } }));
  assert.equal(res.status, 401);
});

test('revalidate: unknown type -> 400', async () => {
  const { POST, calls } = loadRevalidateRoute();
  for (const type of ['bogus', 'Article', 'pages', '123']) {
    const res = await POST(makeNextRequest({
      secret: process.env.REVALIDATE_SECRET,
      body: { slug: 'x', type },
    }));
    assert.equal(res.status, 400, `type=${type}`);
    assert.equal(calls.length, 0);
  }
});

test('revalidate: valid article type -> 200', async () => {
  const { POST, calls } = loadRevalidateRoute();
  const res = await POST(makeNextRequest({
    secret: process.env.REVALIDATE_SECRET,
    body: { slug: 'hello', type: 'article' },
  }));
  assert.equal(res.status, 200);
  assert.ok(calls.some((c) => c.kind === 'tag' && c.tag === 'article:hello'));
});

// ---------------------------------------------------------------------------
// Upload allowlist (Cloudinary stubbed via CLOUDINARY_FAKE_STUB=1)
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636000000002000148af04110000000049454e44ae426082',
  'hex'
);

function uploadForm(filename, contentType, bytes) {
  const fd = new FormData();
  fd.append('image', new Blob([bytes], { type: contentType }), filename);
  return fd;
}

test('upload: SVG is rejected (extension allowlist)', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const res = await app.request('POST', '/api/upload', {
    token: app.adminToken,
    body: uploadForm('evil.svg', 'image/svg+xml', svg),
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /JPEG, PNG, WebP, or GIF/);
});

test('upload: SVG content disguised with .png extension is rejected (magic bytes)', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const res = await app.request('POST', '/api/upload', {
    token: app.adminToken,
    body: uploadForm('evil.png', 'image/png', svg),
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /not a supported image/);
});

test('upload: a real PNG is accepted (stubbed Cloudinary)', async () => {
  const res = await app.request('POST', '/api/upload', {
    token: app.adminToken,
    body: uploadForm('ok.png', 'image/png', PNG_BYTES),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.format, 'png');
  assert.match(res.json.url, /^https:\/\//);
  assert.ok(res.json.public_id);
});

test('upload: editor is refused with 403', async () => {
  const res = await app.request('POST', '/api/upload', {
    token: app.editorToken,
    body: uploadForm('ok.png', 'image/png', PNG_BYTES),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json.required_roles, ['admin']);
});

test('upload: anonymous is refused with 401', async () => {
  const res = await app.request('POST', '/api/upload', {
    body: uploadForm('ok.png', 'image/png', PNG_BYTES),
  });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Role matrix (no DB needed: rejections happen before any query)
// ---------------------------------------------------------------------------

test('role matrix: editor is denied destructive/admin endpoints with 403', async () => {
  const cases = [
    ['DELETE', '/api/articles/1'],
    ['DELETE', '/api/categories/1'],
    ['POST', '/api/categories', { name: 'x', slug: 'x' }],
    ['PUT', '/api/categories/1', { name: 'x', slug: 'x' }],
    ['DELETE', '/api/seo/page%3Ahome'],
    ['POST', '/api/articles', { title: 't', slug: 't', is_featured: true }],
  ];
  for (const [method, url, body] of cases) {
    const res = await app.request(method, url, { token: app.editorToken, body });
    assert.equal(res.status, 403, `${method} ${url}`);
    assert.deepEqual(res.json.required_roles, ['admin'], `${method} ${url}`);
  }
});

test('role matrix: anonymous write attempts are 401', async () => {
  const cases = [
    ['DELETE', '/api/articles/1'],
    ['POST', '/api/articles', { title: 't', slug: 't' }],
    ['DELETE', '/api/seo/page%3Ahome'],
  ];
  for (const [method, url, body] of cases) {
    const res = await app.request(method, url, { body });
    assert.equal(res.status, 401, `${method} ${url}`);
  }
});

test('role matrix: editor may attempt content writes (passes the guard)', async () => {
  // No DB: a passing guard reaches the handler, which fails at the query. Any
  // status other than 401/403 proves the role check let it through.
  const res = await app.request('POST', '/api/articles', {
    token: app.editorToken,
    body: { title: 'zz', slug: 'zz-token-probe' },
  });
  assert.ok(![401, 403].includes(res.status), `status=${res.status}`);
});

test('role matrix: editor cannot feature an article', async () => {
  const res = await app.request('POST', '/api/articles', {
    token: app.editorToken,
    body: { title: 'zz', slug: 'zz-feature-probe', is_featured: '1' },
  });
  assert.equal(res.status, 403);
});

test('role matrix: unknown role in token is treated as editor', async () => {
  const { makeToken } = require('../helpers/app');
  const token = makeToken({ role: 'root' });
  const res = await app.request('DELETE', '/api/articles/1', { token });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// CORS + generic routes
// ---------------------------------------------------------------------------

test('CORS advertises PATCH in Access-Control-Allow-Methods', async () => {
  const res = await app.request('OPTIONS', '/api/articles', {
    headers: {
      Origin: 'http://localhost:3001',
      'Access-Control-Request-Method': 'PATCH',
    },
  });
  const methods = res.headers.get('access-control-allow-methods') || '';
  assert.match(methods, /PATCH/);
});

test('unknown route -> 404 JSON', async () => {
  const res = await app.request('GET', '/api/definitely-not-a-route');
  assert.equal(res.status, 404);
  assert.equal(typeof res.json.message, 'string');
});

test('malformed JSON -> 400 generic message', async () => {
  // authenticateJWT runs before the handler, so send a valid token; the body
  // parser (mounted app-wide) still rejects the malformed payload first.
  const res = await app.request('POST', '/api/categories', {
    token: app.adminToken,
    raw: '{"name": ',
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.message, 'Invalid JSON body');
});

test('health endpoint responds', async () => {
  const res = await app.request('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');
});
