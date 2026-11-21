const jwt = require('jsonwebtoken');

// Algorithm is pinned to HS256 on purpose: without an explicit `algorithms`
// list, jsonwebtoken accepts any algorithm the token header asks for, which
// widens the attack surface (e.g. algorithm-confusion attempts). The signing
// side (routes/auth.js) must use the same algorithm.
const JWT_ALGORITHM = 'HS256';

// Role model (audit P3-5 / P3-7)
// ------------------------------
// The product is effectively two tiers:
//   admin  — full access, including destructive operations (deleting articles,
//            categories and SEO pages) and shared-infrastructure writes (uploads
//            to the Cloudinary account).
//   editor — content authoring: create/update articles, categories and SEO
//            metadata. Cannot delete anything and cannot upload.
// Users with an unknown/absent role (legacy tokens) fall back to the least
// privileged tier: `editor`. Only an explicit `admin` unlock destructive routes.

const ROLE_ADMIN = 'admin';
const ROLE_EDITOR = 'editor';
const KNOWN_ROLES = Object.freeze([ROLE_ADMIN, ROLE_EDITOR]);

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: 'Forbidden: Invalid token' });
  }
};

// Normalise a JWT's `role` claim to a known role. Anything else (missing,
// wrong case, unknown string, injected object) becomes `editor` — the least
// privileged known role — so a malformed token can never widen access.
function normalizeRole(rawRole) {
  if (typeof rawRole !== 'string') return ROLE_EDITOR;
  const role = rawRole.trim().toLowerCase();
  return KNOWN_ROLES.includes(role) ? role : ROLE_EDITOR;
}

// Authorization guard. MUST run after authenticateJWT (it reads req.user).
//   router.delete('/:id', authenticateJWT, requireRole(ROLE_ADMIN), handler)
//
// Returns 403 with a stable, generic body. The rejected role is included
// because it is not secret (the caller already knows their own token) and the
// admin dashboard uses it to explain why an action was refused.
function requireRole(...roles) {
  const allowed = roles.flat().map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) {
    throw new Error('requireRole() needs at least one role');
  }

  return (req, res, next) => {
    if (!req.user) {
      // Programming error: authenticateJWT was not applied first.
      return res.status(401).json({ message: 'Unauthorized: No token provided' });
    }
    const role = normalizeRole(req.user.role);
    if (!allowed.includes(role)) {
      return res.status(403).json({
        message: 'Forbidden: your role does not allow this action',
        required_roles: allowed,
        role,
      });
    }
    next();
  };
}

module.exports = authenticateJWT;
module.exports.authenticateJWT = authenticateJWT;
module.exports.requireRole = requireRole;
module.exports.normalizeRole = normalizeRole;
module.exports.JWT_ALGORITHM = JWT_ALGORITHM;
module.exports.ROLE_ADMIN = ROLE_ADMIN;
module.exports.ROLE_EDITOR = ROLE_EDITOR;
