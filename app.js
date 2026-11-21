// backend/app.js
//
// Express application factory. server.js requires this and calls listen();
// tests require it directly so they exercise the exact production middleware
// stack (CORS, JSON limits, 404 catch-all, error handler) without binding a
// port or running the JWT startup guard.
//
// The JWT_SECRET fail-fast guard stays in server.js: it is a deployment
// concern. Tests set their own secret (see test/helpers/env.js).

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const routes = require('./routes');
const createAgentRouter = require('./agent');

function createApp({ uploadsDir } = {}) {
  const app = express();

  // Trust the first hop proxy only when deployed behind one (nginx / PaaS / CDN).
  // This is what makes express-rate-limit key on the real client IP instead of the
  // proxy's. It is opt-in (TRUST_PROXY=1) so a local/direct deployment cannot be
  // spoofed with a forged X-Forwarded-For header.
  if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  // CORS - parse CORS_ORIGIN into a valid array of origins
  // Prevents invalid multi-origin strings that browsers reject.
  const allowedOrigins = (process.env.CORS_ORIGIN || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.use(cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (server-to-server, curl, etc.)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, origin);
      }
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Confirm-Delete',
      'X-Request-Id',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'Idempotent-Replayed',
      'RateLimit',
      'RateLimit-Policy',
    ],
  }));

  // Agent API. Mounted BEFORE the global JSON parser so agent requests use
  // their own AGENT_BODY_LIMIT (default 2mb) instead of the legacy 100kb cap.
  // The router owns its 404 and error handler, so unknown agent paths never
  // fall through to the legacy `{ message, error }` shape.
  app.use('/api/agent/v1', createAgentRouter());

  // Body parsing. The API only consumes JSON; urlencoded parsing is dropped.
  app.use(express.json({ limit: '100kb' }));

  // Static files untuk uploads - legacy local files only (new uploads go to Cloudinary).
  // The directory is created if absent so old `/uploads/...` URLs keep resolving.
  const staticDir = uploadsDir || path.join(__dirname, 'uploads');
  if (!fs.existsSync(staticDir)) {
    fs.mkdirSync(staticDir, { recursive: true });
  }
  app.use('/uploads', express.static(staticDir));

  // API Routes
  app.use('/api', routes);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // 404 catch-all for any route not matched above (API or otherwise).
  // Must come AFTER all routers - the old behaviour fell through to Express's
  // default HTML "Cannot GET /..." page.
  app.use((req, res) => {
    res.status(404).json({
      message: 'Not found',
      error: `Route not found: ${req.method} ${req.originalUrl}`,
    });
  });

  // Error handling middleware (4 arguments - Express only treats it as the
  // error handler with this exact arity). Client bodies stay generic; the
  // diagnostic (method + URL + stack) is logged server-side only.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const context = `${req.method} ${req.originalUrl}`;

    // Malformed JSON body -> 400 (generic message, no parser internals)
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({ message: 'Invalid JSON body' });
    }
    // Errors marked exposable by routes (validation / upload limits) -> 400
    if (err.status === 400 && err.expose) {
      return res.status(400).json({ message: err.message });
    }
    // Any multer intake error that slipped past a route-level wrapper -> 400
    // rather than an opaque 500.
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Uploaded file is too large'
        : `Invalid upload request (${err.code})`;
      return res.status(400).json({ message });
    }
    console.error(`Error: ${context}`, err);
    res.status(500).json({ message: 'Internal server error' });
  });

  return app;
}

module.exports = createApp;
