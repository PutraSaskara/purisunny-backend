// backend/scripts/agent-purge.js
//
// Housekeeping for the Agent API tables:
//   * idempotency_keys rows whose expires_at is in the past
//   * agent_audit_log rows older than AGENT_AUDIT_RETENTION_DAYS (default 90)
//
// From backend/:
//   npm run agent:purge              # delete and print counts
//   npm run agent:purge -- --dry-run # count only, no write
//
// Safe for a daily cron entry. Exit code is 0 on success and 1 on failure.

require('../config/loadEnv')();

const db = require('../config/db');

const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function getAuditRetentionDays(env = process.env) {
  const raw = Number(env.AGENT_AUDIT_RETENTION_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AUDIT_RETENTION_DAYS;
  return Math.max(1, Math.floor(raw));
}

function parseArgs(argv = []) {
  return {
    dryRun: argv.includes('--dry-run'),
  };
}

function firstCount(result) {
  // mysql2 returns [rows, fields]; test fakes may return rows directly. Accept
  // either shape.
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const row = rows[0] || {};
  const value = row.count !== undefined ? row.count : row.n;
  return Number(value) || 0;
}

// MySQL requires a DATETIME value for the comparison. Computing the cutoff in
// JavaScript keeps the SQL portable and makes the predicate testable.
function auditCutoff({ now = new Date(), retentionDays } = {}) {
  const days = retentionDays === undefined ? getAuditRetentionDays() : retentionDays;
  return new Date(now.getTime() - days * DAY_MS);
}

async function countExpiredIdempotencyKeys(pool) {
  const result = await pool.query(
    'SELECT COUNT(*) AS count FROM idempotency_keys WHERE expires_at < NOW()'
  );
  return firstCount(result);
}

async function countExpiredAuditRows(pool, cutoff) {
  const result = await pool.query(
    'SELECT COUNT(*) AS count FROM agent_audit_log WHERE created_at < ?',
    [cutoff]
  );
  return firstCount(result);
}

async function purge({ dryRun = false, dbPool = db, now = new Date(), retentionDays } = {}) {
  const days = retentionDays === undefined ? getAuditRetentionDays() : retentionDays;
  const cutoff = auditCutoff({ now, retentionDays: days });

  if (dryRun) {
    const idempotency = await countExpiredIdempotencyKeys(dbPool);
    const audit = await countExpiredAuditRows(dbPool, cutoff);
    return { dryRun: true, retentionDays: days, cutoff, idempotency, audit };
  }

  const [idempotencyResult] = await dbPool.query(
    'DELETE FROM idempotency_keys WHERE expires_at < NOW()'
  );
  const [auditResult] = await dbPool.query(
    'DELETE FROM agent_audit_log WHERE created_at < ?',
    [cutoff]
  );

  return {
    dryRun: false,
    retentionDays: days,
    cutoff,
    idempotency: Number(idempotencyResult && idempotencyResult.affectedRows) || 0,
    audit: Number(auditResult && auditResult.affectedRows) || 0,
  };
}

function printReport(result) {
  const mode = result.dryRun ? 'dry run' : 'deleted';
  console.log(`Agent API purge (${mode}):`);
  console.log(`  idempotency_keys expired: ${result.idempotency} ${mode}`);
  console.log(
    `  agent_audit_log older than ${result.retentionDays} day(s): ${result.audit} ${mode}`
  );
  if (result.dryRun) {
    console.log('  No rows were changed. Re-run without --dry-run to delete.');
  }
}

async function main(argv = process.argv.slice(2)) {
  const { dryRun } = parseArgs(argv);
  const result = await purge({ dryRun });
  printReport(result);
  return result;
}

if (require.main === module) {
  main()
    .then(() => db.end())
    .then(() => process.exit(0))
    .catch(async (error) => {
      console.error('Agent purge failed:', error && (error.code || error.message));
      try { await db.end(); } catch { /* already closed */ }
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_AUDIT_RETENTION_DAYS,
  getAuditRetentionDays,
  parseArgs,
  auditCutoff,
  countExpiredIdempotencyKeys,
  countExpiredAuditRows,
  purge,
  printReport,
  main,
};
