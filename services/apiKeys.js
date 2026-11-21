// backend/services/apiKeys.js
//
// Agent API key lifecycle. Only a SHA-256 hash of the full key is stored; the
// plaintext key is returned exactly once by createApiKey().
//
// Key format: psk_live_<prefix>_<secret>
//   prefix  12 hex chars, UNIQUE lookup column
//   secret  32 random bytes, base64url
//
// Tests swap in a fake pool through __setDbForTests (refused in production).

const crypto = require('crypto');
const db = require('../config/db');
const { AgentError } = require('../agent/errors');
const {
  assertScopesAllowed,
  isKnownScope,
  parseScopes,
  uniqueScopes,
} = require('../agent/scopes');

const KEY_PREFIX = 'psk_live_';
const KEY_PATTERN = /^psk_live_([A-Za-z0-9-]{1,16})_(.+)$/;
const PREFIX_BYTES = 6; // 12 hex chars, fits VARCHAR(16)
const SECRET_BYTES = 32;

let dbPool = db;
// key id -> epoch ms of the last last_used_at write. Updated at most once per
// minute per key so a high-throughput client does not turn every request into
// an extra UPDATE.
const lastTouchByKey = new Map();
const TOUCH_INTERVAL_MS = 60 * 1000;

function __setDbForTests(fake) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setDbForTests is not available in production');
  }
  if (fake === null || fake === undefined) {
    dbPool = db;
    lastTouchByKey.clear();
    return;
  }
  if (typeof fake.query !== 'function') {
    throw new Error('db fake must expose query()');
  }
  dbPool = fake;
  lastTouchByKey.clear();
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function generateApiKey() {
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const key = `${KEY_PREFIX}${prefix}_${secret}`;
  return { key, prefix, hash: hashApiKey(key) };
}

function parseApiKey(key) {
  if (typeof key !== 'string') return null;
  const match = KEY_PATTERN.exec(key.trim());
  if (!match) return null;
  return { prefix: match[1], secret: match[2], key: key.trim() };
}

