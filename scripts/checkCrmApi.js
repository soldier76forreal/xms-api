/**
 * checkCrmApi.js — does the running API actually hand the CRM its customers?
 *
 * diagnoseCrmCustomers.js answers "what is in the database and what may this user see".
 * This answers the next question, which is a different one: what does the HTTP API return
 * when the app asks it. Between the two there is only the browser left to blame.
 *
 * READ ONLY. It signs a short-lived token for the user you name (the same way authApi does,
 * with the API's own TOKEN_SECRET), calls GET /crm/customers on the LOCAL port, and reports
 * the status and how many customers came back.
 *
 * Usage (from api/):
 *   node scripts/checkCrmApi.js --phone 09918537814
 *   node scripts/checkCrmApi.js --phone 09918537814 --port 4789
 */
'use strict';

const path = require('path');

const argv = process.argv.slice(2);
const phoneAt = argv.indexOf('--phone');
const PHONE = phoneAt === -1 ? null : argv[phoneAt + 1];
const portAt = argv.indexOf('--port');
const PORT_OVERRIDE = portAt === -1 ? null : argv[portAt + 1];
if (!PHONE || PHONE.startsWith('--')) {
  console.error('Usage: node scripts/checkCrmApi.js --phone <a user phone number> [--port 4789]');
  process.exit(1);
}

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.DB_CONNECT) { console.error('DB_CONNECT is not set'); process.exit(1); }
if (!process.env.TOKEN_SECRET) { console.error('TOKEN_SECRET is not set'); process.exit(1); }

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const PORT = PORT_OVERRIDE || process.env.PORT || 4789;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const conn = await mongoose.createConnection(process.env.DB_CONNECT).asPromise();
  const db = conn.getClient().db();
  const user = await db.collection('users').findOne({ phoneNumber: PHONE });
  if (!user) { console.error(`No user with phone ${PHONE}`); await conn.close(); process.exit(1); }
  const inDb = await db.collection('customers').countDocuments({ deleteDate: null });
  await conn.close();

  console.log(`database     : ${db.databaseName}`);
  console.log(`api          : ${BASE}`);
  console.log(`as user      : ${user.firstName || ''} ${user.lastName || ''} (${PHONE})`);
  console.log(`in the database, not deleted: ${inDb}`);
  console.log('');

  // The same shape authApi issues, so the API's verify middleware accepts it.
  const token = jwt.sign(
    { id: String(user._id), firstName: user.firstName, lastName: user.lastName, access: [], filterMemory: {} },
    process.env.TOKEN_SECRET, { expiresIn: '2m' },
  );
  const headers = { 'auth-token': token, Authorization: `Bearer ${token}` };

  let res;
  try {
    res = await fetch(`${BASE}/crm/customers?limit=200`, { headers });
  } catch (err) {
    console.log(`Could not reach the API on ${BASE} — ${err.message}`);
    console.log('');
    console.log('That is the answer in itself: if nothing is listening there, the app is not');
    console.log('talking to this process. Check the port the API actually started on, and that');
    console.log('the reverse proxy points at it.');
    process.exit(1);
  }

  let body = null;
  try { body = await res.json(); } catch (_) { /* not json */ }
  console.log(`GET /crm/customers -> HTTP ${res.status}`);

  if (res.status === 403) {
    console.log(`  access denied, required: ${body && body.requiredPermission}`);
    console.log('  -> the permission is missing. Run scripts/seedPermissions.js.');
    process.exit(1);
  }
  if (res.status === 401) {
    console.log('  not authenticated — the API rejected a token signed with its own TOKEN_SECRET.');
    console.log('  -> TOKEN_SECRET differs between api/.env and the running process, or between');
    console.log('     api and authApi. They must be identical.');
    process.exit(1);
  }
  if (!res.ok) {
    console.log(`  ${JSON.stringify(body).slice(0, 300)}`);
    process.exit(1);
  }

  const rows = Array.isArray(body) ? body : (body.data || body.customers || []);
  const total = body && (body.total ?? body.count);
  console.log(`  returned ${rows.length} customer(s)${total !== undefined ? ` (total reported: ${total})` : ''}`);
  for (const c of rows.slice(0, 5)) {
    const p = c.personalInformation || {};
    const who = p.companyName || [p.firstName, p.lastName].filter(Boolean).join(' ') || '(no name)';
    console.log(`    ${String(c.phoneNumber || '—').padEnd(18)} ${who}`);
  }

  console.log('');
  if (rows.length) {
    console.log('The API is serving the customers. Nothing is wrong on this side.');
    console.log('So the CRM screen is empty for a reason in the BROWSER:');
    console.log('  · open the CRM, F12 > Network, reload, find the request to /crm/customers');
    console.log('  · check the DOMAIN it goes to. If it is not this server, the deployed frontend');
    console.log('    is pointing at a different API — the usual cause, and it would look exactly');
    console.log('    like missing data.');
    console.log('  · if the request is 200 and carries these rows, the UI is filtering them out:');
    console.log('    clear the CRM filters and the search box.');
  } else {
    console.log('The API answered OK but with no customers, while the database has some.');
    console.log('Re-run scripts/diagnoseCrmCustomers.js --phone ' + PHONE + ' — the data scope is');
    console.log('the only thing that can do that.');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
