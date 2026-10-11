/**
 * diagnoseCrmCustomers.js — why are customers missing from the CRM list?
 *
 * READ ONLY. It writes nothing and changes nothing. It answers, with counts from
 * the real database, the only four things that can hide a customer:
 *
 *   1. they are not in the `customers` collection at all (an older app kept them
 *      somewhere else, or the launch migration never ran)
 *   2. they are soft-deleted (`deleteDate` set)
 *   3. the signed-in user's CRM data scope is 'mine' or 'group', and the records
 *      have a different owner — or no owner at all, which is what a migration
 *      that did not set one leaves behind
 *   4. they are there and visible, and the problem is in the browser
 *
 * Usage (from api/):
 *   node scripts/diagnoseCrmCustomers.js                      the collection only
 *   node scripts/diagnoseCrmCustomers.js --phone 09xxxxxxxxx  also: what THIS user sees
 */
'use strict';

const path = require('path');

const argv = process.argv.slice(2);
const phoneAt = argv.indexOf('--phone');
const PHONE = phoneAt === -1 ? null : argv[phoneAt + 1];
const dbAt = argv.indexOf('--db');
const DB_OVERRIDE = dbAt === -1 ? null : argv[dbAt + 1];

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (DB_OVERRIDE) process.env.DB_CONNECT = DB_OVERRIDE;
if (!process.env.DB_CONNECT) {
  console.error('DB_CONNECT is not set. Put it in api/.env or pass --db "<mongodb uri>"');
  process.exit(1);
}

const mongoose = require('mongoose');

const line = (s = '') => console.log(s);
const head = (s) => { line(); line(s); line('-'.repeat(s.length)); };

