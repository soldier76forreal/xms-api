/**
 * restoreSoftDeletedCustomers.js — bring soft-deleted customers back into the CRM.
 *
 * The CRM lists `{ deleteDate: null }`. A record with a date in that field is hidden,
 * which is how a single bulk write can empty the list while every record is still
 * sitting in the database.
 *
 * This clears `deleteDate` (back to null). It does NOT delete anything, and it does not
 * touch any other field — `updateDate` is deliberately left as it is, so the evidence of
 * when the records were deleted survives in case it is needed again.
 *
 * Dry run unless --yes. By default it refuses to act on everything at once: pass --at with
 * the timestamp the records were deleted at, so one accidental bulk write is undone without
 * also reviving customers somebody meant to remove. --all overrides that, deliberately.
 *
 * Usage (from api/):
 *   node scripts/restoreSoftDeletedCustomers.js                             what is deleted, and when
 *   node scripts/restoreSoftDeletedCustomers.js --at "2026-07-14T17:02:07.557Z"
 *   node scripts/restoreSoftDeletedCustomers.js --at "<ts>" --yes           restore just those
 *   node scripts/restoreSoftDeletedCustomers.js --all --yes                 restore every one
 *
 * Take a mongodump first if you are unsure. Clearing deleteDate is reversible by hand
 * (set it back), but a backup costs nothing.
 */
'use strict';

const path = require('path');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--yes');
const ALL = argv.includes('--all');
const atIdx = argv.indexOf('--at');
const AT = atIdx === -1 ? null : argv[atIdx + 1];
const dbAt = argv.indexOf('--db');
const DB_OVERRIDE = dbAt === -1 ? null : argv[dbAt + 1];

if (atIdx !== -1 && (!AT || AT.startsWith('--'))) {
  console.error('--at needs a timestamp, e.g. --at "2026-07-14T17:02:07.557Z"');
  process.exit(1);
}
let atDate = null;
if (AT) {
  atDate = new Date(AT);
  if (Number.isNaN(atDate.getTime())) {
    console.error(`--at is not a date I can read: ${AT}`);
    process.exit(1);
  }
}

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (DB_OVERRIDE) process.env.DB_CONNECT = DB_OVERRIDE;
if (!process.env.DB_CONNECT) {
  console.error('DB_CONNECT is not set. Put it in api/.env or pass --db "<mongodb uri>"');
  process.exit(1);
}

const mongoose = require('mongoose');

(async () => {
  const conn = await mongoose.createConnection(process.env.DB_CONNECT).asPromise();
  const db = conn.getClient().db();
  const col = db.collection('customers');

  console.log(`database : ${db.databaseName}`);
  console.log(`mode     : ${APPLY ? 'APPLY' : 'dry run (add --yes to write)'}`);
  console.log('');

  const live = await col.countDocuments({ deleteDate: null });
  const hidden = await col.countDocuments({ deleteDate: { $ne: null } });
  console.log(`customers the CRM can see : ${live}`);
  console.log(`hidden by deleteDate      : ${hidden}`);
  if (!hidden) {
    console.log('\nNothing is soft-deleted. If the CRM is still empty the cause is elsewhere —');
    console.log('run scripts/diagnoseCrmCustomers.js --phone <a user phone>.');
    await conn.close();
    process.exit(0);
  }

  // when, and how many at each moment
  const moments = await col.aggregate([
    { $match: { deleteDate: { $type: 'date' } } },
    { $group: { _id: '$deleteDate', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]).toArray();
  console.log('\ndeleted at:');
  for (const m of moments.slice(0, 10)) {
    const mark = atDate && new Date(m._id).getTime() === atDate.getTime() ? '  <-- selected' : '';
    console.log(`  ${new Date(m._id).toISOString()}   ${String(m.n).padStart(6)} record(s)${mark}`);
  }
  if (moments.length > 10) console.log(`  … and ${moments.length - 10} more moments`);

  // what this run would touch
  let filter;
  if (ALL) {
    filter = { deleteDate: { $ne: null } };
  } else if (atDate) {
    filter = { deleteDate: atDate };
  } else {
    console.log('\nPick what to restore:');
    console.log('  --at "<timestamp from the list above>"   just that bulk operation (preferred)');
    console.log('  --all                                     every soft-deleted customer');
    console.log('\nNothing was changed.');
    await conn.close();
    process.exit(0);
  }

  const n = await col.countDocuments(filter);
  console.log(`\nwould restore: ${n} customer(s)`);
  if (!n) {
    console.log('Nothing matches that selection — check the timestamp against the list above.');
    await conn.close();
    process.exit(1);
  }

  // a couple of them, so it is obvious these are the right records
  const sample = await col.find(filter).limit(3)
    .project({ phoneNumber: 1, 'personalInformation.firstName': 1, 'personalInformation.lastName': 1, 'personalInformation.companyName': 1 })
    .toArray();
  console.log('  for example:');
  for (const s of sample) {
    const p = s.personalInformation || {};
    const who = p.companyName || [p.firstName, p.lastName].filter(Boolean).join(' ') || '(no name)';
    console.log(`    ${String(s.phoneNumber || '—').padEnd(18)} ${who}`);
  }

  if (!APPLY) {
    console.log('\nDry run. Nothing was written. Re-run with --yes to restore them.');
    await conn.close();
    process.exit(0);
  }

  // updateDate is left alone on purpose: it still carries the moment of the deletion,
  // which is the only record of what happened.
  const res = await col.updateMany(filter, { $set: { deleteDate: null } });
  console.log(`\nrestored ${res.modifiedCount} customer(s).`);
  console.log(`the CRM can now see ${await col.countDocuments({ deleteDate: null })}.`);

  const stillHidden = await col.countDocuments({ deleteDate: { $ne: null } });
  if (stillHidden) console.log(`${stillHidden} remain soft-deleted (other timestamps).`);
  console.log('\nIf a scoped (non-admin) user still sees none, the data scope is the next thing');
  console.log('to check — scripts/diagnoseCrmCustomers.js --phone <their phone>.');

  await conn.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
