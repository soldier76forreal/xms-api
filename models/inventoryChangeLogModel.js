const mongoose = require('mongoose');

const inventoryChangeLogSchema = new mongoose.Schema({
  subjectType: { type: String, enum: ['product', 'variant'], required: true },
  subjectId:   { type: mongoose.Schema.Types.ObjectId, required: true },
  productId:   { type: mongoose.Schema.Types.ObjectId, required: true },
  changeType: {
    type: String,
    enum: ['quantity', 'price', 'media', 'created', 'spec', 'status'],
    required: true,
  },
  field:    { type: String },
  oldValue: { type: mongoose.Schema.Types.Mixed },
  newValue: { type: mongoose.Schema.Types.Mixed },
  delta:    { type: Number },
  unit:     { type: String },
  currency: { type: String },
  mediaRef: {
    fileId: { type: mongoose.Schema.Types.ObjectId },
    action: { type: String, enum: ['added', 'removed'] },
    name:   { type: String },
  },
  reason: { type: String },
  source: {
    type: String,
    enum: ['manual', 'order', 'import', 'correction'],
    default: 'manual',
  },
  changedBy:     { type: mongoose.Schema.Types.ObjectId },
  changedByName: { type: String },
  date:      { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

module.exports = inventoryChangeLogSchema;
