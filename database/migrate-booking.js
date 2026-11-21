// backend/database/migrate-booking.js
// Idempotent migration: create the booking-lead tracking tables (Phase 1).
//
// booking_leads:   one inquiry per row + the email delivery state machine.
// booking_events:  anonymous conversion events (no IP, no user agent, no PII).
//
// Safe to run multiple times: CREATE TABLE IF NOT EXISTS prevents duplicate
// errors. Existing rows/data are never touched.
//
// The DDL lives in ddl-booking.js so scripts/setup-test-db.js creates exactly
// the same shape for the automated tests.
//
// Usage: node database/migrate-booking.js   (run from backend/)

require('../config/loadEnv')();
const db = require('../config/db');
const { bookingLeadsDDL, bookingEventsDDL } = require('./ddl-booking');

async function tableExists(name) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [name]
  );
  return rows.length > 0;
}

async function migrate() {
  console.log('Running booking migration...');

  if (await tableExists('booking_leads')) {
    console.log('  = booking_leads already exists - skipped');
  } else {
    await db.query(bookingLeadsDDL);
    console.log('  + booking_leads created');
  }

  if (await tableExists('booking_events')) {
    console.log('  = booking_events already exists - skipped');
  } else {
    await db.query(bookingEventsDDL);
    console.log('  + booking_events created');
  }

  console.log('\nBooking migration complete.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration error:', err.message);
  process.exit(1);
});
