// backend/test/unit/cloudinaryCleanup.test.js
//
// Pure parsing checks for utils/cloudinaryCleanup.js (no DB, no network):
//   - extractCloudinaryPublicId: only OUR cloud, OUR folder, image/upload paths
//   - extractContentImageUrls: src attributes, dedupe, null safety
//   - cleanupCloudinaryAssets: never throws, tag-gated, DB-reference-gated
//
// The cleanup cases inject both a fake Cloudinary client and a fake DB pool, so
// no connection is opened. Anything that is not clearly ours must be a no-op.

require('../helpers/env');
process.env.CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'purisunny';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLEANUP_TAG,
  extractCloudinaryPublicId,
  extractContentImageUrls,
  cleanupCloudinaryAssets,
  __setCloudinaryForTests,
} = require('../../utils/cloudinaryCleanup');

const CLOUD = process.env.CLOUDINARY_CLOUD_NAME; // set by test/helpers/env.js
const base = `https://res.cloudinary.com/${CLOUD}/image/upload`;

test.after(() => __setCloudinaryForTests(null));

// ---------------------------------------------------------------------------
// extractCloudinaryPublicId
// ---------------------------------------------------------------------------

test('extractCloudinaryPublicId: plain URL under our folder', () => {
  assert.equal(
    extractCloudinaryPublicId(`${base}/purisunny/rooms/deluxe.jpg`),
    'purisunny/rooms/deluxe'
  );
});

test('extractCloudinaryPublicId: transformation + version segments are skipped', () => {
  assert.equal(
    extractCloudinaryPublicId(`${base}/c_fill,w_800,h_600/q_auto:good/v1712345678/purisunny/a/b.png`),
    'purisunny/a/b'
  );
  assert.equal(
    extractCloudinaryPublicId(`${base}/w_400/v12/purisunny/single.webp`),
    'purisunny/single'
  );
});

test('extractCloudinaryPublicId: keeps dots inside the id, drops only the extension', () => {
  assert.equal(
    extractCloudinaryPublicId(`${base}/purisunny/v1.2/photo.v2.jpg`),
    'purisunny/v1.2/photo.v2'
  );
});

test('extractCloudinaryPublicId: query string is ignored', () => {
  assert.equal(
    extractCloudinaryPublicId(`${base}/purisunny/x.jpg?_a=BAMAK`),
    'purisunny/x'
  );
});

test('extractCloudinaryPublicId: rejects external, legacy, wrong cloud, wrong folder', () => {
  const rejected = [
    'https://example.com/purisunny/x.jpg',
    '/uploads/legacy.jpg',
    '/uploads/purisunny/x.jpg',
    'uploads/rel.jpg',
    '',
    '   ',
    null,
    undefined,
    42,
    `https://res.cloudinary.com/some-other-cloud/image/upload/purisunny/x.jpg`,
    `${base}/other-folder/x.jpg`,
    `${base}/purisunny-ish/x.jpg`,
    `${base}/purisunny`,
    `https://res.cloudinary.com/${CLOUD}/video/upload/purisunny/x.mp4`,
    `https://res.cloudinary.com/${CLOUD}/image/private/purisunny/x.jpg`,
    `${base}/v123/`,
    'not a url at all',
  ];
  for (const value of rejected) {
    assert.equal(extractCloudinaryPublicId(value), null, `value=${JSON.stringify(value)}`);
  }
});

test('extractCloudinaryPublicId: null when CLOUDINARY_CLOUD_NAME is empty', () => {
  const saved = process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_CLOUD_NAME;
  try {
    assert.equal(extractCloudinaryPublicId(`${base}/purisunny/x.jpg`), null);
  } finally {
    process.env.CLOUDINARY_CLOUD_NAME = saved;
  }
});

// ---------------------------------------------------------------------------
// extractContentImageUrls
// ---------------------------------------------------------------------------

test('extractContentImageUrls: both quote styles, dedupe, ignores non-src attrs', () => {
  const html = `
    <p>text</p>
    <img src="https://a.test/1.jpg" alt="x">
    <img class="y" src='https://a.test/2.jpg' data-src="https://a.test/ignore.jpg">
    <img src="https://a.test/1.jpg">
    <img src="">
  `;
  assert.deepEqual(extractContentImageUrls(html), ['https://a.test/1.jpg', 'https://a.test/2.jpg']);
});

test('extractContentImageUrls: null / empty / non-string', () => {
  for (const value of [null, undefined, '', 0, {}, []]) {
    assert.deepEqual(extractContentImageUrls(value), []);
  }
});

// ---------------------------------------------------------------------------
// cleanupCloudinaryAssets
// ---------------------------------------------------------------------------

// Models the live Cloudinary behaviour: `tags` is only present when the caller
// asks for it with `{ tags: true }`. A fake that always echoed tags hid the
// real-world bug where every asset looked untagged.
function fakeCloudinary({ tags = [], deleted = {}, throwOn = null } = {}) {
  const calls = { resources_by_ids: [], delete_resources: [] };
  return {
    calls,
    config() {},
    api: {
      async resources_by_ids(ids, options) {
        calls.resources_by_ids.push({ ids, options });
        if (throwOn === 'resources_by_ids') throw { http_code: 500 };
        const includeTags = Boolean(options && options.tags === true);
        return {
          resources: ids.map((id) => {
            const resource = { public_id: id };
            if (includeTags) resource.tags = tags.includes(id) ? [CLEANUP_TAG] : [];
            return resource;
          }),
        };
      },
      async delete_resources(ids) {
        calls.delete_resources.push(ids);
        if (throwOn === 'delete_resources') throw { http_code: 500 };
        const result = {};
        for (const id of ids) result[id] = deleted[id] || 'deleted';
        return { deleted: result };
      },
    },
  };
}

