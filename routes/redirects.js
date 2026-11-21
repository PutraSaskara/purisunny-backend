// backend/routes/redirects.js
//
// SEO redirect map. Row = { from_path -> to_path, status 301|302 }.
// The frontend resolves a would-be 404 through GET /api/redirects.
//
// GET    /api/redirects      — public, { redirects: [...] } ordered by id
// POST   /api/redirects      — admin, { from_path, to_path, status? } -> 201 { redirect }
// PUT    /api/redirects/:id  — admin, partial body                  -> 200 { redirect }
// DELETE /api/redirects/:id  — admin                                 -> 200 { message }
//
// Statuses:
//   400  validation errors       { message, errors[] }
//   400  from_path shadows a live route / to_path points at /api|/_next
//   401/403  missing token / not admin (middleware/auth.js)
//   404  unknown id
//   409  duplicate from_path     { message, errors[] }
//   500  server error
//
// Every successful mutation fires the revalidate webhook with
// { type: 'redirect' } so the frontend drops its `redirects` cache tag.

const express = require('express');
const router = express.Router();
const { authenticateJWT, requireRole, ROLE_ADMIN } = require('../middleware/auth');
const { parseId } = require('../utils/validate');
const redirects = require('../services/redirects');
const { isHttpError } = require('../services/errors');

// GET /api/redirects — public. The frontend builds its lookup map from this
// list (from_path -> { to_path, status }), so it stays a plain array in `redirects`.
router.get('/', async (req, res) => {
  try {
    res.json({ redirects: await redirects.list() });
  } catch (error) {
    console.error('Get redirects error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/redirects — admin only.
router.post('/', authenticateJWT, requireRole(ROLE_ADMIN), async (req, res) => {
  try {
    const redirect = await redirects.create(req.body || {});
    res.status(201).json({ redirect });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Create redirect error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/redirects/:id — admin only. Partial update: only supplied fields
// change. `from_path === to_path` is re-checked against the merged row so a
// patch that would create a self-loop is refused even when it touches one field.
router.put('/:id', authenticateJWT, requireRole(ROLE_ADMIN), async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ message: 'Redirect id must be a positive integer' });
  }

  try {
    const redirect = await redirects.update(id, req.body || {});
    res.json({ redirect });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Update redirect error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/redirects/:id — admin only.
router.delete('/:id', authenticateJWT, requireRole(ROLE_ADMIN), async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ message: 'Redirect id must be a positive integer' });
  }

  try {
    await redirects.remove(id);
    res.json({ message: 'Redirect deleted' });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Delete redirect error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
