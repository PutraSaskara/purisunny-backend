// backend/test/unit/agentSanitize.test.js
//
// Allowlist behaviour for HTML written through the Agent API.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeArticleContent } = require('../../agent/sanitize');

test('sanitizer removes script tags and their content', () => {
  const cleaned = sanitizeArticleContent('<p>Safe</p><script>alert(1)</script>');
  assert.equal(cleaned, '<p>Safe</p>');
});

test('sanitizer removes img onerror handlers', () => {
  const cleaned = sanitizeArticleContent('<img src="https://example.test/a.jpg" onerror="alert(1)" alt="A">');
  assert.match(cleaned, /<img[^>]*src="https:\/\/example\.test\/a\.jpg"/);
  assert.equal(/onerror/i.test(cleaned), false);
});

test('sanitizer removes javascript: URLs', () => {
  const cleaned = sanitizeArticleContent('<a href="javascript:alert(1)">click</a>');
  assert.equal(/javascript:/i.test(cleaned), false);
  assert.match(cleaned, /click/);
});

test('sanitizer removes iframe elements', () => {
  const cleaned = sanitizeArticleContent('<p>Before</p><iframe src="https://evil.test"></iframe><p>After</p>');
  assert.equal(/iframe/i.test(cleaned), false);
  assert.match(cleaned, /Before/);
  assert.match(cleaned, /After/);
});

test('sanitizer keeps a valid article body and adds noopener to _blank links', () => {
  const html = [
    '<h2 id="intro">Intro</h2>',
    '<p><strong>Bold</strong> and <em>italic</em>.</p>',
    '<ul><li>One</li><li>Two</li></ul>',
    '<figure><img src="https://example.test/photo.jpg" alt="Photo" width="800"><figcaption>Caption</figcaption></figure>',
    '<a href="https://example.test/more" target="_blank">More</a>',
    '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>D</td></tr></tbody></table>',
    '<pre><code>const x = 1;</code></pre>',
  ].join('');
  const cleaned = sanitizeArticleContent(html);
  assert.match(cleaned, /<h2 id="intro">/);
  assert.match(cleaned, /<figure>/);
  assert.match(cleaned, /<table>/);
  assert.match(cleaned, /<pre><code>/);
  assert.match(cleaned, /rel="noopener noreferrer"/);
});

test('sanitizer strips style/object/embed/form/input and unknown attributes', () => {
  const cleaned = sanitizeArticleContent(
    '<style>body{}</style><object data="x"></object><embed src="x">' +
    '<form><input value="x"></form><p data-evil="1">text</p>'
  );
  assert.equal(/style|object|embed|form|input/i.test(cleaned), false);
  assert.equal(/data-evil/i.test(cleaned), false);
  assert.match(cleaned, /text/);
});

test('sanitizer handles non-string input', () => {
  assert.equal(sanitizeArticleContent(null), '');
  assert.equal(sanitizeArticleContent(undefined), '');
  assert.equal(sanitizeArticleContent(42), '');
});
