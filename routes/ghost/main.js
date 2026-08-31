const express = require('express');
const jwt = require('jsonwebtoken');

const dbConnection = require('../../connections/xmsPr');
const userSchema = require('../../models/userModel');
const userAccessSchema = require('../../models/userAccessModel');

const verify = require('../users/verifyToken');
const {
  GhostSession, OWNER_PHONE, SESSION_TTL_MS,
  isOwner, startGhostSession, endGhostSession, sweepGhostSessions,
} = require('../../utils/ghost');

// "Ghost in" — an authorised admin browses the app AS another user, against a
// throwaway clone of the database, to test that user's account.
//
// Everything here runs on the REAL connection: granting rights, starting and
// ending sessions, and the session ledger must all be immune to ghost routing,
// or a ghost could grant itself rights or end sessions inside its own sandbox.
const realConn = dbConnection.realConnection;
const User = realConn.models.user || realConn.model('user', userSchema);
const UserAccess = realConn.models.userAccess || realConn.model('userAccess', userAccessSchema);

const router = express.Router();

// Ghost mode ships disabled (GHOST_ENABLED in .env — see connections/xmsPr.js
// for why the default is off). Reporting 503 with an explicit flag lets the UI
// hide the controls and say why, instead of the feature half-working.
router.use((req, res, next) => {
  if (!dbConnection.ghostEnabled) {
    return res.status(503).json({
      message: 'Ghost mode is disabled on this server (set GHOST_ENABLED=true to enable it).',
      ghostDisabled: true,
    });
  }
  return next();
});

// ── Owner gate ───────────────────────────────────────────────────────────────
// Deliberately NOT a permission key and NOT superAdmin: who may hand out
// impersonation rights is intentionally non-delegatable, so it cannot spread
// to whoever currently holds an admin role.
function requireOwner() {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) return res.status(401).json({ message: 'Not authenticated' });
      // A ghost must never be able to grant ghost rights, even if it is
      // impersonating the owner account.
      if (req.user.ghostSessionId) {
        return res.status(403).json({ message: 'Not available inside a ghost session' });
      }
      if (!(await isOwner(req.user.id))) {
        return res.status(403).json({ message: 'Only the account owner can manage ghost access' });
      }
      return next();
    } catch (err) { return next(err); }
  };
}

async function canGhost(userId) {
  const access = await UserAccess.findOne({ userId: String(userId) }).select('canGhost').lean();
  return !!(access && access.canGhost);
}

function requireGhostCapability() {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) return res.status(401).json({ message: 'Not authenticated' });
      if (req.user.ghostSessionId) {
        // No nesting: a ghost cannot start another ghost session.
        return res.status(403).json({ message: 'Already inside a ghost session' });
      }
      if (await isOwner(req.user.id)) return next();
      if (await canGhost(req.user.id)) return next();
      return res.status(403).json({ message: 'You do not have ghost access' });
    } catch (err) { return next(err); }
  };
}

async function actorName(userId) {
  const u = await User.findById(userId).select('firstName lastName').lean();
  return u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '';
}

