const mongoose = require('mongoose');

// Phase 8 — Digital Marketing. Real-time chat on a raw content record between
// whoever's viewing it and the creator who uploaded the batch — text, voice,
// or file messages, Telegram-style. One Socket.io room per rawContentId (see
// utils/rbac-style pattern reused from routes/socket/xmsNotifications.js —
// no new socket mechanism). Files/voice notes live in the shared File Manager
// collection (scope:'digitalMarketing', attachedTo:{type:'rawContentChat', id}).

// A message belongs to EXACTLY ONE of rawContentId / readyToUploadId — the
// route layer is what guarantees that (see routes/digitalMarketing/main.js),
// not a schema-level constraint. rawContentId is the ORIGINAL thread (a ready-
// to-upload graduated from raw content reuses it — "same conversation, either
// side"). readyToUploadId is for a STANDALONE ready-to-upload record (created
// with no source raw content — see createReadyToUpload — which therefore has
// no rawContentId to hang a thread off at all; every existing row before this
// addition has rawContentId set and readyToUploadId null, so nothing about
// the original thread's data changes).
const rawContentChatSchema = new mongoose.Schema({
  rawContentId:    { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  readyToUploadId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

  senderId:   { type: mongoose.Schema.Types.ObjectId, required: true },
  senderName: { type: String },

  type: { type: String, enum: ['text', 'voice', 'file'], default: 'text' },
  body:   { type: String, default: '' },      // text messages
  fileId:   { type: mongoose.Schema.Types.ObjectId, default: null },   // voice/file messages
  fileDiskName: { type: String, default: '' },   // servable at /uploads/<fileDiskName>
  fileName: { type: String, default: '' },
  fileMime: { type: String, default: '' },

  date:      { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },

  // Edit — text messages only (see routes/digitalMarketing/main.js's PUT
  // .../chat/:messageId — voice/file messages carry no editable text).
  edited:     { type: Boolean, default: false },
  editedDate: { type: Date, default: null },

  // Soft delete — mirrors the rest of the app's deleteDate convention, but
  // named `deleted`/`deletedDate` here (not `deleteDate`) so a plain find()
  // doesn't need an extra deleted:null clause threaded through every chat
  // query; the two GET routes filter it at read time instead. body/file
  // fields are left in place (not blanked) so an already-delivered client
  // that missed the delete socket event still has the placeholder's source
  // data if ever needed — the frontend renders the placeholder purely off
  // the `deleted` flag.
  deleted:     { type: Boolean, default: false },
  deletedDate: { type: Date, default: null },

  // Read receipts — who has seen this message besides its own sender, and
  // when. Deliberately generic (not a single "seenByCreator" boolean):
  // whichever admin opens the thread stamps their own entry, and the
  // creator does the same for admin replies — the frontend derives the
  // Telegram-style single/double-tick from whether anyone OTHER than the
  // record's owner (for the owner's own messages) or the owner specifically
  // (for anyone else's messages) appears here. See rawContentChat.js.
  readBy: [{
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    date:   { type: Date, default: Date.now },
  }],
});

rawContentChatSchema.index({ rawContentId: 1, date: 1 });
rawContentChatSchema.index({ readyToUploadId: 1, date: 1 });

module.exports = rawContentChatSchema;
