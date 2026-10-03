const mongoose = require('mongoose');

// Follow-up / audit log for a deal letter — mirrors customerActivityModel.js's
// shape exactly (one doc per event, text OR voice/image/video via the shared
// File Manager collection), so a deal letter can carry MULTIPLE follow-up
// entries over time rather than a single mutable note field.
const supplyDealLetterActivitySchema = new mongoose.Schema({
  dealLetterId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  stage: { type: String, enum: ['purchasing', 'processing', 'final_product'] },   // status snapshot at entry time
  type: {
    type: String,
    enum: ['created', 'status_changed', 'forecast_updated', 'final_updated', 'price_updated', 'received', 'note', 'deleted'],
    required: true,
  },
  field:    { type: String },
  oldValue: { type: mongoose.Schema.Types.Mixed },
  newValue: { type: mongoose.Schema.Types.Mixed },
  body:     { type: String },   // free follow-up note text
  media: [{
    fileId:    { type: mongoose.Schema.Types.ObjectId },
    kind:      { type: String, enum: ['audio', 'image', 'video'] },
    diskName:  { type: String },
    name:      { type: String },
    thumbnail: { type: String },
  }],
  actorId:   { type: mongoose.Schema.Types.ObjectId },
  actorName: { type: String },
  date:      { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

module.exports = supplyDealLetterActivitySchema;
