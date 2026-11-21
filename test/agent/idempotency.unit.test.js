// backend/test/agent/idempotency.unit.test.js
//
// Helper-level tests only: no resource route is wired in Phase 1.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const idempotency = require('../../agent/idempotency');

function fakeDb() {
  const store = new Map();
  let nextId = 1;
  return {
    store,
    async query(sql, params) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT id, request_hash')) {
        const [apiKeyId, key] = params;
        const row = store.get(`${apiKeyId}:${key}`);
        return [row ? [row] : []];
      }
      if (normalized.startsWith('INSERT INTO idempotency_keys')) {
        const [apiKeyId, key, method, path, hash, expiresAt] = params;
        const storeKey = `${apiKeyId}:${key}`;
        if (store.has(storeKey)) {
          const error = new Error('Duplicate entry');
          error.code = 'ER_DUP_ENTRY';
          throw error;
        }
        const row = { id: nextId += 1, method, path, request_hash: hash, status_code: null, response_body: null, expires_at: expiresAt };
        store.set(storeKey, row);
        return [{ insertId: row.id }];
      }
      if (normalized.startsWith('UPDATE idempotency_keys')) {
        const [statusCode, body, apiKeyId, key] = params;
        const row = store.get(`${apiKeyId}:${key}`);
        if (!row) return [{ affectedRows: 0 }];
        row.status_code = statusCode;
        row.response_body = body;
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith('DELETE FROM idempotency_keys')) {
        for (const [key, row] of store) {
          if (row.id === params[0]) store.delete(key);
        }
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };
}

test.afterEach(() => idempotency.__setDbForTests(null));

test('stableStringify sorts object keys at every depth but keeps arrays ordered', () => {
  const a = idempotency.stableStringify({ b: 1, a: { d: [2, 1], c: true } });
  const b = idempotency.stableStringify({ a: { c: true, d: [2, 1] }, b: 1 });
  assert.equal(a, b);
  assert.notEqual(
    idempotency.stableStringify({ a: [1, 2] }),
    idempotency.stableStringify({ a: [2, 1] })
  );
});

test('requestHash is stable across object key order and method case', () => {
  const first = idempotency.requestHash({ method: 'post', path: '/articles', body: { b: 2, a: 1 } });
  const second = idempotency.requestHash({ method: 'POST', path: '/articles', body: { a: 1, b: 2 } });
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, idempotency.requestHash({ method: 'POST', path: '/articles', body: { a: 2, b: 1 } }));
});

test('same key + same hash replays the completed response', async () => {
  const db = fakeDb();
  idempotency.__setDbForTests(db);
  const input = { apiKeyId: 1, key: 'idem-1', method: 'POST', path: '/articles', hash: 'a'.repeat(64) };

  assert.equal((await idempotency.begin(input)).state, 'new');
  await idempotency.complete({ apiKeyId: 1, key: 'idem-1', statusCode: 201, body: { id: 9 } });

  const replay = await idempotency.begin(input);
  assert.equal(replay.state, 'replay');
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(replay.body, { id: 9 });
});

test('same key + different hash is a conflict', async () => {
  idempotency.__setDbForTests(fakeDb());
  await idempotency.begin({ apiKeyId: 1, key: 'idem-2', method: 'POST', path: '/articles', hash: 'b'.repeat(64) });
  const result = await idempotency.begin({
    apiKeyId: 1,
    key: 'idem-2',
    method: 'POST',
    path: '/articles',
    hash: 'c'.repeat(64),
  });
  assert.equal(result.state, 'conflict');
});

test('same key before completion is in-progress', async () => {
  idempotency.__setDbForTests(fakeDb());
  const input = { apiKeyId: 1, key: 'idem-3', method: 'POST', path: '/articles', hash: 'd'.repeat(64) };
  assert.equal((await idempotency.begin(input)).state, 'new');
  assert.equal((await idempotency.begin(input)).state, 'in-progress');
});

test('different API keys are isolated even with the same Idempotency-Key', async () => {
  idempotency.__setDbForTests(fakeDb());
  const key = 'idem-shared';
  const hash = 'e'.repeat(64);
  assert.equal((await idempotency.begin({ apiKeyId: 1, key, method: 'POST', path: '/x', hash })).state, 'new');
  assert.equal((await idempotency.begin({ apiKeyId: 2, key, method: 'POST', path: '/x', hash })).state, 'new');
});

test('expired rows are replaced', async () => {
  const db = fakeDb();
  idempotency.__setDbForTests(db);
  const hash = 'f'.repeat(64);
  const createdAt = Date.now() - 10_000;
  await idempotency.begin({ apiKeyId: 1, key: 'idem-old', method: 'POST', path: '/x', hash, ttlSeconds: 1, now: createdAt });
  const result = await idempotency.begin({ apiKeyId: 1, key: 'idem-old', method: 'POST', path: '/x', hash, ttlSeconds: 60 });
  assert.equal(result.state, 'new');
});
