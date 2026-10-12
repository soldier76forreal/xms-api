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
 * Dry run unless --yes. By default it refuses to act on everything at once: name the day
 * (--on) or the exact batch (--at), so one accidental bulk delete is undone without also
 * reviving customers somebody removed on purpose - possibly years earlier. --all overrides
 * that, deliberately.
 *
 * Usage (from api/):
 *   node scripts/restoreSoftDeletedCustomers.js                     what is deleted, and when
 *   node scripts/restoreSoftDeletedCustomers.js --on 2026-07-14     everything deleted that day
 *   node scripts/restoreSoftDeletedCustomers.js --on 2026-07-14 --min-batch 50
 *                                                                   only that day's BULK batches
 *   node scripts/restoreSoftDeletedCustomers.js --on 2026-07-14 --yes
 *   node scripts/restoreSoftDeletedCustomers.js --at "<ts>" --yes   one batch exactly
 *   node scripts/restoreSoftDeletedCustomers.js --all --yes         every one, whenever
 *
 * --on is usually the right one. A bulk delete through the list UI arrives as a run of
 * batches - one per page of records, seconds apart - so --at recovers only one page of it.
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
const onIdx = argv.indexOf('--on');
const ON = onIdx === -1 ? null : argv[onIdx + 1];
// A day can hold both halves of the story: the accidental bulk pages AND a few records
// somebody removed on purpose the same day - a duplicate, a test entry. Those arrive as
// batches of one. --min-batch restores only batches of at least N, so the accident is undone
// without quietly reviving the deliberate removals alongside it.
const minIdx = argv.indexOf('--min-batch');
const MIN_BATCH = minIdx === -1 ? 0 : parseInt(argv[minIdx + 1], 10);
if (minIdx !== -1 && (!Number.isFinite(MIN_BATCH) || MIN_BATCH < 1)) {
  console.error('--min-batch needs a whole number, e.g. --min-batch 50');
  process.exit(1);
}
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

// A bulk delete done through the list UI arrives as a run of batches - one per page of
// records, seconds apart - so a single --at only recovers one page of it. --on takes the
// whole day, which is the natural unit for "undo what happened then" while still leaving
// deletions from other days, possibly years earlier and entirely deliberate, alone.
let onFrom = null; let onTo = null;
if (onIdx !== -1) {
  if (!ON || ON.startsWith('--') || !/^\d{4}-\d{2}-\d{2}$/.test(ON)) {
    console.error('--on needs a day as YYYY-MM-DD, e.g. --on 2026-07-14');
    process.exit(1);
  }
  onFrom = new Date(`${ON}T00:00:00.000Z`);
  onTo = new Date(`${ON}T23:59:59.999Z`);
  if (Number.isNaN(onFrom.getTime())) {
    console.error(`--on is not a day I can read: ${ON}`);
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
  // By DAY first - that is the unit a decision gets made in. A run of batches on one day is
  // one event; a deletion years earlier is somebody removing a customer on purpose.
  const byDay = new Map();
  for (const m of moments) {
    const day = new Date(m._id).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + m.n);
  }
  console.log('\ndeleted on:');
  for (const [day, n] of [...byDay].sort((a, b) => b[1] - a[1])) {
    const batches = moments.filter((m) => new Date(m._id).toISOString().slice(0, 10) === day).length;
    const mark = ON === day ? '  <-- selected' : '';
    console.log(`  ${day}   ${String(n).padStart(6)} record(s) in ${batches} batch(es)${mark}`);
  }

  console.log('\nthe individual batches:');
  for (const m of moments.slice(0, 15)) {
    const mark = atDate && new Date(m._id).getTime() === atDate.getTime() ? '  <-- selected' : '';
    console.log(`  ${new Date(m._id).toISOString()}   ${String(m.n).padStart(6)} record(s)${mark}`);
  }
  if (moments.length > 15) console.log(`  … and ${moments.length - 15} more`);

  // what this run would touch
  let filter;
  if (ALL) {
    filter = { deleteDate: { $ne: null } };
  } else if (onFrom) {
    if (MIN_BATCH) {
      // Only the batches on that day that are big enough to be the bulk operation.
      const keep = moments
        .filter((m) => m._id >= onFrom && m._id <= onTo && m.n >= MIN_BATCH)
        .map((m) => m._id);
      const skipped = moments.filter((m) => m._id >= onFrom && m._id <= onTo && m.n < MIN_BATCH);
      console.log(`\nbatches on ${ON} of ${MIN_BATCH}+ records: ${keep.length}`);
      if (skipped.length) {
        console.log(`leaving ${skipped.length} smaller batch(es) alone (${skipped.reduce((s, m) => s + m.n, 0)} record(s)) —`);
        console.log('those are one-off removals, not part of the bulk operation:');
        for (const m of skipped) console.log(`   ${new Date(m._id).toISOString()}   ${m.n} record(s)`);
      }
      if (!keep.length) {
        console.log('\nNo batch that day reaches that size. Nothing was changed.');
        await conn.close();
        process.exit(1);
      }
      filter = { deleteDate: { $in: keep } };
    } else {
      filter = { deleteDate: { $gte: onFrom, $lte: onTo } };
    }
  } else if (atDate) {
    filter = { deleteDate: atDate };
  } else {
    console.log('\nPick what to restore:');
    console.log('  --on YYYY-MM-DD                          everything deleted that day (usually what you want:');
    console.log('                                           a bulk delete through the list arrives as several');
    console.log('                                           batches seconds apart, and --at catches only one)');
    console.log('  --on YYYY-MM-DD --min-batch 50           the same, but only the BULK batches - leaves');
    console.log('                                           same-day one-off removals (a duplicate, a test');
    console.log('                                           record) deleted, which is usually right');
    console.log('  --at "<timestamp from the list above>"   one batch exactly');
    console.log('  --all                                     every soft-deleted customer, whenever - including');
    console.log('                                           ones removed deliberately years ago');
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
