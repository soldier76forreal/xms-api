// One-off cleanup for the retired Job Report + Project Manager modules (2026-07-09).
// Permission keys are normally append-only; these modules were removed entirely,
// so their keys come out of the live catalog AND out of every role / group /
// userAccess doc that still holds them (a stale key in a role is harmless at
// runtime, but it would keep showing up in the role-matrix UI forever).
// Run once: node scripts/removeRetiredModules.js
require('dotenv').config();
const dbConnection      = require('../connections/xmsPr');
const permissionSchema  = require('../models/permissionModel');
const roleSchema        = require('../models/roleModel');
const groupSchema       = require('../models/groupModel');
const userAccessSchema  = require('../models/userAccessModel');

const Permission = dbConnection.model('permission', permissionSchema);
const Role       = dbConnection.model('role',       roleSchema);
const Group      = dbConnection.model('group',      groupSchema);
const UserAccess = dbConnection.model('userAccess', userAccessSchema);

const RETIRED_MODULES = ['jobReport', 'projects'];
const KEY_REGEX = /^(jobReport|projects):/;

(async () => {
  try {
    await dbConnection.asPromise();
    console.log('Connected to', dbConnection.name);

    const deleted = await Permission.deleteMany({ module: { $in: RETIRED_MODULES } });
    console.log('permission catalog docs deleted:', deleted.deletedCount);

    const keys = (await Permission.distinct('key')).filter(k => KEY_REGEX.test(k));
    // distinct() above only returns keys still in the catalog (now none) — pull by
    // regex instead so stale keys inside roles/groups/access are caught regardless.
    const pullFilter = { $regex: KEY_REGEX };

    const roles = await Role.updateMany({}, {
      $pull: { permissions: pullFilter },
      $unset: { 'dataScopes.jobReport': '', 'dataScopes.projects': '' },
    });
    console.log('roles cleaned:', roles.modifiedCount);

    const groups = await Group.updateMany({}, {
      $pull: { permissions: pullFilter },
      $unset: { 'dataScopes.jobReport': '', 'dataScopes.projects': '' },
    });
    console.log('groups cleaned:', groups.modifiedCount);

    const access = await UserAccess.updateMany({}, {
      $pull: { grants: pullFilter, denies: pullFilter },
    });
    console.log('userAccess cleaned:', access.modifiedCount);

    // Sanity: nothing left anywhere
    const leftovers = await Promise.all([
      Permission.countDocuments({ module: { $in: RETIRED_MODULES } }),
      Role.countDocuments({ permissions: pullFilter }),
      Group.countDocuments({ permissions: pullFilter }),
      UserAccess.countDocuments({ $or: [{ grants: pullFilter }, { denies: pullFilter }] }),
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
