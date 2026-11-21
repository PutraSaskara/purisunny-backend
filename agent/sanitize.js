// backend/agent/sanitize.js
//
// Server-side HTML sanitisation for content written through the Agent API.
// Legacy admin writes are intentionally NOT sanitised here: the dashboard has
// its own trusted authoring flow, while agent callers are automated and must
// never be able to persist script tags, event handlers or javascript: URLs.

const sanitizeHtml = require('sanitize-html');

const ALLOWED_TAGS = Object.freeze([
  'p', 'br', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li',
  'blockquote',
  'strong', 'em', 'b', 'i',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'code', 'pre', 'hr',
]);

const ALLOWED_ATTRIBUTES = Object.freeze({
  a: ['href', 'title', 'rel', 'target'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  h2: ['id'],
  h3: ['id'],
  h4: ['id'],
});

// Apply the same allowlist to every agent article write (create, patch,
// upsert, validate). Non-string input is treated as empty content.
function sanitizeArticleContent(html) {
  if (typeof html !== 'string' || html === '') return '';
  return sanitizeHtml(html, {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: { ...ALLOWED_ATTRIBUTES },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      a: ['http', 'https', 'mailto'],
      img: ['http', 'https'],
    },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (tagName, attribs) => {
        const next = { ...attribs };
        // External links opened in a new tab must not retain window.opener.
        if (String(next.target || '').toLowerCase() === '_blank') {
          const rel = new Set(String(next.rel || '').split(/\s+/).filter(Boolean));
          rel.add('noopener');
          rel.add('noreferrer');
          next.rel = [...rel].join(' ');
        }
        return { tagName, attribs: next };
      },
    },
  });
}

module.exports = {
  ALLOWED_TAGS,
  ALLOWED_ATTRIBUTES,
  sanitizeArticleContent,
};
