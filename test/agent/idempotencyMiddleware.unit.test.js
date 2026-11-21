// backend/test/agent/idempotencyMiddleware.unit.test.js
//
// Express-middleware behaviour for Idempotency-Key. Uses an in-memory fake DB.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const idempotency = require('../../agent/idempotency');

function fakeDb() {
  const store = new Map();
  let nextId = 1;
  return {
    store,
    queries: 0,
    updates: 0,
    async query(sql, params) {
      this.queries += 1;
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
        const row = {
          id: nextId += 1,
          method,
          path,
          request_hash: hash,
          status_code: null,
          response_body: null,
          expires_at: expiresAt,
        };
        store.set(storeKey, row);
        return [{ insertId: row.id }];
      }
      if (normalized.startsWith('UPDATE idempotency_keys')) {
        this.updates += 1;
        const [statusCode, body, apiKeyId, key] = params;
        const row = store.get(`${apiKeyId}:${key}`);
        if (!row) return [{ affectedRows: 0 }];
        row.status_code = statusCode;
        row.response_body = body;
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith('DELETE FROM idempotency_keys')) {
        const [apiKeyId, key] = params;
        store.delete(`${apiKeyId}:${key}`);
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };
}

function mockRequest({ method = 'POST', key, body = { title: 'x' }, path = '/api/agent/v1/articles', contentType } = {}) {
  const headers = {};
  if (key !== undefined) headers['idempotency-key'] = key;
  if (contentType !== undefined) headers['content-type'] = contentType;
  return {
    method,
    originalUrl: path,
    headers,
    body,
    apiKey: { id: 1, userId: 7 },
    requestId: 'zz-idem-middleware',
  };
}

function mockResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => {
    res.body = body;
    res.emit('finish');
    if (res.onJson) res.onJson(body);
    return res;
  };
  res.end = () => { res.emit('finish'); };
  return res;
}

