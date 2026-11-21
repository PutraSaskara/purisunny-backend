// backend/agent/openapi.js
//
// OpenAPI 3.1 description of the implemented Agent API. Phase 2A adds the
// article CRUD surface; Phase 2B adds categories, SEO pages and redirects.
// The document is served raw (not envelope-wrapped).

const { NAME, VERSION, DESCRIPTION, getBaseUrl } = require('./registry');
const { KNOWN_SCOPES } = require('./scopes');

const JSON_CONTENT = 'application/json';

function envelopeSchema(dataSchema, metaSchema) {
  const metaProperties = {
    request_id: { type: 'string' },
    ...((metaSchema && metaSchema.properties) || {}),
  };
  return {
    type: 'object',
    required: ['ok', 'data', 'meta'],
    properties: {
      ok: { type: 'boolean', const: true },
      data: dataSchema,
      meta: {
        type: 'object',
        required: ['request_id'],
        properties: metaProperties,
      },
    },
  };
}

function errorResponse(description) {
  return {
    description,
    content: {
      [JSON_CONTENT]: {
        schema: {
          type: 'object',
          required: ['ok', 'error', 'meta'],
          properties: {
            ok: { type: 'boolean', const: false },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: { type: 'array', items: { type: 'object' } },
                context: { type: 'object' },
              },
            },
            meta: {
              type: 'object',
              required: ['request_id'],
              properties: { request_id: { type: 'string' } },
            },
          },
        },
      },
    },
  };
}

function jsonOk(schema, metaSchema) {
  return {
    description: 'Successful response',
    content: {
      [JSON_CONTENT]: {
        schema: envelopeSchema(schema, metaSchema),
      },
    },
  };
}

function jsonCreated(schema) {
  return {
    description: 'Created',
    content: {
      [JSON_CONTENT]: {
        schema: envelopeSchema(schema),
      },
    },
  };
}

function articleErrorResponses() {
  return {
    400: errorResponse('Invalid request or body'),
    401: errorResponse('Missing or invalid API key'),
    403: errorResponse('Scope not permitted for the key owner'),
    404: errorResponse('Article or referenced category not found'),
    409: errorResponse('Duplicate slug, idempotency conflict or in-progress request'),
    429: errorResponse('Rate limit exceeded'),
    503: errorResponse('Agent API disabled'),
  };
}

// Every Phase 2B resource documents the same error surface: validation,
// authentication, scope, missing row, conflict, rate limit and kill switch.
function resourceErrorResponses() {
  return {
    400: errorResponse('Invalid request, body, id, page key or confirmation header'),
    401: errorResponse('Missing or invalid API key'),
    403: errorResponse('Missing required scope or scope not permitted for the key owner'),
    404: errorResponse('Resource not found'),
    409: errorResponse('Duplicate unique value, referenced resource or idempotency conflict'),
    429: errorResponse('Rate limit exceeded'),
    503: errorResponse('Agent API disabled'),
  };
}

function headerParameter(name, description, required = false) {
  return {
    name,
    in: 'header',
    required,
    description,
    schema: { type: 'string' },
  };
}

function pathIdParameter() {
  return {
    name: 'id',
    in: 'path',
    required: true,
    description: 'Positive article id',
    schema: { type: 'integer', minimum: 1 },
  };
}

function pathSlugParameter() {
  return {
    name: 'slug',
    in: 'path',
    required: true,
    description: 'Article slug',
    schema: { type: 'string' },
  };
}

function pathResourceIdParameter(description) {
  return {
    name: 'id',
    in: 'path',
    required: true,
    description,
    schema: { type: 'integer', minimum: 1 },
  };
}

function pathPageKeyParameter() {
  return {
    name: 'pageKey',
    in: 'path',
    required: true,
    description: 'One of the 18 official page keys. URL-encode the colon, e.g. page%3Ahome.',
    schema: {
      type: 'string',
      examples: ['page:home', 'page%3Ahome', 'room:deluxe-room'],
    },
  };
}

