// backend/agent/routes/categories.js
//
// Phase 2B category CRUD for /api/agent/v1. Mounted after API key auth, the
// per-key rate limiter and the shared idempotency middleware.
//
// The legacy PUT /api/categories/:id (full replace) is untouched; the agent
// surface uses PATCH with merge semantics.

const express = require('express');
const { sendSuccess } = require('../envelope');
const { AgentError } = require('../errors');
const { requireScope } = require('../scopes');
const { recordMutation } = require('../audit');
const confirmDelete = require('../confirmDelete');
const { parseId } = require('../../utils/validate');
const { httpError } = require('../../services/errors');
const categories = require('../../services/categories');

const router = express.Router();

const SCOPE_READ = 'categories:read';
const SCOPE_WRITE = 'categories:write';
const SCOPE_DELETE = 'categories:delete';

function parseCategoryId(raw) {
  const id = parseId(raw);
  if (id === null) {
    throw new AgentError('VALIDATION_ERROR', 'Category id must be a positive integer');
  }
  return id;
}

async function auditSuccess(req, { resourceId, statusCode }) {
  req.auditRecorded = true;
  await recordMutation(req, {
    resource_type: 'category',
    resource_id: resourceId === undefined ? null : resourceId,
    status_code: statusCode,
  });
}

function setAuditContext(req, resourceId) {
  req.auditContext = {
    resource_type: 'category',
    resource_id: resourceId === undefined ? null : resourceId,
  };
}

// GET /categories — every category, ordered by name (service order).
router.get('/', requireScope(SCOPE_READ), async (req, res, next) => {
  try {
    setAuditContext(req);
    const items = await categories.list();
    sendSuccess(req, res, { items });
  } catch (error) {
    next(error);
  }
});

// GET /categories/:id
router.get('/:id', requireScope(SCOPE_READ), async (req, res, next) => {
  try {
    const id = parseCategoryId(req.params.id);
    setAuditContext(req, id);
    const category = await categories.get(id);
    if (!category) throw httpError(404, { message: 'Category not found' });
    sendSuccess(req, res, category);
  } catch (error) {
    next(error);
  }
});

// POST /categories — 201 with the created category.
router.post('/', requireScope(SCOPE_WRITE), async (req, res, next) => {
  try {
    setAuditContext(req);
    const created = await categories.create(req.body || {});
    const category = await categories.get(created.id);
    await auditSuccess(req, { resourceId: created.id, statusCode: 201 });
    res.status(201);
    sendSuccess(req, res, category || created);
  } catch (error) {
    next(error);
  }
});

// PATCH /categories/:id — partial merge; duplicate slug is 409.
router.patch('/:id', requireScope(SCOPE_WRITE), async (req, res, next) => {
  try {
    const id = parseCategoryId(req.params.id);
    setAuditContext(req, id);
    const updated = await categories.patch(id, req.body || {});
    await auditSuccess(req, { resourceId: id, statusCode: 200 });
    sendSuccess(req, res, updated);
  } catch (error) {
    next(error);
  }
});

// DELETE /categories/:id — delete scope plus X-Confirm-Delete. Referenced
// categories are still refused by the service with 409.
router.delete(
  '/:id',
  requireScope(SCOPE_DELETE),
  confirmDelete,
  async (req, res, next) => {
    try {
      const id = parseCategoryId(req.params.id);
      setAuditContext(req, id);
      await categories.remove(id);
      await auditSuccess(req, { resourceId: id, statusCode: 200 });
      sendSuccess(req, res, { id, deleted: true });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
module.exports.parseCategoryId = parseCategoryId;
