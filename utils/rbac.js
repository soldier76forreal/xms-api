const dbConnection      = require('../connections/xmsPr');
const permissionSchema  = require('../models/permissionModel');
const roleSchema        = require('../models/roleModel');
const groupSchema       = require('../models/groupModel');
const userAccessSchema  = require('../models/userAccessModel');
const branchSchema      = require('../models/branchModel');

const Permission = dbConnection.model('permission', permissionSchema);
const Role       = dbConnection.model('role',       roleSchema);
const Group      = dbConnection.model('group',      groupSchema);
const UserAccess = dbConnection.model('userAccess', userAccessSchema);
const Branch     = dbConnection.models.branch || dbConnection.model('branch', branchSchema);

// ── Permission cache ──────────────────────────────────────────────────────────
// Short-lived so revocations take effect quickly (max 60s lag).
// Map<userId:string, { perms: Set<string>, expiresAt: number }>
const permCache    = new Map();
const CACHE_TTL_MS = 60 * 1000;

// ── Core resolver ─────────────────────────────────────────────────────────────
// Effective perms = union(role perms + group perms + grants) − denies
// Denies always win over grants.
async function getEffectivePermissions(userId) {
  const id = String(userId);
  const cached = permCache.get(id);
  if (cached && Date.now() < cached.expiresAt) return cached.perms;

  const access = await UserAccess.findOne({ userId: id }).lean();

  if (!access) {
    // Default-deny: no userAccess doc = no permissions
    const empty = new Set();
    permCache.set(id, { perms: empty, expiresAt: Date.now() + CACHE_TTL_MS });
    return empty;
  }

  const perms = new Set();

  if (access.roles && access.roles.length) {
    const roles = await Role.find({ _id: { $in: access.roles }, deleteDate: null }).lean();
    roles.forEach(r => (r.permissions || []).forEach(k => perms.add(k)));
  }

  if (access.groups && access.groups.length) {
    const groups = await Group.find({ _id: { $in: access.groups }, deleteDate: null }).lean();
    groups.forEach(g => (g.permissions || []).forEach(k => perms.add(k)));
  }

  (access.grants || []).forEach(k => perms.add(k));
  (access.denies || []).forEach(k => perms.delete(k));  // denies win

  permCache.set(id, { perms, expiresAt: Date.now() + CACHE_TTL_MS });
  return perms;
}

// Call after any role/group/access mutation to force a fresh resolve next request
function clearPermissionCache(userId) {
  if (userId) permCache.delete(String(userId));
  else        permCache.clear();
}

// ── Scope resolver ────────────────────────────────────────────────────────────
// Returns effective data scopes: { crm: 'mine'|'group'|'all', ... }
// Most permissive wins across all roles + groups (all > group > mine).
// If no role/group has set a scope for a module → default 'all' (no restriction).
const SCOPE_RANK = { mine: 1, group: 2, all: 3 };

async function getEffectiveScopes(userId) {
  const access = await UserAccess.findOne({ userId: String(userId) }).lean();
  if (!access) return {};

  const merged = {};

  const applyScopes = (scopeObj) => {
    if (!scopeObj || typeof scopeObj !== 'object') return;
    Object.entries(scopeObj).forEach(([mod, scope]) => {
      if (!SCOPE_RANK[scope]) return;
      // Most permissive wins (highest rank)
      if (!merged[mod] || SCOPE_RANK[scope] > SCOPE_RANK[merged[mod]]) {
        merged[mod] = scope;
      }
    });
  };

  if (access.roles && access.roles.length) {
    const roles = await Role.find({ _id: { $in: access.roles }, deleteDate: null }).lean();
    roles.forEach(r => applyScopes(r.dataScopes));
  }

  if (access.groups && access.groups.length) {
    const groups = await Group.find({ _id: { $in: access.groups }, deleteDate: null }).lean();
    groups.forEach(g => applyScopes(g.dataScopes));
  }

  return merged;
}

// ── requirePermission factory ─────────────────────────────────────────────────
// Usage: router.post('/something', verify, requirePermission('module:resource:action'), handler)
// Backend is the ONLY real gate — frontend <Can> is UX only.
function requirePermission(key) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      const perms = await getEffectivePermissions(req.user.id);
      if (perms.has(key)) return next();
      return res.status(403).json({ message: 'Access denied', requiredPermission: key });
    } catch (err) {
      return next(err);
    }
  };
}

// ── Super-admin gate ───────────────────────────────────────────────────────────
// A SEPARATE axis from permissions — Roles, Groups, and Branch management are
// gated ONLY by this, never by a permission key. Checked by role FLAG
// (role.isSuperAdmin), never by role name. Intended for exactly one role.
async function isSuperAdmin(userId) {
  const access = await UserAccess.findOne({ userId: String(userId) }).lean();
  if (!access || !access.roles || !access.roles.length) return false;
  const superRole = await Role.findOne({ _id: { $in: access.roles }, deleteDate: null, isSuperAdmin: true }).lean();
  return !!superRole;
}

function requireSuperAdmin() {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      if (await isSuperAdmin(req.user.id)) return next();
      return res.status(403).json({ message: 'This section is only available to the super admin', requiredRole: 'superAdmin' });
    } catch (err) {
      return next(err);
    }
  };
}

// ── Branch access ──────────────────────────────────────────────────────────────
// Inventory/MIS are fully isolated per branch. Every list/detail/mutation route
// in those modules requires a branchId and must call assertBranchAccess to
// confirm the requesting user is actually assigned to it — never trust a
// branchId from the client without this check.
async function getUserBranches(userId) {
  const access = await UserAccess.findOne({ userId: String(userId) }).lean();
  return (access && access.branches) || [];
}

async function assertBranchAccess(userId, branchId) {
  if (!branchId) return false;
  const branches = await getUserBranches(userId);
  if (branches.some((b) => String(b) === String(branchId))) return true;
  // superAdmin holds every branch implicitly — GET /branches already lists them
  // all for a superAdmin, so without this bypass switching to a branch not in
  // their own userAccess.branches 403'd every Inventory/MIS request.
  return isSuperAdmin(userId);
}

// requireBranch — reads branchId from query (GET) or body (mutations), 400s if
// missing/malformed, 403s if the user isn't assigned to it. Exposes the
// validated id as req.branchId for the route handler to use directly.
function requireBranch() {
  return async (req, res, next) => {
    try {
      const branchId = req.query.branchId || req.body.branchId;
      if (!branchId) return res.status(400).json({ message: 'No branch selected', code: 'BRANCH_REQUIRED' });
      const ok = await assertBranchAccess(req.user.id, branchId);
      if (!ok) return res.status(403).json({ message: 'You do not have access to this branch' });
      req.branchId = branchId;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  getEffectivePermissions, getEffectiveScopes, requirePermission, clearPermissionCache,
  isSuperAdmin, requireSuperAdmin, getUserBranches, assertBranchAccess, requireBranch,
  Permission, Role, Group, UserAccess, Branch,
};
