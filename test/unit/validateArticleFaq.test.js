// backend/test/unit/validateArticleFaq.test.js
//
// Pure validator contract for the optional per-article FAQ list
// (utils/validateArticleFaq.js). No DB, no HTTP.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_ARTICLE_FAQS,
  MAX_FAQ_QUESTION_LENGTH,
  MAX_FAQ_ANSWER_LENGTH,
  validateArticleFaqs,
} = require('../../utils/validateArticleFaq');

test('caps mirror the page-FAQ flow (20 / 255 / 1000)', () => {
  assert.equal(MAX_ARTICLE_FAQS, 20);
  assert.equal(MAX_FAQ_QUESTION_LENGTH, 255);
  assert.equal(MAX_FAQ_ANSWER_LENGTH, 1000);
});

test('absent faqs -> present:false, no errors (PUT leaves them untouched)', () => {
  for (const value of [undefined, null]) {
    const r = validateArticleFaqs(value);
    assert.equal(r.present, false);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.items, []);
  }
});

test('empty array is a valid "clear all" when the key is present', () => {
  const r = validateArticleFaqs([]);
  assert.equal(r.present, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items, []);
});

test('valid items are trimmed and numbered by array index', () => {
  const r = validateArticleFaqs([
    { question: '  Where is Puri Sunny?  ', answer: '  Munduk, Bali.  ' },
    { question: 'Q2', answer: 'A2' },
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items, [
    { question: 'Where is Puri Sunny?', answer: 'Munduk, Bali.', position: 0 },
    { question: 'Q2', answer: 'A2', position: 1 },
  ]);
});

test('unknown extra keys inside an item are ignored', () => {
  const r = validateArticleFaqs([
    { question: 'Q', answer: 'A', id: 99, article_id: 7, position: 5, created_at: 'x' },
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items, [{ question: 'Q', answer: 'A', position: 0 }]);
});

test('non-array faqs -> 400-style error', () => {
  for (const value of ['nope', 42, {}, true]) {
    const r = validateArticleFaqs(value);
    assert.equal(r.present, true);
    assert.deepEqual(r.errors, ['faqs must be an array']);
  }
});

test('more than 20 items is rejected', () => {
  const many = Array.from({ length: MAX_ARTICLE_FAQS + 1 }, (_, i) => ({
    question: `Q${i}`,
    answer: `A${i}`,
  }));
  const r = validateArticleFaqs(many);
  assert.deepEqual(r.errors, ['faqs must have at most 20 items']);
  assert.deepEqual(r.items, []);
});

test('exactly 20 items is accepted', () => {
  const many = Array.from({ length: MAX_ARTICLE_FAQS }, (_, i) => ({
    question: `Q${i}`,
    answer: `A${i}`,
  }));
  const r = validateArticleFaqs(many);
  assert.deepEqual(r.errors, []);
  assert.equal(r.items.length, 20);
});

test('empty / whitespace-only / non-string question or answer is rejected', () => {
  const cases = [
    [{ question: '', answer: 'A' }, 'faqs[0].question is required'],
    [{ question: '   ', answer: 'A' }, 'faqs[0].question is required'],
    [{ question: 123, answer: 'A' }, 'faqs[0].question must be a string'],
    [{ answer: 'A' }, 'faqs[0].question is required'],
    [{ question: 'Q', answer: '' }, 'faqs[0].answer is required'],
    [{ question: 'Q', answer: '  ' }, 'faqs[0].answer is required'],
    [{ question: 'Q', answer: {} }, 'faqs[0].answer must be a string'],
    [{ question: 'Q' }, 'faqs[0].answer is required'],
  ];
  for (const [item, expected] of cases) {
    const r = validateArticleFaqs([item]);
    assert.ok(r.errors.includes(expected), `${JSON.stringify(item)} -> ${r.errors.join(' | ')}`);
  }
});

test('question cap is 255 after trimming, answer cap is 1000', () => {
  const ok = validateArticleFaqs([
    { question: `  ${'q'.repeat(255)}  `, answer: `  ${'a'.repeat(1000)}  ` },
  ]);
  assert.deepEqual(ok.errors, []);

  const q = validateArticleFaqs([{ question: 'q'.repeat(256), answer: 'A' }]);
  assert.deepEqual(q.errors, ['faqs[0].question must be at most 255 characters']);

  const a = validateArticleFaqs([{ question: 'Q', answer: 'a'.repeat(1001) }]);
  assert.deepEqual(a.errors, ['faqs[0].answer must be at most 1000 characters']);
});

test('non-object items are reported per index and do not abort the rest', () => {
  const r = validateArticleFaqs([null, 'str', [], { question: 'Q', answer: 'A' }]);
  assert.deepEqual(r.errors, [
    'faqs[0] must be an object',
    'faqs[1] must be an object',
    'faqs[2] must be an object',
  ]);
  // The valid item keeps its array position.
  assert.deepEqual(r.items, [
    { question: 'Q', answer: 'A', position: 3 },
  ]);
});

test('multiple errors are collected, not short-circuited', () => {
  const r = validateArticleFaqs([
    { question: '', answer: '' },
    { question: 'q'.repeat(300), answer: 'A' },
  ]);
  assert.equal(r.errors.length, 3);
  assert.ok(r.errors.some((e) => e.startsWith('faqs[0].question')));
  assert.ok(r.errors.some((e) => e.startsWith('faqs[0].answer')));
  assert.ok(r.errors.some((e) => e.startsWith('faqs[1].question')));
});
