// backend/test/db/agentContacts.test.js
//
// DB-backed Phase 3 Agent API contact checks: create, list/get, read flag,
// delete and the audit row. Skips (does not fail) when no scratch MySQL is
// available. Media is not DB-backed, so it is covered by the HTTP and unit
// suites instead.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryGetDb, createDbLock, withTestDbLock } = require('../helpers/db');

// Unique per run; DB suites run in parallel processes on the same scratch
// database and must not share prefixes or cleanup scopes.
const MARK = `zz-nodetest-agentcontacts-${Date.now().toString(36)}`;

let ctx = null;

test.before(async () => {
  const { db, reason } = await tryGetDb();
  if (!db) {
    ctx = { skip: true, reason };
    return;
  }

  try {
    await db.query('SELECT id, is_read FROM contacts LIMIT 1');
  } catch (err) {
    ctx = { skip: true, reason: `contacts table missing (${err.code || err.message})` };
    return;
  }

  const [admins] = await db.query(
    "SELECT id, username, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"
  );
  const user = admins && admins[0];
  if (!user) {
    ctx = { skip: true, reason: 'scratch database has no admin user (run node scripts/setup-test-db.js)' };
    return;
  }

  // Acquire the advisory lock BEFORE creating the API key so another suite's
  // cleanup cannot touch it while setup writes to the scratch database.
  const lock = createDbLock(db);
  const { startApp } = require('../helpers/app');
  await withTestDbLock(lock, async () => {
    const { migrate } = require('../../database/migrate-agent-foundation');
    await migrate();

    const apiKeys = require('../../services/apiKeys');
    const created = await apiKeys.createApiKey({
      name: `${MARK}-${Date.now().toString(36)}`,
      userId: user.id,
      scopes: ['contacts:read', 'contacts:write', 'contacts:delete'],
      expiresAt: null,
    });

    const contacts = require('../../services/contacts');
    contacts.__setMailerForTests({
      isEmailConfigured: () => false,
      missingEmailConfigKeys: () => ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASS'],
      async sendContactEmail() {
        return { sent: false, error: 'not configured' };
      },
    });

    const app = await startApp({ httpClient: 'node' });
    ctx = {
      skip: false,
      db,
      app,
      lock,
      apiKey: created.key,
      keyId: created.apiKey.id,
    };
  });
});

test.after(async () => {
  if (!ctx || ctx.skip) return;
  const contacts = require('../../services/contacts');
  contacts.__setMailerForTests(null);
  try {
    await ctx.db.query('DELETE FROM contacts WHERE email LIKE ?', [`${MARK}%`]);
    await ctx.db.query('DELETE FROM agent_audit_log WHERE api_key_id = ?', [ctx.keyId]);
    await ctx.db.query('DELETE FROM idempotency_keys WHERE api_key_id = ?', [ctx.keyId]);
    await ctx.db.query('DELETE FROM api_keys WHERE id = ?', [ctx.keyId]);
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

function headers(extra = {}) {
  return { Authorization: `Bearer ${ctx.apiKey}`, ...extra };
}

function wait(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

dbTest('contact CRUD through the agent API, including read flag and unread filter', async () => {
  const email = `${MARK}-crud@example.test`;

  const created = await ctx.app.request('POST', '/api/agent/v1/contacts', {
    headers: headers(),
    body: {
      name: `${MARK} Crud`,
      email,
      phone: '+62 812 0000 0000',
      message: 'A long enough contact message for the agent API test.',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.email_sent, false);
  assert.equal(created.json.data.fallback, 'whatsapp');
  const id = created.json.data.id;

  const fetched = await ctx.app.request('GET', `/api/agent/v1/contacts/${id}`, { headers: headers() });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.data.email, email);
  assert.equal(Number(fetched.json.data.is_read), 0);

  const unread = await ctx.app.request('GET', '/api/agent/v1/contacts?unread=true&per_page=100', {
    headers: headers(),
  });
  assert.equal(unread.status, 200);
  assert.ok(unread.json.data.items.some((row) => row.id === id));

  const patched = await ctx.app.request('PATCH', `/api/agent/v1/contacts/${id}`, {
    headers: headers(),
    body: { is_read: true },
  });
  assert.equal(patched.status, 200);
  assert.equal(Number(patched.json.data.is_read), 1);

  const [stored] = await ctx.db.query('SELECT name, email, message, is_read FROM contacts WHERE id = ?', [id]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].email, email);
  assert.equal(Number(stored[0].is_read), 1);

  const noHeader = await ctx.app.request('DELETE', `/api/agent/v1/contacts/${id}`, { headers: headers() });
  assert.equal(noHeader.status, 400);

  const deleted = await ctx.app.request('DELETE', `/api/agent/v1/contacts/${id}`, {
    headers: headers({ 'X-Confirm-Delete': 'true' }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json.data, { id, deleted: true });

  const gone = await ctx.app.request('GET', `/api/agent/v1/contacts/${id}`, { headers: headers() });
  assert.equal(gone.status, 404);
});

dbTest('contact create writes one audit row with resource_type contact', async () => {
  const requestId = `${MARK}-audit-${Date.now().toString(36)}`;

  const created = await ctx.app.request('POST', '/api/agent/v1/contacts', {
    headers: headers({ 'X-Request-Id': requestId }),
    body: {
      name: `${MARK} Audit`,
      email: `${MARK}-audit@example.test`,
      message: 'A long enough contact message for the audit test.',
    },
  });
  assert.equal(created.status, 201);
  await wait();

  const [rows] = await ctx.db.query(
    'SELECT resource_type, resource_id, method, status_code FROM agent_audit_log WHERE request_id = ?',
    [requestId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource_type, 'contact');
  assert.equal(String(rows[0].resource_id), String(created.json.data.id));
  assert.equal(rows[0].method, 'POST');
  assert.equal(rows[0].status_code, 201);

  await ctx.app.request('DELETE', `/api/agent/v1/contacts/${created.json.data.id}`, {
    headers: headers({ 'X-Confirm-Delete': 'true' }),
  });
});
