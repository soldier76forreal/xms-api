// One-off diagnostic for the "TimeoutError: Timed out ... waiting for the WS
// endpoint URL" PDF failure. Puppeteer's own error swallows Chrome's real
// stderr in this failure mode, so this script bypasses Puppeteer's launch
// handshake and runs each candidate Chrome/Chromium binary directly the same
// way it would be spawned in production, printing whatever it actually says.
//
// Run ON THE SERVER: node scripts/diagnosePdf.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
].filter(Boolean);

console.log('── Candidate paths ──────────────────────────────────');
const found = [];
for (const p of CANDIDATES) {
  const exists = fs.existsSync(p);
  console.log(`${exists ? '[found]  ' : '[missing]'} ${p}`);
  if (exists) {
    found.push(p);
    try {
      const real = fs.realpathSync(p);
      if (real !== p) console.log(`           -> resolves to ${real}`);
      if (real.includes('/snap/')) {
        console.log('           WARNING: this is a snap package. Snap-confined Chromium');
        console.log('           commonly fails/hangs when spawned by a background service');
        console.log('           (pm2/systemd) instead of an interactive desktop session.');
      }
    } catch (_) {}
  }
}

if (found.length === 0) {
  console.log('\nNo candidate binary exists on this machine at all — that IS the bug.');
  console.log('Install one, e.g.: sudo apt install -y chromium  (or google-chrome-stable)');
  process.exit(0);
}

console.log('\n── Direct headless run (bypasses Puppeteer entirely) ─');
for (const p of found) {
  console.log(`\n--- ${p} ---`);
  try {
    const out = execFileSync(
      p,
      ['--headless', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
       '--disable-gpu', '--dump-dom', 'about:blank'],
      { timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    console.log('OK — printed DOM, length', out.length);
  } catch (err) {
    console.log('FAILED');
    console.log('exit code / signal:', err.status, err.signal);
    if (err.stdout) console.log('stdout:', err.stdout.toString().slice(0, 2000));
    if (err.stderr) console.log('stderr:', err.stderr.toString().slice(0, 2000));
    if (!err.stdout && !err.stderr) console.log('error:', err.message);
  }
}

console.log('\n── /dev/shm size (a too-small value is the other common cause) ─');
try {
  console.log(execFileSync('df', ['-h', '/dev/shm'], { encoding: 'utf8' }));
} catch (_) {
  console.log('(df not available / could not check)');
}
