// Strips the constructs that matter for stored-XSS out of TipTap-authored
// blog body HTML before it's saved. NOT a full HTML sanitizer (no new
// dependency was approved for this — TipTap itself was the approved addition
// for Phase C) — this is a targeted denylist covering the vectors that
// matter given the real threat model here: a `digitalMarketing:blog:create`
// staff account crafting a raw API request that bypasses the TipTap editor's
// own schema (which never emits <script>/<iframe>/event-handler attributes
// on its own). If a public-facing rich-text field with a broader threat model
// is ever added, revisit with a real allowlist library (e.g. sanitize-html)
// — ask before adding it, per the project's dependency-approval rule.
function sanitizeHtml(html) {
  if (typeof html !== 'string' || !html) return '';
  let out = html;

  // Drop entire dangerous elements, including their content.
  out = out.replace(/<(script|iframe|object|embed|link|style|meta|base)[^>]*>[\s\S]*?<\/\1>/gi, '');
  out = out.replace(/<(script|iframe|object|embed|link|style|meta|base)[^>]*\/?>/gi, '');

  // Strip any on* event-handler attribute (onclick, onerror, onload, ...).
  out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');

  // Neutralize javascript:/vbscript:/data: URIs in href/src attributes.
  out = out.replace(/(href|src)\s*=\s*"(\s*(javascript|vbscript):[^"]*)"/gi, '$1="#"');
  out = out.replace(/(href|src)\s*=\s*'(\s*(javascript|vbscript):[^']*)'/gi, "$1='#'");

  return out;
}

module.exports = { sanitizeHtml };
