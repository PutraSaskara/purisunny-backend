// backend/scripts/verify-revalidate.js
//
// Verifies the POST /api/revalidate contract in
// frontend/app/api/revalidate/route.js without booting Next.js:
//
//   1. wrong secret                -> 401
//   2. missing secret header       -> 401
//   3. right secret, no type       -> 200 (article, legacy contract)
//   4. right secret, type=article  -> 200 + journal LIST pages invalidated
//   5. right secret, type=page     -> 200 + seo:<key> tags invalidated
//   6. unknown type                -> 400 (was silently treated as an article)
//   7. missing slug                -> 400
//   8. type=redirect, no slug      -> 200 + `redirects` tag invalidated
//
// The route is transformed to CommonJS in memory: `next/cache` import and the
// `@/lib/pageSeo` import are replaced by small recording stubs, so nothing but
// the route's own logic runs. No Next.js build/DB required.
//
// Usage: node scripts/verify-revalidate.js
//        REVALIDATE_SECRET=... node scripts/verify-revalidate.js   (optional)

const fs = require('fs');
const path = require('path');

const ROUTE_FILE = path.join(__dirname, '..', '..', 'frontend', 'app', 'api', 'revalidate', 'route.js');
const SECRET = process.env.REVALIDATE_SECRET || 'zz-verify-revalidate-secret';
process.env.REVALIDATE_SECRET = SECRET;

const calls = [];
const cacheStub = {
  revalidateTag: (tag, profile) => calls.push({ kind: 'tag', tag, profile }),
  revalidatePath: (p, type) => calls.push({ kind: 'path', path: p, type }),
};

function loadRoute() {
  const source = fs.readFileSync(ROUTE_FILE, 'utf8');

  const patched = source
    .replace(/^import \{ revalidateTag, revalidatePath \} from 'next\/cache';$/m, '')
    .replace(/^import \{ createHash, timingSafeEqual \} from 'node:crypto';$/m, '')
    .replace(/^import \{ pageKeyToPath \} from '@\/lib\/pageSeo';$/m, '')
    .replace(/^export async function POST/m, 'async function POST');

  const body = `
    const { createHash, timingSafeEqual } = __stubs.crypto;
    const { revalidateTag, revalidatePath } = __stubs.cache;
    const pageKeyToPath = __stubs.pageKeyToPath;
    const fetch = __stubs.fetch;
    ${patched}
    return { POST };
  `;

  // eslint-disable-next-line no-new-func
  const factory = new Function('__stubs', body);
  return factory({
    cache: cacheStub,
    crypto: require('node:crypto'),
    pageKeyToPath: (key) => (key.startsWith('page:') ? `/${key.slice(5)}` : null),
    // Article-flow probes call GET /articles/:slug; stub a 200 so the test does
    // not depend on (or connect to) a running backend.
    fetch: async () => ({ status: 200, ok: true }),
  });
}

function makeRequest({ secret, body }) {
  const headers = new Map();
  if (secret !== undefined) headers.set('x-revalidate-secret', secret);
  return {
    headers: { get: (name) => (headers.has(name) ? headers.get(name) : null) },
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  };
}

