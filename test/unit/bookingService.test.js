// backend/test/unit/bookingService.test.js
//
// Booking service: server-built first message, duplicate client_ref handling,
// the atomic email state machine, sanitized error codes, list filters,
// tracking events and stats. No MySQL and no SMTP: a scripted DB and a fake
// mailer are injected through the documented test seams.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const booking = require('../../services/booking');

const TODAY = '2099-01-01';

function sqlText(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

// Steps are consumed in order; each must match, so a changed query sequence
// fails loudly instead of silently returning the wrong row.
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

function leadRow(overrides = {}) {
  return {
    id: 1,
    name: 'Wayan Test',
    email: 'wayan@example.com',
    phone: '+62 812-3456-7890',
    check_in: TODAY,
    check_out: '2099-01-04',
    guests: 2,
    room_slug: 'deluxe-room',
    message: 'Halo, saya ingin bertanya tentang kamar.',
    first_message: 'built elsewhere',
    channel: 'whatsapp',
    status: 'new',
    source_page: '/stay/deluxe-room',
    client_ref: 'booking-ref-0001',
    email_status: 'not_required',
    email_sent_at: null,
    email_attempts: 0,
    email_last_attempt_at: null,
    email_error_code: null,
    email_error: null,
    created_at: '2099-01-01 08:00:00',
    updated_at: '2099-01-01 08:00:00',
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  return {
    name: 'Wayan Test',
    email: 'wayan@example.com',
    phone: '+62 812-3456-7890',
    check_in: TODAY,
    check_out: '2099-01-04',
    guests: 2,
    room_slug: 'deluxe-room',
    message: 'Halo, saya ingin bertanya tentang kamar.',
    source_page: '/stay/deluxe-room',
    client_ref: 'booking-ref-0001',
    channel: 'whatsapp',
    ...overrides,
  };
}

function fakeMailer(result) {
  const calls = [];
  return {
    calls,
    async sendBookingEmail(lead) {
      calls.push(lead);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const EXPECTED_FIRST_MESSAGE =
  'Hello Puri Sunny, I would like to book Deluxe Room from 2099-01-01 to 2099-01-04 ' +
  'for 2 guest(s).\nHalo, saya ingin bertanya tentang kamar.';

test.afterEach(() => {
  booking.__setDbForTests(null);
  booking.__setMailerForTests(null);
});

// ---------------------------------------------------------------------------
// createLead
// ---------------------------------------------------------------------------

test('createLead (WhatsApp): server builds first_message and sends no email', async () => {
  const db = scriptedDb([
    { match: /^INSERT INTO booking_leads/, result: [{ insertId: 11 }] },
    {
      match: /^SELECT .* FROM booking_leads WHERE id = \? LIMIT 1$/,
      result: [[leadRow({ id: 11, first_message: EXPECTED_FIRST_MESSAGE })]],
    },
  ]);
  const mailer = fakeMailer({ sent: true });
  booking.__setDbForTests(db);
  booking.__setMailerForTests(mailer);

  const result = await booking.createLead(validPayload());

  assert.equal(result.emailSent, false);
  assert.equal(result.lead.id, 11);
  assert.equal(mailer.calls.length, 0, 'WhatsApp leads must not send email');

  const insert = db.calls[0];
  assert.match(insert.text, /^INSERT INTO booking_leads/);
  const params = insert.params;
  assert.equal(params[0], 'Wayan Test');
  assert.equal(params[1], 'wayan@example.com');
  assert.equal(params[2], '+62 812-3456-7890');
  assert.equal(params[3], TODAY);
  assert.equal(params[4], '2099-01-04');
  assert.equal(params[5], 2);
  assert.equal(params[6], 'deluxe-room');
  assert.equal(params[7], 'Halo, saya ingin bertanya tentang kamar.');
  assert.equal(params[8], EXPECTED_FIRST_MESSAGE);
  assert.equal(params[9], 'whatsapp');
  assert.equal(params[10], '/stay/deluxe-room');
  assert.equal(params[11], 'booking-ref-0001');
  assert.equal(params[12], 'not_required');
});

test('buildFirstMessage maps every real room slug to its display label', () => {
  const base = {
    check_in: TODAY,
    check_out: '2099-01-04',
    guests: 2,
    message: 'Halo, saya ingin bertanya tentang kamar.',
  };
  const rooms = {
    'deluxe-room': 'Deluxe Room',
    'superior-room': 'Superior Room',
    'standard-double': 'Standard Double',
    'standard-twin': 'Standard Twin',
    'standard-camp': 'Standard Camp',
    'family-camp': 'Family Camp',
  };

  for (const [slug, label] of Object.entries(rooms)) {
    assert.equal(
      booking.buildFirstMessage({ ...base, room_slug: slug }),
      `Hello Puri Sunny, I would like to book ${label} from 2099-01-01 to 2099-01-04 ` +
        'for 2 guest(s).\nHalo, saya ingin bertanya tentang kamar.',
      slug
    );
  }
});

test('buildFirstMessage title-cases unknown room slugs', () => {
  const base = {
    check_in: TODAY,
    check_out: '2099-01-04',
    guests: 2,
    message: 'Halo, saya ingin bertanya tentang kamar.',
  };

  assert.match(booking.buildFirstMessage({ ...base, room_slug: 'garden-suite' }), /book Garden Suite from/);
  assert.match(booking.buildFirstMessage({ ...base, room_slug: 'family-suite-room' }), /book Family Suite Room from/);
});

test('buildFirstMessage uses "a stay" for no room or an unusable slug', () => {
  const base = {
    check_in: TODAY,
    check_out: '2099-01-04',
    guests: 2,
    message: 'Halo, saya ingin bertanya tentang kamar.',
  };

  for (const room_slug of [undefined, null, '', '   ', '---']) {
    assert.match(
      booking.buildFirstMessage({ ...base, room_slug }),
      /I would like to book a stay from 2099-01-01 to 2099-01-04/,
      String(room_slug)
    );
  }
});

test('buildFirstMessage for question uses readable labels for known source pages', () => {
  const base = {
    channel: 'question',
    email: 'wayan@example.com',
    phone: '+62 812-3456-7890',
    message: 'Apakah ada sarapan?',
  };
  const known = {
    '/': 'Home',
    '/our-story': 'Our Story',
    '/stay': 'Stay',
    '/stay/rooms/deluxe-room': 'Deluxe Room',
    '/contact': 'Contact',
  };

  for (const [sourcePage, label] of Object.entries(known)) {
    const message = booking.buildFirstMessage({ ...base, source_page: sourcePage });
    assert.equal(
      message,
      `Hello Puri Sunny, I have a question from the ${label} page.\nApakah ada sarapan?`,
      sourcePage
    );
    assert.ok(!message.includes('wayan@example.com'), 'email must not leak into the WhatsApp text');
    assert.ok(!message.includes('+62 812-3456-7890'), 'phone must not leak into the WhatsApp text');
  }
});

test('buildFirstMessage for question title-cases unknown source paths', () => {
  const base = { channel: 'question', message: 'Apakah ada sarapan?' };

  assert.equal(
    booking.buildFirstMessage({ ...base, source_page: '/local-tips' }),
    'Hello Puri Sunny, I have a question from the Local Tips page.\nApakah ada sarapan?'
  );
  assert.equal(
    booking.buildFirstMessage({ ...base, source_page: '/local_tips' }),
    'Hello Puri Sunny, I have a question from the Local Tips page.\nApakah ada sarapan?'
  );
});

test('buildFirstMessage for question omits the page phrase without a source page', () => {
  const base = { channel: 'question', message: 'Apakah ada sarapan?' };
  assert.equal(
    booking.buildFirstMessage({ ...base, source_page: null }),
    'Hello Puri Sunny, I have a question.\nApakah ada sarapan?'
  );
  assert.equal(
    booking.buildFirstMessage({ ...base }),
    'Hello Puri Sunny, I have a question.\nApakah ada sarapan?'
  );
});

test('createLead uses "a stay" when room_slug is absent', async () => {
  const db = scriptedDb([
    { match: /^INSERT INTO booking_leads/, result: [{ insertId: 12 }] },
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[leadRow({ id: 12 })]] },
  ]);
  booking.__setDbForTests(db);
  booking.__setMailerForTests(fakeMailer({ sent: true }));

  await booking.createLead(validPayload({ room_slug: null }));
  const firstMessage = db.calls[0].params[8];
  assert.match(firstMessage, /I would like to book a stay from 2099-01-01 to 2099-01-04/);
});

test('createLead (question): stores a date-less lead, email_status not_required, no mailer call', async () => {
  const firstMessage = 'Hello Puri Sunny, I have a question from the Contact page.\nApakah ada sarapan?';
  const db = scriptedDb([
    { match: /^INSERT INTO booking_leads/, result: [{ insertId: 13 }] },
    {
      match: /^SELECT .* WHERE id = \? LIMIT 1$/,
      result: [[leadRow({
        id: 13,
        channel: 'question',
        check_in: null,
        check_out: null,
        guests: 1,
        email: null,
        email_status: 'not_required',
        first_message: firstMessage,
      })]],
    },
  ]);
  const mailer = fakeMailer({ sent: true });
  booking.__setDbForTests(db);
  booking.__setMailerForTests(mailer);

  const result = await booking.createLead({
    name: 'Wayan Test',
    channel: 'question',
    phone: '+62 812-3456-7890',
    message: 'Apakah ada sarapan?',
    source_page: '/contact',
  });

  assert.equal(result.emailSent, false);
  assert.equal(result.lead.email_status, 'not_required');
  assert.equal(result.lead.first_message, firstMessage);
  assert.equal(mailer.calls.length, 0, 'question leads must not send email');

  const insert = db.calls[0];
  assert.equal(insert.params[1], null, 'email is optional');
  assert.equal(insert.params[2], '+62 812-3456-7890');
  assert.equal(insert.params[3], null, 'check_in is null');
  assert.equal(insert.params[4], null, 'check_out is null');
  assert.equal(insert.params[5], 1, 'guests defaults to 1');
  assert.equal(insert.params[8], firstMessage);
  assert.equal(insert.params[9], 'question');
  assert.equal(insert.params[12], 'not_required');
  assert.equal(db.calls.length, 2, 'INSERT + read-back only; no email claim/update');
  assert.equal(db.calls.some((call) => call.text.startsWith('UPDATE')), false);
});

test('createLead rejects validation errors before touching the DB', async () => {
  const db = scriptedDb([]);
  booking.__setDbForTests(db);

  await assert.rejects(
    booking.createLead(validPayload({ name: '', channel: 'email', email: '' })),
    (error) => error.status === 400
      && error.body.message === 'name is required'
      && Array.isArray(error.body.errors)
      && error.body.errors.includes('email is required for the email channel')
  );
  assert.equal(db.calls.length, 0);
});

test('createLead duplicate client_ref returns the existing lead and sends nothing', async () => {
  const duplicate = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
  const existing = leadRow({ id: 9, email_status: 'sent', channel: 'email' });
  const db = scriptedDb([
    { match: /^INSERT INTO booking_leads/, error: duplicate },
    {
      match: /^SELECT .* FROM booking_leads WHERE client_ref = \? LIMIT 1$/,
      result: [[existing]],
    },
  ]);
  const mailer = fakeMailer({ sent: true });
  booking.__setDbForTests(db);
  booking.__setMailerForTests(mailer);

  const result = await booking.createLead(validPayload({ channel: 'email' }));
  assert.equal(result.lead.id, 9);
  assert.equal(result.emailSent, false);
  assert.equal(mailer.calls.length, 0, 'a duplicate submission must not resend');
  assert.equal(db.calls.length, 2);
  assert.deepEqual(db.calls[1].params, ['booking-ref-0001']);
});

// ---------------------------------------------------------------------------
// Email state machine
// ---------------------------------------------------------------------------

function emailCreateSteps(insertId, sendingRow, finalRow, failure = false, resultRow) {
  const steps = [
    { match: /^INSERT INTO booking_leads/, result: [{ insertId }] },
    { match: /^UPDATE booking_leads SET email_status = 'sending'/, result: [{ affectedRows: 1 }] },
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[sendingRow]] },
  ];
  if (failure) {
    steps.push({ match: /^UPDATE booking_leads SET email_status = 'failed'/, result: [{ affectedRows: 1 }] });
  } else {
    steps.push({ match: /^UPDATE booking_leads SET email_status = 'sent'/, result: [{ affectedRows: 1 }] });
  }
  steps.push({ match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[resultRow || finalRow]] });
  return steps;
}

