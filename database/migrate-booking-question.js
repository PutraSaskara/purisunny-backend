// backend/database/migrate-booking-question.js
// Idempotent migration: extend booking_leads with the `question` channel.
//
// The mini "Ask a question" form has no stay dates, so:
//   * channel accepts 'whatsapp', 'email' or 'question'
//   * check_in / check_out become nullable
//   * guests keeps NOT NULL and gains DEFAULT 1
//
// Existing rows and data are never touched. MODIFY to the same definition is a
// no-op, so this is safe to run repeatedly (including after migrate-booking.js).
//
// If booking_leads does not exist yet, the shared DDL creates the new shape
// directly. scripts/setup-test-db.js also applies these ALTERs so an older
// scratch database converges to the same shape.
//
// Usage: node database/migrate-booking-question.js   (run from backend/)

require('../config/loadEnv')();
const db = require('../config/db');
const {
  bookingLeadsDDL,
  bookingEventsDDL,
  bookingQuestionMigrationDDL,
} = require('./ddl-booking');

async function tableExists(name) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [name]
  );
  return rows.length > 0;
}

async function migrate() {
  console.log('Running booking question migration...');

  if (!(await tableExists('booking_leads'))) {
    await db.query(bookingLeadsDDL);
    await db.query(bookingEventsDDL);
    console.log('  + booking tables created with question channel');
  } else {
    for (const ddl of bookingQuestionMigrationDDL) {
      await db.query(ddl);
    }
    console.log('  ~ booking_leads channel/date/guest shape updated');
  }

  console.log('\nBooking question migration complete.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration error:', err.message);
  process.exit(1);
});
