// Session 72 — Puppeteer plumbing extracted verbatim from routes/mis/invoices.js
// (installed with PUPPETEER_SKIP_DOWNLOAD — bundled Chromium download was
// blocked, so this launches the SYSTEM Chrome/Edge instead). Shared by the
// invoice/quotation PDF route AND the new packing-list/pallet-label routes —
// one headless browser instance for all of them instead of two independent ones.
const fs = require('fs');
let _browserPromise = null;

function resolveChromePath() {
  // IMPORTANT: never fall back to snap-packaged Chromium. Snap confinement breaks
  // Chrome's DevTools pipe so the browser launches but hangs at
  // "Target.setDiscoverTargets timed out" during the CDP handshake. On Ubuntu
  // BOTH /snap/bin/chromium AND /usr/bin/chromium[-browser] are usually snap
  // wrappers, so we only accept a real .deb Google Chrome here; otherwise we
  // return null and let Puppeteer use its OWN managed Chromium (install it on the
  // server with:  npx puppeteer browsers install chrome).
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,             // explicit override wins
    'C:/Program Files/Google/Chrome/Application/chrome.exe',        // local dev (win)
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome-stable',   // real .deb Chrome (apt install google-chrome-stable)
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null; // → Puppeteer's own managed Chromium (never snap)
}

function getBrowser() {
  if (!_browserPromise) {
    // puppeteer v25 is ESM-only — dynamic import() is the CommonJS-safe way in
    const executablePath = resolveChromePath();
    _browserPromise = import('puppeteer')
      .then((mod) => (mod.default || mod).launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        // Default WebSocket transport (NOT pipe). pipe:true got Chrome to launch
        // but then hung the CDP handshake ("Target.setDiscoverTargets timed out")
        // on this server — the DevTools pipe fds don't complete here. The
        // original reason for pipe (a snap-Chromium WS-endpoint timeout) is gone
        // now that a real, non-snap Chrome is installed, so standard WS works.
        timeout: 90000,
        protocolTimeout: 180000,
        // --disable-dev-shm-usage: default /dev/shm is too small on most VPS/
        // containers; --disable-gpu is standard for headless servers. This is the
        // standard, widely-proven server arg set — no exotic flags.
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      }))
      .then((browser) => {
        // If the shared browser dies (crash / lost pipe), drop the cached promise
        // so the NEXT render relaunches a fresh one instead of reusing a dead
        // handle — a dead singleton was 500ing ("Failed to generate PDF") on
        // every subsequent request even though the first one had downloaded fine.
        browser.on('disconnected', () => { _browserPromise = null; });
        return browser;
      })
      .catch((err) => { _browserPromise = null; throw err; });
  }
  return _browserPromise;
}

// pdfOptions defaults to A4 — every pre-Session-72 call site (single-arg,
// invoice/quotation) keeps rendering byte-for-byte the same. The new packing-
// list/label routes pass a custom size (labels aren't A4).
async function renderPdfBuffer(html, pdfOptions = { format: 'A4', printBackground: true }) {
  // Retry once with a fresh browser: if the shared instance died between renders
  // the first newPage/pdf call throws "Target/Protocol closed" — relaunch and
  // try again so a transient browser death doesn't surface as a failed download.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      // 'load' not 'networkidle0' — the template is fully inline (no external
      // resources; CSP-safe), and networkidle0 is known to hang with setContent
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf(pdfOptions);
      await page.close().catch(() => {});
      return pdf;
    } catch (err) {
      lastErr = err;
      if (page) await page.close().catch(() => {});
      _browserPromise = null;   // force a clean relaunch on the retry
    }
  }
  throw lastErr;
}

module.exports = { renderPdfBuffer, resolveChromePath, getBrowser };
