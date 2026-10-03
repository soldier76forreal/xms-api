const mongoose = require('mongoose');

// A Supply record is the container for one product's supplying effort at a
// branch — it's for exactly ONE product (quarry-level, e.g. "MA01"), never a
// specific variant SKU. One product can have MULTIPLE supply records over
// time; each supply record can hold MULTIPLE deal letters (supplyDealLetterModel).
const supplyRecordSchema = new mongoose.Schema({
  // Unique, human-facing identity — SR-0001, SR-0002… from ONE system-wide
  // sequence (utils/sequence.js), so it stays unique across branches: other
  // branches see and request against these records. Server-assigned at
  // creation (older records are backfilled at startup), never edited, never
  // reused. Not a per-branch number like an invoice's: branches have no short
  // code to prefix one with, and countries repeat.
  code:      { type: String, trim: true },
  branchId:  { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  productId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, ref: 'inventoryProduct' },
  // Snapshot of the product's code/name at creation time — display convenience,
  // re-validated against live Inventory on every write, never trusted from the client.
  productCode: { type: String, trim: true },
  productName: { type: String, trim: true },
  title:       { type: String, required: true, trim: true },
  date:        { type: Date, required: true, default: Date.now },
  notes:       { type: String, trim: true },
  dealLetterCount: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
  deleteDate: { type: Date, default: null },
  createdBy:  { type: mongoose.Schema.Types.ObjectId },
  updatedBy:  { type: mongoose.Schema.Types.ObjectId },
});

// Unique once assigned; records not yet backfilled simply don't have one.
supplyRecordSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
supplyRecordSchema.index({ branchId: 1, productId: 1 });
supplyRecordSchema.index({ branchId: 1, date: -1 });

module.exports = supplyRecordSchema;
