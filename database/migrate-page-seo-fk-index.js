// backend/database/migrate-page-seo-fk-index.js
// Idempotent migration for faq_items (audit P3-2, P3-3):
//
//   1. faq_items.page_key -> FOREIGN KEY REFERENCES page_seo(page_key)
//      ON DELETE CASCADE, so deleting a page cannot leave orphaned FAQs.
//   2. Composite index (page_key, position) replacing the old single-column
//      (page_key) index: same leftmost prefix, plus the ordering column.
//
// Collation/type compatibility: both columns are VARCHAR(100) with the table
// default utf8mb4_unicode_ci (see schema.sql / ddl-page-seo.js). Before adding
// the FK the migration verifies that the collations and types actually match
// and refuses to proceed otherwise.
//
// Orphan handling: an existing install may already contain faq_items rows whose
// page_key has no page_seo parent (the old API could insert before this FK
// existed). Adding the FK would fail, so those rows are deleted first. They are
// unreachable through the API (GET/PUT are keyed on page_seo). The count is
// printed.
//
// Re-runnable: the FK and indexes are read from information_schema first.
//
// Usage (from backend/):  node database/migrate-page-seo-fk-index.js

require('../config/loadEnv')();
const db = require('../config/db');

const DATABASE = process.env.DB_NAME || 'purisunny';
const TABLE = 'faq_items';
const PARENT_TABLE = 'page_seo';
const COLUMN = 'page_key';
const FK_NAME = 'fk_faq_items_page_key';
const COMPOSITE_INDEX = 'idx_faq_items_page_position';
const LEGACY_INDEX = 'idx_faq_items_page_key';

async function indexNames() {
  const [rows] = await db.query(
    `SELECT DISTINCT INDEX_NAME AS name
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [DATABASE, TABLE]
  );
  return rows.map((r) => r.name);
}

async function indexColumns(name) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME AS column_name
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`,
    [DATABASE, TABLE, name]
  );
  return rows.map((r) => String(r.column_name).toLowerCase());
}

async function existingFk() {
  const [rows] = await db.query(
    `SELECT kcu.CONSTRAINT_NAME AS name, rc.DELETE_RULE AS deleteRule
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE kcu.TABLE_SCHEMA = ?
        AND kcu.TABLE_NAME = ?
        AND kcu.COLUMN_NAME = ?
        AND kcu.REFERENCED_TABLE_NAME = ?`,
    [DATABASE, TABLE, COLUMN, PARENT_TABLE]
  );
  return rows;
}

async function columnMeta(table, column) {
  const [rows] = await db.query(
    `SELECT COLUMN_TYPE AS columnType, CHARACTER_SET_NAME AS charset,
            COLLATION_NAME AS collation
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DATABASE, table, column]
  );
  return rows[0] || null;
}

// ---- main ----------------------------------------------------------------

async function migrate() {
  console.log(`Running faq_items FK + index migration on "${DATABASE}"...`);

  const child = await columnMeta(TABLE, COLUMN);
  const parent = await columnMeta(PARENT_TABLE, COLUMN);
  if (!child || !parent) {
    throw new Error(
      `${TABLE}.${COLUMN} or ${PARENT_TABLE}.${COLUMN} not found. ` +
      'Run database/schema.sql and database/migrate-page-seo.js first.'
    );
  }
  if (
    child.charset !== parent.charset ||
    child.collation !== parent.collation ||
    child.columnType !== parent.columnType
  ) {
    throw new Error(
      `Column mismatch: ${TABLE}.${COLUMN} is ${child.columnType} ${child.charset}/${child.collation}, ` +
      `${PARENT_TABLE}.${COLUMN} is ${parent.columnType} ${parent.charset}/${parent.collation}. ` +
      'Align the collations before adding the foreign key.'
    );
  }

  // 1. Foreign key
  const fks = await existingFk();
  if (fks.length > 0) {
    const fk = fks[0];
    if (fk.deleteRule === 'CASCADE') {
      console.log(`  = ${fk.name} already ON DELETE CASCADE - skipped`);
    } else {
      console.log(`  ~ ${fk.name} is ON DELETE ${fk.deleteRule} - converting to CASCADE`);
      await db.query(`ALTER TABLE \`${TABLE}\` DROP FOREIGN KEY \`${fk.name}\``);
      await db.query(
        `ALTER TABLE \`${TABLE}\`
           ADD CONSTRAINT \`${FK_NAME}\`
           FOREIGN KEY (\`${COLUMN}\`) REFERENCES \`${PARENT_TABLE}\`(\`${COLUMN}\`) ON DELETE CASCADE`
      );
    }
  } else {
    const [[orphans]] = await db.query(
      `SELECT COUNT(*) AS n FROM \`${TABLE}\` f
         LEFT JOIN \`${PARENT_TABLE}\` p ON p.\`${COLUMN}\` = f.\`${COLUMN}\`
        WHERE p.\`${COLUMN}\` IS NULL`
    );
    if (orphans.n > 0) {
      console.log(`  ~ removing ${orphans.n} orphaned ${TABLE} row(s) (no matching ${PARENT_TABLE}.${COLUMN})`);
      await db.query(
        `DELETE f FROM \`${TABLE}\` f
           LEFT JOIN \`${PARENT_TABLE}\` p ON p.\`${COLUMN}\` = f.\`${COLUMN}\`
          WHERE p.\`${COLUMN}\` IS NULL`
      );
    }
    await db.query(
      `ALTER TABLE \`${TABLE}\`
         ADD CONSTRAINT \`${FK_NAME}\`
         FOREIGN KEY (\`${COLUMN}\`) REFERENCES \`${PARENT_TABLE}\`(\`${COLUMN}\`) ON DELETE CASCADE`
    );
    console.log(`  + ${FK_NAME} added (ON DELETE CASCADE)`);
  }

  // 2. Composite index, absorb the single-column one
  const names = await indexNames();

  const compositeCols = names.includes(COMPOSITE_INDEX) ? await indexColumns(COMPOSITE_INDEX) : null;
  if (compositeCols && compositeCols.join(',') === `${COLUMN},position`) {
    console.log(`  = ${COMPOSITE_INDEX} already present - skipped`);
  } else {
    if (compositeCols) {
      await db.query(`ALTER TABLE \`${TABLE}\` DROP INDEX \`${COMPOSITE_INDEX}\``);
    }
    await db.query(
      `ALTER TABLE \`${TABLE}\` ADD INDEX \`${COMPOSITE_INDEX}\` (\`${COLUMN}\`, \`position\`)`
    );
    console.log(`  + ${COMPOSITE_INDEX} added (${COLUMN}, position)`);
  }

  // The old single-column index is now a strict prefix of the composite one.
  const namesAfter = await indexNames();
  if (namesAfter.includes(LEGACY_INDEX)) {
    await db.query(`ALTER TABLE \`${TABLE}\` DROP INDEX \`${LEGACY_INDEX}\``);
    console.log(`  - ${LEGACY_INDEX} dropped (absorbed by ${COMPOSITE_INDEX})`);
  } else {
    console.log(`  = ${LEGACY_INDEX} not present - skipped`);
  }

  console.log('\nfaq_items FK + index migration complete.');
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration error:', err.code || '', err.message);
    process.exit(1);
  });
