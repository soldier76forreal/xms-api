const mongoose = require('mongoose');

// ── Role — named set of permission keys ───────────────────────────────────────
// System roles (isSystem: true) cannot be deleted (sa, viewer, etc.)
// Effective perms = union(role perms + group perms + grants) − denies

const roleSchema = new mongoose.Schema({
  name:        { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  permissions: [{ type: String }],   // permission key strings
  dataScopes:  { type: Object, default: {} },  // { module: 'mine'|'group'|'all' }
  isSystem:    { type: Boolean, default: false },
  // Super-admin gate — a SEPARATE axis from permissions/dataScopes. Only a role
  // with this flag can manage Roles, Groups, or Branches, regardless of what
  // permission keys another role might otherwise hold. Checked by role FLAG,
  // never by role name, so renaming the role can't silently break the gate.
  // Intended for exactly one role in the system.
  isSuperAdmin: { type: Boolean, default: false },

  // Which job report form this role's holders file their daily report on.
  // A plain String, not an enum: the registry in utils/jobReportTemplates.js
  // is the source of truth for what is valid and an unknown value falls back
  // to 'classic', so adding a template is a code change and never a schema
  // migration - the same rule branch.misTemplates follows. A user holding
  // several roles gets the most specific one; see resolveUserJobReportTemplate
  // in utils/rbac.js.
  jobReportTemplate: { type: String, default: 'classic' },
  insertDate:  { type: Date, default: Date.now },
  updateDate:  { type: Date, default: null },
  deleteDate:  { type: Date, default: null },
});

module.exports = roleSchema;
