const mongoose = require('mongoose');

// Phase 8 — Digital Marketing. Created ONLY via a rawContent record's status
// toggling to 'ready_to_upload' — never a standalone POST (see DO NOT list).
// Always keeps a back-reference to its source raw content batch.

const readyToUploadFileSchema = new mongoose.Schema({
  fileId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  diskName:  { type: String },   // servable at /uploads/<diskName>
  name:      { type: String },
  mimetype:  { type: String },
  thumbnail: { type: String, default: null },
  addedAt:   { type: Date, default: Date.now },
}, { _id: false });

const readyToUploadSchema = new mongoose.Schema({
  rawContentId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

  files: [readyToUploadFileSchema],

  language: { type: String, default: '' },
  platform: { type: String, default: '' },   // Post / Reels / Story / YouTube Short / TikTok post / … (free text, extensible)
  caption:  { type: String, default: '' },

  owner: { type: mongoose.Schema.Types.ObjectId },

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