async function main() {
  const { POST } = loadRoute();

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };

  async function run({ secret, body }) {
    calls.length = 0;
    const res = await POST(makeRequest({ secret, body }));
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, calls: [...calls] };
  }

  // 1. wrong secret
  {
    const r = await run({ secret: 'wrong-secret', body: { slug: 'some-article' } });
    check('wrong secret -> 401', r.status === 401 && r.calls.length === 0, `status=${r.status}`);
  }

  // 1b. near-miss secret (same prefix, one char different) -> 401
  {
    const r = await run({ secret: `${SECRET}x`, body: { slug: 'some-article' } });
    check('near-miss secret -> 401', r.status === 401 && r.calls.length === 0, `status=${r.status}`);
  }

  // 2. missing header
  {
    const r = await run({ body: { slug: 'some-article' } });
    check('missing secret header -> 401', r.status === 401 && r.calls.length === 0, `status=${r.status}`);
  }

  // 3. right secret, no type (legacy article contract)
  //    (fetch is stubbed to 200, so the route answers 200 for a known article)
  {
    const r = await run({ secret: SECRET, body: { slug: 'legacy-article' } });
    const tags = r.calls.filter((c) => c.kind === 'tag').map((c) => c.tag);
    check(
      'right secret + no type -> 200 article flow',
      r.status === 200 && tags.includes('article:legacy-article') && tags.includes('article-list'),
      `status=${r.status} tags=${tags.join(',')}`
    );
  }

  // 4. explicit article type -> journal LIST pages invalidated
  {
    const r = await run({ secret: SECRET, body: { slug: 'typed-article', type: 'article' } });
    const paths = r.calls.filter((c) => c.kind === 'path');
    const hasJournalRoot = paths.some((c) => c.path === '/journal');
    const hasJournalPages = paths.some((c) => c.path === '/journal/page/[n]' && c.type === 'page');
    const hasDetail = paths.some((c) => c.path === '/journal/typed-article');
    const hasSitemap = paths.some((c) => c.path === '/sitemap.xml');
    check(
      'type=article -> journal list + detail + sitemap invalidated',
      r.status === 200 && hasJournalRoot && hasJournalPages && hasDetail && hasSitemap,
      `paths=${paths.map((p) => p.path + (p.type ? `(${p.type})` : '')).join(', ')}`
    );
  }

  // 5. page type
  {
    const r = await run({ secret: SECRET, body: { slug: 'page:gallery', type: 'page' } });
    const tags = r.calls.filter((c) => c.kind === 'tag').map((c) => c.tag);
    check(
      'type=page -> seo tags + mapped route',
      r.status === 200 && tags.includes('seo:page:gallery') && tags.includes('seo:all'),
      `status=${r.status} tags=${tags.join(',')}`
    );
  }

  // 5b. redirect type (SEO Task A) — no slug, only the redirects tag
  {
    const r = await run({ secret: SECRET, body: { type: 'redirect' } });
    const tags = r.calls.filter((c) => c.kind === 'tag').map((c) => c.tag);
    const paths = r.calls.filter((c) => c.kind === 'path');
    check(
      'type=redirect -> 200 + redirects tag',
      r.status === 200 && tags.includes('redirects') && paths.length === 0,
      `status=${r.status} tags=${tags.join(',')}`
    );
  }

  // 5c. redirect type ignores a stray slug instead of running the article flow
  {
    const r = await run({ secret: SECRET, body: { slug: 'leftover', type: 'redirect' } });
    const tags = r.calls.filter((c) => c.kind === 'tag').map((c) => c.tag);
    check(
      'type=redirect with slug -> only redirects tag',
      r.status === 200 && tags.includes('redirects') && !tags.includes('article:leftover'),
      `status=${r.status} tags=${tags.join(',')}`
    );
  }

  // 6. unknown type -> 400 (previously treated as an article)
  for (const type of ['bogus', 'Article', 'ARTICLE', 'pages', '123']) {
    const r = await run({ secret: SECRET, body: { slug: 'some-article', type } });
    check(`unknown type "${type}" -> 400`, r.status === 400 && r.calls.length === 0, `status=${r.status} calls=${r.calls.length}`);
  }

  // 7. missing slug
  {
    const r = await run({ secret: SECRET, body: { type: 'article' } });
    check('missing slug -> 400', r.status === 400, `status=${r.status}`);
  }

  // 8. exact secret from a different string type / empty -> 401
  {
    const r = await run({ secret: '', body: { slug: 'x' } });
    check('empty secret -> 401', r.status === 401, `status=${r.status}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-revalidate crashed:', err);
  process.exit(1);
});
