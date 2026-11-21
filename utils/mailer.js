// backend/utils/mailer.js
//
// Outgoing mail for the public contact form (POST /api/contact).
//
// Config comes from backend/.env ONLY. No credentials live in this file; the
// defaults below are the non-secret, documented display values that the site
// already publishes (the visitor-facing "from" name and the homestay's public
// Gmail), so the form can be activated later by filling in .env alone.
//
//   EMAIL_HOST      SMTP host                 (required to send)
//   EMAIL_PORT      SMTP port                 (default 465)
//   EMAIL_SECURE    '1'/'true' = TLS on 465   (default: inferred from port)
//   EMAIL_USER      SMTP login                (required to send)
//   EMAIL_PASS      SMTP password/app-password(required to send)
//   EMAIL_FROM      envelope/from address     (default admin@purisunnymunduk.id)
//   EMAIL_FROM_NAME display name              (default Puri Sunny Website)
//   EMAIL_TO        recipient                 (default purisunnybali@gmail.com)
//
// Contract:
//   isEmailConfigured()            -> boolean   (host + user + pass all present)
//   missingEmailConfigKeys()       -> string[]  (KEY NAMES only, never values)
//   verifyEmailConfig()            -> void      (one-line startup status log)
//   sendContactEmail(payload)      -> { sent, error? }   -- never throws
//   sendBookingEmail(lead)         -> { sent, errorCode? } -- never throws
//
// Nothing here opens a socket until the first send (lazy transporter), and the
// transporter is pooled + time-limited so a dead SMTP server can never hold a
// request open (connectionTimeout/socketTimeout/greetingTimeout ~10 s).
//
// Testability: createMailer() accepts a transport factory. Unit tests inject a
// fake (or MODULE-NOT-CONNECTED) transport; production uses the module-level
// singleton, which builds a real nodemailer transport on first use.

const DEFAULT_FROM = 'admin@purisunnymunduk.id';
const DEFAULT_FROM_NAME = 'Puri Sunny Website';
const DEFAULT_TO = 'purisunnybali@gmail.com';
const DEFAULT_PORT = 465;

// Timeouts in milliseconds. A stuck SMTP handshake becomes an error, not a
// hung HTTP request.
const SMTP_TIMEOUT_MS = 10000;

// Keys that must all be present for sending to be considered configured.
// EMAIL_FROM/EMAIL_TO/EMAIL_FROM_NAME have safe defaults and are not required.
const REQUIRED_EMAIL_KEYS = Object.freeze(['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASS']);

// ---------------------------------------------------------------------------
// Config (re-read from process.env on every call so .env changes and tests can
// flip configuration without re-requiring this module)
// ---------------------------------------------------------------------------

