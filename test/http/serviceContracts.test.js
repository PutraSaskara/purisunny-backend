// backend/test/http/serviceContracts.test.js
//
// HTTP contract checks that do not need MySQL. These complement the existing
// route suites and pin the behaviour that moved into the service layer:
//   - SEO rejects an unknown page key before any DB access
//   - redirects reject a self-loop before any DB access
//   - POST /api/contact validation stays 400 { message, errors[] }
//   - upload auth/extension/magic-byte rules stay unchanged
//
// The DB-backed article/category/contact side effects live in
// test/db/serviceSideEffects.test.js.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { startApp } = require('../helpers/app');
const contactRoute = require('../../routes/contact');

let app;
let uploadApp;

test.before(async () => {
  // node:http for the rate-limited contact router (same Windows undici reason
  // documented in test/http/contacts.test.js).
  app = await startApp({ httpClient: 'node' });
  // fetch for multipart uploads: the node:http helper only forwards string
  // bodies, and FormData needs fetch.
  uploadApp = await startApp();
});

test.after(async () => {
  if (app) await app.close();
  if (uploadApp) await uploadApp.close();
});

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636000000002000148af04110000000049454e44ae426082',
  'hex'
);

function uploadForm(filename, contentType, bytes) {
  const fd = new FormData();
  fd.append('image', new Blob([bytes], { type: contentType }), filename);
  return fd;
}

// ---------------------------------------------------------------------------
// SEO
// ---------------------------------------------------------------------------

test('SEO: unknown page_key on PUT -> 400 + validKeys before any DB work', async () => {
  const res = await app.request('PUT', '/api/seo/page%3Anot-real', {
    token: app.adminToken,
    body: { meta_title: 'x' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /Invalid page_key/);
  assert.ok(Array.isArray(res.json.validKeys));
  assert.equal(res.json.validKeys.length, 18);
});

test('SEO: unknown page_key on DELETE -> 400 + validKeys', async () => {
  const res = await app.request('DELETE', '/api/seo/page%3Anot-real', {
    token: app.adminToken,
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.validKeys.length, 18);
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

test('redirects: POST self-loop -> 400 errors[]', async () => {
  const res = await app.request('POST', '/api/redirects', {
    token: app.adminToken,
    body: { from_path: '/zz-service-same', to_path: '/zz-service-same' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.message, 'from_path and to_path must be different');
  assert.ok(res.json.errors.includes('from_path and to_path must be different'));
});

// ---------------------------------------------------------------------------
// Contact validation
// ---------------------------------------------------------------------------

test('contact route: __setDbForTests stays functional for the admin inbox', async () => {
  contactRoute.__setDbForTests({
    async query(sql) {
      if (/SELECT COUNT\(\*\) AS total/.test(sql)) {
        return [[{ total: 1, unread: 0 }]];
      }
      if (/FROM contacts/.test(sql)) {
        return [[{
          id: 1,
          name: 'ZZ seam',
          email: 'seam@example.test',
          phone: null,
          message: 'seam message',
          is_read: 0,
          created_at: '2026-01-01 00:00:00',
        }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  });

  try {
    const res = await app.request('GET', '/api/contacts?limit=1', { token: app.adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.json.contacts[0].name, 'ZZ seam');
    assert.equal(res.json.total, 1);
  } finally {
    contactRoute.__setDbForTests(null);
  }
});

test('contact: invalid payload -> 400 { message, errors[] }', async () => {
  const res = await app.request('POST', '/api/contact', {
    body: { name: '', email: 'nope', phone: '', message: '' },
  });
  assert.equal(res.status, 400);
  assert.equal(typeof res.json.message, 'string');
  assert.ok(Array.isArray(res.json.errors));
  assert.ok(res.json.errors.includes('name is required'));
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

test('upload: anonymous -> 401', async () => {
  const res = await uploadApp.request('POST', '/api/upload', {
    body: uploadForm('ok.png', 'image/png', PNG_BYTES),
  });
  assert.equal(res.status, 401);
});

test('upload: editor -> 403 admin only', async () => {
  const res = await uploadApp.request('POST', '/api/upload', {
    token: uploadApp.editorToken,
    body: uploadForm('ok.png', 'image/png', PNG_BYTES),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json.required_roles, ['admin']);
});

test('upload: SVG extension -> 400', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const res = await uploadApp.request('POST', '/api/upload', {
    token: uploadApp.adminToken,
    body: uploadForm('evil.svg', 'image/svg+xml', svg),
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /JPEG, PNG, WebP, or GIF/);
});

test('upload: SVG content disguised as .png -> 400 magic bytes', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const res = await uploadApp.request('POST', '/api/upload', {
    token: uploadApp.adminToken,
    body: uploadForm('evil.png', 'image/png', svg),
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /not a supported image/);
});
