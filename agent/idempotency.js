// backend/agent/idempotency.js
//
// Idempotency-key helper for Agent API mutations.
//
// States returned by begin():
//   new         first time this (api_key_id, idem_key) pair is seen
//   replay      a completed response exists; return it verbatim
//   in-progress the first request is still running
//   conflict    same key reused with a different request body/path/method
//
// Multipart limitation: a multipart/form-data body is consumed by multer AFTER
// this middleware runs, so req.body is empty here and the file bytes cannot be
// hashed. Idempotency is therefore skipped for multipart requests; only JSON
// bodies (including base64 media uploads) are deduplicated. JSON media uploads
// remain safe because the base64 payload is part of the hashed body.

const crypto = require('crypto');
const db = require('../config/db');
const { AgentError } = require('./errors');
const { sendError } = require('./envelope');

let dbPool = db;

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

// AGENT_IDEMPOTENCY_TTL_HOURS defaults to 24 hours. Invalid/non-positive values
// fall back to the default rather than creating rows that expire immediately.
function getIdempotencyTtlSeconds() {
  const hours = Number(process.env.AGENT_IDEMPOTENCY_TTL_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_TTL_SECONDS;
  return Math.max(1, Math.floor(hours * 60 * 60));
}

function __setDbForTests(fake) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setDbForTests is not available in production');
  }
  if (fake === null || fake === undefined) {
    dbPool = db;
    return;
  }
  if (typeof fake.query !== 'function') {
    throw new Error('db fake must expose query()');
  }
  dbPool = fake;
}

// Deterministic JSON serialisation with object keys sorted at every depth.
// Arrays keep their order (query strings and lists are order-sensitive).
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

function requestHash({ method, path, body } = {}) {
  return stableHash({
    method: String(method || 'GET').toUpperCase(),
    path: String(path || ''),
    body: body === undefined ? null : body,
  });
}

