const mongoose = require('mongoose');

// Digital Marketing — WhatsApp Share history. A persistent RECEIPT of every
// completed "Share to WhatsApp" action (built from an Inventory variant via
// routes/digitalMarketing/main.js's product-lookup + the existing Inventory
// branch-availability/share-contacts routes) — created automatically when the
// rep clicks Copy text or Open in WhatsApp, never by a manual save step.
//
// Immutable snapshot, same principle as MIS's issued invoices: once saved, a
// record never re-reads live Inventory data (the product/variant it came from
// may since have changed, moved branch, or been deleted — the record must
// still show exactly what was actually sent). Deletable, not editable.

const branchSnapshotSchema = new mongoose.Schema({
  branchId:   { type: mongoose.Schema.Types.ObjectId },
  branchName: { type: String },
  country:    { type: String, default: null },
  quantity:   { type: Number },
  unit:       { type: String },
}, { _id: false });

const whatsappShareSchema = new mongoose.Schema({
  variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
  productId: { type: mongoose.Schema.Types.ObjectId, default: null },

  productName:   { type: String, default: '' },
  productNameAr: { type: String, default: '' },
  variantCode:   { type: String, default: '' },
  lengthCm:      { type: Number, default: null },
  widthCm:       { type: Number, default: null },

  language:     { type: String, enum: ['en', 'fa', 'ar'], required: true },
  nameLanguage: { type: String, enum: ['en', 'ar'], required: true },

  includeName:       { type: Boolean, default: true },
  includeDimensions: { type: Boolean, default: true },
  includeCode:       { type: Boolean, default: true },
  includeContact:    { type: Boolean, default: true },

  branches: [branchSnapshotSchema],

  contactUserId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  contactName:     { type: String, default: '' },
  contactWaNumber: { type: String, default: '' },

  text: { type: String, required: true },

  action: { type: String, enum: ['copied', 'openedWhatsApp'], required: true },

  owner:         { type: mongoose.Schema.Types.ObjectId },
  createdBy:     { type: mongoose.Schema.Types.ObjectId },
  createdByName: { type: String },

  insertDate: { type: Date, default: Date.now },
  deleteDate: { type: Date, default: null },
});

whatsappShareSchema.index({ insertDate: -1 });
whatsappShareSchema.index({ owner: 1 });

module.exports = whatsappShareSchema;