function timingSafeHexEqual(actualHex, expectedHex) {
  if (typeof actualHex !== 'string' || typeof expectedHex !== 'string') return false;
  if (!/^[a-f0-9]{64}$/i.test(actualHex) || !/^[a-f0-9]{64}$/i.test(expectedHex)) return false;
  const actual = Buffer.from(actualHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function mapKeyRow(row) {
  const scopes = parseScopes(row.scopes);
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    userId: row.user_id,
    username: row.username,
    role: row.role,
    scopes,
    isActive: Number(row.is_active) === 1,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

function normalizeName(name) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (value.length < 1 || value.length > 100) {
    throw new AgentError('VALIDATION_ERROR', 'Key name must be between 1 and 100 characters');
  }
  return value;
}

function normalizeScopeInput(scopes) {
  if (typeof scopes === 'string') {
    return uniqueScopes(scopes.split(',').map((scope) => scope.trim()).filter(Boolean));
  }
  if (!Array.isArray(scopes)) {
    throw new AgentError('VALIDATION_ERROR', 'Scopes must be an array or a comma-separated string');
  }
  return uniqueScopes(scopes);
}

function normalizeExpiry(expiresAt) {
  if (expiresAt === undefined || expiresAt === null) return null;
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(date.getTime())) {
    throw new AgentError('VALIDATION_ERROR', 'expiresAt must be a valid date or null');
  }
  return date;
}

// Parse CLI expiry syntax: 30d, 90d, 365d, 24h, or never. Default 90d.
function parseExpiry(spec, now = new Date()) {
  const raw = spec === undefined || spec === null || String(spec).trim() === ''
    ? '90d'
    : String(spec).trim().toLowerCase();
  if (raw === 'never' || raw === 'none') return null;

  const match = /^(\d+)([dh])$/.exec(raw);
  if (!match) {
    throw new AgentError('VALIDATION_ERROR', `Invalid expiry "${spec}". Use 30d, 90d, 365d, 24h, or never.`);
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AgentError('VALIDATION_ERROR', `Invalid expiry "${spec}". Use a positive value.`);
  }
  const unitMs = match[2] === 'd' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const base = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return new Date(base + amount * unitMs);
}

async function fetchOwner({ userId, username }) {
  let rows;
  if (Number.isFinite(Number(userId))) {
    [rows] = await dbPool.query('SELECT id, username, role FROM users WHERE id = ?', [Number(userId)]);
  } else if (typeof username === 'string' && username.trim() !== '') {
    [rows] = await dbPool.query('SELECT id, username, role FROM users WHERE username = ?', [username.trim()]);
  } else {
    throw new AgentError('VALIDATION_ERROR', 'A user id or username is required');
  }
  if (!rows || rows.length === 0) {
    throw new AgentError('VALIDATION_ERROR', 'Owner user not found');
  }
  return rows[0];
}

async function createApiKey({ name, userId, username, scopes, expiresAt, role } = {}) {
  const keyName = normalizeName(name);
  const scopeList = normalizeScopeInput(scopes);
  const owner = await fetchOwner({ userId, username });
  const ownerRole = owner.role;

  assertScopesAllowed(scopeList, ownerRole);

  const generated = generateApiKey();
  const expiry = normalizeExpiry(expiresAt);

  const [result] = await dbPool.query(
    `INSERT INTO api_keys
       (name, key_prefix, key_hash, user_id, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      keyName,
      generated.prefix,
      generated.hash,
      owner.id,
      JSON.stringify(scopeList),
      expiry,
    ]
  );

  return {
    key: generated.key,
    apiKey: {
      id: result && result.insertId,
      name: keyName,
      prefix: generated.prefix,
      userId: owner.id,
      username: owner.username,
      role: owner.role,
      scopes: scopeList,
      isActive: true,
      expiresAt: expiry ? expiry.toISOString() : null,
      lastUsedAt: null,
      createdAt: null,
      revokedAt: null,
    },
  };
}

async function listApiKeys() {
  const [rows] = await dbPool.query(
    `SELECT k.id, k.name, k.key_prefix, k.user_id, k.scopes, k.is_active,
            k.expires_at, k.last_used_at, k.created_at, k.revoked_at,
            u.username, u.role
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
      ORDER BY k.id DESC`
  );
  return (rows || []).map(mapKeyRow);
}

async function revokeApiKey(id) {
  const keyId = Number(id);
  if (!Number.isSafeInteger(keyId) || keyId <= 0) {
    throw new AgentError('VALIDATION_ERROR', 'A positive integer key id is required');
  }
  const [result] = await dbPool.query(
    'UPDATE api_keys SET is_active = 0, revoked_at = NOW() WHERE id = ?',
    [keyId]
  );
  return Boolean(result && result.affectedRows);
}

async function verifyApiKey(rawKey) {
  const parsed = parseApiKey(rawKey);
  if (!parsed) return null;

  const [rows] = await dbPool.query(
    `SELECT k.id, k.name, k.key_prefix, k.key_hash, k.user_id, k.scopes,
            k.is_active, k.expires_at, k.revoked_at,
            u.username, u.role
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_prefix = ?
      LIMIT 1`,
    [parsed.prefix]
  );
  const row = rows && rows[0];
  if (!row) return null;

  // Verify the hash before looking at any other state so a wrong secret never
  // learns whether a prefix is active/expired/revoked.
  if (!timingSafeHexEqual(hashApiKey(parsed.key), row.key_hash)) return null;
  if (Number(row.is_active) !== 1) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  const scopes = parseScopes(row.scopes);
  if (scopes.length === 0 || scopes.some((scope) => !isKnownScope(scope))) return null;
  // Role-cap enforcement happens in the auth middleware so a row edited outside
  // the service is refused with 403 (not treated as a malformed key).
  const ownerRole = row.role === 'admin' ? 'admin' : 'editor';

  return {
    apiKey: {
      ...mapKeyRow({ ...row, scopes }),
      scopes,
      role: ownerRole,
    },
  };
}

function touchLastUsed(id) {
  const keyId = Number(id);
  if (!Number.isSafeInteger(keyId) || keyId <= 0) return;
  const now = Date.now();
  const previous = lastTouchByKey.get(keyId);
  if (previous && now - previous < TOUCH_INTERVAL_MS) return;
  lastTouchByKey.set(keyId, now);
  // Fire and forget: usage telemetry must never fail authentication.
  Promise.resolve()
    .then(() => dbPool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [keyId]))
    .catch(() => {});
}

module.exports = {
  KEY_PREFIX,
  TOUCH_INTERVAL_MS,
  hashApiKey,
  hashKey: hashApiKey,
  generateApiKey,
  generateKey: generateApiKey,
  parseApiKey,
  parseExpiry,
  createApiKey,
  create: createApiKey,
  listApiKeys,
  list: listApiKeys,
  revokeApiKey,
  revoke: revokeApiKey,
  verifyApiKey,
  verify: verifyApiKey,
  touchLastUsed,
  __setDbForTests,
};
