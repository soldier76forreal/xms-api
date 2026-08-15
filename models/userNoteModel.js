const mongoose = require('mongoose');

// Strictly personal notes — every route that reads/writes these MUST filter
// by req.user.id (the owner). There is no "view other user's notes" route,
// not even for superAdmin — this is the one dataset in the app with zero
// admin override, by explicit design (Pouriya: "no visible for any other
// users"). Attachments reuse the shared File Manager `files` collection
// (scope:'users', attachedTo:{type:'userNote', id}), same convention as
// everywhere else — see the model list in files docs.
const userNoteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  body:   { type: String, default: '' },
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

module.exports = userNoteSchema;
