// backend/agent/registry.js
//
// Single source of truth for the Agent API manifest. Only endpoints that
// actually exist in Phase 1 are advertised.

const pkg = require('../package.json');
const { KNOWN_SCOPES, ROLE_CAPS } = require('./scopes');
const { getRateLimits } = require('./rateLimit');

const NAME = 'Puri Sunny Agent API';
const VERSION = pkg.version || '1.0.0';
const DESCRIPTION = 'API key authenticated API for automating Puri Sunny content workflows.';

const TOOLS = Object.freeze([
  {
    name: 'health',
    method: 'GET',
    path: '/health',
    auth: false,
    required_scope: null,
    operation_id: 'getHealth',
    description: 'Liveness probe for the Agent API.',
  },
  {
    name: 'manifest',
    method: 'GET',
    path: '/manifest',
    auth: false,
    required_scope: null,
    operation_id: 'getManifest',
    description: 'Machine-readable description of this API, its scopes and rate limits.',
  },
  {
    name: 'openapi',
    method: 'GET',
    path: '/openapi.json',
    auth: false,
    required_scope: null,
    operation_id: 'getOpenApi',
    description: 'Raw OpenAPI 3.1 document (not wrapped in the success envelope).',
  },
  {
    name: 'me',
    method: 'GET',
    path: '/me',
    auth: true,
    required_scope: null,
    operation_id: 'getMe',
    description: 'Return the identity, owner and scopes of the calling API key.',
  },
  {
    name: 'articles.list',
    method: 'GET',
    path: '/articles',
    auth: true,
    required_scope: 'articles:read',
    operation_id: 'listArticles',
    description: 'List articles with category, featured, q and updated_since filters.',
  },
  {
    name: 'articles.getBySlug',
    method: 'GET',
    path: '/articles/by-slug/{slug}',
    auth: true,
    required_scope: 'articles:read',
    operation_id: 'getArticleBySlug',
    description: 'Read one article (with FAQs and related articles) by slug.',
  },
  {
    name: 'articles.get',
    method: 'GET',
    path: '/articles/{id}',
    auth: true,
    required_scope: 'articles:read',
    operation_id: 'getArticle',
    description: 'Read one article (with FAQs and related articles) by id.',
  },
  {
    name: 'articles.create',
    method: 'POST',
    path: '/articles',
    auth: true,
    required_scope: 'articles:write',
    operation_id: 'createArticle',
    description: 'Create an article. is_featured=true additionally requires articles:feature.',
  },
  {
    name: 'articles.patch',
    method: 'PATCH',
    path: '/articles/{id}',
    auth: true,
    required_scope: 'articles:write',
    operation_id: 'updateArticle',
    description: 'Partially update an article. Absent fields are preserved.',
  },
  {
    name: 'articles.delete',
    method: 'DELETE',
    path: '/articles/{id}',
    auth: true,
    required_scope: 'articles:delete',
    operation_id: 'deleteArticle',
    description: 'Delete an article. Requires X-Confirm-Delete: true or 1.',
  },
  {
    name: 'articles.validate',
    method: 'POST',
    path: '/articles/validate',
    auth: true,
    required_scope: 'articles:write',
    operation_id: 'validateArticle',
    description: 'Validate an article payload without writing.',
  },
  {
    name: 'articles.upsert',
    method: 'POST',
    path: '/articles/upsert',
    auth: true,
    required_scope: 'articles:write',
    operation_id: 'upsertArticle',
    description: 'Create by slug when absent, patch when present.',
  },
  {
    name: 'categories.list',
    method: 'GET',
    path: '/categories',
    auth: true,
    required_scope: 'categories:read',
    operation_id: 'listCategories',
    description: 'List every category ordered by name.',
  },
  {
    name: 'categories.get',
    method: 'GET',
    path: '/categories/{id}',
    auth: true,
    required_scope: 'categories:read',
    operation_id: 'getCategory',
    description: 'Read one category by id.',
  },
  {
    name: 'categories.create',
    method: 'POST',
    path: '/categories',
    auth: true,
    required_scope: 'categories:write',
    operation_id: 'createCategory',
    description: 'Create a category. Duplicate slug answers 409.',
  },
  {
    name: 'categories.patch',
    method: 'PATCH',
    path: '/categories/{id}',
    auth: true,
    required_scope: 'categories:write',
    operation_id: 'updateCategory',
    description: 'Partially update a category. Description: null clears it.',
  },
  {
    name: 'categories.delete',
    method: 'DELETE',
    path: '/categories/{id}',
    auth: true,
    required_scope: 'categories:delete',
    operation_id: 'deleteCategory',
    description: 'Delete a category. Requires X-Confirm-Delete: true or 1; referenced categories answer 409.',
  },
  {
    name: 'seo.list',
    method: 'GET',
    path: '/seo-pages',
    auth: true,
    required_scope: 'seo:read',
    operation_id: 'listSeoPages',
    description: 'List the 18 official SEO page entries with faqs.',
  },
  {
    name: 'seo.get',
    method: 'GET',
    path: '/seo-pages/{pageKey}',
    auth: true,
    required_scope: 'seo:read',
    operation_id: 'getSeoPage',
    description: 'Read one SEO page. URL-encode the page key colon (page%3Ahome).',
  },
  {
    name: 'seo.upsert',
    method: 'PUT',
    path: '/seo-pages/{pageKey}',
    auth: true,
    required_scope: 'seo:write',
    operation_id: 'upsertSeoPage',
    description: 'Create or update an SEO page and replace its faqs (upsert is the create path).',
  },
  {
    name: 'seo.delete',
    method: 'DELETE',
    path: '/seo-pages/{pageKey}',
    auth: true,
    required_scope: 'seo:delete',
    operation_id: 'deleteSeoPage',
    description: 'Delete an SEO page and its faqs. Requires X-Confirm-Delete: true or 1.',
  },
  {
    name: 'redirects.list',
    method: 'GET',
    path: '/redirects',
    auth: true,
    required_scope: 'redirects:read',
    operation_id: 'listRedirects',
    description: 'List the full redirect map ordered by id.',
  },
  {
    name: 'redirects.get',
    method: 'GET',
    path: '/redirects/{id}',
    auth: true,
    required_scope: 'redirects:read',
    operation_id: 'getRedirect',
    description: 'Read one redirect by id.',
  },
  {
    name: 'redirects.create',
    method: 'POST',
    path: '/redirects',
    auth: true,
    required_scope: 'redirects:write',
    operation_id: 'createRedirect',
    description: 'Create a redirect. Duplicate from_path 409, self-loop or shadowed route 400.',
  },
  {
    name: 'redirects.patch',
    method: 'PATCH',
    path: '/redirects/{id}',
    auth: true,
    required_scope: 'redirects:write',
    operation_id: 'updateRedirect',
    description: 'Partially update a redirect. Missing fields keep their stored value.',
  },
  {
    name: 'redirects.delete',
    method: 'DELETE',
    path: '/redirects/{id}',
    auth: true,
    required_scope: 'redirects:delete',
    operation_id: 'deleteRedirect',
    description: 'Delete a redirect. Requires X-Confirm-Delete: true or 1.',
  },
  {
    name: 'contacts.list',
    method: 'GET',
    path: '/contacts',
    auth: true,
    required_scope: 'contacts:read',
    operation_id: 'listContacts',
    description: 'List contact messages with page, per_page (max 100) and unread filters.',
  },
  {
    name: 'contacts.get',
    method: 'GET',
    path: '/contacts/{id}',
    auth: true,
    required_scope: 'contacts:read',
    operation_id: 'getContact',
    description: 'Read one contact message by id.',
  },
  {
    name: 'contacts.create',
    method: 'POST',
    path: '/contacts',
    auth: true,
    required_scope: 'contacts:write',
    operation_id: 'createContact',
    description: 'Store a contact message and attempt email delivery; always 201 with delivery status.',
  },
  {
    name: 'contacts.patch',
    method: 'PATCH',
    path: '/contacts/{id}',
    auth: true,
    required_scope: 'contacts:write',
    operation_id: 'updateContact',
    description: 'Update only is_read on a contact message.',
  },
  {
    name: 'contacts.delete',
    method: 'DELETE',
    path: '/contacts/{id}',
    auth: true,
    required_scope: 'contacts:delete',
    operation_id: 'deleteContact',
    description: 'Permanently delete a contact message. Requires X-Confirm-Delete: true or 1.',
  },
  {
    name: 'media.upload',
    method: 'POST',
    path: '/media',
    auth: true,
    required_scope: 'media:write',
    operation_id: 'uploadMedia',
    description: 'Upload an image as multipart/form-data or JSON base64. 5MB maximum.',
  },
]);

