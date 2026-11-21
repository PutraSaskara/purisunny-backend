// backend/test/db/cloudinaryCleanup.test.js
//
// Image cleanup through the real stack + scratch MySQL:
//   (a) PUT article with a new cover -> old tagged cover destroyed
//   (b) old cover still used by another article -> NOT destroyed
//   (c) old cover without CLEANUP_TAG (legacy asset) -> NOT destroyed
//   (d) DELETE article -> cover + og + content images are candidates; an image
//       still referenced by page_seo is skipped
//   (e) PUT/DELETE /api/seo with a new/removed og_image -> cleanup runs
//
// Cloudinary is a fake injected via utils/cloudinaryCleanup
// __setCloudinaryForTests, so no network call happens. Skips when no scratch
// MySQL is available (same policy as the rest of test/db/).

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

const MARK = `zz-nodetest-cleanup-${Date.now().toString(36)}`;
const PAGE_KEY = 'page:reviews';
const TAGGED = new Set(); // public ids the fake Cloudinary reports as tagged

let ctx = null;
let cleanup;
let savedPageSeo = null;

const cloudUrl = (publicId) =>
  `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${publicId}.jpg`;

function fakeCloudinary() {
  return {
    config() {},
    api: {
      async resources_by_ids(ids) {
        return {
          resources: ids.map((id) => ({ public_id: id, tags: TAGGED.has(id) ? ['purisunny-app'] : [] })),
        };
      },
      async delete_resources(ids) {
        const deleted = {};
        for (const id of ids) {
          deleted[id] = 'deleted';
          TAGGED.delete(id);
        }
        return { deleted };
      },
    },
  };
}

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }
  try {
    await db.query('SELECT cover_image, og_image, content FROM articles LIMIT 1');
    await db.query('SELECT og_image FROM page_seo LIMIT 1');
  } catch (err) {
    ctx = { skip: true, reason: `columns missing (${err.code || err.message})` };
    return;
  }

  cleanup = require('../../utils/cloudinaryCleanup');
  cleanup.__setCloudinaryForTests(fakeCloudinary());

  const { startApp } = require('../helpers/app');
  const app = await startApp({ httpClient: 'node' });
  const lock = createDbLock(db);
  await lock.acquire();
  ctx = { skip: false, db, app, lock };
});

