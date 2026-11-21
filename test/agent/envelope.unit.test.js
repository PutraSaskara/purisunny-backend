// backend/test/agent/envelope.unit.test.js
//
// Envelope shape, request-id handling and service httpError mapping.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { httpError } = require('../../services/errors');
const { AgentError } = require('../../agent/errors');
const { attachRequestId, sendSuccess, sendError, errorPayload } = require('../../agent/envelope');

function fakeRes() {
  return {
    statusCode: 200,
    headersSent: false,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
    end() { this.ended = true; },
  };
}

test('success envelope carries data and request_id', () => {
  const req = { headers: { 'x-request-id': 'req-abc_123' } };
  const res = fakeRes();
  sendSuccess(req, res, { status: 'ok' });
  assert.deepEqual(res.body, {
    ok: true,
    data: { status: 'ok' },
    meta: { request_id: 'req-abc_123' },
  });
  assert.equal(res.headers['x-request-id'], 'req-abc_123');
});

test('request id: unsafe or oversized values are replaced with a UUID', () => {
  for (const supplied of ['bad value!', 'x'.repeat(65), '<script>']) {
    const req = { headers: { 'x-request-id': supplied } };
    const res = fakeRes();
    const id = attachRequestId(req, res);
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.notEqual(id, supplied);
  }
});

test('error envelope maps service httpError body { message, errors[] }', () => {
  const { status, payload } = errorPayload(httpError(400, {
    message: 'Validation failed',
    errors: [{ message: 'title is required' }, 'slug is required'],
    field: 'title',
  }));
  assert.equal(status, 400);
  assert.equal(payload.code, 'VALIDATION_ERROR');
  assert.equal(payload.message, 'Validation failed');
  assert.deepEqual(payload.details, [
    { message: 'title is required' },
    { message: 'slug is required' },
  ]);
  assert.deepEqual(payload.context, { field: 'title' });
});

test('error envelope maps statuses to stable codes', () => {
  const cases = [
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
    [503, 'SERVICE_UNAVAILABLE'],
  ];
  for (const [status, code] of cases) {
    assert.equal(errorPayload(httpError(status, { message: 'x' })).payload.code, code, String(status));
  }
});

test('unknown errors become generic 500 without leaking the message', () => {
  const internal = new Error('SQL: SELECT password FROM users');
  const { status, payload } = errorPayload(internal);
  assert.equal(status, 500);
  assert.equal(payload.code, 'INTERNAL_ERROR');
  assert.equal(payload.message, 'Internal server error');
  assert.equal(JSON.stringify(payload).includes('SELECT password'), false);
});

test('service httpError 5xx bodies are not exposed', () => {
  const { status, payload } = errorPayload(httpError(500, {
    message: 'ER_LOCK_WAIT_TIMEOUT at /var/lib/mysql',
    errors: [{ message: 'stack detail' }],
  }));
  assert.equal(status, 500);
  assert.equal(payload.code, 'INTERNAL_ERROR');
  assert.equal(payload.message, 'Internal server error');
  assert.equal(payload.details, undefined);
  assert.equal(JSON.stringify(payload).includes('ER_LOCK'), false);
});

test('AgentError uses the documented status mapping', () => {
  assert.equal(new AgentError('CONFLICT').status, 409);
  assert.equal(new AgentError('PAYLOAD_TOO_LARGE').status, 413);
  assert.equal(new AgentError('NOT_A_CODE').code, 'INTERNAL_ERROR');
});

test('sendError writes the envelope and status', () => {
  const req = { headers: { 'x-request-id': 'req-1' } };
  const res = fakeRes();
  sendError(req, res, new AgentError('NOT_FOUND', 'Agent API route not found'));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Agent API route not found' },
    meta: { request_id: 'req-1' },
  });
});
