// backend/database/migrate-articles-seo.js
// Idempotent migration: add SEO fields to the `articles` table.
//
//   meta_title       VARCHAR(255) NULL
//   meta_description VARCHAR(500) NULL
//   og_image         VARCHAR(500) NULL
//   noindex          TINYINT(1) NOT NULL DEFAULT 0
//
// Safe to run multiple times: each column is only added when it is missing
// from information_schema. Existing rows/data are never touched.
//
// Usage: node database/migrate-articles-seo.js   (run from backend/)

require('../config/loadEnv')();
const db = require('../config/db');

const columns = [
  {
    name: 'meta_title',
    ddl: 'ADD COLUMN meta_title VARCHAR(255) NULL AFTER is_featured',
  },
  {
    name: 'meta_description',
    ddl: 'ADD COLUMN meta_description VARCHAR(500) NULL AFTER meta_title',
  },
  {
    name: 'og_image',
    ddl: 'ADD COLUMN og_image VARCHAR(500) NULL AFTER meta_description',
  },
  {
    name: 'noindex',
    ddl: 'ADD COLUMN noindex TINYINT(1) NOT NULL DEFAULT 0 AFTER og_image',
  },
];

async function migrate() {
  const database = process.env.DB_NAME || 'purisunny';

  const [rows] = await db.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'articles'`,
    [database]
  );

  // Ensure the table itself exists.
  if (rows.length === 0) {
    throw new Error(`Table 'articles' not found in database '${database}'. Run database/schema.sql first.`);
  }

  const existing = new Set(rows.map((r) => r.COLUMN_NAME));

  for (const col of columns) {
    if (existing.has(col.name)) {
      console.log(`  = ${col.name} already exists — skipped`);
      continue;
    }

    try {
      await db.query(`ALTER TABLE articles ${col.ddl}`);
      console.log(`  + ${col.name} added`);
    } catch (err) {
      // Idempotency safety net: another process may have added it concurrently.
      if (err && err.code === 'ER_DUP_FIELDNAME') {
        console.log(`  = ${col.name} already exists (race) — skipped`);
        continue;
      }
      throw err;
    }
  }

  console.log('\nSEO columns migration complete.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration error:', err.message);
  process.exit(1);
});