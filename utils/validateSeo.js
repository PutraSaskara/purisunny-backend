// backend/utils/validateSeo.js
//
// Shared normalisation + validation for the optional SEO fields written to
// `articles` and `page_seo` (meta_title, meta_description, og_image, noindex).
//
// This used to be a ~70-line block duplicated byte-for-byte in
// routes/articles.js and routes/seo.js (audit P3-11). The logic below is that
// block verbatim — same ordering, same trimming, same error strings — so both
// routes keep their existing 400 contract.
//
// Pure: no DB access, no Express types. Returns
//   { errors: string[], values: { meta_title, meta_description, og_image, noindex } }
// Callers surface `errors` with their own status/message shape.
//
// Hard caps (SEO Task A), enforced for BOTH routes because they share this
// function — a value that survives here also fits the column, so the API can
// never answer 500 from `Data too long for column`:
//   meta_title       <= 255 characters (VARCHAR(255)), trimmed
//   meta_description <= 500 characters (VARCHAR(500)), trimmed
//   og_image         kept as an http(s) URL, <= 500 characters
// Whitespace-only (= empty after trim) becomes NULL in every case.

const MAX_META_TITLE_LENGTH = 255; // articles.meta_title / page_seo.meta_title
const MAX_META_DESCRIPTION_LENGTH = 500; // VARCHAR(500)
const MAX_OG_IMAGE_LENGTH = 500; // VARCHAR(500)

function normalizeSeoFields(body) {
  const errors = [];

  let meta_title = body.meta_title;
  let meta_description = body.meta_description;
  let og_image = body.og_image;
  let noindex = body.noindex;

  // Treat undefined / empty strings as NULL.
  if (meta_title === undefined || meta_title === null || meta_title === '') meta_title = null;
  if (meta_description === undefined || meta_description === null || meta_description === '') meta_description = null;
  if (og_image === undefined || og_image === null || og_image === '') og_image = null;

  if (meta_title !== null) {
    if (typeof meta_title !== 'string') {
      errors.push('meta_title must be a string');
    } else {
      meta_title = meta_title.trim();
      if (meta_title.length > MAX_META_TITLE_LENGTH) errors.push(`meta_title must be at most ${MAX_META_TITLE_LENGTH} characters`);
      if (meta_title === '') meta_title = null;
    }
  }

  if (meta_description !== null) {
    if (typeof meta_description !== 'string') {
      errors.push('meta_description must be a string');
    } else {
      meta_description = meta_description.trim();
      if (meta_description.length > MAX_META_DESCRIPTION_LENGTH) errors.push(`meta_description must be at most ${MAX_META_DESCRIPTION_LENGTH} characters`);
      if (meta_description === '') meta_description = null;
    }
  }

  if (og_image !== null) {
    if (typeof og_image !== 'string') {
      errors.push('og_image must be a string URL');
    } else {
      og_image = og_image.trim();
      if (og_image.length > MAX_OG_IMAGE_LENGTH) {
        errors.push(`og_image must be at most ${MAX_OG_IMAGE_LENGTH} characters`);
      } else if (og_image !== '') {
        try {
          const parsed = new URL(og_image);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            errors.push('og_image must be a valid http(s) URL');
          }
        } catch {
          errors.push('og_image must be a valid http(s) URL');
        }
      } else {
        og_image = null;
      }
    }
  }

  // noindex must resolve to 0 or 1.
  if (noindex === undefined || noindex === null || noindex === '') {
    noindex = 0;
  } else if (typeof noindex === 'boolean') {
    noindex = noindex ? 1 : 0;
  } else if (typeof noindex === 'string' && (noindex === '0' || noindex === '1')) {
    noindex = parseInt(noindex, 10);
  } else if (noindex !== 0 && noindex !== 1) {
    errors.push('noindex must be 0 or 1');
  }

  return { errors, values: { meta_title, meta_description, og_image, noindex } };
}

module.exports = { normalizeSeoFields };
