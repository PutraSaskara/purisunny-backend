// backend/utils/validateBooking.js
//
// Validation for the public booking-lead form (POST /api/booking/leads) and the
// admin status PATCH. Pure: no DB access, no Express types, no side effects.
//
// Rules (column widths in database/schema.sql / database/ddl-booking.js):
//   name        required, trimmed, 1..100
//   email       optional for channel=whatsapp/question, REQUIRED for
//               channel=email, sane RFC-ish shape, <=255
//   phone       optional, <=32, only digits / + / - / space / parens
//   check_in    stay channels: required YYYY-MM-DD real date, not in the past
//               (today allowed). Question channel: optional, but supplying
//               either date requires both.
//   check_out   stay channels: required YYYY-MM-DD real date, strictly after
//               check_in. Question channel: same optional-both rule.
//   guests      stay channels: required integer 1..20. Question channel:
//               optional, defaults to 1; if supplied must be 1..20.
//   room_slug   optional, <=100, /^[a-z0-9-]+$/
//   message     required, trimmed 10..5000, control chars stripped except
//               newline and tab
//   source_page optional, <=255, starts with "/", no scheme, no whitespace
//   client_ref  optional, 8..64, /^[A-Za-z0-9_-]+$/
//   channel     required, 'whatsapp', 'email' or 'question'
//
// The question channel is the mini "Ask a question" form: email and phone are
// both individually optional, but at least one VALID contact is required.
//
// Errors are human-readable strings and every failing field is collected so the
// route can return { message: errors[0], errors }. All values are nulled when
// any error is present (the service must never insert a half-valid row).
//
// Dates are compared as WITA (UTC+8) calendar days, the homestay's timezone.
// Tests can pin "today" through the second argument.

const { isValidEmail } = require('./validateContact');

const NAME_MAX = 100;
const EMAIL_MAX = 255;
const PHONE_MAX = 32;
const GUESTS_MIN = 1;
const GUESTS_MAX = 20;
const ROOM_SLUG_MAX = 100;
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;
const SOURCE_PAGE_MAX = 255;
const CLIENT_REF_MIN = 8;
const CLIENT_REF_MAX = 64;

const CHANNELS = Object.freeze(['whatsapp', 'email', 'question']);
const QUESTION_CONTACT_ERROR =
  'Please provide an email or phone number so we can reply.';
const STATUSES = Object.freeze(['new', 'contacted', 'confirmed', 'cancelled']);
const EVENTS = Object.freeze(['wa_click', 'email_click', 'form_open', 'form_submit']);

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PHONE_ALLOWED = /^[\d+\-\s()]+$/;
const ROOM_SLUG_PATTERN = /^[a-z0-9-]+$/;
const CLIENT_REF_PATTERN = /^[A-Za-z0-9_-]+$/;
// C0 controls + DEL, all of them for single-line fields.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
// Message: keep \t (09) and \n (0A); strip the rest (CR is normalised first).
const MESSAGE_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// A scheme or protocol-relative URL is invalid as a stored site path.
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function stripControls(value) {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS, '') : value;
}

function cleanLine(value) {
  if (typeof value !== 'string') return value;
  return stripControls(value).trim();
}

function cleanMessage(value) {
  if (typeof value !== 'string') return value;
  const withoutCr = value.replace(/\r\n?/g, '\n');
  return withoutCr.replace(MESSAGE_CONTROL_CHARS, '').trim();
}

