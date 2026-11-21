// backend/test/unit/articlesAgentExtensions.test.js
//
// Service-level extension tests for the Agent API article flow: PATCH merge
// semantics, no-op PATCH, upsert, validate and list filters.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const articles = require('../../services/articles');

function sqlText(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function articleRow(overrides = {}) {
  return {
    id: 5,
    title: 'Stored title',
    slug: 'stored-slug',
    content: '<p>old body</p>',
    excerpt: 'old excerpt',
    cover_image: null,
    category_id: null,
    author: 'Editor',
    read_time: 5,
    is_featured: 0,
    meta_title: null,
    meta_description: null,
    og_image: null,
    noindex: 0,
    keywords: null,
    published_at: new Date('2026-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    title: 'New article',
    slug: 'new-article',
    content: '<p>body</p>',
    excerpt: 'excerpt',
    author: 'Tester',
    cover_image: '',
    read_time: 5,
    is_featured: false,
    ...overrides,
  };
}

function patchDb({ affectedRows = 1, exists = true, row = articleRow(), updateCapture } = {}) {
  const db = {
    async query(sql) {
      const text = sqlText(sql);
      if (text.startsWith('SELECT * FROM articles WHERE id = ?')) return [[row]];
      if (text.startsWith('SELECT slug, cover_image, og_image, content')) {
        return [[{ slug: row.slug, cover_image: row.cover_image, og_image: row.og_image, content: row.content }]];
      }
      if (text.startsWith('SELECT a.*, c.name')) return [[row]];
      if (text.startsWith('SELECT id, question, answer, position')) return [[]];
      if (text.startsWith('SELECT id, title, slug, cover_image')) return [[]];
      return [[]];
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async query(sql, params) {
          const text = sqlText(sql);
          if (text.startsWith('UPDATE articles')) {
            if (updateCapture) updateCapture.params = params;
            return [{ affectedRows }];
          }
          if (text.startsWith('SELECT id FROM articles WHERE id = ?')) {
            return [exists ? [{ id: row.id }] : []];
          }
          return [{}];
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  };
  return db;
}

test.afterEach(() => articles.__setDbForTests(null));

test('patch preserves absent fields and sends the merged row to updateFull', async () => {
  const capture = {};
  articles.__setDbForTests(patchDb({ updateCapture: capture }));

  const result = await articles.patch(5, { excerpt: 'new excerpt' });

  assert.equal(result.article.id, 5);
  assert.ok(Array.isArray(capture.params));
  // title, slug, content, excerpt, cover_image, category_id, author,
  // read_time, is_featured, meta_title, meta_description, og_image, noindex,
  // keywords, id
  assert.equal(capture.params[0], 'Stored title');
  assert.equal(capture.params[1], 'stored-slug');
  assert.equal(capture.params[2], '<p>old body</p>');
  assert.equal(capture.params[3], 'new excerpt');
  assert.equal(capture.params[14], 5);
});

test('patch treats an explicit null as clear for nullable fields', async () => {
  const capture = {};
  articles.__setDbForTests(patchDb({ updateCapture: capture }));

  await articles.patch(5, { excerpt: null, cover_image: null, category_id: null });

  assert.equal(capture.params[3], null); // excerpt
  assert.equal(capture.params[4], null); // cover_image
  assert.equal(capture.params[5], null); // category_id
});

test('patch that changes nothing returns 200-equivalent data instead of 404', async () => {
  articles.__setDbForTests(patchDb({ affectedRows: 0, exists: true }));

  const result = await articles.patch(5, {});
  assert.equal(result.article.id, 5);
  assert.equal(result.article.slug, 'stored-slug');
});

test('patch that finds a deleted row still answers 404', async () => {
  articles.__setDbForTests(patchDb({ affectedRows: 0, exists: false }));

  await assert.rejects(
    articles.patch(5, {}),
    (error) => error.status === 404 && error.body.message === 'Article not found'
  );
});

test('upsert creates when the slug is absent and returns { created: true, id }', async () => {
  const events = [];
  articles.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      events.push(text);
      if (text.startsWith('SELECT id FROM articles WHERE slug')) return [[]];
      return [[]];
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async query(sql) {
          const text = sqlText(sql);
          if (text.startsWith('INSERT INTO articles')) return [{ insertId: 44 }];
          return [{}];
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  });

  const result = await articles.upsert(payload());
  assert.deepEqual(result, { created: true, id: 44 });
  assert.ok(events.some((text) => text.startsWith('SELECT id FROM articles WHERE slug')));
});

test('upsert patches when the slug exists and returns { created: false, id }', async () => {
  let patched = false;
  articles.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      if (text.startsWith('SELECT id FROM articles WHERE slug')) return [[{ id: 5 }]];
      if (text.startsWith('SELECT * FROM articles WHERE id = ?')) return [[articleRow()]];
      if (text.startsWith('SELECT slug, cover_image, og_image, content')) {
        return [[{ slug: 'stored-slug', cover_image: null, og_image: null, content: null }]];
      }
      if (text.startsWith('SELECT a.*, c.name')) return [[articleRow()]];
      if (text.startsWith('SELECT id, question, answer, position')) return [[]];
      if (text.startsWith('SELECT id, title, slug, cover_image')) return [[]];
      return [[]];
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async query(sql) {
          if (sqlText(sql).startsWith('UPDATE articles')) {
            patched = true;
            return [{ affectedRows: 1 }];
          }
          return [{}];
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  });

  const result = await articles.upsert(payload({ slug: 'stored-slug', excerpt: 'updated' }));
  assert.deepEqual(result, { created: false, id: 5 });
  assert.equal(patched, true);
});

test('upsert requires a slug', async () => {
  articles.__setDbForTests({
    async query() { throw new Error('database must not be reached'); },
    async getConnection() { throw new Error('database must not be reached'); },
  });
  await assert.rejects(
    articles.upsert({ title: 'No slug' }),
    (error) => error.status === 400 && /slug is required/.test(error.body.message)
  );
});

test('validate does not write and returns { valid: true }', async () => {
  let writes = 0;
  articles.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      if (/^(INSERT|UPDATE|DELETE)/i.test(text)) writes += 1;
      return [[]];
    },
    async getConnection() { throw new Error('validate must not open a transaction'); },
  });

  const result = await articles.validate(payload());
  assert.equal(result.valid, true);
  assert.equal(writes, 0);
});

