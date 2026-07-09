const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  title:         { type: String, required: true },
  description:   { type: String, default: '' },
  assigneeType:  { type: String, enum: ['user', 'group'], required: true },
  assignedUser:  { type: mongoose.Schema.Types.ObjectId, default: null },
  assignedGroup: { type: mongoose.Schema.Types.ObjectId, default: null },
  status:        { type: String, enum: ['open', 'claimed', 'done'], default: 'open' },
  claimedBy:     { type: mongoose.Schema.Types.ObjectId, default: null },
  claimedByName: { type: String, default: '' },
  createdBy:     { type: mongoose.Schema.Types.ObjectId, required: true },
  createdByName: { type: String, default: '' },
  // Phase 5 — CRM My Desk extensions
  module:    { type: String, enum: ['general', 'crm', 'mis', 'files', 'jobReport', 'projects'], default: 'general' },
  subjects:  [{ subjectType: { type: String }, subjectId: { type: mongoose.Schema.Types.ObjectId } }],
  insertDate:    { type: Date, default: Date.now },
  updateDate:    { type: Date, default: null },
  deleteDate:    { type: Date, default: null },
});

module.exports = taskSchema;
