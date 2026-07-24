const mongoose = require('mongoose');

// Digital Marketing — view/download audit trail for rawContent and
// readyToUpload records (mirror of inventoryChangeLogs / customerActivity /
// fileActivity — same "every relevant action writes a row" convention).
const dmActivitySchema = new mongoose.Schema({
  subjectType: { type: String, enum: ['rawContent', 'readyToUpload'], required: true },
  subjectId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  action: { type: String, enum: ['viewed', 'downloaded'], required: true },
  // Set only for a 'downloaded' row on a specific file within the record.
  fileId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  fileName: { type: String, default: '' },
  actorId:   { type: mongoose.Schema.Types.ObjectId, required: true },
  actorName: { type: String, default: '' },
  date: { type: Date, default: Date.now, index: true },
});

dmActivitySchema.index({ subjectType: 1, subjectId: 1, date: -1 });

module.exports = dmActivitySchema;
