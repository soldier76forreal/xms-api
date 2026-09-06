const mongoose = require('mongoose');

// ── UserAccess — per-user RBAC override document ──────────────────────────────
// One doc per user (userId unique).  Missing doc = default-deny on everything.
// Effective perms = union(role perms across roles[] + group perms across groups[])
//                   + grants[]   − denies[]
// Resolve order: denies win over grants (explicit deny always beats any grant).
// grants / denies hold permission key strings (NOT role names).

const userAccessSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  roles:  [{ type: mongoose.Schema.Types.ObjectId }],   // ref: 'roles' collection
  groups: [{ type: mongoose.Schema.Types.ObjectId }],   // ref: 'groups' collection
  grants: [{ type: String }],   // direct permission key additions
  denies: [{ type: String }],   // direct permission key removals (win over grants)
  // May this user "ghost in" to another account for testing? A THIRD access
  // axis, separate from both permission keys and isSuperAdmin: it can only be
  // set by the owner account (see utils/ghost.js OWNER_PHONE), specifically so
  // that impersonation rights cannot be handed around by whoever currently
  // holds an admin role. Never grantable through the normal roles/groups UI.
  canGhost: { type: Boolean, default: false },
  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
});

module.exports = userAccessSchema;
