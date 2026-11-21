// backend/test/unit/services.test.js
//
// Characterization tests for the extracted service layer. No MySQL, SMTP or
// Cloudinary network access is required: the test-only seams installed by the
// services (__setDbForTests / __setMailerForTests) provide fakes.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const articles = require('../../services/articles');
const categories = require('../../services/categories');
const seo = require('../../services/seo');
const redirects = require('../../services/redirects');
const contacts = require('../../services/contacts');
const media = require('../../services/media');

function sqlText(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function articlePayload(overrides = {}) {
  return {
    title: 'Service test article',
    slug: 'service-test-article',
    content: '<p>body</p>',
    excerpt: 'excerpt',
    author: 'Tester',
    cover_image: '',
    read_time: 5,
    is_featured: false,
    ...overrides,
  };
}

function contactPayload(overrides = {}) {
  return {
    name: 'Service Test',
    email: 'service@example.test',
    phone: '+62 812-0000-0000',
    message: 'Pesan uji service yang cukup panjang.',
    ...overrides,
  };
}

test.after(() => {
  articles.__setDbForTests(null);
  categories.__setDbForTests(null);
  seo.__setDbForTests(null);
  redirects.__setDbForTests(null);
  contacts.__setDbForTests(null);
  contacts.__setMailerForTests(null);
});

// ---------------------------------------------------------------------------
// articles
// ---------------------------------------------------------------------------

test('articles.create: validation errors are 400 with the existing first-message shape', async () => {
  await assert.rejects(
    articles.create({}),
    (error) => error.status === 400
      && error.body.message === error.body.errors[0]
      && /title is required/.test(error.body.errors[0])
  );
});

test('articles.create: a missing category answers 404 before any insert', async () => {
  articles.__setDbForTests({
    query: async () => [[]],
    getConnection: async () => { throw new Error('must not open a transaction'); },
  });

  await assert.rejects(
    articles.create(articlePayload({ category_id: 999 })),
    (error) => error.status === 404
      && error.body.message === 'Category not found: 999'
      && Array.isArray(error.body.errors)
  );
});

test('articles.create: article + FAQ rows share one transaction', async () => {
  const events = [];
  const connection = {
    async beginTransaction() { events.push('begin'); },
    async query(sql, params) {
      const text = sqlText(sql);
      events.push(text);
      if (text.startsWith('INSERT INTO articles')) return [{ insertId: 77 }];
      if (text.startsWith('INSERT INTO article_faq_items')) return [{ insertId: 1 }];
      return [{}];
    },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() { events.push('release'); },
  };
  articles.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      events.push(text);
      if (text.startsWith('SELECT id FROM categories')) return [[{ id: 5 }]];
      return [[]];
    },
    async getConnection() { return connection; },
  });

  const result = await articles.create(articlePayload({
    category_id: 5,
    faqs: [{ question: 'Q1?', answer: 'A1.' }],
  }));

  assert.equal(result.id, 77);
  assert.ok(events.includes('begin'));
  assert.ok(events.indexOf('begin') > events.findIndex((e) => e.startsWith('SELECT id FROM categories')));
  assert.ok(events.includes('commit'));
  assert.ok(events.includes('release'));
  assert.ok(events.some((e) => e.startsWith('DELETE FROM article_faq_items')));
  assert.ok(events.some((e) => e.startsWith('INSERT INTO article_faq_items')));
});

test('articles.create: duplicate slug maps to the existing 409 body', async () => {
  articles.__setDbForTests({
    query: async () => [[]],
    getConnection: async () => ({
      async beginTransaction() {},
      async query(sql) {
        if (sqlText(sql).startsWith('INSERT INTO articles')) {
          const error = new Error('duplicate');
          error.code = 'ER_DUP_ENTRY';
          throw error;
        }
        return [{}];
      },
      async commit() {},
      async rollback() {},
      release() {},
    }),
  });

  await assert.rejects(
    articles.create(articlePayload()),
    (error) => error.status === 409
      && error.body.message === 'An article with this slug already exists'
      && error.body.errors[0] === 'slug must be unique'
  );
});

