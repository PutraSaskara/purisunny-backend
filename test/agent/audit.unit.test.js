// backend/test/agent/audit.unit.test.js
//
// recordMutation extracts caller identity from the Express request and never
// throws when the audit insert fails.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const audit = require('../../agent/audit');

test.afterEach(() => audit.__setDbForTests(null));

test('recordMutation maps request identity and mutation fields', async () => {
  let captured;
  audit.__setDbForTests({
    async query(sql, params) {
      captured = { sql, params };
      return [{ affectedRows: 1 }];
    },
  });

  const req = {
    method: 'PATCH',
    originalUrl: '/api/agent/v1/articles/5?x=1',
    requestId: 'req-123',
    ip: '203.0.113.7',
    headers: { 'user-agent': 'agent-test/1.0' },
    apiKey: { id: 9, userId: 3 },
    agentStartedAt: Date.now() - 4,
  };

  const recorded = await audit.recordMutation(req, {
    resource_type: 'article',
    resource_id: 5,
    status_code: 200,
    duration_ms: 12,
  });

  assert.equal(recorded, true);
  assert.equal(captured.params[0], 9); // api_key_id
  assert.equal(captured.params[1], 3); // user_id
  assert.equal(captured.params[2], 'PATCH');
  assert.equal(captured.params[3], '/api/agent/v1/articles/5?x=1');
  assert.equal(captured.params[4], 'article');
  assert.equal(captured.params[5], '5');
  assert.equal(captured.params[6], 200);
  assert.equal(captured.params[7], 'req-123');
  assert.equal(captured.params[8], '203.0.113.7');
  assert.equal(captured.params[9], 'agent-test/1.0');
  assert.equal(captured.params[10], 12);
});

test('recordMutation swallows database failures', async () => {
  audit.__setDbForTests({
    async query() { throw new Error('audit table unavailable'); },
  });

  const result = await audit.recordMutation({
    method: 'POST',
    originalUrl: '/api/agent/v1/articles',
    headers: {},
    apiKey: { id: 1, userId: 1 },
  }, { resource_type: 'article', resource_id: null, status_code: 201 });

  assert.equal(result, false);
});
