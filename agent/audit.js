// backend/agent/audit.js
//
// Best-effort audit trail. Auditing must never break a request, so every
// failure (missing table, DB outage, bad data) is swallowed.

const db = require('../config/db');

let dbPool = db;

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

function valueOrNull(value) {
  return value === undefined ? null : value;
}

async function recordAudit(entry = {}) {
  try {
    const statusCode = Number.isFinite(Number(entry.status_code))
      ? Number(entry.status_code)
      : 0;
    await dbPool.query(
      `INSERT INTO agent_audit_log
         (api_key_id, user_id, method, path, resource_type, resource_id,
          status_code, request_id, ip, user_agent, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        valueOrNull(entry.api_key_id),
        valueOrNull(entry.user_id),
        String(entry.method || ''),
        String(entry.path || ''),
        valueOrNull(entry.resource_type),
        valueOrNull(entry.resource_id),
        statusCode,
        String(entry.request_id || ''),
        valueOrNull(entry.ip),
        valueOrNull(entry.user_agent),
        Number.isFinite(Number(entry.duration_ms)) ? Number(entry.duration_ms) : null,
      ]
    );
    return true;
  } catch {
    return false;
  }
}

function requestIp(req) {
  if (!req) return null;
  if (typeof req.ip === 'string' && req.ip !== '') return req.ip;
  const socket = req.socket || req.connection;
  return socket && socket.remoteAddress ? socket.remoteAddress : null;
}

// Record a mutation directly from an Express request. Callers pass the
// resource/status data; everything identifying the caller is read from req so
// routes cannot forget the api key, request id or duration.
async function recordMutation(req, entry = {}) {
  const apiKey = req && req.apiKey ? req.apiKey : {};
  const startedAt = req && Number.isFinite(Number(req.agentStartedAt))
    ? Number(req.agentStartedAt)
    : null;
  const durationMs = entry.duration_ms !== undefined
    ? entry.duration_ms
    : (startedAt === null ? null : Date.now() - startedAt);

  return recordAudit({
    api_key_id: entry.api_key_id !== undefined ? entry.api_key_id : apiKey.id,
    user_id: entry.user_id !== undefined ? entry.user_id : apiKey.userId,
    method: entry.method || (req && req.method) || '',
    path: entry.path || (req && (req.originalUrl || req.url)) || '',
    resource_type: entry.resource_type,
    resource_id: entry.resource_id === undefined || entry.resource_id === null
      ? null
      : String(entry.resource_id),
    status_code: entry.status_code,
    request_id: entry.request_id || (req && req.requestId) || '',
    ip: entry.ip !== undefined ? entry.ip : requestIp(req),
    user_agent: entry.user_agent !== undefined
      ? entry.user_agent
      : (req && req.headers ? req.headers['user-agent'] || null : null),
    duration_ms: durationMs,
  });
}

module.exports = { recordAudit, recordMutation, __setDbForTests };
