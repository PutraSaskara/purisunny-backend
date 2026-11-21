// backend/database/migrate-redirects.js
// Idempotent migration: create the `redirects` table (SEO Task A).
//
// redirects:  from_path -> to_path map with 301/302 status, used by the
//             frontend to resolve retired URLs and by routes/articles.js to
//             leave a 301 behind when an article slug changes.
//
// Safe to run multiple times: CREATE TABLE IF NOT EXISTS prevents duplicate
// errors. Existing rows/data are never touched.
//
// The DDL lives in ddl-redirects.js so scripts/setup-test-db.js creates exactly
// the same shape for the automated tests.
//
// Usage: node database/migrate-redirects.js   (run from backend/)

require('../config/loadEnv')();
const db = require('../config/db');
const { redirectsDDL } = require('./ddl-redirects');

async function tableExists(name) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [name]
  );
  return rows.length > 0;
}

async function migrate() {
  console.log('Running redirects migration...');

  if (await tableExists('redirects')) {
    console.log('  = redirects already exists - skipped');
  } else {
    await db.query(redirectsDDL);
    console.log('  + redirects created');
  }

  console.log('\nRedirects migration complete.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration error:', err.message);
  process.exit(1);
});
