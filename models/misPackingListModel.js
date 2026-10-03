const mongoose = require('mongoose');

// Session 72 — Packing List promoted out of the invoice (see misInvoiceModel.js's
// now-frozen `packingList` field, kept only so historical invoices keep
// rendering their old page 2) into its own standalone MIS sub-resource.
// `pallets[].items[].code`/`productCode` are deliberately free-text snapshots,
// not hard InvVariant refs — matches the real physical packing-list/label
// templates this was built from (typed values, no system linkage shown), same
// precedent as the legacy embedded packingRowSchema.
const packingListItemSchema = new mongoose.Schema({
  code:        { type: String, trim: true },
  lengthCm:    { type: Number },
  widthCm:     { type: Number },
  thicknessCm: { type: Number },
  pcs:         { type: Number },
  sqm:         { type: Number },
}, { _id: false });

const packingListPalletSchema = new mongoose.Schema({
  palletId:       { type: String, required: true, trim: true },   // e.g. "P4"
  reference:      { type: String, trim: true },                   // barcode/reference, e.g. "00755"
  productCode:    { type: String, trim: true },                   // Table-1 summary snapshot
  processingType: { type: String, trim: true },                   // free text, e.g. "UNFLD (slab)"
  items: [packingListItemSchema],
}, { _id: false });

const misPackingListSchema = new mongoose.Schema({
  branchId:  { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  docNumber: { type: Number, required: true },   // own per-branch sequence, docType:'packing_list' on invoiceCounterModel

  // 'linked' requires invoiceIds non-empty and scopes item codes to those
  // invoices' lineItems (validated server-side, never trusted from the client);
  // 'free' is a standalone packing list unattached to any invoice.
  type:       { type: String, enum: ['linked', 'free'], required: true },
  invoiceIds: [{ type: mongoose.Schema.Types.ObjectId }],

  productId: { type: mongoose.Schema.Types.ObjectId, default: null },   // optional informational "primary product"

  // Optional link to the Supply record (the lot) this shipment belongs to —
  // set when the list is raised from that record's Documents section, so it
  // shows up there. Re-validated server-side against this list's own branch.
  supplyRecordId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

  driverInfo: {
    fullName:    { type: String, trim: true },
    nationalId:  { type: String, trim: true },
    smartNumber: { type: String, trim: true },
    phone:       { type: String, trim: true },
    iban:        { type: String, trim: true },
  },
  vehicleInfo: {
    trailerPlateNumber: { type: String, trim: true },
    trailerSmartNumber: { type: String, trim: true },
  },
  customsAgent: {
    name:  { type: String, trim: true },
    phone: { type: String, trim: true },
  },
  // Real captured data field (not just a signature line) — per explicit request.
  loadingOfficer: {
    name:  { type: String, trim: true },
    phone: { type: String, trim: true },
  },
  originAddress:       { type: String, trim: true },
  destinationAddress:  { type: String, trim: true },
  shippingDestination: { type: String, trim: true },
  standardThicknessCm: { type: Number },

  pallets: [packingListPalletSchema],

  // Server-computed, stored (same discipline as invoice totals — list/PDF
  // never recompute divergently).
  totals: {
    totalPallets: { type: Number, default: 0 },
    totalSqm:     { type: Number, default: 0 },
    totalPcs:     { type: Number, default: 0 },
  },

  status: { type: String, enum: ['draft', 'final'], default: 'draft' },
  notes:  { type: String, trim: true },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
  deleteDate: { type: Date, default: null },
  createdBy:  { type: mongoose.Schema.Types.ObjectId },
  updatedBy:  { type: mongoose.Schema.Types.ObjectId },
});

misPackingListSchema.index(
  { branchId: 1, docNumber: 1 },
  { unique: true, partialFilterExpression: { deleteDate: null } }
);
misPackingListSchema.index({ invoiceIds: 1 });
misPackingListSchema.index({ branchId: 1, insertDate: -1 });

module.exports = misPackingListSchema;
