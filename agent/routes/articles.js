// backend/agent/routes/articles.js
//
// Phase 2A article CRUD for /api/agent/v1. Mounted after API key auth and the
// per-key rate limiter. The service layer remains the source of truth for SQL,
// validation, transactions, redirects, cleanup and revalidation.

const express = require('express');
const { sendSuccess } = require('../envelope');
const { AgentError } = require('../errors');
const { requireScope, hasScope } = require('../scopes');
const { sanitizeArticleContent } = require('../sanitize');
const { recordMutation } = require('../audit');
const { parseId } = require('../../utils/validate');
const { httpError } = require('../../services/errors');
const articles = require('../../services/articles');

const router = express.Router();

const ARTICLE_SCOPE_READ = 'articles:read';
const ARTICLE_SCOPE_WRITE = 'articles:write';
const ARTICLE_SCOPE_DELETE = 'articles:delete';
const ARTICLE_SCOPE_FEATURE = 'articles:feature';

function parseArticleId(raw) {
  const id = parseId(raw);
  if (id === null) {
    throw new AgentError('VALIDATION_ERROR', 'Article id must be a positive integer');
  }
  return id;
}

function wantsFeatured(body) {
  const flag = body && body.is_featured;
  return flag === true || flag === 1 || flag === '1' || flag === 'true';
}

// Only an explicit `is_featured: true` needs the admin feature scope. Omitting
// the field on PATCH preserves the stored value and must never require it.
function requireFeatureScope(req, res, next) {
  if (!wantsFeatured(req.body || {})) return next();
  if (hasScope(req.apiKey && req.apiKey.scopes, ARTICLE_SCOPE_FEATURE)) return next();
  return next(new AgentError('FORBIDDEN', `Missing required scope: ${ARTICLE_SCOPE_FEATURE}`, {
    context: { required_scope: ARTICLE_SCOPE_FEATURE },
  }));
}

function sanitizedBody(req) {
  const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};
  const body = { ...input };
  if (Object.prototype.hasOwnProperty.call(body, 'content') && typeof body.content === 'string') {
    body.content = sanitizeArticleContent(body.content);
  }
  return body;
}

async function auditSuccess(req, { resourceId, statusCode }) {
  req.auditRecorded = true;
  await recordMutation(req, {
    resource_type: 'article',
    resource_id: resourceId === undefined ? null : resourceId,
    status_code: statusCode,
  });
}

function setAuditContext(req, resourceId) {
  req.auditContext = {
    resource_type: 'article',
    resource_id: resourceId === undefined ? null : resourceId,
  };
}

// GET /articles — default page=1, per_page=20 (service clamps to 50).
router.get('/', requireScope(ARTICLE_SCOPE_READ), async (req, res, next) => {
  try {
    setAuditContext(req);
    const query = {
      ...req.query,
      page: req.query.page === undefined ? 1 : req.query.page,
      per_page: req.query.per_page === undefined ? 20 : req.query.per_page,
    };
    const result = await articles.list(query);
    sendSuccess(req, res, { items: result.items }, {
      total: result.total,
      page: result.page,
      per_page: result.per_page,
      total_pages: result.total_pages,
    });
  } catch (error) {
    next(error);
  }
});

// GET /articles/by-slug/:slug — must stay before the /:id route.
router.get('/by-slug/:slug', requireScope(ARTICLE_SCOPE_READ), async (req, res, next) => {
  try {
    setAuditContext(req);
    const result = await articles.getBySlug(req.params.slug);
    if (!result) throw httpError(404, { message: 'Article not found' });
    sendSuccess(req, res, result);
  } catch (error) {
    next(error);
  }
});

// GET /articles/:id
router.get('/:id', requireScope(ARTICLE_SCOPE_READ), async (req, res, next) => {
  try {
    const id = parseArticleId(req.params.id);
    setAuditContext(req, id);
    const result = await articles.getById(id);
    sendSuccess(req, res, result);
  } catch (error) {
    next(error);
  }
});

// POST /articles — 201 with the created article.
router.post(
  '/',
  requireScope(ARTICLE_SCOPE_WRITE),
  requireFeatureScope,
  async (req, res, next) => {
    try {
      setAuditContext(req);
      const created = await articles.create(sanitizedBody(req));
      const result = await articles.getById(created.id);
      await auditSuccess(req, { resourceId: created.id, statusCode: 201 });
      res.status(201);
      sendSuccess(req, res, result);
    } catch (error) {
      next(error);
    }
  }
);

// POST /articles/validate — no write.
router.post(
  '/validate',
  requireScope(ARTICLE_SCOPE_WRITE),
  requireFeatureScope,
  async (req, res, next) => {
    try {
      setAuditContext(req);
      await articles.validate(sanitizedBody(req));
      sendSuccess(req, res, { valid: true });
    } catch (error) {
      next(error);
    }
  }
);

// POST /articles/upsert — by slug; 200 updated, 201 created.
router.post(
  '/upsert',
  requireScope(ARTICLE_SCOPE_WRITE),
  requireFeatureScope,
  async (req, res, next) => {
    try {
      const body = sanitizedBody(req);
      setAuditContext(req, body.slug);
      const result = await articles.upsert(body);
      const { article } = await articles.getById(result.id);
      const statusCode = result.created ? 201 : 200;
      await auditSuccess(req, { resourceId: result.id, statusCode });
      res.status(statusCode);
      sendSuccess(req, res, { created: result.created, article });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /articles/:id — partial update; returns the updated article.
router.patch('/:id', requireScope(ARTICLE_SCOPE_WRITE), requireFeatureScope, async (req, res, next) => {
  try {
    const id = parseArticleId(req.params.id);
    setAuditContext(req, id);
    const result = await articles.patch(id, sanitizedBody(req));
    await auditSuccess(req, { resourceId: id, statusCode: 200 });
    sendSuccess(req, res, result);
  } catch (error) {
    next(error);
  }
});

// DELETE /articles/:id — requires articles:delete plus an explicit confirmation
// header so an accidental destructive call cannot be replayed by a retry.
router.delete('/:id', requireScope(ARTICLE_SCOPE_DELETE), async (req, res, next) => {
  try {
    const id = parseArticleId(req.params.id);
    setAuditContext(req, id);

    const confirmation = req.headers['x-confirm-delete'];
    const confirmed = confirmation === true || confirmation === 1
      || confirmation === 'true' || confirmation === '1';
    if (!confirmed) {
      throw new AgentError(
        'CONFIRMATION_REQUIRED',
        'X-Confirm-Delete: true or 1 is required to delete an article',
        { context: { header: 'X-Confirm-Delete' } }
      );
    }

    const result = await articles.remove(id);
    await auditSuccess(req, { resourceId: id, statusCode: 200 });
    sendSuccess(req, res, { id, slug: result.slug, deleted: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.requireFeatureScope = requireFeatureScope;
module.exports.wantsFeatured = wantsFeatured;
