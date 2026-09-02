const mongoose = require('mongoose');

// Resumable upload session — the server side of the app-wide Upload Center.
//
// Every upload in the app (File Manager, Inventory media, Digital Marketing,
// Tutorials, CRM attachments, Job Reports, avatars) goes through the same
// three-step protocol instead of a single blocking multipart POST:
//
//   POST   /uploads/sessions              -> create a session, get an id
//   PUT    /uploads/sessions/:id/chunk    -> append the next slice of bytes
//   POST   /uploads/sessions/:id/complete -> assemble + hand off to the module
//
// Chunks are strictly SEQUENTIAL (each one appended at the current end of the
// file, client sends the next only after the previous is acknowledged). That
// is what makes resume trivially correct: `receivedBytes` IS the byte offset
// to resume from, with no gap-tracking or out-of-order bookkeeping to get
// wrong. The client asks GET /uploads/sessions/:id after a disconnect (or on
// app restart) and simply continues from that number.
//
// `purpose` decides two things at completion time: which permission gates the
// upload, and which module's existing file-handling logic runs (see the
// PURPOSES table in routes/uploads/sessions.js). The assembled file is handed
// to that module shaped exactly like a multer file object, so each module
// reuses the file-processing code it already had rather than growing a second
// parallel implementation.

const uploadSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

  // Which downstream flow this upload belongs to — see PURPOSES in
  // routes/uploads/sessions.js for the authoritative list.
  purpose: { type: String, required: true, index: true },

  // The parent record the finished file attaches to (a tutorialId, a
  // jobReport id, an inventory variantId, a folder path, …). Null for
  // purposes that have no parent (e.g. a File Manager upload to the root).
  targetId: { type: String, default: null },

  // Anything else the completion step needs that isn't the file itself —
  // branchId, folder path, a per-file description, the kind of media, etc.
  // Deliberately Mixed: each purpose owns its own shape here.
  extra: { type: mongoose.Schema.Types.Mixed, default: {} },

  filename:   { type: String, required: true },   // original display name
  mimetype:   { type: String, default: 'application/octet-stream' },
  totalBytes: { type: Number, required: true },
  // The resume point. Always equals the real byte length of tempPath on disk.
  receivedBytes: { type: Number, default: 0 },

  tempPath: { type: String, required: true },     // partial file being appended to

  status: {
    type: String,
    enum: ['uploading', 'completed', 'cancelled', 'failed'],
    default: 'uploading',
    index: true,
  },

  // What the completion step produced (the created File doc id, etc.) — kept
  // so a client that lost the completion response can ask what happened
  // instead of re-uploading.
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  error:  { type: String, default: null },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: Date.now },
  // Abandoned sessions (closed browser, never resumed) must not leave partial
  // files on disk forever — swept on boot and on an interval, same approach
  // as ghost sessions in utils/ghost.js.
  expiresAt: { type: Date, required: true, index: true },
});

uploadSessionSchema.index({ status: 1, expiresAt: 1 });
uploadSessionSchema.index({ userId: 1, status: 1 });

module.exports = uploadSessionSchema;
