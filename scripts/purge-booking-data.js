// backend/scripts/purge-booking-data.js
//
// Retention housekeeping for booking tracking:
//   * booking_leads older than 24 months (default 730 days)
//   * booking_events older than 12 months (default 365 days)
//
// From backend/:
//   npm run booking:purge                       # delete and print counts
//   npm run booking:purge -- --dry-run          # count only, no write
//   npm run booking:purge -- --leads-days 900 --events-days 400
//
// Only row counts are printed. Row contents (names, emails, phone numbers,
// messages) are never read or logged.
//
// Safe for a daily or weekly cron entry. Exit code is 0 on success and 1 on
// database failure.

require('../config/loadEnv')();

const db = require('../config/db');

const DEFAULT_LEADS_RETENTION_DAYS = 730; // ~24 months
const DEFAULT_EVENTS_RETENTION_DAYS = 365; // ~12 months
const DAY_MS = 24 * 60 * 60 * 1000;

// Strict positive integer: "30" is valid, while "0", "-5", "1.5", "abc" and a
// missing value all fall back to the default.
function parsePositiveInteger(raw, fallback) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  let leadsRaw;
  let eventsRaw;

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--leads-days') {
      // Do not consume the next flag as a value.
      if (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) {
        leadsRaw = String(args[i + 1]);
        i += 1;
      }
    } else if (arg.startsWith('--leads-days=')) {
      leadsRaw = arg.slice('--leads-days='.length);
    } else if (arg === '--events-days') {
      if (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) {
        eventsRaw = String(args[i + 1]);
        i += 1;
      }
    } else if (arg.startsWith('--events-days=')) {
      eventsRaw = arg.slice('--events-days='.length);
    }
  }

  return {
    dryRun: args.includes('--dry-run'),
    leadsDays: parsePositiveInteger(leadsRaw, DEFAULT_LEADS_RETENTION_DAYS),
    eventsDays: parsePositiveInteger(eventsRaw, DEFAULT_EVENTS_RETENTION_DAYS),
  };
}

function firstCount(result) {
  // mysql2 returns [rows, fields]; test fakes may return rows directly. Accept
  // either shape.
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const row = rows[0] || {};
  return Number(row.count) || 0;
}

// MySQL comparisons use a JS Date so the SQL stays portable and testable.
function cutoffDate({ now = new Date(), retentionDays }) {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

async function countOlderThan(pool, table, cutoff) {
  const result = await pool.query(
    `SELECT COUNT(*) AS count FROM ${table} WHERE created_at < ?`,
    [cutoff]
  );
  return firstCount(result);
}

async function deleteOlderThan(pool, table, cutoff) {
  const result = await pool.query(
    `DELETE FROM ${table} WHERE created_at < ?`,
    [cutoff]
  );
  const affected = Array.isArray(result) ? result[0] : result;
  return Number(affected && affected.affectedRows) || 0;
}

async function purge({ dryRun = false, dbPool = db, now = new Date(), leadsDays, eventsDays } = {}) {
  const leadWindow = leadsDays === undefined ? DEFAULT_LEADS_RETENTION_DAYS : leadsDays;
  const eventWindow = eventsDays === undefined ? DEFAULT_EVENTS_RETENTION_DAYS : eventsDays;
  const leadsCutoff = cutoffDate({ now, retentionDays: leadWindow });
  const eventsCutoff = cutoffDate({ now, retentionDays: eventWindow });

  const beforeLeads = await countOlderThan(dbPool, 'booking_leads', leadsCutoff);
  const beforeEvents = await countOlderThan(dbPool, 'booking_events', eventsCutoff);

  if (dryRun) {
    return {
      dryRun: true,
      leadsDays: leadWindow,
      eventsDays: eventWindow,
      leadsCutoff,
      eventsCutoff,
      before: { leads: beforeLeads, events: beforeEvents },
      after: null,
      deleted: { leads: 0, events: 0 },
    };
  }

  const deletedLeads = await deleteOlderThan(dbPool, 'booking_leads', leadsCutoff);
  const deletedEvents = await deleteOlderThan(dbPool, 'booking_events', eventsCutoff);

  // Re-count after the delete. Counts only; no row contents are read.
  const afterLeads = await countOlderThan(dbPool, 'booking_leads', leadsCutoff);
  const afterEvents = await countOlderThan(dbPool, 'booking_events', eventsCutoff);

  return {
    dryRun: false,
    leadsDays: leadWindow,
    eventsDays: eventWindow,
    leadsCutoff,
    eventsCutoff,
    before: { leads: beforeLeads, events: beforeEvents },
    after: { leads: afterLeads, events: afterEvents },
    deleted: { leads: deletedLeads, events: deletedEvents },
  };
}

function printReport(result) {
  if (result.dryRun) {
    console.log('Booking data purge (dry run):');
    console.log(
      `  booking_leads older than ${result.leadsDays} day(s): ${result.before.leads} would be deleted`
    );
    console.log(
      `  booking_events older than ${result.eventsDays} day(s): ${result.before.events} would be deleted`
    );
    console.log('  No rows were changed. Re-run without --dry-run to delete.');
    return;
  }

  console.log('Booking data purge (live):');
  console.log(
    `  booking_leads older than ${result.leadsDays} day(s): ` +
      `${result.before.leads} before, ${result.after.leads} after (${result.deleted.leads} deleted)`
  );
  console.log(
    `  booking_events older than ${result.eventsDays} day(s): ` +
      `${result.before.events} before, ${result.after.events} after (${result.deleted.events} deleted)`
  );
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await purge(args);
  printReport(result);
  return result;
}

if (require.main === module) {
  main()
    .then(() => db.end())
    .then(() => process.exit(0))
    .catch(async (error) => {
      console.error('Booking purge failed:', error && (error.code || error.message));
      try { await db.end(); } catch { /* already closed */ }
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_LEADS_RETENTION_DAYS,
  DEFAULT_EVENTS_RETENTION_DAYS,
  parsePositiveInteger,
  parseArgs,
  cutoffDate,
  countOlderThan,
  deleteOlderThan,
  purge,
  printReport,
  main,
};
