// backend/config/db.js
//
// Single shared mysql2 pool for the whole backend.
//
// Connection settings are environment-driven. In development the previous
// ergonomics are kept (sensible localhost defaults, empty root password), so
// `npm start` works out of the box on a stock XAMPP install.
//
// In production (NODE_ENV === 'production') the four core variables are
// required: silently falling back to root/no-password/localhost against a
// production database is how a deployment ends up running with credentials
// nobody intended. We therefore refuse to start instead (audit P3-1).
//
// `charset`, `connectTimeout`, `enableKeepAlive` and `queueLimit` are pinned so
// that a slow/hung database cannot pile up unbounded requests (default
// queueLimit is 0 = unlimited) and so that non-ASCII content (Balinese names,
// emoji) round-trips correctly.

const mysql = require('mysql2');
require('dotenv').config();

const REQUIRED_IN_PRODUCTION = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];

if (process.env.NODE_ENV === 'production') {
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => {
    const value = process.env[key];
    // DB_PASSWORD may legitimately be empty for some managed providers, but it
    // must still be *set* explicitly rather than silently defaulted.
    return value === undefined;
  });
  if (missing.length > 0) {
    throw new Error(
      `FATAL: missing database configuration for production: ${missing.join(', ')}. ` +
      'Set them in the environment (see backend/.env.example).'
    );
  }
}

// Default pool queue depth. 100 pending waiters is generous for an admin API
// and bounded, unlike mysql2's default of 0 (= unbounded).
const QUEUE_LIMIT = (() => {
  const raw = Number(process.env.DB_QUEUE_LIMIT);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 100;
})();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : '',
  database: process.env.DB_NAME || 'purisunny',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: QUEUE_LIMIT,
  charset: 'utf8mb4',
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

module.exports = pool.promise();
