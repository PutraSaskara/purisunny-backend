// backend/test/unit/validateBooking.test.js
//
// Pure validation for POST /api/booking/leads and the status PATCH.
//   name:        1..100, trimmed
//   channel:     whatsapp | email
//   email:       optional for whatsapp, required for email, sane shape
//   phone:       optional, digits/+/ -/space/parens, <=32
//   check_in:    real YYYY-MM-DD, today or later (WITA)
//   check_out:   real YYYY-MM-DD, strictly after check_in
//   guests:      integer 1..20
//   room_slug:   optional, [a-z0-9-]+, <=100
//   message:     10..5000, controls stripped except \n and \t
//   source_page: starts with "/", no scheme/whitespace, <=255
//   client_ref:  8..64, [A-Za-z0-9_-]+
//
// "Today" is pinned so the date checks never depend on the machine clock.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateBooking,
  validateBookingStatus,
  parseDateOnly,
  todayInWita,
  NAME_MAX,
  MESSAGE_MIN,
  MESSAGE_MAX,
  PHONE_MAX,
  SOURCE_PAGE_MAX,
  CLIENT_REF_MIN,
  CLIENT_REF_MAX,
  GUESTS_MIN,
  GUESTS_MAX,
  ROOM_SLUG_MAX,
  QUESTION_CONTACT_ERROR,
} = require('../../utils/validateBooking');

const TODAY = '2026-11-21';

function validPayload(overrides = {}) {
  return {
    name: 'Wayan Test',
    email: 'wayan@example.com',
    phone: '+62 812-3456-7890',
    check_in: '2026-11-21',
    check_out: '2026-11-24',
    guests: 2,
    room_slug: 'deluxe-room',
    message: 'Halo, saya ingin bertanya tentang kamar.',
    source_page: '/stay/deluxe-room',
    client_ref: 'booking-ref-0001',
    channel: 'whatsapp',
    ...overrides,
  };
}

function validate(overrides, options = { today: TODAY }) {
  return validateBooking(validPayload(overrides), options);
}

// ---------------------------------------------------------------------------
// Happy path + normalisation
// ---------------------------------------------------------------------------

test('accepts a complete valid WhatsApp payload', () => {
  const { errors, values } = validate();
  assert.deepEqual(errors, []);
  assert.deepEqual(values, {
    name: 'Wayan Test',
    email: 'wayan@example.com',
    phone: '+62 812-3456-7890',
    check_in: '2026-11-21',
    check_out: '2026-11-24',
    guests: 2,
    room_slug: 'deluxe-room',
    message: 'Halo, saya ingin bertanya tentang kamar.',
    source_page: '/stay/deluxe-room',
    client_ref: 'booking-ref-0001',
    channel: 'whatsapp',
  });
});

test('trims every string and nulls omitted optional fields', () => {
  const { errors, values } = validate({
    name: '  Wayan  ',
    email: '  wayan@example.com  ',
    phone: '   ',
    room_slug: '  deluxe-room  ',
    source_page: '  /stay  ',
    client_ref: '  booking-ref-0001  ',
    message: `  ${'x'.repeat(MESSAGE_MIN)}  `,
  });
  assert.deepEqual(errors, []);
  assert.equal(values.name, 'Wayan');
  assert.equal(values.email, 'wayan@example.com');
  assert.equal(values.phone, null);
  assert.equal(values.room_slug, 'deluxe-room');
  assert.equal(values.source_page, '/stay');
  assert.equal(values.client_ref, 'booking-ref-0001');
});

