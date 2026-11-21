// backend/scripts/setup-test-db.js
//
// Creates / refreshes the scratch database used by the verification scripts and
// the automated test suite:
//
//   1. CREATE DATABASE IF NOT EXISTS <DB_NAME>   (DB_NAME must look like a test DB)
//   2. import database/schema.sql with `USE purisunny;` rewritten to <DB_NAME>
//   3. run the idempotent migrations (the redirects table is part of
//      schema.sql, so a plain import already covers it; the FK/index migration
//      below applies anything schema.sql cannot express idempotently)
//   4. seed one admin user + one editor user with known passwords (tests only)
//
// The import is deliberately *not* `DROP DATABASE`: verify-integrity.js cleans
// up after itself and a refresh here must never destroy a developer's local
// data. Tables are created IF NOT EXISTS, so re-running is a no-op.
//
// Usage (from backend/):
//   node scripts/setup-test-db.js
//
// Requires .env.test (or explicit DB_* env vars) pointing at the scratch server.

const fs = require('fs');
const path = require('path');
const testEnvPath = path.join(__dirname, '..', '.env.test');
require('dotenv').config(fs.existsSync(testEnvPath) ? { path: testEnvPath } : undefined);

const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const {
  bookingLeadsDDL,
  bookingEventsDDL,
  bookingQuestionMigrationDDL,
} = require('../database/ddl-booking');

const DB_NAME = process.env.DB_NAME || '';
if (!/test|verify|scratch/i.test(DB_NAME)) {
  console.error(`Refusing to set up DB_NAME="${DB_NAME}". Point DB_NAME at a test database (e.g. purisunny_test).`);
  process.exit(1);
}

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'database', 'schema.sql');

// Test-only credentials. These are never used by the app; they exist solely so
// the test suite can exercise the admin/editor role split.
const TEST_USERS = [
  { username: 'zz-test-admin', email: 'zz-test-admin@example.test', password: 'Test-admin-pass-123', role: 'admin' },
  { username: 'zz-test-editor', email: 'zz-test-editor@example.test', password: 'Test-editor-pass-123', role: 'editor' },
];

function connectionOptions(database) {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : '',
    database,
    multipleStatements: true,
  };
}

async function main() {
  const root = await mysql.createConnection(connectionOptions(undefined));
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.end();

  const db = await mysql.createConnection(connectionOptions(DB_NAME));

  // Import the schema with the hardcoded database name redirected.
  // schema.sql already contains page_seo/faq_items and the faq FK, so a fresh
  // scratch database is identical to a migrated production one.
  const schema = fs
    .readFileSync(SCHEMA_PATH, 'utf8')
    .replace(/^CREATE DATABASE IF NOT EXISTS purisunny;/m, '')
    .replace(/^USE purisunny;/m, `USE \`${DB_NAME}\`;`);
  await db.query(schema);
  console.log(`  + schema imported into ${DB_NAME}`);

  // Booking tables come from schema.sql too; running the shared DDL here keeps
  // the scratch database byte-identical even if schema.sql is reordered.
  await db.query(bookingLeadsDDL);
  await db.query(bookingEventsDDL);
  // CREATE TABLE IF NOT EXISTS does not change a pre-existing scratch table, so
  // apply the question-channel shape explicitly. Each ALTER is idempotent.
  for (const ddl of bookingQuestionMigrationDDL) {
    await db.query(ddl);
  }
  console.log('  + booking tables verified (booking_leads, booking_events)');

  // Test users.
  for (const user of TEST_USERS) {
    const hash = await bcrypt.hash(user.password, 10);
    await db.query(
      `INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE password = VALUES(password), role = VALUES(role)`,
      [user.username, user.email, hash, user.role]
    );
  }
  console.log(`  + ${TEST_USERS.length} test users seeded (admin, editor)`);

  await db.end();
  console.log('\nTest database ready.');
}

main().catch((err) => {
  console.error('Test DB setup failed:', err.code || '', err.message);
  process.exit(1);
});
