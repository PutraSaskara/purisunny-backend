// backend/agent/confirmDelete.js
//
// Shared X-Confirm-Delete guard for destructive Agent API routes. An accidental
// retry must never delete a row, so DELETE requires this explicit second signal
// in addition to the *:delete scope.
//
// Accepted values are exactly 'true' or '1' (case-sensitive). Anything else —
// absent, 'yes', 'TRUE', ' true ' — answers 400 CONFIRMATION_REQUIRED.

const { AgentError } = require('./errors');

const CONFIRM_HEADER = 'X-Confirm-Delete';

function headerValue(req) {
  const raw = req && req.headers ? req.headers['x-confirm-delete'] : undefined;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function isConfirmed(req) {
  const value = headerValue(req);
  return value === 'true' || value === '1';
}

function confirmDelete(req, res, next) {
  if (isConfirmed(req)) return next();
  return next(new AgentError(
    'CONFIRMATION_REQUIRED',
    `${CONFIRM_HEADER}: true or 1 is required to delete this resource`,
    { context: { header: CONFIRM_HEADER } }
  ));
}

module.exports = confirmDelete;
module.exports.confirmDelete = confirmDelete;
module.exports.isConfirmed = isConfirmed;
module.exports.CONFIRM_HEADER = CONFIRM_HEADER;
