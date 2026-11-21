// backend/test/unit/auth.test.js
//
// Role model + requireRole middleware (audit P3-5 / P3-7).

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const authenticateJWT = require('../../middleware/auth');
const { requireRole, normalizeRole, ROLE_ADMIN, ROLE_EDITOR } = authenticateJWT;
const { makeToken } = require('../helpers/app');

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function runAuth(authorization) {
  const req = { headers: authorization === undefined ? {} : { authorization } };
  const res = fakeRes();
  let nextCalled = false;
  authenticateJWT(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

function runRole(role, roles) {
  const req = { user: { role } };
  const res = fakeRes();
  let nextCalled = false;
  requireRole(...roles)(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('normalizeRole falls back to editor (least privilege)', () => {
  assert.equal(normalizeRole('admin'), ROLE_ADMIN);
  assert.equal(normalizeRole('ADMIN'), ROLE_ADMIN);
  assert.equal(normalizeRole(' admin '), ROLE_ADMIN);
  assert.equal(normalizeRole('editor'), ROLE_EDITOR);
  assert.equal(normalizeRole('superuser'), ROLE_EDITOR);
  assert.equal(normalizeRole(undefined), ROLE_EDITOR);
  assert.equal(normalizeRole(null), ROLE_EDITOR);
  assert.equal(normalizeRole({ role: 'admin' }), ROLE_EDITOR);
  assert.equal(normalizeRole(['admin']), ROLE_EDITOR);
});

test('authenticateJWT rejects missing and malformed headers with 401', () => {
  for (const header of [undefined, '', 'Token abc', 'Bearer']) {
    const { res, nextCalled } = runAuth(header);
    assert.equal(res.statusCode, 401, `header=${JSON.stringify(header)}`);
    assert.equal(nextCalled, false);
  }
});

test('authenticateJWT rejects a token signed with another secret with 403', () => {
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ id: 1, role: 'admin' }, 'a-different-secret-at-least-32-chars-long!!', {
    algorithm: 'HS256',
  });
  const { res, nextCalled } = runAuth(`Bearer ${forged}`);
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('authenticateJWT accepts a valid token and exposes req.user', () => {
  const token = makeToken({ role: 'admin', username: 'alice' });
  const { req, nextCalled } = runAuth(`Bearer ${token}`);
  assert.equal(nextCalled, true);
  assert.equal(req.user.role, 'admin');
  assert.equal(req.user.username, 'alice');
});

test('requireRole allows a matching role', () => {
  const { nextCalled } = runRole('admin', [ROLE_ADMIN]);
  assert.equal(nextCalled, true);
});

test('requireRole rejects a non-matching role with 403 + required_roles', () => {
  const { res, nextCalled } = runRole('editor', [ROLE_ADMIN]);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body.required_roles, ['admin']);
  assert.equal(res.body.role, 'editor');
});

test('requireRole treats unknown roles as editor', () => {
  const allowed = runRole('superuser', [ROLE_EDITOR]);
  assert.equal(allowed.nextCalled, true);
  const denied = runRole('superuser', [ROLE_ADMIN]);
  assert.equal(denied.res.statusCode, 403);
});

test('requireRole without req.user answers 401 (auth misordered)', () => {
  const res = fakeRes();
  requireRole(ROLE_ADMIN)({ headers: {} }, res, () => {});
  assert.equal(res.statusCode, 401);
});

test('requireRole throws when constructed without roles', () => {
  assert.throws(() => requireRole(), /at least one role/);
});
