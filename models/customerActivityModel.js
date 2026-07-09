const mongoose = require('mongoose');

const customerActivitySchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  type: {
    type: String,
    enum: ['created','updated','call_logged','note','assigned','status_changed','interest','follow_up_set'],
    required: true,
  },
  field:    { type: String },
  oldValue: { type: mongoose.Schema.Types.Mixed },
  newValue: { type: mongoose.Schema.Types.Mixed },
  body:     { type: String },  // free note / call outcome
  // Voice/image/video attachments on a call_logged/note entry — files live in
  // the shared File Manager collection (scope:'crm', attachedTo:'customerActivity').
  media: [{
    fileId:    { type: mongoose.Schema.Types.ObjectId },
    kind:      { type: String, enum: ['audio', 'image', 'video'] },
    diskName:  { type: String },   // on-disk filename — served at /uploads/<diskName>
    name:      { type: String },   // original display filename
    thumbnail: { type: String },
  }],
  actorId:  { type: mongoose.Schema.Types.ObjectId },
  actorName:{ type: String },
  date:     { type: Date, default: Date.now },
  createdAt:{ type: Date, default: Date.now },
});

module.exports = customerActivitySchema;
