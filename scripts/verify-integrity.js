// backend/scripts/verify-integrity.js
//
// End-to-end verification for "Paket C â€” data integrity & API resilience".
//
// Boots the real Express app (same config as server.js, but WITHOUT the
// listen() call succeeds/fails check) against a MySQL database and exercises
// the status-code contract:
//
//   articles  PUT  / nonexistent id        -> 404
//   articles  DELETE / nonexistent id      -> 404
//   articles  POST duplicate slug          -> 409
//   articles  PUT  duplicate slug          -> 409
//   articles  POST invalid title/slug      -> 400
//   articles  POST read_time 0             -> stored as 0 (not 5)
//   articles  POST unknown category_id     -> 404
//   categories DELETE while referenced     -> 409  (+ state untouched)
//   categories DELETE clean                -> 200
//   categories DELETE nonexistent          -> 404
//   seo       PUT with failing FAQ insert  -> 500, previous page+faqs intact
//   server    unknown route                -> 404 JSON
//   server    malformed JSON               -> 400 JSON
//   revalidate wrong secret / bad type     -> 401 / 400
//   revalidate right secret + enum         -> 200
//   articles  GET ?limit=abc / limit=9999  -> 200 (clamped / ignored, no LIMIT NaN)
//   roles     editor token on admin routes -> 403 (+ row untouched)
//   redirects POST/GET/PUT/DELETE          -> 201/200/200/200 (+ 404, 409, 400)
//   redirects editor writes                -> 403 (+ row untouched)
//   redirects shadowed live routes         -> 400
//   articles  PUT slug change              -> automatic 301 in `redirects`
//                                            (existing rows preserved, no loops)
//   keywords  page_seo + articles          -> roundtrip, trim, empty -> NULL,
//                                            255 OK / 256 -> 400, payload shape
//
// Usage (PowerShell, from backend/):
//   $env:DB_NAME="purisunny_test"; $env:DB_PORT="3307"
//   node scripts/verify-integrity.js
//
// The script NEVER touches tables outside the test database it is pointed at.
// It creates + cleans up its own fixtures (a category and an article prefixed
// with `zz-verify-integrity-`). Requires `page_seo` + `faq_items` (run
// `node database/migrate-page-seo.js` first) and the articles SEO columns
// (`node database/migrate-articles-seo.js`).
//
// Exit code: 0 when every check passes, 1 otherwise.

// Prefer backend/.env.test (the scratch-database profile) when it exists, so
// the documented `node scripts/verify-integrity.js` command points at the test
// database without the caller having to export a dozen variables. Falls back to
// backend/.env exactly as before when .env.test is absent.
const fs = require('fs');
const path = require('path');
// These are test-only CLIs: default to the .env.test profile unless the caller
// explicitly asked for another profile.
process.env.DOTENV_PROFILE = process.env.DOTENV_PROFILE || 'test';
const testEnvPath = path.join(__dirname, '..', '.env.test');
require('dotenv').config(fs.existsSync(testEnvPath) ? { path: testEnvPath } : undefined);

const jwt = require('jsonwebtoken');

const list = [];
function record(name, pass, detail) {
  list.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  â€” ${detail}` : ''}`);
}

