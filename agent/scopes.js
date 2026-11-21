// backend/agent/scopes.js
//
// Explicit scope catalogue. Wildcards are never issued (and never accepted):
// a key receives exactly the scopes stored in api_keys.scopes.
//
// Role cap:
//   admin  -> every known scope
//   editor -> content authoring only (no destructive scopes, no media write)

const { AgentError } = require('./errors');
const { sendError } = require('./envelope');

const KNOWN_SCOPES = Object.freeze([
  'articles:read',
  'articles:write',
  'articles:feature',
  'articles:delete',
  'categories:read',
  'categories:write',
  'categories:delete',
  'seo:read',
  'seo:write',
  'seo:delete',
  'redirects:read',
  'redirects:write',
  'redirects:delete',
  'contacts:read',
  'contacts:write',
  'contacts:delete',
  'media:write',
]);

const EDITOR_SCOPES = Object.freeze([
  'articles:read',
  'articles:write',
  'categories:read',
  'seo:read',
  'seo:write',
  'redirects:read',
]);

const ROLE_CAPS = Object.freeze({
  admin: Object.freeze([...KNOWN_SCOPES]),
  editor: EDITOR_SCOPES,
});

const KNOWN_SCOPE_SET = new Set(KNOWN_SCOPES);

function normalizeRole(role) {
  return role === 'admin' ? 'admin' : 'editor';
}

function isKnownScope(scope) {
  return typeof scope === 'string' && KNOWN_SCOPE_SET.has(scope);
}

function isScopeAllowedForRole(scope, role) {
  const cap = ROLE_CAPS[normalizeRole(role)];
  return cap.includes(scope);
}

// Accept either a JSON string (the database representation) or an array.
// Returns [] when the value is absent/malformed so callers can decide whether
// that is an authentication failure or a validation error.
function parseScopes(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((scope) => typeof scope === 'string');
  }
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((scope) => typeof scope === 'string') : [];
  } catch {
    return [];
  }
}

function uniqueScopes(scopes) {
  const seen = new Set();
  const result = [];
  for (const scope of scopes) {
    const value = typeof scope === 'string' ? scope.trim() : '';
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

// Throws when a scope is unknown or not permitted for the owner's role.
// `context.role` lets the CLI print a useful message without leaking anything.
function assertScopesAllowed(scopes, role) {
  const normalizedRole = normalizeRole(role);
  const list = uniqueScopes(Array.isArray(scopes) ? scopes : parseScopes(scopes));
  if (list.length === 0) {
    throw new AgentError('VALIDATION_ERROR', 'At least one scope is required');
  }

  const unknown = list.filter((scope) => !isKnownScope(scope));
  if (unknown.length > 0) {
    throw new AgentError('VALIDATION_ERROR', `Unknown scope(s): ${unknown.join(', ')}`, {
      context: { unknown_scopes: unknown },
    });
  }

  const cap = ROLE_CAPS[normalizedRole];
  const denied = list.filter((scope) => !cap.includes(scope));
  if (denied.length > 0) {
    throw new AgentError('FORBIDDEN', `Scope(s) not allowed for role ${normalizedRole}: ${denied.join(', ')}`, {
      context: { role: normalizedRole, denied_scopes: denied },
    });
  }
  return list;
}

function hasScope(grantedScopes, requiredScope) {
  if (!Array.isArray(grantedScopes) || typeof requiredScope !== 'string') return false;
  return grantedScopes.includes(requiredScope);
}

function requireScope(scope) {
  return (req, res, next) => {
    if (!req.apiKey) {
      return sendError(req, res, new AgentError('UNAUTHORIZED'));
    }
    if (!hasScope(req.apiKey.scopes, scope)) {
      return sendError(req, res, new AgentError('FORBIDDEN', `Missing required scope: ${scope}`, {
        context: { required_scope: scope },
      }));
    }
    next();
  };
}

module.exports = {
  KNOWN_SCOPES,
  EDITOR_SCOPES,
  ROLE_CAPS,
  normalizeRole,
  isKnownScope,
  isScopeAllowedForRole,
  parseScopes,
  uniqueScopes,
  assertScopesAllowed,
  hasScope,
  scopeMatches: hasScope,
  requireScope,
};
