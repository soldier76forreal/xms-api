// Server-side feature flags — the backend mirror of xms/src/tools/featureFlags.js.
//
// Each flag reads an environment variable but has a CODE DEFAULT, so a deployment
// behaves correctly with no .env entry at all. Set the variable only to override.

// Turn a value from the environment into a boolean. Anything unset or empty keeps
// the code default, so a stray `WEBSITE_API_ENABLED=` line cannot silently flip it.
function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBSITE_API_ENABLED — everything this API exists to serve the PUBLIC WEBSITE.
//
// OFF (the default) means XMS runs as a self-contained management panel: the
// public Next.js site (website/) is not deployed, so the API should not be
// carrying its endpoints, its unauthenticated surface, or its background work.
//
// What it switches off, all in server.js:
//   · /public/website          the whole unauthenticated visitor API (catalog
//                              browsing, e-mail OTP, the customer dashboard,
//                              offer accept, the analytics ingest) + its two
//                              dedicated rate limiters
//   · /price-requests          website purchase requests and the offers that
//                              answer them — and with it the once-a-minute
//                              offer-expiry sweep, which only starts because
//                              routes/priceRequests/main.js is loaded
//   · /digitalMarketing/blog             the website's blog CMS
//   · /digitalMarketing/product-content  the website's product pages + preview
//   · /digitalMarketing/analytics        the website traffic/outcome reports
//
// Nothing is deleted. The routers, models, templates and utilities are all still
// here; they are simply not loaded, so a flip of this one value brings the whole
// website side back. The matching UI switch is WEBSITE_FEATURES_ENABLED in
// xms/src/tools/featureFlags.js — keep the two in step, or the app will offer
// screens whose endpoints answer 503.
//
// NOT affected (these are core XMS, not website): CRM, MIS invoices/quotations/
// packing lists, Inventory, Supply, Users/RBAC, File Manager, Tutorials, the rest
// of Digital Marketing (raw contents, ready to upload, link pages, WhatsApp share)
// and every shared dependency such as sharp or ffmpeg.
const WEBSITE_API_ENABLED = envFlag('WEBSITE_API_ENABLED', false);

module.exports = { WEBSITE_API_ENABLED, envFlag };
