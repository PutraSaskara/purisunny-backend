// backend/test/helpers/env.js
//
// Test environment bootstrap. MUST be required before any app module so that
// config/db.js and utils/revalidate.js see the test values on first load.
//
// - JWT secret: fixed, long enough for the server guard.
// - REVALIDATE_SECRET/FRONTEND_INTERNAL_URL: point at a black hole so the
//   fire-and-forget revalidate call cannot reach a real frontend.
// - Cloudinary: fake credentials + CLOUDINARY_FAKE_STUB=1 makes upload.js use
//   an in-process uploader instead of the network (see routes/upload.js).

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// Ensure config/loadEnv.js picks .env.test for the whole test process.
process.env.DOTENV_PROFILE = process.env.DOTENV_PROFILE || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'zz-test-jwt-secret-0123456789abcdefghijklmnop';
process.env.REVALIDATE_SECRET = process.env.REVALIDATE_SECRET || 'zz-test-revalidate-secret';
process.env.FRONTEND_INTERNAL_URL = 'http://127.0.0.1:9';

// Never talk to the real Cloudinary account from tests.
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'test-cloud';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || 'test-key';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'test-secret';
process.env.CLOUDINARY_FAKE_STUB = '1';

// Keep DB_* from backend/.env out of the way unless a test DB is configured.
// (When .env.test is present, config/loadEnv.js has already loaded it; this
// block only guards against a stale DB_NAME inherited from the shell.)

// Apply the documented test profile now. Without this call config/db.js only
// ever had backend/.env in scope, so "MySQL-free" HTTP suites silently
// connected to the developer's local MySQL (backend/.env DB_HOST) whenever it
// happened to be running. config/loadEnv resolves .env.test (or nothing at
// all, when absent) *before* any module locks in a pool configuration.
const path = require('path');
require(path.join(__dirname, '..', '..', 'config', 'loadEnv'))();
