const mongoose = require('mongoose');

// One file on a ticket. Snapshotted onto the ticket (diskName, name, mimetype,
// thumbnail) so the page never needs a second lookup — same convention as DM's
// raw content files and CRM's customerActivity.media[]. The File Manager
// document (scope:'feedback', attachedTo:{type:'feedbackTicket'}) is what the
// bytes belong to; it never shows in the File Manager list.
const attachmentSchema = new mongoose.Schema({
  fileId:          { type: mongoose.Schema.Types.ObjectId },
  kind:            { type: String },                 // image | video | audio | pdf | other
  isVoice:         { type: Boolean, default: false }, // recorded in the form, as opposed to attached
  diskName:        { type: String },                 // the original upload — what a download hands back
  previewDiskName: { type: String, default: null },  // a browser-displayable copy (HEIC → JPEG)
  name:            { type: String },
  mimetype:        { type: String },
  size:            { type: Number },
  thumbnail:       { type: String, default: null },
}, { _id: false });

// Every status the ticket has been in. The first entry is written at creation;
// the admin panel appends the rest.
const statusEntrySchema = new mongoose.Schema({
  status: { type: String },
  at:     { type: Date, default: Date.now },
  byId:   { type: mongoose.Schema.Types.ObjectId },
  byName: { type: String },
  note:   { type: String, default: '' },
}, { _id: false });

const feedbackTicketSchema = new mongoose.Schema({
  // TK-0001 … from ONE system-wide sequence (utils/sequence.js); never reused.
  ticketNumber: { type: Number, required: true, unique: true },
  code:         { type: String, required: true },

  // Plain strings, validated in utils/feedbackConstants.js — not enums.
  type:         { type: String, required: true },     // bug | suggestion
  status:       { type: String, default: 'open' },
  statusHistory: [statusEntrySchema],

  title:        { type: String, required: true },
  description:  { type: String, default: '' },
  area:         { type: String, default: 'other' },
  attachments:  [attachmentSchema],

  // What the person was looking at. Optional — they can untick it in the form —
  // and apiVersion is stamped by the server, never trusted from the browser.
  context: {
    appVersion: String,
    apiVersion: String,
    path:       String,
    language:   String,
    viewport:   String,
    userAgent:  String,
  },

  // Row-level scoping anchor (mine/group/all) — same field name as CRM / DM.
  owner:         { type: mongoose.Schema.Types.ObjectId, required: true },
  createdByName: { type: String },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
  // Set when the OWNER changed the text after filing it (only possible while Open).
  editedAt:   { type: Date, default: null },
  // Soft delete — by the owner or by a developer. The record stays.
  deleteDate: { type: Date, default: null },
  deletedBy:     { type: mongoose.Schema.Types.ObjectId },
  deletedByName: { type: String },
});

feedbackTicketSchema.index({ owner: 1, insertDate: -1 });
feedbackTicketSchema.index({ status: 1, insertDate: -1 });
feedbackTicketSchema.index({ type: 1, insertDate: -1 });

module.exports = feedbackTicketSchema;
