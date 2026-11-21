// backend/test/db/agentFoundation.test.js
//
// DB-backed Agent API foundation checks. Skips (does not fail) when no scratch
// MySQL is available, matching the rest of test/db.
//
// Covered:
//   - migration creates api_keys, agent_audit_log, idempotency_keys
//   - migration is idempotent (run twice)
//   - key create -> list -> verify -> revoke -> verify null
//   - audit insert and idempotency helpers against the real schema
//   - FK cascade / set-null behaviour where practical

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

let ctx = null;

// IMPORTANT: this prefix must stay unique per suite. Other DB suites create
// api_keys in parallel processes against the same scratch database; a broad
// `name LIKE '...%'` cleanup here would delete their keys mid-test (this broke
// agentArticles with 401s before the prefixes were split). Prefer deleting
// exactly the key ids created by this suite.
const KEY_NAME_PREFIX = 'zz-nodetest-agentfound-';
// Every key id created by this suite, deleted by id in test.after().
const createdKeyIds = [];

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }
  const [users] = await db.query('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
  if (!users || users.length === 0) {
    ctx = { skip: true, reason: 'scratch database has no users (run node scripts/setup-test-db.js)' };
    return;
  }
  const lock = createDbLock(db);
  await lock.acquire();
  ctx = { skip: false, db, user: users[0], lock };
});

test.after(async () => {
  if (!ctx || ctx.skip) return;
  if (createdKeyIds.length > 0) {
    try {
      await ctx.db.query(
        `DELETE FROM idempotency_keys WHERE api_key_id IN (${createdKeyIds.map(() => '?').join(',')})`,
        createdKeyIds
      );
    } catch { /* best effort */ }
  }
  try {
    await ctx.db.query(
      `DELETE FROM api_keys WHERE id IN (${createdKeyIds.map(() => '?').join(',')})`,
      createdKeyIds
    );
  } catch { /* best effort */ }
  if (ctx.lock) await ctx.lock.close();
  try { await ctx.db.end(); } catch { /* already closed */ }
});

function dbTest(name, fn) {
  test(name, async (t) => {
    if (ctx.skip) return t.skip(`DB tests skipped: ${ctx.reason}`);
    return withTestDbLock(ctx.lock, () => fn(t));
  });
}

dbTest('migration creates all three tables and is idempotent', async () => {
  const { migrate } = require('../../database/migrate-agent-foundation');
  await migrate();
  await migrate(); // second run must be a no-op

  const [tables] = await ctx.db.query(
    `SELECT TABLE_NAME AS t
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('api_keys', 'agent_audit_log', 'idempotency_keys')`
  );
  assert.deepEqual(
    tables.map((row) => row.t).sort(),
    ['agent_audit_log', 'api_keys', 'idempotency_keys']
  );

  const [columns] = await ctx.db.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_keys'`
  );
  const names = new Set(columns.map((row) => row.COLUMN_NAME));
  for (const column of [
    'id', 'name', 'key_prefix', 'key_hash', 'user_id', 'scopes',
    'is_active', 'expires_at', 'last_used_at', 'created_at', 'revoked_at',
  ]) {
    assert.ok(names.has(column), `api_keys.${column}`);
  }
});