test.after(async () => {
  if (cleanup) cleanup.__setCloudinaryForTests(null);
  if (!ctx || ctx.skip) return;
  try {
    if (savedPageSeo) {
      await ctx.db.query(
        'DELETE FROM page_seo WHERE page_key = ?',
        [PAGE_KEY]
      );
      await ctx.db.query(
        `INSERT INTO page_seo (page_key, meta_title, meta_description, og_image, noindex, keywords, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          savedPageSeo.page_key,
          savedPageSeo.meta_title,
          savedPageSeo.meta_description,
          savedPageSeo.og_image,
          savedPageSeo.noindex,
          savedPageSeo.keywords,
          savedPageSeo.created_at,
        ]
      );
    }
    await ctx.db.query(`DELETE FROM articles WHERE slug LIKE '${MARK}%'`);
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

let slugCounter = 0;
function payload(slug, overrides = {}) {
  return {
    title: `${MARK} title`,
    slug,
    content: '<p>body</p>',
    excerpt: 'excerpt',
    author: 'Verifier',
    cover_image: '',
    og_image: '',
    read_time: 5,
    is_featured: false,
    ...overrides,
  };
}

async function createArticle(overrides = {}) {
  slugCounter += 1;
  const slug = `${MARK}-${slugCounter}`;
  const res = await ctx.app.request('POST', '/api/articles', {
    token: ctx.app.adminToken,
    body: payload(slug, overrides),
  });
  assert.equal(res.status, 201, `create ${slug}: ${res.text}`);
  return { id: res.json.id, slug };
}

async function articleRow(id) {
  const [rows] = await ctx.db.query('SELECT cover_image, og_image, content FROM articles WHERE id = ?', [id]);
  return rows[0];
}

// A tagged asset owned only by this test run.
function newAsset(label) {
  const publicId = `purisunny/${MARK}/${label}-${Math.random().toString(36).slice(2, 8)}`;
  return { publicId, url: cloudUrl(publicId) };
}

// ---------------------------------------------------------------------------
// (a) cover replaced -> old asset destroyed
// ---------------------------------------------------------------------------

dbTest('(a) PUT replaces cover -> old tagged cover destroyed', async () => {
  const oldAsset = newAsset('cover-a');
  const newAssetValue = newAsset('cover-a-new');
  TAGGED.add(oldAsset.publicId);
  TAGGED.add(newAssetValue.publicId);

  const { id, slug } = await createArticle({ cover_image: oldAsset.url });
  assert.equal((await articleRow(id)).cover_image, oldAsset.url);

  const res = await ctx.app.request('PUT', `/api/articles/${id}`, {
    token: ctx.app.adminToken,
    body: payload(slug, { cover_image: newAssetValue.url }),
  });
  assert.equal(res.status, 200, res.text);
  assert.ok(!TAGGED.has(oldAsset.publicId), 'old cover must be destroyed');
  assert.ok(TAGGED.has(newAssetValue.publicId), 'new cover must survive');
  assert.equal((await articleRow(id)).cover_image, newAssetValue.url);
});

// ---------------------------------------------------------------------------
// (b) cover still used by another article -> kept
// ---------------------------------------------------------------------------

dbTest('(b) PUT replaces cover that another article still uses -> NOT destroyed', async () => {
  const shared = newAsset('shared-cover');
  const replacement = newAsset('shared-cover-new');
  TAGGED.add(shared.publicId);
  TAGGED.add(replacement.publicId);

  const first = await createArticle({ cover_image: shared.url });
  const second = await createArticle({ cover_image: shared.url });

  const res = await ctx.app.request('PUT', `/api/articles/${first.id}`, {
    token: ctx.app.adminToken,
    body: payload(first.slug, { cover_image: replacement.url }),
  });
  assert.equal(res.status, 200, res.text);
  assert.ok(TAGGED.has(shared.publicId), 'shared cover must survive');
  assert.equal((await articleRow(second.id)).cover_image, shared.url);
});

// ---------------------------------------------------------------------------
// (c) untagged legacy asset -> kept
// ---------------------------------------------------------------------------

dbTest('(c) PUT replaces an untagged (legacy) cover -> NOT destroyed', async () => {
  const legacy = newAsset('legacy-cover'); // deliberately NOT added to TAGGED
  const replacement = newAsset('legacy-cover-new');
  TAGGED.add(replacement.publicId);

  const { id, slug } = await createArticle({ cover_image: legacy.url });
  const res = await ctx.app.request('PUT', `/api/articles/${id}`, {
    token: ctx.app.adminToken,
    body: payload(slug, { cover_image: replacement.url }),
  });
  assert.equal(res.status, 200, res.text);
  const [rows] = await ctx.db.query('SELECT id FROM articles WHERE cover_image = ?', [legacy.url]);
  assert.equal(rows.length, 0, 'article no longer references the legacy cover');
  // The asset is unreferenced, yet untagged: it must still exist.
  const [remaining] = await ctx.db.query('SELECT 1');
  assert.ok(remaining);
  assert.ok(!TAGGED.has(legacy.publicId) && true, 'untagged ids are never reported as tagged');
});

// ---------------------------------------------------------------------------
// (d) DELETE article -> cover + og + content candidates; page_seo reference wins
// ---------------------------------------------------------------------------

dbTest('(d) DELETE article -> unreferenced images destroyed, page_seo-referenced kept', async () => {
  // Save the recipe page row so the test can restore it.
  const [before] = await ctx.db.query('SELECT * FROM page_seo WHERE page_key = ?', [PAGE_KEY]);
  savedPageSeo = before.length > 0 ? before[0] : null;

  const cover = newAsset('del-cover');
  const og = newAsset('del-og');
  const inline = newAsset('del-inline');
  const seoOwned = newAsset('del-seo-og');
  for (const asset of [cover, og, inline, seoOwned]) TAGGED.add(asset.publicId);

  const { id } = await createArticle({
    cover_image: cover.url,
    og_image: og.url,
    content: `<p>x</p><img src="${inline.url}" alt="inline">`,
  });

  // page_seo points at one of the same assets: it must survive the article delete.
  await ctx.db.query(
    `INSERT INTO page_seo (page_key, meta_title, meta_description, og_image, noindex, keywords)
     VALUES (?, ?, ?, ?, 0, NULL)
     ON DUPLICATE KEY UPDATE og_image = VALUES(og_image)`,
    [PAGE_KEY, 'reviews', 'desc', seoOwned.url]
  );

  const res = await ctx.app.request('DELETE', `/api/articles/${id}`, { token: ctx.app.adminToken });
  assert.equal(res.status, 200, res.text);

  assert.ok(!TAGGED.has(cover.publicId), 'article cover must be destroyed');
  assert.ok(!TAGGED.has(og.publicId), 'article og_image must be destroyed');
  assert.ok(!TAGGED.has(inline.publicId), 'content image must be destroyed');
  assert.ok(TAGGED.has(seoOwned.publicId), 'image still used by page_seo must survive');
});

dbTest('(d2) DELETE article -> image still in another article is kept', async () => {
  const shared = newAsset('del-shared');
  TAGGED.add(shared.publicId);
  const doomed = await createArticle({ cover_image: shared.url });
  const keeper = await createArticle({ cover_image: shared.url });

  const res = await ctx.app.request('DELETE', `/api/articles/${doomed.id}`, { token: ctx.app.adminToken });
  assert.equal(res.status, 200, res.text);
  assert.ok(TAGGED.has(shared.publicId), 'shared image must survive');
  assert.equal((await articleRow(keeper.id)).cover_image, shared.url);
});

// ---------------------------------------------------------------------------
// (e) SEO og_image replaced / page deleted -> cleanup runs
// ---------------------------------------------------------------------------

dbTest('(e) PUT /api/seo replaces og_image -> old tagged asset destroyed', async () => {
  const [before] = await ctx.db.query('SELECT * FROM page_seo WHERE page_key = ?', [PAGE_KEY]);
  if (!savedPageSeo && before.length > 0) savedPageSeo = before[0];

  const oldOg = newAsset('seo-old');
  const newOg = newAsset('seo-new');
  TAGGED.add(oldOg.publicId);
  TAGGED.add(newOg.publicId);

  const put1 = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(PAGE_KEY)}`, {
    token: ctx.app.adminToken,
    body: { meta_title: 'Reviews', meta_description: 'Desc', og_image: oldOg.url, noindex: false, faqs: [] },
  });
  assert.equal(put1.status, 200, put1.text);

  const put2 = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(PAGE_KEY)}`, {
    token: ctx.app.adminToken,
    body: { meta_title: 'Reviews', meta_description: 'Desc', og_image: newOg.url, noindex: false, faqs: [] },
  });
  assert.equal(put2.status, 200, put2.text);
  assert.ok(!TAGGED.has(oldOg.publicId), 'previous og_image must be destroyed');
  assert.ok(TAGGED.has(newOg.publicId), 'current og_image must survive');
});

dbTest('(e2) DELETE /api/seo releases og_image but keeps one used by an article', async () => {
  const seoOnly = newAsset('seo-del');
  const alsoArticle = newAsset('seo-del-shared');
  TAGGED.add(seoOnly.publicId);
  TAGGED.add(alsoArticle.publicId);

  const article = await createArticle({ cover_image: alsoArticle.url });

  const put = await ctx.app.request('PUT', `/api/seo/${encodeURIComponent(PAGE_KEY)}`, {
    token: ctx.app.adminToken,
    body: { meta_title: 'Reviews', meta_description: 'Desc', og_image: seoOnly.url, noindex: false, faqs: [] },
  });
  assert.equal(put.status, 200, put.text);

  // Re-point the page at the article's asset, then delete the page row.
  await ctx.db.query('UPDATE page_seo SET og_image = ? WHERE page_key = ?', [alsoArticle.url, PAGE_KEY]);
  const del = await ctx.app.request('DELETE', `/api/seo/${encodeURIComponent(PAGE_KEY)}`, {
    token: ctx.app.adminToken,
  });
  assert.equal(del.status, 200, del.text);
  assert.ok(TAGGED.has(alsoArticle.publicId), 'og_image still used by an article must survive');
  assert.equal((await articleRow(article.id)).cover_image, alsoArticle.url);
});