test('articles.updateFull: slug change inserts the automatic redirect after commit', async () => {
  const calls = [];
  const connection = {
    async beginTransaction() {},
    async query(sql) {
      if (sqlText(sql).startsWith('UPDATE articles')) return [{ affectedRows: 1 }];
      return [{}];
    },
    async commit() {},
    async rollback() {},
    release() {},
  };
  articles.__setDbForTests({
    async query(sql, params) {
      const text = sqlText(sql);
      calls.push({ text, params });
      if (text.startsWith('SELECT slug, cover_image, og_image, content')) {
        return [[{ slug: 'old-slug', cover_image: null, og_image: null, content: null }]];
      }
      if (text.startsWith('SELECT id, to_path FROM redirects')) return [[]];
      if (text.startsWith('INSERT INTO redirects')) return [{ insertId: 1 }];
      return [[]];
    },
    async getConnection() { return connection; },
  });

  await articles.updateFull(7, articlePayload({ slug: 'new-slug' }));

  const redirectInsert = calls.find((call) => call.text.startsWith('INSERT INTO redirects'));
  assert.ok(redirectInsert, 'redirect insert missing');
  assert.deepEqual(redirectInsert.params, ['/journal/old-slug', '/journal/new-slug']);
});

test('articles.remove: missing row is 404 and existing row is deleted', async () => {
  let deleteCalled = false;
  articles.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      if (text.startsWith('SELECT slug, cover_image, og_image, content')) return [[]];
      if (text.startsWith('DELETE FROM articles')) {
        deleteCalled = true;
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
    async getConnection() { throw new Error('remove must not open a transaction'); },
  });

  await assert.rejects(
    articles.remove(1),
    (error) => error.status === 404 && error.body.message === 'Article not found'
  );
  assert.equal(deleteCalled, false);

  articles.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      if (text.startsWith('SELECT slug, cover_image, og_image, content')) {
        return [[{ slug: 'gone', cover_image: null, og_image: null, content: null }]];
      }
      if (text.startsWith('DELETE FROM articles')) return [{ affectedRows: 1 }];
      return [[]];
    },
    async getConnection() { throw new Error('remove must not open a transaction'); },
  });

  const result = await articles.remove(2);
  assert.equal(result.slug, 'gone');
});

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

test('categories.create: validation errors use the existing 400 shape', async () => {
  await assert.rejects(
    categories.create({ name: '', slug: 'Not A Slug' }),
    (error) => error.status === 400
      && /name is required/.test(error.body.errors[0])
      && error.body.message === error.body.errors[0]
  );
});

test('categories.create: duplicate slug maps to 409', async () => {
  categories.__setDbForTests({
    async query() {
      const error = new Error('duplicate');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    },
  });

  await assert.rejects(
    categories.create({ name: 'Category', slug: 'category' }),
    (error) => error.status === 409
      && error.body.message === 'A category with this slug already exists'
  );
});

test('categories.remove: referenced category is refused with 409 and the article count', async () => {
  categories.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      if (text.startsWith('SELECT id, name FROM categories')) return [[{ id: 3, name: 'Stay' }]];
      if (text.startsWith('SELECT COUNT(*) AS articleCount')) return [[{ articleCount: 2 }]];
      throw new Error(`unexpected query: ${text}`);
    },
  });

  await assert.rejects(
    categories.remove(3),
    (error) => error.status === 409
      && error.body.articleCount === 2
      && /2 articles still reference it/.test(error.body.message)
  );
});

// ---------------------------------------------------------------------------
// seo
// ---------------------------------------------------------------------------

test('seo.list: returns all 18 official keys with null defaults', async () => {
  seo.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      if (text.startsWith('SELECT page_key, meta_title')) return [[]];
      if (text.startsWith('SELECT * FROM faq_items')) return [[]];
      throw new Error(`unexpected query: ${text}`);
    },
    async getConnection() { throw new Error('seo.list must not open a transaction'); },
  });

  const result = await seo.list();
  assert.equal(result.pages.length, 18);
  assert.equal(result.pages[0].page_key, 'page:home');
  assert.equal(result.pages[0].meta_title, null);
  assert.deepEqual(result.pages[0].faqs, []);
});

test('seo.upsert: invalid page key answers 400 with the official key list', async () => {
  await assert.rejects(
    seo.upsert('page:not-real', {}),
    (error) => error.status === 400
      && /Invalid page_key/.test(error.body.message)
      && error.body.validKeys.length === 18
  );
});

test('seo.upsert: FAQ validation keeps the existing error wording', async () => {
  await assert.rejects(
    seo.upsert('page:home', { faqs: [{ question: '', answer: '' }] }),
    (error) => error.status === 400
      && error.body.errors.some((message) => /faqs\[0\]\.question is required/.test(message))
  );
});

// ---------------------------------------------------------------------------
// redirects
// ---------------------------------------------------------------------------

test('redirects.create: self-loop answers 400 before touching the database', async () => {
  redirects.__setDbForTests({
    async query() { throw new Error('database must not be reached'); },
  });

  await assert.rejects(
    redirects.create({ from_path: '/same', to_path: '/same' }),
    (error) => error.status === 400
      && error.body.errors.includes('from_path and to_path must be different')
  );
});

