// backend/agent/envelope.js
//
// The Agent API answers with a single envelope:
//   success: { ok: true, data, meta: { request_id, ... } }
//   error:   { ok: false, error: { code, message, details?, context? },
//              meta: { request_id } }
//
// Every response (including 404/500) carries a request id. Callers may send a
// safe X-Request-Id; anything else is replaced with a generated UUID.

const crypto = require('crypto');
const { AgentError, normalizeAgentError } = require('./errors');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function attachRequestId(req, res) {
  let id = null;
  const supplied = req.headers && req.headers['x-request-id'];
  if (typeof supplied === 'string' && REQUEST_ID_PATTERN.test(supplied.trim())) {
    id = supplied.trim();
  }
  if (!id) id = crypto.randomUUID();
  req.requestId = id;
  if (res && typeof res.setHeader === 'function' && !res.headersSent) {
    res.setHeader('X-Request-Id', id);
  }
  return id;
}

function getRequestId(req, res) {
  if (req && req.requestId) return req.requestId;
  return attachRequestId(req || { headers: {} }, res);
}

function sendSuccess(req, res, data, meta) {
  const requestId = getRequestId(req, res);
  const body = {
    ok: true,
    data,
    meta: { ...(meta && typeof meta === 'object' ? meta : {}), request_id: requestId },
  };
  return res.json(body);
}

function errorPayload(error) {
  const agentError = normalizeAgentError(error);
  const payload = {
    code: agentError.code,
    message: agentError.message,
  };
  if (agentError.details !== undefined) payload.details = agentError.details;
  if (agentError.context !== undefined) payload.context = agentError.context;
  return { status: agentError.status, payload };
}

function sendError(req, res, error) {
  const requestId = getRequestId(req, res);
  const { status, payload } = errorPayload(error);
  if (res.headersSent) return res.end();
  return res.status(status).json({
    ok: false,
    error: payload,
    meta: { request_id: requestId },
  });
}

module.exports = {
  attachRequestId,
  getRequestId,
  sendSuccess,
  success: sendSuccess,
  sendError,
  failure: sendError,
  errorPayload,
  AgentError,
};
