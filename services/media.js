// backend/services/media.js
//
// Image upload business logic for POST /api/upload. Express-free: the route
// keeps the multer intake middleware and auth, and calls upload() with the
// parsed file.
//
// Cloudinary config is env-only. With CLOUDINARY_FAKE_STUB=1 the uploader
// resolves locally instead of calling the provider, so tests can exercise the
// full pipeline without network access or real credentials.

const path = require('path');
const { createRequire } = require('module');
const { Readable } = require('stream');
const cloudinary = require('cloudinary').v2;
const { CLEANUP_TAG } = require('../utils/cloudinaryCleanup');
const { httpError } = require('./errors');

// `file-type` is a pure ESM package. Requiring it through createRequire keeps
// this CommonJS module able to consume its named exports without a dynamic
// import inside the request handler.
const backendRequire = createRequire(__filename);

// ---------------------------------------------------------------------------
// Cloudinary configuration (env only — never hardcode credentials here)
// ---------------------------------------------------------------------------
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'purisunny';

const requiredEnv = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.warn(
    `[upload] Missing Cloudinary env vars: ${missingEnv.join(', ')}. ` +
    'POST /api/upload will respond 503 until they are set.'
  );
}

const cloudinaryReady = missingEnv.length === 0;
if (cloudinaryReady) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

// Test seam: with CLOUDINARY_FAKE_STUB=1 the uploader below resolves locally
// instead of calling the Cloudinary API, so the test suite can exercise the
// full upload pipeline (auth, multer, magic-byte validation) without network
// access or real credentials. Refused outright in production.
const CLOUDINARY_FAKE_STUB =
  process.env.CLOUDINARY_FAKE_STUB === '1' && process.env.NODE_ENV !== 'production';
if (CLOUDINARY_FAKE_STUB) {
  console.warn('[upload] CLOUDINARY_FAKE_STUB=1 — uploads resolve locally (tests only)');
}

// ---------------------------------------------------------------------------
// Upload intake: multer memory storage only (no files written to disk).
// ---------------------------------------------------------------------------
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB — unchanged from the previous local-disk uploader

// Extension allowlist. SVG is deliberately excluded: raster-only uploads mean
// stored XSS via inline SVG (Cloudinary can serve SVG as a document) is
// impossible. Extensions are a first-line filter; magic bytes below are the
// real check.
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

// Magic-byte allowlist: detected MIME -> expected extension(s)/format.
const ALLOWED_MIME_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

function reject(message) {
  return httpError(400, { message });
}

// Validates extension + real file content. Returns the canonical format
// (e.g. 'jpg') or throws a 400.
async function validateImage(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw reject('Only JPEG, PNG, WebP, or GIF images are allowed');
  }

  const { fileTypeFromBuffer } = await backendRequire('file-type');
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
    // Covers SVG, HTML, polyglots, scripts, and unrecognised content.
    throw reject('File content is not a supported image (JPEG, PNG, WebP, GIF)');
  }

  const format = ALLOWED_MIME_TYPES.get(detected.mime);
  // Extension and real content must agree (e.g. a PNG must not be named .gif).
  // .jpg and .jpeg are both valid names for JPEG content.
  const extMatchesFormat =
    format === 'jpg' ? (ext === '.jpg' || ext === '.jpeg') : ext === `.${format}`;
  if (!extMatchesFormat) {
    throw reject('File extension does not match its actual image content');
  }

  return format;
}

function uploadBufferToCloudinary(buffer, format) {
  if (CLOUDINARY_FAKE_STUB) {
    // Deterministic local result with the same shape as Cloudinary's.
    return Promise.resolve({
      secure_url: `https://res.cloudinary.com/test-cloud/image/upload/fake/test-image.${format}`,
      public_id: 'purisunny/fake/test-image',
      width: 8,
      height: 8,
      format,
      tags: [CLEANUP_TAG],
    });
  }

  return new Promise((resolve, rejectUpload) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: CLOUDINARY_FOLDER,
        resource_type: 'image',
        overwrite: false,
        // Marks the asset as ours; cleanup only ever deletes tagged assets.
        tags: [CLEANUP_TAG],
        // Belt-and-braces: refuse anything Cloudinary would treat as a non-image.
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
      },
      (error, result) => {
        if (error) return rejectUpload(error);
        resolve(result);
      }
    );
    Readable.from(buffer).pipe(stream);
  });
}

// POST /api/upload — admin only (auth is enforced by the route).
// Returns the existing response shape: { url, path, public_id, width, height, format }.
async function upload(file) {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw reject('No file uploaded');
  }
  if (!cloudinaryReady) {
    throw httpError(503, { message: 'Image uploads are not configured on this server' });
  }

  const format = await validateImage(file);

  let result;
  try {
    result = await uploadBufferToCloudinary(file.buffer, format);
  } catch (cloudErr) {
    // Log a short, secret-free diagnostic only (no provider message: Cloudinary
    // echoes signed request parameters in some error strings).
    console.error(
      `[upload] Cloudinary upload failed (http ${cloudErr && cloudErr.http_code ? cloudErr.http_code : 'unknown'})`
    );
    throw httpError(502, { message: 'Image upload service is temporarily unavailable' });
  }

  if (!result || !result.secure_url) {
    console.error('[upload] Cloudinary returned an unexpected response');
    throw httpError(502, { message: 'Image upload service is temporarily unavailable' });
  }

  // Response contract kept compatible with the admin dashboard
  // (it reads `url || path`) while adding the Cloudinary asset metadata.
  return {
    url: result.secure_url,
    path: result.secure_url,
    public_id: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format || format,
  };
}

module.exports = {
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS,
  upload,
};
