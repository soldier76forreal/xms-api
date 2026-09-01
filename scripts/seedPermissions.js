/**
 * seedPermissions.js — run ONCE on first deploy (or after adding new modules)
 * Usage: node api/scripts/seedPermissions.js
 *
 * Idempotent: uses updateOne with upsert so re-running is safe.
 * After seeding, create seed roles via seedRoles.js (or from the Roles Manager UI).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const permissionSchema = require('../models/permissionModel');
const roleSchema       = require('../models/roleModel');

// Mongoose 6: the old v5 flags (useNewUrlParser/useUnifiedTopology/useFindAndModify)
// are defaults now and passing them throws MongoParseError.
const dbConnection = mongoose.createConnection(process.env.DB_CONNECT);

const Permission = dbConnection.model('permission', permissionSchema);
const Role       = dbConnection.model('role',       roleSchema);

// Wait for connection (Mongoose v5 compatible)
function waitForConnection(conn) {
  return new Promise((resolve, reject) => {
    if (conn.readyState === 1) return resolve();
    conn.once('open', resolve);
    conn.once('error', reject);
  });
}

// ── Permission catalog ────────────────────────────────────────────────────────
// Convention: module:resource:action — append-only, born with the feature they guard
const PERMISSIONS = [
  // Inventory
  { key: 'inventory:view',             module: 'inventory', description: 'View products and inventory' },
  { key: 'inventory:product:create',   module: 'inventory', description: 'Create product' },
  { key: 'inventory:subproduct:create',module: 'inventory', description: 'Create sub-product (variant)' },
  { key: 'inventory:edit',             module: 'inventory', description: 'Edit product descriptive info' },
  { key: 'inventory:delete',           module: 'inventory', description: 'Delete product or variant' },
  { key: 'inventory:quantity:edit',    module: 'inventory', description: 'Adjust stock quantity' },
  { key: 'inventory:price:edit',       module: 'inventory', description: 'Change price' },
  { key: 'inventory:media:edit',       module: 'inventory', description: 'Upload and delete media' },
  { key: 'inventory:import',           module: 'inventory', description: 'Import from Excel' },
  { key: 'inventory:export',           module: 'inventory', description: 'Export inventory to Excel' },
  { key: 'inventory:share:whatsapp',   module: 'inventory', description: 'Build and share a WhatsApp product message' },
  // Users
  { key: 'users:view',                 module: 'users', description: 'View users list and details' },
  { key: 'users:create',               module: 'users', description: 'Create user' },
  { key: 'users:edit',                 module: 'users', description: 'Edit user' },
  { key: 'users:delete',               module: 'users', description: 'Delete user' },
  { key: 'users:unlock',               module: 'users', description: 'Unlock a locked user account' },
  { key: 'users:role:view',            module: 'users', description: 'View roles and permissions' },
  { key: 'users:role:edit',            module: 'users', description: 'Create and edit roles' },
  { key: 'users:group:view',           module: 'users', description: 'View groups' },
  { key: 'users:group:edit',           module: 'users', description: 'Create and edit groups' },
  // CRM
  { key: 'crm:view',                   module: 'crm', description: 'View customers and CRM' },
  { key: 'crm:customer:create',        module: 'crm', description: 'Create customer' },
  { key: 'crm:customer:edit',          module: 'crm', description: 'Edit customer' },
  { key: 'crm:customer:delete',        module: 'crm', description: 'Delete customer' },
  { key: 'crm:task:assign',            module: 'crm', description: 'Assign customers to a user/group (My Desk)' },
  { key: 'crm:communication:view',     module: 'crm', description: 'View communication history' },
  { key: 'crm:communication:create',   module: 'crm', description: 'Log a call / note' },
  // MIS (Phase 6 — mis:invoice:view renamed → mis:view; PDF/convert/payment/settings added)
  { key: 'mis:view',                   module: 'mis', description: 'View invoices and pre-invoices' },
  { key: 'mis:invoice:create',         module: 'mis', description: 'Create invoice' },
  { key: 'mis:invoice:edit',           module: 'mis', description: 'Edit invoice' },
  { key: 'mis:invoice:delete',         module: 'mis', description: 'Delete invoice' },
  { key: 'mis:invoice:pdf',            module: 'mis', description: 'Download invoice PDF' },
  { key: 'mis:preinvoice:create',      module: 'mis', description: 'Create pre-invoice' },
  { key: 'mis:preinvoice:edit',        module: 'mis', description: 'Edit pre-invoice' },
  { key: 'mis:preinvoice:delete',      module: 'mis', description: 'Delete pre-invoice' },
  { key: 'mis:preinvoice:pdf',         module: 'mis', description: 'Download pre-invoice PDF' },
  { key: 'mis:preinvoice:convert',     module: 'mis', description: 'Convert pre-invoice to invoice' },
  { key: 'mis:payment:edit',           module: 'mis', description: 'Record / edit invoice payment' },
  { key: 'mis:settings:edit',          module: 'mis', description: 'Edit company settings (invoice header)' },
  // Files
  { key: 'files:view',                 module: 'files', description: 'View files' },
  { key: 'files:upload',               module: 'files', description: 'Upload files' },
  { key: 'files:delete',               module: 'files', description: 'Delete files' },
  { key: 'files:share',                module: 'files', description: 'Share files' },
  // Job Report + Projects modules were removed 2026-07-09 — their keys are
  // deleted from the catalog and cleaned from roles/groups/userAccess by
  // scripts/removeRetiredModules.js (permission keys are otherwise append-only).
  // Tasks
  { key: 'tasks:view',                 module: 'tasks', description: 'View tasks' },
  { key: 'tasks:create',               module: 'tasks', description: 'Create and assign tasks' },
  { key: 'tasks:respond',              module: 'tasks', description: 'Claim / complete tasks' },
  // Digital Marketing (Phase 8) — NOT branch-scoped (confirmed 2026-07-09)
  { key: 'digitalMarketing:view',                    module: 'digitalMarketing', description: 'View raw content and ready-to-upload content' },
  { key: 'digitalMarketing:rawContent:create',       module: 'digitalMarketing', description: 'Upload a raw content batch' },
  { key: 'digitalMarketing:rawContent:edit',         module: 'digitalMarketing', description: 'Edit / change status of raw content' },
  { key: 'digitalMarketing:rawContent:delete',       module: 'digitalMarketing', description: 'Delete raw content' },
  { key: 'digitalMarketing:rawContent:chat',         module: 'digitalMarketing', description: 'Chat on a raw content record' },
  { key: 'digitalMarketing:readyToUpload:edit',      module: 'digitalMarketing', description: 'Edit ready-to-upload content' },
  { key: 'digitalMarketing:readyToUpload:delete',    module: 'digitalMarketing', description: 'Delete ready-to-upload content' },
  { key: 'digitalMarketing:linkPage:create',         module: 'digitalMarketing', description: 'Create an external link page' },
  { key: 'digitalMarketing:linkPage:edit',           module: 'digitalMarketing', description: 'Edit an external link page' },
  { key: 'digitalMarketing:linkPage:delete',         module: 'digitalMarketing', description: 'Delete an external link page' },
  // Tutorial Center — shared reference material, no row-level dataScope
  { key: 'tutorials:view',   module: 'tutorials', description: 'View tutorials' },
  { key: 'tutorials:upload', module: 'tutorials', description: 'Upload a new tutorial' },
  { key: 'tutorials:edit',   module: 'tutorials', description: 'Edit tutorial metadata / files' },
  { key: 'tutorials:delete', module: 'tutorials', description: 'Delete a tutorial' },
  // Job Reports — admin-mode capabilities only. Filing/editing/following-up on
  // your OWN report needs no permission key (same precedent as personal
  // notes/activity) — see routes/users/users.js's jobReports route family.
  { key: 'jobReports:viewAll', module: 'jobReports', description: 'View and filter every user’s job reports' },
  { key: 'jobReports:reply',   module: 'jobReports', description: 'Reply to a user’s job report' },
];

// ── Starter roles ─────────────────────────────────────────────────────────────
const ALL_KEYS = PERMISSIONS.map(p => p.key);

const ROLES = [
  {
    name: 'Admin',
    description: 'Full access to all sections',
    permissions: ALL_KEYS,
    isSystem: true,
    // The Admin role is also THE superAdmin — the only role that can manage
    // Roles/Groups/Branches. This is a separate axis from permissions (see
    // utils/rbac.js requireSuperAdmin) and is intended for exactly one role.
    isSuperAdmin: true,
  },
  {
    name: 'Viewer',
    description: 'View only — no changes',
    permissions: ALL_KEYS.filter(k => k.endsWith(':view')),
    isSystem: false,
  },
  {
    name: 'StockOperator',
    description: 'Stock operator — view + quantity + price',
    permissions: ['inventory:view', 'inventory:quantity:edit', 'inventory:price:edit'],
    isSystem: false,
  },
  {
    name: 'InventoryManager',
    description: 'Inventory manager — all inventory permissions',
    permissions: ALL_KEYS.filter(k => k.startsWith('inventory:')),
    isSystem: false,
  },
];

// Keys renamed across phases — old key is removed from the catalog and swapped
// to the new key inside every role that held it (idempotent).
const RENAMED_KEYS = [
  { from: 'mis:invoice:view', to: 'mis:view' },   // Phase 6
];

async function seed() {
  await waitForConnection(dbConnection);
  console.log('Connected to DB. Seeding permissions...');

  for (const { from, to } of RENAMED_KEYS) {
    await Permission.deleteOne({ key: from });
    await Role.updateMany({ permissions: from }, { $addToSet: { permissions: to } });
    await Role.updateMany({ permissions: from }, { $pull: { permissions: from } });
  }

  for (const p of PERMISSIONS) {
    await Permission.updateOne({ key: p.key }, { $set: p }, { upsert: true });
    process.stdout.write('.');
  }

  console.log(`\nSeeded ${PERMISSIONS.length} permissions.`);
  console.log('Seeding starter roles...');

  // Re-run safe: EXISTING roles keep their (possibly admin-customised) permission
  // arrays — only Admin is always synced to the full catalog (isSystem = all keys);
  // missing starter roles are created with their defaults.
  for (const r of ROLES) {
    const existing = await Role.findOne({ name: r.name });
    if (!existing) {
      await Role.create(r);
      console.log(`  Created role: ${r.name} (${r.permissions.length} permissions)`);
    } else if (r.name === 'Admin') {
      await Role.updateOne({ name: 'Admin' }, { $set: { permissions: ALL_KEYS, isSystem: true, isSuperAdmin: true } });
      console.log(`  Synced Admin → full catalog (${ALL_KEYS.length} permissions) + superAdmin flag`);
    } else {
      console.log(`  Kept existing role untouched: ${r.name}`);
    }
  }

  console.log('Done.');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
