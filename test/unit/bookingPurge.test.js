// backend/test/unit/bookingPurge.test.js
//
// Unit coverage for scripts/purge-booking-data.js using a fake MySQL pool. No
// database connection is made: the script is imported and purge() is called
// directly. Only counts are asserted; the script must never read row contents.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const purge = require('../../scripts/purge-booking-data');

function fakePool({
  leadsBefore = 5,
  eventsBefore = 9,
  leadsAfter = 0,
  eventsAfter = 0,
  leadsDeleted = 5,
  eventsDeleted = 9,
} = {}) {
  const calls = [];
  // Each table's count query returns the "before" value first, then the "after"
  // value on a later call.
  const counts = {
    booking_leads: [leadsBefore, leadsAfter],
    booking_events: [eventsBefore, eventsAfter],
  };

  return {
    calls,
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ text, params });

      const count = text.match(/^SELECT COUNT\(\*\) AS count FROM (booking_leads|booking_events) WHERE created_at < \?$/);
      if (count) {
        const values = counts[count[1]];
        const value = values.length > 1 ? values.shift() : values[0];
        return [[{ count: value }]];
      }

      const del = text.match(/^DELETE FROM (booking_leads|booking_events) WHERE created_at < \?$/);
      if (del) {
        return [{ affectedRows: del[1] === 'booking_leads' ? leadsDeleted : eventsDeleted }];
      }

      return [[]];
    },
  };
}

// ---------------------------------------------------------------------------
// Defaults + arguments
// ---------------------------------------------------------------------------

test('default retention is 730 days for leads and 365 days for events', () => {
  assert.equal(purge.DEFAULT_LEADS_RETENTION_DAYS, 730);
  assert.equal(purge.DEFAULT_EVENTS_RETENTION_DAYS, 365);
  assert.deepEqual(purge.parseArgs([]), {
    dryRun: false,
    leadsDays: 730,
    eventsDays: 365,
  });
});

test('parseArgs reads --dry-run and both override forms', () => {
  assert.deepEqual(purge.parseArgs(['--dry-run']), {
    dryRun: true,
    leadsDays: 730,
    eventsDays: 365,
  });

  assert.deepEqual(
    purge.parseArgs(['--leads-days', '900', '--events-days', '400']),
    { dryRun: false, leadsDays: 900, eventsDays: 400 }
  );

  assert.deepEqual(
    purge.parseArgs(['--leads-days=120', '--events-days=45', '--dry-run']),
    { dryRun: true, leadsDays: 120, eventsDays: 45 }
  );
});

test('invalid or missing day values fall back to the defaults', () => {
  for (const value of ['0', '-5', '1.5', 'abc', 'NaN', '2e3', '']) {
    assert.equal(purge.parsePositiveInteger(value, 730), 730, value);
  }
  assert.equal(purge.parsePositiveInteger(undefined, 365), 365);
  assert.equal(purge.parsePositiveInteger('30', 730), 30);

  assert.deepEqual(
    purge.parseArgs(['--leads-days', '0', '--events-days', 'abc']),
    { dryRun: false, leadsDays: 730, eventsDays: 365 }
  );
  // A flag directly followed by another flag does not consume it as a value.
  assert.deepEqual(
    purge.parseArgs(['--leads-days', '--dry-run']),
    { dryRun: true, leadsDays: 730, eventsDays: 365 }
  );
});

