// backend/test/db/serviceSideEffects.test.js
//
// DB-backed HTTP contract checks for the side effects that now live in the
// service layer:
//   - article create/update/delete: FAQ replace, slug-change 301, Cloudinary
//     cleanup of replaced/removed images
//   - duplicate article slug -> 409
//   - referenced category delete -> 409
//   - contact 201 / 502 response bodies with the row always stored
//
// Skips (does not fail) when no scratch MySQL is available, like the rest of
// test/db/. Cloudinary is replaced by a local fake (__setCloudinaryForTests),
// so no provider network access happens.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

const MARK = `zz-nodetest-side-${Date.now().toString(36)}`;
const SLUG_PREFIX = `${MARK}-article-`;
const CATEGORY_PREFIX = `${MARK}-cat-`;
const CONTACT_MARK = `${MARK}-contact-`;

let ctx = null;
let contactRoute = null;
let cleanupUtil = null;
const destroyed = [];

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }

  // Tables added by later migrations: skip the whole suite rather than fail on
  // a scratch DB that predates them.
  try {
    await db.query('SELECT 1 FROM article_faq_items LIMIT 1');
    await db.query('SELECT 1 FROM redirects LIMIT 1');
    await db.query('SELECT id FROM contacts LIMIT 1');
  } catch (err) {
    ctx = { skip: true, reason: `required tables missing (${err.code || err.message}) — run node scripts/setup-test-db.js` };
    return;
  }

  cleanupUtil = require('../../utils/cloudinaryCleanup');
  cleanupUtil.__setCloudinaryForTests({
    api: {
      async resources_by_ids(ids) {
        return {
          resources: ids.map((id) => ({ public_id: id, tags: [cleanupUtil.CLEANUP_TAG] })),
        };
      },
      async delete_resources(ids) {
        destroyed.push(...ids);
        const deleted = {};
        for (const id of ids) deleted[id] = 'deleted';
        return { deleted };
      },
    },
  });

  const { startApp } = require('../helpers/app');
  // node:http avoids the Windows undici keep-alive race on the contact router.
  const app = await startApp({ httpClient: 'node' });
  const lock = createDbLock(db);
  await lock.acquire();
  contactRoute = require('../../routes/contact');
  ctx = { skip: false, db, app, lock };
});

test.after(async () => {
  if (contactRoute) contactRoute.__setMailerForTests(null);
  if (cleanupUtil) cleanupUtil.__setCloudinaryForTests(null);
  if (!ctx || ctx.skip) return;
  try {
    await ctx.db.query('DELETE FROM articles WHERE slug LIKE ?', [`${SLUG_PREFIX}%`]);
    await ctx.db.query('DELETE FROM redirects WHERE from_path LIKE ?', [`/journal/${SLUG_PREFIX}%`]);
    await ctx.db.query('DELETE FROM categories WHERE slug LIKE ?', [`${CATEGORY_PREFIX}%`]);
    await ctx.db.query('DELETE FROM contacts WHERE name LIKE ?', [`${CONTACT_MARK}%`]);
  } catch { /* best effort */ }
  if (ctx.lock) await ctx.lock.close();
  await ctx.app.close();
  try { await ctx.db.end(); } catch { /* already closed */ }
});

function dbTest(name, fn) {
  test(name, async (t) => {
    if (ctx.skip) return t.skip(`DB tests skipped: ${ctx.reason}`);
    return withTestDbLock(ctx.lock, () => fn(t));
  });
}

function stamp() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function cloudUrl(name) {
  return `https://res.cloudinary.com/test-cloud/image/upload/v1/purisunny/${name}.jpg`;
}

function articlePayload(slug, overrides = {}) {
  return {
    title: 'Node test side effects',
    slug,
    content: '<p>body</p>',
    excerpt: 'excerpt',
    author: 'Verifier',
    cover_image: '',
    read_time: 5,
    is_featured: false,
    ...overrides,
  };
}

function contactPayload(suffix, overrides = {}) {
  return {
    name: `${CONTACT_MARK}-${suffix}`,
    email: `${suffix}@example.test`,
    phone: '+62 812-0000-0000',
    message: `Pesan uji side effect ${suffix} yang cukup panjang.`,
    ...overrides,
  };
}

