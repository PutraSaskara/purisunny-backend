// backend/test/unit/validateSeo.test.js
//
// Proves utils/validateSeo.js behaves byte-for-byte like the block it replaced
// (the previous in-route implementation is embedded below verbatim). Every case
// is compared on JSON.stringify of the full {errors, values} result.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSeoFields } = require('../../utils/validateSeo');

// The original duplicated implementation (routes/articles.js pre-Paket-D).
function legacyNormalizeSeoFields(body) {
  const errors = [];

  let meta_title = body.meta_title;
  let meta_description = body.meta_description;
  let og_image = body.og_image;
  let noindex = body.noindex;

  if (meta_title === undefined || meta_title === null || meta_title === '') meta_title = null;
  if (meta_description === undefined || meta_description === null || meta_description === '') meta_description = null;
  if (og_image === undefined || og_image === null || og_image === '') og_image = null;

  if (meta_title !== null) {
    if (typeof meta_title !== 'string') {
      errors.push('meta_title must be a string');
    } else {
      meta_title = meta_title.trim();
      if (meta_title.length > 255) errors.push('meta_title must be at most 255 characters');
      if (meta_title === '') meta_title = null;
    }
  }

  if (meta_description !== null) {
    if (typeof meta_description !== 'string') {
      errors.push('meta_description must be a string');
    } else {
      meta_description = meta_description.trim();
      if (meta_description.length > 500) errors.push('meta_description must be at most 500 characters');
      if (meta_description === '') meta_description = null;
    }
  }

  if (og_image !== null) {
    if (typeof og_image !== 'string') {
      errors.push('og_image must be a string URL');
    } else {
      og_image = og_image.trim();
      if (og_image.length > 500) {
        errors.push('og_image must be at most 500 characters');
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

const CASES = [
  {},
  { meta_title: 'Hello' },
  { meta_title: '  padded  ' },
  { meta_title: '' },
  { meta_title: null },
  { meta_title: 123 },
  { meta_title: 'x'.repeat(255) },
  { meta_title: 'x'.repeat(256) },
  { meta_description: 'desc' },
  { meta_description: '' },
  { meta_description: ['a'] },
  { meta_description: 'y'.repeat(501) },
  { og_image: 'https://example.com/a.png' },
  { og_image: 'http://example.com/a.png' },
  { og_image: 'ftp://example.com/a.png' },
  { og_image: 'not a url' },
  { og_image: '' },
  { og_image: 42 },
  { og_image: `https://example.com/${'a'.repeat(500)}` },
  { noindex: true },
  { noindex: false },
  { noindex: 0 },
  { noindex: 1 },
  { noindex: '0' },
  { noindex: '1' },
  { noindex: 'true' },
  { noindex: 2 },
  { meta_title: 'Title', meta_description: 'Desc', og_image: 'https://e.co/x.jpg', noindex: '1' },
];

test('normalizeSeoFields matches the previous implementation exactly', () => {
  for (const body of CASES) {
    assert.deepEqual(
      normalizeSeoFields(body),
      legacyNormalizeSeoFields(body),
      `mismatch for ${JSON.stringify(body)}`
    );
  }
});

test('normalizeSeoFields defaults noindex to 0 and blanks to null', () => {
  assert.deepEqual(normalizeSeoFields({}), {
    errors: [],
    values: { meta_title: null, meta_description: null, og_image: null, noindex: 0 },
  });
});

test('normalizeSeoFields collects multiple errors', () => {
  const { errors } = normalizeSeoFields({ meta_title: 1, meta_description: 2, og_image: 'bad', noindex: 'x' });
  assert.equal(errors.length, 4);
});

// ---------------------------------------------------------------------------
// Hard length caps (SEO Task A). Both routes (articles + SEO upsert) share
// normalizeSeoFields, so a value that passes here always fits VARCHAR(255) /
// VARCHAR(500) and the API cannot answer 500 from "Data too long for column".
// ---------------------------------------------------------------------------

test('meta_title cap: 255 accepted, 256 rejected', () => {
  assert.deepEqual(normalizeSeoFields({ meta_title: 'x'.repeat(255) }).errors, []);
  const over = normalizeSeoFields({ meta_title: 'x'.repeat(256) });
  assert.deepEqual(over.errors, ['meta_title must be at most 255 characters']);
  // Length is measured AFTER trimming.
  assert.deepEqual(normalizeSeoFields({ meta_title: `  ${'x'.repeat(255)}  ` }).errors, []);
});

test('meta_description cap: 500 accepted, 501 rejected', () => {
  assert.deepEqual(normalizeSeoFields({ meta_description: 'y'.repeat(500) }).errors, []);
  const over = normalizeSeoFields({ meta_description: 'y'.repeat(501) });
  assert.deepEqual(over.errors, ['meta_description must be at most 500 characters']);
});

test('whitespace-only meta fields become NULL, not empty strings', () => {
  const { errors, values } = normalizeSeoFields({ meta_title: '   ', meta_description: '\n\t ' });
  assert.deepEqual(errors, []);
  assert.equal(values.meta_title, null);
  assert.equal(values.meta_description, null);
});

test('og_image keeps its http(s) URL validation alongside the caps', () => {
  assert.deepEqual(normalizeSeoFields({ og_image: 'https://example.com/a.png' }).errors, []);
  assert.deepEqual(normalizeSeoFields({ og_image: 'ftp://example.com/a.png' }).errors, ['og_image must be a valid http(s) URL']);
  assert.deepEqual(normalizeSeoFields({ og_image: 'not a url' }).errors, ['og_image must be a valid http(s) URL']);
});
