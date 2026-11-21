// backend/test/http/booking.test.js
//
// Booking routes without MySQL:
//   - public POST /api/booking/leads validates before any DB access
//   - a failed email is still 201 (email_status failed, email_sent false)
//   - POST /api/booking/events always answers 204 (invalid input is dropped)
//   - rate limits: leads 5/hour, events 30/minute
//   - auth/role guards: editor may PATCH status but not DELETE
//
// node:http, not fetch: the booking router carries rate limiters and Windows
// undici keep-alive handles race the test runner's exit (same reason as
// test/http/contacts.test.js).
//
// The limiter stores live on the modules, so request counts are budgeted
// explicitly below. Keep the events and leads tests last.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { startApp } = require('../helpers/app');

let app;
let bookingRoute;

test.before(async () => {
  bookingRoute = require('../../routes/booking');
  app = await startApp({ httpClient: 'node' });
});

test.after(async () => {
  if (bookingRoute) {
    bookingRoute.__setDbForTests(null);
    bookingRoute.__setMailerForTests(null);
  }
  if (app) await app.close();
});

const VALID_BODY = {
  name: 'Wayan Test',
  email: 'wayan@example.com',
  phone: '+62 812-3456-7890',
  check_in: '2099-01-01',
  check_out: '2099-01-04',
  guests: 2,
  room_slug: 'deluxe-room',
  message: 'Halo, saya ingin bertanya tentang kamar.',
  source_page: '/stay/deluxe-room',
  client_ref: 'booking-ref-0001',
  channel: 'whatsapp',
};

function sqlText(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function leadRow(overrides = {}) {
  return {
    id: 41,
    name: 'Wayan Test',
    email: 'wayan@example.com',
    phone: '+62 812-3456-7890',
    check_in: '2099-01-01',
    check_out: '2099-01-04',
    guests: 2,
    room_slug: 'deluxe-room',
    message: 'Halo, saya ingin bertanya tentang kamar.',
    first_message: 'Hello Puri Sunny, I would like to book deluxe-room from 2099-01-01 to 2099-01-04 for 2 guest(s).\nHalo, saya ingin bertanya tentang kamar.',
    channel: 'email',
    status: 'new',
    source_page: '/stay/deluxe-room',
    client_ref: 'booking-ref-0001',
    email_status: 'failed',
    email_sent_at: null,
    email_attempts: 1,
    email_last_attempt_at: '2099-01-01 09:00:00',
    email_error_code: 'EAUTH',
    email_error: 'Email delivery failed',
    created_at: '2099-01-01 09:00:00',
    updated_at: '2099-01-01 09:00:00',
    ...overrides,
  };
}

// Small scripted DB: the create-email path is INSERT, claim, SELECT, fail,
// SELECT. Every call must match so the test fails if the flow changes.
function scriptedDb(steps) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async query(sql, params) {
      const text = sqlText(sql);
      calls.push({ text, params });
      const step = steps[index];
      if (!step) throw new Error(`unexpected query #${index + 1}: ${text}`);
      if (!step.match.test(text)) {
        throw new Error(`query #${index + 1} did not match ${step.match}: ${text}`);
      }
      index += 1;
      if (step.error) throw step.error;
      return step.result;
    },
  };
}

// ---------------------------------------------------------------------------
// Public lead form (1 POST)
// ---------------------------------------------------------------------------

test('public POST /leads: validation -> 400 + errors[] before any DB access', async () => {
  const res = await app.request('POST', '/api/booking/leads', {
    body: {
      name: '',
      channel: 'email',
      email: 'not-an-email',
      check_in: '',
      check_out: '',
      guests: 0,
      message: '',
    },
  });

  assert.equal(res.status, 400);
  assert.equal(typeof res.json.message, 'string');
  assert.ok(Array.isArray(res.json.errors));
  assert.ok(res.json.errors.includes('name is required'));
  assert.ok(res.json.errors.includes('email must be a valid email address'));
});

