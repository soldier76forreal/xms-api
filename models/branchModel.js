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
  // Which staff get notified when a public-website price request comes in
  // for a product tagged to this branch (see POST /public/website/price-requests).
  // Editable via the same Branch edit form as everything else above —
  // superAdmin-only, no separate permission key.
  priceRequestNotifyUsers: [{ type: mongoose.Schema.Types.ObjectId }],
  // Which OTHER branches may browse THIS branch's Inventory + Supply and raise
  // stock requests against it. Direction matters: the list lives on the branch
  // being SHARED, so "Isfahan grants KSA" is an entry on Isfahan. Empty (the
  // default, and every pre-existing branch) means nobody — cross-branch
  // browsing is default-deny like every other permission in the app, and the
  // `mis:crossBranch:quote` key remains a SEPARATE requirement on top of it.
  crossBranchAccess: [{ type: mongoose.Schema.Types.ObjectId }],
  // Public-website footer/branches-directory display — real physical location
  // info, not used anywhere else in xms. All optional (existing branches
  // predate these fields).
  address:         { type: String, default: '' },
  phone:           { type: String, default: '' },
  instagramHandle: { type: String, default: '' },
  // Session 72 — per-branch MIS PDF template selection. Plain strings, NOT a
  // Mongoose enum: the render-function lookup table in utils/invoiceTemplate.js
  // (and, for Phase 3, utils/packingListTemplate.js) is the source of truth for
  // valid keys — an unknown/unset value silently falls back to 'classic', so a
  // real new template later is a data change, not a schema change.
  misTemplates: {
    customerInvoice:      { type: String, default: 'classic' },
    customerQuotation:    { type: String, default: 'classic' },
    interBranchInvoice:   { type: String, default: 'classic' },
    interBranchQuotation: { type: String, default: 'classic' },
    packingList: { type: String, default: 'classic' },   // Session 72 (Phase 3)
    label:       { type: String, default: 'classic' },
    dealLetter:  { type: String, default: 'classic' },   // Supply's قرارداد فروش سنگ
  },
  insertDate:  { type: Date, default: Date.now },
  updateDate:  { type: Date, default: null },
  deleteDate:  { type: Date, default: null },
  createdBy:   { type: mongoose.Schema.Types.ObjectId },
});

module.exports = branchSchema;