function envValue(key) {
  const value = process.env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function emailConfig() {
  const port = Number(envValue('EMAIL_PORT')) || DEFAULT_PORT;
  const secureRaw = envValue('EMAIL_SECURE').toLowerCase();
  // Explicit value wins; otherwise TLS is implied by the usual implicit-TLS
  // port (465). 587/25 stay STARTTLS (secure=false).
  const secure = secureRaw === ''
    ? port === 465
    : secureRaw === '1' || secureRaw === 'true' || secureRaw === 'yes';

  return {
    host: envValue('EMAIL_HOST'),
    port,
    secure,
    user: envValue('EMAIL_USER'),
    pass: process.env.EMAIL_PASS ? String(process.env.EMAIL_PASS) : '', // never trimmed: passwords can end in spaces
    from: envValue('EMAIL_FROM') || DEFAULT_FROM,
    fromName: envValue('EMAIL_FROM_NAME') || DEFAULT_FROM_NAME,
    to: envValue('EMAIL_TO') || DEFAULT_TO,
  };
}

// Missing REQUIRED key NAMES. Only names — never values.
function missingEmailConfigKeys() {
  return REQUIRED_EMAIL_KEYS.filter((key) => !envValue(key));
}

function isEmailConfigured() {
  return missingEmailConfigKeys().length === 0;
}

// One-line startup status. Call once from server.js after env is loaded.
// Logs names only: "contact email: NOT configured (missing: EMAIL_HOST, …)".
function verifyEmailConfig({ logger = console } = {}) {
  const missing = missingEmailConfigKeys();
  if (missing.length === 0) {
    logger.log('contact email: configured');
    return { configured: true, missing };
  }
  logger.warn(`contact email: NOT configured (missing: ${missing.join(', ')})`);
  return { configured: false, missing };
}

// ---------------------------------------------------------------------------
// Rendering helpers (pure — exported for unit tests)
// ---------------------------------------------------------------------------

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

// Escape every value that reaches HTML. Order matters: & first.
function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// WITA = UTC+8, no DST. Formatted without Intl so the output is identical on
// every Node build and in tests ("26 Oktober 2026, 14:05 WITA").
const MONTHS_ID = Object.freeze([
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
]);

function formatWita(date = new Date()) {
  const wita = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${wita.getUTCDate()} ${MONTHS_ID[wita.getUTCMonth()]} ${wita.getUTCFullYear()}, ` +
    `${pad(wita.getUTCHours())}:${pad(wita.getUTCMinutes())} WITA (UTC+8)`;
}

function buildSubject({ name }) {
  // Header-safe: validation already stripped controls, and we trim again here.
  const safeName = String(name || '').replace(/[\r\n]+/g, ' ').trim();
  return `Pesan baru dari form website — ${safeName}`;
}

// tel:/wa.me link for a phone-looking value (digits only for the href).
function phoneToWhatsApp(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 6) return null;
  // Indonesian local numbers (0xxx) become 62xxx for wa.me.
  const international = digits.startsWith('0') ? `62${digits.slice(1)}` : digits;
  return `https://wa.me/${international}`;
}

// Builds { from, to, replyTo, subject, text, html }. Pure.
function buildContactEmail(payload = {}, { config = emailConfig(), now = new Date() } = {}) {
  const name = String(payload.name || '').trim();
  const email = String(payload.email || '').trim();
  const phone = payload.phone ? String(payload.phone).trim() : '';
  const message = String(payload.message || '');
  const sentAt = formatWita(now);

  const subject = buildSubject({ name });
  // `replyTo` is added by the caller only when the address is valid; the owner
  // can hit Reply and answer the visitor directly.
  const replyTo = email;

  const waHref = phone ? phoneToWhatsApp(phone) : null;

  // ---- plain text -------------------------------------------------------
  const textLines = [
    'Pesan baru dari form kontak website Puri Sunny.',
    '',
    `Nama     : ${name}`,
    `Email    : ${email}`,
    `Telepon  : ${phone || '-'}`,
    `Waktu    : ${sentAt}`,
    `Sumber   : Form kontak website purisunnymunduk.id`,
    '',
    'Pesan:',
    '----------------------------------------',
    message,
    '----------------------------------------',
    '',
    'Balas email ini untuk menjawab langsung ke pengirim.',
  ];
  const text = textLines.join('\n');

  // ---- HTML -------------------------------------------------------------
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePhone = escapeHtml(phone);
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
  const safeSentAt = escapeHtml(sentAt);

  const phoneRow = phone
    ? `
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Telepon</td>
          <td style="padding:4px 0;">${
            waHref
              ? `<a href="${escapeHtml(waHref)}" style="color:#166534;text-decoration:none;">${safePhone}</a>`
              : safePhone
          }</td>
        </tr>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:24px;background:#f5f3ee;font-family:Arial,Helvetica,sans-serif;color:#2b2b2b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e1d8;border-radius:6px;">
    <tr>
      <td style="padding:20px 24px;background:#166534;color:#ffffff;border-radius:6px 6px 0 0;">
        <strong style="font-size:16px;">Pesan baru dari form website</strong><br>
        <span style="font-size:12px;opacity:.85;">Puri Sunny &mdash; purisunnymunduk.id</span>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6;">
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Nama</td>
          <td style="padding:4px 0;">${safeName}</td>
        </tr>
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Email</td>
          <td style="padding:4px 0;"><a href="mailto:${safeEmail}" style="color:#166534;text-decoration:none;">${safeEmail}</a></td>
        </tr>${phoneRow}
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Waktu</td>
          <td style="padding:4px 0;">${safeSentAt}</td>
        </tr>
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Sumber</td>
          <td style="padding:4px 0;">Form kontak website purisunnymunduk.id</td>
        </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:0 24px 20px;">
        <div style="border-top:1px solid #e5e1d8;padding-top:16px;font-size:14px;line-height:1.7;white-space:normal;">${safeMessage}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:14px 24px;background:#f9f8f4;border-top:1px solid #e5e1d8;font-size:12px;color:#6b7280;border-radius:0 0 6px 6px;">
        Balas email ini untuk menjawab langsung ke pengirim.
      </td>
    </tr>
  </table>
</body>
</html>`;

  const fromAddress = `"${config.fromName.replace(/["\\]/g, '')}" <${config.from}>`;

  return {
    from: fromAddress,
    to: config.to,
    replyTo,
    subject,
    text,
    html,
  };
}

// ---------------------------------------------------------------------------
// Booking inquiry email (new tracking flow)
// ---------------------------------------------------------------------------

// Header-safe booking subject. Same guard as buildSubject: validation already
// stripped controls, but the builder may also be called with a raw DB row.
function buildBookingSubject({ name }) {
  const safeName = String(name || '').replace(/[\r\n]+/g, ' ').trim();
  return `Booking Inquiry — ${safeName}`;
}

// Builds { from, to, replyTo, subject, text, html }. Pure.
// Includes the structured stay details the owner needs to answer without
// opening the admin dashboard. Every value that reaches HTML is escaped.
function buildBookingEmail(lead = {}, { config = emailConfig() } = {}) {
  const name = String(lead.name || '').trim();
  const email = String(lead.email || '').trim();
  const phone = lead.phone ? String(lead.phone).trim() : '';
  const checkIn = String(lead.check_in || '').trim();
  const checkOut = String(lead.check_out || '').trim();
  const guests = lead.guests === undefined || lead.guests === null ? '' : String(lead.guests);
  const room = lead.room_slug ? String(lead.room_slug).trim() : '';
  const sourcePage = lead.source_page ? String(lead.source_page).trim() : '';
  const message = String(lead.message || '');

  const subject = buildBookingSubject({ name });

  // ---- plain text -------------------------------------------------------
  const textLines = [
    'Booking inquiry from the Puri Sunny website.',
    '',
    `Nama       : ${name}`,
    `Email      : ${email || '-'}`,
    `Telepon    : ${phone || '-'}`,
    `Check-in   : ${checkIn}`,
    `Check-out  : ${checkOut}`,
    `Tamu       : ${guests}`,
    `Kamar      : ${room || '-'}`,
    `Halaman    : ${sourcePage || '-'}`,
    '',
    'Pesan:',
    '----------------------------------------',
    message,
    '----------------------------------------',
    '',
    'Balas email ini untuk menjawab langsung ke tamu.',
  ];
  const text = textLines.join('\n');

  // ---- HTML -------------------------------------------------------------
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePhone = escapeHtml(phone);
  const safeCheckIn = escapeHtml(checkIn);
  const safeCheckOut = escapeHtml(checkOut);
  const safeGuests = escapeHtml(guests);
  const safeRoom = escapeHtml(room || '-');
  const safeSourcePage = escapeHtml(sourcePage || '-');
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');

  const phoneRow = phone
    ? `
          <tr>
            <td style="padding:4px 12px 4px 0;color:#6b7280;">Telepon</td>
            <td style="padding:4px 0;">${safePhone}</td>
          </tr>`
    : '';
  const emailRow = email
    ? `<a href="mailto:${safeEmail}" style="color:#166534;text-decoration:none;">${safeEmail}</a>`
    : '-';

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:24px;background:#f5f3ee;font-family:Arial,Helvetica,sans-serif;color:#2b2b2b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e1d8;border-radius:6px;">
    <tr>
      <td style="padding:20px 24px;background:#166534;color:#ffffff;border-radius:6px 6px 0 0;">
        <strong style="font-size:16px;">Booking inquiry</strong><br>
        <span style="font-size:12px;opacity:.85;">Puri Sunny &mdash; purisunnymunduk.id</span>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6;">
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Nama</td>
          <td style="padding:4px 0;">${safeName}</td>
        </tr>
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Email</td>
          <td style="padding:4px 0;">${emailRow}</td>
        </tr>${phoneRow}
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Check-in</td>
          <td style="padding:4px 0;">${safeCheckIn}</td>
        </tr>
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Check-out</td>
          <td style="padding:4px 0;">${safeCheckOut}</td>
        </tr>
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Tamu</td>
          <td style="padding:4px 0;">${safeGuests}</td>
        </tr>
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Kamar</td>
          <td style="padding:4px 0;">${safeRoom}</td>
        </tr>
        <tr>
          <td style="padding:4px 12px 4px 0;color:#6b7280;">Halaman</td>
          <td style="padding:4px 0;">${safeSourcePage}</td>
        </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:0 24px 20px;">
        <div style="border-top:1px solid #e5e1d8;padding-top:16px;font-size:14px;line-height:1.7;white-space:normal;">${safeMessage}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:14px 24px;background:#f9f8f4;border-top:1px solid #e5e1d8;font-size:12px;color:#6b7280;border-radius:0 0 6px 6px;">
        Balas email ini untuk menjawab langsung ke tamu.
      </td>
    </tr>
  </table>
</body>
</html>`;

  const fromAddress = `"${config.fromName.replace(/["\\]/g, '')}" <${config.from}>`;

  return {
    from: fromAddress,
    to: config.to,
    replyTo: email || undefined,
    subject,
    text,
    html,
  };
}

