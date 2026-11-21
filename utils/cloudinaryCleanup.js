// backend/utils/cloudinaryCleanup.js
//
// Safe garbage collection for images uploaded through the admin dashboard.
//
// Rules (do not weaken — a wrong delete 404s a live page):
//   1. Only assets under our own Cloudinary folder (CLOUDINARY_FOLDER) on our
//      own cloud (CLOUDINARY_CLOUD_NAME) are ever considered.
//   2. An asset still referenced by ANY DB row is skipped: articles.cover_image,
//      articles.og_image, articles.content (LIKE), page_seo.og_image (LIKE).
//      Cross-page reuse is extremely common here, so this is the main guard.
//   3. An asset must carry the CLEANUP_TAG. Images uploaded before tagging
//      existed (and the frontend's static gallery registry, which is not in the
//      DB at all) are untagged, so they can never be destroyed by this module.
//   4. Cleanup ALWAYS runs after the DB write committed and NEVER throws:
//      a Cloudinary failure must not turn a successful save into a 500.
//
// Config is read lazily from env; nothing connects at require time (same policy
// as routes/upload.js). Tests inject a fake via __setCloudinaryForTests, which
// is refused in production.

const CLEANUP_TAG = 'purisunny-app';

const CLOUDINARY_HOST = 'res.cloudinary.com';

// Transform params that can appear as their own path segment, e.g. `c_fill`,
// `w_800`, `fl_progressive`. A segment with a comma (`w_400,h_300`) or with
// several params is treated as a transformation too.
const TRANSFORM_PARAM_RE = /^(?:a|ac|af|ar|b|bo|br|c|co|d|dl|dn|dpr|du|e|eo|f|fl|fn|fps|g|h|l|o|p|pg|q|r|so|sp|t|u|vc|vs|w|x|y|z)_/;
const VERSION_RE = /^v\d+$/;

// ---------------------------------------------------------------------------
// Cloudinary client (lazy, config only when every env key is present)
// ---------------------------------------------------------------------------

let cloudinaryClient = null;

function readCloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true };
}

// Returns the v2 SDK (configured once) or null when env is incomplete.
function getCloudinary() {
  if (cloudinaryClient) return cloudinaryClient;
  const config = readCloudinaryConfig();
  if (!config) return null;
  const cloudinary = require('cloudinary').v2;
  cloudinary.config(config);
  cloudinaryClient = cloudinary;
  return cloudinaryClient;
}

// Test-only seam, refused in production (same pattern as
// routes/contact.js __setMailerForTests). Pass null to restore the real client.
function __setCloudinaryForTests(fake) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__setCloudinaryForTests is not available in production');
  }
  if (fake === null || fake === undefined) {
    cloudinaryClient = null;
    return;
  }
  if (typeof fake !== 'object') {
    throw new Error('Cloudinary fake must be an object');
  }
  cloudinaryClient = fake;
}

function resetClientCache() {
  cloudinaryClient = null;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

function currentFolder() {
  return process.env.CLOUDINARY_FOLDER || 'purisunny';
}

function isTransformSegment(segment) {
  if (!segment) return false;
  if (segment.includes(',')) return true;
  return TRANSFORM_PARAM_RE.test(segment);
}

// https://res.cloudinary.com/<cloud>/image/upload/[<transform>/][v<digits>/]<public_id>[.<ext>]
// -> '<public_id>' (no extension) when it lives under our folder, else null.
function extractCloudinaryPublicId(url) {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.hostname !== CLOUDINARY_HOST) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // Cloud name must match ours exactly (case-sensitive per Cloudinary).
  if (segments[0] !== cloudName) return null;
  // Delivery type / resource type prefix.
  if (segments[1] !== 'image' || segments[2] !== 'upload') return null;

  let rest = segments.slice(3);
  // Leading transformations can occupy several segments (e.g. c_fill/w_800).
  while (rest.length > 0 && isTransformSegment(rest[0])) {
    rest = rest.slice(1);
  }
  // Then a version marker.
  if (rest.length > 0 && VERSION_RE.test(rest[0])) {
    rest = rest.slice(1);
  }
  if (rest.length === 0) return null;

  // The public id keeps its folder segments; only the last segment's extension
  // is dropped (Cloudinary ids may contain dots before the extension).
  const lastIndex = rest.length - 1;
  const last = rest[lastIndex];
  const dot = last.lastIndexOf('.');
  const lastWithoutExt = dot > 0 ? last.slice(0, dot) : last;
  const publicId = [...rest.slice(0, lastIndex), lastWithoutExt].join('/');

  const folder = currentFolder();
  if (!publicId.startsWith(`${folder}/`)) return null;
  if (publicId.length <= folder.length + 1) return null;

  return publicId;
}

// All URLs in `src="..."` attributes of an HTML fragment: deduped, in document
// order. Returns [] for null/empty input.
function extractContentImageUrls(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const found = [];
  const seen = new Set();
  const re = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const value = (match[1] !== undefined ? match[1] : match[2] || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    found.push(value);
  }
  return found;
}

// ---------------------------------------------------------------------------
// DB reference check
// ---------------------------------------------------------------------------

