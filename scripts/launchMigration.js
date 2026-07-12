/**
 * launchMigration.js — 2026-07 LAUNCH migration. Run ONCE on the server.
 *
 * Transforms the OLD app's database (lazulite_xms) into the NEW app's schema:
 *   1. Backs up EVERY collection to scripts/launchBackup-<timestamp>/ (EJSON).
 *   2. Reads the old `users` + `customers` collections into memory.
 *   3. Drops ALL collections (old records/logs/requests are NOT carried over).
 *   4. Seeds the NEW app's config: permissions catalog, roles (+ SalesPerson),
 *      company profile — from scripts/launchData/*.json (exported from dev).
 *   5. Creates the four branches: KSA, UAE, Ahvaz, Isfahan.
 *   6. Re-inserts users mapped to the new model (same _id, password kept for
 *      the password-fallback login, auth/lockout defaults added).
 *   7. Builds userAccess: the three phones below become superAdmin (Admin
 *      role); every other user becomes SalesPerson with all four branches.
 *   8. Re-inserts customers mapped to the new model (soft-deleted skipped;
 *      flat phoneNumber/commChannels/status/owner added; logs dropped).
 *
 * Usage (on the server, from /api):
 *   DB_CONNECT="mongodb://user:pass@localhost:27017/lazulite_xms" node scripts/launchMigration.js --yes
 * Without --yes it only prints what it WOULD do (dry run).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { EJSON } = require('bson');

const SUPERADMIN_PHONES = ['09918537814', '09308633322', '09169206009'];
const BRANCH_NAMES = ['KSA', 'UAE', 'Ahvaz', 'Isfahan'];
const APPLY = process.argv.includes('--yes');

const URI = process.env.DB_CONNECT;
if (!URI) { console.error('DB_CONNECT is not set'); process.exit(1); }

const DATA_DIR = path.join(__dirname, 'launchData');
const readData = (name) =>
  EJSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf8'));

// ── user: old shape → new model ───────────────────────────────────────────────
const mapUser = (u) => ({
  _id: u._id,
  firstName: u.firstName,
  lastName: u.lastName,
  phoneNumber: u.phoneNumber,
  password: u.password,                    // kept — password-fallback login
  oldPasswords: u.oldPasswords || [],
  validation: u.validation === true,
  access: [],                              // deprecated — RBAC is userAccess now
  profileImage: u.profileImage || null,
  filterMemory: u.filterMemory || {},
  auth: {
    otpHash: null, otpExpiresAt: null, otpLastSentAt: null,
    otpSendCount: 0, otpWindowStart: null,
    failedOtpAttempts: 0, failedPasswordAttempts: 0, lockedUntil: null,
  },
  isOnline: false,
  lastSeen: null,
  insertDate: u.insertDate || new Date(),
  updateDate: null,
  deleteDate: u.deleteDate || null,
});

// ── customer: old shape → new model (additive fields) ────────────────────────
const mapCustomer = (c) => {
  const phones = (c.contactInfo && c.contactInfo.phoneNumbers) || [];
  const firstPhone = phones.find((p) => p && p.number) || null;
  const flatPhone = firstPhone
    ? (firstPhone.countryCode ? `+${firstPhone.countryCode}${firstPhone.number}` : String(firstPhone.number))
    : null;

  const commChannels = [];
  const commHandles = {};
  if (phones.some((p) => p && p.whatsApp)) {
    const wa = phones.find((p) => p && p.whatsApp && p.number);
    if (wa) {
      commChannels.push('whatsApp');
      commHandles.whatsApp = wa.countryCode ? `+${wa.countryCode}${wa.number}` : String(wa.number);
    }
  }
  const emails = (c.contactInfo && c.contactInfo.emails) || [];
  const firstEmail = emails.find((e) => e && e.email && e.email.trim() !== '');
  if (firstEmail) { commChannels.push('email'); commHandles.email = firstEmail.email.trim(); }

  return {
    _id: c._id,
    inisialInsert: c.inisialInsert,
    personalInformation: c.personalInformation || {},
    contactInfo: c.contactInfo || {},
    address: Array.isArray(c.address) ? c.address : [],
    explanations: c.explanations || null,
    communication: Array.isArray(c.communication) ? c.communication : [],
    insertDate: c.insertDate || new Date(),
    updateDate: c.updateDate || null,
    updatedBy: c.updatedBy || null,
    // Phase 5 flat fields the new UI drives on:
    phoneNumber: flatPhone,
    phoneCountryCode: (c.personalInformation && c.personalInformation.country) || null,
    commChannels,
    commHandles,
    status: 'new',
    tags: [],
    owner: c.inisialInsert || null,
    createdBy: c.inisialInsert || null,
    assignedTo: [],
    interestedProducts: [],
    // logs / phoneCalls / frequentBtnClick are deliberately NOT carried over
  };
};

(async () => {
  const conn = await mongoose.createConnection(URI).asPromise();
  const db = conn.getClient().db();
  console.log(`Connected to database: ${db.databaseName}`);
  console.log(APPLY ? '*** APPLY MODE — the database WILL be rewritten ***' : '--- DRY RUN (pass --yes to apply) ---');

  // 1. Full backup
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, `launchBackup-${stamp}`);
  const collections = await db.listCollections().toArray();
  fs.mkdirSync(backupDir, { recursive: true });
  for (const c of collections) {
    const docs = await db.collection(c.name).find({}).toArray();
    fs.writeFileSync(path.join(backupDir, `${c.name}.json`), EJSON.stringify(docs, { relaxed: false }));
    console.log(`backup  ${c.name.padEnd(26)} ${docs.length}`);
  }
  console.log(`Backup written to ${backupDir}`);

  // 2. Load old users + customers
  const oldUsers = await db.collection('users').find({}).toArray();
  const oldCustomers = await db.collection('customers').find({}).toArray();
  const liveCustomers = oldCustomers.filter((c) => !c.deleteDate);
  console.log(`\nold users: ${oldUsers.length} · old customers: ${oldCustomers.length} (${liveCustomers.length} live, ${oldCustomers.length - liveCustomers.length} soft-deleted → skipped)`);

  // Prepare seed data
  const permissions = readData('permissions');
  const roles = readData('roles');
  const companyProfiles = readData('companyprofiles');

  // SalesPerson role = Sales manager's permission set + mine scopes
  const salesManager = roles.find((r) => r.name === 'Sales manager');
  let salesPerson = roles.find((r) => r.name === 'SalesPerson');
  if (!salesPerson) {
    salesPerson = {
      _id: new mongoose.Types.ObjectId(),
      name: 'SalesPerson',
      description: 'Sales person — CRM/MIS on own records, view-level elsewhere',
      permissions: salesManager ? salesManager.permissions : [],
      dataScopes: { crm: 'mine', mis: 'mine' },
      isSystem: false,
      isSuperAdmin: false,
    };
    roles.push(salesPerson);
  }
  const adminRole = roles.find((r) => r.isSuperAdmin === true);
  if (!adminRole) { console.error('No superAdmin role found in launchData/roles.json'); process.exit(1); }

  const branches = BRANCH_NAMES.map((name) => ({
    _id: new mongoose.Types.ObjectId(),
    name,
    description: '',
    insertDate: new Date(),
    deleteDate: null,
  }));

  const newUsers = oldUsers.map(mapUser);
  const userAccesses = newUsers.map((u) => {
    const isSuper = SUPERADMIN_PHONES.includes(String(u.phoneNumber).trim());
    return {
      userId: u._id,
      roles: [isSuper ? adminRole._id : salesPerson._id],
      groups: [],
      grants: [],
      denies: [],
      // superAdmins hold every branch implicitly; salespersons get all four
      // explicitly so Inventory/MIS work on day one (restrict later in Users UI)
      branches: isSuper ? [] : branches.map((b) => b._id),
    };
  });
  const newCustomers = liveCustomers.map(mapCustomer);

  console.log('\nPlan:');
  console.log(`  permissions      ${permissions.length}`);
  console.log(`  roles            ${roles.length} (${roles.map((r) => r.name).join(', ')})`);
  console.log(`  companyprofiles  ${companyProfiles.length}`);
  console.log(`  branches         ${branches.length} (${BRANCH_NAMES.join(', ')})`);
  console.log(`  users            ${newUsers.length}`);
  newUsers.forEach((u) => {
    const isSuper = SUPERADMIN_PHONES.includes(String(u.phoneNumber).trim());
    console.log(`    ${String(u.phoneNumber).padEnd(16)} ${(u.firstName + ' ' + u.lastName).padEnd(30)} ${isSuper ? 'SUPERADMIN' : 'SalesPerson'}${u.validation ? '' : '  (inactive)'}`);
  });
  console.log(`  customers        ${newCustomers.length}`);

  if (!APPLY) {
    console.log('\nDry run complete — nothing was changed. Re-run with --yes to apply.');
    await conn.close(); process.exit(0);
  }

  // 3. Drop everything
  console.log('\nDropping all collections…');
  for (const c of collections) await db.collection(c.name).drop().catch(() => {});

  // 4-8. Insert the new world
  const ins = async (col, docs) => {
    if (docs.length) await db.collection(col).insertMany(docs);
    console.log(`insert  ${col.padEnd(26)} ${docs.length}`);
  };
  await ins('permissions', permissions);
  await ins('roles', roles);
  await ins('companyprofiles', companyProfiles);
  await ins('branches', branches);
  await ins('users', newUsers);
  await ins('useraccesses', userAccesses);
  await ins('customers', newCustomers);

  // unique index the new app expects on users.phoneNumber
  await db.collection('users').createIndex({ phoneNumber: 1 }, { unique: true }).catch((e) => console.log('index note:', e.message));

  console.log('\nDone. Final state:');
  for (const c of await db.listCollections().toArray()) {
    console.log(`  ${c.name.padEnd(26)} ${await db.collection(c.name).countDocuments()}`);
  }
  await conn.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
