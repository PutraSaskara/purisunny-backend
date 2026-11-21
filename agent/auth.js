// backend/agent/auth.js
//
// Bearer API key authentication for /api/agent/v1. The key is looked up by its
// public prefix, then the SHA-256 hash is compared in constant time. Missing,
// invalid, inactive, revoked and expired keys all produce the same 401 body so
// an attacker cannot enumerate key state.

const apiKeys = require('../services/apiKeys');
const { AgentError } = require('./errors');
const { sendError } = require('./envelope');
const { isScopeAllowedForRole } = require('./scopes');

function extractBearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

async function authenticateApiKey(req, res, next) {
  try {
    const token = extractBearerToken(req.headers && req.headers.authorization);
    if (!token) {
      return sendError(req, res, new AgentError('UNAUTHORIZED'));
    }

    const verified = await apiKeys.verifyApiKey(token);
    if (!verified || !verified.apiKey) {
      return sendError(req, res, new AgentError('UNAUTHORIZED'));
    }

    const { apiKey } = verified;

    // Request-time role cap. A key created outside the service (or a key whose
    // owner was downgraded) cannot exercise scopes above its owner's tier.
    const denied = apiKey.scopes.filter((scope) => !isScopeAllowedForRole(scope, apiKey.role));
    if (denied.length > 0) {
      return sendError(req, res, new AgentError('FORBIDDEN', 'API key scopes exceed its owner role', {
        context: { denied_scopes: denied, role: apiKey.role },
      }));
    }

    req.apiKey = {
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      userId: apiKey.userId,
      username: apiKey.username,
      role: apiKey.role,
      scopes: apiKey.scopes,
      expiresAt: apiKey.expiresAt,
    };

    // Usage telemetry is intentionally fire-and-forget.
    apiKeys.touchLastUsed(apiKey.id);
    return next();
  } catch (error) {
    return next(error);
  }
}

// Test-only seam (same pattern as routes/auth.js). Delegates to the service so
// there is a single fake pool for the whole key lifecycle.
function __setDbForTests(fake) {
  apiKeys.__setDbForTests(fake);
}

module.exports = authenticateApiKey;
module.exports.authenticateApiKey = authenticateApiKey;
module.exports.extractBearerToken = extractBearerToken;
module.exports.__setDbForTests = __setDbForTests;
