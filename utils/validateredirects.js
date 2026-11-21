// backend/utils/validateredirects.js
//
// Validation for the `redirects` table (SEO Task A — redirects).
//
// Pure: no DB access, no Express types. Shared by routes/redirects.js and the
// auto-redirect written when an article slug changes (routes/articles.js).
//
// A redirect row is a pair of root-relative paths plus a status:
//   from_path  must start with '/', <= 255 chars, no scheme/host, no '#'
//   to_path    same rules, plus it must not point at a non-page area (/api, /_next)
//   status     301 or 302 (default 301)
//
// Loop/shadow protection: a redirect whose from_path equals a live route would
// replace that page instead of repairing a broken link, so every from_path is
// checked against PAGE_ROUTES below (mirrors PAGE_SEO_DEFAULTS in
// frontend/lib/pageSeo.js) and the RESERVED_PREFIXES list. `/stay/rooms/*` is
// reserved as a whole because the room slugs are content-driven.

const MAX_PATH_LENGTH = 255;

// Exact live page paths (frontend/lib/pageSeo.js PAGE_SEO_DEFAULTS .path).
const PAGE_ROUTES = Object.freeze([
  '/',
  '/our-story',
  '/stay',
  '/stay/guest-house',
  '/stay/camp',
  '/rooms',
  '/experience',
  '/explore-munduk',
  '/journal',
  '/reviews',
  '/gallery',
  '/contact',
]);

// Non-page areas that must never be redirected. These are matched by prefix
// (and on the first path segment, so '/apiary' is NOT treated as '/api').
//   /api, /admin, /_next  internal surfaces
//   /journal/page         paginated journal (@see frontend journal/page/[n])
//   /uploads              locally served legacy uploads
//   /stay/rooms           room detail pages (slugs are content-driven)
//   sitemap/robots/llms/icons  static SEO assets
const RESERVED_PREFIXES = Object.freeze([
  '/api',
  '/admin',
  '/_next',
  '/journal/page',
  '/uploads',
  '/stay/rooms',
]);

const RESERVED_FILES = Object.freeze([
  '/sitemap.xml',
  '/robots.txt',
  '/llms.txt',
  '/favicon.ico',
  '/icon.png',
  '/apple-icon.png',
]);

// Targets must be real page paths, so /api and /_next are refused as well.
// `/journal/page` is a legitimate target (a redirect may land on journal page 2)
// so it is deliberately NOT in this list.
const RESERVED_TARGET_PREFIXES = Object.freeze(['/api', '/_next']);

const ALLOWED_STATUSES = Object.freeze([301, 302]);
const DEFAULT_STATUS = 301;

// '/stay/rooms/deluxe-room' -> 'stay'; '/API/x' -> 'api'
function firstSegment(path) {
  return path.split('/')[1].toLowerCase();
}

function isUnderPrefix(path, prefix) {
  const p = path.toLowerCase();
  const base = prefix.toLowerCase();
  return p === base || p.startsWith(`${base}/`);
}

// True when `path` is (or sits under) a live page route / reserved area.
function shadowsLiveRoute(path) {
  const p = String(path).toLowerCase();
  if (!p.startsWith('/')) return false;

  if (PAGE_ROUTES.includes(p)) return true;
  if (RESERVED_FILES.includes(p)) return true;

  // `firstSegment` guards '/apiary' from being read as '/api'.
  const segment = firstSegment(p);
  for (const prefix of RESERVED_PREFIXES) {
    if (prefix === `/${segment}` || prefix.startsWith(`/${segment}/`)) {
      if (isUnderPrefix(p, prefix)) return true;
    }
  }
  return false;
}

// True when `path` targets an internal (non-page) area.
function targetsInternalArea(path) {
  const p = String(path).toLowerCase();
  return RESERVED_TARGET_PREFIXES.some((prefix) => isUnderPrefix(p, prefix));
}

