const mongoose = require('mongoose');

// Phase 6 — MIS / Invoices. Single settings doc — the STATIC template
// header/footer (seller identity, bank block, thank-you note, VAT default).
// Editable via PUT /mis/company-profile (mis:settings:edit) — NEVER hardcode
// these values into the PDF/preview template.
// Seed values transcribed from Pouriya's samples (confirm at seed time):
//   bank ADIB · IBAN AE14…282 · SWIFT ABDIAEAD · seller TRN 104877542100003.

const companyProfileSchema = new mongoose.Schema({
  key:    { type: String, default: 'default', unique: true },  // single-doc guard
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

module.exports = companyProfileSchema;
