const mongoose = require('mongoose');

// Generic short-link record backing the app-wide "copy link" button on every
// record detail view (CRM/MIS/Inventory/Digital Marketing/Users) AND File
// Manager's share links. The resolver only maps code -> {module, entityType,
// entityId}; access control is NOT re-implemented here — the frontend routes
// the resolved target through that module's own already-permission/scope-
// gated detail fetch, so there is exactly one place each module's access
// rule lives.
const shortLinkSchema = new mongoose.Schema({
  code:       { type: String, required: true, unique: true, index: true },
  module:     { type: String, required: true, enum: ['crm', 'mis', 'inventory', 'digitalMarketing', 'users', 'files'] },
  entityType: { type: String, required: true },
  entityId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  // File Manager only — the {document, msg, showName} share payload.
  payload:    { type: mongoose.Schema.Types.Mixed, default: null },
  // null = never expires (every record link). Set for File Manager shares.
  expiresAt:  { type: Date, default: null },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, required: true },
  insertDate: { type: Date, default: Date.now },
  deleteDate: { type: Date, default: null },
});

module.exports = shortLinkSchema;
