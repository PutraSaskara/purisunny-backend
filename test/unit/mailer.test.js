// backend/test/unit/mailer.test.js
//
// Mailer config matrix, HTML escaping, builder output and send behaviour with
// an INJECTED fake transport. No real socket is ever opened, so the suite can
// never send mail.
//
// Config is read from process.env on every call, so each test snapshots and
// restores the EMAIL_* variables around itself.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../../utils/mailer');

const EMAIL_KEYS = [
  'EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_SECURE', 'EMAIL_USER', 'EMAIL_PASS',
  'EMAIL_FROM', 'EMAIL_FROM_NAME', 'EMAIL_TO',
];

// Tests must not inherit EMAIL_* from .env/.env.test. Snapshot once, clear.
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

// Temporarily applies EMAIL_* values and always restores them. Awaits the
// callback when it returns a promise, so async tests keep the env set until
// every send has read it (returning fn() without awaiting restored the env
// while a send was still in flight).
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

// A fake transport factory that records sendMail calls and can be told to fail.
function fakeTransportFactory() {
  const calls = [];
  const factory = (options) => {
    const t = {
      options,
      async sendMail(mail) {
        calls.push({ mail, options });
        if (factory.failWith) throw factory.failWith;
        return { accepted: [mail.to], rejected: [], ...factory.info };
      },
      close() { t.closed = true; },
    };
    return t;
  };
  factory.calls = calls; // shared array: factory.calls.length is the send count
  factory.failWith = null;
  factory.info = {};
  return factory;
}

// ---------------------------------------------------------------------------
// Config matrix
// ---------------------------------------------------------------------------

