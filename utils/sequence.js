// System-wide, gap-safe sequences for human-facing codes that must be unique
// across ALL branches (e.g. supply records: SR-0001). Per-branch document
// numbers (invoices, quotations, packing lists) keep using invoiceCounterModel;
// this is for identities other branches also see and refer to.
//
// One document per key, incremented atomically ($inc with upsert), so two
// concurrent creates can never be handed the same number. Numbers are never
// handed back — a deleted record burns its code, same as a deleted invoice.
const mongoose = require('mongoose');
const dbConnection = require('../connections/xmsPr');

const sequenceSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 },
});

const Sequence = dbConnection.models.sequence || dbConnection.model('sequence', sequenceSchema);

async function nextSequence(key) {
  const doc = await Sequence.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return doc.seq;
}

// SR-0001 … SR-9999, then SR-10000 — padded to at least four digits.
const formatCode = (prefix, n, width = 4) => `${prefix}-${String(n).padStart(width, '0')}`;

module.exports = { nextSequence, formatCode, Sequence };
