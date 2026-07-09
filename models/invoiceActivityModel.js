const mongoose = require('mongoose');

// Phase 6 — MIS / Invoices audit log (mirror of inventoryChangeLogs /
// customerActivity). RULE: every invoice/pre-invoice mutation (create / update /
// status / convert / payment / pdf / delete) writes a row in the SAME operation.

const invoiceActivitySchema = new mongoose.Schema({
  invoiceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  docType:   { type: String, enum: ['invoice', 'pre_invoice'] },
  type: {
    type: String,
    enum: ['created', 'updated', 'status', 'converted', 'pdf_generated', 'payment', 'stock_decremented', 'stock_restored', 'assigned', 'deleted'],
    required: true,
  },
  field:    { type: String },
  oldValue: { type: mongoose.Schema.Types.Mixed },
  newValue: { type: mongoose.Schema.Types.Mixed },
  body:     { type: String },
  actorId:  { type: mongoose.Schema.Types.ObjectId },
  actorName:{ type: String },
  date:     { type: Date, default: Date.now },
  createdAt:{ type: Date, default: Date.now },
});

module.exports = invoiceActivitySchema;
