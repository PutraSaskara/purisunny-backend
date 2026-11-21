// backend/test/unit/validateRedirects.test.js
//
// Pure validation for the redirects API (SEO Task A): path grammar, status
// enum, loop/self-redirect protection and live-route shadow protection.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAGE_ROUTES,
  shadowsLiveRoute,
  targetsInternalArea,
  validateRedirect,
  validateRedirectPatch,
} = require('../../utils/validateredirects');

test('validateRedirect accepts a minimal valid payload and defaults status to 301', () => {
  const { errors, values } = validateRedirect({ from_path: '/old-page', to_path: '/new-page' });
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { from_path: '/old-page', to_path: '/new-page', status: 301 });
});

test('validateRedirect trims paths and accepts numeric status strings', () => {
  const { errors, values } = validateRedirect({
    from_path: '  /old-page  ',
    to_path: '/new-page',
    status: '302',
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { from_path: '/old-page', to_path: '/new-page', status: 302 });
});

test('validateRedirect rejects missing, non-string and empty paths', () => {
  for (const body of [
    { to_path: '/x' },
    { from_path: 42, to_path: '/x' },
    { from_path: '   ', to_path: '/x' },
    { from_path: '/x' },
  ]) {
    const { errors } = validateRedirect(body);
    assert.ok(errors.length > 0, JSON.stringify(body));
  }
});

test('validateRedirect rejects paths without a leading slash', () => {
  const { errors } = validateRedirect({ from_path: 'old', to_path: 'new' });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /must start with "\/"/);
});

test('validateRedirect rejects scheme/host, fragments and whitespace', () => {
  const cases = [
    ['https://evil.example/x', /no scheme or host/],
    ['/a#b', /must not contain "#"/],
    ['/a b', /whitespace/],
  ];
  for (const [path, pattern] of cases) {
    const { errors } = validateRedirect({ from_path: path, to_path: '/ok' });
    assert.ok(errors.some((e) => pattern.test(e)), `${path} -> ${errors.join(' | ')}`);
  }
});

test('validateRedirect enforces the 255-character cap', () => {
  const ok = validateRedirect({ from_path: `/${'a'.repeat(254)}`, to_path: '/ok' });
  assert.deepEqual(ok.errors, []);
  const bad = validateRedirect({ from_path: `/${'a'.repeat(255)}`, to_path: '/ok' });
  assert.ok(bad.errors.some((e) => /at most 255 characters/.test(e)));
});

test('validateRedirect rejects from_path === to_path', () => {
  const { errors } = validateRedirect({ from_path: '/same', to_path: '/same' });
  assert.ok(errors.includes('from_path and to_path must be different'));
  // A trailing-slash variant is a different target, not a loop.
  assert.deepEqual(validateRedirect({ from_path: '/same', to_path: '/same/' }).errors, []);
});

test('validateRedirect restricts status to 301/302', () => {
  for (const status of [307, 308, 300, 0, 'abc', 1.5, -301]) {
    const { errors } = validateRedirect({ from_path: '/a', to_path: '/b', status });
    assert.ok(errors.includes('status must be 301 or 302'), `status=${status}`);
  }
  assert.deepEqual(validateRedirect({ from_path: '/a', to_path: '/b', status: 302 }).errors, []);
});

test('shadowsLiveRoute covers every PAGE_SEO_DEFAULTS path and reserved area', () => {
  for (const path of PAGE_ROUTES) {
    assert.equal(shadowsLiveRoute(path), true, path);
  }
  for (const path of [
    '/stay/rooms/deluxe-room',
    '/stay/rooms/whatever-new-room',
    '/api',
    '/api/articles',
    '/ADMIN',
    '/journal/page/2',
    '/_next/static/x',
    '/uploads/old.jpg',
    '/sitemap.xml',
    '/robots.txt',
    '/llms.txt',
    '/favicon.ico',
    '/icon.png',
    '/apple-icon.png',
  ]) {
    assert.equal(shadowsLiveRoute(path), true, path);
  }
});

test('shadowsLiveRoute is segment-aware (look-alikes are allowed)', () => {
  for (const path of [
    '/gallery-2023',
    '/add',
    '/apiary',
    '/contact-us',
    '/stay-forever',
    '/journal/page-2',
  ]) {
    assert.equal(shadowsLiveRoute(path), false, path);
  }
});

test('targetsInternalArea only blocks /api and /_next targets', () => {
  assert.equal(targetsInternalArea('/api/x'), true);
  assert.equal(targetsInternalArea('/_next/x'), true);
  assert.equal(targetsInternalArea('/apiary'), false);
  assert.equal(targetsInternalArea('/journal/page/2'), false);
  assert.equal(targetsInternalArea('/gallery'), false);
});

test('validateRedirect reports the shadow-route rejection message', () => {
  const { errors } = validateRedirect({ from_path: '/gallery', to_path: '/rooms' });
  assert.ok(errors.includes('from_path shadows an existing route'));

  const internal = validateRedirect({ from_path: '/retired', to_path: '/api/articles' });
  assert.ok(internal.errors.some((e) => /reserved non-page prefix/.test(e)));
});

test('validateRedirectPatch only validates supplied fields', () => {
  assert.deepEqual(validateRedirectPatch({}), { errors: [], values: {} });

  const partial = validateRedirectPatch({ status: 302 });
  assert.deepEqual(partial, { errors: [], values: { status: 302 } });

  const badPath = validateRedirectPatch({ to_path: 'nope' });
  assert.equal(badPath.errors.length, 1);

  const shadow = validateRedirectPatch({ from_path: '/rooms' });
  assert.ok(shadow.errors.includes('from_path shadows an existing route'));
});
