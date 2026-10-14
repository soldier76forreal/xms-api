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

  // ── Which form this report was filed on ───────────────────────────────────
  // A role picks the template its holders file on (role.jobReportTemplate);
  // the registry in utils/jobReportTemplates.js decides what is valid, so this
  // is a plain String and NOT a Mongoose enum - the same reason
  // branch.misTemplates is. An unknown key falls back to 'classic' at render
  // time instead of making the document unreadable. Every report filed before
  // templates existed has no value here and therefore reads as 'classic',
  // which is exactly what it is.
  templateKey: { type: String, default: 'classic' },

  // The answers, keyed by the template's section keys: a `fields` section
  // stores an object, a `table` section an array of row objects. Declared
  // Mixed because its shape IS the template, which lives in code - so any
  // write must call markModified('sections') (Mongoose cannot see into a
  // Mixed path, and a silently-dropped update is the BUG-05 trap again).
  // Never trusted from the client: resolveJobReportSections() in
  // utils/jobReportSections.js rebuilds it from the template spec and
  // re-snapshots every customer/variety/content reference server-side.
  sections: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

  // Flat, de-duplicated references pulled out of `sections` in the same
  // operation - what makes "every report that mentions this customer" a
  // query instead of a scan over Mixed.
  links: {
    customers:  [{ customerId: mongoose.Schema.Types.ObjectId, name: String, phone: String }],
    varieties:  [{ variantId: mongoose.Schema.Types.ObjectId, productId: mongoose.Schema.Types.ObjectId, code: String, productName: String }],
    dmContents: [{ kind: String, recordId: mongoose.Schema.Types.ObjectId, title: String }],
  },

  // 'draft' is an autosave in progress - the form writes one on every pause so
  // a rep who gets a phone call mid-report loses nothing. It is the author's
  // own working copy: excluded from the admin list, and it notifies nobody
  // until it is submitted. A classic report created the old way is born
  // 'submitted', which is why that is the default.
  status:      { type: String, enum: ['draft', 'submitted'], default: 'submitted', index: true },
  submittedAt: { type: Date, default: null },
  autoSavedAt: { type: Date, default: null },
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
userJobReportSchema.index({ userId: 1, status: 1, reportDate: -1 });
userJobReportSchema.index({ 'links.customers.customerId': 1 });

module.exports = userJobReportSchema;