// UTC+8 with no DST. Returns YYYY-MM-DD for the WITA calendar day.
function todayInWita(now = new Date()) {
  const wita = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${wita.getUTCFullYear()}-${pad(wita.getUTCMonth() + 1)}-${pad(wita.getUTCDate())}`;
}

// Strict YYYY-MM-DD parser: rejects 2026-02-30, 2026-13-01 and rollover dates
// that `new Date()` would silently accept. Returns { iso, time } or null.
function parseDateOnly(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;

  // Day 0 of the next month is the last day of this month.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;

  return { iso: value, time: Date.UTC(year, month - 1, day) };
}

function isObjectBody(body) {
  return Boolean(body) && typeof body === 'object' && !Array.isArray(body);
}

function validateBooking(body, options = {}) {
  const input = isObjectBody(body) ? body : {};
  const errors = [];

  // Resolve "today" once so the two date checks cannot straddle midnight.
  const opts = options && typeof options === 'object' ? options : {};
  const pinnedToday = parseDateOnly(opts.today);
  const today = pinnedToday || parseDateOnly(todayInWita());

  // ---- channel -----------------------------------------------------------
  let channel = cleanLine(input.channel);
  if (channel === undefined || channel === null || channel === '') {
    errors.push('channel is required');
    channel = null;
  } else if (!CHANNELS.includes(channel)) {
    errors.push("channel must be 'whatsapp', 'email' or 'question'");
    channel = null;
  }
  const isQuestion = channel === 'question';

  // ---- name --------------------------------------------------------------
  let name = cleanLine(input.name);
  if (name === undefined || name === null || name === '') {
    errors.push('name is required');
    name = null;
  } else if (typeof name !== 'string') {
    errors.push('name must be a string');
    name = null;
  } else if (name.length > NAME_MAX) {
    errors.push(`name must be at most ${NAME_MAX} characters`);
    name = null;
  }

  // ---- email -------------------------------------------------------------
  let email = cleanLine(input.email);
  if (email === undefined || email === null || email === '') {
    email = null;
    if (channel === 'email') {
      errors.push('email is required for the email channel');
    }
  } else if (email.length > EMAIL_MAX) {
    errors.push(`email must be at most ${EMAIL_MAX} characters`);
    email = null;
  } else if (!isValidEmail(email)) {
    errors.push('email must be a valid email address');
    email = null;
  }

  // ---- phone (optional) --------------------------------------------------
  let phone = cleanLine(input.phone);
  if (phone === undefined || phone === null || phone === '') {
    phone = null;
  } else if (typeof phone !== 'string') {
    errors.push('phone must be a string');
    phone = null;
  } else if (phone.length > PHONE_MAX) {
    errors.push(`phone must be at most ${PHONE_MAX} characters`);
    phone = null;
  } else if (!PHONE_ALLOWED.test(phone)) {
    errors.push('phone may only contain digits, spaces, parentheses, hyphens and a leading +');
    phone = null;
  }

  // The question form only needs one working reply channel. Checked after the
  // shape validation so an invalid value does not count as contact.
  if (isQuestion && email === null && phone === null) {
    errors.push(QUESTION_CONTACT_ERROR);
  }

  // ---- dates -------------------------------------------------------------
  const checkInRaw = cleanLine(input.check_in);
  const checkOutRaw = cleanLine(input.check_out);
  const hasCheckIn = !(checkInRaw === undefined || checkInRaw === null || checkInRaw === '');
  const hasCheckOut = !(checkOutRaw === undefined || checkOutRaw === null || checkOutRaw === '');
  // Stay channels always require both dates. Question leads may omit both, but
  // supplying either one turns both into required fields.
  const datesRequired = !isQuestion || hasCheckIn || hasCheckOut;

  function readDate(raw, field, required) {
    if (raw === undefined || raw === null || raw === '') {
      return {
        value: null,
        date: null,
        error: required ? `${field} is required` : null,
      };
    }

    const date = parseDateOnly(raw);
    if (!date) {
      return { value: null, date: null, error: `${field} must be a valid date (YYYY-MM-DD)` };
    }
    if (field === 'check_in' && today && date.time < today.time) {
      return { value: null, date: null, error: 'check_in must not be in the past' };
    }
    return { value: date.iso, date, error: null };
  }

  const checkInResult = readDate(checkInRaw, 'check_in', datesRequired);
  if (checkInResult.error) errors.push(checkInResult.error);
  const checkIn = checkInResult.value;
  const checkInDate = checkInResult.date;

  const checkOutResult = readDate(checkOutRaw, 'check_out', datesRequired);
  if (checkOutResult.error) errors.push(checkOutResult.error);
  const checkOut = checkOutResult.value;
  const checkOutDate = checkOutResult.date;

  if (checkInDate && checkOutDate && checkOutDate.time <= checkInDate.time) {
    errors.push('check_out must be after check_in');
  }

  // ---- guests ------------------------------------------------------------
  let guests = null;
  const rawGuests = input.guests;
  const guestsText = typeof rawGuests === 'string' ? rawGuests.trim() : rawGuests;
  const guestsProvided = !(
    rawGuests === undefined || rawGuests === null || guestsText === ''
  );

  if (guestsProvided) {
    if (
      (typeof rawGuests === 'number' && Number.isInteger(rawGuests))
      || (typeof rawGuests === 'string' && /^\d+$/.test(guestsText))
    ) {
      const parsed = Number(guestsText);
      if (Number.isSafeInteger(parsed) && parsed >= GUESTS_MIN && parsed <= GUESTS_MAX) {
        guests = parsed;
      }
    }
    if (guests === null) {
      errors.push(`guests must be an integer between ${GUESTS_MIN} and ${GUESTS_MAX}`);
    }
  } else if (isQuestion) {
    // Mini question form: one guest unless the caller supplies a count.
    guests = 1;
  } else {
    errors.push(`guests must be an integer between ${GUESTS_MIN} and ${GUESTS_MAX}`);
  }

  // ---- room_slug (optional) ---------------------------------------------
  let roomSlug = cleanLine(input.room_slug);
  if (roomSlug === undefined || roomSlug === null || roomSlug === '') {
    roomSlug = null;
  } else if (typeof roomSlug !== 'string') {
    errors.push('room_slug must be a string');
    roomSlug = null;
  } else if (roomSlug.length > ROOM_SLUG_MAX) {
    errors.push(`room_slug must be at most ${ROOM_SLUG_MAX} characters`);
    roomSlug = null;
  } else if (!ROOM_SLUG_PATTERN.test(roomSlug)) {
    errors.push('room_slug must be lowercase letters, numbers and hyphens');
    roomSlug = null;
  }

  // ---- message -----------------------------------------------------------
  let message = cleanMessage(input.message);
  if (message === undefined || message === null || message === '') {
    errors.push('message is required');
    message = null;
  } else if (typeof message !== 'string') {
    errors.push('message must be a string');
    message = null;
  } else if (message.length < MESSAGE_MIN) {
    errors.push(`message must be at least ${MESSAGE_MIN} characters`);
    message = null;
  } else if (message.length > MESSAGE_MAX) {
    errors.push(`message must be at most ${MESSAGE_MAX} characters`);
    message = null;
  }

  // ---- source_page (optional) -------------------------------------------
  let sourcePage = cleanLine(input.source_page);
  if (sourcePage === undefined || sourcePage === null || sourcePage === '') {
    sourcePage = null;
  } else if (typeof sourcePage !== 'string') {
    errors.push('source_page must be a string');
    sourcePage = null;
  } else if (sourcePage.length > SOURCE_PAGE_MAX) {
    errors.push(`source_page must be at most ${SOURCE_PAGE_MAX} characters`);
    sourcePage = null;
  } else if (
    !sourcePage.startsWith('/')
    || sourcePage.startsWith('//')
    || /\s/.test(sourcePage)
    || SCHEME_PATTERN.test(sourcePage)
  ) {
    errors.push('source_page must start with "/" and contain no scheme or whitespace');
    sourcePage = null;
  }

  // ---- client_ref (optional) --------------------------------------------
  let clientRef = cleanLine(input.client_ref);
  if (clientRef === undefined || clientRef === null || clientRef === '') {
    clientRef = null;
  } else if (typeof clientRef !== 'string') {
    errors.push('client_ref must be a string');
    clientRef = null;
  } else if (clientRef.length < CLIENT_REF_MIN) {
    errors.push(`client_ref must be at least ${CLIENT_REF_MIN} characters`);
    clientRef = null;
  } else if (clientRef.length > CLIENT_REF_MAX) {
    errors.push(`client_ref must be at most ${CLIENT_REF_MAX} characters`);
    clientRef = null;
  } else if (!CLIENT_REF_PATTERN.test(clientRef)) {
    errors.push('client_ref may only contain letters, numbers, hyphens and underscores');
    clientRef = null;
  }

  const valid = errors.length === 0;

  return {
    errors,
    values: {
      name: valid ? name : null,
      email: valid ? email : null,
      phone: valid ? phone : null,
      check_in: valid ? checkIn : null,
      check_out: valid ? checkOut : null,
      guests: valid ? guests : null,
      room_slug: valid ? roomSlug : null,
      message: valid ? message : null,
      source_page: valid ? sourcePage : null,
      client_ref: valid ? clientRef : null,
      channel: valid ? channel : null,
    },
  };
}

// PATCH /api/booking/leads/:id — status only. Returns { value, errors }.
function validateBookingStatus(raw) {
  const status = typeof raw === 'string' ? raw.trim() : '';
  if (!STATUSES.includes(status)) {
    const message = `status must be one of: ${STATUSES.join(', ')}`;
    return { value: null, errors: [message] };
  }
  return { value: status, errors: [] };
}

module.exports = {
  NAME_MAX,
  EMAIL_MAX,
  PHONE_MAX,
  GUESTS_MIN,
  GUESTS_MAX,
  ROOM_SLUG_MAX,
  MESSAGE_MIN,
  MESSAGE_MAX,
  SOURCE_PAGE_MAX,
  CLIENT_REF_MIN,
  CLIENT_REF_MAX,
  CHANNELS,
  QUESTION_CONTACT_ERROR,
  STATUSES,
  EVENTS,
  DATE_PATTERN,
  ROOM_SLUG_PATTERN,
  CLIENT_REF_PATTERN,
  CONTROL_CHARS,
  MESSAGE_CONTROL_CHARS,
  stripControls,
  cleanLine,
  cleanMessage,
  todayInWita,
  parseDateOnly,
  validateBooking,
  validateBookingStatus,
};