test('createLead (email) claims atomically, sends, and stores sent', async () => {
  const sending = leadRow({ id: 21, channel: 'email', email_status: 'sending', email_attempts: 1 });
  const sent = leadRow({
    id: 21, channel: 'email', email_status: 'sent', email_attempts: 1,
    email_sent_at: '2099-01-01 09:00:00',
  });
  const db = scriptedDb(emailCreateSteps(21, sending, sent));
  const mailer = fakeMailer({ sent: true });
  booking.__setDbForTests(db);
  booking.__setMailerForTests(mailer);

  const result = await booking.createLead(validPayload({ channel: 'email' }));

  assert.equal(result.emailSent, true);
  assert.equal(result.lead.email_status, 'sent');
  assert.equal(mailer.calls.length, 1);
  assert.equal(mailer.calls[0].id, 21);

  const claim = db.calls[1];
  assert.match(claim.text, /email_attempts = email_attempts \+ 1/);
  assert.match(claim.text, /INTERVAL 10 MINUTE/);
  assert.match(claim.text, /email_status IN \('pending', 'failed'\)/);
  assert.deepEqual(claim.params, [21]);
});

test('createLead failure stores only the whitelisted code and fixed label', async () => {
  const sending = leadRow({ id: 22, channel: 'email', email_status: 'sending', email_attempts: 1 });
  const failed = leadRow({
    id: 22, channel: 'email', email_status: 'failed', email_attempts: 1,
    email_error_code: 'EAUTH', email_error: 'Email delivery failed',
  });
  const db = scriptedDb(emailCreateSteps(22, sending, failed, true));
  const mailer = fakeMailer({
    sent: false,
    errorCode: 'EAUTH',
    error: '535 Authentication failed for admin@example.test on smtp.example.test',
  });
  booking.__setDbForTests(db);
  booking.__setMailerForTests(mailer);

  const result = await booking.createLead(validPayload({ channel: 'email' }));

  assert.equal(result.emailSent, false);
  assert.equal(result.lead.email_status, 'failed');

  const failure = db.calls.find((call) => call.text.includes("SET email_status = 'failed'"));
  assert.deepEqual(failure.params, ['EAUTH', 'Email delivery failed', 22]);
  const serialized = JSON.stringify(failure.params);
  assert.ok(!serialized.includes('535'), 'raw SMTP text must not be stored');
  assert.ok(!serialized.includes('smtp.example.test'), 'hostname must not be stored');
  assert.ok(!serialized.includes('admin@example.test'), 'address must not be stored');
});