test('isEmailConfigured: false when nothing is set', () => {
  assert.equal(mailer.isEmailConfigured(), false);
  assert.deepEqual(mailer.missingEmailConfigKeys(), ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASS']);
});

test('isEmailConfigured: every single missing key keeps it false', () => {
  for (const key of ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASS']) {
    const env = { ...CONFIGURED };
    delete env[key];
    withEnv(env, () => {
      assert.equal(mailer.isEmailConfigured(), false, `missing ${key}`);
      assert.deepEqual(mailer.missingEmailConfigKeys(), [key], `missing ${key}`);
    });
  }
});

test('isEmailConfigured: true with host + user + pass; defaults fill the rest', () => {
  withEnv(CONFIGURED, () => {
    assert.equal(mailer.isEmailConfigured(), true);
    const cfg = mailer.emailConfig();
    assert.equal(cfg.host, 'smtp.zoho.com');
    assert.equal(cfg.port, 465);
    assert.equal(cfg.secure, true); // inferred from port 465
    assert.equal(cfg.from, mailer.DEFAULT_FROM);
    assert.equal(cfg.fromName, mailer.DEFAULT_FROM_NAME);
    assert.equal(cfg.to, mailer.DEFAULT_TO);
  });
});

test('defaults match the documented addresses', () => {
  assert.equal(mailer.DEFAULT_FROM, 'admin@purisunnymunduk.id');
  assert.equal(mailer.DEFAULT_TO, 'purisunnybali@gmail.com');
  assert.equal(mailer.DEFAULT_FROM_NAME, 'Puri Sunny Website');
  assert.equal(mailer.DEFAULT_PORT, 465);
});

test('EMAIL_SECURE is inferred from port, and can be forced both ways', () => {
  withEnv({ ...CONFIGURED, EMAIL_PORT: '587' }, () => {
    assert.equal(mailer.emailConfig().secure, false, '587 defaults to STARTTLS');
  });
  withEnv({ ...CONFIGURED, EMAIL_PORT: '587', EMAIL_SECURE: '1' }, () => {
    assert.equal(mailer.emailConfig().secure, true);
  });
  withEnv({ ...CONFIGURED, EMAIL_PORT: '465', EMAIL_SECURE: 'false' }, () => {
    assert.equal(mailer.emailConfig().secure, false);
  });
});

test('passwords are not trimmed (trailing spaces are legitimate)', () => {
  withEnv({ ...CONFIGURED, EMAIL_PASS: '  secret with spaces  ' }, () => {
    assert.equal(mailer.emailConfig().pass, '  secret with spaces  ');
  });
});

test('verifyEmailConfig logs names only, never values', () => {
  const lines = [];
  const logger = { log: (m) => lines.push(['log', m]), warn: (m) => lines.push(['warn', m]) };

  withEnv({}, () => mailer.verifyEmailConfig({ logger }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], 'warn');
  assert.match(lines[0][1], /contact email: NOT configured \(missing: EMAIL_HOST, EMAIL_USER, EMAIL_PASS\)/);

  lines.length = 0;
  withEnv(CONFIGURED, () => mailer.verifyEmailConfig({ logger }));
  assert.deepEqual(lines, [['log', 'contact email: configured']]);
});

test('verifyEmailConfig never prints a configured value', () => {
  const output = [];
  const logger = {
    log: (m) => output.push(m),
    warn: (m) => output.push(m),
  };
  withEnv({ ...CONFIGURED, EMAIL_PASS: 'SUPER-SECRET-VALUE' }, () => mailer.verifyEmailConfig({ logger }));
  withEnv({ EMAIL_PASS: 'SUPER-SECRET-VALUE' }, () => mailer.verifyEmailConfig({ logger }));
  assert.ok(!output.some((line) => String(line).includes('SUPER-SECRET-VALUE')));
  assert.ok(!output.some((line) => String(line).includes('admin@purisunnymunduk.id')));
});

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

test('escapeHtml escapes & < > " and single quotes', () => {
  assert.equal(
    mailer.escapeHtml(`<img src=x onerror="alert('x')"> & </script>`),
    '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; &lt;/script&gt;'
  );
});

test('escapeHtml returns "" for null/undefined and stringifies numbers', () => {
  assert.equal(mailer.escapeHtml(null), '');
  assert.equal(mailer.escapeHtml(undefined), '');
  assert.equal(mailer.escapeHtml(0), '0');
});

test('buildContactEmail escapes every user value in the HTML body', () => {
  const evil = {
    name: `</script><script>alert(1)</script>`,
    email: `a"b'c@example.com`,
    phone: `"><img onerror=x>`,
    message: `<img src=x onerror="alert('pwn')"> & "quotes" 'single'\nsecond line`,
  };
  const { html, text } = mailer.buildContactEmail(evil, { config: mailer.emailConfig() });

  // Raw markup from user input must not appear anywhere in the HTML.
  assert.ok(!html.includes('<script>'), 'script tag leaked');
  assert.ok(!html.includes('</script><script>'), 'script break-out leaked');
  assert.ok(!html.includes('<img'), 'img tag leaked');
  assert.ok(!html.includes('onerror="alert'));
  // ...and it must survive as text.
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(&#39;pwn&#39;)&quot;&gt;'));
  assert.ok(html.includes('&amp; &quot;quotes&quot; &#39;single&#39;'));
  // Newlines become <br> inside the message block.
  assert.ok(html.includes('second line'));
  assert.ok(html.includes('<br>'));

  // Plain text keeps the raw characters (text/plain has no markup surface).
  assert.ok(text.includes('<img src=x'));
});

test('buildContactEmail escapes the subject inside the HTML <title>', () => {
  const { html } = mailer.buildContactEmail(
    { name: `</title><script>alert(1)</script>`, email: 'x@example.com', message: 'long enough message' },
    { config: mailer.emailConfig() }
  );
  assert.ok(!html.includes('</title><script>'));
  assert.ok(html.includes('&lt;/title&gt;&lt;script&gt;'));
});

test('buildContactEmail strips CR/LF from the subject (no header injection)', () => {
  const subject = mailer.buildSubject({ name: 'Wayan\r\nBcc: victim@example.com' });
  assert.ok(!subject.includes('\r'));
  assert.ok(!subject.includes('\n'));
  assert.equal(subject, 'Pesan baru dari form website — Wayan Bcc: victim@example.com');
});

// ---------------------------------------------------------------------------
// Builder output
// ---------------------------------------------------------------------------

test('buildContactEmail: subject, from, to, replyTo and body content', () => {
  const payload = {
    name: 'Made Sari',
    email: 'made@example.com',
    phone: '+62 812-3456-7890',
    message: 'Apakah ada kamar kosong bulan depan?',
  };
  const now = new Date(Date.UTC(2026, 9, 26, 6, 5)); // 14:05 WITA
  const { config } = { config: mailer.emailConfig() };
  const out = mailer.buildContactEmail(payload, { config, now });

  assert.equal(out.subject, 'Pesan baru dari form website — Made Sari');
  assert.equal(out.from, '"Puri Sunny Website" <admin@purisunnymunduk.id>');
  assert.equal(out.to, 'purisunnybali@gmail.com');
  assert.equal(out.replyTo, 'made@example.com');

  for (const value of ['Made Sari', 'made@example.com', '+62 812-3456-7890', 'Apakah ada kamar kosong bulan depan?']) {
    assert.ok(out.text.includes(value), `text missing ${value}`);
    assert.ok(out.html.includes(value), `html missing ${value}`);
  }
  assert.match(out.text, /Form kontak website purisunnymunduk\.id/);
  assert.match(out.text, /26 Oktober 2026, 14:05 WITA \(UTC\+8\)/);
  assert.ok(out.html.includes('mailto:made@example.com'));
  assert.ok(out.html.includes('https://wa.me/6281234567890'));
});

test('buildContactEmail honours EMAIL_FROM / EMAIL_FROM_NAME / EMAIL_TO overrides', () => {
  withEnv(
    { ...CONFIGURED, EMAIL_FROM: 'noreply@purisunnymunduk.id', EMAIL_FROM_NAME: 'Puri Sunny Reservasi', EMAIL_TO: 'owner@example.com' },
    () => {
      const out = mailer.buildContactEmail({ name: 'A', email: 'a@b.com', message: 'long enough message' });
      assert.equal(out.from, '"Puri Sunny Reservasi" <noreply@purisunnymunduk.id>');
      assert.equal(out.to, 'owner@example.com');
    }
  );
});

test('buildContactEmail omits the phone row when no phone was given', () => {
  const out = mailer.buildContactEmail(
    { name: 'A', email: 'a@b.com', phone: null, message: 'long enough message' },
    { config: mailer.emailConfig() }
  );
  assert.ok(!out.html.includes('Telepon'), 'no phone row in the HTML when phone is empty');
  assert.ok(out.text.includes('Telepon  : -'), 'plain text shows a dash placeholder');
});

test('phoneToWhatsApp converts local 0xxx numbers to 62xxx', () => {
  assert.equal(mailer.phoneToWhatsApp('0812-3456-7890'), 'https://wa.me/6281234567890');
  assert.equal(mailer.phoneToWhatsApp('+62 812 3456 7890'), 'https://wa.me/6281234567890');
  assert.equal(mailer.phoneToWhatsApp('12'), null);
});

test('formatWita is UTC+8 and zero-padded', () => {
  assert.equal(mailer.formatWita(new Date(Date.UTC(2026, 0, 1, 0, 0))), '1 Januari 2026, 08:00 WITA (UTC+8)');
  assert.equal(mailer.formatWita(new Date(Date.UTC(2026, 11, 31, 17, 59))), '1 Januari 2027, 01:59 WITA (UTC+8)');
});

// ---------------------------------------------------------------------------
// Send behaviour (injected fake transport — no network)
// ---------------------------------------------------------------------------

test('sendContactEmail without config returns sent:false and names missing keys only', async () => {
  const factory = fakeTransportFactory();
  await withEnv({}, async () => {
    const m = mailer.createMailer({ transportFactory: factory });
    const result = await m.sendContactEmail({ name: 'A', email: 'a@b.com', message: 'long enough message' });
    assert.equal(result.sent, false);
    assert.match(result.error, /EMAIL_HOST, EMAIL_USER, EMAIL_PASS/);
    assert.equal(factory.calls.length, 0, 'no transport must be created without config');
  });
});

test('sendContactEmail passes the built message to the transport on success', async () => {
  const factory = fakeTransportFactory();
  await withEnv(CONFIGURED, async () => {
    const m = mailer.createMailer({ transportFactory: factory, now: () => new Date(Date.UTC(2026, 9, 26, 2, 0)) });
    const result = await m.sendContactEmail({
      name: 'Made', email: 'made@example.com', phone: '0812', message: 'Tolong balas pesan ini.',
    });

    assert.deepEqual(result, { sent: true });
    assert.equal(factory.calls.length, 1);
    const { mail, options } = factory.calls[0];
    assert.equal(mail.to, 'purisunnybali@gmail.com');
    assert.equal(mail.replyTo, 'made@example.com');
    assert.equal(mail.subject, 'Pesan baru dari form website — Made');
    assert.match(mail.from, /admin@purisunnymunduk\.id/);

    // Transport options: timeouts capped so a dead SMTP cannot hang a request.
    assert.equal(options.host, 'smtp.zoho.com');
    assert.equal(options.port, 465);
    assert.equal(options.secure, true);
    assert.equal(options.pool, true);
    assert.ok(options.connectionTimeout <= 15000);
    assert.ok(options.socketTimeout <= 15000);
    assert.ok(options.greetingTimeout <= 15000);
    assert.deepEqual(options.auth, { user: CONFIGURED.EMAIL_USER, pass: CONFIGURED.EMAIL_PASS });
  });
});

test('sendContactEmail never throws: transport errors become { sent:false, error }', async () => {
  const factory = fakeTransportFactory();
  factory.failWith = new Error('connect ECONNREFUSED');
  await withEnv(CONFIGURED, async () => {
    const m = mailer.createMailer({ transportFactory: factory });
    const result = await m.sendContactEmail({ name: 'A', email: 'a@b.com', message: 'long enough message' });
    assert.equal(result.sent, false);
    assert.match(result.error, /ECONNREFUSED/);
  });
});

test('sendContactEmail reports a rejected recipient as not sent', async () => {
  const factory = fakeTransportFactory();
  factory.info = { accepted: [], rejected: ['purisunnybali@gmail.com'] };
  await withEnv(CONFIGURED, async () => {
    const m = mailer.createMailer({ transportFactory: factory });
    const result = await m.sendContactEmail({ name: 'A', email: 'a@b.com', message: 'long enough message' });
    assert.equal(result.sent, false);
    assert.match(result.error, /recipient rejected/);
  });
});

test('transporter is created lazily and reused across sends', async () => {
  let created = 0;
  const fake = fakeTransportFactory();
  const factory = (options) => { created += 1; return fake(options); };
  await withEnv(CONFIGURED, async () => {
    const m = mailer.createMailer({ transportFactory: factory });
    assert.equal(created, 0, 'no transport before the first send');
    await m.sendContactEmail({ name: 'A', email: 'a@b.com', message: 'long enough message' });
    await m.sendContactEmail({ name: 'B', email: 'b@c.com', message: 'long enough message' });
    assert.equal(created, 1, 'transport must be reused');
    assert.equal(fake.calls.length, 2);
    m.resetTransport();
    await m.sendContactEmail({ name: 'C', email: 'c@d.com', message: 'long enough message' });
    assert.equal(created, 2, 'resetTransport forces a fresh transport');
  });
});

test('sendContactEmail swallows errors thrown while building the message', async () => {
  const factory = fakeTransportFactory();
  await withEnv(CONFIGURED, async () => {
    const m = mailer.createMailer({ transportFactory: factory });
    // A payload whose name getter throws exercises the build try/catch.
    const payload = { email: 'a@b.com', message: 'long enough message' };
    Object.defineProperty(payload, 'name', { get() { throw new Error('boom'); } });
    const result = await m.sendContactEmail(payload);
    assert.equal(result.sent, false);
    assert.match(result.error, /boom/);
    assert.equal(factory.calls.length, 0);
  });
});
