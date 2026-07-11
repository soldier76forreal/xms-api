const mongoose = require('mongoose');

// Phase 9 — File Manager activity feed (mirror of inventoryChangeLogs /
// customerActivity / invoiceActivity). RULE: every fileManager mutation route
// writes a row in the SAME operation. Powers the detail panel's Activity tab
// (the old UI only had a per-file logsStatus string — never a real feed).
const fileActivitySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['upload', 'new_folder', 'rename', 'move', 'copy', 'delete', 'tag_added', 'tag_removed', 'share_link', 'download'],
    required: true,
  },
  itemKind: { type: String, enum: ['file', 'folder'], required: true },
  itemId:   { type: mongoose.Schema.Types.ObjectId, index: true },
  itemName: { type: String },
  path:     { type: String },        // supFolder path the action happened in
  oldValue: { type: mongoose.Schema.Types.Mixed },
  newValue: { type: mongoose.Schema.Types.Mixed },
  actorId:   { type: mongoose.Schema.Types.ObjectId, index: true },
  actorName: { type: String },
  date:      { type: Date, default: Date.now, index: true },
});

module.exports = fileActivitySchema;
