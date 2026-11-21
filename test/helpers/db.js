// backend/test/helpers/db.js
//
// Optional scratch-database support. Returns the shared pool when a test
// database is configured and reachable, otherwise null so DB-backed suites can
// skip gracefully (a machine without MySQL still runs `npm test` green).
//
// Cross-process coordination: `node --test` runs every *file* in its own
// process, and several DB suites share ONE scratch database. A suite's cleanup
// (e.g. `DELETE FROM articles WHERE slug LIKE 'zz-nodetest-%'`) would otherwise
// delete another suite's fixtures mid-run, which makes DB tests flaky under the
// full `npm test`. DB-backed suites therefore serialise themselves with
//   - an in-process promise chain (suites in the same process), and
//   - a MySQL advisory lock, GET_LOCK(), held on ONE dedicated pool connection
//     for the lifetime of the suite (other processes).
// The lock is connection-scoped, so nothing is written to the database and a
// crashed suite releases it as soon as its connection closes.

require('./env');

const path = require('path');
const fs = require('fs');

// config/loadEnv picks .env.test because test/helpers/env.js set
// DOTENV_PROFILE=test before this module was evaluated.
require(path.join(__dirname, '..', '..', 'config', 'loadEnv'))();
const testEnvPath = path.join(__dirname, '..', '..', '.env.test');
const HAS_TEST_PROFILE = fs.existsSync(testEnvPath);

const DB_NAME = process.env.DB_NAME || '';
const LOOKS_LIKE_TEST_DB = /test|verify|scratch/i.test(DB_NAME);

const LOCK_NAME = 'zz_test_db_suite_lock';
// Upper bound for waiting on another suite (a full run takes well under this).
const LOCK_TIMEOUT_S = 180;

async function tryGetDb() {
  if (!HAS_TEST_PROFILE || !LOOKS_LIKE_TEST_DB) {
    return { db: null, reason: 'no backend/.env.test pointing at a *test* database' };
  }
  let db;
  try {
    db = require('../../config/db');
    await db.query('SELECT 1');
  } catch (err) {
    return { db: null, reason: `scratch MySQL unreachable (${err.code || err.message})` };
  }
  try {
    const [rows] = await db.query(
      "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('articles','categories','users')"
    );
    if (rows.length < 3) {
      return { db: null, reason: 'scratch database is missing tables (run node scripts/setup-test-db.js)' };
    }
  } catch (err) {
    return { db: null, reason: `cannot inspect scratch database (${err.code || err.message})` };
  }
  return { db, reason: null };
}

// In-process queue: every suite body waits for the previous one to finish.
let inProcessChain = Promise.resolve();

function inProcess(fn) {
  const previous = inProcessChain;
  let release;
  inProcessChain = new Promise((resolve) => { release = resolve; });
  return previous.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

// Run `fn` while holding the suite lock. `holder` is the object returned by
// createDbLock(); reusing it across calls keeps ONE connection (GET_LOCK is
// re-entrant per session, so the lock is acquired once and released at the end).
async function withTestDbLock(holder, fn) {
  return inProcess(async () => {
    if (!holder || !holder.connection) return fn();
    if (!holder.acquired) {
      const [rows] = await holder.connection.query('SELECT GET_LOCK(?, ?) AS got', [
        LOCK_NAME,
        holder.timeoutSeconds || LOCK_TIMEOUT_S,
      ]);
      if (!rows[0] || Number(rows[0].got) !== 1) {
        throw new Error(
          `could not acquire the test DB lock within ${holder.timeoutSeconds || LOCK_TIMEOUT_S}s (another suite is running)`
        );
      }
      holder.acquired = true;
    }
    return fn();
  });
}

// Creates the lock holder (one dedicated connection) and registers it with the
// node:test lifecycle: acquired in before(), released in after(). Returns a
// no-op holder when there is no database.
function createDbLock(db) {
  if (!db) {
    return { connection: null, acquired: false, close: async () => {} };
  }
  return {
    connection: null, // lazily created in acquire()
    acquired: false,
    async acquire() {
      this.connection = await db.getConnection();
    },
    async close() {
      if (this.connection) {
        try {
          await this.connection.query('SELECT RELEASE_LOCK(?) AS released', [LOCK_NAME]);
        } catch { /* closing the connection releases it anyway */ }
        try { this.connection.release(); } catch { /* already released */ }
      }
      this.connection = null;
      this.acquired = false;
    },
  };
}

module.exports = {
  tryGetDb,
  createDbLock,
  withTestDbLock,
  HAS_TEST_PROFILE,
  DB_NAME,
  LOCK_NAME,
  LOCK_TIMEOUT_S,
};