// True when any article/page_seo row still points at this public id.
async function isStillReferenced(database, publicId) {
  const like = `%${publicId}%`;
  const [cover, og, content, pageOg] = await Promise.all([
    database.query('SELECT 1 FROM articles WHERE cover_image LIKE ? LIMIT 1', [like]),
    database.query('SELECT 1 FROM articles WHERE og_image LIKE ? LIMIT 1', [like]),
    database.query('SELECT 1 FROM articles WHERE content LIKE ? LIMIT 1', [like]),
    database.query('SELECT 1 FROM page_seo WHERE og_image LIKE ? LIMIT 1', [like]),
  ]);
  return [cover, og, content, pageOg].some(([rows]) => rows && rows.length > 0);
}

// Fetches tags for `ids`; returns the subset that carries CLEANUP_TAG.
// IMPORTANT: resources_by_ids omits `tags` unless asked. Without the options
// argument every asset looks untagged and cleanup would never delete anything
// (verified against the live API: tags === undefined by default).
async function filterTagged(cloudinaryApi, ids) {
  if (ids.length === 0) return [];
  let response;
  try {
    response = await cloudinaryApi.resources_by_ids(ids, { tags: true });
  } catch (err) {
    console.error('[cleanup] tag lookup failed', (err && err.http_code) || '');
    return [];
  }
  const resources = response && Array.isArray(response.resources) ? response.resources : [];
  const tagged = new Set();
  for (const resource of resources) {
    if (!resource || typeof resource.public_id !== 'string') continue;
    const tags = Array.isArray(resource.tags) ? resource.tags : [];
    if (tags.includes(CLEANUP_TAG)) tagged.add(resource.public_id);
  }
  return ids.filter((id) => tagged.has(id));
}

/**
 * Deletes the given candidate asset URLs when they are ours, unreferenced and
 * tagged. Never throws.
 *
 * @param {string[]} candidateUrls URLs (or HTML is NOT accepted) to consider.
 * @returns {Promise<{destroyed: number, skipped: number}>}
 */
async function cleanupCloudinaryAssets(candidateUrls, options = {}) {
  const result = { destroyed: 0, skipped: 0 };
  try {
    if (!Array.isArray(candidateUrls) || candidateUrls.length === 0) return result;

    const cloudinary = cloudinaryClient || getCloudinary();
    if (!cloudinary) {
      // Env incomplete (or plain unit test without a fake): nothing to do.
      return result;
    }

    // 1. Unique public ids under our folder.
    const ids = [];
    const seen = new Set();
    for (const url of candidateUrls) {
      const publicId = extractCloudinaryPublicId(url);
      if (!publicId || seen.has(publicId)) continue;
      seen.add(publicId);
      ids.push(publicId);
    }
    if (ids.length === 0) return result;

    // 2. Drop anything the database still references. `options.db` is the seam
    // used by unit tests; production uses the real pool.
    const database = options.db || require('../config/db');
    const unreferenced = [];
    for (const id of ids) {
      try {
        if (await isStillReferenced(database, id)) continue;
      } catch (err) {
        // Fail safe: an unknown reference state means "do not delete".
        console.error('[cleanup] reference check failed', (err && err.code) || '');
        continue;
      }
      unreferenced.push(id);
    }
    result.skipped = ids.length - unreferenced.length;

    // 3. Only assets uploaded through the dashboard carry the tag.
    const api = cloudinary.api || {};
    if (typeof api.resources_by_ids !== 'function' || typeof api.delete_resources !== 'function') {
      result.skipped += unreferenced.length;
      console.error('[cleanup] Cloudinary admin API unavailable');
      return result;
    }
    const tagged = await filterTagged(api, unreferenced);
    result.skipped += unreferenced.length - tagged.length;

    if (tagged.length === 0) {
      if (result.skipped > 0) console.log(`[cleanup] skipped ${result.skipped} referenced/untagged`);
      return result;
    }

    // 4. Batch delete.
    let deletion;
    try {
      deletion = await api.delete_resources(tagged);
    } catch (err) {
      console.error('[cleanup] delete failed', (err && err.http_code) || '');
      result.skipped += tagged.length;
      return result;
    }

    // A "deleted" entry may carry a non-"ok" status (not found, etc.).
    const perId = (deletion && deletion.deleted) || {};
    const destroyedIds = tagged.filter((id) => {
      const status = perId[id];
      return status === undefined || status === 'deleted' || status === 'ok';
    });
    result.destroyed += destroyedIds.length;
    result.skipped += tagged.length - destroyedIds.length;

    if (destroyedIds.length > 0) {
      console.log(`[cleanup] destroyed ${destroyedIds.length} asset(s): ${destroyedIds.join(', ')}`);
    }
    if (result.skipped > 0) console.log(`[cleanup] skipped ${result.skipped} referenced/untagged`);
    return result;
  } catch (err) {
    // Absolute backstop: cleanup must never break the caller's request.
    console.error('[cleanup] unexpected failure', (err && err.http_code) || '');
    return result;
  }
}

module.exports = {
  CLEANUP_TAG,
  extractCloudinaryPublicId,
  extractContentImageUrls,
  cleanupCloudinaryAssets,
  __setCloudinaryForTests,
  resetClientCache,
};