function fakeDb(referenced = []) {
  return {
    async query(sql, params) {
      const needle = params[0].replace(/%/g, '');
      const hit = referenced.some((ref) => needle.includes(ref));
      return [hit ? [{ 1: 1 }] : []];
    },
  };
}

const url = (id) => `${base}/${id}.jpg`;

test('cleanupCloudinaryAssets: empty candidates make no API call', async () => {
  const cloud = fakeCloudinary();
  __setCloudinaryForTests(cloud);
  assert.deepEqual(await cleanupCloudinaryAssets([]), { destroyed: 0, skipped: 0 });
  assert.deepEqual(await cleanupCloudinaryAssets([undefined, null, '']), { destroyed: 0, skipped: 0 });
  assert.equal(cloud.calls.resources_by_ids.length, 0);
});

test('cleanupCloudinaryAssets: tagged + unreferenced -> deleted', async () => {
  const id = 'purisunny/rooms/old-cover';
  const cloud = fakeCloudinary({ tags: [id] });
  __setCloudinaryForTests(cloud);
  const out = await cleanupCloudinaryAssets([url(id)], { db: fakeDb() });
  assert.deepEqual(out, { destroyed: 1, skipped: 0 });
  assert.deepEqual(cloud.calls.delete_resources, [[id]]);
  // Cloudinary only returns `tags` when explicitly requested; without it a
  // tagged asset would be skipped as untagged (regression guard).
  assert.deepEqual(cloud.calls.resources_by_ids, [{ ids: [id], options: { tags: true } }]);
});

test('cleanupCloudinaryAssets: still referenced in DB -> skipped, never deleted', async () => {
  const id = 'purisunny/rooms/shared';
  const cloud = fakeCloudinary({ tags: [id] });
  __setCloudinaryForTests(cloud);
  const out = await cleanupCloudinaryAssets([url(id)], { db: fakeDb([id]) });
  assert.deepEqual(out, { destroyed: 0, skipped: 1 });
  assert.equal(cloud.calls.resources_by_ids.length, 0);
  assert.equal(cloud.calls.delete_resources.length, 0);
});

test('cleanupCloudinaryAssets: untagged asset (legacy / gallery registry) -> never deleted', async () => {
  const id = 'purisunny/rooms/legacy';
  const cloud = fakeCloudinary({ tags: [] });
  __setCloudinaryForTests(cloud);
  const out = await cleanupCloudinaryAssets([url(id)], { db: fakeDb() });
  assert.deepEqual(out, { destroyed: 0, skipped: 1 });
  assert.equal(cloud.calls.delete_resources.length, 0);
});

test('cleanupCloudinaryAssets: mixed batch deletes only the tagged unreferenced ones', async () => {
  const keepReferenced = 'purisunny/keep/ref';
  const keepUntagged = 'purisunny/keep/untagged';
  const remove = 'purisunny/remove/me';
  const cloud = fakeCloudinary({ tags: [remove, keepReferenced] });
  __setCloudinaryForTests(cloud);
  const out = await cleanupCloudinaryAssets(
    [url(keepReferenced), url(keepUntagged), url(remove)],
    { db: fakeDb([keepReferenced]) }
  );
  assert.deepEqual(out, { destroyed: 1, skipped: 2 });
  assert.deepEqual(cloud.calls.delete_resources, [[remove]]);
});

test('cleanupCloudinaryAssets: duplicate URLs collapse to one id', async () => {
  const id = 'purisunny/dup';
  const cloud = fakeCloudinary({ tags: [id] });
  __setCloudinaryForTests(cloud);
  const out = await cleanupCloudinaryAssets([url(id), `${url(id)}?x=1`, url(id)], { db: fakeDb() });
  assert.deepEqual(out, { destroyed: 1, skipped: 0 });
  assert.deepEqual(cloud.calls.delete_resources, [[id]]);
});

test('cleanupCloudinaryAssets: Cloudinary errors never throw', async () => {
  const id = 'purisunny/err';
  __setCloudinaryForTests(fakeCloudinary({ tags: [id], throwOn: 'resources_by_ids' }));
  assert.deepEqual(await cleanupCloudinaryAssets([url(id)], { db: fakeDb() }), { destroyed: 0, skipped: 1 });

  __setCloudinaryForTests(fakeCloudinary({ tags: [id], throwOn: 'delete_resources' }));
  assert.deepEqual(await cleanupCloudinaryAssets([url(id)], { db: fakeDb() }), { destroyed: 0, skipped: 1 });
});

test('cleanupCloudinaryAssets: DB failure means "do not delete"', async () => {
  const id = 'purisunny/dberr';
  const cloud = fakeCloudinary({ tags: [id] });
  __setCloudinaryForTests(cloud);
  const brokenDb = { async query() { throw new Error('ECONNREFUSED'); } };
  const out = await cleanupCloudinaryAssets([url(id)], { db: brokenDb });
  assert.deepEqual(out, { destroyed: 0, skipped: 1 });
  assert.equal(cloud.calls.delete_resources.length, 0);
});

test('cleanupCloudinaryAssets: non-"deleted" status counts as skipped', async () => {
  const id = 'purisunny/notfound';
  const cloud = fakeCloudinary({ tags: [id], deleted: { [id]: 'not found' } });
  __setCloudinaryForTests(cloud);
  const out = await cleanupCloudinaryAssets([url(id)], { db: fakeDb() });
  assert.deepEqual(out, { destroyed: 0, skipped: 1 });
});

test('__setCloudinaryForTests is refused in production', () => {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => __setCloudinaryForTests({}), /not available in production/);
  } finally {
    process.env.NODE_ENV = saved;
    __setCloudinaryForTests(null);
  }
});
