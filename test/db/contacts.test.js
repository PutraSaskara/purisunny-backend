// backend/test/db/contacts.test.js
//
// GET /api/contacts end-to-end through the real Express stack + scratch MySQL.
//
// Contract under test:
//   200 { contacts: [...], total, unread }   admin only
//   contacts rows: { id, name, email, phone, message, is_read, created_at }
//   ORDER BY created_at DESC, id DESC        (newest first, id breaks ties)
//   ?limit=<int>                             clamp 1..100, default all
//   total / unread                           whole-table counts, limit-free
//
// Skips gracefully without a test DB. Fixtures are inserted directly (not via
// POST /api/contact) so the suite does not consume the public rate limiter and
// can control created_at ordering.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

const MARK = `zz-nodetest-contacts-${Date.now().toString(36)}`;

let ctx = null;

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }
  try {
    await db.query('SELECT id, name, email, phone, message, is_read, created_at FROM contacts LIMIT 1');
  } catch (err) {
    ctx = { skip: true, reason: `contacts table missing (${err.code || err.message}) — run node scripts/setup-test-db.js` };
    return;
  }
  const { startApp } = require('../helpers/app');
  // node:http, not fetch: same Windows undici hazard documented in
  // test/db/contact.test.js (the contact router carries a rate limiter).
  const app = await startApp({ httpClient: 'node' });
  const lock = createDbLock(db);
  await lock.acquire();
  ctx = { skip: false, db, app, lock };
});

test.after(async () => {
  if (!ctx || ctx.skip) return;
  try {
    await ctx.db.query('DELETE FROM contacts WHERE name LIKE ?', [`${MARK}%`]);
  } catch { /* best effort */ }
  if (ctx.lock) await ctx.lock.close();
  await ctx.app.close();
  try { await ctx.db.end(); } catch { /* already closed */ }
});

function dbTest(name, fn) {
  test(name, async (t) => {
    if (ctx.skip) return t.skip(`DB tests skipped: ${ctx.reason}`);
    return withTestDbLock(ctx.lock, () => fn(t));
  });
}

function contactRow(suffix, { isRead = 0, createdAt } = {}) {
  return {
    name: `${MARK}-${suffix}`,
    email: `${suffix}@example.test`,
    phone: '+62 812-0000-0000',
    message: `Pesan uji otomatis ${suffix} yang cukup panjang.`,
    isRead,
    createdAt: createdAt || '2026-01-01 00:00:00',
  };
}

async function insertContacts(rows) {
  for (const row of rows) {
    await ctx.db.query(
      'INSERT INTO contacts (name, email, phone, message, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [row.name, row.email, row.phone, row.message, row.isRead, row.createdAt]
    );
  }
}

// Rows from OUR fixture only, newest first. The endpoint returns the whole
// table, so assertions filter on the MARK prefix.
function ours(contacts) {
  return contacts.filter((c) => String(c.name).startsWith(MARK));
}

// tableCounts mirrors the endpoint's own counts query so the test can compare
// against the real state of the shared table (other suites may add rows).
async function tableCounts() {
  const [rows] = await ctx.db.query(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread FROM contacts'
  );
  return { total: Number(rows[0].total) || 0, unread: Number(rows[0].unread) || 0 };
}

const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

dbTest('contacts: 200 shape + totals + DESC order + limit semantics', async () => {
  // TIMESTAMP tops out at 2038 (MariaDB clamps past it), so keep the fixture in
  // range but late enough to sit above leftover rows from other suites.
  const rows = [
    // Same created_at for a pair: the id DESC tiebreak must decide the order.
    contactRow('a-oldest', { isRead: 1, createdAt: '2037-01-01 00:00:00' }),
    contactRow('b-same', { isRead: 0, createdAt: '2037-02-02 10:00:00' }),
    contactRow('c-same', { isRead: 1, createdAt: '2037-02-02 10:00:00' }),
    contactRow('d-newest', { isRead: 0, createdAt: '2037-03-03 12:00:00' }),
  ];
  await insertContacts(rows);

  const [stored] = await ctx.db.query(
    'SELECT id, name, is_read FROM contacts WHERE name LIKE ? ORDER BY id ASC',
    [`${MARK}%`]
  );
  const idOf = new Map(stored.map((r) => [r.name, r.id]));

  const res = await ctx.app.request('GET', '/api/contacts', { token: ctx.app.adminToken });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.json)}`);

  // Envelope shape.
  assert.deepEqual(Object.keys(res.json).sort(), ['contacts', 'total', 'unread']);
  assert.ok(Array.isArray(res.json.contacts));
  assert.equal(typeof res.json.total, 'number');
  assert.equal(typeof res.json.unread, 'number');

  // Row shape (fixture rows only: the shared scratch table may hold leftovers
  // from other suites, e.g. rows with a NULL created_at).
  for (const contact of ours(res.json.contacts)) {
    assert.deepEqual(
      Object.keys(contact).sort(),
      ['created_at', 'email', 'id', 'is_read', 'message', 'name', 'phone']
    );
    assert.match(String(contact.created_at), ISO_TS);
  }

  // Totals cover the whole table, not the page.
  const expected = await tableCounts();
  assert.equal(res.json.total, expected.total);
  assert.equal(res.json.unread, expected.unread);

  // Fixture rows appear in DESC (created_at, id) order.
  const fixture = ours(res.json.contacts);
  assert.deepEqual(
    fixture.map((c) => c.name),
    [
      `${MARK}-d-newest`,
      `${MARK}-c-same`,
      `${MARK}-b-same`,
      `${MARK}-a-oldest`,
    ]
  );
  // id breaks created_at ties: c-same was inserted after b-same and must win.
  assert.ok(
    fixture.find((c) => c.name === `${MARK}-c-same`).id >
      fixture.find((c) => c.name === `${MARK}-b-same`).id
  );
  // Newest fixture row leads the whole list.
  assert.equal(res.json.contacts[0].name, `${MARK}-d-newest`);

  // ?limit=2 -> exactly 2 rows, fixture newest first; totals unchanged.
  const limited = await ctx.app.request('GET', '/api/contacts?limit=2', { token: ctx.app.adminToken });
  assert.equal(limited.status, 200);
  assert.equal(limited.json.contacts.length, 2);
  assert.deepEqual(
    ours(limited.json.contacts).map((c) => c.name),
    [`${MARK}-d-newest`, `${MARK}-c-same`]
  );
  assert.equal(limited.json.total, expected.total);
  assert.equal(limited.json.unread, expected.unread);

  // Clamp low: ?limit=0 -> 1 row. Clamp high: ?limit=1000 -> at most 100.
  const clampedLow = await ctx.app.request('GET', '/api/contacts?limit=0', { token: ctx.app.adminToken });
  assert.equal(clampedLow.status, 200);
  assert.equal(clampedLow.json.contacts.length, 1);

  const clampedHigh = await ctx.app.request('GET', '/api/contacts?limit=1000', { token: ctx.app.adminToken });
  assert.equal(clampedHigh.status, 200);
  assert.equal(clampedHigh.json.contacts.length, Math.min(100, expected.total));

  // No ?limit -> every row, same count as total.
  assert.equal(res.json.contacts.length, expected.total);

  // is_read comes back as 0/1 numbers (tinyint), matching the schema.
  const newest = fixture.find((c) => c.id === idOf.get(`${MARK}-d-newest`));
  assert.equal(Number(newest.is_read), 0);
  const oldest = fixture.find((c) => c.id === idOf.get(`${MARK}-a-oldest`));
  assert.equal(Number(oldest.is_read), 1);
});
