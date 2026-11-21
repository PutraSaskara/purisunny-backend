// backend/test/helpers/app.js
//
// Boots the real Express app on an ephemeral port and returns small fetch
// helpers. All HTTP tests go through this so they exercise the same middleware
// stack as production (see app.js).

require('./env');

const path = require('path');

const jwt = require('jsonwebtoken');
const createApp = require('../../app');
const { JWT_ALGORITHM } = require('../../middleware/auth');

function makeToken({ role = 'admin', id = 1, username = 'test-user' } = {}) {
  return jwt.sign({ id, username, role }, process.env.JWT_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn: '1h',
  });
}

async function startApp({ httpClient = 'fetch' } = {}) {
  const app = createApp({ uploadsDir: require('os').tmpdir() });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // `httpClient: 'node'` routes requests through node:http instead of global
  // fetch. Needed for rate-limited routes under `node --test --test-force-exit`
  // on Windows: force-exit races undici's keep-alive async handles and aborts
  // the process with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)".
  // node:http leaves no such handle. See test/db/contact.test.js.
  const nodeHttp = httpClient === 'node';
  const nodeUrl = new URL(base);

  // node:http replies with a plain header object; give tests the same
  // headers.get(name) interface that fetch's Headers offers.
  function toHeaderBag(rawHeaders) {
    const lower = new Map();
    for (const [key, value] of Object.entries(rawHeaders || {})) {
      lower.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    }
    return {
      get: (name) => (lower.has(String(name).toLowerCase()) ? lower.get(String(name).toLowerCase()) : null),
      has: (name) => lower.has(String(name).toLowerCase()),
      entries: () => lower.entries(),
      raw: rawHeaders,
    };
  }

  function nodeRequest(method, path, { payload, finalHeaders }) {
    return new Promise((resolve, reject) => {
      const headers = { ...finalHeaders };
      if (payload !== undefined && payload !== null) {
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = require('http').request(
        { host: nodeUrl.hostname, port: nodeUrl.port, path, method, headers },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => {
            let json = null;
            if (text) {
              try { json = JSON.parse(text); } catch { json = null; }
            }
            resolve({ status: res.statusCode, json, headers: toHeaderBag(res.headers), text });
          });
        }
      );
      req.on('error', reject);
      if (payload !== undefined && payload !== null) req.write(payload);
      req.end();
    });
  }

  async function request(method, path, { body, token, headers = {}, raw } = {}) {
    const finalHeaders = { ...headers };
    if (token !== undefined && token !== null) {
      finalHeaders.Authorization = `Bearer ${token}`;
    }
    let payload;
    if (raw !== undefined) {
      payload = raw;
      if (!finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    } else if (body !== undefined && !(body instanceof FormData)) {
      finalHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    } else {
      payload = body;
    }

    if (nodeHttp) {
      return nodeRequest(method, path, { payload: typeof payload === 'string' ? payload : undefined, finalHeaders });
    }

    const res = await fetch(`${base}${path}`, { method, headers: finalHeaders, body: payload });
    let json = null;
    const text = await res.text();
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: res.status, json, headers: res.headers, text };
  }

  return {
    base,
    request,
    adminToken: makeToken({ role: 'admin', username: 'zz-test-admin' }),
    editorToken: makeToken({ role: 'editor', username: 'zz-test-editor' }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      // A suite whose handlers reach config/db opens a pooled mysql2
      // connection (enableKeepAlive) that holds the event loop open forever,
      // so `node --test` (and `npm test`) never exits naturally. End the
      // shared pool with the server, the same teardown every DB-backed suite
      // already performs (ctx.db.end() in test/db/*.test.js). If a suite ends
      // the pool again itself, the second end() rejects immediately and the
      // suite's own try/catch swallows it.
      const sharedDb = require.cache[require.resolve('../../config/db')];
      if (sharedDb) {
        try { await sharedDb.exports.end(); } catch { /* already closed */ }
      }
    },
  };
}

module.exports = { startApp, makeToken };
