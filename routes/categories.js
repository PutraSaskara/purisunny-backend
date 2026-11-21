const express = require('express');
const router = express.Router();
const { authenticateJWT, requireRole, ROLE_ADMIN } = require('../middleware/auth');
const { parseId } = require('../utils/validate');
const categories = require('../services/categories');
const { isHttpError } = require('../services/errors');

// GET /api/categories — public
router.get('/', async (req, res) => {
  try {
    res.json(await categories.list());
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/categories/:id — public, single category
router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ message: 'Category id must be a positive integer' });
  }

  try {
    const category = await categories.get(id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }
    res.json(category);
  } catch (error) {
    console.error('Get category error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/categories — admin only (shared taxonomy; see role matrix in
// middleware/auth.js)
router.post('/', authenticateJWT, requireRole(ROLE_ADMIN), async (req, res) => {
  try {
    const data = await categories.create(req.body);
    // Keep the response shape the admin dashboard already consumes
    // (`result.data || result`) while adding the row it just created.
    res.status(201).json({
      id: data.id,
      message: 'Category created',
      data,
    });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Create category error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/categories/:id — admin only (renaming a slug breaks public URLs)
router.put('/:id', authenticateJWT, requireRole(ROLE_ADMIN), async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ message: 'Category id must be a positive integer' });
  }

  try {
    const data = await categories.update(id, req.body);
    res.json({ message: 'Category updated', data });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Update category error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/categories/:id — admin only
router.delete('/:id', authenticateJWT, requireRole(ROLE_ADMIN), async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ message: 'Category id must be a positive integer' });
  }

  try {
    await categories.remove(id);
    res.json({ message: 'Category deleted' });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Delete category error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
