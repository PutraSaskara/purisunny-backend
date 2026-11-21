const express = require('express');
const router = express.Router();
const { authenticateJWT, requireRole, ROLE_ADMIN } = require('../middleware/auth');
const { parseId } = require('../utils/validate');
const articles = require('../services/articles');
const { isHttpError } = require('../services/errors');

// ---------------------------------------------------------------------------
// Feature-flag guard (audit P3-7)
// ---------------------------------------------------------------------------
// `is_featured` controls what is showcased on the public homepage, so toggling
// it is an admin decision rather than ordinary content authoring. Editors keep
// full create/update rights; they simply cannot set the flag.
//
//   - is_featured absent / 0 / "0" / false  -> allowed (no change of meaning)
//   - is_featured 1 / "1" / true            -> admin only (403 for editors)
//
// Applied after authenticateJWT. On a plain authenticated request without the
// flag nothing changes, so the existing contract for editors is untouched.
function maybeGuardFeatureFlag(req, res, next) {
  const body = req.body || {};
  const { is_featured: flag } = body;
  const wantsFeatured =
    flag === true || flag === 1 || flag === '1' || flag === 'true';

  if (!wantsFeatured) return next();
  return requireRole(ROLE_ADMIN)(req, res, next);
}

// GET /api/articles — public, with optional category filter and optional pagination.
// When query includes `page` or `per_page`, returns { items, total, page, per_page, total_pages }.
// Otherwise returns plain array (backward-compatible).
router.get('/', async (req, res) => {
  try {
    res.json(await articles.list(req.query));
  } catch (error) {
    console.error('Get articles error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/articles/:slug — public, single article (+ its FAQs, ordered)
router.get('/:slug', async (req, res) => {
  try {
    const data = await articles.getBySlug(req.params.slug);
    if (!data) {
      return res.status(404).json({ message: 'Article not found' });
    }
    res.json(data);
  } catch (error) {
    console.error('Get article error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/articles — any authenticated user; admin-only for feature flagging
router.post('/', authenticateJWT, maybeGuardFeatureFlag, async (req, res) => {
  try {
    const created = await articles.create(req.body);
    res.status(201).json({ id: created.id, message: 'Article created' });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Create article error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/articles/:id — any authenticated user; admin-only for feature flagging
router.put('/:id', authenticateJWT, maybeGuardFeatureFlag, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ message: 'Article id must be a positive integer' });
  }

  try {
    await articles.updateFull(id, req.body);
    res.json({ message: 'Article updated' });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Update article error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/articles/:id — admin only (destructive; audit P3-7)
router.delete('/:id', authenticateJWT, requireRole(ROLE_ADMIN), async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ message: 'Article id must be a positive integer' });
  }

  try {
    await articles.remove(id);
    res.json({ message: 'Article deleted' });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Delete article error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
