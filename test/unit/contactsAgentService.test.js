// backend/test/unit/contactsAgentService.test.js
//
// Phase 3 unit checks: contacts.listPage pagination/filtering, get/setRead/remove
// and the media JSON base64 decoder. No MySQL, no network.

const test = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/env');

const contacts = require('../../services/contacts');
const media = require('../../services/media');
const { decodeBase64Image } = require('../../agent/routes/media');

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636000000002000148af04110000000049454e44ae426082',
  'hex'
);

function sqlText(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

test.afterEach(() => {
  contacts.__setDbForTests(null);
});

test('contacts.listPage: defaults, DESC order, total/unread and total_pages', async () => {
  const calls = [];
  contacts.__setDbForTests({
    async query(sql, params) {
      const text = sqlText(sql);
      calls.push({ text, params });
      if (text.includes('COUNT(*)')) return [[{ total: 7, unread: 3 }]];
      return [[{ id: 2, name: 'B', is_read: 0 }, { id: 1, name: 'A', is_read: 1 }]];
    },
  });

  const result = await contacts.listPage({});
  assert.equal(result.page, 1);
  assert.equal(result.per_page, 20);
  assert.equal(result.total, 7);
  assert.equal(result.unread, 3);
  assert.equal(result.total_pages, 1);
  assert.equal(result.items.length, 2);

  const listQuery = calls.find((call) => call.text.startsWith('SELECT id'));
  assert.match(listQuery.text, /ORDER BY created_at DESC, id DESC/);
  assert.deepEqual(listQuery.params, [20, 0]);
});

test('contacts.listPage: page offset, per_page clamp and unread filter', async () => {
  const calls = [];
  contacts.__setDbForTests({
    async query(sql, params) {
      const text = sqlText(sql);
      calls.push({ text, params });
      if (text.includes('COUNT(*)')) return [[{ total: 9, unread: 4 }]];
      return [[]];
    },
  });

  const result = await contacts.listPage({ page: '3', per_page: '500', unread: 'true' });
  assert.equal(result.page, 3);
  assert.equal(result.per_page, 100);
  assert.equal(result.total, 4, 'filtered total is the unread count');
  assert.equal(result.unread, 4);
  assert.equal(result.total_pages, 1);

  const listQuery = calls.find((call) => call.text.startsWith('SELECT id'));
  assert.match(listQuery.text, /WHERE is_read = 0/);
  assert.deepEqual(listQuery.params, [100, 200]);
});

test('contacts.listPage: invalid page/per_page fall back to defaults', async () => {
  contacts.__setDbForTests({
    async query(sql) {
      if (sqlText(sql).includes('COUNT(*)')) return [[{ total: 0, unread: 0 }]];
      return [[]];
    },
  });

  const result = await contacts.listPage({ page: 'abc', per_page: '0', unread: 'false' });
  assert.equal(result.page, 1);
  assert.equal(result.per_page, 20);
  assert.equal(result.total_pages, 0);
});

test('contacts.get: returns the row or null', async () => {
  contacts.__setDbForTests({
    async query(sql, params) {
      assert.match(sqlText(sql), /WHERE id = \? LIMIT 1$/);
      return [params[0] === 42 ? [{ id: 42, name: 'Ada' }] : []];
    },
  });

  assert.deepEqual(await contacts.get(42), { id: 42, name: 'Ada' });
  assert.equal(await contacts.get(7), null);
});

test('contacts.setRead: updates only is_read and returns the refreshed row', async () => {
  const calls = [];
  let stored = 0;
  contacts.__setDbForTests({
    async query(sql, params) {
      const text = sqlText(sql);
      calls.push({ text, params });
      if (text.startsWith('UPDATE contacts SET is_read')) {
        stored = params[0];
        return [{ affectedRows: 1 }];
      }
      return [[{ id: 5, is_read: stored }]];
    },
  });

  const row = await contacts.setRead(5, true);
  assert.equal(row.is_read, 1);
  const update = calls.find((call) => call.text.startsWith('UPDATE contacts SET is_read'));
  assert.deepEqual(update.params, [1, 5]);
  assert.equal(calls.some((call) => /UPDATE contacts SET (?!is_read)/.test(call.text)), false);

  const cleared = await contacts.setRead(5, 0);
  assert.equal(cleared.is_read, 0);
});

test('contacts.setRead: missing row -> 404, invalid flag -> 400 without an UPDATE', async () => {
  const calls = [];
  contacts.__setDbForTests({
    async query(sql) {
      calls.push(sqlText(sql));
      return [[]];
    },
  });

  await assert.rejects(
    contacts.setRead(999, true),
    (error) => error.status === 404 && error.body.message === 'Contact not found'
  );
  await assert.rejects(
    contacts.setRead(5, 'yes'),
    (error) => error.status === 400 && /is_read must be/.test(error.body.message)
  );
  assert.equal(calls.some((sql) => sql.startsWith('UPDATE')), false);
});

test('contacts.remove: hard delete, 404 when missing', async () => {
  const calls = [];
  contacts.__setDbForTests({
    async query(sql, params) {
      calls.push(sqlText(sql));
      return params[0] === 1 ? [{ affectedRows: 1 }] : [{ affectedRows: 0 }];
    },
  });

  assert.deepEqual(await contacts.remove(1), { id: 1 });
  assert.deepEqual(calls, ['DELETE FROM contacts WHERE id = ?']);

  await assert.rejects(
    contacts.remove(2),
    (error) => error.status === 404 && error.body.message === 'Contact not found'
  );
});

// ---------------------------------------------------------------------------
// media JSON mode
// ---------------------------------------------------------------------------

test('decodeBase64Image: plain base64 and data URL prefix both decode', () => {
  const plain = decodeBase64Image({
    filename: 'photo.png',
    content_base64: PNG_BYTES.toString('base64'),
  });
  assert.equal(plain.originalname, 'photo.png');
  assert.deepEqual(plain.buffer, PNG_BYTES);

  const prefixed = decodeBase64Image({
    filename: 'photo.JPG',
    content_base64: `data:image/jpeg;base64,${PNG_BYTES.toString('base64')}`,
  });
  assert.equal(prefixed.originalname, 'photo.JPG');
  assert.deepEqual(prefixed.buffer, PNG_BYTES);
});

test('decodeBase64Image: filename and extension are required', () => {
  for (const body of [
    {},
    { filename: 'photo', content_base64: PNG_BYTES.toString('base64') },
    { filename: 'photo.svg', content_base64: PNG_BYTES.toString('base64') },
  ]) {
    assert.throws(
      () => decodeBase64Image(body),
      (error) => error.status === 400 && error.code === 'VALIDATION_ERROR'
    );
  }
});

test('decodeBase64Image: malformed base64 is rejected', () => {
  for (const value of ['', 'not base64!', 'abcde', 'a===']) {
    assert.throws(
      () => decodeBase64Image({ filename: 'photo.png', content_base64: value }),
      (error) => error.status === 400 && error.code === 'VALIDATION_ERROR'
    );
  }
});

test('decodeBase64Image: decoded payload over 5MB is rejected', () => {
  const tooLarge = Buffer.alloc(media.MAX_FILE_SIZE + 1).toString('base64');
  assert.throws(
    () => decodeBase64Image({ filename: 'photo.png', content_base64: tooLarge }),
    (error) => error.status === 400 && /5MB or smaller/.test(error.message)
  );
});