test('WhatsApp leads may omit email; the email channel requires it', () => {
  assert.deepEqual(validate({ channel: 'whatsapp', email: null }).errors, []);

  const missing = validate({ channel: 'email', email: '' });
  assert.ok(missing.errors.includes('email is required for the email channel'));

  const ok = validate({ channel: 'email', email: 'guest@example.com' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.values.channel, 'email');
});

// ---------------------------------------------------------------------------
// Required values + boundaries
// ---------------------------------------------------------------------------

test('required fields are reported together', () => {
  const { errors } = validateBooking({}, { today: TODAY });
  assert.ok(errors.includes('channel is required'));
  assert.ok(errors.includes('name is required'));
  assert.ok(errors.includes('check_in is required'));
  assert.ok(errors.includes('check_out is required'));
  assert.ok(errors.includes('message is required'));
  assert.ok(errors.some((error) => error.startsWith('guests must be')));
});

test('non-object bodies do not throw and collect errors', () => {
  for (const body of [null, undefined, 42, 'text', []]) {
    const { errors } = validateBooking(body, { today: TODAY });
    assert.ok(errors.length >= 4, `body=${JSON.stringify(body)}`);
  }
});

test('name boundary: 100 accepted, 101 rejected', () => {
  assert.deepEqual(validate({ name: 'x'.repeat(NAME_MAX) }).errors, []);
  assert.ok(validate({ name: 'x'.repeat(NAME_MAX + 1) }).errors
    .includes(`name must be at most ${NAME_MAX} characters`));
});

test('message boundaries: 10 accepted, 9 rejected, 5000 accepted, 5001 rejected', () => {
  assert.deepEqual(validate({ message: 'x'.repeat(MESSAGE_MIN) }).errors, []);
  assert.ok(validate({ message: 'x'.repeat(MESSAGE_MIN - 1) }).errors
    .includes(`message must be at least ${MESSAGE_MIN} characters`));
  assert.deepEqual(validate({ message: 'x'.repeat(MESSAGE_MAX) }).errors, []);
  assert.ok(validate({ message: 'x'.repeat(MESSAGE_MAX + 1) }).errors
    .includes(`message must be at most ${MESSAGE_MAX} characters`));
});

test('message controls: CRLF normalised, newline/tab kept, other controls stripped', () => {
  const { errors, values } = validate({
    message: 'Line one\u0000\r\nLine two\tend\u0007\n\nLine three',
  });
  assert.deepEqual(errors, []);
  assert.equal(values.message, 'Line one\nLine two\tend\n\nLine three');
});

test('message length is measured after control stripping', () => {
  const padded = 'x'.repeat(MESSAGE_MAX) + '\u0000'.repeat(500);
  assert.deepEqual(validate({ message: padded }).errors, []);
});

// ---------------------------------------------------------------------------
// Email / phone / room
// ---------------------------------------------------------------------------

test('email shape is enforced and capped at 255 characters', () => {
  for (const email of ['plain', 'a@b', 'a b@c.com', 'a@@b.com']) {
    assert.ok(validate({ email }).errors.includes('email must be a valid email address'), email);
  }

  const local = 'a'.repeat(256 - '@example.com'.length);
  const over = `${local}x@example.com`;
  const errors = validate({ channel: 'email', email: over }).errors;
  assert.ok(errors.includes('email must be at most 255 characters'));
});

test('phone is optional and limited to digits/+/ -/space/parens', () => {
  for (const phone of [undefined, null, '', '   ']) {
    assert.equal(validate({ phone }).values.phone, null);
  }
  for (const phone of ['+62 812-3456-7890', '(0362) 12345', '081234567890']) {
    assert.deepEqual(validate({ phone }).errors, [], phone);
  }
  for (const phone of ['abc', '0812<script>', '0812@x']) {
    assert.ok(validate({ phone }).errors
      .some((error) => error.includes('phone may only contain')), phone);
  }
  assert.deepEqual(validate({ phone: '1'.repeat(PHONE_MAX) }).errors, []);
  assert.ok(validate({ phone: '1'.repeat(PHONE_MAX + 1) }).errors
    .some((error) => error.includes('phone must be at most')));
});

test('room_slug is optional, bounded and kebab-case', () => {
  for (const room_slug of [undefined, null, '', '   ']) {
    assert.equal(validate({ room_slug }).values.room_slug, null);
  }
  for (const room_slug of ['deluxe-room', 'camp', 'room-2']) {
    assert.deepEqual(validate({ room_slug }).errors, [], room_slug);
  }
  for (const room_slug of ['Deluxe Room', 'deluxe_room', 'DELUXE', '../x']) {
    assert.ok(validate({ room_slug }).errors
      .some((error) => error.includes('room_slug must be')), room_slug);
  }
  assert.deepEqual(validate({ room_slug: 'a'.repeat(ROOM_SLUG_MAX) }).errors, []);
  assert.ok(validate({ room_slug: 'a'.repeat(ROOM_SLUG_MAX + 1) }).errors
    .some((error) => error.includes('room_slug must be at most')));
});

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

test('channel only accepts whatsapp, email or question', () => {
  for (const channel of ['sms', 'EMAIL', '', undefined]) {
    assert.ok(validate({ channel }).errors.length > 0, String(channel));
  }
  assert.deepEqual(validate({ channel: 'email', email: 'a@b.com' }).errors, []);
  assert.deepEqual(validate({ channel: 'whatsapp' }).errors, []);
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test('parseDateOnly rejects rollover and malformed dates', () => {
  assert.deepEqual(parseDateOnly('2026-11-21'), {
    iso: '2026-11-21',
    time: Date.UTC(2026, 10, 21),
  });
  for (const value of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1', '21-11-2026', '2026-11-21T00:00:00Z', 20261121]) {
    assert.equal(parseDateOnly(value), null, String(value));
  }
});

test('check_in accepts today, rejects yesterday and malformed dates', () => {
  assert.deepEqual(validate({ check_in: TODAY, check_out: '2026-11-24' }).errors, []);

  const past = validate({ check_in: '2026-11-20' });
  assert.ok(past.errors.includes('check_in must not be in the past'));

  const malformed = validate({ check_in: '2026-02-30' });
  assert.ok(malformed.errors.includes('check_in must be a valid date (YYYY-MM-DD)'));
});

test('check_out must be a real date strictly after check_in', () => {
  assert.ok(validate({ check_in: '2026-11-21', check_out: '2026-11-21' }).errors
    .includes('check_out must be after check_in'));
  assert.ok(validate({ check_in: '2026-11-21', check_out: '2026-11-20' }).errors
    .includes('check_out must be after check_in'));
  assert.ok(validate({ check_out: '2026-02-30' }).errors
    .includes('check_out must be a valid date (YYYY-MM-DD)'));
});

test('todayInWita uses the UTC+8 calendar day', () => {
  assert.equal(todayInWita(new Date(Date.UTC(2026, 10, 21, 0, 0))), '2026-11-21');
  assert.equal(todayInWita(new Date(Date.UTC(2026, 10, 21, 20, 0))), '2026-11-22');
});

// ---------------------------------------------------------------------------
// Guests / source page / client ref
// ---------------------------------------------------------------------------

test('guests is an integer 1..20 (numeric strings accepted)', () => {
  assert.deepEqual(validate({ guests: GUESTS_MIN }).errors, []);
  assert.deepEqual(validate({ guests: GUESTS_MAX }).errors, []);
  assert.deepEqual(validate({ guests: '3' }).values.guests, 3);

  for (const guests of [0, GUESTS_MAX + 1, 1.5, '1.5', '', null, true]) {
    assert.ok(validate({ guests }).errors.some((error) => error.startsWith('guests must be')),
      String(guests));
    assert.equal(validate({ guests }).values.guests, null);
  }
});

test('source_page is a site path, not a URL', () => {
  for (const source_page of [undefined, null, '', '/', '/stay', '/stay/deluxe-room?x=1']) {
    assert.deepEqual(validate({ source_page }).errors, [], String(source_page));
  }
  for (const source_page of ['stay', 'https://evil.test', '//evil.test/x', '/stay page', '/a b']) {
    assert.ok(validate({ source_page }).errors
      .some((error) => error.includes('source_page must start with')), source_page);
  }
  assert.deepEqual(validate({ source_page: `/${'a'.repeat(SOURCE_PAGE_MAX - 1)}` }).errors, []);
  assert.ok(validate({ source_page: `/${'a'.repeat(SOURCE_PAGE_MAX)}` }).errors
    .some((error) => error.includes('source_page must be at most')));
});

test('client_ref is optional, 8..64 safe characters', () => {
  for (const client_ref of [undefined, null, '', '   ']) {
    assert.deepEqual(validate({ client_ref }).errors, []);
    assert.equal(validate({ client_ref }).values.client_ref, null);
  }
  assert.deepEqual(validate({ client_ref: 'a'.repeat(CLIENT_REF_MIN) }).errors, []);
  assert.deepEqual(validate({ client_ref: 'A_z-9'.repeat(CLIENT_REF_MAX / 5).slice(0, CLIENT_REF_MAX) }).errors, []);

  assert.ok(validate({ client_ref: 'a'.repeat(CLIENT_REF_MIN - 1) }).errors
    .some((error) => error.includes('client_ref must be at least')));
  assert.ok(validate({ client_ref: 'a'.repeat(CLIENT_REF_MAX + 1) }).errors
    .some((error) => error.includes('client_ref must be at most')));
  for (const client_ref of ['has space', 'has.dot.x', 'has/slash', 'has@at.x']) {
    assert.ok(validate({ client_ref }).errors
      .some((error) => error.includes('client_ref may only contain')), client_ref);
  }
});

// ---------------------------------------------------------------------------
// Question channel (mini "Ask a question" form)
// ---------------------------------------------------------------------------

function questionPayload(overrides = {}) {
  return {
    name: 'Wayan Test',
    channel: 'question',
    email: null,
    phone: '+62 812-3456-7890',
    check_in: null,
    check_out: null,
    guests: undefined,
    room_slug: null,
    message: 'Halo, saya ingin bertanya tentang kamar.',
    source_page: '/contact',
    ...overrides,
  };
}

function validateQuestion(overrides = {}) {
  return validateBooking(questionPayload(overrides), { today: TODAY });
}

test('question: minimal form with a phone is valid; dates stay null and guests defaults to 1', () => {
  const { errors, values } = validateQuestion();
  assert.deepEqual(errors, []);
  assert.deepEqual(values, {
    name: 'Wayan Test',
    email: null,
    phone: '+62 812-3456-7890',
    check_in: null,
    check_out: null,
    guests: 1,
    room_slug: null,
    message: 'Halo, saya ingin bertanya tentang kamar.',
    source_page: '/contact',
    client_ref: null,
    channel: 'question',
  });
});

test('question: a valid email alone is enough contact', () => {
  const { errors, values } = validateQuestion({ email: 'wayan@example.com', phone: null });
  assert.deepEqual(errors, []);
  assert.equal(values.email, 'wayan@example.com');
  assert.equal(values.phone, null);
  assert.equal(values.guests, 1);
});

test('question: missing or invalid contact is rejected with the reply-channel message', () => {
  const missing = validateQuestion({ email: null, phone: null });
  assert.ok(missing.errors.includes(QUESTION_CONTACT_ERROR));
  assert.equal(QUESTION_CONTACT_ERROR, 'Please provide an email or phone number so we can reply.');

  const invalidEmail = validateQuestion({ email: 'not-an-email', phone: null });
  assert.ok(invalidEmail.errors.includes('email must be a valid email address'));
  assert.ok(invalidEmail.errors.includes(QUESTION_CONTACT_ERROR));
});

test('question: dates are optional, but one date requires both and keeps past/order rules', () => {
  const none = validateQuestion();
  assert.deepEqual(none.errors, []);
  assert.equal(none.values.check_in, null);
  assert.equal(none.values.check_out, null);

  const both = validateQuestion({ check_in: '2026-11-22', check_out: '2026-11-25' });
  assert.deepEqual(both.errors, []);
  assert.equal(both.values.check_in, '2026-11-22');
  assert.equal(both.values.check_out, '2026-11-25');

  const inOnly = validateQuestion({ check_in: '2026-11-22', check_out: null });
  assert.ok(inOnly.errors.includes('check_out is required'));

  const outOnly = validateQuestion({ check_in: null, check_out: '2026-11-25' });
  assert.ok(outOnly.errors.includes('check_in is required'));

  const past = validateQuestion({ check_in: '2026-11-20', check_out: '2026-11-25' });
  assert.ok(past.errors.includes('check_in must not be in the past'));

  const backwards = validateQuestion({ check_in: '2026-11-25', check_out: '2026-11-22' });
  assert.ok(backwards.errors.includes('check_out must be after check_in'));
});

test('question: guests is optional (default 1) but must be 1..20 when supplied', () => {
  assert.equal(validateQuestion({ guests: undefined }).values.guests, 1);
  assert.equal(validateQuestion({ guests: null }).values.guests, 1);
  assert.equal(validateQuestion({ guests: '' }).values.guests, 1);
  assert.equal(validateQuestion({ guests: 3 }).values.guests, 3);

  for (const guests of [0, GUESTS_MAX + 1, 1.5, 'abc']) {
    const { errors } = validateQuestion({ guests });
    assert.ok(errors.some((error) => error.startsWith('guests must be')), String(guests));
  }
});

test('question: room_slug keeps the same optional slug rule', () => {
  assert.deepEqual(validateQuestion({ room_slug: 'deluxe-room' }).errors, []);
  assert.ok(validateQuestion({ room_slug: 'Deluxe Room' }).errors
    .some((error) => error.includes('room_slug must be')));
});

test('question: source_page and client_ref keep their existing rules', () => {
  assert.ok(validateQuestion({ source_page: 'https://evil.test' }).errors
    .some((error) => error.includes('source_page must start with')));
  assert.ok(validateQuestion({ client_ref: 'short' }).errors
    .some((error) => error.includes('client_ref must be at least')));
});

// ---------------------------------------------------------------------------
// Nulling + status PATCH
// ---------------------------------------------------------------------------

test('all values are null when any error is present', () => {
  const { errors, values } = validate({ name: '', email: 'nope', guests: 99 });
  assert.ok(errors.length > 0);
  assert.deepEqual(values, {
    name: null,
    email: null,
    phone: null,
    check_in: null,
    check_out: null,
    guests: null,
    room_slug: null,
    message: null,
    source_page: null,
    client_ref: null,
    channel: null,
  });
});

test('validateBookingStatus accepts the four statuses only', () => {
  for (const status of ['new', 'contacted', 'confirmed', 'cancelled']) {
    assert.deepEqual(validateBookingStatus(status), { value: status, errors: [] });
  }
  for (const status of ['pending', 'NEW', '', null, 42, {}]) {
    const result = validateBookingStatus(status);
    assert.equal(result.value, null);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /status must be one of/);
  }
});
