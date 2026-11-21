// backend/test/agent/contactsMedia.http.test.js
//
// HTTP contract for the Phase 3 Agent API surface:
//   /api/agent/v1/contacts
//   /api/agent/v1/media
//
// Contact service calls are stubbed so routing, scopes, envelope shape, delete
// confirmation, idempotency replay and audit wiring run without MySQL. Media
// uses the real service with CLOUDINARY_FAKE_STUB=1 (set by helpers/env).

require('../helpers/env');
process.env.AGENT_API_ENABLED = '1';
process.env.AGENT_BODY_LIMIT = '1kb';
process.env.AGENT_MEDIA_BODY_LIMIT = '16kb';
process.env.AGENT_RATE_LIMIT_READ = '500';
process.env.AGENT_RATE_LIMIT_WRITE = '500';

const test = require('node:test');
const assert = require('node:assert/strict');

const apiKeys = require('../../services/apiKeys');
const auth = require('../../agent/auth');
const idempotency = require('../../agent/idempotency');
const audit = require('../../agent/audit');
const contacts = require('../../services/contacts');
const { httpError } = require('../../services/errors');
const { startApp } = require('../helpers/app');

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636000000002000148af04110000000049454e44ae426082',
  'hex'
);

const originals = {
  listPage: contacts.listPage,
  get: contacts.get,
  create: contacts.create,
  setRead: contacts.setRead,
  remove: contacts.remove,
};

function rowFor({ id, name, role, scopes }) {
  const generated = apiKeys.generateApiKey();
  return {
    generated,
    row: {
      id,
      name,
      key_prefix: generated.prefix,
      key_hash: generated.hash,
      user_id: role === 'admin' ? 1 : 2,
      scopes: JSON.stringify(scopes),
      is_active: 1,
      expires_at: null,
      last_used_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
      revoked_at: null,
      username: role === 'admin' ? 'zz-test-admin' : 'zz-test-editor',
      role,
    },
  };
}

const ALL_SCOPES = [
  'contacts:read', 'contacts:write', 'contacts:delete', 'media:write',
];

const admin = rowFor({ id: 1, name: 'phase3-admin', role: 'admin', scopes: ALL_SCOPES });
// Contacts and media scopes are admin-only per ROLE_CAPS, so these keys need
// an admin owner even when they hold only one slice of the scope catalogue.
const reader = rowFor({ id: 2, name: 'phase3-reader', role: 'admin', scopes: ['contacts:read'] });
const writer = rowFor({ id: 3, name: 'phase3-writer', role: 'admin', scopes: ['contacts:read', 'contacts:write'] });
const noMedia = rowFor({ id: 4, name: 'phase3-no-media', role: 'admin', scopes: ['contacts:read'] });
const noContactsRead = rowFor({ id: 5, name: 'phase3-no-contacts', role: 'admin', scopes: ['articles:read'] });

const allRows = [admin, reader, writer, noMedia, noContactsRead].map((entry) => entry.row);

function makeDb() {
  const idem = new Map();
  const audits = [];
  let nextIdem = 1;
  return {
    idem,
    audits,
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM api_keys k/i.test(text)) {
        const prefix = params && params[0];
        return [allRows.filter((row) => row.key_prefix === prefix)];
      }
      if (/UPDATE api_keys SET last_used_at/i.test(text)) return [{ affectedRows: 1 }];

      if (text.startsWith('SELECT id, request_hash')) {
        const [apiKeyId, key] = params;
        const row = idem.get(`${apiKeyId}:${key}`);
        return [row ? [row] : []];
      }
      if (text.startsWith('INSERT INTO idempotency_keys')) {
        const [apiKeyId, key, method, path, hash, expiresAt] = params;
        const storeKey = `${apiKeyId}:${key}`;
        if (idem.has(storeKey)) {
          const error = new Error('Duplicate entry');
          error.code = 'ER_DUP_ENTRY';
          throw error;
        }
        const row = {
          id: nextIdem += 1,
          method,
          path,
          request_hash: hash,
          status_code: null,
          response_body: null,
          expires_at: expiresAt,
        };
        idem.set(storeKey, row);
        return [{ insertId: row.id }];
      }
      if (text.startsWith('UPDATE idempotency_keys')) {
        const [statusCode, body, apiKeyId, key] = params;
        const row = idem.get(`${apiKeyId}:${key}`);
        if (!row) return [{ affectedRows: 0 }];
        row.status_code = statusCode;
        row.response_body = body;
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith('DELETE FROM idempotency_keys')) {
        if (params.length === 2) {
          idem.delete(`${params[0]}:${params[1]}`);
        } else {
          for (const [key, row] of idem) {
            if (row.id === params[0]) idem.delete(key);
          }
        }
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith('INSERT INTO agent_audit_log')) {
        audits.push(params);
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };
}