test('unknown mailer error codes collapse to UNKNOWN', async () => {
  const sending = leadRow({ id: 23, channel: 'email', email_status: 'sending' });
  const failed = leadRow({ id: 23, channel: 'email', email_status: 'failed', email_error_code: 'UNKNOWN' });
  const db = scriptedDb(emailCreateSteps(23, sending, failed, true));
  booking.__setDbForTests(db);
  booking.__setMailerForTests(fakeMailer({ sent: false, errorCode: 'SOMETHING_ELSE' }));

  await booking.createLead(validPayload({ channel: 'email' }));
  const failure = db.calls.find((call) => call.text.includes("SET email_status = 'failed'"));
  assert.equal(failure.params[0], 'UNKNOWN');
});

test('a throwing mailer is treated as UNKNOWN and never breaks the request', async () => {
  const sending = leadRow({ id: 24, channel: 'email', email_status: 'sending' });
  const failed = leadRow({ id: 24, channel: 'email', email_status: 'failed', email_error_code: 'UNKNOWN' });
  const db = scriptedDb(emailCreateSteps(24, sending, failed, true));
  booking.__setDbForTests(db);
  booking.__setMailerForTests(fakeMailer(new Error('socket exploded')));

  const result = await booking.createLead(validPayload({ channel: 'email' }));
  assert.equal(result.emailSent, false);
  const failure = db.calls.find((call) => call.text.includes("SET email_status = 'failed'"));
  assert.equal(failure.params[0], 'UNKNOWN');
  assert.ok(!JSON.stringify(failure.params).includes('socket exploded'));
});

