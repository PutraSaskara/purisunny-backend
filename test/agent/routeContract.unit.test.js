// backend/test/agent/routeContract.unit.test.js
//
// Contract test that compares three independent descriptions of the Agent API:
//   1. the Express routers in backend/agent/routes/*.js (what actually runs)
//   2. the manifest in backend/agent/registry.js (what callers discover)
//   3. the OpenAPI document in backend/agent/openapi.js (what tools import)
//
// Express params are normalised to OpenAPI style: :id -> {id}.
// Any mismatch fails: a route that is not documented is a bug, and a manifest
// tool without an operation (or vice versa) breaks generated clients.

require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const meta = require('../../agent/routes/meta');
const articles = require('../../agent/routes/articles');
const categories = require('../../agent/routes/categories');
const seoPages = require('../../agent/routes/seoPages');
const redirects = require('../../agent/routes/redirects');
const contacts = require('../../agent/routes/contacts');
const media = require('../../agent/routes/media');
const { TOOLS } = require('../../agent/registry');
const { buildOpenApi } = require('../../agent/openapi');

const MOUNTS = [
  { prefix: '', router: meta.publicRouter, file: 'routes/meta.js (public)' },
  { prefix: '', router: meta.protectedRouter, file: 'routes/meta.js (protected)' },
  { prefix: '/articles', router: articles, file: 'routes/articles.js' },
  { prefix: '/categories', router: categories, file: 'routes/categories.js' },
  { prefix: '/seo-pages', router: seoPages, file: 'routes/seoPages.js' },
  { prefix: '/redirects', router: redirects, file: 'routes/redirects.js' },
  { prefix: '/contacts', router: contacts, file: 'routes/contacts.js' },
  { prefix: '/media', router: media, file: 'routes/media.js' },
];

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

// Express 4 keeps routes in router.stack layers with `layer.route`. Route
// methods are exposed as a lowercase-keyed object (e.g. { get: true }).
function normalizePath(prefix, routePath) {
  const raw = `${prefix}${routePath === '/' ? '' : routePath}` || '/';
  return raw.replace(/\/+/g, '/').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function routerPairs() {
  const pairs = new Set();
  const duplicates = [];
  for (const { prefix, router, file } of MOUNTS) {
    assert.ok(Array.isArray(router.stack), `${file} is not an Express router`);
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const route = layer.route;
      const methods = Object.keys(route.methods || {})
        .filter((method) => method !== '_all')
        .map((method) => method.toUpperCase());
      for (const method of methods) {
        const pair = `${method} ${normalizePath(prefix, route.path)}`;
        if (pairs.has(pair)) duplicates.push(pair);
        pairs.add(pair);
      }
    }
  }
  assert.deepEqual(duplicates, [], `duplicate route(s): ${duplicates.join(', ')}`);
  return [...pairs].sort();
}

function manifestPairs() {
  return TOOLS.map((tool) => `${String(tool.method).toUpperCase()} ${tool.path}`).sort();
}

function openApiPairs() {
  const doc = buildOpenApi();
  const pairs = [];
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      if (operations[method]) pairs.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return pairs.sort();
}

test('every Agent router method/path pair is in the manifest', () => {
  const manifest = new Set(manifestPairs());
  const missing = routerPairs().filter((pair) => !manifest.has(pair));
  assert.deepEqual(missing, [], `route(s) missing from registry.TOOLS: ${missing.join(', ')}`);
});

test('every Agent router method/path pair is in the OpenAPI document', () => {
  const openapi = new Set(openApiPairs());
  const missing = routerPairs().filter((pair) => !openapi.has(pair));
  assert.deepEqual(missing, [], `route(s) missing from openapi paths: ${missing.join(', ')}`);
});

test('every manifest tool has a matching OpenAPI operation', () => {
  const openapi = new Set(openApiPairs());
  const missing = manifestPairs().filter((pair) => !openapi.has(pair));
  assert.deepEqual(missing, [], `manifest tool(s) missing from openapi: ${missing.join(', ')}`);
});

test('OpenAPI documents no operation that the manifest does not advertise', () => {
  const manifest = new Set(manifestPairs());
  const extra = openApiPairs().filter((pair) => !manifest.has(pair));
  assert.deepEqual(extra, [], `openapi operation(s) missing from manifest: ${extra.join(', ')}`);
});

test('route, manifest and OpenAPI sets are identical', () => {
  assert.deepEqual(routerPairs(), manifestPairs());
  assert.deepEqual(openApiPairs(), manifestPairs());
});
