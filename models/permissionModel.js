const mongoose = require('mongoose');

// ── Permission catalog (seed once; never deleted, only added) ─────────────────
// Key convention: module:resource:action  e.g. 'inventory:quantity:edit'
// Checked by requirePermission() middleware — NEVER check role names server-side.

const permissionSchema = new mongoose.Schema({
  key:         { type: String, required: true, unique: true, trim: true },
  module:      { type: String, required: true, trim: true },
  description: { type: String, default: '' },
}, { timestamps: true });

module.exports = permissionSchema;
