// backend/agent/routes/meta.js
//
// Public meta endpoints plus the authenticated /me identity endpoint.

const express = require('express');
const { sendSuccess } = require('../envelope');
const { VERSION, buildManifest, rateLimitSummary } = require('../registry');
const { buildOpenApi } = require('../openapi');

const publicRouter = express.Router();
const protectedRouter = express.Router();

publicRouter.get('/health', (req, res) => {
  sendSuccess(req, res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: VERSION,
  });
});

publicRouter.get('/manifest', (req, res) => {
  sendSuccess(req, res, buildManifest());
});

// Raw OpenAPI 3.1 document. It is deliberately NOT wrapped in the agent
// success envelope so n8n/Hermes/OpenClaw can import the URL directly. The
// X-Request-Id header is still attached by the request-id middleware.
publicRouter.get('/openapi.json', (req, res) => {
  res.json(buildOpenApi());
});

protectedRouter.get('/me', (req, res) => {
  const key = req.apiKey;
  sendSuccess(req, res, {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    key: {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
    },
    user_id: key.userId,
    owner: {
      username: key.username,
      role: key.role,
    },
    scopes: key.scopes,
    expires_at: key.expiresAt,
    rate_limits: rateLimitSummary(),
  });
});

module.exports = { publicRouter, protectedRouter };
