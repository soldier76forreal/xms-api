/**
 * grantAdminAccess.js — one-off script to bootstrap the Admin role and assign it to a user.
 * Run once: node api/scripts/grantAdminAccess.js
 *
 * What it does:
 *   1. Seeds all permission keys (idempotent)
 *   2. Creates/updates the Admin role with all permissions
 *   3. Finds the user by phone number and upserts their userAccess doc with the Admin role
 */

require('dotenv').config();
const mongoose         = require('mongoose');
const permissionSchema = require('../models/permissionModel');
const roleSchema       = require('../models/roleModel');
const userAccessSchema = require('../models/userAccessModel');
const userSchema       = require('../models/userModel');

const TARGET_PHONE = '09918537814';

const db = mongoose.createConnection(process.env.DB_CONNECT, {
  useNewUrlParser: true, useUnifiedTopology: true, useFindAndModify: false,
});

const Permission = db.model('permission', permissionSchema);
const Role       = db.model('role',       roleSchema);
const UserAccess = db.model('userAccess', userAccessSchema);
const User       = db.model('user',       userSchema);

const ALL_PERMISSION_KEYS = [
  'inventory:view', 'inventory:product:create', 'inventory:subproduct:create',
  'inventory:edit', 'inventory:delete', 'inventory:quantity:edit',
  'inventory:price:edit', 'inventory:media:edit',
  'users:view', 'users:create', 'users:edit', 'users:delete', 'users:unlock',
  'users:role:view', 'users:role:edit', 'users:group:view', 'users:group:edit',
  'crm:customer:view', 'crm:customer:create', 'crm:customer:edit', 'crm:customer:delete',
  'mis:invoice:view', 'mis:invoice:create', 'mis:invoice:edit', 'mis:invoice:delete',
  'files:view', 'files:upload', 'files:delete', 'files:share',
  'jobReport:view', 'jobReport:create', 'jobReport:edit',
  'projects:view', 'projects:create', 'projects:edit', 'projects:delete',
  'tasks:view', 'tasks:create', 'tasks:respond',
];

async function run() {
  await new Promise((resolve, reject) => {
    db.once('open', resolve);
    db.once('error', reject);
    if (db.readyState === 1) resolve();
  });
  console.log('Connected to DB.');

  // 1. Upsert all permission keys
  for (const key of ALL_PERMISSION_KEYS) {
    const module = key.split(':')[0];
    await Permission.updateOne({ key }, { $set: { key, module } }, { upsert: true });
  }
  console.log(`✓ ${ALL_PERMISSION_KEYS.length} permissions seeded.`);

  // 2. Create or update Admin role with all permissions
  let adminRole = await Role.findOne({ name: 'Admin' });
  if (!adminRole) {
    adminRole = await Role.create({
      name: 'Admin',
      description: 'Full access to all sections',
      permissions: ALL_PERMISSION_KEYS,
      isSystem: true,
    });
    console.log('✓ Admin role created.');
  } else {
    await Role.updateOne({ _id: adminRole._id }, { $set: { permissions: ALL_PERMISSION_KEYS } });
    console.log('✓ Admin role updated with all permissions.');
  }

  // 3. Find user by phone number
  const user = await User.findOne({ phoneNumber: TARGET_PHONE });
  if (!user) {
    console.error(`✗ User with phone ${TARGET_PHONE} not found. Check the phone number.`);
    process.exit(1);
  }
  console.log(`✓ User found: ${user.firstName} ${user.lastName} (${user._id})`);

  // 4. Upsert userAccess doc — give Admin role
  await UserAccess.findOneAndUpdate(
    { userId: user._id },
    { $set: { userId: user._id, roles: [adminRole._id], groups: [], grants: [], denies: [] } },
    { upsert: true, new: true }
  );
  console.log(`✓ Admin role assigned to ${user.firstName} ${user.lastName}.`);
  console.log('Done. Restart the xmsApi server so the permission cache is cleared.');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
