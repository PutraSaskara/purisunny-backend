// backend/agent/errors.js
//
// Transport-neutral error shape for the Agent API. The rest of the backend
// (services/*) throws `httpError(status, body)`; normalizeAgentError() maps
// those into a stable Agent API error code without leaking internals.

const { isHttpError } = require('../services/errors');

const STATUS_BY_CODE = Object.freeze({
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFIRMATION_REQUIRED: 400,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
});

const DEFAULT_MESSAGES = Object.freeze({
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  VALIDATION_ERROR: 'Validation failed',
  CONFIRMATION_REQUIRED: 'Confirmation required',
  CONFLICT: 'Conflict',
  IDEMPOTENCY_CONFLICT: 'Idempotency-Key was reused with a different request',
  IDEMPOTENCY_IN_PROGRESS: 'A request with this Idempotency-Key is already in progress',
  RATE_LIMITED: 'Rate limit exceeded',
  PAYLOAD_TOO_LARGE: 'Request body is too large',
  SERVICE_UNAVAILABLE: 'Service unavailable',
  INTERNAL_ERROR: 'Internal server error',
});

class AgentError extends Error {
  constructor(code, message, options = {}) {
    super(message || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.INTERNAL_ERROR);
    this.name = 'AgentError';
    this.code = STATUS_BY_CODE[code] ? code : 'INTERNAL_ERROR';
    this.status = Number.isFinite(options.status)
      ? options.status
      : STATUS_BY_CODE[this.code] || 500;
    if (options.details !== undefined) this.details = options.details;
    if (options.context !== undefined) this.context = options.context;
  }
}

function statusToCode(status) {
  switch (Number(status)) {
    case 400:
    case 422:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}

function normalizeDetails(errors) {
  if (!Array.isArray(errors)) return undefined;
  return errors.map((entry) => {
    if (entry && typeof entry === 'object' && typeof entry.message === 'string') {
      return { message: entry.message };
    }
    return { message: String(entry) };
  });
}

function normalizeAgentError(error) {
  if (error instanceof AgentError) return error;

  // Service-layer httpError(status, body): preserve the public fields the
  // legacy routes already expose, but under the agent error shape.
  if (isHttpError(error)) {
    // 5xx internals stay server-side; only client-facing 4xx bodies are mapped.
    if (Number(error.status) >= 500) {
      return statusToCode(error.status) === 'SERVICE_UNAVAILABLE'
        ? new AgentError('SERVICE_UNAVAILABLE')
        : new AgentError('INTERNAL_ERROR');
    }
    const body = error.body && typeof error.body === 'object' ? error.body : {};
    const code = statusToCode(error.status);
    const details = normalizeDetails(body.errors);
    const context = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === 'message' || key === 'errors') continue;
      context[key] = value;
    }
    return new AgentError(code, typeof body.message === 'string' ? body.message : undefined, {
      status: Number(error.status),
      details,
      context: Object.keys(context).length ? context : undefined,
    });
  }

  // express.json() body-parser errors.
  if (error && (error.type === 'entity.too.large' || Number(error.status) === 413)) {
    return new AgentError('PAYLOAD_TOO_LARGE');
  }
  if (error instanceof SyntaxError && Number(error.status) === 400) {
    return new AgentError('VALIDATION_ERROR', 'Invalid JSON body');
  }
  if (error && Number(error.status) === 400 && error.expose) {
    return new AgentError('VALIDATION_ERROR', String(error.message || DEFAULT_MESSAGES.VALIDATION_ERROR));
  }

  // Anything else is an implementation/internal failure. Keep the message
  // generic so stack traces, SQL text and credentials never reach a client.
  return new AgentError('INTERNAL_ERROR');
}

module.exports = {
  AgentError,
  normalizeAgentError,
  statusToCode,
  STATUS_BY_CODE,
  DEFAULT_MESSAGES,
};
