// backend/test/agent/scopes.unit.test.js
//
// Scope catalogue, role cap, matching and requireScope() middleware.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const scopes = require('../../agent/scopes');

const EDITOR_ALLOWED = [
  'articles:read',
  'articles:write',
  'categories:read',
  'seo:read',
  'seo:write',
  'redirects:read',
];

test('known scopes are explicit and contain no wildcards', () => {
  assert.equal(scopes.KNOWN_SCOPES.length, 17);
  assert.ok(scopes.KNOWN_SCOPES.every((scope) => /^[a-z]+:(read|write|feature|delete)$/.test(scope)));
  assert.equal(scopes.isKnownScope('articles:*'), false);
  assert.equal(scopes.isKnownScope('*'), false);
  assert.equal(scopes.isKnownScope('articles:read'), true);
});

test('editor cap is exactly the documented subset', () => {
  assert.deepEqual([...scopes.ROLE_CAPS.editor], EDITOR_ALLOWED);
  assert.equal(scopes.isScopeAllowedForRole('articles:read', 'editor'), true);
  for (const denied of ['articles:delete', 'articles:feature', 'categories:write', 'seo:delete', 'redirects:write', 'contacts:read', 'media:write']) {
    assert.equal(scopes.isScopeAllowedForRole(denied, 'editor'), false, denied);
  }
});

test('admin cap accepts every known scope', () => {
  for (const scope of scopes.KNOWN_SCOPES) {
    assert.equal(scopes.isScopeAllowedForRole(scope, 'admin'), true, scope);
  }
});

test('assertScopesAllowed accepts editor subset and rejects the rest', () => {
  assert.deepEqual(scopes.assertScopesAllowed(EDITOR_ALLOWED, 'editor'), EDITOR_ALLOWED);
  assert.throws(
    () => scopes.assertScopesAllowed(['articles:read', 'articles:delete'], 'editor'),
    (err) => err.code === 'FORBIDDEN'
  );
  assert.throws(
    () => scopes.assertScopesAllowed(['articles:read', 'unknown:scope'], 'admin'),
    (err) => err.code === 'VALIDATION_ERROR'
  );
  assert.throws(
    () => scopes.assertScopesAllowed([], 'admin'),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('unknown roles fall back to editor (least privilege)', () => {
  assert.equal(scopes.normalizeRole('root'), 'editor');
  assert.throws(
    () => scopes.assertScopesAllowed(['articles:delete'], 'root'),
    (err) => err.code === 'FORBIDDEN'
  );
});

test('hasScope / scopeMatches require an exact grant', () => {
  assert.equal(scopes.hasScope(['articles:read'], 'articles:read'), true);
  assert.equal(scopes.hasScope(['articles:read'], 'articles:write'), false);
  assert.equal(scopes.hasScope(['articles:*'], 'articles:read'), false);
  assert.equal(scopes.scopeMatches(['seo:read'], 'seo:read'), true);
});

test('parseScopes handles JSON, arrays and malformed values', () => {
  assert.deepEqual(scopes.parseScopes('["articles:read"]'), ['articles:read']);
  assert.deepEqual(scopes.parseScopes(['seo:read']), ['seo:read']);
  assert.deepEqual(scopes.parseScopes('not-json'), []);
  assert.deepEqual(scopes.parseScopes(null), []);
});

function runRequireScope(grantedScopes, requiredScope) {
  return new Promise((resolve) => {
    const middleware = scopes.requireScope(requiredScope);
    const req = {
      headers: {},
      apiKey: grantedScopes ? { scopes: grantedScopes } : undefined,
    };
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return body; },
      end() {},
    };
    middleware(req, res, () => resolve({ status: 200, next: true }));
  });
}

test('requireScope: passes with the scope, 403 without it, 401 without a key', async () => {
  const allowed = await runRequireScope(['articles:read'], 'articles:read');
  assert.equal(allowed.next, true);

  const denied = await runRequireScope(['articles:read'], 'articles:delete');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.ok, false);
  assert.equal(denied.body.error.code, 'FORBIDDEN');
  assert.equal(denied.body.error.context.required_scope, 'articles:delete');

  const anonymous = await runRequireScope(null, 'articles:read');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.code, 'UNAUTHORIZED');
});
