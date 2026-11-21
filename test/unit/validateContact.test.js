// backend/test/unit/validateContact.test.js
//
// Pure validation + normalisation for POST /api/contact.
//   name:    required, trimmed, <=100
//   email:   required, sane shape, <=255
//   phone:   optional, digits/+/ -/space/parens, <=32
//   message: required, trimmed, 10..5000
// Control characters are stripped before the length checks run.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateContact,
  isValidEmail,
  looksLikePhone,
  cleanMessage,
  stripControls,
  NAME_MAX,
  MESSAGE_MIN,
  MESSAGE_MAX,
  PHONE_MAX,
  EMAIL_MAX,
} = require('../../utils/validateContact');

function validPayload(overrides = {}) {
  return {
    name: 'Wayan Test',
    email: 'wayan@example.com',
    phone: '+62 812-3456-7890',
    message: 'Halo, saya ingin bertanya tentang kamar.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path + normalisation
// ---------------------------------------------------------------------------

test('validateContact accepts a complete valid payload', () => {
  const { errors, values } = validateContact(validPayload());
  assert.deepEqual(errors, []);
  assert.deepEqual(values, {
    name: 'Wayan Test',
    email: 'wayan@example.com',
    phone: '+62 812-3456-7890',
    message: 'Halo, saya ingin bertanya tentang kamar.',
  });
});

test('validateContact trims surrounding whitespace on every field', () => {
  const { errors, values } = validateContact({
    name: '  Wayan  ',
    email: '  wayan@example.com  ',
    phone: '  0812  ',
    message: '   Halo, ini pesan yang cukup panjang.   ',
  });
  assert.deepEqual(errors, []);
  // email is stored as typed (trimmed); the shape check passed.
  assert.equal(values.name, 'Wayan');
  assert.equal(values.email, 'wayan@example.com');
  assert.equal(values.phone, '0812');
  assert.equal(values.message, 'Halo, ini pesan yang cukup panjang.');
});

test('validateContact treats an omitted or blank phone as null (optional)', () => {
  for (const phone of [undefined, null, '', '   ']) {
    const { errors, values } = validateContact(validPayload({ phone }));
    assert.deepEqual(errors, [], `phone=${JSON.stringify(phone)}`);
    assert.equal(values.phone, null, `phone=${JSON.stringify(phone)}`);
  }
});

// ---------------------------------------------------------------------------
// Required + boundary lengths
// ---------------------------------------------------------------------------

test('validateContact requires name, email and message', () => {
  const { errors } = validateContact({});
  assert.ok(errors.includes('name is required'));
  assert.ok(errors.includes('email is required'));
  assert.ok(errors.includes('message is required'));
});

test('validateContact rejects non-string payloads without throwing', () => {
  for (const body of [null, undefined, 42, 'text', []]) {
    const { errors } = validateContact(body);
    assert.ok(errors.length >= 3, `body=${JSON.stringify(body)}`);
  }
});

test('name boundary: 100 accepted, 101 rejected', () => {
  const ok = validateContact(validPayload({ name: 'x'.repeat(NAME_MAX) }));
  assert.deepEqual(ok.errors, []);

  const over = validateContact(validPayload({ name: 'x'.repeat(NAME_MAX + 1) }));
  assert.ok(over.errors.includes(`name must be at most ${NAME_MAX} characters`));
});

test('message boundaries: 10 accepted, 9 rejected, 5000 accepted, 5001 rejected', () => {
  assert.deepEqual(validateContact(validPayload({ message: 'x'.repeat(MESSAGE_MIN) })).errors, []);

  const short = validateContact(validPayload({ message: 'x'.repeat(MESSAGE_MIN - 1) }));
  assert.ok(short.errors.includes(`message must be at least ${MESSAGE_MIN} characters`));

  assert.deepEqual(validateContact(validPayload({ message: 'x'.repeat(MESSAGE_MAX) })).errors, []);

  const long = validateContact(validPayload({ message: 'x'.repeat(MESSAGE_MAX + 1) }));
  assert.ok(long.errors.includes(`message must be at most ${MESSAGE_MAX} characters`));
});

test('message length is measured after control stripping (padding cannot cheat the cap)', () => {
  // 5000 real chars + 500 control chars: must still be accepted, not rejected.
  const padded = 'x'.repeat(MESSAGE_MAX) + '\u0000'.repeat(500);
  const { errors } = validateContact(validPayload({ message: padded }));
  assert.deepEqual(errors, []);
});

test('phone boundary: 32 accepted, 33 rejected', () => {
  assert.deepEqual(validateContact(validPayload({ phone: '1'.repeat(PHONE_MAX) })).errors, []);
  const over = validateContact(validPayload({ phone: '1'.repeat(PHONE_MAX + 1) }));
  assert.ok(over.errors.some((e) => e.includes('phone must be at most')));
});

test('phone rejects characters outside digits/+/ -/space/parens', () => {
  for (const phone of ['abc', '0812<script>', '0812;DROP', '0812@x', '0812#']) {
    const { errors } = validateContact(validPayload({ phone }));
    assert.ok(
      errors.some((e) => e.includes('phone may only contain')),
      `phone=${phone} errors=${JSON.stringify(errors)}`
    );
  }
});

test('phone accepts the punctuation people actually type', () => {
  for (const phone of ['+62 812-3456-7890', '(0362) 12345', '+62(0)812 3456', '081234567890']) {
    assert.deepEqual(validateContact(validPayload({ phone })).errors, [], `phone=${phone}`);
  }
});

// ---------------------------------------------------------------------------
// Email shape
// ---------------------------------------------------------------------------

test('isValidEmail accepts ordinary addresses and rejects junk', () => {
  for (const ok of ['a@b.com', 'first.last@sub.example.co.id', "o'brien@example.com", 'x+tag@example.com']) {
    assert.equal(isValidEmail(ok), true, ok);
  }
  for (const bad of ['', 'plain', 'a@b', 'a@@b.com', 'a b@c.com', 'a@b..com', '.a@b.com', 'a.@b.com', 'a@-b.com']) {
    assert.equal(isValidEmail(bad), false, bad);
  }
});

test('email boundary: 255 handled, over-long rejected with a cap error', () => {
  const local = 'a'.repeat(EMAIL_MAX - '@example.com'.length);
  const atCap = `${local}@example.com`;
  assert.equal(atCap.length, EMAIL_MAX);
  assert.deepEqual(validateContact(validPayload({ email: atCap })).errors, []);

  const over = validateContact(validPayload({ email: `${local}x@example.com` }));
  assert.ok(over.errors.includes('email must be a valid email address'));
  assert.ok(over.errors.includes(`email must be at most ${EMAIL_MAX} characters`));
});

// ---------------------------------------------------------------------------
// Control-character stripping (header-injection safety)
// ---------------------------------------------------------------------------

test('stripControls removes CR/LF and NUL from single-line fields', () => {
  const { values } = validateContact(validPayload({
    name: 'Wayan\r\nBcc: victim@example.com',
    email: 'wayan@example.com\n',
  }));
  assert.equal(values.name, 'WayanBcc: victim@example.com');
  assert.equal(values.email, 'wayan@example.com');
});

test('cleanMessage keeps newlines, drops other controls and collapses runs', () => {
  const { values } = validateContact(validPayload({
    message: 'Line one\u0000\r\nLine two\n\n\n\nLine three\u0007',
  }));
  assert.equal(values.message, 'Line one\nLine two\n\nLine three');
});

test('stripControls is a no-op on non-strings', () => {
  assert.equal(stripControls(42), 42);
  assert.equal(stripControls(null), null);
});

test('looksLikePhone needs 6..15 digits', () => {
  assert.equal(looksLikePhone('0812-3456-7890'), true);
  assert.equal(looksLikePhone('12345'), false);
  assert.equal(looksLikePhone('(0362) 12345'), true);
  assert.equal(looksLikePhone('1234567890123456'), false);
});

// ---------------------------------------------------------------------------
// Multiple errors are collected together
// ---------------------------------------------------------------------------

test('validateContact reports every failing field at once', () => {
  const { errors } = validateContact({ name: '', email: 'nope', phone: 'bad!', message: 'hi' });
  assert.ok(errors.includes('name is required'));
  assert.ok(errors.includes('email must be a valid email address'));
  assert.ok(errors.includes('phone may only contain digits, spaces, parentheses, hyphens and a leading +'));
  assert.ok(errors.includes(`message must be at least ${MESSAGE_MIN} characters`));
  assert.ok(errors.length >= 4);
});

test('values are nulled out whenever any error is present', () => {
  const { errors, values } = validateContact({ name: 'A', email: 'nope', message: 'long enough message' });
  assert.ok(errors.length > 0);
  assert.deepEqual(values, { name: null, email: null, phone: null, message: null });
});
