// backend/database/migrate-articles-category-fk.js
// Idempotent migration: make articles.category_id REFUSE deletion of a
// referenced category instead of silently detaching it.
//
//   before: FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
//   after:  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
//
// Why: the API now answers 409 when a category still has articles
// (routes/categories.js). SET NULL was the reason that delete used to succeed
// and quietly orphan every article; RESTRICT turns the database into the
// backstop for the race where an article is attached between the API's COUNT
// check and the DELETE.
//
// Safe to run multiple times: the current rule is read from
// information_schema first and the FK is only recreated when it is SET NULL,
// CASCADE, or missing. Existing rows/data are never touched.
//
// Backfill note: this migration does NOT detach anything. If a category is
// deleted concurrently the FK raises ER_ROW_IS_REFERENCED_2, which the API
// already maps to 409.
//
// Usage (from backend/):  node database/migrate-articles-category-fk.js

require('../config/loadEnv')();
const db = require('../config/db');

const TABLE = 'articles';
const COLUMN = 'category_id';
const REFERENCED_TABLE = 'categories';
// Name used when the existing constraint has no usable name.
const NEW_CONSTRAINT_NAME = 'fk_articles_category_id';

async function migrate() {
  const database = process.env.DB_NAME || 'purisunny';

  const [constraints] = await db.query(
    `SELECT kcu.CONSTRAINT_NAME AS name, rc.DELETE_RULE AS deleteRule
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE kcu.TABLE_SCHEMA = ?
        AND kcu.TABLE_NAME = ?
        AND kcu.COLUMN_NAME = ?
        AND kcu.REFERENCED_TABLE_NAME = ?`,
    [database, TABLE, COLUMN, REFERENCED_TABLE]
  );

  if (constraints.length === 0) {
    console.log(`  + no FK on ${TABLE}.${COLUMN} found — creating ${NEW_CONSTRAINT_NAME} (RESTRICT)`);
    await db.query(
      `ALTER TABLE ${TABLE}
         ADD CONSTRAINT ${NEW_CONSTRAINT_NAME}
         FOREIGN KEY (${COLUMN}) REFERENCES ${REFERENCED_TABLE}(id) ON DELETE RESTRICT`
    );
    console.log('\nCategory FK migration complete.');
    return;
  }

  for (const constraint of constraints) {
    if (constraint.deleteRule === 'RESTRICT' || constraint.deleteRule === 'NO ACTION') {
      console.log(`  = ${constraint.name} already ${constraint.deleteRule} — skipped`);
      continue;
    }
    console.log(`  ~ ${constraint.name} is ${constraint.deleteRule} — converting to RESTRICT`);
    await db.query(`ALTER TABLE ${TABLE} DROP FOREIGN KEY \`${constraint.name}\``);
    await db.query(
      `ALTER TABLE ${TABLE}
         ADD CONSTRAINT ${NEW_CONSTRAINT_NAME}
         FOREIGN KEY (${COLUMN}) REFERENCES ${REFERENCED_TABLE}(id) ON DELETE RESTRICT`
    );
  }

  console.log('\nCategory FK migration complete.');
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration error:', err.message);
    process.exit(1);
  });