function getBaseUrl() {
  const configured = (process.env.PUBLIC_API_BASE_URL || '').trim();
  if (!configured) return '/api/agent/v1';
  return configured.replace(/\/+$/, '');
}

function rateLimitSummary() {
  const limits = getRateLimits();
  const shape = (limit) => ({
    limit,
    window_ms: limits.window_ms,
    per: 'api_key',
  });
  return {
    read: shape(limits.read),
    write: shape(limits.write),
    auth_failure: {
      limit: limits.auth_failure,
      window_ms: limits.window_ms,
      per: 'ip',
    },
  };
}

function buildManifest() {
  return {
    name: NAME,
    version: VERSION,
    description: DESCRIPTION,
    base_url: getBaseUrl(),
    auth: {
      type: 'bearer',
      scheme: 'Bearer',
      header: 'Authorization',
      key_format: 'psk_live_<prefix>_<secret>',
    },
    auth_scheme: 'Bearer',
    scopes: [...KNOWN_SCOPES],
    role_caps: {
      admin: [...ROLE_CAPS.admin],
      editor: [...ROLE_CAPS.editor],
    },
    rate_limits: rateLimitSummary(),
    tools: TOOLS.map((tool) => ({ ...tool })),
    docs: {
      openapi: '/openapi.json',
      manifest: '/manifest',
      health: '/health',
    },
  };
}

module.exports = {
  NAME,
  VERSION,
  DESCRIPTION,
  TOOLS,
  getBaseUrl,
  rateLimitSummary,
  buildManifest,
};
