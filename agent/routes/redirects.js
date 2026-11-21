// backend/agent/routes/redirects.js
//
// Phase 2B redirect CRUD for /api/agent/v1/redirects. services/redirects.js
// already implements patch semantics for update(), so PATCH reuses it.
//
// Preserved contract: duplicate from_path 409, self-loop 400, a from_path that
// shadows a live page route 400, and the revalidate webhook on every mutation.

const express = require('express');
const { sendSuccess } = require('../envelope');
const { AgentError } = require('../errors');
const { requireScope } = require('../scopes');
const { recordMutation } = require('../audit');
const confirmDelete = require('../confirmDelete');
const { parseId } = require('../../utils/validate');
const { httpError } = require('../../services/errors');
const redirects = require('../../services/redirects');

const router = express.Router();

const SCOPE_READ = 'redirects:read';
const SCOPE_WRITE = 'redirects:write';
const SCOPE_DELETE = 'redirects:delete';

function parseRedirectId(raw) {
  const id = parseId(raw);
  if (id === null) {
    throw new AgentError('VALIDATION_ERROR', 'Redirect id must be a positive integer');
  }
  return id;
}

async function auditSuccess(req, { resourceId, statusCode }) {
  req.auditRecorded = true;
  await recordMutation(req, {
    resource_type: 'redirect',
    resource_id: resourceId === undefined ? null : resourceId,
    status_code: statusCode,
  });
}

function setAuditContext(req, resourceId) {
  req.auditContext = {
    resource_type: 'redirect',
    resource_id: resourceId === undefined ? null : resourceId,
  };
}

// GET /redirects — full map, ordered by id.
router.get('/', requireScope(SCOPE_READ), async (req, res, next) => {
  try {
    setAuditContext(req);
    const items = await redirects.list();
    sendSuccess(req, res, { items });
  } catch (error) {
    next(error);
  }
});

// GET /redirects/:id
router.get('/:id', requireScope(SCOPE_READ), async (req, res, next) => {
  try {
    const id = parseRedirectId(req.params.id);
    setAuditContext(req, id);
    const redirect = await redirects.get(id);
    if (!redirect) throw httpError(404, { message: 'Redirect not found' });
    sendSuccess(req, res, redirect);
  } catch (error) {
    next(error);
  }
});

// POST /redirects — 201 with the created row.
router.post('/', requireScope(SCOPE_WRITE), async (req, res, next) => {
  try {
    setAuditContext(req);
    const redirect = await redirects.create(req.body || {});
    await auditSuccess(req, { resourceId: redirect.id, statusCode: 201 });
    res.status(201);
    sendSuccess(req, res, redirect);
  } catch (error) {
    next(error);
  }
});

// PATCH /redirects/:id — partial update; the service re-checks the merged row.
router.patch('/:id', requireScope(SCOPE_WRITE), async (req, res, next) => {
  try {
    const id = parseRedirectId(req.params.id);
    setAuditContext(req, id);
    const redirect = await redirects.update(id, req.body || {});
    await auditSuccess(req, { resourceId: id, statusCode: 200 });
    sendSuccess(req, res, redirect);
  } catch (error) {
    next(error);
  }
});

// DELETE /redirects/:id — delete scope plus X-Confirm-Delete.
router.delete(
  '/:id',
  requireScope(SCOPE_DELETE),
  confirmDelete,
  async (req, res, next) => {
    try {
      const id = parseRedirectId(req.params.id);
      setAuditContext(req, id);
      await redirects.remove(id);
      await auditSuccess(req, { resourceId: id, statusCode: 200 });
      sendSuccess(req, res, { id, deleted: true });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
module.exports.parseRedirectId = parseRedirectId;
