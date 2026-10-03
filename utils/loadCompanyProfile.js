// Session 72 (Phase 3) — shared per-branch-override-with-global-fallback
// company profile loader, used by the new packing-list/label PDF routes.
// routes/mis/invoices.js keeps its own already-verified local copy of this
// exact logic (added in Phase 2) rather than being refactored to import this
// — not worth touching tested, working code for a pure duplication cleanup.
const dbConnection = require('../connections/xmsPr');
const companyProfileSchema = require('../models/companyProfileModel');

const CompanyProfile = dbConnection.models.companyProfile || dbConnection.model('companyProfile', companyProfileSchema);

async function loadCompanyProfile(branchId) {
  if (branchId) {
    const branchProfile = await CompanyProfile.findOne({ branchId }).lean();
    if (branchProfile) return branchProfile;
  }
  return CompanyProfile.findOneAndUpdate(
    { key: 'default', branchId: null },
    { $setOnInsert: { key: 'default', branchId: null } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
}

module.exports = { loadCompanyProfile };
