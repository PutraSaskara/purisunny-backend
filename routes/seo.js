// backend/routes/seo.js
// SEO Dashboard API — 18 page keys for Puri Sunny.
//
// GET    /api/seo          — public, list all pages (with faqs)
// GET    /api/seo/:pageKey — public, single page + faqs (404 if none)
// PUT    /api/seo/:pageKey — authenticated (admin + editor, content authoring), upsert page_seo + replace faqs
// DELETE /api/seo/:pageKey — admin only (destructive), delete page + its faqs

const express = require('express');
const router = express.Router();
const { authenticateJWT, requireRole, ROLE_ADMIN } = require('../middleware/auth');
const seo = require('../services/seo');
const { isHttpError } = require('../services/errors');

// ─────────────────────────────────────────────────────
//  GET /api/seo — public, list ALL 18 pages (with faqs)
// ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    res.json(await seo.list());
  } catch (error) {
    console.error('Get all page SEO error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────
//  GET /api/seo/:pageKey — public, single page + faqs
// ─────────────────────────────────────────────────────
router.get('/:pageKey', async (req, res) => {
  try {
    const data = await seo.get(req.params.pageKey);
    if (!data) {
      return res.status(404).json({ message: 'Page not found' });
    }
    res.json(data);
  } catch (error) {
    console.error('Get page SEO error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────
//  PUT /api/seo/:pageKey — admin, UPSERT page + replace faqs
// ─────────────────────────────────────────────────────
router.put('/:pageKey', authenticateJWT, async (req, res) => {
  try {
    const data = await seo.upsert(req.params.pageKey, req.body);
    res.json({ message: 'Page SEO updated', data });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Upsert page SEO error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────
//  DELETE /api/seo/:pageKey — admin only, delete page + faqs
// ─────────────────────────────────────────────────────
router.delete('/:pageKey', authenticateJWT, requireRole(ROLE_ADMIN), async (req, res) => {
  try {
    await seo.remove(req.params.pageKey);
    res.json({ message: 'Page SEO deleted' });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Delete page SEO error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
