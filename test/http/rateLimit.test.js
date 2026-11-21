// backend/test/http/rateLimit.test.js
//
// Login brute-force protection: 5 failed attempts per IP / 15 min, then 429.
//
// No DB needed: the rate limiter runs before the users query, and every failed
// lookup counts (skipSuccessfulRequests only exempts 2xx responses), so unknown
// credentials with no database still exercise the 429 path. The auth route's
// handler logs its own DB error per attempt; that noise is expected here.
//
// NOTE: express-rate-limit keeps its store on the limiter module, which is
// shared by every app instance in this process. Order matters, so the
// missing-credentials check runs first while the window is still fresh.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { startApp } = require('../helpers/app');

let app;
// node:http, not fetch: under `node --test --test-force-exit` on Windows the
// global fetch (undici) keep-alive handles race the forced exit on a
// rate-limited route and abort with "Assertion failed: … UV_HANDLE_CLOSING".
// node:http leaves no such handle. Same reason in test/db/contact.test.js.
test.before(async () => { app = await startApp({ httpClient: 'node' }); });
test.after(async () => { if (app) await app.close(); });

test('login missing credentials -> 400 (counts toward the limit too)', async () => {
  const res = await app.request('POST', '/api/auth/login', { body: {} });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /username and password required/i);
});

test('login returns 429 after 5 failed attempts', async () => {
  // The 400 above already consumed one slot; make four more failures and the
  // window is exhausted at 5.
  for (let i = 0; i < 4; i += 1) {
    const res = await app.request('POST', '/api/auth/login', {
      body: { username: `nobody-${i}`, password: 'wrong-password' },
    });
    // Without a DB this is a 500; with one it is a 401. Either way it counts as
    // a failed attempt because it is not 2xx.
    assert.notEqual(res.status, 429, `attempt ${i + 2} must not be limited yet`);
    assert.notEqual(res.status, 200, 'must not authenticate with bogus credentials');
  }

  const sixth = await app.request('POST', '/api/auth/login', {
    body: { username: 'nobody', password: 'wrong-password' },
  });
  assert.equal(sixth.status, 429);
  assert.match(sixth.json.message, /Too many login attempts/);
  assert.ok(sixth.headers.get('ratelimit') || sixth.headers.get('retry-after'), 'expected rate-limit headers');
});
