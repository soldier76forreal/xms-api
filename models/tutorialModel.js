const mongoose = require('mongoose');

// Tutorial Center — in-app help material (video/image/document) for how to use
// each section of the app. Files live in the shared File Manager collection
// (scope:'tutorials', attachedTo:{type:'tutorial', id}) — this doc only
// snapshots fileId + per-file metadata, same convention as rawContentModel.js.
//
// Two-level classification: `section` is the coarse "which part of the app"
// bucket the per-section widgets filter on (required — even a general
// orientation tutorial belongs to a section, or 'general'); `tags` is the finer
// "which specific action" (optional, permission-key-shaped strings, e.g.
// 'crm:customer:create' — sourced from the live permission catalog via
// GET /tutorials/action-tags, not FK-enforced against it).
//
// No row-level dataScope — unlike CRM/Inventory/MIS/DM, tutorials are shared
// reference material: everyone with tutorials:view sees all of them.

const tutorialFileSchema = new mongoose.Schema({
  fileId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  diskName:  { type: String },   // on-disk filename — servable at /uploads/<diskName>
  name:      { type: String },   // original display filename
  mimetype:  { type: String },
  kind:      { type: String, enum: ['image', 'video', 'audio', 'pdf', 'other'] },
  thumbnail: { type: String, default: null },
  addedAt:   { type: Date, default: Date.now },
}, { _id: false });

const tutorialSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  description: { type: String, default: '' },
  language:    { type: String, enum: ['en', 'fa', 'ar'], required: true },
  section: {
    type: String,
    enum: ['crm', 'mis', 'inventory', 'digitalMarketing', 'users', 'files', 'general'],
    required: true,
    index: true,
  },
  tags: [{ type: String }],   // permission-key-shaped action tags, e.g. 'crm:customer:create'

  files: [tutorialFileSchema],

  owner:         { type: mongoose.Schema.Types.ObjectId },
  createdBy:     { type: mongoose.Schema.Types.ObjectId },
  createdByName: { type: String },
  updatedBy:     { type: mongoose.Schema.Types.ObjectId },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
  deleteDate: { type: Date, default: null },
});

tutorialSchema.index({ insertDate: -1 });
tutorialSchema.index({ tags: 1 });

module.exports = tutorialSchema;
