// backend/agent/routes/contacts.js
//
// Phase 3 contact inbox CRUD for /api/agent/v1/contacts. The public
// POST /api/contact route is unchanged: this router reuses the same service
// create() so the row is stored before mail is attempted, but always answers
// 201 with the delivery status instead of the legacy 201/502 split.
//
// PATCH is intentionally narrow: only is_read may change. Unknown fields are a
// validation error so an agent cannot silently rewrite a stored message.

const express = require('express');
const { sendSuccess } = require('../envelope');
const { AgentError } = require('../errors');
const { requireScope } = require('../scopes');
const { recordMutation } = require('../audit');
const confirmDelete = require('../confirmDelete');
const { parseId } = require('../../utils/validate');
const { httpError } = require('../../services/errors');
const contacts = require('../../services/contacts');

const router = express.Router();

const SCOPE_READ = 'contacts:read';
const SCOPE_WRITE = 'contacts:write';
const SCOPE_DELETE = 'contacts:delete';

function parseContactId(raw) {
  const id = parseId(raw);
  if (id === null) {
    throw new AgentError('VALIDATION_ERROR', 'Contact id must be a positive integer');
  }
  return id;
}

function bodyObject(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

async function auditSuccess(req, { resourceId, statusCode }) {
  req.auditRecorded = true;
  await recordMutation(req, {
    resource_type: 'contact',
    resource_id: resourceId === undefined ? null : resourceId,
    status_code: statusCode,
  });
}

function setAuditContext(req, resourceId) {
  req.auditContext = {
    resource_type: 'contact',
    resource_id: resourceId === undefined ? null : resourceId,
  };
}

// GET /contacts — page/per_page (max 100) plus optional unread=true.
router.get('/', requireScope(SCOPE_READ), async (req, res, next) => {
  try {
    setAuditContext(req);
    const result = await contacts.listPage({
      page: req.query.page,
      per_page: req.query.per_page,
      unread: req.query.unread,
    });
    sendSuccess(req, res, { items: result.items }, {
      total: result.total,
      unread: result.unread,
      page: result.page,
      per_page: result.per_page,
      total_pages: result.total_pages,
    });
  } catch (error) {
    next(error);
  }
});

// GET /contacts/:id — 400 invalid id, 404 missing.
router.get('/:id', requireScope(SCOPE_READ), async (req, res, next) => {
  try {
    const id = parseContactId(req.params.id);
    setAuditContext(req, id);
    const contact = await contacts.get(id);
    if (!contact) throw httpError(404, { message: 'Contact not found' });
    sendSuccess(req, res, contact);
  } catch (error) {
    next(error);
  }
});

// POST /contacts — store + attempt mail, always 201. The response carries the
// delivery status; when mail did not leave the owner still has the row and the
// agent gets `fallback: "whatsapp"`.
router.post('/', requireScope(SCOPE_WRITE), async (req, res, next) => {
  try {
    setAuditContext(req);
    const result = await contacts.create(bodyObject(req.body));
    const data = {
      id: result.contactId,
      email_sent: Boolean(result.emailSent),
    };
    if (!result.emailSent) data.fallback = 'whatsapp';

    await auditSuccess(req, { resourceId: result.contactId, statusCode: 201 });
    res.status(201);
    sendSuccess(req, res, data);
  } catch (error) {
    next(error);
  }
});

// PATCH /contacts/:id — only { is_read } is accepted.
router.patch('/:id', requireScope(SCOPE_WRITE), async (req, res, next) => {
  try {
    const id = parseContactId(req.params.id);
    setAuditContext(req, id);

    const body = bodyObject(req.body);
    const keys = Object.keys(body);
    const unknown = keys.filter((key) => key !== 'is_read');
    if (unknown.length > 0) {
      throw new AgentError(
        'VALIDATION_ERROR',
        `Unknown field(s): ${unknown.join(', ')}. Only is_read may be updated.`,
        { details: unknown.map((key) => ({ message: `${key} is not allowed` })) }
      );
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'is_read')) {
      throw new AgentError('VALIDATION_ERROR', 'is_read is required');
    }

    const updated = await contacts.setRead(id, body.is_read);
    await auditSuccess(req, { resourceId: id, statusCode: 200 });
    sendSuccess(req, res, updated);
  } catch (error) {
    next(error);
  }
});

// DELETE /contacts/:id — delete scope plus X-Confirm-Delete. Hard delete.
router.delete(
  '/:id',
  requireScope(SCOPE_DELETE),
  confirmDelete,
  async (req, res, next) => {
    try {
      const id = parseContactId(req.params.id);
      setAuditContext(req, id);
      await contacts.remove(id);
      await auditSuccess(req, { resourceId: id, statusCode: 200 });
      sendSuccess(req, res, { id, deleted: true });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
module.exports.parseContactId = parseContactId;
