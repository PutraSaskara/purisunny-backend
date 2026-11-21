// backend/test/unit/agentPurge.test.js
//
// Unit coverage for scripts/agent-purge.js using a fake MySQL pool. No
// database connection is made: the script is imported and purge() is called
// directly.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const purge = require('../../scripts/agent-purge');

function fakePool({ idempotencyCount = 3, auditCount = 4, idempotencyDeleted = 2, auditDeleted = 1 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });
      if (text.startsWith('SELECT COUNT(*) AS count FROM idempotency_keys')) {
        return [[{ count: idempotencyCount }]];
      }
      if (text.startsWith('SELECT COUNT(*) AS count FROM agent_audit_log')) {
        return [[{ count: auditCount }]];
      }
      if (text.startsWith('DELETE FROM idempotency_keys')) {
        return [{ affectedRows: idempotencyDeleted }];
      }
      if (text.startsWith('DELETE FROM agent_audit_log')) {
        return [{ affectedRows: auditDeleted }];
      }
      return [[]];
    },
  };
}

test('getAuditRetentionDays defaults to 90 and ignores invalid values', () => {
  assert.equal(purge.getAuditRetentionDays({}), 90);
  assert.equal(purge.DEFAULT_AUDIT_RETENTION_DAYS, 90);
  for (const value of ['0', '-5', 'abc', '', 'NaN']) {
    assert.equal(purge.getAuditRetentionDays({ AGENT_AUDIT_RETENTION_DAYS: value }), 90, value);
  }
});

test('getAuditRetentionDays floors positive values', () => {
  assert.equal(purge.getAuditRetentionDays({ AGENT_AUDIT_RETENTION_DAYS: '30' }), 30);
  assert.equal(purge.getAuditRetentionDays({ AGENT_AUDIT_RETENTION_DAYS: '30.9' }), 30);
  assert.equal(purge.getAuditRetentionDays({ AGENT_AUDIT_RETENTION_DAYS: '1' }), 1);
});

test('auditCutoff subtracts exactly the retention window', () => {
  const now = new Date('2026-01-31T00:00:00.000Z');
  const cutoff = purge.auditCutoff({ now, retentionDays: 90 });
  const days = (now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
  assert.equal(days, 90);
  assert.equal(cutoff.toISOString(), '2025-11-02T00:00:00.000Z');
});

test('parseArgs detects --dry-run only', () => {
  assert.equal(purge.parseArgs(['--dry-run']).dryRun, true);
  assert.equal(purge.parseArgs(['--dryrun']).dryRun, false);
  assert.equal(purge.parseArgs([]).dryRun, false);
});

test('--dry-run reports counts with SELECT only and never deletes', async () => {
  const pool = fakePool({ idempotencyCount: 7, auditCount: 12 });
  const result = await purge.purge({
    dryRun: true,
    dbPool: pool,
    now: new Date('2026-01-31T00:00:00.000Z'),
    retentionDays: 90,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.idempotency, 7);
  assert.equal(result.audit, 12);
  assert.equal(result.retentionDays, 90);

  assert.equal(pool.calls.length, 2);
  for (const call of pool.calls) {
    assert.match(call.text, /^SELECT COUNT\(\*\) AS count/);
    assert.equal(call.text.includes('DELETE'), false);
  }
  assert.equal(pool.calls[0].text.includes('expires_at < NOW()'), true);
  assert.equal(pool.calls[1].params.length, 1);
  assert.ok(pool.calls[1].params[0] instanceof Date);
});

test('live purge deletes expired keys and old audit rows and reports counts', async () => {
  const pool = fakePool({ idempotencyDeleted: 5, auditDeleted: 9 });
  const result = await purge.purge({
    dryRun: false,
    dbPool: pool,
    now: new Date('2026-01-31T00:00:00.000Z'),
    retentionDays: 30,
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.idempotency, 5);
  assert.equal(result.audit, 9);

  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].text, /^DELETE FROM idempotency_keys WHERE expires_at < NOW\(\)$/);
  assert.match(pool.calls[1].text, /^DELETE FROM agent_audit_log WHERE created_at < \?$/);
  const cutoff = pool.calls[1].params[0];
  assert.equal(cutoff.toISOString(), '2026-01-01T00:00:00.000Z');
});

test('dry run also accepts a flat rows array (non-mysql2 fakes)', async () => {
  const pool = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.includes('FROM idempotency_keys')) return [{ count: 2 }];
      if (text.includes('FROM agent_audit_log')) return [{ count: 1 }];
      return [[]];
    },
  };
  const result = await purge.purge({ dryRun: true, dbPool: pool, retentionDays: 90 });
  assert.equal(result.idempotency, 2);
  assert.equal(result.audit, 1);
});

test('purge handles an empty result without throwing', async () => {
  const pool = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('DELETE')) return [{}];
      return [[]];
    },
  };
  const result = await purge.purge({ dryRun: false, dbPool: pool, retentionDays: 90 });
  assert.equal(result.idempotency, 0);
  assert.equal(result.audit, 0);
});
