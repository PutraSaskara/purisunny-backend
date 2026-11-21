// backend/test/http/contacts.test.js
//
// GET /api/contacts role matrix and query validation without MySQL:
//   - anonymous -> 401 (authenticateJWT)
//   - editor    -> 403 + required_roles ['admin']
//   - admin passes the guard (any non-401/403 status proves it)
//   - invalid ?limit answers 400 + errors[] BEFORE any DB access
//   - the public POST /api/contact route is untouched by the new GET
//
// The DB-backed half (shape, DESC order, limit, totals) lives in
// test/db/contacts.test.js.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { startApp } = require('../helpers/app');

let app;
// node:http, not fetch: the contact router carries a rate limiter and Windows
// undici keep-alive handles race the test runner's exit (see
// test/db/contact.test.js).
test.before(async () => { app = await startApp({ httpClient: 'node' }); });
test.after(async () => { if (app) await app.close(); });

test('contacts: anonymous GET /api/contacts -> 401', async () => {
  const res = await app.request('GET', '/api/contacts');
  assert.equal(res.status, 401);
  assert.equal(typeof res.json.message, 'string');
});

test('contacts: editor GET /api/contacts -> 403 admin only', async () => {
  const res = await app.request('GET', '/api/contacts', { token: app.editorToken });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json.required_roles, ['admin']);
});

test('contacts: admin passes the guard', async () => {
  const res = await app.request('GET', '/api/contacts', { token: app.adminToken });
  assert.ok(![401, 403].includes(res.status), `status=${res.status}`);
});

test('contacts: invalid ?limit -> 400 + errors[] before any DB access', async () => {
  for (const limit of ['abc', '1.5', '1e2', '-', '10x']) {
    const res = await app.request('GET', `/api/contacts?limit=${encodeURIComponent(limit)}`, {
      token: app.adminToken,
    });
    assert.equal(res.status, 400, `limit=${limit}: status=${res.status}`);
    assert.ok(Array.isArray(res.json.errors), `limit=${limit}: errors missing`);
    assert.equal(typeof res.json.message, 'string');
  }
});

test('contacts: public POST /api/contact is still rate-limit shaped (not auth)', async () => {
  // No token, invalid body: validation answers 400, proving the public route is
  // not behind authenticateJWT. (Every POST counts against the shared limiter,
  // so this stays the only POST in this file.)
  const res = await app.request('POST', '/api/contact', {
    body: { name: '', email: 'nope', phone: '', message: '' },
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.json.errors));
});
