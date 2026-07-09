const mongoose = require('mongoose');

// ── Branch — a fully isolated Inventory + Invoice section ─────────────────────
// Each branch has its own inventory catalog (products/variants) and its own
// invoice/pre-invoice numbering — NOT a shared pool tagged by branch. A user
// only ever sees the branch(es) listed on their userAccess.branches; every
// inventory/MIS route requires a branchId and re-validates it server-side.
// Creating/editing/archiving branches is superAdmin-only (see utils/rbac.js
// requireSuperAdmin) — never gated by an ordinary permission key.
const branchSchema = new mongoose.Schema({
  name:        { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  status:      { type: String, enum: ['active', 'archived'], default: 'active' },
  insertDate:  { type: Date, default: Date.now },
  updateDate:  { type: Date, default: null },
  deleteDate:  { type: Date, default: null },
  createdBy:   { type: mongoose.Schema.Types.ObjectId },
});

module.exports = branchSchema;
