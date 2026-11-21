const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateJWT, requireRole, ROLE_ADMIN } = require('../middleware/auth');
const media = require('../services/media');
const { isHttpError } = require('../services/errors');

// ---------------------------------------------------------------------------
// Upload intake: multer memory storage only (no files written to disk).
// ---------------------------------------------------------------------------
const MAX_FILE_SIZE = media.MAX_FILE_SIZE;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

function reject(message) {
  const error = new Error(message);
  error.status = 400;
  error.expose = true;
  return error;
}

// Wraps multer so its errors reach our handler with explicit status codes
// (relying on the global handler alone would turn LIMIT_FILE_SIZE into a 500).
function acceptSingleImage(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(reject(`Image must be ${MAX_FILE_SIZE / (1024 * 1024)}MB or smaller`));
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(reject('Only a single image file (field name "image") is allowed'));
    }
    return next(reject('Invalid upload request'));
  });
}

// POST /api/upload — admin only
// Uploads write to the shared Cloudinary account (and consume its quota), so
// this is infrastructure-level access rather than content authoring.
router.post('/', authenticateJWT, requireRole(ROLE_ADMIN), acceptSingleImage, async (req, res, next) => {
  try {
    const data = await media.upload(req.file);
    res.json(data);
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    next(error);
  }
});

module.exports = router;
// Additive exports for the Agent API media route. Legacy /api/upload consumers
// keep using the router export unchanged.
module.exports.acceptSingleImage = acceptSingleImage;
module.exports.MAX_FILE_SIZE = MAX_FILE_SIZE;
