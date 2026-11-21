// backend/services/contacts.js
//
// Business logic for the public contact form and the admin inbox.
// Express-free: routes keep the rate limiter and translate thrown errors.
//
// The DB row is ALWAYS written before the mail is attempted: `contacts` is the
// backup, so a dropped message is still visible in the admin dashboard even when
// SMTP is down. The response never claims success unless the mail actually left.

const realDb = require('../config/db');
const { validateContact } = require('../utils/validateContact');
const mailerUtils = require('../utils/mailer');
const { httpError } = require('./errors');

const DELIVERY_FAILED_MESSAGE =
  'We could not deliver your message right now. Please contact us via WhatsApp.';

// Admin inbox: columns returned to the dashboard, and the hard cap for ?limit.
// A dashboard panel never needs more than this in one payload.
const CONTACT_COLUMNS = 'id, name, email, phone, message, is_read, created_at';
const CONTACT_LIMIT_MAX = 100;
const CONTACT_PAGE_SIZE_DEFAULT = 20;
const CONTACT_PAGE_SIZE_MAX = 100;

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
  if (typeof fake.sendContactEmail !== 'function') {
    throw new Error('mailer fake must expose sendContactEmail()');
  }
  mailer = {
    sendContactEmail: fake.sendContactEmail,
    // Fall back to the real config check unless the fake provides its own.
    isEmailConfigured: fake.isEmailConfigured || mailerUtils.isEmailConfigured,
    missingEmailConfigKeys: fake.missingEmailConfigKeys || mailerUtils.missingEmailConfigKeys,
  };
}

// Parse ?limit. Returns { limit: null } when absent (all rows), { limit: n } when
// valid (clamped to 1..100), or { error } when the value is not an integer.
function parseContactLimit(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { limit: null };
  }
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) {
    return { error: 'limit must be an integer' };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return { error: 'limit must be an integer' };
  }
  return { limit: Math.min(Math.max(value, 1), CONTACT_LIMIT_MAX) };
}

// GET /api/contacts — admin only. Dashboard "Recent Contacts" panel plus the
// totals the statistics cards read. Two statements: the page and the counts.
async function list(rawLimit) {
  const parsed = parseContactLimit(rawLimit);
  if (parsed.error) {
    throw httpError(400, { message: parsed.error, errors: [parsed.error] });
  }

  const listSql = `SELECT ${CONTACT_COLUMNS} FROM contacts ORDER BY created_at DESC, id DESC`;
  // LIMIT is bound as a number, not spliced into the SQL text.
  const listArgs = parsed.limit === null ? [] : [parsed.limit];

  const [rows] = await db.query(
    parsed.limit === null ? listSql : `${listSql} LIMIT ?`,
    listArgs
  );
  const [counts] = await db.query(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread FROM contacts'
  );

  const summary = counts[0] || {};
  return {
    contacts: rows,
    // SUM() is NULL on an empty table; COUNT(*) is always a number.
    total: Number(summary.total) || 0,
    unread: Number(summary.unread) || 0,
  };
}

function parsePositiveInteger(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return value;
}

function isTruthyFlag(raw) {
  return raw === true || raw === 1 || raw === '1'
    || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
}

function isFalsyFlag(raw) {
  return raw === false || raw === 0 || raw === '0'
    || (typeof raw === 'string' && raw.trim().toLowerCase() === 'false');
}