// ---------------------------------------------------------------------------
// Email failure is still 201 (2nd POST)
// ---------------------------------------------------------------------------

test('POST /leads: email failure -> 201 with failed status and a working wa_url', async () => {
  const db = scriptedDb([
    { match: /^INSERT INTO booking_leads/, result: [{ insertId: 41 }] },
    { match: /^UPDATE booking_leads SET email_status = 'sending'/, result: [{ affectedRows: 1 }] },
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[leadRow({ email_status: 'sending' })]] },
    { match: /^UPDATE booking_leads SET email_status = 'failed'/, result: [{ affectedRows: 1 }] },
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[leadRow()]] },
  ]);
  bookingRoute.__setDbForTests(db);
  bookingRoute.__setMailerForTests({ async sendBookingEmail() { return { sent: false, errorCode: 'EAUTH' }; } });

  try {
    const res = await app.request('POST', '/api/booking/leads', {
      body: { ...VALID_BODY, channel: 'email' },
    });

    assert.equal(res.status, 201);
    assert.equal(res.json.email_status, 'failed');
    assert.equal(res.json.email_sent, false);
    assert.equal(res.json.lead.email_error_code, 'EAUTH');
    assert.equal(res.json.first_message, res.json.lead.first_message);
    assert.equal(
      res.json.wa_url,
      `https://wa.me/6285737216669?text=${encodeURIComponent(res.json.first_message)}`
    );
    assert.ok(!res.text.includes('502'), 'never answers 502');
  } finally {
    bookingRoute.__setDbForTests(null);
    bookingRoute.__setMailerForTests(null);
  }
});

// ---------------------------------------------------------------------------
// Question channel (3rd POST)
// ---------------------------------------------------------------------------

