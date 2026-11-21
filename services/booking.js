// backend/services/booking.js
//
// Business logic for booking-lead tracking. Express-free: routes keep the rate
// limiters, authentication and HTTP translation.
//
// The row is written first and is the source of truth. Email delivery is a
// separate state machine so a dead SMTP server can never lose a lead:
//
//   pending -> sending -> sent | failed
//
// The transition to `sending` is atomic and doubles as the concurrency guard:
// only one worker can claim a row, and a stale `sending` row is reclaimable
// after 10 minutes. Retries use the same claim, so two admin clicks cannot send
// the same email twice.
//
// Privacy: only whitelisted error codes and the fixed label
// "Email delivery failed" are persisted. Raw SMTP messages, hostnames and
// recipient addresses never reach the database.

const realDb = require('../config/db');
const { isDuplicateEntry } = require('../utils/validate');
const {
  validateBooking,
  validateBookingStatus,
  CHANNELS,
  STATUSES,
  EVENTS,
} = require('../utils/validateBooking');
const mailerUtils = require('../utils/mailer');
const { httpError } = require('./errors');

// DATE_FORMAT keeps check_in/check_out as plain YYYY-MM-DD strings in API
// responses regardless of the mysql2 date conversion of the day.
const LEAD_COLUMNS = [
  'id', 'name', 'email', 'phone',
  "DATE_FORMAT(check_in, '%Y-%m-%d') AS check_in",
  "DATE_FORMAT(check_out, '%Y-%m-%d') AS check_out",
  'guests', 'room_slug', 'message', 'first_message', 'channel', 'status',
  'source_page', 'client_ref', 'email_status', 'email_sent_at',
  'email_attempts', 'email_last_attempt_at', 'email_error_code', 'email_error',
  'created_at', 'updated_at',
].join(', ');

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const MAX_EVENT_BATCH = 100;
const EMAIL_CLAIM_TIMEOUT_MINUTES = 10;
const EMAIL_ERROR_LABEL = 'Email delivery failed';

// The only nodemailer codes that may be stored. Anything else collapses to
// UNKNOWN so a future transport cannot leak arbitrary text into the column.
const EMAIL_ERROR_CODES = Object.freeze([
  'EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'EENVELOPE', 'ESOCKET',
]);

// Atomic claim: pending/failed rows are claimable, and a `sending` row older
// than the timeout is treated as abandoned by a crashed worker.
const CLAIM_SQL = `
  UPDATE booking_leads
     SET email_status = 'sending',
         email_attempts = email_attempts + 1,
         email_last_attempt_at = NOW()
   WHERE id = ?
     AND (
       email_status IN ('pending', 'failed')
       OR (email_status = 'sending'
           AND email_last_attempt_at < NOW() - INTERVAL ${EMAIL_CLAIM_TIMEOUT_MINUTES} MINUTE)
     )
`;

let db = realDb;

// The mailer the service uses. Production always uses the shared singleton;
// tests swap it for a fake via __setMailerForTests (refused in production).
let mailer = mailerUtils;

function __setDbForTests(fake) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setDbForTests is not available in production');
  }
  if (fake === null || fake === undefined) {
    db = realDb;
    return;
  }
  if (typeof fake.query !== 'function') {
    throw new Error('db fake must expose query()');
  }
  db = fake;
}

// Test-only seam. Tests must never open an SMTP socket, so they inject a fake
// with the same shape as utils/mailer. Deliberately refuses to run in
// production: a stray call there could disable real delivery.
function __setMailerForTests(fake) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setMailerForTests is not available in production');
  }
  if (fake === null || fake === undefined) {
    mailer = mailerUtils;
    return;
  }
  if (typeof fake.sendBookingEmail !== 'function') {
    throw new Error('mailer fake must expose sendBookingEmail()');
  }
  mailer = { sendBookingEmail: fake.sendBookingEmail };
}

function sanitizeEmailErrorCode(raw) {
  const code = typeof raw === 'string' ? raw.trim() : '';
  return EMAIL_ERROR_CODES.includes(code) ? code : 'UNKNOWN';
}

// Display labels for the real rooms. room_slug is a URL-safe key, not customer
// copy, so it must be humanised before it reaches the WhatsApp message.
const ROOM_LABELS = Object.freeze({
  'deluxe-room': 'Deluxe Room',
  'superior-room': 'Superior Room',
  'standard-double': 'Standard Double',
  'standard-twin': 'Standard Twin',
  'standard-camp': 'Standard Camp',
  'family-camp': 'Family Camp',
});