// Paginated inbox for the Agent API. Deterministic order matches list():
// created_at DESC, id DESC. `total` is the filtered count; `unread` always
// counts unread rows across the whole table so the badge stays meaningful when
// the caller filters to unread only.
async function listPage({ page, per_page: perPage, unread } = {}) {
  const currentPage = parsePositiveInteger(page, 1);
  const pageSize = Math.min(parsePositiveInteger(perPage, CONTACT_PAGE_SIZE_DEFAULT), CONTACT_PAGE_SIZE_MAX);
  const onlyUnread = isTruthyFlag(unread);
  const where = onlyUnread ? 'WHERE is_read = 0' : '';
  const offset = (currentPage - 1) * pageSize;

  const [rows] = await db.query(
    `SELECT ${CONTACT_COLUMNS} FROM contacts ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );
  const [counts] = await db.query(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread FROM contacts'
  );

  const summary = counts[0] || {};
  const totalAll = Number(summary.total) || 0;
  const unreadAll = Number(summary.unread) || 0;
  const total = onlyUnread ? unreadAll : totalAll;

  return {
    items: rows,
    total,
    unread: unreadAll,
    page: currentPage,
    per_page: pageSize,
    total_pages: Math.ceil(total / pageSize) || 0,
  };
}

// GET /api/agent/v1/contacts/:id — row or null (the route maps null to 404).
async function get(id) {
  const [rows] = await db.query(
    `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows && rows[0] ? rows[0] : null;
}

// PATCH is_read only. Accepts boolean, 0/1 and their string forms. A missing
// row answers 404; an unchanged value still succeeds because the row exists.
async function setRead(id, isRead) {
  let value;
  if (isTruthyFlag(isRead)) value = 1;
  else if (isFalsyFlag(isRead)) value = 0;
  else {
    throw httpError(400, {
      message: 'is_read must be a boolean (true/false) or 0/1',
      errors: ['is_read must be a boolean (true/false) or 0/1'],
    });
  }

  const existing = await get(id);
  if (!existing) throw httpError(404, { message: 'Contact not found' });

  await db.query('UPDATE contacts SET is_read = ? WHERE id = ?', [value, id]);
  return get(id);
}

// DELETE /api/agent/v1/contacts/:id — hard delete.
async function remove(id) {
  const [result] = await db.query('DELETE FROM contacts WHERE id = ?', [id]);
  if (!result || Number(result.affectedRows) === 0) {
    throw httpError(404, { message: 'Contact not found' });
  }
  return { id };
}

// POST /api/contact — public, store the submission and email the homestay.
// Returns { emailSent: true } or { emailSent: false }; the route maps that to
// the existing 201 / 502 response bodies.
async function create(body = {}) {
  const { errors, values } = validateContact(body);
  if (errors.length > 0) {
    throw httpError(400, { message: errors[0], errors });
  }

  let contactId;
  try {
    const [result] = await db.query(
      'INSERT INTO contacts (name, email, phone, message) VALUES (?, ?, ?, ?)',
      [values.name, values.email, values.phone, values.message]
    );
    contactId = result.insertId;
  } catch (error) {
    // The row could not be stored: nothing is backed up, so do NOT try to mail
    // (the owner would then have no record to reply from the dashboard).
    console.error('Contact insert error:', error);
    throw httpError(500, { message: 'Server error' });
  }

  // The row is safely stored; now attempt delivery when SMTP is configured.
  // `sendContactEmail` never throws and re-checks configuration itself.
  const result = await mailer.sendContactEmail({
    name: values.name,
    email: values.email,
    phone: values.phone,
    message: values.message,
  });

  if (result.sent) {
    return { emailSent: true, contactId };
  }

  // Not configured (interim) or SMTP failed: the row is kept, the visitor is
  // routed to WhatsApp. Log the id so the owner can find the message later.
  if (mailer.isEmailConfigured()) {
    console.error(`Contact ${contactId}: stored but email delivery failed — ${result.error || 'unknown error'}`);
  } else {
    console.warn(`Contact ${contactId}: stored, email not configured (missing: ${mailer.missingEmailConfigKeys().join(', ')})`);
  }

  return { emailSent: false, contactId };
}

module.exports = {
  DELIVERY_FAILED_MESSAGE,
  CONTACT_LIMIT_MAX,
  CONTACT_PAGE_SIZE_DEFAULT,
  CONTACT_PAGE_SIZE_MAX,
  list,
  listPage,
  get,
  setRead,
  remove,
  create,
  __setDbForTests,
  __setMailerForTests,
};
