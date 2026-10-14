/**
 * deployJobReportTemplates.js — the database side of per-role job report forms.
 *
 * There is no migration to run. Every schema addition this feature made is
 * additive with a default, and the code was written so that a record saved
 * before it existed reads correctly:
 *
 *   · a report with no `templateKey`  → the classic report, which is what it is
 *   · a report with no `status`       → the admin list filters {status: {$ne:'draft'}},
 *                                       and $ne matches a field that is absent
 *   · a role with no `jobReportTemplate` → classic
 *
 * So the app works the moment the new code is running. What this script is for
 * is the things you DO want to do deliberately on a deploy:
 *
 *   1. confirm the jobReports permission keys are in the live catalog
 *      (they shipped in Session 68 — a database seeded before that will not
 *      have them, and then nobody can hold "view all reports" at all)
 *   2. create the two new indexes explicitly rather than waiting for Mongoose's
 *      autoIndex to get round to it on a collection that may already be large
 *   3. choose which ROLE files on the salesperson sheet — the one step that
 *      actually turns the feature on for anybody
 *   4. check that such a role can really use it: the three pickers carry the
 *      permission of the section they read from, so a role on the salesperson
 *      form without crm:view / inventory:view / digitalMarketing:view gets a
 *      form whose pickers politely say "no access". This script says so BEFORE
 *      your reps find out.
 *
 * READ ONLY until you pass --yes. It never deletes anything.
 *
 * Usage (from api/):
 *   node scripts/deployJobReportTemplates.js                      # report only
 *   node scripts/deployJobReportTemplates.js --yes                # seed keys + indexes
 *   node scripts/deployJobReportTemplates.js --role "Sales manager" --template salesperson --yes
 *   node scripts/deployJobReportTemplates.js --backfill-status --yes
 *   node scripts/deployJobReportTemplates.js --db "mongodb://…"   # a database other than .env's
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { listJobReportTemplates, isKnownTemplate, DEFAULT_TEMPLATE } = require('../utils/jobReportTemplates');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

const APPLY = has('--yes');
const DB = valueOf('--db') || process.env.DB_CONNECT;
const ROLE_NAME = valueOf('--role');
const TEMPLATE = valueOf('--template');
const BACKFILL = has('--backfill-status');

if (!DB) {
  console.error('No database. Set DB_CONNECT in api/.env or pass --db "<uri>".');
  process.exit(1);
}
if (TEMPLATE && !isKnownTemplate(TEMPLATE)) {
  console.error(`Unknown template "${TEMPLATE}". Known: ${listJobReportTemplates().map((t) => t.key).join(', ')}`);
  process.exit(1);
}
if (ROLE_NAME && !TEMPLATE) {
  console.error('--role needs --template (which form that role should file on).');
  process.exit(1);
}

// The keys this feature needs. NONE of them are new — the job report keys
// shipped with the job reports section itself, and the three section keys are
// as old as their sections. They are listed here so the script can tell you
// whether the live catalog actually has them, which is the thing that varies
// between a database seeded last year and one seeded last week.
const REQUIRED_KEYS = [
  { key: 'jobReports:viewAll', module: 'jobReports', description: 'View and filter every user’s job reports' },
  { key: 'jobReports:reply',   module: 'jobReports', description: 'Reply to a user’s job report' },
];

// What a role needs to actually USE a template that references other sections.
// Read off the template registry rather than hard-coded, so a template added
// later is checked too.
const PICKER_KEYS = {
  customer:  'crm:view',
  variety:   'inventory:view',
  dmContent: 'digitalMarketing:view',
  recipient: 'crm:view',   // its customer mode; channels and text need nothing
};

function templateNeeds(templateKey) {
  const { resolveJobReportTemplate, eachField } = require('../utils/jobReportTemplates');
  const tpl = resolveJobReportTemplate(templateKey);
  const needed = new Set();
  eachField(tpl, (field) => {
    const key = PICKER_KEYS[field.type];
    if (key) needed.add(key);
  });
  return Array.from(needed).sort();
}

const line = (s = '') => console.log(s);
const head = (s) => { line(); line(s); line('─'.repeat(s.length)); };

(async () => {
  const conn = await mongoose.createConnection(DB).asPromise();
  const db = conn.db;
  line(`database : ${db.databaseName}`);
  line(`mode     : ${APPLY ? 'APPLY — changes will be written' : 'DRY RUN — nothing will be written'}`);

  const changes = [];

  // ── 1. the permission catalog ──────────────────────────────────────────
  head('1. Permission keys');
  const permissions = db.collection('permissions');
  const presentKeys = new Set(
    (await permissions.find({ key: { $in: REQUIRED_KEYS.map((p) => p.key) } }).toArray()).map((p) => p.key),
  );
  for (const p of REQUIRED_KEYS) {
    if (presentKeys.has(p.key)) {
      line(`  present  ${p.key}`);
    } else {
      line(`  MISSING  ${p.key}  — ${p.description}`);
      changes.push(async () => {
        await permissions.updateOne({ key: p.key }, { $set: p }, { upsert: true });
        line(`  seeded   ${p.key}`);
      });
    }
  }
  // Admin is always synced to the whole catalog by seedPermissions; if a key
  // was missing it has to be added to Admin too, or the key exists and nobody
  // holds it.
  if (presentKeys.size < REQUIRED_KEYS.length) {
    changes.push(async () => {
      const admin = await db.collection('roles').findOne({ name: 'Admin' });
      if (!admin) { line('  note: no role named "Admin" — grant the new keys by hand'); return; }
      const missing = REQUIRED_KEYS.map((p) => p.key).filter((k) => !(admin.permissions || []).includes(k));
      if (!missing.length) return;
      await db.collection('roles').updateOne({ _id: admin._id }, { $addToSet: { permissions: { $each: missing } } });
      line(`  granted to Admin: ${missing.join(', ')}`);
    });
  }
  line('  (this feature mints NO new permission keys — it reuses the section keys above)');

  // ── 2. indexes ─────────────────────────────────────────────────────────
  head('2. Indexes on userjobreports');
  const reports = db.collection('userjobreports');
  const existing = (await reports.indexes().catch(() => [])).map((i) => i.name);
  const wanted = [
    { spec: { userId: 1, status: 1, reportDate: -1 }, name: 'userId_1_status_1_reportDate_-1',
      why: 'resuming a draft, and a user’s own list' },
    { spec: { 'links.customers.customerId': 1 }, name: 'links.customers.customerId_1',
      why: 'every report that mentions a given customer' },
  ];
  for (const idx of wanted) {
    if (existing.includes(idx.name)) {
      line(`  present  ${idx.name}`);
    } else {
      line(`  MISSING  ${idx.name}  — ${idx.why}`);
      changes.push(async () => {
        await reports.createIndex(idx.spec, { name: idx.name, background: true });
        line(`  created  ${idx.name}`);
      });
    }
  }

  // ── 3. existing reports ────────────────────────────────────────────────
  head('3. Reports already in the database');
  const total = await reports.countDocuments({ deleteDate: null });
  const noStatus = await reports.countDocuments({ deleteDate: null, status: { $exists: false } });
  const drafts = await reports.countDocuments({ deleteDate: null, status: 'draft' });
  line(`  ${total} report(s), of which ${noStatus} predate the status field and ${drafts} are drafts`);
  if (noStatus) {
    line('  Those read as submitted already — the admin list filters {status: {$ne: "draft"}},');
    line('  and $ne matches a field that is simply absent. No backfill is required.');
    if (BACKFILL) {
      changes.push(async () => {
        const r = await reports.updateMany(
          { deleteDate: null, status: { $exists: false } },
          { $set: { status: 'submitted' } },
        );
        line(`  stamped ${r.modifiedCount} report(s) as submitted`);
      });
    } else {
      line('  Pass --backfill-status to stamp them explicitly anyway (tidier, not needed).');
    }
  }

  // ── 4. which role files on which form ──────────────────────────────────
  head('4. Roles and the form they file on');
  const roles = await db.collection('roles').find({ deleteDate: null }).sort({ name: 1 }).toArray();
  const accesses = await db.collection('useraccesses').find({}).project({ roles: 1 }).toArray();
  const holders = (roleId) => accesses.filter((a) => (a.roles || []).some((r) => String(r) === String(roleId))).length;

  for (const r of roles) {
    const tpl = r.jobReportTemplate || DEFAULT_TEMPLATE;
    const n = holders(r._id);
    line(`  ${r.name.padEnd(26)} ${tpl.padEnd(13)} ${n} user(s)`);

    // The check that matters: can this role actually use the form it is on?
    if (tpl !== DEFAULT_TEMPLATE) {
      const needed = templateNeeds(tpl);
      const held = new Set(r.permissions || []);
      const missing = needed.filter((k) => !held.has(k));
      if (missing.length) {
        line(`  ${''.padEnd(26)} ⚠ cannot use: ${missing.join(', ')}`);
        line(`  ${''.padEnd(26)}   (those pickers will say "no access"; grant the keys to this role)`);
      } else {
        line(`  ${''.padEnd(26)} ✓ holds ${needed.join(', ')}`);
      }
    }
  }

  line();
  line('  Available forms: ' + listJobReportTemplates().map((t) => `${t.key} (${t.label.en})`).join(' · '));

  if (ROLE_NAME) {
    const role = roles.find((r) => r.name === ROLE_NAME);
    if (!role) {
      line(`  ✗ no role named "${ROLE_NAME}"`);
    } else if ((role.jobReportTemplate || DEFAULT_TEMPLATE) === TEMPLATE) {
      line(`  "${ROLE_NAME}" is already on "${TEMPLATE}" — nothing to do`);
    } else {
      line(`  will set "${ROLE_NAME}" → "${TEMPLATE}" (was "${role.jobReportTemplate || DEFAULT_TEMPLATE}")`);
      changes.push(async () => {
        await db.collection('roles').updateOne(
          { _id: role._id },
          { $set: { jobReportTemplate: TEMPLATE, updateDate: new Date() } },
        );
        line(`  set "${ROLE_NAME}" → "${TEMPLATE}"`);
        const needed = templateNeeds(TEMPLATE);
        const missing = needed.filter((k) => !(role.permissions || []).includes(k));
        if (missing.length) {
          line(`  ⚠ this role does not hold ${missing.join(', ')} — those pickers will be unusable`);
        }
      });
    }
  } else {
    line('  You can also set this in the app: People → Roles → the role → Daily report form.');
  }

  // ── apply ──────────────────────────────────────────────────────────────
  head(APPLY ? 'Applying' : 'Nothing written');
  if (!changes.length) {
    line('  Everything is already in place.');
  } else if (!APPLY) {
    line(`  ${changes.length} change(s) would be made. Re-run with --yes to apply.`);
  } else {
    for (const run of changes) await run();
    line('  Done.');
  }

  line();
  line('After this: restart the API (it is plain `node server.js`, so it does not');
  line('pick up new routes by itself) and deploy a fresh frontend build.');

  await conn.close();
  process.exit(0);
})().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