function parseStoredBody(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function selectRow(apiKeyId, idemKey) {
  const [rows] = await dbPool.query(
    `SELECT id, request_hash, status_code, response_body, expires_at
       FROM idempotency_keys
      WHERE api_key_id = ? AND idem_key = ?
      LIMIT 1`,
    [apiKeyId, idemKey]
  );
  return rows && rows[0] ? rows[0] : null;
}

function isExpired(row, nowMs) {
  if (!row.expires_at) return false;
  const expires = new Date(row.expires_at).getTime();
  return Number.isFinite(expires) && expires <= nowMs;
}

async function begin({ apiKeyId, key, method, path, hash, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now() } = {}) {
  const idemKey = key;
  if (!Number.isFinite(Number(apiKeyId)) || Number(apiKeyId) <= 0) {
    throw new Error('idempotency.begin() requires a valid apiKeyId');
  }
  if (typeof idemKey !== 'string' || idemKey.trim() === '') {
    throw new Error('idempotency.begin() requires an Idempotency-Key');
  }
  const apiKey = Number(apiKeyId);
  const digest = hash || requestHash({ method, path });
  let row = await selectRow(apiKey, idemKey);

  if (row && isExpired(row, now)) {
    await dbPool.query('DELETE FROM idempotency_keys WHERE id = ?', [row.id]);
    row = null;
  }

  if (row) {
    if (String(row.request_hash) !== String(digest)) {
      return { state: 'conflict', id: row.id };
    }
    if (row.status_code === null || row.status_code === undefined) {
      return { state: 'in-progress', id: row.id };
    }
    return {
      state: 'replay',
      id: row.id,
      statusCode: Number(row.status_code),
      body: parseStoredBody(row.response_body),
    };
  }

  const expiresAt = new Date(now + Math.max(1, Number(ttlSeconds) || DEFAULT_TTL_SECONDS) * 1000);
  try {
    const [result] = await dbPool.query(
      `INSERT INTO idempotency_keys
         (api_key_id, idem_key, method, path, request_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [apiKey, idemKey, String(method || '').toUpperCase(), String(path || ''), digest, expiresAt]
    );
    return { state: 'new', id: result && result.insertId };
  } catch (error) {
    // Concurrent first request won the unique-key race: re-read its row.
    if (error && error.code === 'ER_DUP_ENTRY') {
      const raced = await selectRow(apiKey, idemKey);
      if (raced && String(raced.request_hash) !== String(digest)) {
        return { state: 'conflict', id: raced.id };
      }
      if (raced && (raced.status_code === null || raced.status_code === undefined)) {
        return { state: 'in-progress', id: raced.id };
      }
      if (raced) {
        return {
          state: 'replay',
          id: raced.id,
          statusCode: Number(raced.status_code),
          body: parseStoredBody(raced.response_body),
        };
      }
    }
    throw error;
  }
}

async function complete({ apiKeyId, key, statusCode, body } = {}) {
  const payload = body === undefined || body === null
    ? null
    : (typeof body === 'string' ? body : JSON.stringify(body));
  const [result] = await dbPool.query(
    `UPDATE idempotency_keys
        SET status_code = ?, response_body = ?
      WHERE api_key_id = ? AND idem_key = ?`,
    [Number(statusCode), payload, Number(apiKeyId), String(key)]
  );
  return Boolean(result && result.affectedRows);
}

function replayResponse(result) {
  return {
    statusCode: result.statusCode,
    body: result.body,
  };
}

// Drop an in-progress row so a 5xx response does not become a permanent replay
// or leave the key wedged in "in-progress" until the TTL elapses.
async function abandon({ apiKeyId, key } = {}) {
  try {
    await dbPool.query(
      'DELETE FROM idempotency_keys WHERE api_key_id = ? AND idem_key = ?',
      [Number(apiKeyId), String(key)]
    );
    return true;
  } catch {
    return false;
  }
}

function headerValue(req) {
  const raw = req.headers && req.headers['idempotency-key'];
  if (Array.isArray(raw)) return raw[0] === undefined ? '' : String(raw[0]);
  return raw === undefined || raw === null ? null : String(raw);
}

// multipart/form-data cannot be hashed at this point: multer has not run yet,
// so req.body is empty and the file bytes live in the unparsed stream.
function isMultipartRequest(req) {
  if (typeof req.is === 'function') {
    try {
      if (req.is('multipart/form-data')) return true;
    } catch {
      // Fall through to the header check below.
    }
  }
  const contentType = req.headers && req.headers['content-type'];
  return typeof contentType === 'string'
    && contentType.toLowerCase().startsWith('multipart/form-data');
}

// Express middleware for protected Agent API mutations. GET/HEAD and requests
// without the header pass straight through.
function idempotencyMiddleware(req, res, next) {
  if (!MUTATING_METHODS.has(String(req.method || '').toUpperCase())) return next();
  if (!req.apiKey) return next();

  // See the multipart limitation in the file header. Skipping here means a
  // same-key retry with a different file runs the handler again instead of
  // replaying the first upload's response.
  if (isMultipartRequest(req)) return next();

  const supplied = headerValue(req);
  if (supplied === null) return next();

  const key = supplied.trim();
  if (key === '') {
    return sendError(req, res, new AgentError(
      'VALIDATION_ERROR',
      'Idempotency-Key must not be empty'
    ));
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return sendError(req, res, new AgentError(
      'VALIDATION_ERROR',
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`
    ));
  }

  const apiKeyId = req.apiKey.id;
  const method = String(req.method || '').toUpperCase();
  const path = req.originalUrl || req.url || '';
  const hash = requestHash({ method, path, body: req.body });
  const ttlSeconds = getIdempotencyTtlSeconds();

  begin({ apiKeyId, key, method, path, hash, ttlSeconds })
    .then((result) => {
      if (!result) return next();

      if (result.state === 'conflict') {
        return sendError(req, res, new AgentError('IDEMPOTENCY_CONFLICT'));
      }
      if (result.state === 'in-progress') {
        res.setHeader('Retry-After', '1');
        return sendError(req, res, new AgentError('IDEMPOTENCY_IN_PROGRESS'));
      }
      if (result.state === 'replay') {
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(result.statusCode).json(result.body);
      }

      // New key: persist the response BEFORE sending it, so a client that
      // receives the response can retry immediately and get a replay. A
      // persistence failure is fail-open: log a short code-only diagnostic
      // (never the body or the key) and still answer the caller.
      let settled = false;
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (settled) return originalJson(body);
        settled = true;

        const persist = res.statusCode >= 500
          ? abandon({ apiKeyId, key })
          : complete({ apiKeyId, key, statusCode: res.statusCode, body });

        const send = () => {
          try {
            return originalJson(body);
          } catch (error) {
            console.error('Idempotency response failed:', error && (error.code || error.name));
            if (!res.headersSent) res.end();
            return res;
          }
        };

        Promise.resolve(persist)
          .catch((error) => {
            // Code-only diagnostic: never log the stored body, the key or the
            // SQL text (which may embed caller values).
            console.error('Idempotency persist failed:', error && (error.code || error.name || 'unknown'));
          })
          .then(send);
        return res;
      };

      return next();
    })
    .catch((error) => {
      // A broken idempotency store must not take down ordinary writes.
      console.error('Idempotency middleware error:', error && (error.code || error.message));
      return next();
    });
}

module.exports = {
  stableStringify,
  stableHash,
  requestHash,
  hashRequest: requestHash,
  begin,
  complete,
  abandon,
  replayResponse,
  getIdempotencyTtlSeconds,
  idempotencyMiddleware,
  middleware: idempotencyMiddleware,
  isMultipartRequest,
  DEFAULT_TTL_SECONDS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  __setDbForTests,
};
