// backend/database/migrate-article-faq.js
// Idempotent migration: create the article_faq_items table (optional per-article
// Q/A list, see routes/articles.js).
//
// This is deliberately a NEW table: the page-level faq_items -> page_seo flow
// (routes/seo.js) is a separate, already-tested contract and is not touched.
//
// Idempotent by construction:
//   - table missing            -> created from database/ddl-article-faq.js
//   - table present, FK OK     -> skipped
//   - table present, FK with another DELETE rule -> converted to CASCADE
//   - index present with the wrong column list   -> replaced
// Existing rows are never deleted. A pre-existing orphaned row (article_id
// with no parent article) has no valid target and is removed before the FK is
// added, same policy as migrate-page-seo-fk-index.js; the count is printed.
//
// Usage (from backend/):  node database/migrate-article-faq.js

require('../config/loadEnv')();
const db = require('../config/db');
const {
  ARTICLE_FAQ_TABLE: TABLE,
  ARTICLE_FAQ_FK_NAME: FK_NAME,
  ARTICLE_FAQ_INDEX_NAME: INDEX_NAME,
  ARTICLE_FAQ_PARENT_TABLE: PARENT_TABLE,
  articleFaqItemsDDL,
} = require('./ddl-article-faq');

const COLUMN = 'article_id';
const DATABASE = process.env.DB_NAME || 'purisunny';

async function tableExists(name) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [name]
  );
  return rows.length > 0;
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

async function ensureFk() {
  const fks = await existingFk();
  if (fks.length > 0) {
    const fk = fks[0];
    if (fk.deleteRule === 'CASCADE') {
      console.log(`  = ${fk.name} already ON DELETE CASCADE - skipped`);
      return;
    }
    console.log(`  ~ ${fk.name} is ON DELETE ${fk.deleteRule} - converting to CASCADE`);
    await db.query(`ALTER TABLE \`${TABLE}\` DROP FOREIGN KEY \`${fk.name}\``);
  }

  const [[orphans]] = await db.query(
    `SELECT COUNT(*) AS n FROM \`${TABLE}\` f
       LEFT JOIN \`${PARENT_TABLE}\` p ON p.id = f.\`${COLUMN}\`
      WHERE p.id IS NULL`
  );
  if (orphans.n > 0) {
    console.log(`  ~ removing ${orphans.n} orphaned ${TABLE} row(s) (no matching ${PARENT_TABLE}.id)`);
    await db.query(
      `DELETE f FROM \`${TABLE}\` f
         LEFT JOIN \`${PARENT_TABLE}\` p ON p.id = f.\`${COLUMN}\`
        WHERE p.id IS NULL`
    );
  }

  await db.query(
    `ALTER TABLE \`${TABLE}\`
       ADD CONSTRAINT \`${FK_NAME}\`
       FOREIGN KEY (\`${COLUMN}\`) REFERENCES \`${PARENT_TABLE}\`(id) ON DELETE CASCADE`
  );
  console.log(`  + ${FK_NAME} added (ON DELETE CASCADE)`);
}

async function ensureIndex() {
  const columns = await indexColumns(INDEX_NAME);
  if (columns.join(',') === `${COLUMN},position`) {
    console.log(`  = ${INDEX_NAME} already present - skipped`);
    return;
  }
  if (columns.length > 0) {
    await db.query(`ALTER TABLE \`${TABLE}\` DROP INDEX \`${INDEX_NAME}\``);
  }
  await db.query(
    `ALTER TABLE \`${TABLE}\` ADD INDEX \`${INDEX_NAME}\` (\`${COLUMN}\`, \`position\`)`
  );
  console.log(`  + ${INDEX_NAME} added (${COLUMN}, position)`);
}

async function migrate() {
  console.log(`Running ${TABLE} migration on "${DATABASE}"...`);

  if (!(await tableExists(PARENT_TABLE))) {
    throw new Error(
      `${PARENT_TABLE} table not found. Run database/schema.sql first.`
    );
  }

  if (await tableExists(TABLE)) {
    console.log(`  = ${TABLE} already exists - verifying FK + index`);
  } else {
    await db.query(articleFaqItemsDDL);
    console.log(`  + ${TABLE} created`);
    console.log(`\n${TABLE} migration complete.`);
    return;
  }

  await ensureFk();
  await ensureIndex();

  console.log(`\n${TABLE} migration complete.`);
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration error:', err.code || '', err.message);
    process.exit(1);
  });
