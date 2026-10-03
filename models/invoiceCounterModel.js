const mongoose = require('mongoose');

// Phase 6 — MIS / Invoices. Atomic per-docType numbering.
// One doc per docType; the server assigns the next number on create via
//   Counter.findOneAndUpdate({ docType }, { $inc: { seq: 1 } }, { new: true, upsert: true })
// — never assign document numbers on the client; must be gap-safe under
// concurrent creates ($inc is atomic). Counters never rewind (deleted docs
// burn their number).

const invoiceCounterSchema = new mongoose.Schema({
  // Per-branch, per-docType sequence — branches are fully isolated, so each
  // branch's Invoice/Pre-invoice numbering starts fresh and independently.
  branchId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // 'packing_list' added Session 72 — reuses this exact atomic per-branch
  // counter mechanism for packing-list doc numbers instead of a separate one.
  docType:  { type: String, enum: ['invoice', 'pre_invoice', 'packing_list'], required: true },
  seq:      { type: Number, default: 0 },
});
invoiceCounterSchema.index({ branchId: 1, docType: 1 }, { unique: true });

module.exports = invoiceCounterSchema;
