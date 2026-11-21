// backend/services/categories.js
//
// Business logic for /api/categories. Express-free: routes authenticate and
// translate the errors thrown here into responses.

const realDb = require('../config/db');
const {
  isDuplicateEntry,
  isRowReferenced,
  optionalString,
  requiredString,
  validateSlug,
} = require('../utils/validate');
const { httpError } = require('./errors');

// categories.name VARCHAR(100), categories.slug VARCHAR(100).
const MAX_NAME_LENGTH = 100;
const MAX_SLUG_LENGTH = 100;

let db = realDb;

function __setDbForTests(fake) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setDbForTests is not available in production');
  }
  if (fake === null || fake === undefined) {
    db = realDb;
    return;
  }
  if (typeof fake.query !== 'function') {
    throw new Error('db fake must expose query()');
  }
  db = fake;
}

// Validate name/slug/description. Returns { errors: string[], values }.
function validateCategoryFields(body) {
  const errors = [];
  const values = {};

  const name = requiredString(body.name, 'name', MAX_NAME_LENGTH);
  if (name.error) errors.push(name.error);
  else values.name = name.value;

  const slug = validateSlug(body.slug);
  if (slug.error) errors.push(slug.error);
  else if (slug.value.length > MAX_SLUG_LENGTH) {
    errors.push(`slug must be at most ${MAX_SLUG_LENGTH} characters`);
  } else {
    values.slug = slug.value;
  }

  const description = optionalString(body.description, 'description');
  if (description.error) errors.push(description.error);
  else values.description = description.value;

  return { errors, values };
}

// GET /api/categories — public
async function list() {
  const [rows] = await db.query('SELECT * FROM categories ORDER BY name ASC');
  return rows;
}

// GET /api/categories/:id — public, single category
async function get(id) {
  const [rows] = await db.query('SELECT * FROM categories WHERE id = ?', [id]);
  return rows[0] || null;
}

// POST /api/categories — admin only
async function create(body = {}) {
  const { errors, values } = validateCategoryFields(body);
  if (errors.length > 0) {
    throw httpError(400, { message: errors[0], errors });
  }

  try {
    const [result] = await db.query(
      'INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)',
      [values.name, values.slug, values.description]
    );

    return {
      id: result.insertId,
      name: values.name,
      slug: values.slug,
      description: values.description,
    };
  } catch (error) {
    if (isDuplicateEntry(error)) {
      throw httpError(409, {
        message: 'A category with this slug already exists',
        errors: ['slug must be unique'],
      });
    }
    throw error;
  }
}

// Partial validation for PATCH: only supplied fields are checked. Absent
// fields keep their stored value; an explicit `description: null` clears it.
function hasOwn(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function validateCategoryPatch(body) {
  const errors = [];
  const values = {};

  if (hasOwn(body, 'name')) {
    const name = requiredString(body.name, 'name', MAX_NAME_LENGTH);
    if (name.error) errors.push(name.error);
    else values.name = name.value;
  }

  if (hasOwn(body, 'slug')) {
    const slug = validateSlug(body.slug);
    if (slug.error) errors.push(slug.error);
    else if (slug.value.length > MAX_SLUG_LENGTH) {
      errors.push(`slug must be at most ${MAX_SLUG_LENGTH} characters`);
    } else {
      values.slug = slug.value;
    }
  }

  if (hasOwn(body, 'description') && body.description !== undefined) {
    const description = optionalString(body.description, 'description');
    if (description.error) errors.push(description.error);
    else values.description = description.value;
  }

  return { errors, values };
}

// PATCH /api/agent/v1/categories/:id — partial merge. A no-op body still
// answers 200 with the stored row; only a missing id is a 404.
async function patch(id, body = {}) {
  const { errors, values } = validateCategoryPatch(body);
  if (errors.length > 0) {
    throw httpError(400, { message: errors[0], errors });
  }

  const existing = await get(id);
  if (!existing) {
    throw httpError(404, { message: 'Category not found' });
  }

  const next = {
    name: values.name !== undefined ? values.name : existing.name,
    slug: values.slug !== undefined ? values.slug : existing.slug,
    description: values.description !== undefined ? values.description : existing.description,
  };

  try {
    await db.query(
      'UPDATE categories SET name = ?, slug = ?, description = ? WHERE id = ?',
      [next.name, next.slug, next.description, id]
    );

    return {
      id,
      name: next.name,
      slug: next.slug,
      description: next.description,
      created_at: existing.created_at === undefined ? null : existing.created_at,
    };
  } catch (error) {
    if (isDuplicateEntry(error)) {
      throw httpError(409, {
        message: 'A category with this slug already exists',
        errors: ['slug must be unique'],
      });
    }
    throw error;
  }
}

// PUT /api/categories/:id — admin only (renaming a slug breaks public URLs)
async function update(id, body = {}) {
  const { errors, values } = validateCategoryFields(body);
  if (errors.length > 0) {
    throw httpError(400, { message: errors[0], errors });
  }

  try {
    const [result] = await db.query(
      'UPDATE categories SET name = ?, slug = ?, description = ? WHERE id = ?',
      [values.name, values.slug, values.description, id]
    );

    if (result.affectedRows === 0) {
      throw httpError(404, { message: 'Category not found' });
    }

    return { id, ...values };
  } catch (error) {
    if (isDuplicateEntry(error)) {
      throw httpError(409, {
        message: 'A category with this slug already exists',
        errors: ['slug must be unique'],
      });
    }
    throw error;
  }
}

// DELETE /api/categories/:id — admin only
//
// Data-loss guard: articles.category_id is a nullable FK. Deleting a category
// that articles still reference would silently detach them, so it is refused
// with 409 and the reference count. The count is informational (the final say
// is the DELETE itself, which also catches concurrent inserts via the FK).
async function remove(id) {
  try {
    const [existing] = await db.query('SELECT id, name FROM categories WHERE id = ?', [id]);
    if (existing.length === 0) {
      throw httpError(404, { message: 'Category not found' });
    }

    const [[{ articleCount }]] = await db.query(
      'SELECT COUNT(*) AS articleCount FROM articles WHERE category_id = ?',
      [id]
    );

    if (articleCount > 0) {
      const label = articleCount === 1 ? 'article' : 'articles';
      throw httpError(409, {
        message: `Cannot delete category "${existing[0].name}": ${articleCount} ${label} still reference it. Reassign or delete those articles first.`,
        articleCount,
      });
    }

    const [result] = await db.query('DELETE FROM categories WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      // Deleted concurrently between the SELECT and the DELETE.
      throw httpError(404, { message: 'Category not found' });
    }

    return { id };
  } catch (error) {
    // Backstop for the race where an article referencing this category is
    // created between the count check and the DELETE.
    if (isRowReferenced(error)) {
      throw httpError(409, {
        message: 'Cannot delete category: articles still reference it. Reassign or delete those articles first.',
      });
    }
    throw error;
  }
}

module.exports = {
  list,
  get,
  create,
  update,
  patch,
  remove,
  __setDbForTests,
};