// ── GET /ghost/access — who currently holds ghost rights (owner only) ────────
router.get('/access', verify, requireOwner(), async (req, res) => {
  try {
    const rows = await UserAccess.find({ canGhost: true }).select('userId').lean();
    const ids = rows.map((r) => r.userId);
    const users = await User.find({ _id: { $in: ids } }).select('firstName lastName phoneNumber').lean();
    return res.status(200).json({ users, ownerPhone: OWNER_PHONE });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /ghost/access/:userId — grant or revoke (owner only) ─────────────────
router.put('/access/:userId', verify, requireOwner(), async (req, res) => {
  try {
    const { canGhost: grant } = req.body;
    await UserAccess.updateOne(
      { userId: String(req.params.userId) },
      { $set: { canGhost: !!grant } },
      { upsert: true }
    );
    return res.status(200).json({ userId: req.params.userId, canGhost: !!grant });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /ghost/me — does the caller have ghost rights, and are they in one? ──
// Any authenticated user may call this; it only ever describes the CALLER, and
// the frontend needs it to decide whether to show the ghost controls at all.
router.get('/me', verify, async (req, res) => {
  try {
    if (req.user.ghostSessionId && req.ghostSession) {
      return res.status(200).json({
        inGhost: true,
        canGhost: false,
        isOwner: false,
        session: {
          _id: req.ghostSession._id,
          targetUserName: req.ghostSession.targetUserName,
          adminName: req.ghostSession.adminName,
          expiresAt: req.ghostSession.expiresAt,
        },
      });
    }
    const owner = await isOwner(req.user.id);
    return res.status(200).json({
      inGhost: false,
      canGhost: owner || (await canGhost(req.user.id)),
      isOwner: owner,
      session: null,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── POST /ghost/start/:userId — begin impersonating that user ────────────────
router.post('/start/:userId', verify, requireGhostCapability(), async (req, res) => {
  try {
    const targetId = req.params.userId;
    if (String(targetId) === String(req.user.id)) {
      return res.status(400).json({ message: 'You are already yourself' });
    }

    const target = await User.findOne({ _id: targetId, deleteDate: null }).select('firstName lastName').lean();
    if (!target) return res.status(404).json({ message: 'User not found' });

    // One live session per admin — a second one would leave the first clone
    // orphaned and the admin unsure which sandbox they are in.
    const existing = await GhostSession.findOne({ adminId: req.user.id, status: 'active' }).lean();
    if (existing) await endGhostSession(existing._id, 'exited');

    const adminDisplayName = await actorName(req.user.id);
    const targetDisplayName = `${target.firstName || ''} ${target.lastName || ''}`.trim();

    const { session, stats } = await startGhostSession({
      adminId: req.user.id,
      adminName: adminDisplayName,
      targetUserId: targetId,
      targetUserName: targetDisplayName,
    });

    // The ghost token impersonates the TARGET (id) while recording who is
    // really behind it (realAdminId) and which sandbox to use.
    const ghostToken = jwt.sign(
      { id: String(targetId), ghostSessionId: String(session._id), realAdminId: String(req.user.id) },
      process.env.TOKEN_SECRET,
      { expiresIn: Math.floor(SESSION_TTL_MS / 1000) }
    );

    return res.status(201).json({
      ghostToken,
      session: {
        _id: session._id,
        targetUserId: targetId,
        targetUserName: targetDisplayName,
        expiresAt: session.expiresAt,
      },
      clonedCollections: stats.collections,
      clonedDocuments: stats.copiedDocs,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Could not start ghost session', detail: err.message });
  }
});

// ── POST /ghost/stop — exit and destroy the sandbox ──────────────────────────
// Callable BOTH with a ghost token (the in-app "exit ghost" button) and with a
// normal admin token (cleaning up a session left behind by a closed browser).
router.post('/stop', verify, async (req, res) => {
  try {
    let sessionId = req.user.ghostSessionId || req.body.sessionId;

    if (!sessionId) {
      const mine = await GhostSession.findOne({ adminId: req.user.id, status: 'active' }).lean();
      sessionId = mine && mine._id;
    }
    if (!sessionId) return res.status(200).json({ message: 'No active ghost session', ended: false });

    const session = await GhostSession.findById(sessionId).lean();
    if (!session) return res.status(404).json({ message: 'Session not found' });

    // Only the admin who started it (or the owner) may end it.
    const requesterId = req.user.ghostSessionId ? req.user.realAdminId : req.user.id;
    if (String(session.adminId) !== String(requesterId) && !(await isOwner(requesterId))) {
      return res.status(403).json({ message: 'Not your ghost session' });
    }

    const ended = await endGhostSession(sessionId, 'exited');
    return res.status(200).json({ message: 'Ghost session ended', ended: true, session: ended });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /ghost/sessions — audit trail (owner only) ───────────────────────────
router.get('/sessions', verify, requireOwner(), async (req, res) => {
  try {
    const rows = await GhostSession.find({}).sort({ startedAt: -1 }).limit(100).lean();
    return res.status(200).json({ data: rows });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── POST /ghost/sweep — force cleanup of expired/orphaned sandboxes (owner) ──
router.post('/sweep', verify, requireOwner(), async (req, res) => {
  try {
    const result = await sweepGhostSessions('expired');
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