test('sanitizeEmailErrorCode accepts the documented codes only', () => {
  for (const code of ['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'EENVELOPE', 'ESOCKET']) {
    assert.equal(booking.sanitizeEmailErrorCode(code), code);
  }
  for (const value of [undefined, null, '', 'UNKNOWN', 'ETIMEOUT', 42, {}]) {
    assert.equal(booking.sanitizeEmailErrorCode(value), 'UNKNOWN', String(value));
  }
});

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

test('listLeads: filters, pagination, filtered total and table-wide counts', async () => {
  const db = scriptedDb([
    {
      match: /^SELECT .* ORDER BY created_at DESC, id DESC LIMIT \? OFFSET \?$/,
      result: [[leadRow({ id: 5, status: 'new' })]],
    },
    { match: /^SELECT COUNT\(\*\) AS total FROM booking_leads WHERE/, result: [[{ total: 3 }]] },
    { match: /^SELECT COUNT\(\*\) AS total, SUM/, result: [[{ total: 7, new_count: 4 }]] },
  ]);
  booking.__setDbForTests(db);

  const result = await booking.listLeads({
    status: 'new',
    channel: 'whatsapp',
    q: 'wayan',
    page: '2',
    per_page: '500',
  });

  assert.equal(result.page, 2);
  assert.equal(result.per_page, 100);
  assert.equal(result.total, 3);
  assert.equal(result.total_pages, 1);
  assert.deepEqual(result.counts, { new: 4, total: 7 });
  assert.equal(result.items.length, 1);

  const list = db.calls[0];
  assert.match(list.text, /WHERE status = \? AND channel = \? AND \(name LIKE \? OR email LIKE \?\)/);
  assert.deepEqual(list.params, ['new', 'whatsapp', '%wayan%', '%wayan%', 100, 100]);
});

test('listLeads accepts the question channel filter', async () => {
  const db = scriptedDb([
    {
      match: /^SELECT .* ORDER BY created_at DESC, id DESC LIMIT \? OFFSET \?$/,
      result: [[]],
    },
    { match: /^SELECT COUNT\(\*\) AS total FROM booking_leads WHERE channel = \?$/, result: [[{ total: 0 }]] },
    { match: /^SELECT COUNT\(\*\) AS total, SUM/, result: [[{ total: 0, new_count: 0 }]] },
  ]);
  booking.__setDbForTests(db);

  const result = await booking.listLeads({ channel: 'question' });
  assert.equal(result.total, 0);
  assert.equal(result.items.length, 0);
  assert.deepEqual(db.calls[0].params, ['question', 20, 0]);
});

test('listLeads rejects an unknown enum filter before querying', async () => {
  const db = scriptedDb([]);
  booking.__setDbForTests(db);

  await assert.rejects(
    booking.listLeads({ status: 'archived' }),
    (error) => error.status === 400 && /status must be one of/.test(error.body.message)
  );
  assert.equal(db.calls.length, 0);
});

test('updateLeadStatus: 400 for an invalid status, 404 for a missing row', async () => {
  const db = scriptedDb([]);
  booking.__setDbForTests(db);

  await assert.rejects(
    booking.updateLeadStatus(1, 'archived'),
    (error) => error.status === 400 && /status must be one of/.test(error.body.message)
  );
  assert.equal(db.calls.length, 0);

  const missing = scriptedDb([
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[]] },
  ]);
  booking.__setDbForTests(missing);
  await assert.rejects(
    booking.updateLeadStatus(9, 'contacted'),
    (error) => error.status === 404 && error.body.message === 'Booking lead not found'
  );
});

