// backend/services/redirects.js
//
// Business logic for the SEO redirect map. Express-free: routes authenticate
// and translate the errors thrown here.
//
// Row = { from_path -> to_path, status 301|302 }. Every successful mutation
// fires the revalidate webhook with { type: 'redirect' } so the frontend drops
// its `redirects` cache tag.

const realDb = require('../config/db');
const { isDuplicateEntry } = require('../utils/validate');
const { validateRedirect, validateRedirectPatch } = require('../utils/validateredirects');
const { triggerRedirectRevalidateSafe } = require('../utils/revalidate');
const { httpError } = require('./errors');

const REDIRECT_COLUMNS = 'id, from_path, to_path, status, created_at, updated_at';

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

async function fetchRedirect(id) {
  const [rows] = await db.query(`SELECT ${REDIRECT_COLUMNS} FROM redirects WHERE id = ?`, [id]);
  return rows[0] || null;
}

// GET /api/redirects — public. The frontend builds its lookup map from this
// list (from_path -> { to_path, status }), so it stays a plain array in
// `redirects`.
async function list() {
  const [rows] = await db.query(`SELECT ${REDIRECT_COLUMNS} FROM redirects ORDER BY id ASC`);
  return rows;
}

// GET /api/agent/v1/redirects/:id — returns the row or null (no throw), so the
// agent route owns the 404 envelope.
async function get(id) {
  return fetchRedirect(id);
}

// POST /api/redirects — admin only.
async function create(body = {}) {
  const { errors, values } = validateRedirect(body);
  if (errors.length > 0) {
    throw httpError(400, { message: errors[0], errors });
  }

  try {
    const [result] = await db.query(
      'INSERT INTO redirects (from_path, to_path, status) VALUES (?, ?, ?)',
      [values.from_path, values.to_path, values.status]
    );

    // Fire-and-forget: invalidate the frontend redirect map.
    triggerRedirectRevalidateSafe();

    return fetchRedirect(result.insertId);
  } catch (error) {
    if (isDuplicateEntry(error)) {
      throw httpError(409, {
        message: 'A redirect with this from_path already exists',
        errors: ['from_path must be unique'],
      });
    }
    throw error;
  }
}

// PUT /api/redirects/:id — admin only. Partial update: only supplied fields
// change. `from_path === to_path` is re-checked against the merged row so a
// patch that would create a self-loop is refused even when it touches one field.
async function update(id, body = {}) {
  const patch = validateRedirectPatch(body);
  if (patch.errors.length > 0) {
    throw httpError(400, { message: patch.errors[0], errors: patch.errors });
  }

  try {
    const current = await fetchRedirect(id);
    if (!current) {
      throw httpError(404, { message: 'Redirect not found' });
    }

    const next = {
      from_path: patch.values.from_path !== undefined ? patch.values.from_path : current.from_path,
      to_path: patch.values.to_path !== undefined ? patch.values.to_path : current.to_path,
      status: patch.values.status !== undefined ? patch.values.status : current.status,
    };

    if (next.from_path === next.to_path) {
      const errors = ['from_path and to_path must be different'];
      throw httpError(400, { message: errors[0], errors });
    }

    await db.query(
      'UPDATE redirects SET from_path = ?, to_path = ?, status = ? WHERE id = ?',
      [next.from_path, next.to_path, next.status, id]
    );

    triggerRedirectRevalidateSafe();

    const redirect = await fetchRedirect(id);
    if (!redirect) {
      // Deleted concurrently between the UPDATE and the re-read.
      throw httpError(404, { message: 'Redirect not found' });
    }
    return redirect;
  } catch (error) {
    if (isDuplicateEntry(error)) {
      throw httpError(409, {
        message: 'A redirect with this from_path already exists',
        errors: ['from_path must be unique'],
      });
    }
    throw error;
  }
}

// DELETE /api/redirects/:id — admin only.
async function remove(id) {
  const [result] = await db.query('DELETE FROM redirects WHERE id = ?', [id]);
  if (result.affectedRows === 0) {
    throw httpError(404, { message: 'Redirect not found' });
  }

  triggerRedirectRevalidateSafe();

  return { id };
}

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  __setDbForTests,
};
