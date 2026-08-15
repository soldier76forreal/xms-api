const mongoose = require('mongoose');

// A user's own work/job reports — shown in Users > (their profile) > Job
// Reports, alongside the Activity Log. Self-authored only (create/edit/delete
// always operate on req.user.id — see routes/users/users.js), but VISIBLE to
// anyone who can view that user's profile (users:view), unlike userNoteModel
// which is strictly private. reportDate is the field the list is organized
// and filtered by — distinct from insertDate (when the record was typed up).
const userJobReportSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  reportDate: { type: Date, required: true, index: true },
  title:      { type: String, default: '' },
  body:       { type: String, default: '' },
  files: [{
    fileId:    { type: mongoose.Schema.Types.ObjectId },
    kind:      { type: String, enum: ['audio', 'video', 'image', 'document'] },
    diskName:  { type: String },
    name:      { type: String },
    thumbnail: { type: String, default: null },
  }],
  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date },
  deleteDate: { type: Date, default: null },
});

module.exports = userJobReportSchema;
