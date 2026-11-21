// backend/agent/index.js
//
// Agent API router factory. Mounted at /api/agent/v1 in app.js BEFORE the
// global 100kb JSON parser so agent payloads can use their own 2MB limit.
//
// Order matters: kill switch -> request id -> public routes -> auth-failure
// limiter -> API key auth -> per-key rate limit -> path-aware JSON parser ->
// idempotency -> protected routes -> agent 404 -> agent error handler.
//
// Body parsing deliberately runs AFTER authentication so unauthenticated huge
// payloads are rejected before they are buffered. JSON parsing stays before
// idempotencyMiddleware because that middleware hashes req.body.

const express = require('express');
const { attachRequestId, sendError } = require('./envelope');
const { AgentError, normalizeAgentError } = require('./errors');
const { authenticateApiKey } = require('./auth');
const { createRateLimiters, selectRateLimiter } = require('./rateLimit');
const { idempotencyMiddleware } = require('./idempotency');
const { recordMutation } = require('./audit');
const { publicRouter, protectedRouter } = require('./routes/meta');
const articlesRouter = require('./routes/articles');
const categoriesRouter = require('./routes/categories');
const seoPagesRouter = require('./routes/seoPages');
const redirectsRouter = require('./routes/redirects');
const contactsRouter = require('./routes/contacts');
const mediaRouter = require('./routes/media');

const DEFAULT_BODY_LIMIT = '2mb';
const DEFAULT_MEDIA_BODY_LIMIT = '8mb';

function agentDisabled() {
  const value = String(process.env.AGENT_API_ENABLED || '').trim().toLowerCase();
  return value === '0' || value === 'false';
}

// One parser per limit, selected by path after auth. Non-JSON content types
// (multipart uploads) are skipped by express.json and reach multer untouched.
function createBodyParsers() {
  const jsonDefault = express.json({
    limit: process.env.AGENT_BODY_LIMIT || DEFAULT_BODY_LIMIT,
  });
  const jsonMedia = express.json({
    limit: process.env.AGENT_MEDIA_BODY_LIMIT || DEFAULT_MEDIA_BODY_LIMIT,
  });

  return (req, res, next) => {
    const requestPath = req.path || '';
    const isMedia = requestPath === '/media' || requestPath.startsWith('/media/');
    return (isMedia ? jsonMedia : jsonDefault)(req, res, next);
  };
}

function createAgentRouter() {
  const router = express.Router();

  // 0. Cache policy. Agent responses carry contact PII, scoped data and
  //    per-key rate-limit state, so no cache (browser, proxy or CDN) may store
  //    them — including errors and the kill-switch response.
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // 1. Kill switch. Still attach a request id so the envelope stays consistent.
  router.use((req, res, next) => {
    if (agentDisabled()) {
      attachRequestId(req, res);
      return sendError(req, res, new AgentError(
        'SERVICE_UNAVAILABLE',
        'The Agent API is currently disabled'
      ));
    }
    return next();
  });

  // 2. Request id (echo safe caller value, otherwise UUID).
  router.use((req, res, next) => {
    attachRequestId(req, res);
    req.agentStartedAt = Date.now();
    next();
  });

  // 3. Public endpoints. They are GET-only, so no body parsing is required
  //    before them; this keeps unauthenticated requests away from the parser.
  router.use(publicRouter);

  // 4. Authentication failure limiter (per IP, 401 responses only).
  const limiters = createRateLimiters();
  router.use(limiters.authFailure);

  // 5. API key auth.
  router.use(authenticateApiKey);

  // 6. Per-key read/write limiters.
  router.use(selectRateLimiter(limiters));

  // 7. Agent-specific JSON limits; independent from the legacy 100kb parser.
  //    /media gets the larger base64 budget, everything else 2MB.
  router.use(createBodyParsers());

  // 8. Idempotency for mutating protected requests (header is optional).
  //    Runs after JSON parsing because it hashes req.body.
  router.use(idempotencyMiddleware);

  // 9. Protected endpoints.
  router.use(protectedRouter);
  router.use('/articles', articlesRouter);
  router.use('/categories', categoriesRouter);
  router.use('/seo-pages', seoPagesRouter);
  router.use('/redirects', redirectsRouter);
  router.use('/contacts', contactsRouter);
  router.use('/media', mediaRouter);

  // 10. Agent-shaped 404 for unknown paths under the mount point.
  router.use((req, res) => sendError(req, res, new AgentError('NOT_FOUND', 'Agent API route not found')));

  // 11. Agent-shaped error handler. Stacks stay server-side only.
  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const normalized = normalizeAgentError(err);

    // Failed mutations are audited here; successful routes set auditRecorded
    // after their own audit write so nothing is counted twice. Best effort:
    // never await the write before sending the error response.
    if (!req.auditRecorded && req.apiKey && !['GET', 'HEAD'].includes(String(req.method || '').toUpperCase())) {
      req.auditRecorded = true;
      const context = req.auditContext || {};
      Promise.resolve(recordMutation(req, {
        resource_type: context.resource_type || null,
        resource_id: context.resource_id === undefined ? null : context.resource_id,
        status_code: normalized.status,
      })).catch(() => {});
    }

    if (normalized.code === 'INTERNAL_ERROR') {
      console.error(`Agent API error: ${req.method} ${req.originalUrl}`, err && err.stack ? err.stack : err);
    }
    return sendError(req, res, normalized);
  });

  return router;
}

module.exports = createAgentRouter;
module.exports.createAgentRouter = createAgentRouter;
module.exports.agentDisabled = agentDisabled;
