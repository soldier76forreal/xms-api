const mongoose = require('mongoose');

// Phase 8 — Digital Marketing. Created either via a rawContent record's status
// toggling to 'ready_to_upload' (rawContentId set, back-reference to its source
// raw content batch) OR standalone via POST /ready-to-upload (rawContentId left
// unset — added 2026-07-22 at Pouriya's request, reversing the original
// graduate-only design).

const readyToUploadFileSchema = new mongoose.Schema({
  fileId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  diskName:  { type: String },   // servable at /uploads/<diskName>
  name:      { type: String },
  mimetype:  { type: String },
  thumbnail: { type: String, default: null },
  addedAt:   { type: Date, default: Date.now },
}, { _id: false });

// Same shape/reasoning as rawContentModel.js's rawContentProductSchema — a
// snapshot, not a live-joined reference, looked up via the branch-scoped
// GET /digitalMarketing/inventory-lookup.
const readyToUploadProductSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, required: true },
  variantId: { type: mongoose.Schema.Types.ObjectId, required: true },
  code:      { type: String },
  productName: { type: String },
  branchId:  { type: mongoose.Schema.Types.ObjectId, default: null },
  branchName: { type: String },
  addedAt:   { type: Date, default: Date.now },
}, { _id: false });

const readyToUploadSchema = new mongoose.Schema({
  rawContentId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

  title: { type: String, default: '' },   // shown on the card + detail

  files: [readyToUploadFileSchema],

  language: { type: String, default: '' },
  platform: { type: String, default: '' },   // Post / Reels / Story / YouTube Short / TikTok post / … (free text, extensible)
  caption:  { type: String, default: '' },

  // Inventory varieties this content is about/for — see readyToUploadProductSchema.
  products: [readyToUploadProductSchema],

  owner: { type: mongoose.Schema.Types.ObjectId },

  // Optional branch tag (added 2026-09-08) — same non-restrictive convention
  // as rawContentModel.js's branchId: filterable, never gates visibility.
  branchId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

  createdBy:   { type: mongoose.Schema.Types.ObjectId },
  createdByName: { type: String },
  updatedBy:   { type: mongoose.Schema.Types.ObjectId },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
  deleteDate: { type: Date, default: null },
});

readyToUploadSchema.index({ insertDate: -1 });
readyToUploadSchema.index({ owner: 1 });

module.exports = readyToUploadSchema;
