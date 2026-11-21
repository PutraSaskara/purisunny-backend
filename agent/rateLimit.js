// backend/agent/rateLimit.js
//
// Rate limits are per API key (never per IP) so one noisy key cannot consume
// another key's budget. Authentication failures use a small separate per-IP
// limiter because there is no key id to bucket them by yet.

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { AgentError } = require('./errors');
const { sendError } = require('./envelope');

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getRateLimits() {
  return {
    read: positiveInt(process.env.AGENT_RATE_LIMIT_READ, 120),
    write: positiveInt(process.env.AGENT_RATE_LIMIT_WRITE, 30),
    auth_failure: positiveInt(process.env.AGENT_AUTH_FAILURE_LIMIT, 20),
    window_ms: 60 * 1000,
  };
}

function limiterHandler(message, context) {
  return (req, res) => sendError(req, res, new AgentError('RATE_LIMITED', message, { context }));
}

function createRateLimiters() {
  const limits = getRateLimits();
  const windowMs = limits.window_ms;

  const keyedByApiKey = (bucket, limit) => rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `agent:${bucket}:${req.apiKey ? req.apiKey.id : 'anonymous'}`,
    handler: limiterHandler('Rate limit exceeded', {
      limit,
      window_ms: windowMs,
      bucket,
    }),
  });

  const authFailure = rateLimit({
    windowMs,
    limit: limits.auth_failure,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // IPv6-safe per-IP bucket. Only 401 responses count: a valid key never
    // loses its budget because another key (or a 404) was rejected.
    keyGenerator: (req) => `agent:auth:${ipKeyGenerator(req.ip, 56)}`,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode !== 401,
    handler: limiterHandler('Too many failed authentication attempts', {
      limit: limits.auth_failure,
      window_ms: windowMs,
      bucket: 'auth_failure',
    }),
  });

  return {
    limits,
    read: keyedByApiKey('read', limits.read),
    write: keyedByApiKey('write', limits.write),
    authFailure,
  };
}

function selectRateLimiter(limiters) {
  return (req, res, next) => {
    const limiter = req.method === 'GET' || req.method === 'HEAD'
      ? limiters.read
      : limiters.write;
    return limiter(req, res, next);
  };
}

module.exports = {
  getRateLimits,
  createRateLimiters,
  selectRateLimiter,
};