const state = {
  listPageCalls: [],
  creates: [],
  patches: [],
  deletes: [],
};

let app;
let db;

function bearer(key) {
  return { Authorization: `Bearer ${key}` };
}

function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contactRow(overrides = {}) {
  return {
    id: 1,
    name: 'Ada',
    email: 'ada@example.test',
    phone: '+62 812 0000 0000',
    message: 'A long enough contact message.',
    is_read: 0,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

test.before(async () => {
  db = makeDb();
  apiKeys.__setDbForTests(db);
  auth.__setDbForTests(db);
  idempotency.__setDbForTests(db);
  audit.__setDbForTests(db);

  contacts.listPage = async (query) => {
    state.listPageCalls.push(query);
    return {
      items: [contactRow()],
      total: 1,
      unread: 1,
      page: 2,
      per_page: 5,
      total_pages: 1,
    };
  };
  contacts.get = async (id) => (Number(id) === 999 ? null : contactRow({ id: Number(id) }));
  contacts.create = async (body) => {
    state.creates.push(body);
    if (!body.name) {
      throw httpError(400, { message: 'name is required', errors: ['name is required'] });
    }
    return { emailSent: false, contactId: 77 };
  };
  contacts.setRead = async (id, isRead) => {
    state.patches.push({ id: Number(id), isRead });
    if (Number(id) === 999) throw httpError(404, { message: 'Contact not found' });
    if (isRead === 'bad') {
      throw httpError(400, {
        message: 'is_read must be a boolean (true/false) or 0/1',
        errors: ['is_read must be a boolean (true/false) or 0/1'],
      });
    }
    return contactRow({ id: Number(id), is_read: isRead === true || isRead === 1 ? 1 : 0 });
  };
  contacts.remove = async (id) => {
    state.deletes.push(Number(id));
    if (Number(id) === 999) throw httpError(404, { message: 'Contact not found' });
    return { id: Number(id) };
  };

  app = await startApp();
});

test.after(async () => {
  if (app) await app.close();
  contacts.listPage = originals.listPage;
  contacts.get = originals.get;
  contacts.create = originals.create;
  contacts.setRead = originals.setRead;
  contacts.remove = originals.remove;
  auth.__setDbForTests(null);
  apiKeys.__setDbForTests(null);
  idempotency.__setDbForTests(null);
  audit.__setDbForTests(null);
  delete process.env.AGENT_BODY_LIMIT;
  delete process.env.AGENT_MEDIA_BODY_LIMIT;
  delete process.env.AGENT_RATE_LIMIT_READ;
  delete process.env.AGENT_RATE_LIMIT_WRITE;
});

// ---------------------------------------------------------------------------
// contacts
// ---------------------------------------------------------------------------

test('contacts: key and read scope required', async () => {
  const anonymous = await app.request('GET', '/api/agent/v1/contacts');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error.code, 'UNAUTHORIZED');

  const forbidden = await app.request('GET', '/api/agent/v1/contacts', {
    headers: bearer(noContactsRead.generated.key),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error.context.required_scope, 'contacts:read');
});

test('GET /contacts: data.items plus pagination/unread meta', async () => {
  state.listPageCalls.length = 0;
  const res = await app.request('GET', '/api/agent/v1/contacts?page=2&per_page=5&unread=true', {
    headers: bearer(reader.generated.key),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.data.items.length, 1);
  assert.equal(res.json.data.items[0].email, 'ada@example.test');
  assert.equal(res.json.meta.total, 1);
  assert.equal(res.json.meta.unread, 1);
  assert.equal(res.json.meta.page, 2);
  assert.equal(res.json.meta.per_page, 5);
  assert.equal(res.json.meta.total_pages, 1);
  assert.deepEqual(state.listPageCalls[0], { page: '2', per_page: '5', unread: 'true' });
});

test('GET /contacts/:id: invalid id -> 400, missing -> 404, found -> row', async () => {
  const invalid = await app.request('GET', '/api/agent/v1/contacts/abc', {
    headers: bearer(reader.generated.key),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'VALIDATION_ERROR');

  const missing = await app.request('GET', '/api/agent/v1/contacts/999', {
    headers: bearer(reader.generated.key),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');

  const found = await app.request('GET', '/api/agent/v1/contacts/1', {
    headers: bearer(reader.generated.key),
  });
  assert.equal(found.status, 200);
  assert.equal(found.json.data.id, 1);
});

test('POST /contacts: 201 with delivery status and fallback, validation 400, write scope', async () => {
  state.creates.length = 0;
  const res = await app.request('POST', '/api/agent/v1/contacts', {
    headers: bearer(writer.generated.key),
    body: {
      name: 'Ada',
      email: 'ada@example.test',
      phone: '+62 812 0000 0000',
      message: 'A long enough contact message.',
    },
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json.data, { id: 77, email_sent: false, fallback: 'whatsapp' });
  assert.equal(state.creates.length, 1);

  const readerWrite = await app.request('POST', '/api/agent/v1/contacts', {
    headers: bearer(reader.generated.key),
    body: { name: 'Ada' },
  });
  assert.equal(readerWrite.status, 403);
  assert.equal(readerWrite.json.error.context.required_scope, 'contacts:write');

  const invalid = await app.request('POST', '/api/agent/v1/contacts', {
    headers: bearer(writer.generated.key),
    body: {},
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(invalid.json.error.details, [{ message: 'name is required' }]);
});

test('PATCH /contacts/:id: only is_read, unknown field -> 400, 404 missing', async () => {
  state.patches.length = 0;
  const patched = await app.request('PATCH', '/api/agent/v1/contacts/1', {
    headers: bearer(writer.generated.key),
    body: { is_read: 1 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.is_read, 1);
  assert.deepEqual(state.patches[0], { id: 1, isRead: 1 });

  const unknown = await app.request('PATCH', '/api/agent/v1/contacts/1', {
    headers: bearer(writer.generated.key),
    body: { is_read: 1, message: 'rewrite' },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, 'VALIDATION_ERROR');
  assert.match(unknown.json.error.message, /Unknown field/);

  const missingField = await app.request('PATCH', '/api/agent/v1/contacts/1', {
    headers: bearer(writer.generated.key),
    body: {},
  });
  assert.equal(missingField.status, 400);

  const missing = await app.request('PATCH', '/api/agent/v1/contacts/999', {
    headers: bearer(writer.generated.key),
    body: { is_read: false },
  });
  assert.equal(missing.status, 404);
});

test('DELETE /contacts/:id: confirmation, delete scope, 404 and success', async () => {
  state.deletes.length = 0;
  const missingHeader = await app.request('DELETE', '/api/agent/v1/contacts/1', {
    headers: bearer(admin.generated.key),
  });
  assert.equal(missingHeader.status, 400);
  assert.equal(missingHeader.json.error.code, 'CONFIRMATION_REQUIRED');

  const writerDelete = await app.request('DELETE', '/api/agent/v1/contacts/1', {
    headers: { ...bearer(writer.generated.key), 'X-Confirm-Delete': 'true' },
  });
  assert.equal(writerDelete.status, 403);
  assert.equal(writerDelete.json.error.context.required_scope, 'contacts:delete');

  const missing = await app.request('DELETE', '/api/agent/v1/contacts/999', {
    headers: { ...bearer(admin.generated.key), 'X-Confirm-Delete': 'true' },
  });
  assert.equal(missing.status, 404);

  const deleted = await app.request('DELETE', '/api/agent/v1/contacts/1', {
    headers: { ...bearer(admin.generated.key), 'X-Confirm-Delete': '1' },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json.data, { id: 1, deleted: true });
  assert.ok(state.deletes.includes(1));
});

test('POST /contacts: Idempotency-Key replay returns the first response', async () => {
  state.creates.length = 0;
  db.audits.length = 0;
  const headers = { ...bearer(writer.generated.key), 'Idempotency-Key': 'zz-http-contact-idem' };
  const body = {
    name: 'Replay',
    email: 'replay@example.test',
    phone: null,
    message: 'A long enough replay message.',
  };

  const first = await app.request('POST', '/api/agent/v1/contacts', { headers, body });
  assert.equal(first.status, 201);
  await wait();

  const second = await app.request('POST', '/api/agent/v1/contacts', { headers, body });
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(second.json, first.json);
  assert.equal(state.creates.length, 1);

  // The replayed request must not run the handler again, so it must not add a
  // second audit row either.
  const contactAudits = db.audits.filter((params) => params[4] === 'contact');
  assert.equal(contactAudits.length, 1);
});

test('contact mutations write contact audit rows exactly once', async () => {
  const createRequestId = 'zz-http-contact-audit-create';
  const deleteRequestId = 'zz-http-contact-audit-delete';
  db.audits.length = 0;

  const created = await app.request('POST', '/api/agent/v1/contacts', {
    headers: { ...bearer(writer.generated.key), 'X-Request-Id': createRequestId },
    body: {
      name: 'Audit',
      email: 'audit@example.test',
      phone: null,
      message: 'A long enough audit message.',
    },
  });
  assert.equal(created.status, 201);

  const deleted = await app.request('DELETE', '/api/agent/v1/contacts/1', {
    headers: {
      ...bearer(admin.generated.key),
      'X-Request-Id': deleteRequestId,
      'X-Confirm-Delete': 'true',
    },
  });
  assert.equal(deleted.status, 200);
  await wait();

  const createRow = db.audits.find((params) => params[7] === createRequestId);
  assert.ok(createRow, 'contact create audit row missing');
  assert.equal(createRow[4], 'contact');
  assert.equal(String(createRow[5]), '77');
  assert.equal(createRow[6], 201);

  const deleteRow = db.audits.find((params) => params[7] === deleteRequestId);
  assert.ok(deleteRow, 'contact delete audit row missing');
  assert.equal(deleteRow[4], 'contact');
  assert.equal(String(deleteRow[5]), '1');
  assert.equal(deleteRow[6], 200);
});

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

test('POST /media: multipart idempotency is skipped, same key + different file runs twice', async () => {
  db.audits.length = 0;
  const headers = {
    ...bearer(admin.generated.key),
    'Idempotency-Key': 'zz-media-multipart-idem',
  };

  for (const filename of ['first.png', 'second.png']) {
    const form = new FormData();
    form.append('image', new Blob([PNG_BYTES], { type: 'image/png' }), filename);
    const res = await app.request('POST', '/api/agent/v1/media', { headers, body: form });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    // A replay would set this header; the multipart path must never replay.
    assert.equal(res.headers.get('idempotent-replayed'), null);
  }

  await wait();
  const mediaAudits = db.audits.filter((params) => params[4] === 'media');
  assert.equal(mediaAudits.length, 2);
});

test('POST /media: JSON base64 still uses idempotency (hashable body)', async () => {
  db.audits.length = 0;
  const headers = {
    ...bearer(admin.generated.key),
    'Idempotency-Key': 'zz-media-json-idem',
  };
  const body = { filename: 'photo.png', content_base64: PNG_BYTES.toString('base64') };

  const first = await app.request('POST', '/api/agent/v1/media', { headers, body });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const second = await app.request('POST', '/api/agent/v1/media', { headers, body });
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(second.json, first.json);

  await wait();
  const mediaAudits = db.audits.filter((params) => params[4] === 'media');
  assert.equal(mediaAudits.length, 1);
});

test('POST /media: JSON base64 with the same key and different content conflicts', async () => {
  const headers = {
    ...bearer(admin.generated.key),
    'Idempotency-Key': 'zz-media-json-conflict',
  };
  const png = PNG_BYTES.toString('base64');
  const first = await app.request('POST', '/api/agent/v1/media', {
    headers,
    body: { filename: 'photo.png', content_base64: png },
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));

  const second = await app.request('POST', '/api/agent/v1/media', {
    headers,
    body: {
      filename: 'photo.png',
      content_base64: `${png.slice(0, 8)}AAAA${png.slice(12)}`,
    },
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('POST /media: multipart image succeeds through the fake Cloudinary stub', async () => {
  const form = new FormData();
  form.append('image', new Blob([PNG_BYTES], { type: 'image/png' }), 'photo.png');

  const res = await app.request('POST', '/api/agent/v1/media', {
    headers: bearer(admin.generated.key),
    body: form,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.ok, true);
  assert.match(res.json.data.url, /^https:\/\//);
  assert.equal(res.json.data.path, res.json.data.url);
  assert.equal(res.json.data.format, 'png');
  assert.ok(res.json.data.public_id);
  assert.equal(typeof res.json.data.width, 'number');
  assert.equal(typeof res.json.data.height, 'number');
});

test('POST /media: JSON base64 succeeds, with and without a data URL prefix', async () => {
  for (const content of [
    PNG_BYTES.toString('base64'),
    `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
  ]) {
    const res = await app.request('POST', '/api/agent/v1/media', {
      headers: bearer(admin.generated.key),
      body: { filename: 'photo.png', content_base64: content },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.data.format, 'png');
  }
});

test('POST /media: invalid extension, malformed base64 and magic-byte mismatch are 400', async () => {
  const badExt = await app.request('POST', '/api/agent/v1/media', {
    headers: bearer(admin.generated.key),
    body: { filename: 'photo.svg', content_base64: PNG_BYTES.toString('base64') },
  });
  assert.equal(badExt.status, 400);
  assert.equal(badExt.json.error.code, 'VALIDATION_ERROR');

  const badBase64 = await app.request('POST', '/api/agent/v1/media', {
    headers: bearer(admin.generated.key),
    body: { filename: 'photo.png', content_base64: 'not base64!' },
  });
  assert.equal(badBase64.status, 400);

  const mismatch = await app.request('POST', '/api/agent/v1/media', {
    headers: bearer(admin.generated.key),
    body: {
      filename: 'photo.gif',
      content_base64: PNG_BYTES.toString('base64'),
    },
  });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.json.error.message, /extension does not match/i);
});

test('POST /media: authentication and media:write scope are required', async () => {
  const anonymous = await app.request('POST', '/api/agent/v1/media', {
    body: { filename: 'photo.png', content_base64: PNG_BYTES.toString('base64') },
  });
  assert.equal(anonymous.status, 401);

  const forbidden = await app.request('POST', '/api/agent/v1/media', {
    headers: bearer(noMedia.generated.key),
    body: { filename: 'photo.png', content_base64: PNG_BYTES.toString('base64') },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error.context.required_scope, 'media:write');
});

test('body limits: /media uses AGENT_MEDIA_BODY_LIMIT, other paths keep AGENT_BODY_LIMIT', async () => {
  const mediaHuge = JSON.stringify({ content_base64: 'x'.repeat(20 * 1024) });
  const mediaRes = await app.request('POST', '/api/agent/v1/media', {
    headers: bearer(admin.generated.key),
    raw: mediaHuge,
  });
  assert.equal(mediaRes.status, 413);
  assert.equal(mediaRes.json.error.code, 'PAYLOAD_TOO_LARGE');

  const otherHuge = JSON.stringify({ name: 'x'.repeat(2048) });
  const otherRes = await app.request('POST', '/api/agent/v1/contacts', {
    headers: bearer(writer.generated.key),
    raw: otherHuge,
  });
  assert.equal(otherRes.status, 413);
  assert.equal(otherRes.json.error.code, 'PAYLOAD_TOO_LARGE');
});

test('unauthenticated oversized body is rejected before parsing', async () => {
  const huge = JSON.stringify({ content_base64: 'x'.repeat(20 * 1024) });
  const res = await app.request('POST', '/api/agent/v1/media', { raw: huge });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'UNAUTHORIZED');
});
