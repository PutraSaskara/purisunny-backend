// backend/routes/contact.js
//
// Public contact form + admin inbox.
//
//   POST /api/contact   -> 201 { message, email_sent: true }       email delivered
//                       -> 502 { message, fallback, email_sent }   email not delivered
//                       -> 400 { message, errors[] }               validation failed
//                       -> 429 { message }                         >5 per IP per hour
//
//   GET  /api/contacts  -> 200 { contacts: [...], total, unread }  admin only
//                          query ?limit=<int>  clamp 1..100, default all
//                       -> 400 { message, errors[] }               limit not an integer
//                       -> 401/403  missing token / not admin (middleware/auth.js)
//                       -> 500 { message }                         server error
//
// `contacts` rows are ordered by created_at DESC, id DESC (newest first; id
// breaks ties inside the same second). `total` counts every row and `unread`
// counts rows with is_read = 0, regardless of `limit`, so the dashboard panel
// and the badge show the same numbers.
//
// The DB row is ALWAYS written before the mail is attempted: `contacts` is the
// backup, so a dropped message is still visible in the admin dashboard even when
// SMTP is down. The response never claims success unless the mail actually left,
// because otherwise the visitor would think the owner saw their message when
// nobody did.
//
// Interim state: EMAIL_* is not in .env yet, so every submission stores the row
// and returns the 502 + `fallback: 'whatsapp'` body. The website turns that into
// a WhatsApp call-to-action (the number is live today), not a mystery error.
//
// Contract is FIXED — the frontend codes against it. Do not change field names.

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { authenticateJWT, requireRole, ROLE_ADMIN } = require('../middleware/auth');
const contacts = require('../services/contacts');
const { isHttpError } = require('../services/errors');

// Public form endpoint: cap submissions at 5 per IP per hour to blunt spam and
// accidental double-submits. Generic 429 body (no internals leaked).
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many messages sent. Please try again later.' },
});

// GET /api/contacts — admin only. Dashboard "Recent Contacts" panel plus the
// totals the statistics cards read. Two statements: the page and the counts.
router.get('/', authenticateJWT, requireRole(ROLE_ADMIN), async (req, res) => {
  try {
    res.json(await contacts.list(req.query.limit));
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Get contacts error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/contact — public, store the submission and email the homestay.
router.post('/', contactLimiter, async (req, res) => {
  try {
    const result = await contacts.create(req.body || {});
    if (result.emailSent) {
      return res.status(201).json({
        message: 'Message sent successfully',
        email_sent: true,
      });
    }

    return res.status(502).json({
      message: contacts.DELIVERY_FAILED_MESSAGE,
      fallback: 'whatsapp',
      email_sent: false,
    });
  } catch (error) {
    if (isHttpError(error)) {
      return res.status(error.status).json(error.body);
    }
    console.error('Contact insert error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
module.exports.DELIVERY_FAILED_MESSAGE = contacts.DELIVERY_FAILED_MESSAGE;
module.exports.__setMailerForTests = contacts.__setMailerForTests;
module.exports.__setDbForTests = contacts.__setDbForTests;
