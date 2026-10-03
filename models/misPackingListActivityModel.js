const mongoose = require('mongoose');

// Session 72 — dedicated activity log for packing lists, NOT a reuse of
// invoiceActivityModel — that enum carries invoice-only values ('payment',
// 'converted', 'stock_decremented'...) that make no sense here, and coupling
// the two would mean every future invoice-only activity type risks leaking
// into packing-list history.
const misPackingListActivitySchema = new mongoose.Schema({
  packingListId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  type: {
    type: String,
    enum: ['created', 'updated', 'pallet_added', 'pallet_removed', 'linked_to_invoice', 'pdf_generated', 'label_generated', 'deleted'],
    required: true,
  },
  field:    { type: String },
  oldValue: { type: mongoose.Schema.Types.Mixed },
  newValue: { type: mongoose.Schema.Types.Mixed },
  body:     { type: String },
  actorId:   { type: mongoose.Schema.Types.ObjectId },
  actorName: { type: String },
  date:      { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

module.exports = misPackingListActivitySchema;
