const mongoose = require('mongoose');

// ── Group — team/department with shared permissions ───────────────────────────
// members: array of user ObjectIds (from shared DB — no ref string needed since
//          both APIs use the same DB_CONNECT and 'users' collection)
// permissions: additional keys granted to all members of this group
// dataScopes: future per-section data visibility  e.g. { crm: 'own' }

const groupSchema = new mongoose.Schema({
  name:        { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  members:     [{ type: mongoose.Schema.Types.ObjectId }],
  admins:      [{ type: mongoose.Schema.Types.ObjectId }],
  permissions: [{ type: String }],
  dataScopes:  { type: Object, default: {} },
  insertDate:  { type: Date, default: Date.now },
  updateDate:  { type: Date, default: null },
  deleteDate:  { type: Date, default: null },
});

module.exports = groupSchema;
