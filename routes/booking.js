// backend/routes/booking.js
//
// Public booking-lead capture + admin/editor inbox.
//
//   POST /api/booking/events              public, rate 30/min/IP -> 204 always
//   POST /api/booking/leads               public, rate 5/hour/IP  -> 201
//                                                                  -> 400 validation
//   GET  /api/booking/leads               admin/editor          -> 200 list
//   GET  /api/booking/leads/:id           admin/editor          -> 200 / 404
//   PATCH /api/booking/leads/:id          admin/editor {status} -> 200 / 400 / 404
//   POST /api/booking/leads/:id/resend-email  admin/editor      -> 200 / 400 / 404
//   DELETE /api/booking/leads/:id         admin only            -> 200 / 404
//   GET  /api/booking/stats?days=7        admin only            -> 200
//
// A failed email is NOT an error for the visitor: the lead is stored and the
// response is still 201 with email_status 'failed' and email_sent false. The
// WhatsApp hand-off in `wa_url` always works.
//
// Tracking input is best-effort: invalid events are dropped silently and the
// endpoint always answers 204 (apart from the rate limiter's 429).

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { authenticateJWT, requireRole, ROLE_ADMIN, ROLE_EDITOR } = require('../middleware/auth');
const { parseId } = require('../utils/validate');
const booking = require('../services/booking');
const { isHttpError } = require('../services/errors');

// Canonical direct-booking WhatsApp number (also used by the frontend's
// bookingLinks.js helper).
const WA_NUMBER = '6285737216669';

// Public tracking: generous enough for a normal visit, bounded against floods.
const eventsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many tracking events. Please try again later.' },
});

// Public form: 5 submissions per IP per hour.
const leadsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many booking inquiries sent. Please try again later.' },
});

function sendIdError(res) {
  return res.status(400).json({ message: 'Booking lead id must be a positive integer' });
}

function sendServiceError(res, error, context) {
  if (isHttpError(error)) {
    return res.status(error.status).json(error.body);
  }
  console.error(`${context}:`, error);
  return res.status(500).json({ message: 'Server error' });
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

// POST /api/booking/events — anonymous only; no PII fields are read.
router.post('/events', eventsLimiter, async (req, res) => {
  try {
    await booking.recordEvents(req.body || {});
  } catch (error) {
    // The service already swallows bad input and DB errors; this is the last
    // resort so tracking can never answer anything but 204.
    console.error('Booking events error:', error && error.code ? error.code : 'UNKNOWN');
  }
  res.status(204).end();
});

// POST /api/booking/leads — store the inquiry, then attempt the email.
router.post('/leads', leadsLimiter, async (req, res) => {
  try {
    const { lead, emailSent } = await booking.createLead(req.body || {});
    if (!lead) {
      // Defensive: a successful insert must always re-read a row.
      return res.status(500).json({ message: 'Server error' });
    }

    const firstMessage = lead.first_message || '';
    return res.status(201).json({
      lead,
      first_message: firstMessage,
      wa_url: `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(firstMessage)}`,
      email_status: lead.email_status,
      email_sent: Boolean(emailSent),
    });
  } catch (error) {
    return sendServiceError(res, error, 'Create booking lead error');
  }
});

// ---------------------------------------------------------------------------
// Admin / editor
// ---------------------------------------------------------------------------

// GET /api/booking/leads — filters: status, channel, email_status, q, page,
// per_page. Ordered newest first.
router.get('/leads', authenticateJWT, requireRole(ROLE_ADMIN, ROLE_EDITOR), async (req, res) => {
  try {
    res.json(await booking.listLeads(req.query));
  } catch (error) {
    return sendServiceError(res, error, 'List booking leads error');
  }
});

// GET /api/booking/leads/:id
router.get('/leads/:id', authenticateJWT, requireRole(ROLE_ADMIN, ROLE_EDITOR), async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return sendIdError(res);

  try {
    const lead = await booking.getLead(id);
    if (!lead) return res.status(404).json({ message: 'Booking lead not found' });
    return res.json({ lead });
  } catch (error) {
    return sendServiceError(res, error, 'Get booking lead error');
  }
});

// PATCH /api/booking/leads/:id — status only.
router.patch('/leads/:id', authenticateJWT, requireRole(ROLE_ADMIN, ROLE_EDITOR), async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return sendIdError(res);

  try {
    const lead = await booking.updateLeadStatus(id, req.body && req.body.status);
    return res.json({ lead });
  } catch (error) {
    return sendServiceError(res, error, 'Update booking lead error');
  }
});

// POST /api/booking/leads/:id/resend-email — retries the same atomic claim.
router.post(
  '/leads/:id/resend-email',
  authenticateJWT,
  requireRole(ROLE_ADMIN, ROLE_EDITOR),
  async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendIdError(res);

    try {
      const lead = await booking.resendLeadEmail(id);
      return res.json({ lead });
    } catch (error) {
      return sendServiceError(res, error, 'Resend booking email error');
    }
  }
);

// DELETE /api/booking/leads/:id — admin only, hard delete.
router.delete('/leads/:id', authenticateJWT, requireRole(ROLE_ADMIN), async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return sendIdError(res);

  try {
    await booking.removeLead(id);
    return res.json({ message: 'Booking lead deleted' });
  } catch (error) {
    return sendServiceError(res, error, 'Delete booking lead error');
  }
});

// GET /api/booking/stats?days=7 — admin only, window metrics + all-time totals.
router.get('/stats', authenticateJWT, requireRole(ROLE_ADMIN), async (req, res) => {
  try {
    res.json(await booking.stats(req.query.days));
  } catch (error) {
    return sendServiceError(res, error, 'Booking stats error');
  }
});

module.exports = router;
module.exports.WA_NUMBER = WA_NUMBER;
module.exports.__setDbForTests = booking.__setDbForTests;
module.exports.__setMailerForTests = booking.__setMailerForTests;
