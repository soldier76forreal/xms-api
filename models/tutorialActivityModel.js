const mongoose = require('mongoose');

// Tutorial Center audit trail — mirrors customerActivityModel.js exactly
// (same shape, same conventions), because the Tutorial Center's "who watched
// this" view is the same question CRM's `viewed` rows already answer for a
// customer record.
//
// A 'viewed' row is written every time someone OPENS a tutorial's detail — so
// unlike the mutation types, it is the one that accumulates repeatedly for the
// same actor. The views route de-duplicates per user for the "who watched"
// roster while still keeping every raw row for the log, so a genuine watch
// count and a last-watched timestamp are both derivable.
//
// No row-level dataScope, matching tutorialModel.js — tutorials are shared
// reference material, so anyone with tutorials:view can see the roster.

const tutorialActivitySchema = new mongoose.Schema({
  tutorialId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  type: {
    type: String,
    enum: ['created', 'updated', 'deleted', 'file_added', 'file_removed', 'viewed'],
    required: true,
  },
  field:    { type: String },
  oldValue: { type: mongoose.Schema.Types.Mixed },
  newValue: { type: mongoose.Schema.Types.Mixed },
  body:     { type: String },

  actorId:   { type: mongoose.Schema.Types.ObjectId, index: true },
  actorName: { type: String },
  date:      { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

// Backs both the per-tutorial views roster and the per-user activity feed.
tutorialActivitySchema.index({ tutorialId: 1, type: 1, date: -1 });
tutorialActivitySchema.index({ actorId: 1, date: -1 });

module.exports = tutorialActivitySchema;
