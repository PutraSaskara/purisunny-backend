// backend/services/errors.js
//
// Small transport-neutral error shape used by the service layer. Services throw
// these; the route adapters translate them into the exact HTTP response the API
// already exposes. A plain factory is used instead of a class so the services
// stay close to the existing CommonJS style.

function httpError(status, body) {
  const message = body && typeof body.message === 'string' ? body.message : 'Service error';
  const error = new Error(message);
  error.status = status;
  error.body = body;
  return error;
}

function isHttpError(error) {
  return Boolean(error && typeof error.status === 'number' && error.body);
}

module.exports = { httpError, isHttpError };
