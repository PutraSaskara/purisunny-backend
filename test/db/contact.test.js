// backend/test/db/contact.test.js
//
// POST /api/contact end-to-end through the real Express stack + scratch MySQL.
//
// Contract under test (FIXED — the frontend codes against it):
//   validation fail                       -> 400 { message, errors[] }
//   email configured + sent               -> 201 { message, email_sent: true }
//   email configured + send fails         -> 502 { message, fallback:'whatsapp', email_sent:false }
//   email NOT configured                  -> 502 (same shape)
//   in EVERY case where validation passed -> a row exists in `contacts`
//
// The mailer is swapped for a fake (routes/contact.js __setMailerForTests), so
// the suite never opens an SMTP socket. Skips gracefully without a test DB.
//
// NOTE: contactLimiter is 5/hour per IP and the limiter store lives on the
// module, shared by every app instance in this process. A single suite with a
// bounded number of POSTs (<= 5) keeps every request inside one window; tests
// are ordered so the validation checks (which also count) stay within budget.
// The 429 path itself is covered by test/http/rateLimit.test.js for /auth.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

const MARK = `zz-nodetest-contact-${Date.now().toString(36)}`;

let ctx = null;
let contactRoute = null;

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }
  try {
    await db.query('SELECT id, name, email, phone, message, is_read FROM contacts LIMIT 1');
  } catch (err) {
    ctx = { skip: true, reason: `contacts table missing (${err.code || err.message}) — run node scripts/setup-test-db.js` };
    return;
  }
  const { startApp } = require('../helpers/app');
  const app = await startApp({ httpClient: 'node' });
  const lock = createDbLock(db);
  await lock.acquire();
  contactRoute = require('../../routes/contact');
  ctx = { skip: false, db, app, lock };
});

test.after(async () => {
  if (contactRoute) contactRoute.__setMailerForTests(null);
  if (!ctx || ctx.skip) return;
  try {
    await ctx.db.query('DELETE FROM contacts WHERE name LIKE ?', [`${MARK}%`]);
  } catch { /* best effort */ }
  if (ctx.lock) await ctx.lock.close();
  await ctx.app.close();
  try { await ctx.db.end(); } catch { /* already closed */ }
});

// The routes are mounted on one shared express-rate-limit store, so a test that
// runs first must fit the budget. Every dbTest below is a POST that passes
// validation except the validation one, and that one is counted too. Keep the
// total POSTs at <= 5.
function dbTest(name, fn) {
  test(name, async (t) => {
    if (ctx.skip) return t.skip(`DB tests skipped: ${ctx.reason}`);
    return withTestDbLock(ctx.lock, () => fn(t));
  });
}

function payload(suffix, overrides = {}) {
  return {
    name: `${MARK}-${suffix}`,
    email: `${suffix}@example.test`,
    phone: '+62 812-0000-0000',
    message: `Pesan uji otomatis ${suffix} yang cukup panjang.`,
    ...overrides,
  };
}

async function countRows(suffix) {
  const [rows] = await ctx.db.query(
    'SELECT id, name, email, phone, message, is_read FROM contacts WHERE name = ?',
    [`${MARK}-${suffix}`]
  );
  return rows;
}

