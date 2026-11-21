// backend/test/agent/apiKeys.unit.test.js
//
// Key generation/hash, expiry parsing and verify() state handling. No MySQL.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const apiKeys = require('../../services/apiKeys');
const { AgentError } = require('../../agent/errors');

function makeRow(overrides = {}) {
  const generated = apiKeys.generateApiKey();
  const row = {
    id: 1,
    name: 'n8n',
    key_prefix: generated.prefix,
    key_hash: generated.hash,
    user_id: 1,
    scopes: JSON.stringify(['articles:read', 'articles:write']),
    is_active: 1,
    expires_at: null,
    last_used_at: null,
    created_at: new Date(),
    revoked_at: null,
    username: 'admin',
    role: 'admin',
    ...overrides,
  };
  return { generated, row };
}

function fakeDb(rows, { owner = { id: 1, username: 'admin', role: 'admin' }, insertId = 7 } = {}) {
  return {
    rows,
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      if (/FROM api_keys k/i.test(sql)) return [this.rows];
      if (/FROM users/i.test(sql)) return [[owner]];
      if (/INSERT INTO api_keys/i.test(sql)) return [{ insertId }];
      if (/UPDATE api_keys SET last_used_at/i.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    },
  };
}

test.afterEach(() => apiKeys.__setDbForTests(null));

test('generateApiKey: format, prefix length and stable SHA-256 hash', () => {
  const first = apiKeys.generateApiKey();
  const second = apiKeys.generateApiKey();

  assert.match(first.key, /^psk_live_[A-Za-z0-9_-]{1,16}_[A-Za-z0-9_-]{40,}$/);
  assert.equal(first.prefix.length, 12);
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.equal(apiKeys.hashApiKey(first.key), first.hash);
  assert.equal(apiKeys.hashKey(first.key), first.hash);
  assert.notEqual(first.key, second.key);
  assert.notEqual(first.prefix, second.prefix);
});

test('parseApiKey: accepts the documented format, rejects everything else', () => {
  const generated = apiKeys.generateApiKey();
  const parsed = apiKeys.parseApiKey(generated.key);
  assert.equal(parsed.prefix, generated.prefix);
  assert.ok(parsed.secret.length > 20);
  assert.equal(apiKeys.parseApiKey('Bearer abc'), null);
  assert.equal(apiKeys.parseApiKey('psk_live__abc'), null);
  assert.equal(apiKeys.parseApiKey(null), null);
});

test('parseExpiry: 30d/90d/365d/24h/never with a fixed clock', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(apiKeys.parseExpiry('30d', now).toISOString(), '2026-01-31T00:00:00.000Z');
  assert.equal(apiKeys.parseExpiry('90d', now).toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal(apiKeys.parseExpiry('365d', now).toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(apiKeys.parseExpiry('24h', now).toISOString(), '2026-01-02T00:00:00.000Z');
  assert.equal(apiKeys.parseExpiry('never', now), null);
  assert.equal(apiKeys.parseExpiry('', now).toISOString(), '2026-04-01T00:00:00.000Z');
  assert.throws(() => apiKeys.parseExpiry('30m', now), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(() => apiKeys.parseExpiry('0d', now), (err) => err.code === 'VALIDATION_ERROR');
});

test('verifyApiKey: valid key returns the owner identity and scopes', async () => {
  const { generated, row } = makeRow();
  const db = fakeDb([row]);
  apiKeys.__setDbForTests(db);

  const verified = await apiKeys.verifyApiKey(generated.key);
  assert.ok(verified);
  assert.equal(verified.apiKey.id, 1);
  assert.equal(verified.apiKey.prefix, generated.prefix);
  assert.equal(verified.apiKey.userId, 1);
  assert.equal(verified.apiKey.username, 'admin');
  assert.equal(verified.apiKey.role, 'admin');
  assert.deepEqual(verified.apiKey.scopes, ['articles:read', 'articles:write']);
  assert.equal(db.calls[0].params[0], generated.prefix);
});

test('verifyApiKey: wrong secret, invalid format and unknown prefix -> null', async () => {
  const { generated, row } = makeRow();
  apiKeys.__setDbForTests(fakeDb([row]));

  const wrongSecret = `psk_live_${generated.prefix}_not-the-real-secret`;
  assert.equal(await apiKeys.verifyApiKey(wrongSecret), null);
  assert.equal(await apiKeys.verifyApiKey('garbage'), null);

  apiKeys.__setDbForTests(fakeDb([]));
  assert.equal(await apiKeys.verifyApiKey(generated.key), null);
});

test('verifyApiKey: inactive, revoked and expired keys -> null', async () => {
  const { generated, row } = makeRow();
  for (const variant of [
    { is_active: 0 },
    { revoked_at: new Date() },
    { expires_at: new Date(Date.now() - 60_000) },
  ]) {
    apiKeys.__setDbForTests(fakeDb([{ ...row, ...variant }]));
    assert.equal(await apiKeys.verifyApiKey(generated.key), null, JSON.stringify(variant));
  }
});

test('verifyApiKey: expired is null but future expiry is valid', async () => {
  const { generated, row } = makeRow({ expires_at: new Date(Date.now() + 60_000) });
  apiKeys.__setDbForTests(fakeDb([row]));
  assert.ok(await apiKeys.verifyApiKey(generated.key));
});

test('createApiKey: editor cannot receive admin-only scopes; unknown scopes rejected', async () => {
  apiKeys.__setDbForTests(fakeDb([], { owner: { id: 2, username: 'editor', role: 'editor' } }));

  await assert.rejects(
    apiKeys.createApiKey({
      name: 'editor-key',
      username: 'editor',
      scopes: ['articles:read', 'articles:delete'],
      expiresAt: null,
    }),
    (err) => err instanceof AgentError && err.code === 'FORBIDDEN'
  );

  await assert.rejects(
    apiKeys.createApiKey({
      name: 'editor-key',
      username: 'editor',
      scopes: ['articles:*'],
      expiresAt: null,
    }),
    (err) => err instanceof AgentError && err.code === 'VALIDATION_ERROR'
  );

  const created = await apiKeys.createApiKey({
    name: 'editor-key',
    username: 'editor',
    scopes: ['articles:read', 'seo:write'],
    expiresAt: null,
  });
  assert.match(created.key, /^psk_live_/);
  assert.deepEqual(created.apiKey.scopes, ['articles:read', 'seo:write']);
});

test('createApiKey: admin can receive every known scope and expiry is stored', async () => {
  apiKeys.__setDbForTests(fakeDb([]));
  const expiresAt = new Date('2026-06-01T00:00:00.000Z');
  const created = await apiKeys.createApiKey({
    name: 'n8n',
    username: 'admin',
    scopes: ['articles:read', 'contacts:delete', 'media:write'],
    expiresAt,
  });
  assert.equal(created.apiKey.expiresAt, expiresAt.toISOString());
  assert.equal(created.apiKey.role, 'admin');
});
