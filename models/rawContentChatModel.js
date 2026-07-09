const mongoose = require('mongoose');

// Phase 8 — Digital Marketing. Real-time chat on a raw content record between
// whoever's viewing it and the creator who uploaded the batch — text, voice,
// or file messages, Telegram-style. One Socket.io room per rawContentId (see
// utils/rbac-style pattern reused from routes/socket/xmsNotifications.js —
// no new socket mechanism). Files/voice notes live in the shared File Manager
// collection (scope:'digitalMarketing', attachedTo:{type:'rawContentChat', id}).

const rawContentChatSchema = new mongoose.Schema({
  rawContentId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

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

module.exports = rawContentChatSchema;
