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
  // ISO country code (e.g. 'AE', 'SA', 'IR') — resolves a flag/country for this
  // branch via xms/src/components/crm/util/countryData.js. Optional: existing
  // branches predate this field and simply show no flag until an admin sets it.
  country:     { type: String, default: null },
  insertDate:  { type: Date, default: Date.now },
  updateDate:  { type: Date, default: null },
  deleteDate:  { type: Date, default: null },
  createdBy:   { type: mongoose.Schema.Types.ObjectId },
});

module.exports = branchSchema;