dbTest('api key service: create -> list -> verify -> revoke', async () => {
  const apiKeys = require('../../services/apiKeys');
  const name = `${KEY_NAME_PREFIX}${Date.now().toString(36)}`;
  const scopes = ctx.user.role === 'admin'
    ? ['articles:read', 'articles:write', 'contacts:read']
    : ['articles:read', 'seo:read'];

  const created = await apiKeys.createApiKey({
    name,
    userId: ctx.user.id,
    role: ctx.user.role,
    scopes,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  assert.match(created.key, /^psk_live_/);
  assert.equal(created.apiKey.name, name);
  createdKeyIds.push(created.apiKey.id);

  const listed = await apiKeys.listApiKeys();
  const listedKey = listed.find((row) => row.id === created.apiKey.id);
  assert.ok(listedKey);
  assert.equal(listedKey.username, ctx.user.username);
  assert.deepEqual(listedKey.scopes, scopes);

  const verified = await apiKeys.verifyApiKey(created.key);
  assert.ok(verified);
  assert.equal(verified.apiKey.id, created.apiKey.id);
  assert.equal(verified.apiKey.userId, ctx.user.id);

  const revoked = await apiKeys.revokeApiKey(created.apiKey.id);
  assert.equal(revoked, true);
  assert.equal(await apiKeys.verifyApiKey(created.key), null);
});

dbTest('agent_audit_log stores a row and NULLs api_key_id on key deletion', async () => {
  const apiKeys = require('../../services/apiKeys');
  const { recordAudit } = require('../../agent/audit');
  const name = `${KEY_NAME_PREFIX}audit-${Date.now().toString(36)}`;
  const created = await apiKeys.createApiKey({
    name,
    userId: ctx.user.id,
    role: ctx.user.role,
    scopes: ctx.user.role === 'admin' ? ['articles:read'] : ['articles:read'],
    expiresAt: null,
  });
  createdKeyIds.push(created.apiKey.id);

  // Unique per run: unlike the old constant 'zz-nodetest-audit', a unique id
  // keeps this test correct across re-runs of the same scratch database.
  const requestId = `${KEY_NAME_PREFIX}audit-${Date.now().toString(36)}`;
  const recorded = await recordAudit({
    api_key_id: created.apiKey.id,
    user_id: ctx.user.id,
    method: 'GET',
    path: '/api/agent/v1/me',
    status_code: 200,
    request_id: requestId,
    ip: '127.0.0.1',
    user_agent: 'node-test',
    duration_ms: 3,
  });
  assert.equal(recorded, true);

  const [rows] = await ctx.db.query(
    'SELECT api_key_id, user_id, status_code FROM agent_audit_log WHERE request_id = ?',
    [requestId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].api_key_id, created.apiKey.id);

  await ctx.db.query('DELETE FROM api_keys WHERE id = ?', [created.apiKey.id]);
  const [after] = await ctx.db.query(
    'SELECT api_key_id, user_id FROM agent_audit_log WHERE request_id = ?',
    [requestId]
  );
  assert.equal(after.length, 1);
  assert.equal(after[0].api_key_id, null);
  assert.equal(after[0].user_id, ctx.user.id);

  // Do not leave the audit row behind for the next run of this suite.
  await ctx.db.query('DELETE FROM agent_audit_log WHERE request_id = ?', [requestId]);
});

dbTest('idempotency helper: begin/complete/replay/conflict against the real schema', async () => {
  const apiKeys = require('../../services/apiKeys');
  const idempotency = require('../../agent/idempotency');
  const name = `${KEY_NAME_PREFIX}idem-${Date.now().toString(36)}`;
  const created = await apiKeys.createApiKey({
    name,
    userId: ctx.user.id,
    role: ctx.user.role,
    scopes: ['articles:read'],
    expiresAt: null,
  });
  createdKeyIds.push(created.apiKey.id);

  const idemKey = `zz-nodetest-idem-${Date.now().toString(36)}`;
  const hash = 'a'.repeat(64);
  const input = { apiKeyId: created.apiKey.id, key: idemKey, method: 'POST', path: '/articles', hash };

  const begun = await idempotency.begin(input);
  assert.equal(begun.state, 'new');
  assert.equal((await idempotency.begin(input)).state, 'in-progress');
  await idempotency.complete({ apiKeyId: created.apiKey.id, key: idemKey, statusCode: 201, body: { ok: true } });

  const replay = await idempotency.begin(input);
  assert.equal(replay.state, 'replay');
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(replay.body, { ok: true });

  const conflict = await idempotency.begin({ ...input, hash: 'b'.repeat(64) });
  assert.equal(conflict.state, 'conflict');
});
