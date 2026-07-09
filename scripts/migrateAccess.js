/**
 * migrateAccess.js — one-off migration: access:[] → userAccess docs
 * Usage: node api/scripts/migrateAccess.js
 *
 * Run AFTER seedPermissions.js so the Admin/Viewer roles exist.
 * Idempotent: skips users who already have a userAccess doc.
 *
 * Mapping (old access[] → role name):
 *   'sa'  → Admin
 *   'inv' → InventoryManager
 *   'req' → Viewer  (generic viewer for request-level access)
 *   (no match) → no role assigned (default-deny)
 */

require('dotenv').config();
const mongoose = require('mongoose');

const userModel       = require('../models/userModel');
const roleSchema      = require('../models/roleModel');
const userAccessSchema= require('../models/userAccessModel');

const dbConnection = mongoose.createConnection(process.env.DB_CONNECT, {
  useNewUrlParser: true, useUnifiedTopology: true, useFindAndModify: false,
});

const User       = dbConnection.model('user',       userModel);
const Role       = dbConnection.model('role',       roleSchema);
const UserAccess = dbConnection.model('userAccess', userAccessSchema);

const ACCESS_TO_ROLE = {
  sa:  'Admin',
  inv: 'InventoryManager',
  req: 'Viewer',
};

function waitForConnection(conn) {
  return new Promise((resolve, reject) => {
    if (conn.readyState === 1) return resolve();
    conn.once('open', resolve);
    conn.once('error', reject);
  });
}

async function migrate() {
  await waitForConnection(dbConnection);
  console.log('Connected. Starting access:[] → userAccess migration...');

  // Load all roles into a name→_id map
  const allRoles = await Role.find({ deleteDate: null }).lean();
  const roleMap  = {};
  allRoles.forEach(r => { roleMap[r.name] = r._id; });

  const users = await User.find({ deleteDate: null }).lean();
  let created = 0, skipped = 0;

  for (const u of users) {
    const exists = await UserAccess.findOne({ userId: u._id });
    if (exists) { skipped++; continue; }

    const roleIds = [];
    (u.access || []).forEach(a => {
      const roleName = ACCESS_TO_ROLE[a];
      if (roleName && roleMap[roleName]) {
        roleIds.push(roleMap[roleName]);
      }
    });

    await UserAccess.create({ userId: u._id, roles: roleIds, groups: [], grants: [], denies: [] });
    created++;
    console.log(`  Migrated: ${u.firstName} ${u.lastName} (${u.phoneNumber}) → roles: [${roleIds.length ? roleIds.join(', ') : 'none'}]`);
  }

  console.log(`\nDone. Created: ${created}, Skipped (already had userAccess): ${skipped}`);
  console.log('Review the migrated docs, then retire the access[] field from the user model.');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(1); });
