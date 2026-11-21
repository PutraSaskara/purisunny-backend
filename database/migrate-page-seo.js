// backend/database/migrate-page-seo.js
// Idempotent migration: create page_seo + faq_items tables.
//
// page_seo:   Stores SEO metadata for each of the 18 official page keys.
// faq_items:  Stores FAQ entries associated with a page_key.
//
// Safe to run multiple times: CREATE TABLE IF NOT EXISTS prevents duplicate
// errors. Existing rows/data are never touched.
//
// The DDL lives in ddl-page-seo.js so scripts/setup-test-db.js creates exactly
// the same shape for the automated tests.
//
// The faq_items -> page_seo foreign key (ON DELETE CASCADE) and the composite
// (page_key, position) index are applied by migrate-page-seo-fk-index.js, which
// must run for *existing* tables too.
//
// Usage: node database/migrate-page-seo.js   (run from backend/)

require('../config/loadEnv')();
const db = require('../config/db');
const { pageSeoDDL, faqItemsDDL } = require('./ddl-page-seo');

async function tableExists(name) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [name]
  );
  return rows.length > 0;
}

async function ensureTable(name, ddl) {
  if (await tableExists(name)) {
    console.log(`  = ${name} already exists - skipped`);
    return;
  }
  await db.query(ddl);
  console.log(`  + ${name} created`);
}

async function migrate() {
  console.log('Running page_seo migration...');

  await ensureTable('page_seo', pageSeoDDL);
  await ensureTable('faq_items', faqItemsDDL);

  console.log('\nPage SEO migration complete.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration error:', err.message);
  process.exit(1);
});