// Customer-facing labels for the pages that can send a question lead. Raw
// route paths are not suitable for a WhatsApp message.
const SOURCE_PAGE_LABELS = Object.freeze({
  '/': 'Home',
  '/our-story': 'Our Story',
  '/stay': 'Stay',
  '/stay/guest-house': 'Guest House',
  '/stay/camp': 'Camp',
  '/stay/rooms/deluxe-room': 'Deluxe Room',
  '/stay/rooms/superior-room': 'Superior Room',
  '/stay/rooms/standard-double': 'Standard Double',
  '/stay/rooms/standard-twin': 'Standard Twin',
  '/stay/rooms/standard-camp': 'Standard Camp',
  '/stay/rooms/family-camp': 'Family Camp',
  '/rooms': 'Rooms',
  '/experience': 'Experience',
  '/explore-munduk': 'Explore Munduk',
  '/gallery': 'Gallery',
  '/reviews': 'Reviews',
  '/journal': 'Journal',
  '/contact': 'Contact',
});

// Unknown paths become a readable title, e.g. "/local-tips" -> "Local Tips".
function humanizeSourcePage(sourcePage) {
  if (typeof sourcePage !== 'string' || sourcePage.trim() === '') return 'our website';

  const path = sourcePage.trim();
  if (SOURCE_PAGE_LABELS[path]) return SOURCE_PAGE_LABELS[path];

  const text = path
    .replace(/^\/+/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return 'our website';

  return text
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function humanizeRoomSlug(roomSlug) {
  if (typeof roomSlug !== 'string' || roomSlug.trim() === '') return null;

  const slug = roomSlug.trim();
  if (ROOM_LABELS[slug]) return ROOM_LABELS[slug];

  const words = slug.split('-').filter(Boolean);
  if (words.length === 0) return null;

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Server-built canonical first message. The client never supplies this, so the
// WhatsApp hand-off and the stored copy always agree.
function buildFirstMessage(values) {
  if (values.channel === 'question') {
    const source = values.source_page
      ? ` from the ${humanizeSourcePage(values.source_page)} page`
      : '';
    return `Hello Puri Sunny, I have a question${source}.\n${values.message}`;
  }

  const room = humanizeRoomSlug(values.room_slug) || 'a stay';
  return `Hello Puri Sunny, I would like to book ${room} from ${values.check_in} ` +
    `to ${values.check_out} for ${values.guests} guest(s).\n${values.message}`;
}

function parsePositiveInteger(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return value;
}

function enumFilter(raw, allowed, field) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).trim();
  if (!allowed.includes(value)) {
    const message = `${field} must be one of: ${allowed.join(', ')}`;
    throw httpError(400, { message, errors: [message] });
  }
  return value;
}

// GET /api/booking/leads — admin/editor inbox list.
async function listLeads(filters = {}) {
  const status = enumFilter(filters.status, STATUSES, 'status');
  const channel = enumFilter(filters.channel, CHANNELS, 'channel');
  const emailStatus = enumFilter(
    filters.email_status,
    ['not_required', 'pending', 'sending', 'sent', 'failed'],
    'email_status'
  );
  const q = typeof filters.q === 'string' ? filters.q.trim().slice(0, 100) : '';

  const page = parsePositiveInteger(filters.page, 1);
  const perPage = Math.min(parsePositiveInteger(filters.per_page, PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX);
  const offset = (page - 1) * perPage;

  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (channel) { where.push('channel = ?'); params.push(channel); }
  if (emailStatus) { where.push('email_status = ?'); params.push(emailStatus); }
  if (q) {
    where.push('(name LIKE ? OR email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await db.query(
    `SELECT ${LEAD_COLUMNS} FROM booking_leads ${whereSql}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, perPage, offset]
  );
  const [filtered] = await db.query(
    `SELECT COUNT(*) AS total FROM booking_leads ${whereSql}`,
    params
  );
  // Counts are table-wide so the dashboard badges stay meaningful while a
  // filter is active.
  const [counts] = await db.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count
       FROM booking_leads`
  );

  const summary = (counts && counts[0]) || {};
  const total = Number((filtered && filtered[0] && filtered[0].total)) || 0;

  return {
    items: rows || [],
    total,
    page,
    per_page: perPage,
    total_pages: Math.ceil(total / perPage) || 0,
    counts: {
      new: Number(summary.new_count) || 0,
      total: Number(summary.total) || 0,
    },
  };
}

// Row or null. The route maps null to 404.
async function getLead(id) {
  const [rows] = await db.query(
    `SELECT ${LEAD_COLUMNS} FROM booking_leads WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows && rows[0] ? rows[0] : null;
}

// One delivery attempt with the atomic claim. Returns { lead, emailSent }.
async function attemptEmail(id) {
  const [claim] = await db.query(CLAIM_SQL, [id]);
  if (!claim || Number(claim.affectedRows) === 0) {
    // Already sent, or another worker holds a fresh `sending` claim.
    return { lead: await getLead(id), emailSent: false };
  }

  const lead = await getLead(id);
  if (!lead) return { lead: null, emailSent: false };

  let result;
  try {
    result = await mailer.sendBookingEmail(lead);
  } catch {
    // A mailer must never break the request; treat it as an unknown failure.
    result = { sent: false, errorCode: 'UNKNOWN' };
  }

  if (result && result.sent) {
    await db.query(
      `UPDATE booking_leads
          SET email_status = 'sent',
              email_sent_at = NOW(),
              email_error = NULL,
              email_error_code = NULL
        WHERE id = ?`,
      [id]
    );
    return { lead: await getLead(id), emailSent: true };
  }

  await db.query(
    `UPDATE booking_leads
        SET email_status = 'failed',
            email_error_code = ?,
            email_error = ?
      WHERE id = ?`,
    [sanitizeEmailErrorCode(result && result.errorCode), EMAIL_ERROR_LABEL, id]
  );
  return { lead: await getLead(id), emailSent: false };
}

// POST /api/booking/leads — public.
// A duplicate client_ref resolves to the existing row and never sends again.
async function createLead(payload = {}) {
  const { errors, values } = validateBooking(payload);
  if (errors.length > 0) {
    throw httpError(400, { message: errors[0], errors });
  }

  const firstMessage = buildFirstMessage(values);
  const emailStatus = values.channel === 'email' ? 'pending' : 'not_required';

  let insertId;
  try {
    const [result] = await db.query(
      `INSERT INTO booking_leads
        (name, email, phone, check_in, check_out, guests, room_slug, message,
         first_message, channel, source_page, client_ref, email_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.name,
        values.email,
        values.phone,
        values.check_in,
        values.check_out,
        values.guests,
        values.room_slug,
        values.message,
        firstMessage,
        values.channel,
        values.source_page,
        values.client_ref,
        emailStatus,
      ]
    );
    insertId = result.insertId;
  } catch (error) {
    // Idempotent submission: the UNIQUE client_ref is the only non-PK unique
    // key, so a duplicate means we already have this lead.
    if (isDuplicateEntry(error) && values.client_ref) {
      const [rows] = await db.query(
        `SELECT ${LEAD_COLUMNS} FROM booking_leads WHERE client_ref = ? LIMIT 1`,
        [values.client_ref]
      );
      if (rows && rows[0]) {
        return { lead: rows[0], emailSent: false };
      }
    }
    throw error;
  }

  if (values.channel === 'email') {
    return attemptEmail(insertId);
  }

  return { lead: await getLead(insertId), emailSent: false };
}

// PATCH /api/booking/leads/:id — status only.
async function updateLeadStatus(id, status) {
  const checked = validateBookingStatus(status);
  if (checked.errors.length > 0) {
    throw httpError(400, { message: checked.errors[0], errors: checked.errors });
  }

  const existing = await getLead(id);
  if (!existing) throw httpError(404, { message: 'Booking lead not found' });

  await db.query('UPDATE booking_leads SET status = ? WHERE id = ?', [checked.value, id]);
  return getLead(id);
}

// DELETE /api/booking/leads/:id — admin only, hard delete.
async function removeLead(id) {
  const [result] = await db.query('DELETE FROM booking_leads WHERE id = ?', [id]);
  if (!result || Number(result.affectedRows) === 0) {
    throw httpError(404, { message: 'Booking lead not found' });
  }
  return { id };
}

// POST /api/booking/leads/:id/resend-email — admin/editor.
// Uses the same claim as the initial send, so sent/actively-sending rows are
// not duplicated. Returns the refreshed lead.
async function resendLeadEmail(id) {
  const existing = await getLead(id);
  if (!existing) throw httpError(404, { message: 'Booking lead not found' });
  if (existing.channel !== 'email') {
    throw httpError(400, {
      message: 'Email resend is only available for email-channel leads',
      errors: ['Email resend is only available for email-channel leads'],
    });
  }

  const { lead } = await attemptEmail(id);
  if (!lead) throw httpError(404, { message: 'Booking lead not found' });
  return lead;
}

function optionalEventText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > maxLength) return null;
  return trimmed;
}

