const express = require('express');
const crypto = require('crypto');
const path = require('path');

const verify = require('../users/verifyToken');
const { getEffectivePermissions } = require('../../utils/rbac');
const { PURPOSES } = require('./purposes');
const {
  createSession, getSession, appendChunk, completeSession,
  markCompleted, markFailed, cancelSession, listActiveSessions,
} = require('../../utils/resumableUpload');
const crashLogger = require('../../utils/crashLogger');

// ── Upload Center — the resumable transfer API ───────────────────────────────
//
//   POST   /uploads/sessions              start (returns id + chunkSize)
//   GET    /uploads/sessions              your resumable sessions (app restart)
//   GET    /uploads/sessions/:id          resume point (receivedBytes)
//   PUT    /uploads/sessions/:id/chunk    append the next slice
//   POST   /uploads/sessions/:id/complete assemble + hand to the module
//   DELETE /uploads/sessions/:id          cancel + delete the partial file
//
// Why this exists rather than the classic single multipart POST: a plain POST
// cannot resume. If the connection drops at 90% of a 2GB video the whole
// transfer is lost, and the user has to sit in a form watching it. Chunks make
// the resume point a single number (see models/uploadSessionModel.js), which is
// what lets an upload survive a dropped connection, a backgrounded phone, and
// a closed-then-reopened browser.
//
// The classic multipart routes are all still in place and untouched — this is
// an additional path, not a replacement, so nothing regresses if a client
// keeps using the old one.

const router = express.Router();

// 8MB ceiling per request. The client picks its own chunk size under this
// (2MB by default — small enough that a drop loses very little, large enough
// that the per-request overhead stays irrelevant).
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const SUGGESTED_CHUNK_BYTES = 2 * 1024 * 1024;

async function assertPurposeAllowed(purposeKey, userId) {
  const purpose = PURPOSES[purposeKey];
  if (!purpose) { const e = new Error(`Unknown upload purpose: ${purposeKey}`); e.status = 400; throw e; }
  // A null permission means the upload only ever touches the caller's own
  // data — see the note in purposes.js.
  if (purpose.permission) {
    const perms = await getEffectivePermissions(userId);
    if (!perms.has(purpose.permission)) {
      const e = new Error('Access denied'); e.status = 403; e.requiredPermission = purpose.permission; throw e;
    }
  }
  return purpose;
}

// ── POST /uploads/sessions — begin a resumable upload ───────────────────────
router.post('/sessions', verify, async (req, res) => {
  try {
    const { purpose, targetId = null, extra = {}, filename, mimetype, totalBytes } = req.body;
    if (!filename) return res.status(400).json({ message: 'filename is required' });

    const purposeDef = await assertPurposeAllowed(purpose, req.user.id);

    if (purposeDef.imagesOnly && !String(mimetype || '').startsWith('image/')) {
      return res.status(400).json({ message: 'Only image files are allowed for this upload' });
    }

    const session = await createSession({
      userId: req.user.id, purpose, targetId, extra,
      filename, mimetype, totalBytes: Number(totalBytes),
    });

    return res.status(201).json({
      sessionId: session._id,
      receivedBytes: 0,
      chunkSize: SUGGESTED_CHUNK_BYTES,
      maxChunkSize: MAX_CHUNK_BYTES,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message, code: err.code });
    crashLogger.logError(err, { type: 'uploadSessionCreateFailed' });
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /uploads/sessions — what was I uploading? (app restart / reconnect) ──
router.get('/sessions', verify, async (req, res) => {
  try {
    const sessions = await listActiveSessions(req.user.id);
    return res.status(200).json({
      data: sessions.map((s) => ({
        sessionId: s._id, purpose: s.purpose, targetId: s.targetId, extra: s.extra,
        filename: s.filename, mimetype: s.mimetype,
        totalBytes: s.totalBytes, receivedBytes: s.receivedBytes,
        insertDate: s.insertDate, expiresAt: s.expiresAt,
      })),
      chunkSize: SUGGESTED_CHUNK_BYTES,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /uploads/sessions/:id — the resume point ────────────────────────────
router.get('/sessions/:id', verify, async (req, res) => {
  try {
    const session = await getSession(req.params.id, req.user.id);
    if (!session) return res.status(404).json({ message: 'Upload session not found' });
    return res.status(200).json({
      sessionId: session._id, status: session.status,
      receivedBytes: session.receivedBytes, totalBytes: session.totalBytes,
      filename: session.filename, purpose: session.purpose, targetId: session.targetId,
      result: session.result,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /uploads/sessions/:id/chunk?offset=N — append the next slice ────────
// Raw body, not multipart: there is exactly one blob per request and no
// field metadata, so multipart framing would be pure overhead. Scoped
// express.raw() — the global bodyParser.json() ignores octet-stream, so the
// two don't collide.
router.put('/sessions/:id/chunk',
  verify,
  express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK_BYTES }),
  async (req, res) => {
    try {
      const offset = Number(req.query.offset);
      if (!Number.isFinite(offset) || offset < 0) {
        return res.status(400).json({ message: 'offset query parameter is required' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ message: 'Empty chunk body' });
      }

      const { receivedBytes, duplicate } = await appendChunk(req.params.id, req.user.id, offset, req.body);
      return res.status(200).json({ receivedBytes, duplicate });
    } catch (err) {
      if (err.status) {
        // On an offset mismatch, tell the client where the server actually is
        // so it can re-seek instead of restarting the whole file.
        return res.status(err.status).json({ message: err.message, code: err.code, receivedBytes: err.receivedBytes });
      }
      crashLogger.logError(err, { type: 'uploadChunkFailed', sessionId: req.params.id });
      return res.status(500).json({ message: 'Server error' });
    }
  });

// ── POST /uploads/sessions/:id/complete — assemble + hand to the module ─────
router.post('/sessions/:id/complete', verify, async (req, res) => {
  let sessionIdForFailure = req.params.id;
  try {
    const existing = await getSession(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ message: 'Upload session not found' });

    // Idempotent: a client that lost the response asks again rather than
    // re-uploading the whole file.
    if (existing.status === 'completed') {
      return res.status(200).json({ alreadyCompleted: true, result: existing.result });
    }

    const purposeDef = await assertPurposeAllowed(existing.purpose, req.user.id);

    const finalFilename = `${purposeDef.prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(existing.filename) || ''}`;
    const { session, file } = await completeSession(req.params.id, req.user.id, { finalFilename });

    const result = await purposeDef.complete({ file, session, userId: req.user.id });
    await markCompleted(session._id, result);

    return res.status(201).json({ sessionId: session._id, result });
  } catch (err) {
    if (err.status) {
      if (err.status >= 500) await markFailed(sessionIdForFailure, err.message).catch(() => {});
      return res.status(err.status).json({ message: err.message, code: err.code, receivedBytes: err.receivedBytes });
    }
    await markFailed(sessionIdForFailure, err.message).catch(() => {});
    crashLogger.logError(err, { type: 'uploadCompleteFailed', sessionId: req.params.id });
    return res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ── DELETE /uploads/sessions/:id — cancel + reclaim the partial file ────────
router.delete('/sessions/:id', verify, async (req, res) => {
  try {
    const ok = await cancelSession(req.params.id, req.user.id);
    if (!ok) return res.status(404).json({ message: 'Upload session not found' });
    return res.status(200).json({ cancelled: true });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