test('updateLeadStatus: updates only status and returns the refreshed row', async () => {
  const db = scriptedDb([
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[leadRow({ id: 3 })]] },
    { match: /^UPDATE booking_leads SET status = \? WHERE id = \?$/, result: [{ affectedRows: 1 }] },
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[leadRow({ id: 3, status: 'contacted' })]] },
  ]);
  booking.__setDbForTests(db);

  const lead = await booking.updateLeadStatus(3, 'contacted');
  assert.equal(lead.status, 'contacted');
  assert.deepEqual(db.calls[1].params, ['contacted', 3]);
});

test('resendLeadEmail: pending -> sent via the same atomic claim', async () => {
  const pending = leadRow({ id: 31, channel: 'email', email_status: 'pending' });
  const sent = leadRow({ id: 31, channel: 'email', email_status: 'sent' });
  const db = scriptedDb([
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[pending]] },
    { match: /^UPDATE booking_leads SET email_status = 'sending'/, result: [{ affectedRows: 1 }] },
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[leadRow({ id: 31, channel: 'email', email_status: 'sending' })]] },
    { match: /^UPDATE booking_leads SET email_status = 'sent'/, result: [{ affectedRows: 1 }] },
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[sent]] },
  ]);
  const mailer = fakeMailer({ sent: true });
  booking.__setDbForTests(db);
  booking.__setMailerForTests(mailer);

  const lead = await booking.resendLeadEmail(31);
  assert.equal(lead.email_status, 'sent');
  assert.equal(mailer.calls.length, 1);
});