test('POST /leads: channel question -> 201 with wa_url and no email attempt', async () => {
  const firstMessage = 'Hello Puri Sunny, I have a question from the Contact page.\nApakah ada sarapan?';
  const db = scriptedDb([
    { match: /^INSERT INTO booking_leads/, result: [{ insertId: 42 }] },
    {
      match: /^SELECT .* WHERE id = \? LIMIT 1$/,
      result: [[leadRow({
        id: 42,
        channel: 'question',
        email: null,
        check_in: null,
        check_out: null,
        guests: 1,
        email_status: 'not_required',
        email_error_code: null,
        email_error: null,
        first_message: firstMessage,
      })]],
    },
  ]);
  bookingRoute.__setDbForTests(db);

  try {
    const res = await app.request('POST', '/api/booking/leads', {
      body: {
        name: 'Wayan Test',
        channel: 'question',
        phone: '+62 812-3456-7890',
        message: 'Apakah ada sarapan?',
        source_page: '/contact',
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.json.lead.channel, 'question');
    assert.equal(res.json.email_status, 'not_required');
    assert.equal(res.json.email_sent, false);
    assert.equal(res.json.first_message, firstMessage);
    assert.equal(
      res.json.wa_url,
      `https://wa.me/6285737216669?text=${encodeURIComponent(firstMessage)}`
    );
    assert.equal(db.calls.length, 2, 'INSERT + read-back only; no email claim');
  } finally {
    bookingRoute.__setDbForTests(null);
  }
});

// ---------------------------------------------------------------------------
// Tracking (3 events calls)
// ---------------------------------------------------------------------------

test('public POST /events: invalid tracking input still returns 204', async () => {
  const res = await app.request('POST', '/api/booking/events', {
    body: { event: 'not-a-real-event', ip: '1.2.3.4' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.text, '');
});

test('public POST /events: object or array accepted, always 204', async () => {
  const single = await app.request('POST', '/api/booking/events', {
    body: { event: 'wa_click', source_page: '/stay', session_id: 'sess-1' },
  });
  assert.equal(single.status, 204);

  const batch = await app.request('POST', '/api/booking/events', {
    body: [{ event: 'form_open', source_page: '/stay' }, { event: 'bogus' }],
  });
  assert.equal(batch.status, 204);
});

// ---------------------------------------------------------------------------
// Auth / role guards
// ---------------------------------------------------------------------------

test('booking: anonymous GET /leads -> 401', async () => {
  const res = await app.request('GET', '/api/booking/leads');
  assert.equal(res.status, 401);
  assert.equal(typeof res.json.message, 'string');
});

test('booking: editor may GET /leads (guard admits both staff roles)', async () => {
  const res = await app.request('GET', '/api/booking/leads', { token: app.editorToken });
  assert.ok(![401, 403].includes(res.status), `status=${res.status}`);
});

test('booking: stats is admin only; editor -> 403 and admin passes the guard', async () => {
  const editor = await app.request('GET', '/api/booking/stats', { token: app.editorToken });
  assert.equal(editor.status, 403);
  assert.deepEqual(editor.json.required_roles, ['admin']);

  const admin = await app.request('GET', '/api/booking/stats', { token: app.adminToken });
  assert.ok(![401, 403].includes(admin.status), `status=${admin.status}`);
});

test('booking: editor DELETE /leads/:id -> 403 admin only', async () => {
  const res = await app.request('DELETE', '/api/booking/leads/1', { token: app.editorToken });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json.required_roles, ['admin']);
});

test('booking: admin passes the DELETE guard, then the numeric id check answers 400', async () => {
  const res = await app.request('DELETE', '/api/booking/leads/abc', { token: app.adminToken });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /positive integer/);
});

test('booking: editor may PATCH; invalid id and invalid status both answer 400', async () => {
  const badId = await app.request('PATCH', '/api/booking/leads/abc', {
    token: app.editorToken,
    body: { status: 'contacted' },
  });
  assert.equal(badId.status, 400);
  assert.match(badId.json.message, /positive integer/);

  // Reaches the service, which validates before any DB access — proving the
  // editor role is admitted to PATCH.
  const badStatus = await app.request('PATCH', '/api/booking/leads/1', {
    token: app.editorToken,
    body: { status: 'archived' },
  });
  assert.equal(badStatus.status, 400);
  assert.ok(Array.isArray(badStatus.json.errors));
  assert.match(badStatus.json.message, /status must be one of/);
});

test('booking: editor may reach resend; invalid id answers 400', async () => {
  const res = await app.request('POST', '/api/booking/leads/abc/resend-email', {
    token: app.editorToken,
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /positive integer/);
});

test('booking: GET /leads/:id is staff-only', async () => {
  const res = await app.request('GET', '/api/booking/leads/1');
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Rate limits (must stay last: the counters are process-wide)
// ---------------------------------------------------------------------------

test('public POST /events rate limit: 30/min/IP then 429', async () => {
  // Three events calls already ran above (one invalid, one single, one batch);
  // make 27 more to fill the 30-request window. Invalid bodies short-circuit
  // before the DB.
  for (let i = 0; i < 27; i += 1) {
    const res = await app.request('POST', '/api/booking/events', { body: {} });
    assert.equal(res.status, 204, `event ${i + 4} must still be accepted`);
  }

  const limited = await app.request('POST', '/api/booking/events', { body: {} });
  assert.equal(limited.status, 429);
  assert.equal(typeof limited.json.message, 'string');
});

test('public POST /leads rate limit: 5/hour/IP then 429', async () => {
  // Validation, email-failure and question tests above already consumed three
  // slots. Two more reach validation; the sixth request is limited.
  for (let i = 0; i < 2; i += 1) {
    const res = await app.request('POST', '/api/booking/leads', { body: { name: '' } });
    assert.equal(res.status, 400, `lead ${i + 4} must still reach validation`);
  }

  const limited = await app.request('POST', '/api/booking/leads', { body: { name: '' } });
  assert.equal(limited.status, 429);
  assert.equal(typeof limited.json.message, 'string');
});
