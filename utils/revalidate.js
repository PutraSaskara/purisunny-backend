// On-demand revalidation helper.
//
// After an article / SEO page / redirect mutation succeeds, notify the Next.js
// frontend so it can invalidate cached data immediately instead of waiting for
// the default ISR window (~5 minutes).
//
// This is intentionally fire-and-forget: an unreachable or slow frontend must
// never fail (or delay) the write itself. Uses the global fetch available in
// Node 18+ so no extra dependency is required.
//
// Contract with POST /api/revalidate (frontend/app/api/revalidate/route.js):
//   { slug }                      -> article: detail page + journal LIST pages
//   { slug, type: 'page' }        -> SEO page_key
//   { type: 'redirect' }          -> redirect map (no slug); invalidates the
//                                    frontend cache tag `redirects`, which backs
//                                    its from_path -> to_path lookup used before
//                                    rendering a 404.
// `type` is restricted to the fixed enum below; anything else would make the
// frontend reject the call with 400. A 'redirect' payload carries no slug, so
// `slug` is optional for that type only (see triggerRedirectRevalidateSafe).

const FRONTEND_INTERNAL_URL = (process.env.FRONTEND_INTERNAL_URL || 'http://localhost:3000').replace(/\/+$/, '');
const REVALIDATE_SECRET = process.env.REVALIDATE_SECRET;
const REVALIDATE_TIMEOUT_MS = 3000;

// Keep in sync with the enum in frontend/app/api/revalidate/route.js.
const REVALIDATE_TYPES = Object.freeze(['article', 'page', 'redirect']);

async function postRevalidate(payload) {
  if (!REVALIDATE_SECRET) {
    console.warn('[revalidate] REVALIDATE_SECRET is not set; skipping revalidation');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVALIDATE_TIMEOUT_MS);

  try {
    const response = await fetch(`${FRONTEND_INTERNAL_URL}/api/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-revalidate-secret': REVALIDATE_SECRET,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const label = payload.slug
      ? `slug "${payload.slug}"`
      : `type "${payload.type}"`;

    if (response.ok) {
      console.log(`[revalidate] Revalidated ${label}${payload.type ? ` type="${payload.type}"` : ''} (status ${response.status})`);
    } else {
      console.warn(`[revalidate] Revalidation for ${label}${payload.type ? ` type="${payload.type}"` : ''} returned status ${response.status}`);
    }
  } catch (error) {
    console.warn(`[revalidate] Revalidation for ${JSON.stringify(payload)} failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function triggerRevalidate(slug, type) {
  if (!slug || typeof slug !== 'string') {
    return;
  }

  if (type !== undefined && type !== null && !REVALIDATE_TYPES.includes(type)) {
    console.warn(`[revalidate] Unsupported revalidate type "${type}"; skipping (allowed: ${REVALIDATE_TYPES.join(', ')})`);
    return;
  }

  // Articles send { slug } (type omitted for backward compatibility with the
  // original contract), pages send { slug, type: 'page' }.
  const payload = type ? { slug, type } : { slug };
  await postRevalidate(payload);
}

// Redirect mutations send { type: 'redirect' } — the frontend has no per-slug
// redirect cache, only the `redirects` tag covering the whole map.
async function triggerRedirectRevalidate() {
  await postRevalidate({ type: 'redirect' });
}

// Fire-and-forget wrapper: resolves immediately and never throws into the
// caller's request flow.
function triggerRevalidateSafe(slug, type) {
  Promise.resolve()
    .then(() => triggerRevalidate(slug, type))
    .catch((error) => {
      console.warn(`[revalidate] Unexpected revalidation error: ${error.message}`);
    });
}

function triggerRedirectRevalidateSafe() {
  Promise.resolve()
    .then(() => triggerRedirectRevalidate())
    .catch((error) => {
      console.warn(`[revalidate] Unexpected redirect revalidation error: ${error.message}`);
    });
}

module.exports = {
  triggerRevalidate,
  triggerRevalidateSafe,
  triggerRedirectRevalidate,
  triggerRedirectRevalidateSafe,
  REVALIDATE_TYPES,
};
