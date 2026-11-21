// backend/test/unit/bookingMailer.test.js
//
// Booking email builder + send behaviour with an injected fake transport.
// No real socket is opened. Verifies the subject, Reply-To, structured stay
// details, HTML escaping and that SMTP error messages are never returned.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../../utils/mailer');

const EMAIL_KEYS = [
  'EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_SECURE', 'EMAIL_USER', 'EMAIL_PASS',
  'EMAIL_FROM', 'EMAIL_FROM_NAME', 'EMAIL_TO',
];

const SAVED_EMAIL_ENV = {};
for (const key of EMAIL_KEYS) SAVED_EMAIL_ENV[key] = process.env[key];

test.before(() => {
  for (const key of EMAIL_KEYS) delete process.env[key];
});
test.after(() => {
  for (const key of EMAIL_KEYS) {
    if (SAVED_EMAIL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_EMAIL_ENV[key];
  }
});

async function withEnv(values, fn) {
  const previous = {};
  for (const key of EMAIL_KEYS) previous[key] = process.env[key];
  for (const key of EMAIL_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const key of EMAIL_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

const CONFIGURED = {
  EMAIL_HOST: 'smtp.zoho.com',
  EMAIL_USER: 'admin@purisunnymunduk.id',
  EMAIL_PASS: 'zz-fake-app-password',
};

function fakeTransportFactory() {
  const calls = [];
  const factory = (options) => ({
    options,
    async sendMail(mail) {
      calls.push({ mail, options });
      if (factory.failWith) throw factory.failWith;
      return { accepted: [mail.to], rejected: [] };
    },
    close() {},
  });
  factory.calls = calls;
  factory.failWith = null;
  return factory;
}

function lead(overrides = {}) {
  return {
    name: 'Made Sari',
    email: 'made@example.com',
    phone: '+62 812-3456-7890',
    check_in: '2099-01-01',
    check_out: '2099-01-04',
    guests: 2,
    room_slug: 'deluxe-room',
    message: 'Apakah ada kamar kosong bulan depan?',
    source_page: '/stay/deluxe-room',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

test('buildBookingEmail: subject, recipients and structured details', () => {
  const out = mailer.buildBookingEmail(lead());

  assert.equal(out.subject, 'Booking Inquiry — Made Sari');
  assert.equal(out.from, '"Puri Sunny Website" <admin@purisunnymunduk.id>');
  assert.equal(out.to, 'purisunnybali@gmail.com');
  assert.equal(out.replyTo, 'made@example.com');

  for (const value of [
    'Made Sari', 'made@example.com', '+62 812-3456-7890',
    '2099-01-01', '2099-01-04', 'deluxe-room', '/stay/deluxe-room',
    'Apakah ada kamar kosong bulan depan?',
  ]) {
    assert.ok(out.text.includes(value), `text missing ${value}`);
    assert.ok(out.html.includes(value), `html missing ${value}`);
  }
  assert.ok(out.html.includes('mailto:made@example.com'));
});

test('buildBookingEmail escapes every user value in the HTML body', () => {
  const evil = lead({
    name: `</script><script>alert(1)</script>`,
    email: `a"b'c@example.com`,
    phone: `"><img onerror=x>`,
    message: `<img src=x onerror="alert('pwn')"> & "quotes" 'single'\nsecond line`,
    room_slug: 'deluxe-room',
    source_page: '/stay',
  });
  const { html } = mailer.buildBookingEmail(evil);

  assert.ok(!html.includes('<script>'), 'script tag leaked');
  assert.ok(!html.includes('<img'), 'img tag leaked');
  assert.ok(!html.includes('onerror="alert'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(&#39;pwn&#39;)&quot;&gt;'));
  assert.ok(html.includes('second line'));
  assert.ok(html.includes('<br>'));
});

test('buildBookingEmail strips CR/LF from the subject (no header injection)', () => {
  const { subject } = mailer.buildBookingEmail(lead({ name: 'Wayan\r\nBcc: victim@example.com' }));
  assert.ok(!subject.includes('\r'));
  assert.ok(!subject.includes('\n'));
  assert.equal(subject, 'Booking Inquiry — Wayan Bcc: victim@example.com');
});

test('buildBookingEmail honours EMAIL_FROM / EMAIL_FROM_NAME / EMAIL_TO overrides', () => {
  withEnv(
    {
      ...CONFIGURED,
      EMAIL_FROM: 'noreply@purisunnymunduk.id',
      EMAIL_FROM_NAME: 'Puri Sunny Reservasi',
      EMAIL_TO: 'owner@example.com',
    },
    () => {
      const out = mailer.buildBookingEmail(lead());
      assert.equal(out.from, '"Puri Sunny Reservasi" <noreply@purisunnymunduk.id>');
      assert.equal(out.to, 'owner@example.com');
    }
  );
});

// ---------------------------------------------------------------------------
// Send behaviour (fake transport, no network)
// ---------------------------------------------------------------------------

test('sendBookingEmail without config returns sent:false + errorCode, no transport', async () => {
  const factory = fakeTransportFactory();
  await withEnv({}, async () => {
    const m = mailer.createMailer({ transportFactory: factory });
    const result = await m.sendBookingEmail(lead());
    assert.deepEqual(result, { sent: false, errorCode: 'UNKNOWN' });
    assert.equal(factory.calls.length, 0, 'no transport without config');
  });
});

test('sendBookingEmail passes the built booking message to the transport', async () => {
  const factory = fakeTransportFactory();
  await withEnv(CONFIGURED, async () => {
    const m = mailer.createMailer({ transportFactory: factory });
    const result = await m.sendBookingEmail(lead());

    assert.deepEqual(result, { sent: true });
    assert.equal(factory.calls.length, 1);
    const { mail } = factory.calls[0];
    assert.equal(mail.to, 'purisunnybali@gmail.com');
    assert.equal(mail.replyTo, 'made@example.com');
    assert.equal(mail.subject, 'Booking Inquiry — Made Sari');
    assert.match(mail.text, /Check-in/);
  });
});

test('sendBookingEmail returns only the SMTP code, never the raw message', async () => {
  const factory = fakeTransportFactory();
  factory.failWith = Object.assign(
    new Error('535 auth failed for admin@example.test on smtp.example.test'),
    { code: 'EAUTH' }
  );
  await withEnv(CONFIGURED, async () => {
    const m = mailer.createMailer({ transportFactory: factory });
    const result = await m.sendBookingEmail(lead());
    assert.equal(result.sent, false);
    assert.equal(result.errorCode, 'EAUTH');
    assert.equal(result.error, undefined);
    assert.ok(!JSON.stringify(result).includes('535'));
    assert.ok(!JSON.stringify(result).includes('smtp.example.test'));
  });
});

test('sendBookingEmail maps a rejected recipient to EENVELOPE', async () => {
  const factory = (options) => ({
    options,
    async sendMail(mail) {
      return { accepted: [], rejected: [mail.to] };
    },
    close() {},
  });
  await withEnv(CONFIGURED, async () => {
    const m = mailer.createMailer({ transportFactory: factory });
    const result = await m.sendBookingEmail(lead());
    assert.deepEqual(result, { sent: false, errorCode: 'EENVELOPE' });
  });
});