test('validate uses the existing 400 error shape and checks category existence', async () => {
  articles.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      if (text.startsWith('SELECT id FROM categories')) return [[]];
      return [[]];
    },
    async getConnection() { throw new Error('validate must not open a transaction'); },
  });

  await assert.rejects(
    articles.validate(payload({ title: '' })),
    (error) => error.status === 400
      && error.body.message === error.body.errors[0]
      && /title is required/.test(error.body.message)
  );

  await assert.rejects(
    articles.validate(payload({ category_id: 999 })),
    (error) => error.status === 404
      && error.body.message === 'Category not found: 999'
  );
});

test('list adds q and updated_since filters without changing pagination', async () => {
  const calls = [];
  articles.__setDbForTests({
    async query(sql, params) {
      const text = sqlText(sql);
      calls.push({ text, params });
      if (text.startsWith('SELECT COUNT(*)')) return [[{ total: 1 }]];
      return [[articleRow()]];
    },
    async getConnection() { throw new Error('list must not open a transaction'); },
  });

  const result = await articles.list({
    page: '2',
    per_page: '10',
    q: 'coffee',
    updated_since: '2026-01-02T00:00:00.000Z',
  });

  assert.equal(result.page, 2);
  assert.equal(result.per_page, 10);
  assert.equal(result.total, 1);
  const countCall = calls.find((call) => call.text.startsWith('SELECT COUNT(*)'));
  assert.match(countCall.text, /a\.title LIKE \?/);
  assert.match(countCall.text, /a\.updated_at >= \?/);
  assert.equal(countCall.params[0], '%coffee%');
  assert.equal(countCall.params[1], '%coffee%');
  assert.ok(countCall.params[2] instanceof Date);
});

test('list ignores invalid q/updated_since values (legacy compatibility)', async () => {
  const calls = [];
  articles.__setDbForTests({
    async query(sql) {
      calls.push(sqlText(sql));
      return [[articleRow()]];
    },
    async getConnection() { throw new Error('list must not open a transaction'); },
  });

  const rows = await articles.list({});
  assert.equal(Array.isArray(rows), true);
  assert.equal(calls[0].includes('a.title LIKE'), false);
  assert.equal(calls[0].includes('a.updated_at'), false);
});
