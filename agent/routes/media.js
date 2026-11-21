// backend/agent/routes/media.js
//
// Phase 3 media upload for /api/agent/v1/media. Two request modes share one
// upload implementation (services/media.js):
//
//   A. multipart/form-data, single field `image` (multer intake from
//      routes/upload.js — same 5MB cap and field rules as /api/upload).
//   B. application/json { filename, content_base64 }, where content_base64 may
//      carry an optional `data:image/<type>;base64,` prefix.
//
// Magic-byte validation always runs inside media.upload(), so the JSON path
// cannot bypass the raster-only allowlist. No list/read/delete in v1.

const path = require('path');
const express = require('express');
const { sendSuccess } = require('../envelope');
const { AgentError } = require('../errors');
const { requireScope } = require('../scopes');
const { recordMutation } = require('../audit');
const { acceptSingleImage } = require('../../routes/upload');
const { isHttpError } = require('../../services/errors');
const media = require('../../services/media');

const router = express.Router();

const SCOPE_WRITE = 'media:write';
const DATA_URL_PREFIX = /^data:image\/[A-Za-z0-9.+-]+;base64,/i;
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;

function validationError(message) {
  return new AgentError('VALIDATION_ERROR', message);
}

// Decode mode B into the same { originalname, buffer } shape multer produces.
// Extension and magic bytes are still checked by media.upload(); this helper
// only rejects inputs that cannot become a file at all.
function decodeBase64Image(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  const filename = typeof input.filename === 'string' ? input.filename.trim() : '';
  if (filename === '') {
    throw validationError('filename is required');
  }
  const ext = path.extname(filename).toLowerCase();
  if (!media.ALLOWED_EXTENSIONS.has(ext)) {
    throw validationError('Only JPEG, PNG, WebP, or GIF images are allowed');
  }

  const raw = input.content_base64;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw validationError('content_base64 is required');
  }

  const cleaned = raw.replace(DATA_URL_PREFIX, '').replace(/\s+/g, '');
  if (cleaned === '' || !BASE64_BODY.test(cleaned) || cleaned.length % 4 === 1) {
    throw validationError('content_base64 must be valid base64');
  }

  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length === 0) {
    throw validationError('content_base64 must be valid base64');
  }
  if (buffer.length > media.MAX_FILE_SIZE) {
    throw validationError(`Image must be ${media.MAX_FILE_SIZE / (1024 * 1024)}MB or smaller`);
  }

  return { originalname: filename, buffer };
}

// 502/503 are real upstream states, but the shared normalizer collapses 5xx
// httpErrors into 500. Preserve the status while keeping the agent envelope.
function mapUploadError(error) {
  if (isHttpError(error) && (Number(error.status) === 502 || Number(error.status) === 503)) {
    const message = error.body && typeof error.body.message === 'string'
      ? error.body.message
      : undefined;
    return new AgentError('SERVICE_UNAVAILABLE', message, { status: Number(error.status) });
  }
  return error;
}

async function auditSuccess(req, { resourceId, statusCode }) {
  req.auditRecorded = true;
  await recordMutation(req, {
    resource_type: 'media',
    resource_id: resourceId === undefined ? null : resourceId,
    status_code: statusCode,
  });
}

function setAuditContext(req, resourceId) {
  req.auditContext = {
    resource_type: 'media',
    resource_id: resourceId === undefined ? null : resourceId,
  };
}

// POST /media — 201 with { url, path, public_id, width, height, format }.
router.post('/', requireScope(SCOPE_WRITE), acceptSingleImage, async (req, res, next) => {
  setAuditContext(req);
  try {
    const multipart = typeof req.is === 'function' && req.is('multipart/form-data');
    const file = multipart ? req.file : decodeBase64Image(req.body);
    const result = await media.upload(file);

    await auditSuccess(req, { resourceId: result.public_id, statusCode: 201 });
    res.status(201);
    sendSuccess(req, res, result);
  } catch (error) {
    next(mapUploadError(error));
  }
});

module.exports = router;
module.exports.decodeBase64Image = decodeBase64Image;
module.exports.mapUploadError = mapUploadError;
