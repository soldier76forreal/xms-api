// Row-level scope for bug reports and suggestions — ONE definition, used by the
// list route AND the single-ticket route. (Job reports learned this the hard
// way: a security filter written twice is one that drifts.)
//
// Two deliberate departures from the other modules, both because a ticket is
// somebody's own words, screenshots and voice notes:
//
//   · The default is 'mine'. Everywhere else "no scope set" means 'all' (see
//     utils/rbac.js getEffectiveScopes). Here a role has to be GIVEN a wider
//     scope — otherwise holding feedback:view would let anyone read everyone's
//     reports. The Roles screen shows the same default (rolesManager.js).
//   · A superAdmin always sees everything. They administer the system and are
//     who the admin panel is for; making them opt in role-by-role would only
//     mean the person in charge cannot read the reports.
//
// A scope answers WHICH tickets, never WHETHER: the permission key
// (feedback:view) is checked first, by requirePermission on the route.
const mongoose = require('mongoose');
const { getEffectiveScopes, isSuperAdmin, Group } = require('./rbac');

const VALID_SCOPES = ['mine', 'group', 'all'];

async function ticketScopeFor(userId) {
  if (await isSuperAdmin(userId)) return 'all';
  const scopes = await getEffectiveScopes(userId);
  return VALID_SCOPES.includes(scopes.feedback) ? scopes.feedback : 'mine';
}

// Everyone who shares a group with the user, the user included. Used by both
// the list filter and the single-ticket check so 'group' cannot mean two things.
async function groupPeerIds(userId) {
  const groups = await Group.find({
    members: new mongoose.Types.ObjectId(String(userId)),
    deleteDate: null,
  }).select('members').lean();
  const ids = new Set([String(userId)]);
  groups.forEach((g) => (g.members || []).forEach((m) => ids.add(String(m))));
  return ids;
}

// A Mongo filter on `owner`, or {} for 'all'.
async function ticketScopeFilter(userId, scope) {
  if (scope === 'all') return {};
  if (scope === 'group') {
    const ids = await groupPeerIds(userId);
    return { owner: { $in: [...ids].map((id) => new mongoose.Types.ObjectId(id)) } };
  }
  return { owner: new mongoose.Types.ObjectId(String(userId)) };   // 'mine', and anything unrecognised
}

async function canAccessTicket(userId, scope, doc) {
  if (scope === 'all') return true;
  if (scope === 'group') return (await groupPeerIds(userId)).has(String(doc.owner));
  return String(doc.owner) === String(userId);
}

module.exports = { ticketScopeFor, ticketScopeFilter, canAccessTicket, groupPeerIds, VALID_SCOPES };
