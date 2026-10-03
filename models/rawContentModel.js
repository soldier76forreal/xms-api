const mongoose = require('mongoose');

// Phase 8 — Digital Marketing. A raw content batch: the unedited material a
// content creator uploads (image/video/voice/PDF/other), each file carrying
// its own text OR voice description, plus batch-level language/useCase/
// platform. Files themselves live in the shared File Manager collection
// (scope:'digitalMarketing', attachedTo:{type:'rawContent', id}) — this doc
// only snapshots the fileId + per-file metadata, same convention as
// customerActivity.media[].
// NOT branch-scoped (confirmed 2026-07-09) — one shared org-wide pool, every
// digitalMarketing:view holder sees every record regardless of branchId.
// branchId (added 2026-09-08) is an OPTIONAL TAG, not isolation: which
// branch a batch is FOR, so it can be filtered — it never gates visibility
// the way Inventory/MIS's branchId does, and requireBranch() is deliberately
// NOT used here.

const rawContentFileSchema = new mongoose.Schema({
  fileId:      { type: mongoose.Schema.Types.ObjectId, required: true },
  diskName:    { type: String },   // on-disk filename — servable at /uploads/<diskName>, avoids a second lookup
  name:        { type: String },   // original display filename
  mimetype:    { type: String },
  thumbnail:   { type: String, default: null },
  description: { type: String, default: '' },
  voiceDescriptionFileId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  voiceDescriptionDiskName: { type: String, default: null },
  addedAt:     { type: Date, default: Date.now },
}, { _id: false });

// A tagged Inventory variant — snapshot of code/product name at the moment it
// was attached (same reasoning as rawContentFileSchema snapshotting file
// metadata rather than joining live each read: this doc is a working-content
// record, not a permanent relationship like CRM's interestedProducts, and a
// creator tagging "the product this content is about" wants what they saw at
// the time, not a value that silently changes if Inventory edits the product
// later). Looked up via GET /digitalMarketing/inventory-lookup, which already
// enforces branch scoping — nothing here re-checks branch access on read.
const rawContentProductSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, required: true },
  variantId: { type: mongoose.Schema.Types.ObjectId, required: true },
  code:      { type: String },   // the variant's own code, e.g. TR45Q10004018VFP
  productName: { type: String },
  branchId:  { type: mongoose.Schema.Types.ObjectId, default: null },
  branchName: { type: String },
  addedAt:   { type: Date, default: Date.now },
}, { _id: false });

const rawContentSchema = new mongoose.Schema({
  title:    { type: String, default: '' },   // batch title (shown on the card + detail)
  language: { type: String, default: '' },
  useCase:  { type: String, default: 'Anything' },
  platform: { type: String, default: 'Anything' },

  status: {
    type: String,
    enum: ['working_on_it', 'rejected', 'canceled', 'ready_to_upload'],
    default: 'working_on_it',
    index: true,
  },

  files: [rawContentFileSchema],

  // A text-format content item — the alternative to uploading files (a
  // creator can describe/write the content instead of attaching media), with
  // an optional voice recording alongside the typed text for when speaking is
  // easier than typing. Batch-level (one per record), not per-file — this is
  // its own kind of content, not a caption on an upload.
  textContent:        { type: String, default: '' },
  textVoiceFileId:    { type: mongoose.Schema.Types.ObjectId, default: null },
  textVoiceDiskName:  { type: String, default: null },

  // Inventory varieties this content is about/for — see rawContentProductSchema.
  products: [rawContentProductSchema],

  // Set once the status flips to 'ready_to_upload' — the linked readyToUpload doc.
  readyToUploadId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // Row-level scoping anchor (mine/group/all dataScope) — same pattern as CRM's owner.
  owner: { type: mongoose.Schema.Types.ObjectId },

  // Optional — which branch this batch is FOR (see the file-header note above).
  // null = unset, shown/filterable as "No branch" on the frontend.
  branchId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

  createdBy:   { type: mongoose.Schema.Types.ObjectId },
  createdByName: { type: String },
  updatedBy:   { type: mongoose.Schema.Types.ObjectId },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
  deleteDate: { type: Date, default: null },
});

rawContentSchema.index({ insertDate: -1 });
rawContentSchema.index({ owner: 1 });

module.exports = rawContentSchema;
