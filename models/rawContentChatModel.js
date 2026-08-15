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
});

rawContentChatSchema.index({ rawContentId: 1, date: 1 });
rawContentChatSchema.index({ readyToUploadId: 1, date: 1 });

module.exports = rawContentChatSchema;
