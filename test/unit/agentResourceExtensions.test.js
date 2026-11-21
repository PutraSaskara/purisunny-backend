// backend/test/unit/agentResourceExtensions.test.js
//
// Phase 2B service/helper additions: categories.patch merge semantics,
// redirects.get, and the shared X-Confirm-Delete guard. No database needed.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const categories = require('../../services/categories');
const redirects = require('../../services/redirects');
const confirmDelete = require('../../agent/confirmDelete');

function sqlText(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

test.after(() => {
  categories.__setDbForTests(null);
  redirects.__setDbForTests(null);
});

// ---------------------------------------------------------------------------
// categories.patch
// ---------------------------------------------------------------------------

const STORED = {
  id: 7,
  name: 'Stay',
  slug: 'stay',
  description: 'Old description',
  created_at: new Date('2026-01-01T00:00:00Z'),
};

function categoriesDb({ updates, selectRows = [STORED] }) {
  return {
    async query(sql, params) {
      const text = sqlText(sql);
      if (text.startsWith('SELECT * FROM categories WHERE id = ?')) {
        return [selectRows];
      }
      if (text.startsWith('UPDATE categories SET name = ?')) {
        if (updates) updates.push(params);
        // A no-op UPDATE reports 0 affected rows; that must never mean 404.
        return [{ affectedRows: 0 }];
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

test('categories.patch: absent fields keep their stored values', async () => {
  const updates = [];
  categories.__setDbForTests(categoriesDb({ updates }));

  const result = await categories.patch(7, { name: 'Stays' });

  assert.deepEqual(updates, [['Stays', 'stay', 'Old description', 7]]);
  assert.equal(result.id, 7);
  assert.equal(result.name, 'Stays');
  assert.equal(result.slug, 'stay');
  assert.equal(result.description, 'Old description');
});

test('categories.patch: an empty body is a 200-equivalent no-op, not 404', async () => {
  const updates = [];
  categories.__setDbForTests(categoriesDb({ updates }));

  const result = await categories.patch(7, {});

  assert.deepEqual(updates, [['Stay', 'stay', 'Old description', 7]]);
  assert.equal(result.name, 'Stay');
  assert.equal(result.slug, 'stay');
  assert.equal(result.description, 'Old description');
});

test('categories.patch: explicit null clears the description', async () => {
  const updates = [];
  categories.__setDbForTests(categoriesDb({ updates }));

  const result = await categories.patch(7, { description: null });

  assert.equal(updates[0][2], null);
  assert.equal(result.description, null);
});

test('categories.patch: missing category answers 404 before any UPDATE', async () => {
  const updates = [];
  categories.__setDbForTests(categoriesDb({ updates, selectRows: [] }));

  await assert.rejects(
    categories.patch(7, { name: 'Nope' }),
    (error) => error.status === 404 && error.body.message === 'Category not found'
  );
  assert.deepEqual(updates, []);
});

test('categories.patch: invalid supplied field answers 400 and does not write', async () => {
  const updates = [];
  categories.__setDbForTests(categoriesDb({ updates }));

  await assert.rejects(
    categories.patch(7, { slug: 'Not A Slug' }),
    (error) => error.status === 400 && /slug must be lowercase/.test(error.body.errors[0])
  );
  assert.deepEqual(updates, []);
});

test('categories.patch: duplicate slug maps to 409', async () => {
  categories.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      if (text.startsWith('SELECT * FROM categories WHERE id = ?')) return [[STORED]];
      if (text.startsWith('UPDATE categories SET name = ?')) {
        const error = new Error('duplicate');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      throw new Error(`unexpected query: ${text}`);
    },
  });

  await assert.rejects(
    categories.patch(7, { slug: 'taken' }),
    (error) => error.status === 409
      && error.body.message === 'A category with this slug already exists'
  );
});

test('categories.update: legacy full PUT still requires name and slug', async () => {
  categories.__setDbForTests({
    async query() { throw new Error('validation must precede the database'); },
  });

  await assert.rejects(
    categories.update(7, { description: 'only description' }),
    (error) => error.status === 400 && /name is required/.test(error.body.errors[0])
  );
});

// ---------------------------------------------------------------------------
// redirects.get
// ---------------------------------------------------------------------------

test('redirects.get: returns the row', async () => {
  const row = {
    id: 4,
    from_path: '/old',
    to_path: '/new',
    status: 301,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
  };
  redirects.__setDbForTests({
    async query(sql) {
      const text = sqlText(sql);
      if (text.startsWith('SELECT id, from_path, to_path, status')) return [[row]];
      throw new Error(`unexpected query: ${text}`);
    },
  });

  assert.deepEqual(await redirects.get(4), row);
});

test('redirects.get: missing row returns null', async () => {
  redirects.__setDbForTests({
    async query() { return [[]]; },
  });

  assert.equal(await redirects.get(999), null);
});

// ---------------------------------------------------------------------------
// confirmDelete
// ---------------------------------------------------------------------------

function runConfirm(value) {
  const req = { headers: value === undefined ? {} : { 'x-confirm-delete': value } };
  return new Promise((resolve) => {
    confirmDelete(req, {}, (error) => resolve(error || null));
  });
}

test('confirmDelete: exactly "true" and "1" pass', async () => {
  assert.equal(await runConfirm('true'), null);
  assert.equal(await runConfirm('1'), null);
});

test('confirmDelete: anything else answers CONFIRMATION_REQUIRED with the header context', async () => {
  for (const value of [undefined, 'yes', 'TRUE', ' true ', '0', '']) {
    const error = await runConfirm(value);
    assert.ok(error, `value ${JSON.stringify(value)} must be rejected`);
    assert.equal(error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(error.status, 400);
    assert.deepEqual(error.context, { header: 'X-Confirm-Delete' });
  }
});
