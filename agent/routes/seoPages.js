// backend/agent/routes/seoPages.js
//
// Phase 2B SEO page CRUD for /api/agent/v1/seo-pages. The 18 page keys are a
// fixed set owned by services/seo.js; upsert (PUT) is the create path, so no
// POST route exists.
//
// Page keys contain a colon (page:home, room:deluxe-room). Express matches
// `page:home` directly and also accepts `page%3Ahome`; clients that build URLs
// from a template should URL-encode the key.

const express = require('express');
const { sendSuccess } = require('../envelope');
const { requireScope } = require('../scopes');
const { recordMutation } = require('../audit');
const confirmDelete = require('../confirmDelete');
const { httpError } = require('../../services/errors');
const seo = require('../../services/seo');

const router = express.Router();

const SCOPE_READ = 'seo:read';
const SCOPE_WRITE = 'seo:write';
const SCOPE_DELETE = 'seo:delete';

function assertValidPageKey(pageKey) {
  if (!seo.VALID_PAGE_KEYS.includes(pageKey)) {
    throw seo.invalidPageKey(pageKey);
  }
}

async function auditSuccess(req, { resourceId, statusCode }) {
  req.auditRecorded = true;
  await recordMutation(req, {
    resource_type: 'seo_page',
    resource_id: resourceId === undefined ? null : resourceId,
    status_code: statusCode,
  });
}

function setAuditContext(req, resourceId) {
  req.auditContext = {
    resource_type: 'seo_page',
    resource_id: resourceId === undefined ? null : resourceId,
  };
}

// GET /seo-pages — all 18 official keys, including unset defaults.
router.get('/', requireScope(SCOPE_READ), async (req, res, next) => {
  try {
    setAuditContext(req);
    const result = await seo.list();
    sendSuccess(req, res, { items: result.pages });
  } catch (error) {
    next(error);
  }
});

// GET /seo-pages/:pageKey — invalid keys answer 400 with the official list.
router.get('/:pageKey', requireScope(SCOPE_READ), async (req, res, next) => {
  try {
    const pageKey = req.params.pageKey;
    assertValidPageKey(pageKey);
    setAuditContext(req, pageKey);
    const page = await seo.get(pageKey);
    if (!page) throw httpError(404, { message: 'Page not found' });
    sendSuccess(req, res, page);
  } catch (error) {
    next(error);
  }
});

// PUT /seo-pages/:pageKey — upsert page_seo and replace its faqs.
router.put('/:pageKey', requireScope(SCOPE_WRITE), async (req, res, next) => {
  try {
    const pageKey = req.params.pageKey;
    setAuditContext(req, pageKey);
    const page = await seo.upsert(pageKey, req.body || {});
    await auditSuccess(req, { resourceId: pageKey, statusCode: 200 });
    sendSuccess(req, res, page);
  } catch (error) {
    next(error);
  }
});

// DELETE /seo-pages/:pageKey — delete scope plus X-Confirm-Delete.
router.delete(
  '/:pageKey',
  requireScope(SCOPE_DELETE),
  confirmDelete,
  async (req, res, next) => {
    try {
      const pageKey = req.params.pageKey;
      setAuditContext(req, pageKey);
      await seo.remove(pageKey);
      await auditSuccess(req, { resourceId: pageKey, statusCode: 200 });
      sendSuccess(req, res, { page_key: pageKey, deleted: true });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
module.exports.assertValidPageKey = assertValidPageKey;
