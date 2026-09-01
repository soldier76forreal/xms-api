const mongoose = require('mongoose');

// A user's work/job reports. Originally a profile-only feature (Users > their
// profile > Job Reports, alongside the Activity Log); promoted to its own
// top-level section with two view modes — see routes/users/users.js's
// jobReports route family and CLAUDE.md's Job Reports section.
//
// Self-authored only (create/edit/delete/followUp always operate on
// req.user.id), but VISIBLE to anyone who can view that user's profile
// (users:view) or who holds jobReports:viewAll, unlike userNoteModel which is
// strictly private. reportDate is the field the list is organized and
// filtered by — distinct from insertDate (when the record was typed up).
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

  // Admin replies — a small back-and-forth thread on the report, not a full
  // chat system (matches the embedded-subdocument convention used elsewhere,
  // e.g. whatsappShareModel's contact/branch snapshots, rather than a new
  // collection — reply volume per report is expected to be small). Written
  // ONLY by a holder of jobReports:reply; each one fires a notification to
  // the report's owner.
  replies: [{
    authorId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    authorName: { type: String, default: '' },
    body:       { type: String, required: true },
    date:       { type: Date, default: Date.now },
  }],

  // Follow-ups — the report OWNER adding a dated update to their own record
  // over time, WITHOUT overwriting the original entry the way an edit does.
  // Text-only by design (the original report already carries attachments;
  // this is meant for a quick "still in progress" / "resolved" style update,
  // not a second full report).
  followUps: [{
    body:       { type: String, required: true },
    authorId:   { type: mongoose.Schema.Types.ObjectId, required: true },
    authorName: { type: String, default: '' },
    date:       { type: Date, default: Date.now },
  }],

  // Denormalized max(reportDate, updateDate, every reply/followUp date) —
  // what the admin list actually sorts by ("latest job reports" means latest
  // ACTIVITY, not just latest original submission). Recomputed in the same
  // operation as every write that can move it; see touchLastActivity() in
  // routes/users/users.js.
  lastActivityAt: { type: Date, default: Date.now, index: true },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date },
  deleteDate: { type: Date, default: null },
});

userJobReportSchema.index({ deleteDate: 1, lastActivityAt: -1 });

module.exports = userJobReportSchema;