(async () => {
  const conn = await mongoose.createConnection(process.env.DB_CONNECT).asPromise();
  const db = conn.getClient().db();
  line(`database: ${db.databaseName}`);

  // ── 0. where is the data, whatever it is called? ──────────────────────────
  // Matching on the NAME is not enough: an older app may have called the collection
  // something else entirely. Count everything, so a collection holding hundreds of
  // records cannot be missed regardless of what it is named.
  head('Every collection, by document count');
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  const counts = [];
  for (const n of names) counts.push({ n, c: await db.collection(n).countDocuments({}) });
  counts.sort((a, b) => b.c - a.c);
  for (const r of counts.filter((r) => r.c > 0).slice(0, 20)) {
    line(`  ${String(r.c).padStart(7)}  ${r.n}`);
  }
  const empties = counts.filter((r) => r.c === 0).length;
  if (empties) line(`  (${empties} more, all empty)`);

  // ── 1. is there more than one place customers could be? ───────────────────
  head('Collections that could hold customers');
  const candidates = names.filter((n) => /customer|client|contact/i.test(n));
  for (const n of candidates) {
    line(`  ${n.padEnd(28)} ${counts.find((r) => r.n === n).c} documents`);
  }
  if (!candidates.includes('customers')) {
    line('  !! there is no `customers` collection - the CRM reads that one and nothing else');
  }
  for (const n of candidates.filter((n) => n !== 'customers' && n !== 'customeractivities')) {
    const n2 = counts.find((r) => r.n === n).c;
    if (n2) {
      line(`  !! "${n}" holds ${n2} document(s). The CRM reads ONLY "customers" -`);
      line('     Mongoose pluralises the "customer" model to that name. Records anywhere');
      line('     else are invisible to it no matter how correct they look.');
    }
  }

  const col = db.collection('customers');
  const total = await col.countDocuments({});

  // ── 2. soft-deleted? ──────────────────────────────────────────────────────
  head('The customers collection');
  const visible = await col.countDocuments({ deleteDate: null });
  const deleted = await col.countDocuments({ deleteDate: { $ne: null } });
  line(`  total                      ${total}`);
  line(`  the list query can see     ${visible}      (deleteDate null or absent)`);
  line(`  excluded by deleteDate     ${deleted}`);

  // The base filter is {deleteDate: null}, which matches null AND a missing field - but
  // nothing else. An older app that wrote '' or false or 0 there would have every one of
  // its records silently excluded, so show what is actually stored rather than a count.
  if (deleted) {
    const kinds = await col.aggregate([
      { $match: { deleteDate: { $ne: null } } },
      { $group: { _id: { $type: '$deleteDate' }, n: { $sum: 1 }, sample: { $first: '$deleteDate' } } },
      { $sort: { n: -1 } },
    ]).toArray();
    line();
    line('  what those records hold in deleteDate:');
    for (const k of kinds) {
      line(`    ${String(k._id).padEnd(10)} ${String(k.n).padStart(6)}   e.g. ${JSON.stringify(k.sample)}`);
      if (k._id !== 'date') {
        line('      ^^ not a date and not null, so the list filter excludes it. If these are');
        line('         NOT meant to be deleted, clear the field:');
        line(`         db.customers.updateMany({ deleteDate: { $type: "${k._id}" } }, { $set: { deleteDate: null } })`);
      }
    }

    // People delete customers one at a time, so a crowd of records sharing one timestamp
    // to the millisecond is not someone tidying up - it is a single bulk write. Showing the
    // grouping is what separates a deliberate clear-out from something having wiped the list.
    const moments = await col.aggregate([
      { $match: { deleteDate: { $type: 'date' } } },
      { $group: { _id: '$deleteDate', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]).toArray();
    if (moments.length) {
      // By DAY first and in full. Showing only the biggest few moments hides the tail, and
      // the tail is exactly what you need to know: whether every deletion belongs to the
      // same incident or some are older and deliberate.
      const byDay = new Map();
      for (const m of moments) {
        const day = new Date(m._id).toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) || 0) + m.n);
      }
      line();
      line('  which day they were deleted on (every day, nothing hidden):');
      let accounted = 0;
      for (const [day, n] of [...byDay].sort((a, b) => b[1] - a[1])) {
        const batches = moments.filter((m) => new Date(m._id).toISOString().slice(0, 10) === day).length;
        line(`    ${day}   ${String(n).padStart(6)} record(s) in ${batches} batch(es)`);
        accounted += n;
      }
      line(`    ${''.padEnd(10)}  ${String(accounted).padStart(6)} total`);

      line();
      line('  the individual batches, in time order (identical timestamps = one bulk operation):');
      const chrono = [...moments].sort((a, b) => new Date(a._id) - new Date(b._id));
      for (const m of chrono.slice(0, 15)) {
        line(`    ${new Date(m._id).toISOString()}   ${String(m.n).padStart(6)} record(s)`);
      }
      if (moments.length > 15) line(`    … and ${moments.length - 15} more batches`);
      const biggest = moments[0];
      if (biggest.n > 10) {
        line();
        line(`  >>> ${biggest.n} customers share one timestamp to the millisecond. Nobody deletes`);
        line('      that many by hand - one operation did it.');

        // The app's only bulk delete is PUT /crm/customers/bulk {action:'delete'}, and it
        // stamps updatedBy with the caller and writes an activity row naming them. So this
        // is answerable from the data rather than guessed at.
        head('Who did it');
        // Across the whole DAY, not just the biggest batch - a bulk delete through the list
        // arrives as several batches, and attributing only one of them understates it.
        const day = new Date(biggest._id).toISOString().slice(0, 10);
        const dayFrom = new Date(`${day}T00:00:00.000Z`);
        const dayTo = new Date(`${day}T23:59:59.999Z`);
        line(`  looking at everything deleted on ${day}`);
        const actors = await col.aggregate([
          { $match: { deleteDate: { $gte: dayFrom, $lte: dayTo } } },
          { $group: { _id: '$updatedBy', n: { $sum: 1 } } },
          { $sort: { n: -1 } },
        ]).toArray();
        for (const a of actors) {
          if (!a._id) {
            line(`  ${String(a.n).padStart(6)} record(s) have no updatedBy`);
            line('         -> the app always stamps it on a bulk delete, so these were almost');
            line('            certainly changed OUTSIDE the app - a script, or the database directly.');
            continue;
          }
          const u = await db.collection('users').findOne({ _id: a._id });
          const who = u ? `${u.firstName || ''} ${u.lastName || ''} (${u.phoneNumber || 'no phone'})` : 'a user no longer in the database';
          line(`  ${String(a.n).padStart(6)} record(s) by  ${who}`);
          line(`         user id ${a._id}`);
        }

        // the second, independent record of the same event
        // The same day, not a minute around one batch - the batches themselves span longer
        // than a minute, so a tighter window would undercount the very thing being counted.
        const acts = await db.collection('customeractivities').aggregate([
          { $match: { date: { $gte: dayFrom, $lte: dayTo } } },
          { $group: { _id: { actor: '$actorId', name: '$actorName', type: '$type' }, n: { $sum: 1 } } },
          { $sort: { n: -1 } },
          { $limit: 5 },
        ]).toArray();
        line();
        if (acts.length) {
          line('  activity rows written that day (the app logs every change):');
          for (const a of acts) {
            line(`    ${String(a.n).padStart(6)}  ${a._id.type || 'activity'} by ${a._id.name || a._id.actor || 'unknown'}`);
          }
        } else {
          line('  no activity rows were written that day.');
          line('  -> the app writes one per customer on a bulk delete, so their absence means');
          line('     this did NOT go through the app. It was a direct database operation.');
        }

        // Recommend the DAY, not the batch. A bulk delete through the list arrives as a run
        // of batches, so --at would restore one page of it and quietly leave the rest hidden.
        const dayTotal = byDay.get(day);
        const dayBatches = moments.filter((m) => new Date(m._id).toISOString().slice(0, 10) === day).length;
        line();
        line(`  If that was not intended, restore that whole day - ${dayTotal} record(s) across`);
        line(`  ${dayBatches} batch(es). Deletions on OTHER days are left alone, which matters here:`);
        line('  one-at-a-time removals over the years are somebody doing it on purpose.');
        line('        node scripts/restoreSoftDeletedCustomers.js                  (dry run, per-day)');
        line(`        node scripts/restoreSoftDeletedCustomers.js --on ${day} --yes`);
      }
    }
  }

  // ── 3. the shape a legacy record has ──────────────────────────────────────
  head('Shape of what is in there');
  const withOwner = await col.countDocuments({ owner: { $exists: true, $ne: null } });
  const withAssigned = await col.countDocuments({ assignedTo: { $exists: true, $ne: [] } });
  const withPhone = await col.countDocuments({ phoneNumber: { $exists: true, $ne: '' } });
  const withPersonal = await col.countDocuments({ personalInformation: { $exists: true } });
  line(`  have an owner              ${withOwner} of ${total}`);
  line(`  have assignedTo            ${withAssigned} of ${total}`);
  line(`  have a flat phoneNumber    ${withPhone} of ${total}   (the CRM searches this field)`);
  line(`  have personalInformation   ${withPersonal} of ${total}   (name/type/country live here)`);
  if (withOwner < total) {
    line(`  -> ${total - withOwner} record(s) have NO owner. Anyone whose CRM scope is`);
    line('     "mine" or "group" cannot see those, because the filter matches on owner.');
  }
  if (withPhone < total) {
    line(`  -> ${total - withPhone} record(s) have no flat phoneNumber; they still list,`);
    line('     but searching by phone will not find them.');
  }

  const sample = await col.findOne({ deleteDate: null });
  if (sample) {
    line();
    line('  a sample record, field names only:');
    line('    ' + Object.keys(sample).join(', '));
  }

  // ── 4. what one specific user would see ───────────────────────────────────
  if (PHONE) {
    head(`What the user on ${PHONE} sees`);
    const user = await db.collection('users').findOne({ phoneNumber: PHONE });
    if (!user) {
      line('  no user with that phone number');
    } else {
      line(`  user     ${user.firstName || ''} ${user.lastName || ''}  (${user._id})`);
      const access = await db.collection('useraccesses').findOne({ userId: user._id });
      const roleIds = (access && access.roles) || [];
      const roles = roleIds.length
        ? await db.collection('roles').find({ _id: { $in: roleIds } }).toArray() : [];
      line(`  roles    ${roles.map((r) => r.name).join(', ') || '(none)'}`);
      line(`  superAdmin: ${roles.some((r) => r.isSuperAdmin) ? 'yes' : 'no'}`);

      // the CRM scope is the narrowest thing that applies
      const scopes = roles.map((r) => (r.dataScopes || {}).crm).filter(Boolean);
      const groupIds = (access && access.groups) || [];
      const groups = groupIds.length
        ? await db.collection('groups').find({ _id: { $in: groupIds } }).toArray() : [];
      for (const g of groups) if ((g.dataScopes || {}).crm) scopes.push(g.dataScopes.crm);
      const scope = scopes.includes('all') ? 'all'
        : scopes.includes('group') ? 'group'
          : scopes.includes('mine') ? 'mine' : 'all (nothing set)';
      line(`  CRM data scope: ${scope}`);

      let q = { deleteDate: null };
      if (scope === 'mine') {
        q = { ...q, $or: [{ owner: user._id }, { assignedTo: user._id }] };
      } else if (scope === 'group') {
        const memberIds = [...new Set(groups.flatMap((g) => (g.members || []).map(String)))]
          .map((id) => new mongoose.Types.ObjectId(id));
        q = { ...q, $or: [{ owner: { $in: memberIds } }, { assignedTo: { $in: memberIds } }] };
      }
      const seen = await col.countDocuments(q);
      line(`  customers this user can list: ${seen} of ${visible}`);
      if (seen < visible) {
        line();
        line(`  >>> ${visible - seen} customer(s) are hidden from this user by the data scope.`);
        line('      Fix either way:');
        line('        - give the role CRM scope "all" (Users > Roles > edit the role), or');
        line('        - set an owner on the records so the scope can match them.');
      } else if (seen === 0 && visible === 0) {
        line('  >>> the collection itself is empty - nothing to show.');
      } else {
        line('  >>> the data is visible to this user. If the CRM screen is still empty,');
        line('      the problem is in the browser, not the database: check the request to');
        line('      GET /crm/customers in the network tab (a 403 means the crm:view key is');
        line('      missing - run scripts/seedPermissions.js).');
      }
    }
  } else {
    line();
    line('Re-run with --phone <a user phone number> to see what that user can list.');
  }

  await conn.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