// ---------------------------------------------------------------------------
// Transporter (lazy, pooled, time-limited)
// ---------------------------------------------------------------------------

// Factory indirection so tests can inject a fake. Default builds a real one.
function defaultTransportFactory(options) {
  // require() lazily: unit tests that never send do not need nodemailer loaded.
  const nodemailer = require('nodemailer'); // eslint-disable-line global-require
  return nodemailer.createTransport(options);
}

// Creates an isolated mailer instance. The module-level singleton below is what
// the routes use; tests call createMailer() with their own factory.
function createMailer({ transportFactory = defaultTransportFactory, now = () => new Date() } = {}) {
  let transport = null;
  // Config is pinned when the transport is built, so the `auth` and the
  // `from`/`to` of every message come from the same snapshot. A config change
  // therefore requires resetTransport() — which is exactly what the test
  // utility and a future reload hook do.
  let transportConfig = null;

  function getTransport() {
    if (transport) return transport;
    const config = emailConfig();
    transport = transportFactory({
      host: config.host,
      port: config.port,
      secure: config.secure,
      pool: true, // reuse the connection across messages
      maxConnections: 2,
      maxMessages: 50,
      connectionTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      auth: { user: config.user, pass: config.pass },
    });
    transportConfig = config;
    return transport;
  }

  // Allows tests (and a future config reload) to drop the pooled connection.
  function resetTransport() {
    if (transport && typeof transport.close === 'function') {
      try { transport.close(); } catch { /* best effort */ }
    }
    transport = null;
    transportConfig = null;
  }

  /**
   * Send one contact-form message to EMAIL_TO.
   * Never throws; resolves { sent: false, error } on any failure.
   * Caller must check isEmailConfigured() first — an unconfigured mailer
   * returns { sent: false, error: 'email not configured (…) ' } without trying.
   */
  async function sendContactEmail(payload) {
    const missing = missingEmailConfigKeys();
    if (missing.length > 0) {
      return { sent: false, error: `email not configured (missing: ${missing.join(', ')})` };
    }

    let mail;
    try {
      getTransport(); // pins the config snapshot used for rendering
      mail = buildContactEmail(payload, { config: transportConfig, now: now() });
    } catch (err) {
      return { sent: false, error: err && err.message ? err.message : 'could not build message' };
    }

    try {
      const info = await getTransport().sendMail(mail);
      // Rejected recipients arrive without throwing on some transports.
      const rejected = info && Array.isArray(info.rejected) ? info.rejected : [];
      const accepted = info && Array.isArray(info.accepted) ? info.accepted : [];
      if (rejected.includes(mail.to) && !accepted.includes(mail.to)) {
        return { sent: false, error: 'recipient rejected by SMTP server' };
      }
      return { sent: true };
    } catch (err) {
      // Log the SMTP error server-side only; the route returns a generic body.
      console.error('Contact email send failed:', err && err.message ? err.message : err);
      return { sent: false, error: err && err.message ? err.message : 'send failed' };
    }
  }

  /**
   * Send one booking-inquiry email to EMAIL_TO.
   * Never throws; resolves { sent: true } or { sent: false, errorCode }.
   * `errorCode` is the raw nodemailer code; the booking service whitelists it
   * before anything reaches the database. No error message is returned.
   */
  async function sendBookingEmail(lead) {
    const missing = missingEmailConfigKeys();
    if (missing.length > 0) {
      return { sent: false, errorCode: 'UNKNOWN' };
    }

    let mail;
    try {
      getTransport(); // pins the config snapshot used for rendering
      mail = buildBookingEmail(lead, { config: transportConfig });
    } catch (err) {
      return { sent: false, errorCode: err && err.code ? String(err.code) : 'UNKNOWN' };
    }

    try {
      const info = await getTransport().sendMail(mail);
      // Rejected recipients arrive without throwing on some transports.
      const rejected = info && Array.isArray(info.rejected) ? info.rejected : [];
      const accepted = info && Array.isArray(info.accepted) ? info.accepted : [];
      if (rejected.includes(mail.to) && !accepted.includes(mail.to)) {
        return { sent: false, errorCode: 'EENVELOPE' };
      }
      return { sent: true };
    } catch (err) {
      // Server-side log only, and only the code: never the SMTP message (it can
      // contain hostnames, credentials hints and recipient addresses).
      console.error('Booking email send failed:', err && err.code ? String(err.code) : 'UNKNOWN');
      return { sent: false, errorCode: err && err.code ? String(err.code) : 'UNKNOWN' };
    }
  }

  return { sendContactEmail, sendBookingEmail, resetTransport, getTransport };
}

// Module-level singleton used by routes/contact.js and scripts/send-test-email.js.
const mailer = createMailer();

module.exports = {
  DEFAULT_FROM,
  DEFAULT_FROM_NAME,
  DEFAULT_TO,
  DEFAULT_PORT,
  SMTP_TIMEOUT_MS,
  REQUIRED_EMAIL_KEYS,
  emailConfig,
  missingEmailConfigKeys,
  isEmailConfigured,
  verifyEmailConfig,
  escapeHtml,
  formatWita,
  buildSubject,
  phoneToWhatsApp,
  buildContactEmail,
  buildBookingSubject,
  buildBookingEmail,
  createMailer,
  sendContactEmail: mailer.sendContactEmail,
  sendBookingEmail: mailer.sendBookingEmail,
  resetTransport: mailer.resetTransport,
};
