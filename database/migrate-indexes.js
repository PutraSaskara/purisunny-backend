// backend/database/migrate-indexes.js
// Idempotent migration: query-serving indexes + column hygiene (audit P3-2,
// P3-4, P3-5).
//
// Indexes added when missing:
//   articles (published_at, id)      journal ordering (ORDER BY published_at DESC, id DESC)
//   articles (category_id)           related-articles lookup + category delete COUNT
//                                    (usually already created as the FK's implicit index)
//   contacts (is_read)               unread-message badge
//   gallery_images (category)        gallery tab filtering
//   faq_items (page_key, position)   ordered FAQ read per page, subsumes the
//                                    old single-column (page_key) index
//
// Column hygiene, only when the current definition differs:
//   articles.read_time   INT NOT NULL DEFAULT 5
//   articles.is_featured TINYINT(1) NOT NULL DEFAULT 0
//   users.role           ENUM('admin','editor') NOT NULL DEFAULT 'editor'
//
// The users.role change affects NEW rows only: existing rows are untouched
// (an existing admin stays admin). AUTO_INCREMENT ids are preserved because
// redefining a column keeps the table contents.
//
// Every step reads information_schema first, so re-running is a no-op.
//
// Usage (from backend/):  node database/migrate-indexes.js

require('../config/loadEnv')();
const db = require('../config/db');

const DATABASE = process.env.DB_NAME || 'purisunny';

// ---- helpers ---------------------------------------------------------------

async function existingIndexes(table) {
  const [rows] = await db.query(
    `SELECT INDEX_NAME AS name, COLUMN_NAME AS column_name
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [DATABASE, table]
  );
  const byName = new Map();
  for (const row of rows) {
    if (!byName.has(row.name)) byName.set(row.name, []);
    byName.get(row.name).push(String(row.column_name).toLowerCase());
  }
  return byName;
}

// True when some index (under any name) starts with exactly these columns.
function hasIndexStartingWith(indexes, columns) {
  const wanted = columns.map((c) => c.toLowerCase());
  for (const cols of indexes.values()) {
    if (cols.length < wanted.length) continue;
    const prefix = cols.slice(0, wanted.length);
    if (prefix.every((c, i) => c === wanted[i])) return true;
  }
  return false;
}

async function ensureIndex(table, name, columns) {
  const indexes = await existingIndexes(table);
  const canonical = name.toLowerCase();

  if (hasIndexStartingWith(indexes, columns)) {
    console.log(`  = ${table}(${columns.join(', ')}) already indexed - skipped`);
    return;
  }

  // A partial/duplicate index under the canonical name would make ADD INDEX fail.
  if (indexes.has(canonical) || indexes.has(name)) {
    console.log(`  ~ ${table}.${name} exists with a different column list - replacing`);
    await db.query(`ALTER TABLE \`${table}\` DROP INDEX \`${name}\``);
  }

  await db.query(
    `ALTER TABLE \`${table}\` ADD INDEX \`${name}\` (${columns.map((c) => `\`${c}\``).join(', ')})`
  );
  console.log(`  + ${table}(${columns.join(', ')}) indexed as ${name}`);
}

async function columnInfo(table, column) {
  const [rows] = await db.query(
    `SELECT IS_NULLABLE AS nullable, COLUMN_TYPE AS columnType, COLUMN_DEFAULT AS columnDefault
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DATABASE, table, column]
  );
  return rows[0] || null;
}

// Redefine a column only if it does not already satisfy the target definition.
function ensureColumn(table, column, ddl, matches) {
  return columnInfo(table, column).then(async (info) => {
    if (!info) {
      console.log(`  ! ${table}.${column} not found - run database/schema.sql first`);
      return;
    }
    if (matches(info)) {
      console.log(`  = ${table}.${column} already up to date - skipped`);
      return;
    }
    await db.query(`ALTER TABLE \`${table}\` MODIFY COLUMN ${ddl}`);
    console.log(`  + ${table}.${column} -> ${ddl}`);
  });
}

function defaultMatches(expected) {
  return (info) => {
    if (info.columnDefault === null) return false;
    return String(info.columnDefault).toLowerCase() === String(expected).toLowerCase();
  };
}

// ---- main ----------------------------------------------------------------

async function migrate() {
  console.log(`Running index + column migration on "${DATABASE}"...`);

  // Indexes
  await ensureIndex('articles', 'idx_articles_published_at_id', ['published_at', 'id']);
  await ensureIndex('articles', 'idx_articles_category_id', ['category_id']);
  await ensureIndex('contacts', 'idx_contacts_is_read', ['is_read']);
  await ensureIndex('gallery_images', 'idx_gallery_images_category', ['category']);
  await ensureIndex('faq_items', 'idx_faq_items_page_position', ['page_key', 'position']);

  // Backfill NULLs before enforcing NOT NULL (MODIFY maps NULL -> default in
  // strict mode, but doing it explicitly keeps the intent readable).
  const [[nullRead]] = await db.query('SELECT COUNT(*) AS n FROM articles WHERE read_time IS NULL');
  if (nullRead.n > 0) {
    await db.query('UPDATE articles SET read_time = 5 WHERE read_time IS NULL');
    console.log(`  ~ backfilled ${nullRead.n} articles.read_time NULL -> 5`);
  }
  const [[nullFeatured]] = await db.query('SELECT COUNT(*) AS n FROM articles WHERE is_featured IS NULL');
  if (nullFeatured.n > 0) {
    await db.query('UPDATE articles SET is_featured = 0 WHERE is_featured IS NULL');
    console.log(`  ~ backfilled ${nullFeatured.n} articles.is_featured NULL -> 0`);
  }
  const [[nullRole]] = await db.query('SELECT COUNT(*) AS n FROM users WHERE role IS NULL');
  if (nullRole.n > 0) {
    await db.query("UPDATE users SET role = 'editor' WHERE role IS NULL");
    console.log(`  ~ backfilled ${nullRole.n} users.role NULL -> 'editor'`);
  }

  // Column hygiene
  await ensureColumn(
    'articles',
    'read_time',
    'read_time INT NOT NULL DEFAULT 5',
    (info) => info.nullable === 'NO' && defaultMatches('5')(info)
  );
  await ensureColumn(
    'articles',
    'is_featured',
    'is_featured TINYINT(1) NOT NULL DEFAULT 0',
    (info) => info.nullable === 'NO' && defaultMatches('0')(info)
  );
  await ensureColumn(
    'users',
    'role',
    "role ENUM('admin','editor') NOT NULL DEFAULT 'editor'",
    (info) =>
      info.nullable === 'NO' &&
      defaultMatches('editor')(info) &&
      /enum\('admin','editor'\)/i.test(info.columnType)
  );

  console.log('\nIndex + column migration complete.');
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration error:', err.code || '', err.message);
    process.exit(1);
  });
