// One-off cleanup for the DamoonCars re-scope: MIS/Invoices, Inventory, File
// Manager (the standalone section — NOT the shared `files` collection, which
// CRM/Digital Marketing/Tutorials/Users still use for their own uploads), and
// Job Reports are removed entirely, along with WhatsApp Share (Inventory-only
// DM sub-feature), the multi-branch system, and CRM's Inventory-linked
// "interested products" field. Mirrors scripts/removeRetiredModules.js's
// permission-catalog cleanup, but with a much larger blast radius (whole
// collections, not just permission keys) — so, like scripts/launchMigration.js,
// this one is dry-run by default.
//
// Usage:
//   node scripts/removeDamoonCarsModules.js            (dry run — prints counts only)
//   node scripts/removeDamoonCarsModules.js --yes       (applies)
require('dotenv').config();
const dbConnection      = require('../connections/xmsPr');
const permissionSchema  = require('../models/permissionModel');
const roleSchema        = require('../models/roleModel');
const groupSchema       = require('../models/groupModel');
const userAccessSchema  = require('../models/userAccessModel');
const customerSchema    = require('../models/customerModel');
const fileSchema        = require('../models/fileModel');

const Permission = dbConnection.model('permission',   permissionSchema);
const Role       = dbConnection.model('role',         roleSchema);
const Group      = dbConnection.model('group',        groupSchema);
const UserAccess = dbConnection.model('userAccess',   userAccessSchema);
const Customer   = dbConnection.model('customer',     customerSchema);
const File       = dbConnection.model('file',         fileSchema);

const APPLY = process.argv.includes('--yes');

const RETIRED_MODULES = ['inventory', 'mis', 'files', 'jobReports'];
const KEY_REGEX = /^(inventory|mis|files|jobReports):/;
const pullFilter = { $regex: KEY_REGEX };

// Collections dropped wholesale — names are Mongoose's default pluralization
// of each deleted model's registration name (verified against this project's
// installed mongoose version since the schema files themselves are gone).
const DROPPED_COLLECTIONS = [
  'inventoryproducts', 'inventoryvariants', 'inventorychangelogs', 'inventorycategories',
  'misinvoices', 'invoicecounters', 'invoiceactivities', 'companyprofiles',
  'invoices',   // legacy pre-RBAC invoice model
  'branches', 'folders', 'filefolderstags', 'fileactivities',
  'whatsappshares', 'userjobreports',
];

// `files` is NOT dropped — CRM/Digital Marketing/Tutorials/Users share it.
// Only rows belonging to the removed modules come out of it.
const DEAD_FILE_SCOPES = ['inventory', 'file_manager'];
const DEAD_ATTACHED_TYPES = ['inventoryProduct', 'inventoryVariant', 'invoice', 'jobReport', 'userJobReport'];
const fileFilter = {
  $or: [
    { scope: { $in: DEAD_FILE_SCOPES } },
    { 'attachedTo.type': { $in: DEAD_ATTACHED_TYPES } },
  ],
};

(async () => {
  try {
    await dbConnection.asPromise();
    console.log('Connected to', dbConnection.name);
    console.log(APPLY ? '*** APPLY MODE — the database WILL be rewritten ***' : '--- DRY RUN (pass --yes to apply) ---');

    // ── Report current state ──────────────────────────────────────────────────
    const permCount = await Permission.countDocuments({ module: { $in: RETIRED_MODULES } });
    console.log(`Permission catalog docs to delete: ${permCount}`);

    const rolesToClean  = await Role.countDocuments({ permissions: pullFilter });
    const groupsToClean = await Group.countDocuments({ permissions: pullFilter });
    const accessGrantsToClean = await UserAccess.countDocuments({ $or: [{ grants: pullFilter }, { denies: pullFilter }] });
    console.log(`Roles with stale keys: ${rolesToClean}, Groups: ${groupsToClean}, UserAccess grants/denies: ${accessGrantsToClean}`);

    const collectionCounts = {};
    for (const collName of DROPPED_COLLECTIONS) {
      collectionCounts[collName] = await dbConnection.db.collection(collName).countDocuments().catch(() => 0);
    }
    console.log('Collection doc counts (to be dropped):', collectionCounts);

    const filesToDelete = await File.countDocuments(fileFilter);
    console.log(`File docs to delete (dead scope/attachedTo, collection kept): ${filesToDelete}`);

    const branchesFieldCount    = await UserAccess.countDocuments({ branches: { $exists: true, $ne: [] } });
    const interestedFieldCount  = await Customer.countDocuments({ interestedProducts: { $exists: true, $ne: [] } });
    console.log(`UserAccess docs with a non-empty branches[]: ${branchesFieldCount}`);
    console.log(`Customer docs with a non-empty interestedProducts[]: ${interestedFieldCount}`);

    if (!APPLY) {
      console.log('\nDry run complete — nothing was changed. Re-run with --yes to apply.');
      await dbConnection.close();
      process.exit(0);
    }

    // ── Apply ──────────────────────────────────────────────────────────────
    const permDeleted = await Permission.deleteMany({ module: { $in: RETIRED_MODULES } });
    console.log('permission catalog docs deleted:', permDeleted.deletedCount);

    const unsetScopes = {
      'dataScopes.inventory': '', 'dataScopes.mis': '', 'dataScopes.files': '', 'dataScopes.jobReports': '',
    };

    const roles = await Role.updateMany({}, { $pull: { permissions: pullFilter }, $unset: unsetScopes });
    console.log('roles cleaned:', roles.modifiedCount);

    const groups = await Group.updateMany({}, { $pull: { permissions: pullFilter }, $unset: unsetScopes });
    console.log('groups cleaned:', groups.modifiedCount);

    const access = await UserAccess.updateMany({}, { $pull: { grants: pullFilter, denies: pullFilter } });
    console.log('userAccess grants/denies cleaned:', access.modifiedCount);

    const branchesUnset = await UserAccess.updateMany({}, { $unset: { branches: '' } });
    console.log('userAccess.branches removed from:', branchesUnset.modifiedCount);

    const interestedUnset = await Customer.updateMany({}, { $unset: { interestedProducts: '' } });
    console.log('customer.interestedProducts removed from:', interestedUnset.modifiedCount);

    const filesDeleted = await File.deleteMany(fileFilter);
    console.log('file docs deleted (dead scope/attachedTo):', filesDeleted.deletedCount);

    for (const collName of DROPPED_COLLECTIONS) {
      try {
        await dbConnection.db.collection(collName).drop();
        console.log(`dropped collection: ${collName}`);
      } catch (err) {
        if (err.codeName === 'NamespaceNotFound' || err.code === 26) {
          console.log(`collection already absent: ${collName}`);
        } else {
          throw err;
        }
      }
    }

    // Sanity: nothing left anywhere
    const leftovers = await Promise.all([
      Permission.countDocuments({ module: { $in: RETIRED_MODULES } }),
      Role.countDocuments({ permissions: pullFilter }),
      Group.countDocuments({ permissions: pullFilter }),
      UserAccess.countDocuments({ $or: [{ grants: pullFilter }, { denies: pullFilter }, { branches: { $exists: true, $ne: [] } }] }),
      Customer.countDocuments({ interestedProducts: { $exists: true, $ne: [] } }),
      File.countDocuments(fileFilter),
    ]);
    console.log('leftovers (should be all 0):', leftovers.join(', '));

    await dbConnection.close();
    console.log('DONE');
    process.exit(0);
  } catch (err) {
    console.error('FAILED:', err);
    process.exit(1);
  }
})();
