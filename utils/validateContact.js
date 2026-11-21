// backend/utils/validateContact.js
//
// Validation for the public contact form (POST /api/contact).
//
// Pure: no DB access, no Express types, no side effects. Shared by
// routes/contact.js and the unit tests, and the same normalised values are
// what the mailer renders.
//
// Rules (column widths in database/schema.sql):
//   name     required, trimmed, 1..100 characters        (VARCHAR(100))
//   email    required, trimmed, sane RFC-ish shape, <=255
//   phone    optional, trimmed, <=32, only digits / + / - / space / parens
//            (kept below the VARCHAR(30) column width so the INSERT can never
//             fail on a value validation accepted)
//   message  required, trimmed, 10..5000 characters      (TEXT)
//
// Control characters are stripped before the length checks run, so a payload
// padded with NUL/newline noise cannot slip past the caps, and header
// injection into the outgoing mail (`\r\nBcc:`) is impossible.
//
// Errors keep the wording style of utils/validateredirects.js
// ("name is required", "message must be at least 10 characters").

const NAME_MAX = 100;
const EMAIL_MAX = 255;
const PHONE_MAX = 32;
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;

// Sane practical email shape (not RFC 5322 in full — that accepts things no
// SMTP server or owner inbox will ever want):
//   local part: no whitespace, no @, no leading/trailing dot, no '..'
//   domain:     at least one dot, labels of letters/digits/hyphens,
//               TLD >= 2 letters
// Anchored, so junk like "a@b" (no TLD) and "a@@b.com" are rejected.
const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

// C0 controls + DEL, except \n and \t inside the message body which are
// meaningless for a single-line field but useful in the message. We strip
// EVERY control character (including \r and \n) from name/email/phone and keep
// ordinary newlines in `message`, normalising CRLF -> LF.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

// Phone: digits, plus, hyphen, space, parentheses after stripping controls.
const PHONE_ALLOWED = /^[\d+\-\s()]+$/;

function stripControls(value) {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS, '') : value;
}

// Trim + strip controls for a single-line field.
function cleanLine(value) {
  if (typeof value !== 'string') return value;
  return stripControls(value).trim();
}

// Message body: strip controls except \n, normalise CRLF/CR to \n, trim edges.
function cleanMessage(value) {
  if (typeof value !== 'string') return value;
  const withoutCr = value.replace(/\r\n?/g, '\n');
  const withoutControls = withoutCr
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n');
  return withoutControls.trim();
}

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= EMAIL_MAX && EMAIL_PATTERN.test(value);
}

// Looks like a phone number someone could tap: at least 6 digits once
// separators are ignored (short local numbers are legitimate in Indonesia, but
// a stray "(" or "12" is not).
function looksLikePhone(value) {
  if (typeof value !== 'string') return false;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 15;
}

// Returns { errors: string[], values: { name, email, phone, message } }.
// `values` is only meaningful when errors is empty; email is lower-cased for
// storage/dedupe while the display form is kept in `email`.
function validateContact(body) {
  const input = body && typeof body === 'object' ? body : {};
  const errors = [];

  // ---- name --------------------------------------------------------------
  let name = cleanLine(input.name);
  if (name === undefined || name === null || name === '') {
    errors.push('name is required');
    name = null;
  } else if (name.length > NAME_MAX) {
    errors.push(`name must be at most ${NAME_MAX} characters`);
  }

  // ---- email -------------------------------------------------------------
  let email = cleanLine(input.email);
  if (email === undefined || email === null || email === '') {
    errors.push('email is required');
    email = null;
  } else if (!isValidEmail(email)) {
    // Covers "too long" too: the pattern rejects anything over EMAIL_MAX
    // because isValidEmail gates on length first.
    errors.push('email must be a valid email address');
    if (email.length > EMAIL_MAX) {
      errors.push(`email must be at most ${EMAIL_MAX} characters`);
    }
  }

  // ---- phone (optional) --------------------------------------------------
  let phone = cleanLine(input.phone);
  if (phone === undefined || phone === null || phone === '') {
    phone = null;
  } else if (phone.length > PHONE_MAX) {
    errors.push(`phone must be at most ${PHONE_MAX} characters`);
  } else if (!PHONE_ALLOWED.test(phone)) {
    errors.push('phone may only contain digits, spaces, parentheses, hyphens and a leading +');
  }

  // ---- message -----------------------------------------------------------
  let message = cleanMessage(input.message);
  if (message === undefined || message === null || message === '') {
    errors.push('message is required');
    message = null;
  } else if (message.length < MESSAGE_MIN) {
    errors.push(`message must be at least ${MESSAGE_MIN} characters`);
  } else if (message.length > MESSAGE_MAX) {
    errors.push(`message must be at most ${MESSAGE_MAX} characters`);
  }

  return {
    errors,
    values: {
      name: errors.length === 0 ? name : null,
      email: errors.length === 0 ? email : null,
      phone: errors.length === 0 ? phone : null,
      message: errors.length === 0 ? message : null,
    },
  };
}

module.exports = {
  NAME_MAX,
  EMAIL_MAX,
  PHONE_MAX,
  MESSAGE_MIN,
  MESSAGE_MAX,
  EMAIL_PATTERN,
  PHONE_ALLOWED,
  isValidEmail,
  looksLikePhone,
  stripControls,
  cleanLine,
  cleanMessage,
  validateContact,
};
