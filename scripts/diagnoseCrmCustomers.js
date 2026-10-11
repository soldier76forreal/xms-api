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

  // ── 1. is there more than one place customers could be? ───────────────────
  head('Collections that could hold customers');
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  const candidates = names.filter((n) => /customer|client|contact/i.test(n));
  for (const n of candidates) {
    line(`  ${n.padEnd(28)} ${await db.collection(n).countDocuments({})} documents`);
  }
  if (!candidates.includes('customers')) {
    line('  !! there is no `customers` collection - the CRM reads that one and nothing else');
  }
  const others = candidates.filter((n) => n !== 'customers');
  for (const n of others) {
    const n2 = await db.collection(n).countDocuments({});
    if (n2) line(`  !! "${n}" holds ${n2} document(s) the CRM will never read`);
  }

  const col = db.collection('customers');
  const total = await col.countDocuments({});

  // ── 2. soft-deleted? ──────────────────────────────────────────────────────
  head('The customers collection');
  const visible = await col.countDocuments({ deleteDate: null });
  const deleted = await col.countDocuments({ deleteDate: { $ne: null } });
  line(`  total                      ${total}`);
  line(`  the list query can see     ${visible}      (deleteDate null or absent)`);
  line(`  soft-deleted               ${deleted}`);
  if (deleted) line('  -> soft-deleted records never appear; that is by design');

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