test('resendLeadEmail: a claim that loses the race does not send again', async () => {
  const sent = leadRow({ id: 32, channel: 'email', email_status: 'sent' });
  const db = scriptedDb([
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[sent]] },
    { match: /^UPDATE booking_leads SET email_status = 'sending'/, result: [{ affectedRows: 0 }] },
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[sent]] },
  ]);
  const mailer = fakeMailer({ sent: true });
  booking.__setDbForTests(db);
  booking.__setMailerForTests(mailer);

  const lead = await booking.resendLeadEmail(32);
  assert.equal(lead.email_status, 'sent');
  assert.equal(mailer.calls.length, 0);
});

test('resendLeadEmail refuses WhatsApp leads and missing rows', async () => {
  const whatsapp = scriptedDb([
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[leadRow({ id: 33, channel: 'whatsapp' })]] },
  ]);
  booking.__setDbForTests(whatsapp);
  await assert.rejects(
    booking.resendLeadEmail(33),
    (error) => error.status === 400 && /only available for email-channel/.test(error.body.message)
  );

  const missing = scriptedDb([
    { match: /^SELECT .* WHERE id = \? LIMIT 1$/, result: [[]] },
  ]);
  booking.__setDbForTests(missing);
  await assert.rejects(
    booking.resendLeadEmail(34),
    (error) => error.status === 404 && error.body.message === 'Booking lead not found'
  );
});

test('removeLead: hard deletes and reports a missing row as 404', async () => {
  const db = scriptedDb([
    { match: /^DELETE FROM booking_leads WHERE id = \?$/, result: [{ affectedRows: 1 }] },
    { match: /^DELETE FROM booking_leads WHERE id = \?$/, result: [{ affectedRows: 0 }] },
  ]);
  booking.__setDbForTests(db);

  assert.deepEqual(await booking.removeLead(1), { id: 1 });
  await assert.rejects(
    booking.removeLead(2),
    (error) => error.status === 404 && error.body.message === 'Booking lead not found'
  );
});

// ---------------------------------------------------------------------------
// Tracking events
// ---------------------------------------------------------------------------

