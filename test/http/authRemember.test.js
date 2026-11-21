// backend/test/http/authRemember.test.js
//
// POST /api/auth/login "Remember me" contract:
//   remember === true           -> token expires in ~30 days
//   remember absent / false     -> token expires in ~24 hours
//   remember non-boolean junk   -> ignored, ~24 hours (never a 400)
// Response shape, rate limit and lockout behaviour stay unchanged.
//
// No MySQL needed: routes/auth.js exposes __setDbForTests so the user lookup
// returns a fixed bcrypt hash. The fake pool only answers the users query.
//
// NOTE: loginLimiter is 5 failed attempts / 15 min / IP and its store lives on
// the module. Successful logins are not counted (skipSuccessfulRequests), so
// the 2xx cases below do not consume the budget. node:http is used for the
// same --test-force-exit reason as test/http/rateLimit.test.js.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { startApp } = require('../helpers/app');

const DAY = 24 * 60 * 60;
const TOLERANCE_S = 60;

const PASSWORD = 'zz-test-password';
const USERNAME = 'zz-remember-user';

let app;
let authRoute;
let passwordHash;

function fakePool() {
  return {
    async query(sql, params) {
      if (/FROM users/i.test(sql) && params.includes(USERNAME)) {
        return [[{
          id: 4242,
          username: USERNAME,
          email: 'zz-remember@example.test',
          password: passwordHash,
          role: 'admin',
        }]];
      }
      return [[]];
    },
  };
}

function lifetimeSeconds(token) {
  const decoded = jwt.decode(token);
  assert.ok(decoded && decoded.iat && decoded.exp, 'token must carry iat and exp');
  return decoded.exp - decoded.iat;
}

function assertLifetime(token, expectedDays) {
  const expected = expectedDays * DAY;
  const actual = lifetimeSeconds(token);
  assert.ok(
    Math.abs(actual - expected) <= TOLERANCE_S,
    `expected ~${expected}s (${expectedDays}d), got ${actual}s`
  );
}

test.before(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  authRoute = require('../../routes/auth');
  authRoute.__setDbForTests(fakePool());
  app = await startApp({ httpClient: 'node' });
});

test.after(async () => {
  if (authRoute) authRoute.__setDbForTests(null);
  if (app) await app.close();
});

async function login(extra) {
  return app.request('POST', '/api/auth/login', {
    body: { username: USERNAME, password: PASSWORD, ...extra },
  });
}

test('login with remember:true -> token lifetime ~30 days, unchanged response shape', async () => {
  const res = await login({ remember: true });
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.token, 'string');
  assert.deepEqual(res.json.user, { id: 4242, username: USERNAME, role: 'admin' });
  assertLifetime(res.json.token, 30);
});

test('login without remember -> token lifetime ~24 hours', async () => {
  const res = await login();
  assert.equal(res.status, 200);
  assertLifetime(res.json.token, 1);
});

test('login with remember:false -> token lifetime ~24 hours', async () => {
  const res = await login({ remember: false });
  assert.equal(res.status, 200);
  assertLifetime(res.json.token, 1);
});

test('login with non-boolean remember -> ignored (24h), not a 400', async () => {
  for (const remember of ['true', 1, 0, 'yes', null, {}, []]) {
    const res = await login({ remember });
    assert.equal(res.status, 200, `remember=${JSON.stringify(remember)}`);
    assertLifetime(res.json.token, 1);
  }
});

test('remember token still passes authenticateJWT', async () => {
  const res = await login({ remember: true });
  const probe = await app.request('POST', '/api/upload', { token: res.json.token });
  // Authenticated but no file -> 400 from multer, never 401/403.
  assert.ok(![401, 403].includes(probe.status), `status=${probe.status}`);
});
