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

const dbConnection = mongoose.createConnection(process.env.DB_CONNECT, {
  useNewUrlParser: true, useUnifiedTopology: true, useFindAndModify: false,
});

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
  { key: 'inventory:view',             module: 'inventory', description: 'مشاهده محصولات و انبار' },
  { key: 'inventory:product:create',   module: 'inventory', description: 'ایجاد محصول جدید' },
  { key: 'inventory:subproduct:create',module: 'inventory', description: 'ایجاد زیرمحصول (واریانت)' },
  { key: 'inventory:edit',             module: 'inventory', description: 'ویرایش اطلاعات توصیفی محصول' },
  { key: 'inventory:delete',           module: 'inventory', description: 'حذف محصول یا واریانت' },
  { key: 'inventory:quantity:edit',    module: 'inventory', description: 'تنظیم موجودی' },
  { key: 'inventory:price:edit',       module: 'inventory', description: 'تغییر قیمت' },
  { key: 'inventory:media:edit',       module: 'inventory', description: 'آپلود و حذف تصاویر' },
  { key: 'inventory:import',           module: 'inventory', description: 'ورود اطلاعات از اکسل' },
  { key: 'inventory:export',           module: 'inventory', description: 'خروجی اکسل از موجودی' },
  // Users
  { key: 'users:view',                 module: 'users', description: 'مشاهده لیست و جزئیات کاربران' },
  { key: 'users:create',               module: 'users', description: 'ایجاد کاربر جدید' },
  { key: 'users:edit',                 module: 'users', description: 'ویرایش کاربر' },
  { key: 'users:delete',               module: 'users', description: 'حذف کاربر' },
  { key: 'users:unlock',               module: 'users', description: 'رفع قفل OTP کاربر' },
  { key: 'users:role:view',            module: 'users', description: 'مشاهده نقش‌ها و مجوزها' },
  { key: 'users:role:edit',            module: 'users', description: 'ایجاد و ویرایش نقش‌ها' },
  { key: 'users:group:view',           module: 'users', description: 'مشاهده گروه‌ها' },
  { key: 'users:group:edit',           module: 'users', description: 'ایجاد و ویرایش گروه‌ها' },
  // CRM
  { key: 'crm:view',                   module: 'crm', description: 'مشاهده مشتریان و CRM' },
  { key: 'crm:customer:create',        module: 'crm', description: 'ایجاد مشتری' },
  { key: 'crm:customer:edit',          module: 'crm', description: 'ویرایش مشتری' },
  { key: 'crm:customer:delete',        module: 'crm', description: 'حذف مشتری' },
  { key: 'crm:task:assign',            module: 'crm', description: 'تخصیص مشتری به کاربر/گروه (My Desk)' },
  { key: 'crm:communication:view',     module: 'crm', description: 'مشاهده تاریخچه تماس‌ها' },
  { key: 'crm:communication:create',   module: 'crm', description: 'ثبت تماس / یادداشت' },
  // MIS (Phase 6 — mis:invoice:view renamed → mis:view; PDF/convert/payment/settings added)
  { key: 'mis:view',                   module: 'mis', description: 'مشاهده فاکتورها و پیش‌فاکتورها' },
  { key: 'mis:invoice:create',         module: 'mis', description: 'ایجاد فاکتور' },
  { key: 'mis:invoice:edit',           module: 'mis', description: 'ویرایش فاکتور' },
  { key: 'mis:invoice:delete',         module: 'mis', description: 'حذف فاکتور' },
  { key: 'mis:invoice:pdf',            module: 'mis', description: 'دانلود PDF فاکتور' },
  { key: 'mis:preinvoice:create',      module: 'mis', description: 'ایجاد پیش‌فاکتور' },
  { key: 'mis:preinvoice:edit',        module: 'mis', description: 'ویرایش پیش‌فاکتور' },
  { key: 'mis:preinvoice:delete',      module: 'mis', description: 'حذف پیش‌فاکتور' },
  { key: 'mis:preinvoice:pdf',         module: 'mis', description: 'دانلود PDF پیش‌فاکتور' },
  { key: 'mis:preinvoice:convert',     module: 'mis', description: 'تبدیل پیش‌فاکتور به فاکتور' },
  { key: 'mis:payment:edit',           module: 'mis', description: 'ثبت / ویرایش پرداخت فاکتور' },
  { key: 'mis:settings:edit',          module: 'mis', description: 'ویرایش تنظیمات شرکت (سربرگ فاکتور)' },
  // Files
  { key: 'files:view',                 module: 'files', description: 'مشاهده فایل‌ها' },
  { key: 'files:upload',               module: 'files', description: 'آپلود فایل' },
  { key: 'files:delete',               module: 'files', description: 'حذف فایل' },
  { key: 'files:share',                module: 'files', description: 'اشتراک‌گذاری فایل' },
  // Job Report
  { key: 'jobReport:view',             module: 'jobReport', description: 'مشاهده گزارش‌ها' },
  { key: 'jobReport:create',           module: 'jobReport', description: 'ثبت گزارش' },
  { key: 'jobReport:edit',             module: 'jobReport', description: 'ویرایش گزارش' },
  // Projects
  { key: 'projects:view',              module: 'projects', description: 'مشاهده پروژه‌ها' },
  { key: 'projects:create',            module: 'projects', description: 'ایجاد پروژه' },
  { key: 'projects:edit',              module: 'projects', description: 'ویرایش پروژه' },
  { key: 'projects:delete',            module: 'projects', description: 'حذف پروژه' },
  // Tasks
  { key: 'tasks:view',                 module: 'tasks', description: 'مشاهده وظایف' },
  { key: 'tasks:create',               module: 'tasks', description: 'ایجاد و تخصیص وظیفه' },
  { key: 'tasks:respond',              module: 'tasks', description: 'دریافت / انجام وظیفه' },
  // Digital Marketing (Phase 8) — NOT branch-scoped (confirmed 2026-07-09)
  { key: 'digitalMarketing:view',                    module: 'digitalMarketing', description: 'View raw content and ready-to-upload content' },
  { key: 'digitalMarketing:rawContent:create',       module: 'digitalMarketing', description: 'Upload a raw content batch' },
  { key: 'digitalMarketing:rawContent:edit',         module: 'digitalMarketing', description: 'Edit / change status of raw content' },
  { key: 'digitalMarketing:rawContent:delete',       module: 'digitalMarketing', description: 'Delete raw content' },
  { key: 'digitalMarketing:rawContent:chat',         module: 'digitalMarketing', description: 'Chat on a raw content record' },
  { key: 'digitalMarketing:readyToUpload:edit',      module: 'digitalMarketing', description: 'Edit ready-to-upload content' },
  { key: 'digitalMarketing:readyToUpload:delete',    module: 'digitalMarketing', description: 'Delete ready-to-upload content' },
];

// ── Starter roles ─────────────────────────────────────────────────────────────
const ALL_KEYS = PERMISSIONS.map(p => p.key);

const ROLES = [
  {
    name: 'Admin',
    description: 'دسترسی کامل به همه بخش‌ها',
    permissions: ALL_KEYS,
    isSystem: true,
    // The Admin role is also THE superAdmin — the only role that can manage
    // Roles/Groups/Branches. This is a separate axis from permissions (see
    // utils/rbac.js requireSuperAdmin) and is intended for exactly one role.
    isSuperAdmin: true,
  },
  {
    name: 'Viewer',
    description: 'فقط مشاهده — بدون تغییر',
    permissions: ALL_KEYS.filter(k => k.endsWith(':view')),
    isSystem: false,
  },
  {
    name: 'StockOperator',
    description: 'اپراتور انبار — مشاهده + موجودی + قیمت',
    permissions: ['inventory:view', 'inventory:quantity:edit', 'inventory:price:edit'],
    isSystem: false,
  },
  {
    name: 'InventoryManager',
    description: 'مدیر انبار — همه مجوزهای انبار',
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