test('cutoffDate subtracts exactly the retention window', () => {
  const now = new Date('2026-01-31T00:00:00.000Z');
  assert.equal(purge.cutoffDate({ now, retentionDays: 730 }).toISOString(), '2024-02-01T00:00:00.000Z');
  assert.equal(purge.cutoffDate({ now, retentionDays: 365 }).toISOString(), '2025-01-31T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

test('--dry-run counts only and never deletes', async () => {
  const pool = fakePool({ leadsBefore: 7, eventsBefore: 12 });
  const now = new Date('2026-01-31T00:00:00.000Z');
  const result = await purge.purge({
    dryRun: true,
    dbPool: pool,
    now,
    leadsDays: 730,
    eventsDays: 365,
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.before, { leads: 7, events: 12 });
  assert.equal(result.after, null);
  assert.deepEqual(result.deleted, { leads: 0, events: 0 });
  assert.equal(result.leadsDays, 730);
  assert.equal(result.eventsDays, 365);

  assert.equal(pool.calls.length, 2);
  for (const call of pool.calls) {
    assert.match(call.text, /^SELECT COUNT\(\*\) AS count/);
    assert.equal(call.text.includes('DELETE'), false);
  }
  assert.ok(pool.calls[0].params[0] instanceof Date);
  assert.equal(pool.calls[0].params[0].toISOString(), '2024-02-01T00:00:00.000Z');
  assert.equal(pool.calls[1].params[0].toISOString(), '2025-01-31T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Live delete
// ---------------------------------------------------------------------------

test('live purge deletes old leads and events, then re-counts', async () => {
  const pool = fakePool({
    leadsBefore: 5,
    eventsBefore: 9,
    leadsAfter: 0,
    eventsAfter: 0,
    leadsDeleted: 5,
    eventsDeleted: 9,
  });
  const now = new Date('2026-01-31T00:00:00.000Z');
  const result = await purge.purge({
    dryRun: false,
    dbPool: pool,
    now,
    leadsDays: 730,
    eventsDays: 365,
  });

  assert.equal(result.dryRun, false);
  assert.deepEqual(result.before, { leads: 5, events: 9 });
  assert.deepEqual(result.after, { leads: 0, events: 0 });
  assert.deepEqual(result.deleted, { leads: 5, events: 9 });

  assert.deepEqual(
    pool.calls.map((call) => call.text.split(' ')[0]),
    ['SELECT', 'SELECT', 'DELETE', 'DELETE', 'SELECT', 'SELECT']
  );
  assert.match(pool.calls[2].text, /^DELETE FROM booking_leads WHERE created_at < \?$/);
  assert.match(pool.calls[3].text, /^DELETE FROM booking_events WHERE created_at < \?$/);
  assert.equal(pool.calls[2].params[0].toISOString(), '2024-02-01T00:00:00.000Z');
  assert.equal(pool.calls[3].params[0].toISOString(), '2025-01-31T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Custom windows
// ---------------------------------------------------------------------------

test('custom --leads-days / --events-days drive both cutoffs', async () => {
  const pool = fakePool({ leadsBefore: 2, eventsBefore: 3 });
  const now = new Date('2026-01-31T00:00:00.000Z');
  const args = purge.parseArgs(['--leads-days', '60', '--events-days=7']);
  const result = await purge.purge({ ...args, dbPool: pool, now });

  assert.equal(result.leadsDays, 60);
  assert.equal(result.eventsDays, 7);
  assert.equal(result.leadsCutoff.toISOString(), '2025-12-02T00:00:00.000Z');
  assert.equal(result.eventsCutoff.toISOString(), '2026-01-24T00:00:00.000Z');
  assert.deepEqual(result.before, { leads: 2, events: 3 });

  assert.equal(pool.calls[0].params[0].toISOString(), '2025-12-02T00:00:00.000Z');
  assert.equal(pool.calls[1].params[0].toISOString(), '2026-01-24T00:00:00.000Z');
});

test('purge accepts a flat rows array from non-mysql2 fakes', async () => {
  const pool = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.includes('FROM booking_leads')) return [{ count: 4 }];
      if (text.includes('FROM booking_events')) return [{ count: 1 }];
      return [{}];
    },
  };

  const result = await purge.purge({ dryRun: true, dbPool: pool, leadsDays: 30, eventsDays: 10 });
  assert.deepEqual(result.before, { leads: 4, events: 1 });
});

test('purge handles an empty delete result without throwing', async () => {
  const pool = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('DELETE')) return [{}];
      return [[]];
    },
  };

  const result = await purge.purge({ dryRun: false, dbPool: pool });
  assert.deepEqual(result.deleted, { leads: 0, events: 0 });
  assert.deepEqual(result.after, { leads: 0, events: 0 });
});

test('database errors propagate so the CLI can exit 1', async () => {
  const pool = {
    async query() {
      throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
    },
  };

  await assert.rejects(
    purge.purge({ dryRun: true, dbPool: pool }),
    (error) => error.code === 'ECONNRESET'
  );
});