test('recordEvents inserts only whitelisted columns in one statement', async () => {
  const db = scriptedDb([
    { match: /^INSERT INTO booking_events \(event, source_page, room_slug, session_id, lead_id\)/, result: [{ affectedRows: 2 }] },
  ]);
  booking.__setDbForTests(db);

  const result = await booking.recordEvents([
    {
      event: 'wa_click', source_page: '/stay', room_slug: 'deluxe-room',
      session_id: 'sess-1', lead_id: '5', ip: '1.2.3.4', user_agent: 'evil-agent',
    },
    { event: 'not-a-real-event', source_page: '/x' },
    null,
    'text',
    { event: 'form_open', ip: '5.6.7.8' },
  ]);

  assert.equal(result.inserted, 2);
  assert.equal(db.calls.length, 1);
  const { text, params } = db.calls[0];
  assert.match(text, /VALUES \(\?, \?, \?, \?, \?\), \(\?, \?, \?, \?, \?\)$/);
  assert.deepEqual(params, [
    'wa_click', '/stay', 'deluxe-room', 'sess-1', 5,
    'form_open', null, null, null, null,
  ]);
  const serialized = JSON.stringify(params);
  assert.ok(!serialized.includes('1.2.3.4'), 'IP must never be stored');
  assert.ok(!serialized.includes('evil-agent'), 'user agent must never be stored');
  assert.ok(!serialized.includes('5.6.7.8'), 'IP must never be stored');
});

test('recordEvents drops every invalid entry without querying or throwing', async () => {
  const db = scriptedDb([]);
  booking.__setDbForTests(db);

  assert.deepEqual(await booking.recordEvents(null), { inserted: 0 });
  assert.deepEqual(await booking.recordEvents('text'), { inserted: 0 });
  assert.deepEqual(await booking.recordEvents([{ event: 'nope' }, {}, []]), { inserted: 0 });
  assert.equal(db.calls.length, 0);
});

test('recordEvents swallows DB errors (tracking is best-effort)', async () => {
  const db = scriptedDb([
    {
      match: /^INSERT INTO booking_events/,
      error: Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }),
    },
  ]);
  booking.__setDbForTests(db);

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await booking.recordEvents({ event: 'wa_click' }), { inserted: 0 });
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

test('stats: window metrics plus all-time totals', async () => {
  const db = scriptedDb([
    {
      match: /FROM booking_leads$/,
      result: [[{
        total_leads: 50,
        total_window: 5,
        new_leads: 20,
        new_window: 2,
        whatsapp_leads: 30,
        whatsapp_window: 3,
        email_leads: 15,
        email_window: 1,
        question_leads: 5,
        question_window: 1,
        failed_emails: 5,
        failed_window: 1,
      }]],
    },
    {
      match: /FROM booking_events$/,
      result: [[{
        wa_clicks: 100,
        wa_window: 10,
        email_clicks: 25,
        email_window: 2,
      }]],
    },
  ]);
  booking.__setDbForTests(db);

  const result = await booking.stats(7);
  assert.deepEqual(result, {
    days: 7,
    totalLeads: 5,
    newLeads: 2,
    whatsappLeads: 3,
    emailLeads: 1,
    questionLeads: 1,
    waClicks: 10,
    emailClicks: 2,
    failedEmails: 1,
    all_time: {
      totalLeads: 50,
      newLeads: 20,
      whatsappLeads: 30,
      emailLeads: 15,
      questionLeads: 5,
      waClicks: 100,
      emailClicks: 25,
      failedEmails: 5,
    },
  });
  assert.deepEqual(db.calls[0].params, [7, 7, 7, 7, 7, 7]);
  assert.deepEqual(db.calls[1].params, [7, 7]);
});

test('stats: null SUM values become 0 and an invalid days value falls back to 7', async () => {
  const db = scriptedDb([
    { match: /FROM booking_leads$/, result: [[{
      total_leads: 0, total_window: null, new_leads: null, new_window: null,
      whatsapp_leads: null, whatsapp_window: null, email_leads: null,
      email_window: null, question_leads: null, question_window: null,
      failed_emails: null, failed_window: null,
    }]] },
    { match: /FROM booking_events$/, result: [[{
      wa_clicks: null, wa_window: null, email_clicks: null, email_window: null,
    }]] },
  ]);
  booking.__setDbForTests(db);

  const result = await booking.stats('abc');
  assert.equal(result.days, 7);
  assert.equal(result.totalLeads, 0);
  assert.equal(result.questionLeads, 0);
  assert.equal(result.all_time.questionLeads, 0);
  assert.equal(result.all_time.waClicks, 0);
  assert.deepEqual(db.calls[0].params, [7, 7, 7, 7, 7, 7]);
});