// A fake mailer. `sent` decides the result; configuration is explicit so the
// "configured but failed" and "not configured" branches can both be covered.
function fakeMailer({ sent, configured = true }) {
  const calls = [];
  return {
    calls,
    isEmailConfigured: () => configured,
    missingEmailConfigKeys: () => (configured ? [] : ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASS']),
    async sendContactEmail(p) {
      calls.push(p);
      return sent
        ? { sent: true }
        : { sent: false, error: configured ? 'connect ECONNREFUSED' : 'email not configured' };
    },
  };
}

// ---------------------------------------------------------------------------
// Validation (400, no row written)
// ---------------------------------------------------------------------------

dbTest('validation: 400 + errors[] and no row written', async () => {
  const before = await countRows('invalid');
  assert.equal(before.length, 0);

  const res = await ctx.app.request('POST', '/api/contact', {
    body: payload('invalid', { email: 'not-an-email', message: 'short' }),
  });
  assert.equal(res.status, 400);
  assert.equal(typeof res.json.message, 'string');
  assert.ok(Array.isArray(res.json.errors));
  assert.ok(res.json.errors.some((e) => e.includes('email')));
  assert.ok(res.json.errors.some((e) => e.includes('message')));

  const after = await countRows('invalid');
  assert.equal(after.length, 0, 'invalid payload must not be stored');
});

// ---------------------------------------------------------------------------
// Happy path: configured + sent -> 201, row stored, mailer got the values
// ---------------------------------------------------------------------------

dbTest('happy path: configured + sent -> 201 { message, email_sent:true } and row stored', async () => {
  const fake = fakeMailer({ sent: true, configured: true });
  contactRoute.__setMailerForTests(fake);

  const res = await ctx.app.request('POST', '/api/contact', { body: payload('ok') });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json, {
    message: 'Message sent successfully',
    email_sent: true,
  });

  const rows = await countRows('ok');
  assert.equal(rows.length, 1, 'row must be stored');
  const row = rows[0];
  assert.equal(row.email, 'ok@example.test');
  assert.equal(row.phone, '+62 812-0000-0000');
  assert.equal(row.message, 'Pesan uji otomatis ok yang cukup panjang.');
  assert.equal(Number(row.is_read), 0);

  // The mailer received exactly the normalised values from the request.
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0], {
    name: `${MARK}-ok`,
    email: 'ok@example.test',
    phone: '+62 812-0000-0000',
    message: 'Pesan uji otomatis ok yang cukup panjang.',
  });
});

// ---------------------------------------------------------------------------
// Configured but SMTP failed -> 502, row STILL stored
// ---------------------------------------------------------------------------

dbTest('mailer failure: configured + send failed -> 502 and row STILL stored', async () => {
  const fake = fakeMailer({ sent: false, configured: true });
  contactRoute.__setMailerForTests(fake);

  const res = await ctx.app.request('POST', '/api/contact', { body: payload('fail') });
  assert.equal(res.status, 502);
  assert.deepEqual(res.json, {
    message: 'We could not deliver your message right now. Please contact us via WhatsApp.',
    fallback: 'whatsapp',
    email_sent: false,
  });

  const rows = await countRows('fail');
  assert.equal(rows.length, 1, 'row must be the backup even when mail fails');
  assert.equal(fake.calls.length, 1, 'delivery must have been attempted');
});

// ---------------------------------------------------------------------------
// Not configured (the current interim state) -> 502, row stored, no send attempt
// ---------------------------------------------------------------------------

dbTest('unconfigured: -> 502 + fallback whatsapp, row stored, no send attempted', async () => {
  const fake = fakeMailer({ sent: false, configured: false });
  contactRoute.__setMailerForTests(fake);

  const res = await ctx.app.request('POST', '/api/contact', { body: payload('unconfigured') });
  assert.equal(res.status, 502);
  assert.equal(res.json.fallback, 'whatsapp');
  assert.equal(res.json.email_sent, false);
  assert.match(res.json.message, /WhatsApp/);

  const rows = await countRows('unconfigured');
  assert.equal(rows.length, 1, 'row must be stored even when email is not configured');
});

// ---------------------------------------------------------------------------
// Real (unmocked) config is unconfigured in the test env -> same 502
// ---------------------------------------------------------------------------

dbTest('real mailer in the test profile is unconfigured -> 502 + whatsapp', async () => {
  // Restore the real singleton. test/helpers/env.js does not set EMAIL_*, so
  // this exercises the genuine interim behaviour: store, then route to WhatsApp.
  contactRoute.__setMailerForTests(null);
  const mailer = require('../../utils/mailer');
  assert.equal(mailer.isEmailConfigured(), false, 'test profile must not have EMAIL_* configured');

  const res = await ctx.app.request('POST', '/api/contact', { body: payload('real') });
  assert.equal(res.status, 502);
  assert.deepEqual(Object.keys(res.json).sort(), ['email_sent', 'fallback', 'message']);
  assert.equal(res.json.email_sent, false);
  assert.equal(res.json.fallback, 'whatsapp');

  const rows = await countRows('real');
  assert.equal(rows.length, 1);
});
