const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../config/db');
const { JWT_ALGORITHM } = require('../middleware/auth');

// Database pool used by the login lookup. Tests swap in a fake via
// __setDbForTests so the token lifetime can be checked without a live MySQL;
// production always uses config/db.
let dbPool = db;

// Test-only seam. Refused in production, like routes/contact.js.
function __setDbForTests(fake) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setDbForTests is not available in production');
  }
  if (fake === null || fake === undefined) {
    dbPool = db;
    return;
  }
  if (typeof fake.query !== 'function') {
    throw new Error('db fake must expose query()');
  }
  dbPool = fake;
}

// Brute-force protection for the login endpoint: 5 attempts per IP per 15 min.
// Successful logins are not counted (skipSuccessfulRequests) so a legitimate
// admin is never locked out by normal use. The 429 body is generic on purpose —
// it must not confirm whether a username exists.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: 'Too many login attempts. Please try again later.' },
});

// POST /api/auth/login
// Contract: body { username, password, remember? }. `remember` is optional;
// only a strict boolean true extends the token lifetime to 30d (default 24h).
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password, remember } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password required' });
    }
    
    const [rows] = await dbPool.query('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
    
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    // "Remember me": opt-in long session. Any non-boolean value is ignored so
    // an absent or malformed field keeps the 24h default instead of a 400.
    const expiresIn = remember === true ? '30d' : '24h';

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn, algorithm: JWT_ALGORITHM }
    );
    
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
module.exports.__setDbForTests = __setDbForTests;
