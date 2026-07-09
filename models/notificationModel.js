const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  fromId:     { type: mongoose.Schema.Types.ObjectId, default: null },
  fromName:   { type: String, default: '' },
  type:       {
    type: String,
    enum: ['info', 'task', 'taskClaimed', 'taskDone', 'request', 'system', 'unlock'],
    default: 'info',
  },
  title:      { type: String, required: true },
  body:       { type: String, default: '' },
  entityType: { type: String, default: null },  // 'task' | 'invoice' | 'user' | etc.
  entityId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  isRead:     { type: Boolean, default: false, index: true },
  insertDate: { type: Date, default: Date.now },
  deleteDate: { type: Date, default: null },
});

module.exports = notificationSchema;