function optionalLeadId(value) {
  if (
    (typeof value === 'number' && Number.isInteger(value) && value > 0)
    || (typeof value === 'string' && /^\d+$/.test(value.trim()))
  ) {
    const parsed = Number(typeof value === 'string' ? value.trim() : value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

// POST /api/booking/events — public tracking.
// Accepts an object or an array. Invalid entries are dropped silently and the
// call never throws (tracking must never break the page).
async function recordEvents(payload) {
  const items = Array.isArray(payload) ? payload.slice(0, MAX_EVENT_BATCH) : [payload];
  const rows = [];

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const event = typeof item.event === 'string' ? item.event.trim() : '';
    if (!EVENTS.includes(event)) continue;

    rows.push([
      event,
      optionalEventText(item.source_page, 255),
      optionalEventText(item.room_slug, 100),
      optionalEventText(item.session_id, 64),
      optionalLeadId(item.lead_id),
    ]);
  }

  if (rows.length === 0) return { inserted: 0 };

  const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
  try {
    const [result] = await db.query(
      `INSERT INTO booking_events (event, source_page, room_slug, session_id, lead_id)
       VALUES ${placeholders}`,
      rows.flat()
    );
    return { inserted: Number(result && result.affectedRows) || rows.length };
  } catch (error) {
    // Anonymous tracking is best-effort. Log the code only (never the values).
    console.error('Record booking events error:', error && error.code ? error.code : 'UNKNOWN');
    return { inserted: 0 };
  }
}

// GET /api/booking/stats?days=7
async function stats(rawDays = 7) {
  const parsed = Number(rawDays);
  const days = Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : 7;

  const [leadRows] = await db.query(
    `SELECT
       COUNT(*) AS total_leads,
       SUM(created_at >= NOW() - INTERVAL ? DAY) AS total_window,
       SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_leads,
       SUM(status = 'new' AND created_at >= NOW() - INTERVAL ? DAY) AS new_window,
       SUM(CASE WHEN channel = 'whatsapp' THEN 1 ELSE 0 END) AS whatsapp_leads,
       SUM(channel = 'whatsapp' AND created_at >= NOW() - INTERVAL ? DAY) AS whatsapp_window,
       SUM(CASE WHEN channel = 'email' THEN 1 ELSE 0 END) AS email_leads,
       SUM(channel = 'email' AND created_at >= NOW() - INTERVAL ? DAY) AS email_window,
       SUM(CASE WHEN channel = 'question' THEN 1 ELSE 0 END) AS question_leads,
       SUM(channel = 'question' AND created_at >= NOW() - INTERVAL ? DAY) AS question_window,
       SUM(CASE WHEN email_status = 'failed' THEN 1 ELSE 0 END) AS failed_emails,
       SUM(email_status = 'failed'
           AND email_last_attempt_at >= NOW() - INTERVAL ? DAY) AS failed_window
     FROM booking_leads`,
    [days, days, days, days, days, days]
  );

  const [eventRows] = await db.query(
    `SELECT
       SUM(CASE WHEN event = 'wa_click' THEN 1 ELSE 0 END) AS wa_clicks,
       SUM(event = 'wa_click' AND created_at >= NOW() - INTERVAL ? DAY) AS wa_window,
       SUM(CASE WHEN event = 'email_click' THEN 1 ELSE 0 END) AS email_clicks,
       SUM(event = 'email_click' AND created_at >= NOW() - INTERVAL ? DAY) AS email_window
     FROM booking_events`,
    [days, days]
  );

  const leads = (leadRows && leadRows[0]) || {};
  const events = (eventRows && eventRows[0]) || {};
  const n = (value) => Number(value) || 0;

  return {
    days,
    totalLeads: n(leads.total_window),
    newLeads: n(leads.new_window),
    whatsappLeads: n(leads.whatsapp_window),
    emailLeads: n(leads.email_window),
    questionLeads: n(leads.question_window),
    waClicks: n(events.wa_window),
    emailClicks: n(events.email_window),
    failedEmails: n(leads.failed_window),
    all_time: {
      totalLeads: n(leads.total_leads),
      newLeads: n(leads.new_leads),
      whatsappLeads: n(leads.whatsapp_leads),
      emailLeads: n(leads.email_leads),
      questionLeads: n(leads.question_leads),
      waClicks: n(events.wa_clicks),
      emailClicks: n(events.email_clicks),
      failedEmails: n(leads.failed_emails),
    },
  };
}

module.exports = {
  EMAIL_ERROR_LABEL,
  CLAIM_SQL,
  buildFirstMessage,
  sanitizeEmailErrorCode,
  createLead,
  listLeads,
  getLead,
  updateLeadStatus,
  removeLead,
  resendLeadEmail,
  recordEvents,
  stats,
  __setDbForTests,
  __setMailerForTests,
};