function tick(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs the middleware and simulates a handler that answers 201 for a new key.
async function run(req, respond = (res) => res.status(201).json({ ok: true, data: { id: 9 } })) {
  const res = mockResponse();
  let nextCalled = false;
  const done = new Promise((resolve) => { res.onJson = resolve; });
  idempotency.idempotencyMiddleware(req, res, (error) => {
    nextCalled = true;
    if (error) {
      res.status(500).json({ ok: false, error: { code: error.code } });
      return;
    }
    respond(res);
  });
  await done;
  await tick();
  return { res, nextCalled };
}

test.afterEach(() => idempotency.__setDbForTests(null));

test('no Idempotency-Key passes straight through without touching the store', async () => {
  const db = fakeDb();
  idempotency.__setDbForTests(db);

  const { res, nextCalled } = await run(mockRequest({ key: undefined }));
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(db.queries, 0);
  assert.equal(res.headers['idempotent-replayed'], undefined);
});

test('GET requests skip idempotency even with a key', async () => {
  const db = fakeDb();
  idempotency.__setDbForTests(db);

  const { res } = await run(mockRequest({ method: 'GET', key: 'idem-get' }));
  assert.equal(res.statusCode, 201);
  assert.equal(db.queries, 0);
});

test('new key stores the response and a replay returns it verbatim', async () => {
  const db = fakeDb();
  idempotency.__setDbForTests(db);

  const req = mockRequest({ key: 'idem-replay' });
  const first = await run(req);
  assert.equal(first.res.statusCode, 201);
  assert.equal(first.res.headers['idempotent-replayed'], undefined);

  const second = await run(mockRequest({ key: 'idem-replay' }));
  assert.equal(second.nextCalled, false);
  assert.equal(second.res.statusCode, 201);
  assert.equal(second.res.headers['idempotent-replayed'], 'true');
  assert.deepEqual(second.res.body, { ok: true, data: { id: 9 } });
});

test('same key with a different body is IDEMPOTENCY_CONFLICT (409)', async () => {
  const db = fakeDb();
  idempotency.__setDbForTests(db);

  await run(mockRequest({ key: 'idem-conflict', body: { title: 'one' } }));
  const second = await run(mockRequest({ key: 'idem-conflict', body: { title: 'two' } }));
  assert.equal(second.nextCalled, false);
  assert.equal(second.res.statusCode, 409);
  assert.equal(second.res.body.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('same key before the first response is IDEMPOTENCY_IN_PROGRESS (409)', async () => {
  const db = fakeDb();
  idempotency.__setDbForTests(db);

  const start = run(mockRequest({ key: 'idem-progress' }), () => {
    // Never respond: the first request stays in progress.
  });
  // Let begin() insert the row, then issue the second request.
  await tick();
  const second = await run(mockRequest({ key: 'idem-progress' }));
  assert.equal(second.nextCalled, false);
  assert.equal(second.res.statusCode, 409);
  assert.equal(second.res.body.error.code, 'IDEMPOTENCY_IN_PROGRESS');
  assert.equal(second.res.headers['retry-after'], '1');

  // Finish the first request so its promise resolves.
  start.catch(() => {});
});

test('empty or oversized Idempotency-Key is a 400 validation error', async () => {
  idempotency.__setDbForTests(fakeDb());
  for (const key of ['', '   ', 'x'.repeat(256)]) {
    const req = mockRequest({ key });
    const res = mockResponse();
    const done = new Promise((resolve) => { res.onJson = resolve; });
    let nextCalled = false;
    idempotency.idempotencyMiddleware(req, res, () => { nextCalled = true; });
    await done;
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  }
});

test('5xx responses abandon the row so a retry can proceed', async () => {
  idempotency.__setDbForTests(fakeDb());
  const req = mockRequest({ key: 'idem-5xx' });

  await run(req, (res) => res.status(503).json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } }));
  // The abandoned row is gone, so the same key starts a fresh request.
  const second = await run(mockRequest({ key: 'idem-5xx' }));
  assert.equal(second.nextCalled, true);
  assert.equal(second.res.statusCode, 201);
});

test('multipart/form-data skips idempotency entirely (file bytes are not hashable)', async () => {
  const db = fakeDb();
  idempotency.__setDbForTests(db);

  const { res, nextCalled } = await run(mockRequest({
    key: 'idem-multipart',
    contentType: 'multipart/form-data; boundary=zz',
    body: {},
  }));
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(db.queries, 0);
  assert.equal(res.headers['idempotent-replayed'], undefined);
});

test('multipart skip is also detected through req.is()', async () => {
  const db = fakeDb();
  idempotency.__setDbForTests(db);

  const req = mockRequest({ key: 'idem-multipart-is', body: {} });
  req.is = (type) => type === 'multipart/form-data';
  const { nextCalled } = await run(req);
  assert.equal(nextCalled, true);
  assert.equal(db.queries, 0);
});

test('the response is persisted before it is sent, so an immediate retry replays', async () => {
  const db = fakeDb();
  idempotency.__setDbForTests(db);

  await run(mockRequest({ key: 'idem-immediate' }));
  // No waiting/tick here: the first response was sent only after complete().
  const second = await run(mockRequest({ key: 'idem-immediate' }));
  assert.equal(second.nextCalled, false);
  assert.equal(second.res.headers['idempotent-replayed'], 'true');
  assert.deepEqual(second.res.body, { ok: true, data: { id: 9 } });
});

test('the response is stored exactly once (no double-store)', async () => {
  const db = fakeDb();
  idempotency.__setDbForTests(db);

  const first = await run(mockRequest({ key: 'idem-single-store' }));
  assert.equal(first.res.statusCode, 201);
  await tick();
  assert.equal(db.updates, 1);
});

test('a persistence failure is fail-open: the response still reaches the caller', async () => {
  const db = fakeDb();
  const originalQuery = db.query.bind(db);
  db.query = async (sql, params) => {
    if (String(sql).replace(/\s+/g, ' ').trim().startsWith('UPDATE idempotency_keys')) {
      const error = new Error('table is gone');
      error.code = 'ER_NO_SUCH_TABLE';
      throw error;
    }
    return originalQuery(sql, params);
  };
  idempotency.__setDbForTests(db);

  const { res, nextCalled } = await run(mockRequest({ key: 'idem-persist-fail' }));
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { ok: true, data: { id: 9 } });
});
