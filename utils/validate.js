// backend/utils/validate.js
//
// Shared request-body validation helpers for the admin write routes
// (articles, categories). They only normalise/verify input — no DB access — so
// each route keeps full control over ordering and error wording.
//
// The SEO field validator (normalizeSeoFields) lives in utils/validateSeo.js
// because it is shared by the articles and SEO routes.

// Slug grammar used by the admin dashboard slugifier:
//   lowercase alphanumerics, single hyphens between groups, no leading/trailing
//   hyphen. Length is bounded by the column (VARCHAR(255)).
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_TITLE_LENGTH = 255;
const MAX_SLUG_LENGTH = 255;
const MAX_AUTHOR_LENGTH = 100; // articles.author VARCHAR(100)
const MAX_COVER_IMAGE_LENGTH = 500; // articles.cover_image VARCHAR(500)

// MySQL error codes the routes translate into proper HTTP statuses.
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';
const ER_ROW_IS_REFERENCED_2 = 'ER_ROW_IS_REFERENCED_2';

function isDuplicateEntry(error) {
  return Boolean(error && error.code === ER_DUP_ENTRY);
}

// True when MySQL refused a DELETE because rows in another table still point at
// the parent row (FK defined without ON DELETE CASCADE / SET NULL).
function isRowReferenced(error) {
  return Boolean(error && error.code === ER_ROW_IS_REFERENCED_2);
}

// Optional free-text field: undefined/null/'' -> null, otherwise a trimmed
// string. Returns { value } or { error }.
function optionalString(value, field, maxLength) {
  if (value === undefined || value === null || value === '') {
    return { value: null };
  }
  if (typeof value !== 'string') {
    return { error: `${field} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed === '') return { value: null };
  if (maxLength && trimmed.length > maxLength) {
    return { error: `${field} must be at most ${maxLength} characters` };
  }
  return { value: trimmed };
}

// Required string: trims, rejects non-strings and empty/whitespace-only values.
function requiredString(value, field, maxLength) {
  if (value === undefined || value === null) {
    return { error: `${field} is required` };
  }
  if (typeof value !== 'string') {
    return { error: `${field} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return { error: `${field} is required` };
  }
  if (maxLength && trimmed.length > maxLength) {
    return { error: `${field} must be at most ${maxLength} characters` };
  }
  return { value: trimmed };
}

// Slug: required, lower-case kebab-case, max 255 characters.
function validateSlug(value) {
  const required = requiredString(value, 'slug', MAX_SLUG_LENGTH);
  if (required.error) return required;
  if (!SLUG_PATTERN.test(required.value)) {
    return {
      error:
        'slug must be lowercase letters, numbers, and single hyphens ' +
        '(e.g. "story-of-munduk-coffee")',
    };
  }
  return { value: required.value };
}

// Boolean coercion for TINYINT(1) flags sent from the dashboard:
//   true/false, 0/1, '0'/'1', 'true'/'false' (case-insensitive).
// An absent value (undefined / null / '') falls back to `fallback`.
function coerceBoolean(value, field, fallback) {
  if (value === undefined || value === null || value === '') {
    return { value: fallback };
  }
  if (typeof value === 'boolean') {
    return { value: value ? 1 : 0 };
  }
  if (typeof value === 'number') {
    if (value === 1) return { value: 1 };
    if (value === 0) return { value: 0 };
    return { error: `${field} must be a boolean` };
  }
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    if (normalised === '1' || normalised === 'true') return { value: 1 };
    if (normalised === '0' || normalised === 'false') return { value: 0 };
  }
  return { error: `${field} must be a boolean` };
}

// Strict integer in [min, max] (accepts numeric strings — HTML forms send
// strings). An absent value (undefined / null / '') falls back to `fallback`.
// Unlike `value || fallback`, a supplied 0 stays 0 — callers choose the minimum
// where 0 is not meaningful.
function coerceInteger(value, field, { min = 0, max = 2147483647, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') {
    return { value: fallback };
  }
  let parsed;
  if (typeof value === 'number') {
    // Only finite integers (rejects 1.5, NaN, Infinity from JSON numbers).
    parsed = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    return { error: `${field} must be an integer between ${min} and ${max}` };
  }
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return { error: `${field} must be an integer between ${min} and ${max}` };
  }
  return { value: parsed };
}

// Positive integer primary key from a route param ("12" -> 12).
function parseId(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null;
  const id = Number(raw.trim());
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

// Legacy `?limit=` query parameter (plain-array articles mode).
// Clamps to 1..50 like the paginated `per_page`. Returns null when the value is
// missing or not a positive integer, so the caller can keep its default —
// this is what stops `LIMIT NaN` (→ `LIMIT NULL` → 500) and unbounded dumps.
const LEGACY_LIMIT_MAX = 50;

function clampLegacyLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw)) return null; // ?limit=1&limit=2 — ambiguous, ignore
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return Math.min(value, LEGACY_LIMIT_MAX);
}

module.exports = {
  SLUG_PATTERN,
  MAX_TITLE_LENGTH,
  MAX_SLUG_LENGTH,
  MAX_AUTHOR_LENGTH,
  MAX_COVER_IMAGE_LENGTH,
  LEGACY_LIMIT_MAX,
  isDuplicateEntry,
  isRowReferenced,
  optionalString,
  requiredString,
  validateSlug,
  coerceBoolean,
  coerceInteger,
  parseId,
  clampLegacyLimit,
};
