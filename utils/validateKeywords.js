// backend/utils/validateKeywords.js
//
// Validation for the optional `keywords` field (meta keywords) written to
// `articles` and `page_seo`, split out so unit tests can cover it directly
// (same idea as validateSeo.js / validateArticleFaq.js).
//
// Contract (identical on every endpoint that touches it):
//   - `keywords` is OPTIONAL. Absent / null / ''  -> null (column is NULL).
//   - Must be a string; anything else            -> 'keywords must be a string'
//   - Trimmed first; whitespace-only becomes null.
//   - At most 255 characters (VARCHAR(255)) after trimming
//                                                -> 'keywords must be at most 255
//                                                    characters'
//   - NULL / whitespace-only                     -> null
//
// `keywords` is emitted as <meta name="keywords"> only. It deliberately does
// NOT feed any completeness score, and a missing value is never an error.
//
// Pure: no DB access, no Express types.

const MAX_KEYWORDS_LENGTH = 255; // articles.keywords / page_seo.keywords VARCHAR(255)

function normalizeKeywords(raw) {
  // Absent / explicit null / empty string all mean "not set".
  if (raw === undefined || raw === null || raw === '') {
    return { error: null, value: null };
  }

  if (typeof raw !== 'string') {
    return { error: 'keywords must be a string', value: null };
  }

  // Length is measured AFTER trimming, exactly like the other SEO caps.
  const value = raw.trim();
  if (value.length > MAX_KEYWORDS_LENGTH) {
    return { error: `keywords must be at most ${MAX_KEYWORDS_LENGTH} characters`, value: null };
  }
  if (value === '') {
    return { error: null, value: null };
  }

  return { error: null, value };
}

module.exports = { MAX_KEYWORDS_LENGTH, normalizeKeywords };
