const mongoose = require('mongoose');

// Phase 8 — Digital Marketing. A raw content batch: the unedited material a
// content creator uploads (image/video/voice/PDF/other), each file carrying
// its own text OR voice description, plus batch-level language/useCase/
// platform. Files themselves live in the shared File Manager collection
// (scope:'digitalMarketing', attachedTo:{type:'rawContent', id}) — this doc
// only snapshots the fileId + per-file metadata, same convention as
// customerActivity.media[].
// NOT branch-scoped (confirmed 2026-07-09) — one shared pool across the org.

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

  // Set once the status flips to 'ready_to_upload' — the linked readyToUpload doc.
  readyToUploadId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // Row-level scoping anchor (mine/group/all dataScope) — same pattern as CRM's owner.
  owner: { type: mongoose.Schema.Types.ObjectId },

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
