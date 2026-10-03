const mongoose = require('mongoose');

// Phase 6 — MIS / Invoices. Single settings doc — the STATIC template
// header/footer (seller identity, bank block, thank-you note, VAT default).
// Editable via PUT /mis/company-profile (mis:settings:edit) — NEVER hardcode
// these values into the PDF/preview template.
// Seed values transcribed from Pouriya's samples (confirm at seed time):
//   bank ADIB · IBAN AE14…282 · SWIFT ABDIAEAD · seller TRN 104877542100003.

const companyProfileSchema = new mongoose.Schema({
  key:    { type: String, default: 'default' },  // single-doc guard for the GLOBAL fallback doc (branchId: null)
  // Session 72 — per-branch override. null = the original global fallback doc
  // (the one pre-existing live doc keeps key:'default', branchId: null, and
  // keeps working exactly as before). A real branchId doc overrides the global
  // one for that branch only; loadProfile(branchId) below falls back to global
  // when no branch-specific doc exists yet.
  // NOT `index: true` here — the explicit partial+unique index below is the
  // only index on this field; declaring both produces two indexes that fight
  // over the same auto-generated name ("branchId_1") and IndexKeySpecsConflict.
  branchId: { type: mongoose.Schema.Types.ObjectId, default: null },
  nameAr: { type: String },
  nameEn: { type: String },
  phones: [{ type: String }],
  email:  { type: String },
  website:{ type: String },
  trn:    { type: String },                     // seller VAT no. (ب.ض.)
  branchAddressAr: { type: String },
  logoFileId: { type: mongoose.Schema.Types.ObjectId },  // ref → files (shared uploader)

  bank: {
    name:          { type: String },            // e.g. ADIB
    accountNumber: { type: String },
    iban:          { type: String },
    branch:        { type: String },
    swift:         { type: String },
  },

  vatRate:        { type: Number, default: 5 },  // % — UAE default, per-line rate default
  thankYouNoteAr: { type: String },
  quotationValidityDefaultDays: { type: Number, default: 2 },

  updateDate: { type: Date },
  updatedBy:  { type: mongoose.Schema.Types.ObjectId },
});

// At most one override doc per real branch. Partial — MongoDB partial-index
// filters only support a small operator set ($eq/$exists/$gt/$gte/$lt/$lte/
// $type/$and), NOT $ne, so "branchId is a real ObjectId" is expressed as
// $type:'objectId' rather than the more obvious {$ne: null}. This correctly
// excludes the pre-existing global fallback doc, which predates this field
// and so is either missing it or holds an explicit null (BSON type 'null'),
// never 'objectId'. App logic (loadProfile) guarantees exactly one global doc
// exists, via its existing upsert-on-read.
companyProfileSchema.index(
  { branchId: 1 },
  { unique: true, partialFilterExpression: { branchId: { $type: 'objectId' } } }
);

module.exports = companyProfileSchema;
