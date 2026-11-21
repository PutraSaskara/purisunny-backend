// backend/seed-page-seo.js
//
// LEGACY entry point — kept so existing docs/scripts that call this path keep
// working. The authoritative, idempotent seed now lives in
// scripts/seed-page-seo.js (18 page keys + English FAQs + revalidation).
//
// This forwarder previously held only 2 hard-coded rows with outdated
// descriptions; it no longer writes data itself.

require('./scripts/seed-page-seo');