const IDEMPOTENCY_PARAMETER = headerParameter(
  'Idempotency-Key',
  'Optional replay key for mutating requests. Reusing a key with a different method/path/body answers 409.'
);

function articleSchema() {
  return { $ref: '#/components/schemas/Article' };
}

function articleDetailSchema() {
  return { $ref: '#/components/schemas/ArticleDetail' };
}

function buildOpenApi() {
  const base = getBaseUrl();
  return {
    openapi: '3.1.0',
    info: {
      title: NAME,
      version: VERSION,
      description: DESCRIPTION,
    },
    servers: [{ url: base }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key in the form psk_live_<prefix>_<secret>.',
        },
      },
      schemas: {
        Scope: { type: 'string', enum: [...KNOWN_SCOPES] },
        ArticleFaq: {
          type: 'object',
          required: ['id', 'question', 'answer', 'position'],
          properties: {
            id: { type: 'integer' },
            question: { type: 'string' },
            answer: { type: 'string' },
            position: { type: 'integer' },
          },
        },
        Article: {
          type: 'object',
          required: ['id', 'title', 'slug', 'read_time', 'is_featured', 'noindex', 'faqs'],
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            slug: { type: 'string' },
            content: { type: ['string', 'null'] },
            excerpt: { type: ['string', 'null'] },
            cover_image: { type: ['string', 'null'] },
            category_id: { type: ['integer', 'null'] },
            category_name: { type: ['string', 'null'] },
            category_slug: { type: ['string', 'null'] },
            author: { type: ['string', 'null'] },
            read_time: { type: 'integer' },
            is_featured: { type: 'integer', enum: [0, 1] },
            meta_title: { type: ['string', 'null'] },
            meta_description: { type: ['string', 'null'] },
            og_image: { type: ['string', 'null'] },
            noindex: { type: 'integer', enum: [0, 1] },
            keywords: { type: ['string', 'null'] },
            published_at: { type: ['string', 'null'], format: 'date-time' },
            created_at: { type: ['string', 'null'], format: 'date-time' },
            updated_at: { type: ['string', 'null'], format: 'date-time' },
            faqs: { type: 'array', items: { $ref: '#/components/schemas/ArticleFaq' } },
          },
        },
        ArticleDetail: {
          type: 'object',
          required: ['article', 'related'],
          properties: {
            article: articleSchema(),
            related: { type: 'array', items: articleSchema() },
          },
        },
        ArticleWriteInput: {
          type: 'object',
          required: ['title', 'slug'],
          properties: {
            title: { type: 'string', maxLength: 255 },
            slug: { type: 'string', maxLength: 255, description: 'lowercase-kebab-case' },
            content: { type: ['string', 'null'], description: 'Sanitised HTML (agent writes only)' },
            excerpt: { type: ['string', 'null'] },
            author: { type: ['string', 'null'], maxLength: 100 },
            cover_image: { type: ['string', 'null'], maxLength: 500 },
            read_time: { type: 'integer', minimum: 0, maximum: 10000 },
            is_featured: { type: 'boolean', description: 'true additionally requires articles:feature' },
            category_id: { type: ['integer', 'null'], minimum: 1 },
            meta_title: { type: ['string', 'null'], maxLength: 255 },
            meta_description: { type: ['string', 'null'], maxLength: 500 },
            og_image: { type: ['string', 'null'], maxLength: 500 },
            noindex: { type: 'boolean' },
            keywords: { type: ['string', 'null'], maxLength: 255 },
            faqs: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['question', 'answer'],
                properties: {
                  question: { type: 'string', maxLength: 255 },
                  answer: { type: 'string', maxLength: 1000 },
                },
              },
            },
          },
        },
        ArticlePatchInput: {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: 255 },
            slug: { type: 'string', maxLength: 255 },
            content: { type: ['string', 'null'] },
            excerpt: { type: ['string', 'null'] },
            author: { type: ['string', 'null'], maxLength: 100 },
            cover_image: { type: ['string', 'null'], maxLength: 500 },
            read_time: { type: 'integer', minimum: 0, maximum: 10000 },
            is_featured: { type: 'boolean' },
            category_id: { type: ['integer', 'null'], minimum: 1 },
            meta_title: { type: ['string', 'null'], maxLength: 255 },
            meta_description: { type: ['string', 'null'], maxLength: 500 },
            og_image: { type: ['string', 'null'], maxLength: 500 },
            noindex: { type: 'boolean' },
            keywords: { type: ['string', 'null'], maxLength: 255 },
            faqs: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['question', 'answer'],
                properties: {
                  question: { type: 'string', maxLength: 255 },
                  answer: { type: 'string', maxLength: 1000 },
                },
              },
            },
          },
        },
        ArticleListData: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: articleSchema() },
          },
        },
        ArticleDeleteData: {
          type: 'object',
          required: ['id', 'slug', 'deleted'],
          properties: {
            id: { type: 'integer' },
            slug: { type: 'string' },
            deleted: { type: 'boolean', const: true },
          },
        },
        ArticleUpsertData: {
          type: 'object',
          required: ['created', 'article'],
          properties: {
            created: { type: 'boolean' },
            article: articleSchema(),
          },
        },
        ArticleValidateData: {
          type: 'object',
          required: ['valid'],
          properties: {
            valid: { type: 'boolean', const: true },
          },
        },
        Category: {
          type: 'object',
          required: ['id', 'name', 'slug'],
          properties: {
            id: { type: 'integer' },
            name: { type: 'string', maxLength: 100 },
            slug: { type: 'string', maxLength: 100 },
            description: { type: ['string', 'null'] },
            created_at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        CategoryWriteInput: {
          type: 'object',
          required: ['name', 'slug'],
          properties: {
            name: { type: 'string', maxLength: 100 },
            slug: { type: 'string', maxLength: 100, description: 'lowercase-kebab-case' },
            description: { type: ['string', 'null'] },
          },
        },
        CategoryPatchInput: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 100 },
            slug: { type: 'string', maxLength: 100 },
            description: {
              type: ['string', 'null'],
              description: 'Absent preserves the stored description; null clears it.',
            },
          },
        },
        CategoryListData: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/Category' } },
          },
        },
        CategoryDeleteData: {
          type: 'object',
          required: ['id', 'deleted'],
          properties: {
            id: { type: 'integer' },
            deleted: { type: 'boolean', const: true },
          },
        },
        SeoFaq: {
          type: 'object',
          required: ['question', 'answer'],
          properties: {
            question: { type: 'string', maxLength: 255 },
            answer: { type: 'string' },
            position: { type: 'integer', minimum: 0 },
          },
        },
        SeoPage: {
          type: 'object',
          required: ['page_key', 'meta_title', 'meta_description', 'og_image', 'noindex', 'keywords', 'faqs'],
          properties: {
            page_key: { type: 'string' },
            meta_title: { type: ['string', 'null'] },
            meta_description: { type: ['string', 'null'] },
            og_image: { type: ['string', 'null'] },
            noindex: { type: 'integer', enum: [0, 1] },
            keywords: { type: ['string', 'null'] },
            faqs: { type: 'array', items: { $ref: '#/components/schemas/SeoFaq' } },
            created_at: { type: ['string', 'null'], format: 'date-time' },
            updated_at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        SeoPageInput: {
          type: 'object',
          properties: {
            meta_title: { type: ['string', 'null'], maxLength: 255 },
            meta_description: { type: ['string', 'null'], maxLength: 500 },
            og_image: { type: ['string', 'null'], maxLength: 500, description: 'http(s) URL' },
            noindex: { type: ['boolean', 'integer'], enum: [false, true, 0, 1] },
            keywords: { type: ['string', 'null'], maxLength: 255 },
            faqs: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['question', 'answer'],
                properties: {
                  question: { type: 'string', maxLength: 255 },
                  answer: { type: 'string' },
                },
              },
            },
          },
        },
        SeoPageListData: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/SeoPage' } },
          },
        },
        SeoPageDeleteData: {
          type: 'object',
          required: ['page_key', 'deleted'],
          properties: {
            page_key: { type: 'string' },
            deleted: { type: 'boolean', const: true },
          },
        },
        Redirect: {
          type: 'object',
          required: ['id', 'from_path', 'to_path', 'status'],
          properties: {
            id: { type: 'integer' },
            from_path: { type: 'string', maxLength: 255 },
            to_path: { type: 'string', maxLength: 255 },
            status: { type: 'integer', enum: [301, 302] },
            created_at: { type: ['string', 'null'], format: 'date-time' },
            updated_at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        RedirectInput: {
          type: 'object',
          required: ['from_path', 'to_path'],
          properties: {
            from_path: {
              type: 'string',
              maxLength: 255,
              description: 'Root-relative path that must not shadow a live route.',
            },
            to_path: {
              type: 'string',
              maxLength: 255,
              description: 'Root-relative page path; /api and /_next are refused.',
            },
            status: { type: 'integer', enum: [301, 302], default: 301 },
          },
        },
        RedirectPatchInput: {
          type: 'object',
          properties: {
            from_path: { type: 'string', maxLength: 255 },
            to_path: { type: 'string', maxLength: 255 },
            status: { type: 'integer', enum: [301, 302] },
          },
        },
        RedirectListData: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/Redirect' } },
          },
        },
        RedirectDeleteData: {
          type: 'object',
          required: ['id', 'deleted'],
          properties: {
            id: { type: 'integer' },
            deleted: { type: 'boolean', const: true },
          },
        },
        Contact: {
          type: 'object',
          required: ['id', 'name', 'email', 'phone', 'message', 'is_read', 'created_at'],
          properties: {
            id: { type: 'integer' },
            name: { type: 'string', maxLength: 100 },
            email: { type: 'string', maxLength: 255 },
            phone: { type: ['string', 'null'], maxLength: 32 },
            message: { type: 'string', maxLength: 5000 },
            is_read: { type: 'integer', enum: [0, 1] },
            created_at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        ContactCreateInput: {
          type: 'object',
          required: ['name', 'email', 'message'],
          properties: {
            name: { type: 'string', maxLength: 100 },
            email: { type: 'string', maxLength: 255, format: 'email' },
            phone: { type: ['string', 'null'], maxLength: 32 },
            message: { type: 'string', minLength: 10, maxLength: 5000 },
          },
        },
        ContactPatchInput: {
          type: 'object',
          required: ['is_read'],
          additionalProperties: false,
          properties: {
            is_read: {
              type: ['boolean', 'integer'],
              enum: [true, false, 0, 1],
              description: 'Only is_read may be updated. Unknown fields answer 400.',
            },
          },
        },
        ContactListData: {
          type: 'object',
          required: ['items'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/Contact' } },
          },
        },
        ContactCreateData: {
          type: 'object',
          required: ['id', 'email_sent'],
          properties: {
            id: { type: 'integer' },
            email_sent: { type: 'boolean' },
            fallback: { type: 'string', enum: ['whatsapp'] },
          },
        },
        ContactDeleteData: {
          type: 'object',
          required: ['id', 'deleted'],
          properties: {
            id: { type: 'integer' },
            deleted: { type: 'boolean', const: true },
          },
        },
        MediaAsset: {
          type: 'object',
          required: ['url', 'path', 'public_id', 'width', 'height', 'format'],
          properties: {
            url: { type: 'string', format: 'uri' },
            path: { type: 'string', format: 'uri' },
            public_id: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            format: { type: 'string', enum: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
          },
        },
        MediaBase64Input: {
          type: 'object',
          required: ['filename', 'content_base64'],
          properties: {
            filename: {
              type: 'string',
              description: 'Name with an allowed extension: .jpg, .jpeg, .png, .webp or .gif.',
            },
            content_base64: {
              type: 'string',
              description: 'Base64 image data. An optional data:image/<type>;base64, prefix is accepted.',
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/health': {
        get: {
          operationId: 'getHealth',
          summary: 'Health check',
          security: [],
          responses: {
            200: jsonOk({
              type: 'object',
              required: ['status', 'timestamp', 'version'],
              properties: {
                status: { type: 'string', const: 'ok' },
                timestamp: { type: 'string', format: 'date-time' },
                version: { type: 'string' },
              },
            }),
            503: errorResponse('Agent API disabled'),
          },
        },
      },
      '/manifest': {
        get: {
          operationId: 'getManifest',
          summary: 'Agent API manifest',
          security: [],
          responses: {
            200: jsonOk({ type: 'object' }),
            503: errorResponse('Agent API disabled'),
          },
        },
      },
      '/openapi.json': {
        get: {
          operationId: 'getOpenApi',
          summary: 'Raw OpenAPI 3.1 document',
          security: [],
          responses: {
            200: {
              description: 'OpenAPI document, not wrapped in the success envelope',
              content: { [JSON_CONTENT]: { schema: { type: 'object' } } },
            },
            503: errorResponse('Agent API disabled'),
          },
        },
      },
      '/me': {
        get: {
          operationId: 'getMe',
          summary: 'Current API key identity',
          security: [{ bearerAuth: [] }],
          responses: {
            200: jsonOk({
              type: 'object',
              required: ['id', 'name', 'prefix', 'owner', 'scopes'],
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                prefix: { type: 'string' },
                owner: {
                  type: 'object',
                  properties: {
                    username: { type: 'string' },
                    role: { type: 'string', enum: ['admin', 'editor'] },
                  },
                },
                scopes: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Scope' },
                },
                expires_at: { type: ['string', 'null'], format: 'date-time' },
                rate_limits: { type: 'object' },
              },
            }),
            401: errorResponse('Missing or invalid API key'),
            403: errorResponse('Scope not permitted for the key owner'),
            429: errorResponse('Rate limit exceeded'),
            503: errorResponse('Agent API disabled'),
          },
        },
      },

      '/articles': {
        get: {
          operationId: 'listArticles',
          summary: 'List articles',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'articles:read',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'per_page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
            { name: 'category', in: 'query', description: 'Category slug', schema: { type: 'string' } },
            { name: 'featured', in: 'query', schema: { type: 'boolean' } },
            { name: 'q', in: 'query', description: 'Title/excerpt search', schema: { type: 'string' } },
            { name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/ArticleListData' }, {
              type: 'object',
              properties: {
                total: { type: 'integer' },
                page: { type: 'integer' },
                per_page: { type: 'integer' },
                total_pages: { type: 'integer' },
              },
            }),
            ...articleErrorResponses(),
          },
        },
        post: {
          operationId: 'createArticle',
          summary: 'Create an article',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'articles:write',
          parameters: [IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/ArticleWriteInput' } } },
          },
          responses: {
            201: jsonCreated(articleDetailSchema()),
            ...articleErrorResponses(),
          },
        },
      },

      '/articles/by-slug/{slug}': {
        get: {
          operationId: 'getArticleBySlug',
          summary: 'Get an article by slug',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'articles:read',
          parameters: [pathSlugParameter()],
          responses: {
            200: jsonOk(articleDetailSchema()),
            ...articleErrorResponses(),
          },
        },
      },

      '/articles/{id}': {
        get: {
          operationId: 'getArticle',
          summary: 'Get an article by id',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'articles:read',
          parameters: [pathIdParameter()],
          responses: {
            200: jsonOk(articleDetailSchema()),
            ...articleErrorResponses(),
          },
        },
        patch: {
          operationId: 'updateArticle',
          summary: 'Partially update an article',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'articles:write',
          parameters: [pathIdParameter(), IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/ArticlePatchInput' } } },
          },
          responses: {
            200: jsonOk(articleDetailSchema()),
            ...articleErrorResponses(),
          },
        },
        delete: {
          operationId: 'deleteArticle',
          summary: 'Delete an article',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'articles:delete',
          parameters: [
            pathIdParameter(),
            IDEMPOTENCY_PARAMETER,
            headerParameter('X-Confirm-Delete', 'Must be true or 1', true),
          ],
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/ArticleDeleteData' }),
            400: errorResponse('Invalid id or missing confirmation header'),
            ...articleErrorResponses(),
          },
        },
      },

      '/articles/validate': {
        post: {
          operationId: 'validateArticle',
          summary: 'Validate an article payload without writing',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'articles:write',
          parameters: [IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/ArticleWriteInput' } } },
          },
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/ArticleValidateData' }),
            ...articleErrorResponses(),
          },
        },
      },

      '/articles/upsert': {
        post: {
          operationId: 'upsertArticle',
          summary: 'Create or update an article by slug',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'articles:write',
          parameters: [IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/ArticleWriteInput' } } },
          },
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/ArticleUpsertData' }),
            201: jsonCreated({ $ref: '#/components/schemas/ArticleUpsertData' }),
            ...articleErrorResponses(),
          },
        },
      },

      '/categories': {
        get: {
          operationId: 'listCategories',
          summary: 'List categories',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'categories:read',
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/CategoryListData' }),
            ...resourceErrorResponses(),
          },
        },
        post: {
          operationId: 'createCategory',
          summary: 'Create a category',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'categories:write',
          parameters: [IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/CategoryWriteInput' } } },
          },
          responses: {
            201: jsonCreated({ $ref: '#/components/schemas/Category' }),
            ...resourceErrorResponses(),
          },
        },
      },

      '/categories/{id}': {
        get: {
          operationId: 'getCategory',
          summary: 'Get a category by id',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'categories:read',
          parameters: [pathResourceIdParameter('Positive category id')],
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/Category' }),
            ...resourceErrorResponses(),
          },
        },
        patch: {
          operationId: 'updateCategory',
          summary: 'Partially update a category',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'categories:write',
          parameters: [pathResourceIdParameter('Positive category id'), IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/CategoryPatchInput' } } },
          },
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/Category' }),
            ...resourceErrorResponses(),
          },
        },
        delete: {
          operationId: 'deleteCategory',
          summary: 'Delete a category',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'categories:delete',
          parameters: [
            pathResourceIdParameter('Positive category id'),
            IDEMPOTENCY_PARAMETER,
            headerParameter('X-Confirm-Delete', 'Must be true or 1', true),
          ],
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/CategoryDeleteData' }),
            ...resourceErrorResponses(),
          },
        },
      },

      '/seo-pages': {
        get: {
          operationId: 'listSeoPages',
          summary: 'List the 18 official SEO pages',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'seo:read',
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/SeoPageListData' }),
            ...resourceErrorResponses(),
          },
        },
      },

      '/seo-pages/{pageKey}': {
        get: {
          operationId: 'getSeoPage',
          summary: 'Get one SEO page with faqs',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'seo:read',
          parameters: [pathPageKeyParameter()],
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/SeoPage' }),
            ...resourceErrorResponses(),
          },
        },
        put: {
          operationId: 'upsertSeoPage',
          summary: 'Create or update an SEO page and replace its faqs',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'seo:write',
          parameters: [pathPageKeyParameter(), IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/SeoPageInput' } } },
          },
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/SeoPage' }),
            ...resourceErrorResponses(),
          },
        },
        delete: {
          operationId: 'deleteSeoPage',
          summary: 'Delete an SEO page and its faqs',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'seo:delete',
          parameters: [
            pathPageKeyParameter(),
            IDEMPOTENCY_PARAMETER,
            headerParameter('X-Confirm-Delete', 'Must be true or 1', true),
          ],
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/SeoPageDeleteData' }),
            ...resourceErrorResponses(),
          },
        },
      },

      '/redirects': {
        get: {
          operationId: 'listRedirects',
          summary: 'List redirects',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'redirects:read',
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/RedirectListData' }),
            ...resourceErrorResponses(),
          },
        },
        post: {
          operationId: 'createRedirect',
          summary: 'Create a redirect',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'redirects:write',
          parameters: [IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/RedirectInput' } } },
          },
          responses: {
            201: jsonCreated({ $ref: '#/components/schemas/Redirect' }),
            ...resourceErrorResponses(),
          },
        },
      },

      '/redirects/{id}': {
        get: {
          operationId: 'getRedirect',
          summary: 'Get a redirect by id',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'redirects:read',
          parameters: [pathResourceIdParameter('Positive redirect id')],
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/Redirect' }),
            ...resourceErrorResponses(),
          },
        },
        patch: {
          operationId: 'updateRedirect',
          summary: 'Partially update a redirect',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'redirects:write',
          parameters: [pathResourceIdParameter('Positive redirect id'), IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/RedirectPatchInput' } } },
          },
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/Redirect' }),
            ...resourceErrorResponses(),
          },
        },
        delete: {
          operationId: 'deleteRedirect',
          summary: 'Delete a redirect',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'redirects:delete',
          parameters: [
            pathResourceIdParameter('Positive redirect id'),
            IDEMPOTENCY_PARAMETER,
            headerParameter('X-Confirm-Delete', 'Must be true or 1', true),
          ],
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/RedirectDeleteData' }),
            ...resourceErrorResponses(),
          },
        },
      },

      '/contacts': {
        get: {
          operationId: 'listContacts',
          summary: 'List contact messages',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'contacts:read',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'per_page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
            { name: 'unread', in: 'query', description: 'true (or 1) returns unread messages only', schema: { type: 'boolean' } },
          ],
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/ContactListData' }, {
              type: 'object',
              properties: {
                total: { type: 'integer' },
                unread: { type: 'integer' },
                page: { type: 'integer' },
                per_page: { type: 'integer' },
                total_pages: { type: 'integer' },
              },
            }),
            ...resourceErrorResponses(),
          },
        },
        post: {
          operationId: 'createContact',
          summary: 'Store a contact message and attempt email delivery',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'contacts:write',
          parameters: [IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/ContactCreateInput' } } },
          },
          responses: {
            201: jsonCreated({ $ref: '#/components/schemas/ContactCreateData' }),
            ...resourceErrorResponses(),
          },
        },
      },

      '/contacts/{id}': {
        get: {
          operationId: 'getContact',
          summary: 'Get a contact message by id',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'contacts:read',
          parameters: [pathResourceIdParameter('Positive contact id')],
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/Contact' }),
            ...resourceErrorResponses(),
          },
        },
        patch: {
          operationId: 'updateContact',
          summary: 'Update only the read flag of a contact message',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'contacts:write',
          parameters: [pathResourceIdParameter('Positive contact id'), IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: { [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/ContactPatchInput' } } },
          },
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/Contact' }),
            ...resourceErrorResponses(),
          },
        },
        delete: {
          operationId: 'deleteContact',
          summary: 'Permanently delete a contact message',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'contacts:delete',
          parameters: [
            pathResourceIdParameter('Positive contact id'),
            IDEMPOTENCY_PARAMETER,
            headerParameter('X-Confirm-Delete', 'Must be true or 1', true),
          ],
          responses: {
            200: jsonOk({ $ref: '#/components/schemas/ContactDeleteData' }),
            ...resourceErrorResponses(),
          },
        },
      },

      '/media': {
        post: {
          operationId: 'uploadMedia',
          summary: 'Upload an image (multipart or JSON base64)',
          security: [{ bearerAuth: [] }],
          'x-required-scope': 'media:write',
          parameters: [IDEMPOTENCY_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['image'],
                  properties: {
                    image: {
                      type: 'string',
                      format: 'binary',
                      description: 'JPEG, PNG, WebP or GIF. 5MB maximum.',
                    },
                  },
                },
              },
              [JSON_CONTENT]: { schema: { $ref: '#/components/schemas/MediaBase64Input' } },
            },
          },
          responses: {
            201: jsonCreated({ $ref: '#/components/schemas/MediaAsset' }),
            502: errorResponse('Image upload service is temporarily unavailable'),
            ...resourceErrorResponses(),
          },
        },
      },
    },
  };
}

module.exports = { buildOpenApi };
