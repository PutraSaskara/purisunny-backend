// backend/database/migrate-keywords.js
// Idempotent migration: add the optional meta-keywords column to `articles`
// and `page_seo`.
//
//   articles.keywords  VARCHAR(255) NULL
//   page_seo.keywords  VARCHAR(255) NULL
//
// NULL = "not set" — the API then emits no <meta name="keywords"> tag. The
// field is optional everywhere and does NOT feed any completeness score.
//
// Safe to run multiple times: each column is only added when it is missing from
// information_schema (same pattern as migrate-articles-seo.js). Purely
// additive: existing rows/data are never updated or deleted, so NULL is the
// value every existing row gets.
//
// Collation follows the tables themselves (utf8mb4_unicode_ci, declared at
// table level in database/schema.sql), so no per-column charset is needed.
//
// Usage: node database/migrate-keywords.js   (run from backend/)

require('../config/loadEnv')();
const db = require('../config/db');

const MAX_KEYWORDS_LENGTH = 255; // keep in sync with utils/validateKeywords.js

// Table -> DDL statement. `page_seo` puts the new column after the other SEO
// fields (it has no is_featured column, unlike articles).
const TARGETS = [
  {
    table: 'articles',
    name: 'keywords',
    ddl: `ADD COLUMN keywords VARCHAR(${MAX_KEYWORDS_LENGTH}) NULL AFTER noindex`,
  },
  {
    table: 'page_seo',
    name: 'keywords',
    ddl: `ADD COLUMN keywords VARCHAR(${MAX_KEYWORDS_LENGTH}) NULL AFTER noindex`,
  },
];

async function existingColumns(table) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return new Set(rows.map((r) => r.COLUMN_NAME));
}

async function migrate() {
  const database = process.env.DB_NAME || 'purisunny';
  console.log(`Running keywords migration on "${database}"...`);

  for (const target of TARGETS) {
    const existing = await existingColumns(target.table);

    // Ensure the table itself exists.
    if (existing.size === 0) {
      throw new Error(
        `Table '${target.table}' not found in database '${database}'. Run database/schema.sql first.`
      );
    }

    if (existing.has(target.name)) {
      console.log(`  = ${target.table}.${target.name} already exists — skipped`);
      continue;
    }

    try {
      await db.query(`ALTER TABLE ${target.table} ${target.ddl}`);
      console.log(`  + ${target.table}.${target.name} added`);
    } catch (err) {
      // Idempotency safety net: another process may have added it concurrently.
      if (err && err.code === 'ER_DUP_FIELDNAME') {
        console.log(`  = ${target.table}.${target.name} already exists (race) — skipped`);
        continue;
      }
      throw err;
    }
  }

  console.log('\nKeywords columns migration complete.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration error:', err.message);
  process.exit(1);
});