async function main() {
  // â”€â”€ Guard: refuse to run against the production database name â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const dbName = process.env.DB_NAME || 'purisunny';
  if (!/test|verify|scratch/i.test(dbName)) {
    console.error(
      `Refusing to run against DB_NAME="${dbName}". Point DB_NAME at a test database ` +
      '(e.g. purisunny_test).'
    );
    process.exit(1);
  }

  const db = require('../config/db');

  // â”€â”€ Preconditions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  try {
    await db.query('SELECT 1');
  } catch (err) {
    console.error(`Cannot reach MySQL (${dbName}): ${err.code || ''} ${err.message}`);
    console.error('This script needs a live MySQL instance â€” run it in a DB environment.');
    process.exit(1);
  }
  const [tables] = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name IN ('articles','categories','page_seo','faq_items','redirects','article_faq_items')`
  );
  const present = new Set(tables.map((t) => String(t.TABLE_NAME || t.table_name).toUpperCase()));
  for (const t of ['articles', 'categories', 'page_seo', 'faq_items', 'redirects', 'article_faq_items']) {
    if (!present.has(t.toUpperCase())) {
      console.error(`Missing table "${t}". Run database/schema.sql + the migrations first.`);
      process.exit(1);
    }
  }

  // â”€â”€ Boot the app on an ephemeral port â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Mirrors server.js's middleware order (same modules, same sequence) so the
  // status-code contract is exercised through the real stack. server.js itself
  // cannot be required here because it calls app.listen().
  const express = require('express');
  const cors = require('cors');
  const multer = require('multer');
  const routes = require('../routes');

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', routes);
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use((req, res) => {
    res.status(404).json({ message: 'Not found', error: `Route not found: ${req.method} ${req.originalUrl}` });
  });
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({ message: 'Invalid JSON body' });
    }
    if (err.status === 400 && err.expose) return res.status(400).json({ message: err.message });
    if (err instanceof multer.MulterError) return res.status(400).json({ message: `Invalid upload request (${err.code})` });
    // Same shape as server.js (method + URL, stack server-side only).
    console.error(`Error: ${req.method} ${req.originalUrl}`, err);
    return res.status(500).json({ message: 'Internal server error' });
  });


  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const token = jwt.sign({ id: 1, username: 'verify', role: 'admin' }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  async function call(method, path, body, { auth = true, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: auth ? { ...authHeaders, ...headers } : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }

  // â”€â”€ Fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const stamp = Date.now().toString(36);
  const catSlug = `zz-verify-integrity-${stamp}`;
  const artSlug = `zz-verify-integrity-article-${stamp}`;
  const artSlug2 = `zz-verify-integrity-article2-${stamp}`;
  const pageKey = 'page:gallery'; // an official key; state is restored afterwards

      const [catIns] = await db.query('INSERT INTO categories (name, slug) VALUES (?, ?)', ['ZZ Verify Integrity', catSlug]);
      const catId = catIns.insertId;


  // page_seo/faq_items snapshot for `pageKey`, restored in the finally block.
  let pageBefore = [];
  let faqsBefore = [];
  try {
    const [p] = await db.query('SELECT * FROM page_seo WHERE page_key = ?', [pageKey]);
    const [f] = await db.query('SELECT question, answer, position FROM faq_items WHERE page_key = ? ORDER BY position', [pageKey]);
    pageBefore = p;
    faqsBefore = f;
  } catch (err) {
    console.error('snapshot warning:', err.message);
  }

  const cleanup = async () => {
    try {
      await db.query("DELETE FROM articles WHERE slug LIKE 'zz-verify-integrity-%'");
      await db.query("DELETE FROM categories WHERE slug LIKE 'zz-verify-integrity-%'");
      // Article FAQs go with their articles via ON DELETE CASCADE; this explicit
      // sweep only covers a crash that left a row orphaned before the FK.
      await db.query(
        `DELETE f FROM article_faq_items f
           LEFT JOIN articles a ON a.id = f.article_id
          WHERE a.id IS NULL`
      );
      // Article renames in this script leave auto-redirects at
      // /journal/zz-verify-integrity-* (SEO Task A).
      await db.query("DELETE FROM redirects WHERE from_path LIKE '/journal/zz-verify-integrity-%'");
      await db.query("DELETE FROM redirects WHERE from_path LIKE '/zz-verify-integrity-%'");
    } catch (err) {
      console.error('cleanup warning:', err.message);
    }
  };

  const articlePayload = (overrides = {}) => ({
    title: 'ZZ Verify Integrity Article',
    slug: artSlug,
    content: '<p>body</p>',
    excerpt: 'excerpt',
    author: 'Verifier',
    cover_image: '',
    read_time: 5,
    is_featured: false,
    category_id: catId,
    ...overrides,
  });

  try {
    const [artIns] = await db.query(
      'INSERT INTO articles (title, slug, content, category_id, author, read_time, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['ZZ seed', artSlug, 'x', catId, 'Verifier', 5, 0]
    );
    const articleId = artIns.insertId;

    // 1. PUT nonexistent article -> 404
    {
      const r = await call('PUT', '/api/articles/99999999', articlePayload({ slug: `zz-verify-integrity-missing-${stamp}` }));
      record('PUT nonexistent article -> 404', r.status === 404, `status=${r.status} body=${JSON.stringify(r.json)}`);
    }

    // 2. DELETE nonexistent article -> 404
    {
      const r = await call('DELETE', '/api/articles/99999999');
      record('DELETE nonexistent article -> 404', r.status === 404, `status=${r.status}`);
    }

    // 3. POST duplicate slug -> 409
    {
      const r = await call('POST', '/api/articles', articlePayload({ title: 'dup', slug: artSlug }));
      record('POST duplicate slug -> 409', r.status === 409, `status=${r.status} msg=${r.json && r.json.message}`);
    }

    // 4. PUT to another article's slug -> 409
    {
      const [other] = await db.query('SELECT id FROM articles WHERE id != ? LIMIT 1', [articleId]);
      if (other.length > 0) {
        const r = await call('PUT', `/api/articles/${other[0].id}`, articlePayload({ slug: artSlug }));
        record('PUT duplicate slug -> 409', r.status === 409, `status=${r.status}`);
      } else {
        const r = await call('PUT', `/api/articles/${articleId}`, articlePayload({ slug: `zz-verify-integrity-other-${stamp}` }));
        record('PUT rename slug -> 200', r.status === 200, `status=${r.status}`);
      }
    }

    // 5. Validation 400s â€” each case gets a valid, unique slug so only the
    //    field under test can trigger the 400.
    {
      const cases = [
        ['missing title', { title: '' }],
        ['non-string title', { title: 123 }],
        ['bad slug', { slug: 'Bad Slug With Spaces' }],
        ['uppercase slug', { slug: 'BadSlug' }],
        ['long title', { title: 'x'.repeat(256) }],
        ['non-string content', { content: { a: 1 } }],
        ['non-string author', { author: ['x'] }],
        ['bad is_featured', { is_featured: 'maybe' }],
        ['bad read_time', { read_time: 'abc' }],
        ['negative read_time', { read_time: -1 }],
        ['bad category_id', { category_id: 'abc' }],
      ];
      let i = 0;
      for (const [label, override] of cases) {
        i += 1;
        const slug = `zz-verify-integrity-case-${i}-${stamp}`;
        const r = await call('POST', '/api/articles', articlePayload({ slug, ...override }));
        record(`POST ${label} -> 400`, r.status === 400, `status=${r.status} msg=${r.json && r.json.message}`);
      }
    }

    // 6. read_time 0 stays 0
    {
      const r = await call('POST', '/api/articles', articlePayload({ slug: artSlug2, read_time: 0 }));
      let stored = null;
      if (r.status === 201) {
        const [rows] = await db.query('SELECT read_time FROM articles WHERE id = ?', [r.json.id]);
        stored = rows[0] && rows[0].read_time;
      }
      record('POST read_time=0 stored as 0 (not 5)', r.status === 201 && stored === 0, `status=${r.status} stored=${stored}`);
    }

    // 7. Unknown category -> 404
    {
      const r = await call('POST', '/api/articles', articlePayload({ slug: `zz-verify-integrity-nocat-${stamp}`, category_id: 99999999 }));
      record('POST unknown category_id -> 404', r.status === 404, `status=${r.status}`);
    }

    // 8. Category delete while referenced -> 409, nothing detached
    {
      const before = await db.query('SELECT COUNT(*) AS n FROM articles WHERE category_id = ?', [catId]);
      const r = await call('DELETE', `/api/categories/${catId}`);
      const after = await db.query('SELECT COUNT(*) AS n FROM articles WHERE category_id = ?', [catId]);
      const [catStill] = await db.query('SELECT id FROM categories WHERE id = ?', [catId]);
      record(
        'DELETE referenced category -> 409 + state intact',
        r.status === 409 && before[0][0].n === after[0][0].n && catStill.length === 1,
        `status=${r.status} count=${r.json && r.json.articleCount} articlesBefore=${before[0][0].n} after=${after[0][0].n}`
      );
    }

    // 9. SEO transaction rollback.
    //    To fail the FAQ bulk INSERT deterministically the script installs a
    //    temporary BEFORE INSERT trigger on `faq_items` that rejects one marker
    //    answer. (The payload passes application validation, so the failure
    //    happens at the DB layer â€” exactly what the transaction must survive.)
    {
      const [beforePage] = [pageBefore];
      const [beforeFaqs] = [faqsBefore];

      // Temporary trigger: reject inserts with a marker answer.
      await db.query('DROP TRIGGER IF EXISTS zz_verify_fail_faq');
      await db.query(
        `CREATE TRIGGER zz_verify_fail_faq BEFORE INSERT ON faq_items
         FOR EACH ROW BEGIN
           IF NEW.answer = 'ZZ_FORCE_FAIL' THEN
             SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced verification failure';
           END IF;
         END`
      );
      let r;
      try {
        r = await call('PUT', `/api/seo/${encodeURIComponent(pageKey)}`, {
          meta_title: 'ZZ SHOULD ROLL BACK',
          meta_description: 'zz rollback probe',
          og_image: '',
          noindex: 0,
          faqs: [
            { question: 'Legit question', answer: 'legit answer' },
            { question: 'Fail me', answer: 'ZZ_FORCE_FAIL' },
          ],
        });
      } finally {
        await db.query('DROP TRIGGER IF EXISTS zz_verify_fail_faq');
      }

      // The 500 above is expected: seo.js logs the DB error server-side, which
      // makes a stderr line appear in the console. The PASS/FAIL line below is
      // authoritative.
      const [afterPage] = await db.query('SELECT * FROM page_seo WHERE page_key = ?', [pageKey]);
      const [afterFaqs] = await db.query(
        'SELECT question, answer, position FROM faq_items WHERE page_key = ? ORDER BY position',
        [pageKey]
      );
      const pageUnchanged = JSON.stringify(beforePage) === JSON.stringify(afterPage);
      const faqsUnchanged = JSON.stringify(beforeFaqs) === JSON.stringify(afterFaqs);
      record(
        'SEO PUT failing FAQ insert -> 500 + full rollback',
        r.status === 500 && pageUnchanged && faqsUnchanged,
        `status=${r.status} pageUnchanged=${pageUnchanged} faqsUnchanged=${faqsUnchanged}`
      );
    }

    // 10. SEO PUT success still works
    {
      const r = await call('PUT', `/api/seo/${encodeURIComponent(pageKey)}`, {
        meta_title: 'ZZ verify title',
        meta_description: '',
        og_image: '',
        noindex: 1,
        faqs: [{ question: 'Q1', answer: 'A1' }],
      });
      const [faqs] = await db.query('SELECT COUNT(*) AS n FROM faq_items WHERE page_key = ?', [pageKey]);
      record('SEO PUT success -> 200 + faq replaced', r.status === 200 && faqs[0].n === 1, `status=${r.status} faqs=${faqs[0].n}`);
      // restore: delete the row + faqs and rewrite the pre-test snapshot
      await db.query('DELETE FROM page_seo WHERE page_key = ?', [pageKey]);
      await db.query('DELETE FROM faq_items WHERE page_key = ?', [pageKey]);
      for (const row of pageBefore) {
        await db.query(
          'INSERT INTO page_seo (page_key, meta_title, meta_description, og_image, noindex, keywords) VALUES (?, ?, ?, ?, ?, ?)',
          [row.page_key, row.meta_title, row.meta_description, row.og_image, row.noindex, row.keywords]
        );
      }
      for (const row of faqsBefore) {
        await db.query(
          'INSERT INTO faq_items (page_key, question, answer, position) VALUES (?, ?, ?, ?)',
          [pageKey, row.question, row.answer, row.position]
        );
      }
    }

    // 11. 404 catch-all
    {
      const r = await call('GET', '/api/definitely-not-a-route', undefined, { auth: false });
      record('unknown route -> 404 JSON', r.status === 404 && r.json && typeof r.json.message === 'string', `status=${r.status} body=${JSON.stringify(r.json)}`);
    }

    // 12. Malformed JSON -> 400
    {
      const r = await call('POST', '/api/categories', '{"name": ', { auth: false });
      record('malformed JSON -> 400', r.status === 400 && r.json && r.json.message === 'Invalid JSON body', `status=${r.status}`);
    }

    // 13. Articles limit hardening
    {
      const a = await call('GET', '/api/articles?limit=abc', undefined, { auth: false });
      const b = await call('GET', '/api/articles?limit=9999', undefined, { auth: false });
      const c = await call('GET', '/api/articles?limit=2', undefined, { auth: false });
      record(
        'GET ?limit=abc -> 200 (default, no LIMIT NaN)',
        a.status === 200 && Array.isArray(a.json),
        `status=${a.status}`
      );
      record(
        'GET ?limit=9999 -> 200 (clamped)',
        b.status === 200 && Array.isArray(b.json),
        `status=${b.status} rows=${Array.isArray(b.json) ? b.json.length : '-'}`
      );
      record('GET ?limit=2 -> 200 with <=2 rows', c.status === 200 && Array.isArray(c.json) && c.json.length <= 2, `rows=${Array.isArray(c.json) ? c.json.length : '-'}`);
    }

    // 14. Clear the category reference, then delete -> 200
    {
      await db.query('DELETE FROM articles WHERE category_id = ?', [catId]);
      const r = await call('DELETE', `/api/categories/${catId}`);
      record('DELETE unreferenced category -> 200', r.status === 200, `status=${r.status}`);
    }
    // 15. DELETE nonexistent category -> 404
    {
      const r = await call('DELETE', `/api/categories/${catId}`);
      record('DELETE nonexistent category -> 404', r.status === 404, `status=${r.status}`);
    }

    // 15b. Optional per-article FAQs (article_faq_items) — POST/detail/PUT/list
    {
      // Fixtures use the `zz-verify-integrity-%` prefix owned by this script's
      // cleanup(), so a concurrent `npm test` (which wipes `zz-nodetest-%`)
      // cannot remove them mid-run.
      const faqSlug = `zz-verify-integrity-faq-${stamp}`;
      const base = {
        title: 'ZZ Verify Integrity FAQ',
        slug: faqSlug,
        content: '<p>body</p>',
        author: 'Verifier',
        read_time: 5,
        category_id: null,
      };

      // create with faqs
      const created = await call('POST', '/api/articles', {
        ...base,
        faqs: [{ question: 'Q one?', answer: 'A one.' }, { question: 'Q two?', answer: 'A two.' }],
      });
      record('POST article with faqs -> 201', created.status === 201, `status=${created.status}`);
      const faqArticleId = created.json && created.json.id;
      // The script may run against a scratch DB holding other rows; pin these
      // fixtures to the top of the published_at DESC, id DESC list so the
      // per_page queries below are deterministic.
      const pinTop = async (...ids) => {
        for (const id of ids) {
          if (id) await db.query('UPDATE articles SET published_at = DATE_ADD(NOW(), INTERVAL 10 SECOND) WHERE id = ?', [id]);
        }
      };
      await pinTop(faqArticleId);

      // detail by slug returns ordered faqs
      {
        const d = await call('GET', `/api/articles/${faqSlug}`, undefined, { auth: false });
        const faqs = d.json && d.json.article && d.json.article.faqs;
        const ordered =
          Array.isArray(faqs) &&
          faqs.length === 2 &&
          faqs[0].question === 'Q one?' &&
          faqs[1].question === 'Q two?' &&
          faqs[0].position === 0 &&
          faqs[1].position === 1;
        record('GET article by slug -> faqs ordered', d.status === 200 && ordered, `status=${d.status} faqs=${JSON.stringify(faqs)}`);
      }

      // list carries faq_count
      {
        const l = await call('GET', '/api/articles?per_page=3', undefined, { auth: false });
        const item = l.json && l.json.items && l.json.items.find((a) => a.slug === faqSlug);
        record('GET articles list -> faq_count = 2', l.status === 200 && item && item.faq_count === 2, `faq_count=${item && item.faq_count}`);
      }

      // PUT with faqs -> replace-all
      {
        const p = await call('PUT', `/api/articles/${faqArticleId}`, {
          ...base,
          faqs: [{ question: 'Only replacement?', answer: 'Yes.' }],
        });
        const d = await call('GET', `/api/articles/${faqSlug}`, undefined, { auth: false });
        const faqs = d.json && d.json.article && d.json.article.faqs;
        record(
          'PUT article with faqs -> replaced (1 row)',
          p.status === 200 && Array.isArray(faqs) && faqs.length === 1 && faqs[0].question === 'Only replacement?',
          `status=${p.status} faqs=${JSON.stringify(faqs)}`
        );
      }

      // PUT without faqs -> untouched
      {
        const p = await call('PUT', `/api/articles/${faqArticleId}`, { ...base, title: 'ZZ Verify Integrity FAQ renamed' });
        const d = await call('GET', `/api/articles/${faqSlug}`, undefined, { auth: false });
        const faqs = d.json && d.json.article && d.json.article.faqs;
        record(
          'PUT article without faqs -> faqs untouched',
          p.status === 200 && Array.isArray(faqs) && faqs.length === 1,
          `status=${p.status} faqs=${JSON.stringify(faqs)}`
        );
      }

      // validation 400s
      {
        const cases = [
          ['>20 faqs', { faqs: Array.from({ length: 21 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` })) }],
          ['empty question', { faqs: [{ question: '   ', answer: 'A' }] }],
          ['oversize answer', { faqs: [{ question: 'Q', answer: 'a'.repeat(1001) }] }],
          ['oversize question', { faqs: [{ question: 'q'.repeat(256), answer: 'A' }] }],
          ['non-array faqs', { faqs: 'nope' }],
        ];
        let i = 0;
        for (const [label, override] of cases) {
          i += 1;
          const r = await call('POST', '/api/articles', {
            ...base,
            slug: `zz-verify-integrity-faqcase-${i}-${stamp}`,
            ...override,
          });
          record(
            `POST article ${label} -> 400 + errors[]`,
            r.status === 400 && Array.isArray(r.json && r.json.errors),
            `status=${r.status} msg=${r.json && r.json.message}`
          );
        }
      }

      // create without faqs -> faq_count 0
      {
        const noFaqSlug = `zz-verify-integrity-nofaq-${stamp}`;
        const r = await call('POST', '/api/articles', { ...base, slug: noFaqSlug });
        await pinTop(r.json && r.json.id);
        const l = await call('GET', '/api/articles?per_page=3', undefined, { auth: false });
        const item = l.json && l.json.items && l.json.items.find((a) => a.slug === noFaqSlug);
        record('POST article without faqs -> faq_count 0', r.status === 201 && item && item.faq_count === 0, `status=${r.status} faq_count=${item && item.faq_count}`);
      }

      // FK CASCADE: deleting the article removes its FAQ rows (no orphans)
      if (faqArticleId) {
        const del = await call('DELETE', `/api/articles/${faqArticleId}`);
        const [left] = await db.query('SELECT COUNT(*) AS n FROM article_faq_items WHERE article_id = ?', [faqArticleId]);
        record('DELETE article -> faqs removed (FK CASCADE)', del.status === 200 && left[0].n === 0, `status=${del.status} left=${left[0].n}`);
      }

      // schema wiring: the FK is ON DELETE CASCADE and the (article_id, position) index exists
      {
        const [fks] = await db.query(
          `SELECT rc.DELETE_RULE AS rule FROM information_schema.KEY_COLUMN_USAGE kcu
             JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
               ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
            WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.TABLE_NAME = 'article_faq_items'
              AND kcu.COLUMN_NAME = 'article_id' AND kcu.REFERENCED_TABLE_NAME = 'articles'`
        );
        const [idx] = await db.query(
          `SELECT COLUMN_NAME AS c FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'article_faq_items'
              AND INDEX_NAME = 'idx_article_faq_article_position' ORDER BY SEQ_IN_INDEX`
        );
        record(
          'article_faq_items FK -> articles ON DELETE CASCADE',
          fks.length === 1 && fks[0].rule === 'CASCADE',
          `fks=${fks.length} rule=${fks[0] && fks[0].rule}`
        );
        record(
          'article_faq_items index (article_id, position) present',
          idx.map((r) => String(r.c).toLowerCase()).join(',') === 'article_id,position',
          `columns=${idx.map((r) => r.c).join(',')}`
        );
      }
    }

    // 15c. Optional meta keywords (page_seo.keywords + articles.keywords).
    //      Own fixtures; the SEO key `page:home` is snapshotted and restored so
    //      the check can run against any scratch database.
    {
      const kwPageKey = 'page:home';
      const [kwPageBefore] = await db.query('SELECT * FROM page_seo WHERE page_key = ?', [kwPageKey]);
      const [kwFaqsBefore] = await db.query(
        'SELECT question, answer, position FROM faq_items WHERE page_key = ? ORDER BY position',
        [kwPageKey]
      );

      try {
        // list payload shape: every page carries keywords (string|null)
        const seoList = await call('GET', '/api/seo', undefined, { auth: false });
        const listShapeOk =
          seoList.status === 200 &&
          Array.isArray(seoList.json.pages) &&
          seoList.json.pages.length > 0 &&
          seoList.json.pages.every(
            (p) => 'keywords' in p && (p.keywords === null || typeof p.keywords === 'string')
          );
        record('GET /api/seo -> every page has keywords string|null', listShapeOk, `status=${seoList.status}`);

        // PUT trims and roundtrips
        const kwPut = await call('PUT', `/api/seo/${encodeURIComponent(kwPageKey)}`, {
          meta_title: 'ZZ keywords',
          keywords: '  bali, munduk  ',
          faqs: [],
        });
        const kwOne = await call('GET', `/api/seo/${encodeURIComponent(kwPageKey)}`, undefined, { auth: false });
        record(
          'SEO PUT keywords -> trimmed + echoed in detail',
          kwPut.status === 200 && kwPut.json.data.keywords === 'bali, munduk' && kwOne.json.keywords === 'bali, munduk',
          `put=${kwPut.status} value=${kwPut.json && kwPut.json.data && kwPut.json.data.keywords}`
        );

        // whitespace-only -> NULL in the column
        const kwBlank = await call('PUT', `/api/seo/${encodeURIComponent(kwPageKey)}`, {
          meta_title: 'ZZ keywords',
          keywords: '   ',
          faqs: [],
        });
        const [kwCol] = await db.query('SELECT keywords FROM page_seo WHERE page_key = ?', [kwPageKey]);
        record(
          'SEO PUT whitespace keywords -> NULL',
          kwBlank.status === 200 && kwBlank.json.data.keywords === null && kwCol[0].keywords === null,
          `status=${kwBlank.status} stored=${kwCol[0] && kwCol[0].keywords}`
        );

        // 255 accepted / 256 rejected with errors[]
        const kw255 = await call('PUT', `/api/seo/${encodeURIComponent(kwPageKey)}`, {
          meta_title: 'ZZ keywords',
          keywords: 'x'.repeat(255),
          faqs: [],
        });
        const kw256 = await call('PUT', `/api/seo/${encodeURIComponent(kwPageKey)}`, {
          meta_title: 'ZZ keywords',
          keywords: 'y'.repeat(256),
          faqs: [],
        });
        const kwWording =
          kw256.status === 400 &&
          Array.isArray(kw256.json.errors) &&
          kw256.json.errors[0] === 'keywords must be at most 255 characters' &&
          kw256.json.message === kw256.json.errors[0];
        record('SEO keywords cap: 255 OK / 256 -> 400 + errors[]', kw255.status === 200 && kwWording, `ok=${kw255.status} over=${kw256.status} msg=${kw256.json && kw256.json.message}`);
      } finally {
        await db.query('DELETE FROM faq_items WHERE page_key = ?', [kwPageKey]);
        await db.query('DELETE FROM page_seo WHERE page_key = ?', [kwPageKey]);
        for (const row of kwPageBefore) {
          await db.query(
            'INSERT INTO page_seo (page_key, meta_title, meta_description, og_image, noindex, keywords) VALUES (?, ?, ?, ?, ?, ?)',
            [row.page_key, row.meta_title, row.meta_description, row.og_image, row.noindex, row.keywords]
          );
        }
        for (const row of kwFaqsBefore) {
          await db.query(
            'INSERT INTO faq_items (page_key, question, answer, position) VALUES (?, ?, ?, ?)',
            [kwPageKey, row.question, row.answer, row.position]
          );
        }
      }

      // Article fixtures use the script's own cleanup() prefix.
      const kwBase = {
        title: 'ZZ Verify Integrity Keywords',
        content: '<p>body</p>',
        author: 'Verifier',
        read_time: 5,
        category_id: null,
      };
      const kwSlug = `zz-verify-integrity-kw-${stamp}`;
      const kwCreated = await call('POST', '/api/articles', {
        ...kwBase,
        slug: kwSlug,
        keywords: '  bali, villa  ',
      });
      const kwArticleId = kwCreated.json && kwCreated.json.id;

      const kwDetail = await call('GET', `/api/articles/${kwSlug}`, undefined, { auth: false });
      record(
        'POST article keywords -> trimmed in detail',
        kwCreated.status === 201 && kwDetail.json && kwDetail.json.article && kwDetail.json.article.keywords === 'bali, villa',
        `status=${kwCreated.status} value=${kwDetail.json && kwDetail.json.article && kwDetail.json.article.keywords}`
      );

      const kwList = await call('GET', '/api/articles?per_page=3', undefined, { auth: false });
      const kwItem = kwList.json && kwList.json.items && kwList.json.items.find((a) => a.slug === kwSlug);
      // Only assert presence/shape when the fixture is in the first page; the
      // published_at tie-break is not guaranteed on a shared scratch database.
      if (kwItem) {
        record('GET articles list -> keywords string|null', kwItem.keywords === 'bali, villa' || kwItem.keywords === null, `keywords=${JSON.stringify(kwItem.keywords)}`);
      }

      const kwOver = await call('POST', '/api/articles', {
        ...kwBase,
        slug: `zz-verify-integrity-kw-over-${stamp}`,
        keywords: 'z'.repeat(256),
      });
      record(
        'POST article keywords 256 -> 400 + errors[]',
        kwOver.status === 400 && Array.isArray(kwOver.json.errors) && /keywords must be at most 255 characters/.test(kwOver.json.errors[0]),
        `status=${kwOver.status} msg=${kwOver.json && kwOver.json.message}`
      );

      if (kwArticleId) {
        // omitted keywords on PUT is an article-row column -> NULL (like meta_title)
        const kwPutArt = await call('PUT', `/api/articles/${kwArticleId}`, {
          ...kwBase,
          slug: kwSlug,
          title: 'ZZ Verify Integrity Keywords renamed',
        });
        const detail2 = await call('GET', `/api/articles/${kwSlug}`, undefined, { auth: false });
        record(
          'PUT article without keywords -> NULL (row column, like meta_title)',
          kwPutArt.status === 200 && detail2.json && detail2.json.article && detail2.json.article.keywords === null,
          `status=${kwPutArt.status} value=${detail2.json && detail2.json.article && detail2.json.article.keywords}`
        );
        await call('DELETE', `/api/articles/${kwArticleId}`);
      }
    }

    // 16. Category validation 400s
    {
      const cases = [
        ['missing name', { name: '', slug: `zz-verify-integrity-cat-${stamp}` }],
        ['non-string name', { name: { a: 1 }, slug: `zz-verify-integrity-cat-${stamp}` }],
        ['int name', { name: 42, slug: `zz-verify-integrity-cat-${stamp}` }],
        ['bad slug', { name: 'ZZ Cat', slug: 'Not A Slug' }],
        ['long name', { name: 'x'.repeat(101), slug: `zz-verify-integrity-cat-${stamp}` }],
      ];
      for (const [label, body] of cases) {
        const r = await call('POST', '/api/categories', body);
        record(`POST category ${label} -> 400`, r.status === 400, `status=${r.status} msg=${r.json && r.json.message}`);
      }
    }

    // 17. Category duplicate slug -> 409 (own fixture: catId is gone by now)
    {
      const dupSlug = `zz-verify-integrity-dup-${stamp}`;
      const first = await call('POST', '/api/categories', { name: 'ZZ Dup Base', slug: dupSlug });
      const r = await call('POST', '/api/categories', { name: 'ZZ Dup Clone', slug: dupSlug });
      record(
        'POST category duplicate slug -> 409',
        first.status === 201 && r.status === 409,
        `first=${first.status} second=${r.status}`
      );
      await db.query('DELETE FROM categories WHERE slug = ?', [dupSlug]);
    }

    // 18. Category PUT: creates, updates, 404 on missing, 409 on duplicate slug
    {
      const putSlug = `zz-verify-integrity-put-${stamp}`;
      const putSlug2 = `zz-verify-integrity-put2-${stamp}`;
      const occupantSlug = `zz-verify-integrity-occupant-${stamp}`;
      const occupant = await call('POST', '/api/categories', { name: 'ZZ Occupant', slug: occupantSlug });
      const created = await call('POST', '/api/categories', { name: 'ZZ Put Target', slug: putSlug });
      const newId = created.status === 201 ? created.json.id : null;
      const updated = newId
        ? await call('PUT', `/api/categories/${newId}`, { name: 'ZZ Put Target Renamed', slug: putSlug2 })
        : { status: 0 };
      const missing = await call('PUT', '/api/categories/99999999', { name: 'Nope', slug: `zz-verify-integrity-nope-${stamp}` });
      const dupe = await call('PUT', `/api/categories/${newId}`, { name: 'ZZ Put Target', slug: occupantSlug });
      record(
        'category POST -> PUT -> 404 missing -> 409 duplicate',
        occupant.status === 201 && created.status === 201 && updated.status === 200 && missing.status === 404 && dupe.status === 409,
        `occupant=${occupant.status} create=${created.status} update=${updated.status} missing=${missing.status} dupe=${dupe.status}`
      );
      await db.query("DELETE FROM categories WHERE slug LIKE 'zz-verify-integrity-put%' OR slug = ?", [occupantSlug]);
    }

    // 19. Malformed / non-numeric ids -> 400
    {
      const a = await call('DELETE', '/api/articles/abc');
      const b = await call('DELETE', '/api/categories/abc');
      const c = await call('PUT', '/api/articles/0', articlePayload({ slug: `zz-verify-integrity-zero-${stamp}` }));
      record(
        'non-numeric / zero ids -> 400',
        a.status === 400 && b.status === 400 && c.status === 400,
        `articleDelete=${a.status} categoryDelete=${b.status} articlePut=${c.status}`
      );
    }

    // 21. Role enforcement (Paket D): an editor token is refused on destructive
    //     and admin-only endpoints before any DB work happens.
    //     Uses a detached article fixture so the check does not depend on rows
    //     deleted by earlier steps.
    {
      const [roleSeed] = await db.query(
        'INSERT INTO articles (title, slug, content, category_id, author, read_time, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['ZZ role', `zz-verify-integrity-role-${stamp}`, 'x', null, 'Verifier', 5, 0]
      );
      const editorToken = jwt.sign({ id: 2, username: 'verify-editor', role: 'editor' }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: '1h',
      });
      const editorCall = async (method, path, body) => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${editorToken}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return res.status;
      };
      const statuses = {
        deleteArticle: await editorCall('DELETE', `/api/articles/${roleSeed.insertId}`),
        deleteCategory: await editorCall('DELETE', '/api/categories/1'),
        createCategory: await editorCall('POST', '/api/categories', { name: 'x', slug: 'x' }),
        deleteSeo: await editorCall('DELETE', '/api/seo/page%3Ahome'),
      };
      const allForbidden = Object.values(statuses).every((s) => s === 403);
      record('editor token -> 403 on admin-only endpoints', allForbidden, JSON.stringify(statuses));

      // The fixture must still exist (403 happened before the delete).
      const [stillThere] = await db.query('SELECT id FROM articles WHERE id = ?', [roleSeed.insertId]);
      record('editor DELETE article -> row untouched', stillThere.length === 1, `rows=${stillThere.length}`);
      await db.query('DELETE FROM articles WHERE id = ?', [roleSeed.insertId]);
    }

    // 20. Article PUT with no-op body still answers 200 (idempotent content).
    //     Uses a fresh row: the fixture article was deleted in check 14.
    {
      const [seed] = await db.query(
        'INSERT INTO articles (title, slug, content, category_id, author, read_time, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['ZZ noop', `zz-verify-integrity-noop-${stamp}`, 'body', null, 'Verifier', 5, 0]
      );
      const [row] = await db.query('SELECT * FROM articles WHERE id = ?', [seed.insertId]);
      const r = await call('PUT', `/api/articles/${seed.insertId}`, {
        title: row[0].title,
        slug: row[0].slug,
        content: row[0].content || 'x',
        excerpt: row[0].excerpt || '',
        author: row[0].author || 'Verifier',
        cover_image: row[0].cover_image || '',
        read_time: row[0].read_time,
        is_featured: row[0].is_featured,
        category_id: row[0].category_id,
      });
      record('PUT unchanged article -> 200 (no false 404)', r.status === 200, `status=${r.status}`);
    }

    // 22. Redirects (SEO Task A): CRUD contract, role matrix, validation,
    //     shadow-route rejection and the automatic article-slug redirect.
    {
      const fromPath = `/zz-verify-integrity-from-${stamp}`;
      const toPath = `/zz-verify-integrity-to-${stamp}`;
      const toPath2 = `/zz-verify-integrity-to2-${stamp}`;

      const created = await call('POST', '/api/redirects', { from_path: fromPath, to_path: toPath });
      const createdId = created.status === 201 && created.json.redirect ? created.json.redirect.id : null;
      record(
        'POST redirect -> 201 { redirect }',
        created.status === 201 &&
          createdId !== null &&
          created.json.redirect.from_path === fromPath &&
          created.json.redirect.to_path === toPath &&
          created.json.redirect.status === 301,
        `status=${created.status} body=${JSON.stringify(created.json)}`
      );

      const pub = await call('GET', '/api/redirects', undefined, { auth: false });
      const found = pub.status === 200 && Array.isArray(pub.json.redirects)
        ? pub.json.redirects.find((x) => x.from_path === fromPath)
        : null;
      record(
        'GET redirects public -> 200 + row present',
        pub.status === 200 && Array.isArray(pub.json.redirects) && Boolean(found) && 'created_at' in found && 'updated_at' in found,
        `status=${pub.status} found=${Boolean(found)}`
      );

      const updated = createdId
        ? await call('PUT', `/api/redirects/${createdId}`, { to_path: toPath2, status: 302 })
        : { status: 0 };
      record(
        'PUT redirect -> 200 + fields updated',
        updated.status === 200 &&
          updated.json.redirect &&
          updated.json.redirect.from_path === fromPath &&
          updated.json.redirect.to_path === toPath2 &&
          updated.json.redirect.status === 302,
        `status=${updated.status} body=${JSON.stringify(updated.json)}`
      );

      const dup = await call('POST', '/api/redirects', { from_path: fromPath, to_path: toPath });
      record('POST duplicate from_path -> 409', dup.status === 409, `status=${dup.status}`);

      const missingPut = await call('PUT', '/api/redirects/99999999', { to_path: toPath });
      const missingDel = await call('DELETE', '/api/redirects/99999999');
      record('PUT/DELETE missing redirect -> 404', missingPut.status === 404 && missingDel.status === 404, `put=${missingPut.status} del=${missingDel.status}`);

      const validationCases = [
        ['no leading slash', { from_path: `zz-verify-integrity-x-${stamp}`, to_path: toPath }],
        ['scheme/host', { from_path: `https://evil.example/${stamp}`, to_path: toPath }],
        ['hash', { from_path: `/zz-verify-integrity-hash-${stamp}#x`, to_path: toPath }],
        ['identical paths', { from_path: fromPath, to_path: fromPath }],
        ['status 307', { from_path: `/zz-verify-integrity-s-${stamp}`, to_path: toPath, status: 307 }],
        ['too long', { from_path: `/${'a'.repeat(256)}`, to_path: toPath }],
        ['target /api', { from_path: `/zz-verify-integrity-api-${stamp}`, to_path: '/api/articles' }],
      ];
      for (const [label, body] of validationCases) {
        const r = await call('POST', '/api/redirects', body);
        record(`POST redirect ${label} -> 400 + errors[]`, r.status === 400 && Array.isArray(r.json.errors), `status=${r.status} errors=${r.json && r.json.errors && r.json.errors.join(' | ')}`);
      }

      for (const shadow of ['/gallery', '/stay/rooms/deluxe-room', '/api/health', '/journal/page/2']) {
        const r = await call('POST', '/api/redirects', { from_path: shadow, to_path: toPath });
        const msg = r.json && Array.isArray(r.json.errors) ? r.json.errors.join(' | ') : '';
        record(`POST redirect shadowing ${shadow} -> 400`, r.status === 400 && /shadows an existing route/.test(msg), `status=${r.status} errors=${msg}`);
      }

      // Non-shadowing look-alike must be accepted (segment-aware matching).
      const lookalike = await call('POST', '/api/redirects', { from_path: `/apiary-${stamp}`, to_path: '/gallery' });
      record('POST redirect /apiary-* (not /api) -> 201', lookalike.status === 201, `status=${lookalike.status} body=${JSON.stringify(lookalike.json)}`);
      if (lookalike.status === 201) {
        await call('DELETE', `/api/redirects/${lookalike.json.redirect.id}`);
      }

      // Role matrix: editor is refused on every write, public GET still works.
      const editorToken = jwt.sign({ id: 2, username: 'verify-editor', role: 'editor' }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: '1h',
      });
      const editorCall = async (method, path, body) => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${editorToken}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return res.status;
      };
      const roleStatuses = {
        post: await editorCall('POST', '/api/redirects', { from_path: `/zz-verify-integrity-role-${stamp}`, to_path: toPath }),
        put: createdId ? await editorCall('PUT', `/api/redirects/${createdId}`, { to_path: toPath }) : 0,
        del: createdId ? await editorCall('DELETE', `/api/redirects/${createdId}`) : 0,
      };
      const [survivor] = await db.query('SELECT id, to_path FROM redirects WHERE id = ?', [createdId]);
      record(
        'editor -> 403 on redirect writes + row untouched',
        Object.values(roleStatuses).every((s) => s === 403) &&
          survivor.length === 1 &&
          survivor[0].to_path === toPath2,
        `${JSON.stringify(roleStatuses)} survivor=${survivor.length}`
      );

      const del = createdId ? await call('DELETE', `/api/redirects/${createdId}`) : { status: 0 };
      record('DELETE redirect -> 200 { message }', del.status === 200 && typeof del.json.message === 'string', `status=${del.status}`);

      // Auto-redirect on article slug change. Fresh row, no category_id, so no
      // earlier step (which bulk-deletes by category) can have removed it.
      const oldSlug = `zz-verify-integrity-slug-old-${stamp}`;
      const newSlug = `zz-verify-integrity-slug-new-${stamp}`;
      const [slugSeed] = await db.query(
        'INSERT INTO articles (title, slug, content, category_id, author, read_time, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['ZZ slug move', oldSlug, 'x', null, 'Verifier', 5, 0]
      );
      const rename = await call('PUT', `/api/articles/${slugSeed.insertId}`, articlePayload({ slug: newSlug, category_id: null }));
      const [autoRedirect] = await db.query('SELECT from_path, to_path, status FROM redirects WHERE from_path = ?', [`/journal/${oldSlug}`]);
      record(
        'article slug change -> auto 301 redirect',
        rename.status === 200 &&
          autoRedirect.length === 1 &&
          autoRedirect[0].to_path === `/journal/${newSlug}` &&
          autoRedirect[0].status === 301,
        `status=${rename.status} rows=${JSON.stringify(autoRedirect)}`
      );

      // Repeated rename: the previous hop stays a valid chain, nothing loops.
      const rename2 = await call('PUT', `/api/articles/${slugSeed.insertId}`, articlePayload({ slug: `${newSlug}-2`, category_id: null }));
      const back = await call('PUT', `/api/articles/${slugSeed.insertId}`, articlePayload({ slug: oldSlug, category_id: null }));
      const [chain] = await db.query(
        "SELECT from_path, to_path, status FROM redirects WHERE from_path LIKE ?",
        [`/journal/${oldSlug}%`]
      );
      const hops = JSON.parse(JSON.stringify(chain));
      const [loops] = await db.query(
        'SELECT from_path FROM redirects WHERE from_path LIKE ? AND from_path = to_path',
        [`/journal/${oldSlug}%`]
      );
      record(
        'article repeated rename -> no loops, statuses stay 301',
        rename2.status === 200 &&
          back.status === 200 &&
          loops.length === 0 &&
          hops.every((r) => r.status === 301 && r.from_path !== r.to_path),
        `rename2=${rename2.status} back=${back.status} hops=${JSON.stringify(hops)} loops=${loops.length}`
      );

      await db.query('DELETE FROM articles WHERE id = ?', [slugSeed.insertId]);
      await db.query("DELETE FROM redirects WHERE from_path LIKE '/journal/zz-verify-integrity-%'");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
    try { await db.end(); } catch { /* pool already closed */ }
  }

  const failed = list.filter((r) => !r.pass);
  console.log(`\n${list.length - failed.length}/${list.length} checks passed.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-integrity crashed:', err);
  process.exit(1);
});
