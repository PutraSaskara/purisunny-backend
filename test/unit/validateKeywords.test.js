// backend/test/unit/validateKeywords.test.js
//
// Optional meta-keywords field (routes/articles.js + routes/seo.js).
//
// Contract under test:
//   - absent / null / ''    -> null (no error)
//   - non-string            -> 'keywords must be a string'
//   - trimmed; whitespace-only -> null
//   - 255 chars accepted, 256 rejected with
//     'keywords must be at most 255 characters'

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_KEYWORDS_LENGTH, normalizeKeywords } = require('../../utils/validateKeywords');

test('keywords is optional: absent, null and empty all mean NULL', () => {
  assert.deepEqual(normalizeKeywords(undefined), { error: null, value: null });
  assert.deepEqual(normalizeKeywords(null), { error: null, value: null });
  assert.deepEqual(normalizeKeywords(''), { error: null, value: null });
});

test('keywords is trimmed and whitespace-only becomes NULL', () => {
  assert.deepEqual(normalizeKeywords('  puri sunny, munduk  '), {
    error: null,
    value: 'puri sunny, munduk',
  });
  assert.deepEqual(normalizeKeywords('   '), { error: null, value: null });
  assert.deepEqual(normalizeKeywords('\n\t '), { error: null, value: null });
});

test('keywords accepts a comma-separated list verbatim', () => {
  const value = 'bali, munduk, guest house, puri sunny';
  assert.deepEqual(normalizeKeywords(value), { error: null, value });
});

test('non-string keywords are rejected', () => {
  for (const raw of [123, true, false, [], ['a'], {}, { a: 1 }]) {
    assert.deepEqual(
      normalizeKeywords(raw),
      { error: 'keywords must be a string', value: null },
      `mismatch for ${JSON.stringify(raw)}`
    );
  }
});

test('keywords cap: 255 accepted, 256 rejected (measured after trimming)', () => {
  assert.equal(MAX_KEYWORDS_LENGTH, 255);

  const exact = 'x'.repeat(255);
  assert.deepEqual(normalizeKeywords(exact), { error: null, value: exact });
  // Whitespace around an exactly-255 value does not count toward the cap.
  assert.deepEqual(normalizeKeywords(`   ${exact}   `), { error: null, value: exact });

  const over = 'y'.repeat(256);
  assert.deepEqual(normalizeKeywords(over), {
    error: 'keywords must be at most 255 characters',
    value: null,
  });
});

test('empty and whitespace-only inputs never produce an error', () => {
  for (const raw of [undefined, null, '', ' ', '\t', '\n']) {
    assert.equal(normalizeKeywords(raw).error, null, `unexpected error for ${JSON.stringify(raw)}`);
  }
});