test('redirects.update: merged self-loop answers 400', async () => {
  redirects.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      if (text.startsWith('SELECT id, from_path, to_path, status')) {
        return [[{ id: 1, from_path: '/a', to_path: '/b', status: 301 }]];
      }
      throw new Error(`unexpected query: ${text}`);
    },
  });

  await assert.rejects(
    redirects.update(1, { to_path: '/a' }),
    (error) => error.status === 400
      && error.body.errors.includes('from_path and to_path must be different')
  );
});

test('redirects.create: duplicate from_path maps to 409', async () => {
  redirects.__setDbForTests({
    async query() {
      const error = new Error('duplicate');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    },
  });

  await assert.rejects(
    redirects.create({ from_path: '/old', to_path: '/new' }),
    (error) => error.status === 409
      && error.body.message === 'A redirect with this from_path already exists'
  );
});

// ---------------------------------------------------------------------------
// contacts
// ---------------------------------------------------------------------------

test('contacts.list: invalid limit answers 400 before touching the database', async () => {
  contacts.__setDbForTests({
    async query() { throw new Error('database must not be reached'); },
  });

  await assert.rejects(
    contacts.list('nope'),
    (error) => error.status === 400
      && error.body.errors[0] === 'limit must be an integer'
  );
});

test('contacts.create: the row is inserted before the mail attempt', async () => {
  const events = [];
  contacts.__setDbForTests({
    async query(sql) {
      events.push('db');
      assert.ok(sqlText(sql).startsWith('INSERT INTO contacts'));
      return [{ insertId: 55 }];
    },
  });
  contacts.__setMailerForTests({
    isEmailConfigured: () => true,
    missingEmailConfigKeys: () => [],
    async sendContactEmail() {
      events.push('mail');
      return { sent: false, error: 'connect ECONNREFUSED' };
    },
  });

  const result = await contacts.create(contactPayload());
  assert.deepEqual(events, ['db', 'mail']);
  assert.equal(result.emailSent, false);
  assert.equal(result.contactId, 55);
});

test('contacts.create: a failed insert answers 500 and never attempts mail', async () => {
  let mailed = false;
  contacts.__setDbForTests({
    async query() {
      const error = new Error('insert failed');
      error.code = 'ER_LOCK_WAIT_TIMEOUT';
      throw error;
    },
  });
  contacts.__setMailerForTests({
    isEmailConfigured: () => true,
    missingEmailConfigKeys: () => [],
    async sendContactEmail() {
      mailed = true;
      return { sent: true };
    },
  });

  await assert.rejects(
    contacts.create(contactPayload()),
    (error) => error.status === 500 && error.body.message === 'Server error'
  );
  assert.equal(mailed, false);
});

test('contacts.create: successful delivery returns emailSent true', async () => {
  contacts.__setDbForTests({
    async query() { return [{ insertId: 56 }]; },
  });
  contacts.__setMailerForTests({
    isEmailConfigured: () => true,
    missingEmailConfigKeys: () => [],
    async sendContactEmail() { return { sent: true }; },
  });

  const result = await contacts.create(contactPayload());
  assert.equal(result.emailSent, true);
  assert.equal(result.contactId, 56);
});

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636000000002000148af04110000000049454e44ae426082',
  'hex'
);

test('media.upload: missing file is 400 "No file uploaded"', async () => {
  await assert.rejects(
    media.upload(undefined),
    (error) => error.status === 400 && error.body.message === 'No file uploaded'
  );
});

test('media.upload: non-image extension is rejected before any upload', async () => {
  await assert.rejects(
    media.upload({ originalname: 'evil.svg', buffer: Buffer.from('<svg/>') }),
    (error) => error.status === 400
      && error.body.message === 'Only JPEG, PNG, WebP, or GIF images are allowed'
  );
});

test('media.upload: extension/content mismatch is rejected', async () => {
  await assert.rejects(
    media.upload({ originalname: 'not-a-png.gif', buffer: PNG_BYTES }),
    (error) => error.status === 400
      && error.body.message === 'File extension does not match its actual image content'
  );
});

test('media.upload: valid PNG resolves through the fake Cloudinary stub', async () => {
  const result = await media.upload({ originalname: 'ok.png', buffer: PNG_BYTES });
  assert.equal(result.format, 'png');
  assert.equal(result.path, result.url);
  assert.match(result.url, /^https:\/\//);
  assert.ok(result.public_id);
  assert.equal(typeof result.width, 'number');
  assert.equal(typeof result.height, 'number');
});
