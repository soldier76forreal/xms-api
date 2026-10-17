/**
 * deployFeedbackSection.js — the database side of Report & Info.
 *
 * This feature mints THREE permission keys, and permissions are default-deny:
 * until a role holds them nobody can open the section. Nothing else needs
 * migrating — the collection, its indexes and the ticket-number sequence are
 * all created by the code on first use, and the File Manager enums are code.
 *
 *   info:view               the section's door — app version, sections, changes
 *   feedback:view           see tickets (limited by the `feedback` data scope)
 *   feedback:ticket:create  submit a bug report or suggestion
 *
 * DATA SCOPE. The `feedback` scope defaults to 'mine' — own tickets only — and
 * NOT to 'all' like every other module (see utils/feedbackScope.js). A role
 * that should read other people's reports has to be given 'group' or 'all'
 * (Roles → Data visibility → "Reports & feedback", or --scope below). A
 * superAdmin always sees everything.
 *
 * So the steps a deploy actually needs are:
 *   1. seed the three keys into the permission catalog
 *   2. give the Admin (superAdmin) role the keys, so the catalog and Admin agree
 *   3. choose which ROLES get them — the step that turns it on for anybody
 *   4. optionally widen who may READ other people's tickets
 *
 * READ ONLY until you pass --yes. It never deletes anything and never removes a
 * permission from a role.
 *
 * Usage (from api/):
 *   node scripts/deployFeedbackSection.js                                   # report only
 *   node scripts/deployFeedbackSection.js --yes                             # seed keys + Admin
 *   node scripts/deployFeedbackSection.js --grant-all-roles --yes           # everyone may report
 *   node scripts/deployFeedbackSection.js --grant "SalesPerson,Viewer" --yes
 *   node scripts/deployFeedbackSection.js --grant "Support" --keys info:view,feedback:view --yes
 *   node scripts/deployFeedbackSection.js --scope "Support=all,Team lead=group" --yes
 *   node scripts/deployFeedbackSection.js --db "mongodb://…"                # a database other than .env's
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

const APPLY = has('--yes');
const DB = valueOf('--db') || process.env.DB_CONNECT;
const GRANT_ALL = has('--grant-all-roles');
const GRANT_NAMES = (valueOf('--grant') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SCOPE_ARG = valueOf('--scope') || '';

if (!DB) {
  console.error('No database. Set DB_CONNECT in api/.env or pass --db "<uri>".');
  process.exit(1);
}

const KEYS = [
  { key: 'info:view',              module: 'info',     description: 'Open Report & Info — app version, sections and recent changes' },
  { key: 'feedback:view',          module: 'feedback', description: 'See bug reports and suggestions (own only, unless the role/group data scope is widened)' },
  { key: 'feedback:ticket:create', module: 'feedback', description: 'Submit a bug report or suggestion (text, voice note, files)' },
];
const KEY_NAMES = KEYS.map((k) => k.key);

// --keys narrows what --grant / --grant-all-roles hands out.
const GRANT_KEYS = valueOf('--keys')
  ? valueOf('--keys').split(',').map((s) => s.trim()).filter(Boolean)
  : KEY_NAMES;
const unknownKey = GRANT_KEYS.find((k) => !KEY_NAMES.includes(k));
if (unknownKey) {
  console.error(`--keys: "${unknownKey}" is not one of ${KEY_NAMES.join(', ')}`);
  process.exit(1);
}

// "Support=all,Team lead=group" → [['Support','all'], ['Team lead','group']]
const SCOPE_CHANGES = SCOPE_ARG.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
  const i = pair.lastIndexOf('=');
  return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
});
const badScope = SCOPE_CHANGES.find(([n, s]) => !n || !['mine', 'group', 'all'].includes(s));
if (badScope) {
  console.error(`--scope: expected "Role name=mine|group|all", got "${badScope.join('=')}"`);
  process.exit(1);
}

const line = (s = '') => console.log(s);
const head = (s) => { line(); line(s); line('─'.repeat(s.length)); };

(async () => {
  const conn = await mongoose.createConnection(DB).asPromise();
  const db = conn.db;
  line(`database : ${db.databaseName}`);
  line(`mode     : ${APPLY ? 'APPLY — changes will be written' : 'DRY RUN — nothing will be written'}`);

  const changes = [];
  const roles = await db.collection('roles').find({ deleteDate: null }).sort({ name: 1 }).toArray();
  const roleByName = new Map(roles.map((r) => [r.name, r]));

  // ── 1. the permission catalog ──────────────────────────────────────────
  head('1. Permission keys');
  const permissions = db.collection('permissions');
  const present = new Set(
    (await permissions.find({ key: { $in: KEY_NAMES } }).toArray()).map((p) => p.key),
  );
  for (const k of KEYS) {
    if (present.has(k.key)) {
      line(`  present  ${k.key}`);
    } else {
      line(`  MISSING  ${k.key}`);
      changes.push(async () => {
        await permissions.updateOne({ key: k.key }, { $set: k }, { upsert: true });
        line(`  seeded   ${k.key}`);
      });
    }
  }

  // ── 2. the superAdmin role ─────────────────────────────────────────────
  head('2. Admin (superAdmin) role');
  const supers = roles.filter((r) => r.isSuperAdmin);
  if (!supers.length) line('  no role is flagged isSuperAdmin — nothing to sync');
  for (const r of supers) {
    const lacking = KEY_NAMES.filter((k) => !(r.permissions || []).includes(k));
    if (!lacking.length) {
      line(`  ${r.name}: already holds all three`);
    } else {
      line(`  ${r.name}: lacks ${lacking.join(', ')}`);
      changes.push(async () => {
        await db.collection('roles').updateOne({ _id: r._id }, { $addToSet: { permissions: { $each: lacking } } });
        line(`  granted to ${r.name}: ${lacking.join(', ')}`);
      });
    }
  }

  // ── 3. who gets the keys ───────────────────────────────────────────────
  head('3. Roles');
  for (const name of GRANT_NAMES) {
    if (!roleByName.has(name)) { console.error(`--grant: no role named "${name}"`); process.exit(1); }
  }
  for (const [name] of SCOPE_CHANGES) {
    if (!roleByName.has(name)) { console.error(`--scope: no role named "${name}"`); process.exit(1); }
  }
  const toGrant = new Set(GRANT_ALL ? roles.map((r) => r.name) : GRANT_NAMES);

  const accesses = await db.collection('useraccesses').find({}).project({ roles: 1 }).toArray();
  const holders = (roleId) => accesses.filter((a) => (a.roles || []).some((x) => String(x) === String(roleId))).length;

  line(`  ${'role'.padEnd(28)}${'door'.padEnd(6)}${'view'.padEnd(6)}${'create'.padEnd(8)}${'scope'.padEnd(17)}users`);
  for (const r of roles) {
    const perms = new Set(r.permissions || []);
    const scopeNow = (r.dataScopes && r.dataScopes.feedback) || null;
    const mark = (k, w = 6) => (perms.has(k) ? 'yes' : '-').padEnd(w);
    const scopeLabel = r.isSuperAdmin ? 'all (admin)' : (scopeNow ? scopeNow : 'mine (default)');
    line(`  ${r.name.padEnd(28)}${mark('info:view')}${mark('feedback:view')}${mark('feedback:ticket:create', 8)}${scopeLabel.padEnd(17)}${holders(r._id)}`);

    if (toGrant.has(r.name)) {
      const lacking = GRANT_KEYS.filter((k) => !perms.has(k));
      if (lacking.length) {
        changes.push(async () => {
          await db.collection('roles').updateOne({ _id: r._id }, { $addToSet: { permissions: { $each: lacking } } });
          line(`  granted to ${r.name}: ${lacking.join(', ')}`);
        });
      }
    }
  }

  // ── 4. who may read other people's tickets ─────────────────────────────
  if (SCOPE_CHANGES.length) {
    head('4. Data scope — who may read other people’s tickets');
    for (const [name, scope] of SCOPE_CHANGES) {
      const r = roleByName.get(name);
      const now = (r.dataScopes && r.dataScopes.feedback) || 'mine (default)';
      line(`  ${name}: ${now} → ${scope}`);
      changes.push(async () => {
        await db.collection('roles').updateOne({ _id: r._id }, { $set: { 'dataScopes.feedback': scope } });
        line(`  scope set: ${name} → ${scope}`);
      });
    }
  }

  // ── 5. things worth knowing before your users find out ─────────────────
  head('Checks');
  const effectiveHas = (r, k) => (r.isSuperAdmin ? true : (r.permissions || []).includes(k) || (toGrant.has(r.name) && GRANT_KEYS.includes(k)));
  let warned = false;
  for (const r of roles) {
    const door = effectiveHas(r, 'info:view');
    const view = effectiveHas(r, 'feedback:view');
    const create = effectiveHas(r, 'feedback:ticket:create');
    if ((view || create) && !door) {
      warned = true;
      line(`  ! ${r.name}: has a feedback key but not info:view — the section's door — so they cannot open it`);
    }
    if (create && !view) {
      warned = true;
      line(`  ! ${r.name}: can submit but not see tickets — they will not see their own ticket afterwards`);
    }
  }
  if (!warned) line('  none');

  // ── apply ──────────────────────────────────────────────────────────────
  head(APPLY ? 'Applying' : 'Dry run');
  if (!changes.length) {
    line('  nothing to change');
  } else if (!APPLY) {
    line(`  ${changes.length} change(s) pending — run again with --yes to apply them`);
  } else {
    for (const run of changes) await run();
    line(`  ${changes.length} change(s) applied`);
    line('  Permissions are cached for up to 60 s, so users see the new section within a minute.');
  }

  await conn.close();
})().catch((err) => { console.error(err); process.exit(1); });