// Single path field check. Returns { value } or { error }.
// `field` is used verbatim in the error strings ('from_path' / 'to_path').
function validateRedirectPath(value, field) {
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
  // Scheme/host first so "https://host/x" is reported as a URL, not as a path
  // that merely forgot its leading slash.
  if (trimmed.includes('://')) {
    return { error: `${field} must be a path, not a full URL (no scheme or host)` };
  }
  if (!trimmed.startsWith('/')) {
    return { error: `${field} must start with "/"` };
  }
  if (trimmed.length > MAX_PATH_LENGTH) {
    return { error: `${field} must be at most ${MAX_PATH_LENGTH} characters` };
  }
  if (trimmed.includes('#')) {
    return { error: `${field} must not contain "#"` };
  }
  if (/[\s]/.test(trimmed)) {
    return { error: `${field} must not contain whitespace` };
  }

  return { value: trimmed };
}

// status: accepts 301/302 and the numeric strings '301'/'302' (HTML forms).
// Absent (undefined/null/'') falls back to `fallback`.
function validateRedirectStatus(value, fallback = DEFAULT_STATUS) {
  if (value === undefined || value === null || value === '') {
    return { value: fallback };
  }
  let status;
  if (typeof value === 'number') {
    status = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    status = Number(value.trim());
  } else {
    return { error: 'status must be 301 or 302' };
  }
  if (!ALLOWED_STATUSES.includes(status)) {
    return { error: 'status must be 301 or 302' };
  }
  return { value: status };
}

// Validate a create payload ({ from_path, to_path, status? }).
// Returns { errors: string[], values: { from_path, to_path, status } }.
function validateRedirect(body) {
  const errors = [];
  const values = {};

  const from = validateRedirectPath(body.from_path, 'from_path');
  if (from.error) {
    errors.push(from.error);
  } else {
    values.from_path = from.value;
  }

  const to = validateRedirectPath(body.to_path, 'to_path');
  if (to.error) {
    errors.push(to.error);
  } else {
    values.to_path = to.value;
  }

  const status = validateRedirectStatus(body.status, DEFAULT_STATUS);
  if (status.error) {
    errors.push(status.error);
  } else {
    values.status = status.value;
  }

  if (!from.error && !to.error) {
    // Exact comparison only: '/a' -> '/a/' is a distinct target, not a loop.
    if (values.from_path === values.to_path) {
      errors.push('from_path and to_path must be different');
    }
    if (shadowsLiveRoute(values.from_path)) {
      errors.push('from_path shadows an existing route');
    }
    if (targetsInternalArea(values.to_path)) {
      errors.push('to_path must not point at a reserved non-page prefix (/api, /_next)');
    }
  }

  return { errors, values };
}

// Validate a partial update payload ({ from_path?, to_path?, status? }).
// Only supplied fields are validated; everything else is left to the caller.
// Returns { errors, values } with exactly the supplied (valid) fields.
function validateRedirectPatch(body) {
  const errors = [];
  const values = {};

  if (body.from_path !== undefined) {
    const from = validateRedirectPath(body.from_path, 'from_path');
    if (from.error) errors.push(from.error);
    else values.from_path = from.value;
  }

  if (body.to_path !== undefined) {
    const to = validateRedirectPath(body.to_path, 'to_path');
    if (to.error) errors.push(to.error);
    else values.to_path = to.value;
  }

  if (body.status !== undefined) {
    const status = validateRedirectStatus(body.status, DEFAULT_STATUS);
    if (status.error) errors.push(status.error);
    else values.status = status.value;
  }

  if (values.from_path !== undefined && shadowsLiveRoute(values.from_path)) {
    errors.push('from_path shadows an existing route');
  }
  if (values.to_path !== undefined && targetsInternalArea(values.to_path)) {
    errors.push('to_path must not point at a reserved non-page prefix (/api, /_next)');
  }

  return { errors, values };
}

module.exports = {
  MAX_PATH_LENGTH,
  PAGE_ROUTES,
  RESERVED_PREFIXES,
  RESERVED_FILES,
  RESERVED_TARGET_PREFIXES,
  ALLOWED_STATUSES,
  DEFAULT_STATUS,
  shadowsLiveRoute,
  targetsInternalArea,
  validateRedirectPath,
  validateRedirectStatus,
  validateRedirect,
  validateRedirectPatch,
};
