/**
 * checkTokenSecrets.js — do the two services agree on the signing secret?
 *
 * authApi SIGNS the access token at login. api VERIFIES it on every request. They read the
 * same variable name from two different .env files, and nothing enforces that the values
 * match. When they drift, the symptom is specific and misleading:
 *
 *   · signing in works — that is authApi alone, and it is happy
 *   · every single API call then fails with 401
 *   · the frontend's interceptor tries /auth/refreshToken, which also fails
 *   · screens come up empty, as though the data were gone
 *
 * It is the classic outcome of rotating the secret in one file and not the other.
 *
 * READ ONLY, and it never prints a secret. It compares SHA-256 fingerprints, so the output
 * is safe to paste into a chat or a ticket.
 *
 * Usage (from api/):
 *   node scripts/checkTokenSecrets.js
 *   node scripts/checkTokenSecrets.js --authenv /path/to/authApi/.env
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const authIdx = argv.indexOf('--authenv');
const AUTH_ENV_ARG = authIdx === -1 ? null : argv[authIdx + 1];

const API_ENV = path.join(__dirname, '..', '.env');
// The sibling layout the repos are deployed in; --authenv covers anything else.
const AUTH_CANDIDATES = AUTH_ENV_ARG ? [AUTH_ENV_ARG] : [
  path.join(__dirname, '..', '..', 'authApi', '.env'),
  path.join(__dirname, '..', '..', 'auth', '.env'),
  path.join(__dirname, '..', '..', 'xmsAuth', '.env'),
];

function readEnv(file) {
  if (!fs.existsSync(file)) return null;
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Never the value - a short fingerprint is enough to compare and safe to share.
const fp = (v) => (v ? crypto.createHash('sha256').update(v).digest('hex').slice(0, 12) : null);

const api = readEnv(API_ENV);
if (!api) { console.error(`Cannot read ${API_ENV}`); process.exit(1); }

const authPath = AUTH_CANDIDATES.find((p) => fs.existsSync(p));
const auth = authPath ? readEnv(authPath) : null;

console.log(`api/.env      : ${API_ENV}`);
console.log(`authApi/.env  : ${authPath || 'NOT FOUND'}`);
console.log('');

if (!auth) {
  console.log('Could not find the authApi .env beside this one. Point at it with:');
  console.log('  node scripts/checkTokenSecrets.js --authenv /full/path/to/authApi/.env');
  console.log('');
  console.log(`For reference, api TOKEN_SECRET fingerprint: ${fp(api.TOKEN_SECRET) || '(not set)'}`);
  process.exit(1);
}

let problems = 0;

// ── the one that matters ────────────────────────────────────────────────────
const a = api.TOKEN_SECRET;
const b = auth.TOKEN_SECRET;
console.log('TOKEN_SECRET  (authApi signs the access token, api verifies it)');
console.log(`  api      ${a ? `set, fingerprint ${fp(a)}, ${a.length} chars` : 'NOT SET'}`);
console.log(`  authApi  ${b ? `set, fingerprint ${fp(b)}, ${b.length} chars` : 'NOT SET'}`);
if (!a || !b) {
  problems++;
  console.log('  >>> one of them has no TOKEN_SECRET at all. Tokens cannot work.');
} else if (a !== b) {
  problems++;
  console.log('');
  console.log('  >>> THEY DO NOT MATCH. This is the fault.');
  console.log('      Signing in will work, because that is authApi on its own. Every call to');
  console.log('      the api then returns 401, the frontend tries to refresh, that fails too,');
  console.log('      and every screen comes up empty as though the data had gone.');
  console.log('      Fix: set the SAME value in both .env files, then restart BOTH services.');
  console.log('      Everyone will have to sign in again - tokens issued under the old secret');
  console.log('      stop verifying, which is expected and clears itself.');
} else {
  console.log('  >>> they match.');
}

// ── the refresh-token secret lives only on authApi, which is correct ───────
console.log('');
console.log('Other token secrets (authApi only — api never reads these):');
for (const k of ['TOKEN_SECRET_REF', 'TOKEN_SECRETFORMAIN']) {
  console.log(`  ${k.padEnd(20)} authApi ${auth[k] ? `set, fingerprint ${fp(auth[k])}` : 'not set'}`
    + `${api[k] ? `   (also in api/.env, fingerprint ${fp(api[k])})` : ''}`);
}

// ── and the other thing that silently splits a deployment in two ───────────
console.log('');
console.log('DB_CONNECT (both services must use the SAME database)');
const dbA = api.DB_CONNECT; const dbB = auth.DB_CONNECT;
console.log(`  api      ${dbA ? `fingerprint ${fp(dbA)}` : 'NOT SET'}`);
console.log(`  authApi  ${dbB ? `fingerprint ${fp(dbB)}` : 'NOT SET'}`);
if (dbA && dbB && dbA !== dbB) {
  problems++;
  console.log('  >>> the two services point at DIFFERENT databases. api reads users written by');
  console.log('      authApi, so a user can exist for login and be unknown to every api route.');
} else if (dbA && dbB) {
  console.log('  >>> they match.');
}

console.log('');
console.log(problems ? `${problems} problem(s) found.` : 'Nothing wrong with the secrets or the database on either side.');
console.log('');
console.log('Note: this reads the .env FILES. A process started with its own environment, or');
console.log('under a manager that injects variables, may be running with different values —');
console.log('restarting both services after any change is what makes the files authoritative.');
process.exit(problems ? 1 : 0);
