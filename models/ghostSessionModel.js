const mongoose = require('mongoose');

// "Ghost in" — an authorised admin browsing the app AS another user, to test
// that user's account without touching their data.
//
// Each session gets its OWN MongoDB database, cloned from production at the
// moment it starts (see utils/ghost.js). Every read and write the ghost makes
// is routed there by connections/xmsPr.js, so:
//   * the target user's real records are never modified,
//   * anything the ghost creates is invisible to everyone else,
//   * cleanup is a single dropDatabase() — nothing can survive by accident.
//
// This record itself lives in the REAL database (it is the audit trail of who
// impersonated whom, and it must outlive the ghost database it describes).

const ghostSessionSchema = new mongoose.Schema({
  // Who is doing the impersonating — always the real human, never the target.
  adminId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  adminName: { type: String, default: '' },

  // Whose account is being viewed.
  targetUserId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  targetUserName: { type: String, default: '' },

  // The throwaway database this session's queries are routed to.
  dbName: { type: String, required: true, unique: true },

  status: {
    type: String,
    enum: ['active', 'ended', 'expired', 'failed'],
    default: 'active',
    index: true,
  },

  // Sessions are time-boxed as well as explicitly exitable: a browser that is
  // simply closed never tells the server anything, so a TTL is the only
  // reliable way to guarantee the ghost database is eventually reclaimed.
  startedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
  lastSeenAt: { type: Date, default: Date.now },
  endedAt:   { type: Date, default: null },
  endedReason: { type: String, default: '' },   // 'exited' | 'expired' | 'startupSweep' | 'failed'

  // Set if the ghost database could not be dropped, so it can be retried and
  // is never silently left behind occupying disk.
  cleanupError: { type: String, default: null },
});

ghostSessionSchema.index({ status: 1, expiresAt: 1 });

module.exports = ghostSessionSchema;