dbTest('article create -> update -> delete: FAQs, slug redirect and image cleanup', async () => {
  const s = stamp();
  const oldSlug = `${SLUG_PREFIX}${s}-old`;
  const newSlug = `${SLUG_PREFIX}${s}-new`;
  const oldCover = cloudUrl(`zz-side-old-cover-${s}`);
  const oldOg = cloudUrl(`zz-side-old-og-${s}`);
  const oldContent = cloudUrl(`zz-side-old-content-${s}`);
  const newCover = cloudUrl(`zz-side-new-cover-${s}`);
  const newOg = cloudUrl(`zz-side-new-og-${s}`);
  const newContent = cloudUrl(`zz-side-new-content-${s}`);

  const created = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: articlePayload(oldSlug, {
      content: `<p><img src="${oldContent}"></p>`,
      cover_image: oldCover,
      og_image: oldOg,
      faqs: [
        { question: 'Old one?', answer: 'First.' },
        { question: 'Old two?', answer: 'Second.' },
      ],
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const articleId = created.json.id;
  assert.equal(created.json.message, 'Article created');

  const detail = await ctx.app.request('GET', `/api/articles/${oldSlug}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(
    detail.json.article.faqs.map((f) => [f.question, f.answer, f.position]),
    [['Old one?', 'First.', 0], ['Old two?', 'Second.', 1]]
  );

  const [oldFaqs] = await ctx.db.query(
    'SELECT id FROM article_faq_items WHERE article_id = ? ORDER BY id',
    [articleId]
  );
  assert.equal(oldFaqs.length, 2);

  const updated = await ctx.app.request('PUT', `/api/articles/${articleId}`, {
    token: ctx.app.adminToken,
    body: articlePayload(newSlug, {
      content: `<p><img src="${newContent}"></p>`,
      cover_image: newCover,
      og_image: newOg,
      faqs: [{ question: 'New only?', answer: 'Replacement.' }],
    }),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));

  // FAQ replace semantics: old rows gone, new row present in the same position.
  const [newFaqs] = await ctx.db.query(
    'SELECT id, question, answer, position FROM article_faq_items WHERE article_id = ? ORDER BY position',
    [articleId]
  );
  assert.equal(newFaqs.length, 1);
  assert.equal(newFaqs[0].question, 'New only?');
  assert.ok(!oldFaqs.some((row) => row.id === newFaqs[0].id), 'FAQ rows must be replaced, not reused');

  // Slug change leaves the automatic 301.
  const [redirects] = await ctx.db.query(
    'SELECT from_path, to_path, status FROM redirects WHERE from_path = ?',
    [`/journal/${oldSlug}`]
  );
  assert.equal(redirects.length, 1);
  assert.equal(redirects[0].to_path, `/journal/${newSlug}`);
  assert.equal(redirects[0].status, 301);

  // Replaced cover/og/content images are released post-commit.
  const oldCoverId = cleanupUtil.extractCloudinaryPublicId(oldCover);
  const oldOgId = cleanupUtil.extractCloudinaryPublicId(oldOg);
  const oldContentId = cleanupUtil.extractCloudinaryPublicId(oldContent);
  assert.ok(destroyed.includes(oldCoverId), `old cover not cleaned: ${destroyed.join(', ')}`);
  assert.ok(destroyed.includes(oldOgId), `old og not cleaned: ${destroyed.join(', ')}`);
  assert.ok(destroyed.includes(oldContentId), `old content image not cleaned: ${destroyed.join(', ')}`);

  const deleted = await ctx.app.request('DELETE', `/api/articles/${articleId}`, {
    token: ctx.app.adminToken,
  });
  assert.equal(deleted.status, 200);

  const [articleRows] = await ctx.db.query('SELECT id FROM articles WHERE id = ?', [articleId]);
  assert.equal(articleRows.length, 0);
  const [faqRows] = await ctx.db.query('SELECT id FROM article_faq_items WHERE article_id = ?', [articleId]);
  assert.equal(faqRows.length, 0, 'FAQ rows must cascade with the article');

  const newCoverId = cleanupUtil.extractCloudinaryPublicId(newCover);
  const newOgId = cleanupUtil.extractCloudinaryPublicId(newOg);
  const newContentId = cleanupUtil.extractCloudinaryPublicId(newContent);
  assert.ok(destroyed.includes(newCoverId), 'deleted article cover not cleaned');
  assert.ok(destroyed.includes(newOgId), 'deleted article og not cleaned');
  assert.ok(destroyed.includes(newContentId), 'deleted article content image not cleaned');
});

dbTest('article duplicate slug -> 409 with the existing body', async () => {
  const slug = `${SLUG_PREFIX}${stamp()}-dup`;
  const first = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: articlePayload(slug),
  });
  assert.equal(first.status, 201);

  const duplicate = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: articlePayload(slug),
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.message, 'An article with this slug already exists');
  assert.deepEqual(duplicate.json.errors, ['slug must be unique']);

  const [rows] = await ctx.db.query('SELECT id FROM articles WHERE slug = ?', [slug]);
  assert.equal(rows.length, 1);

  await ctx.app.request('DELETE', `/api/articles/${first.json.id}`, { token: ctx.app.adminToken });
});

dbTest('category delete while referenced -> 409 and leaves the category intact', async () => {
  const s = stamp();
  const categorySlug = `${CATEGORY_PREFIX}${s}`;
  const articleSlug = `${SLUG_PREFIX}${s}-catref`;

  const category = await ctx.app.request('POST', '/api/categories', {
    token: ctx.app.adminToken,
    body: { name: `ZZ side ${s}`, slug: categorySlug },
  });
  assert.equal(category.status, 201, JSON.stringify(category.json));
  const categoryId = category.json.id;

  const article = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: articlePayload(articleSlug, { category_id: categoryId }),
  });
  assert.equal(article.status, 201, JSON.stringify(article.json));

  const refused = await ctx.app.request('DELETE', `/api/categories/${categoryId}`, {
    token: ctx.app.adminToken,
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.articleCount, 1);
  assert.match(refused.json.message, /1 article still reference it/);

  const stillThere = await ctx.app.request('GET', `/api/categories/${categoryId}`);
  assert.equal(stillThere.status, 200);
  assert.equal(stillThere.json.slug, categorySlug);

  await ctx.app.request('DELETE', `/api/articles/${article.json.id}`, { token: ctx.app.adminToken });
  const removed = await ctx.app.request('DELETE', `/api/categories/${categoryId}`, {
    token: ctx.app.adminToken,
  });
  assert.equal(removed.status, 200);
});

dbTest('contact: 201 when delivered, 502 + fallback when mail fails, row always stored', async () => {
  const route = contactRoute;
  assert.ok(route && typeof route.__setMailerForTests === 'function');

  const calls = [];
  route.__setMailerForTests({
    isEmailConfigured: () => true,
    missingEmailConfigKeys: () => [],
    async sendContactEmail(payload) {
      calls.push(payload);
      return calls.length === 1 ? { sent: true } : { sent: false, error: 'connect ECONNREFUSED' };
    },
  });

  const ok = await ctx.app.request('POST', '/api/contact', {
    body: contactPayload('ok'),
  });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.json, {
    message: 'Message sent successfully',
    email_sent: true,
  });

  const failed = await ctx.app.request('POST', '/api/contact', {
    body: contactPayload('fail'),
  });
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.json, {
    message: 'We could not deliver your message right now. Please contact us via WhatsApp.',
    fallback: 'whatsapp',
    email_sent: false,
  });

  const [okRows] = await ctx.db.query('SELECT id FROM contacts WHERE name = ?', [`${CONTACT_MARK}-ok`]);
  const [failRows] = await ctx.db.query('SELECT id FROM contacts WHERE name = ?', [`${CONTACT_MARK}-fail`]);
  assert.equal(okRows.length, 1, 'successful delivery row must be stored');
  assert.equal(failRows.length, 1, 'failed delivery row must still be stored');

  route.__setMailerForTests(null);
});
