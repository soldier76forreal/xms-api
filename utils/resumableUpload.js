const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dbConnection = require('../connections/xmsPr');
const uploadSessionSchema = require('../models/uploadSessionModel');
const crashLogger = require('./crashLogger');
const { BLOCKED_EXTENSIONS, BLOCKED_MIMETYPES, MAX_UPLOAD_BYTES } = require('./uploadGuards');

// Server side of the app-wide Upload Center. See models/uploadSessionModel.js
// for the protocol and why chunks are strictly sequential.
//
// This module owns ONLY the generic "get bytes onto disk, resumably" problem.
// It deliberately knows nothing about tutorials, inventory, job reports, etc.
// — completeSession() hands back a plain multer-shaped file object and each
// module runs the file-processing logic it already had. That split is what
// keeps this from turning into a second, parallel implementation of every
// module's upload behaviour.

const UploadSession = dbConnection.models.uploadSession
  || dbConnection.model('uploadSession', uploadSessionSchema);

// Partial uploads live apart from finished files so a half-written blob can
// never be mistaken for (or served as) real content — public/uploads is
// statically served, this directory is not reachable through it by name.
const TEMP_DIR = path.join('public', 'uploads', '_resumable');

// An abandoned session (user closed the browser and never came back) holds
// disk space; 24h is long enough that a genuine "resume tomorrow" still works.
const SESSION_TTL_MS = Number(process.env.UPLOAD_SESSION_TTL_HOURS || 24) * 60 * 60 * 1000;

function ensureTempDir() {
  try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch (_) { /* already there */ }
}

function extensionOf(filename = '') {
  const i = String(filename).lastIndexOf('.');
  return i < 0 ? '' : String(filename).slice(i).toLowerCase();
}

/**
 * Same policy the multer fileFilter enforces for classic uploads, applied at
 * session-creation time. Kept here (rather than importing the multer filter)
 * because there is no multer in this path at all — but it reads the SAME
 * blocklist constants, so the two can't drift.
 * Throws an Error with .status on rejection.
 */
function assertUploadAllowed({ filename, mimetype, totalBytes }) {
  const ext = extensionOf(filename);
  const mime = String(mimetype || '').toLowerCase();

  if (BLOCKED_EXTENSIONS.includes(ext) || BLOCKED_MIMETYPES.includes(mime)) {
    const err = new Error(`File type not allowed: ${ext || mime || 'unknown'}`);
    err.status = 400; err.code = 'BLOCKED_FILE_TYPE';
    throw err;
  }
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    const err = new Error('totalBytes must be a positive number');
    err.status = 400; err.code = 'BAD_SIZE';
    throw err;
  }
  if (totalBytes > MAX_UPLOAD_BYTES) {
    const err = new Error(`File too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`);
    err.status = 413; err.code = 'LIMIT_FILE_SIZE';
    throw err;
  }
}

async function createSession({ userId, purpose, targetId = null, extra = {}, filename, mimetype, totalBytes }) {
  assertUploadAllowed({ filename, mimetype, totalBytes });
  ensureTempDir();

  const tempName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.part`;
  const tempPath = path.join(TEMP_DIR, tempName);
  fs.writeFileSync(tempPath, '');   // create empty, so appends have a target

  const session = await UploadSession.create({
    userId, purpose, targetId, extra,
    filename, mimetype, totalBytes,
    receivedBytes: 0,
    tempPath,
    status: 'uploading',
    insertDate: new Date(),
    updateDate: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });

  return session;
}

async function getSession(sessionId, userId) {
  const session = await UploadSession.findById(sessionId).lean();
  if (!session) return null;
  // A session belongs to whoever created it — never let one user resume or
  // inspect another's transfer.
  if (String(session.userId) !== String(userId)) return null;
  return session;
}

/**
 * Append the next slice. `offset` must equal what the server already holds —
 * that check is what makes a duplicated or out-of-order chunk (a retry racing
 * a slow ack, say) a safe no-op instead of a corrupted file.
 */
async function appendChunk(sessionId, userId, offset, buffer) {
  const session = await getSession(sessionId, userId);
  if (!session) { const e = new Error('Upload session not found'); e.status = 404; throw e; }
  if (session.status !== 'uploading') { const e = new Error(`Session is ${session.status}`); e.status = 409; throw e; }

  // Idempotent replay: the client already sent this range and is retrying
  // after a lost acknowledgement. Report success with the true offset rather
  // than appending the same bytes twice.
  if (offset < session.receivedBytes) {
    return { receivedBytes: session.receivedBytes, duplicate: true };
  }
  if (offset !== session.receivedBytes) {
    const e = new Error(`Chunk offset mismatch: server has ${session.receivedBytes}, got ${offset}`);
    e.status = 409; e.code = 'OFFSET_MISMATCH'; e.receivedBytes = session.receivedBytes;
    throw e;
  }
  if (session.receivedBytes + buffer.length > session.totalBytes) {
    const e = new Error('Chunk would exceed declared file size');
    e.status = 400; throw e;
  }

  fs.appendFileSync(session.tempPath, buffer);

  // Trust the filesystem, not the arithmetic — if a previous append partially
  // failed, the real length is authoritative for where to resume.
  const realSize = fs.statSync(session.tempPath).size;
  await UploadSession.updateOne(
    { _id: sessionId },
    { $set: { receivedBytes: realSize, updateDate: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } }
  );

  return { receivedBytes: realSize, duplicate: false };
}

/**
 * Verify the transfer is whole and hand back a MULTER-SHAPED file object.
 *
 * The shape matters: every module already has working code that takes a multer
 * file (thumbnailing, File-doc creation, attaching to a parent record). By
 * handing back the same shape, the resumable path reuses all of it instead of
 * duplicating it — the caller just renames the file into its own naming
 * convention first (each module has its own prefix) via `finalFilename`.
 */
async function completeSession(sessionId, userId, { finalFilename, destDir = path.join('public', 'uploads') } = {}) {
  const session = await getSession(sessionId, userId);
  if (!session) { const e = new Error('Upload session not found'); e.status = 404; throw e; }
  if (session.status === 'completed') { const e = new Error('Session already completed'); e.status = 409; e.result = session.result; throw e; }
  if (session.status !== 'uploading') { const e = new Error(`Session is ${session.status}`); e.status = 409; throw e; }

  const realSize = fs.existsSync(session.tempPath) ? fs.statSync(session.tempPath).size : 0;
  if (realSize !== session.totalBytes) {
    const e = new Error(`Incomplete upload: have ${realSize} of ${session.totalBytes} bytes`);
    e.status = 409; e.code = 'INCOMPLETE'; e.receivedBytes = realSize;
    throw e;
  }

  const name = finalFilename || `upload-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionOf(session.filename)}`;
  const finalPath = path.join(destDir, name);
  fs.mkdirSync(destDir, { recursive: true });
  fs.renameSync(session.tempPath, finalPath);

  return {
    session,
    // Multer's file object shape — see the multer docs / any existing
    // req.file consumer in this codebase.
    file: {
      fieldname: 'files',
      originalname: session.filename,
      encoding: '7bit',
      mimetype: session.mimetype,
      destination: destDir,
      filename: name,
      path: finalPath,
      size: realSize,
    },
  };
}

/** Record the outcome after the module-specific completion logic has run. */
async function markCompleted(sessionId, result) {
  await UploadSession.updateOne(
    { _id: sessionId },
    { $set: { status: 'completed', result, updateDate: new Date() } }
  );
}

async function markFailed(sessionId, message) {
  await UploadSession.updateOne(
    { _id: sessionId },
    { $set: { status: 'failed', error: String(message || 'Upload failed'), updateDate: new Date() } }
  );
}

async function cancelSession(sessionId, userId) {
  const session = await getSession(sessionId, userId);
  if (!session) return false;
  try { if (fs.existsSync(session.tempPath)) fs.unlinkSync(session.tempPath); } catch (_) { /* best-effort */ }
  await UploadSession.updateOne({ _id: sessionId }, { $set: { status: 'cancelled', updateDate: new Date() } });
  return true;
}

/** List a user's resumable sessions — powers "what was I uploading?" on app restart. */
async function listActiveSessions(userId) {
  return UploadSession.find({ userId, status: 'uploading' }).sort({ insertDate: -1 }).limit(200).lean();
}

/**
 * Every upload this user has ever started — completed, cancelled and failed
 * included, not just what is still in flight. This is what makes the Upload
 * Center's history genuinely the USER's, not the browser's: reload the app on
 * a different device and the same history is there, because it was never
 * only in that first device's IndexedDB. Paginated since it only grows.
 */
async function listUploadHistory(userId, { page = 1, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;
  const [data, total] = await Promise.all([
    UploadSession.find({ userId }).sort({ updateDate: -1 }).skip(skip).limit(lim).lean(),
    UploadSession.countDocuments({ userId }),
  ]);
  return { data, total, page: Math.max(1, Number(page) || 1), limit: lim };
}

/**
 * Reclaim abandoned sessions and any stray .part files with no session row.
 * Runs on boot and on an interval — same shape as the ghost-session sweep.
 */
async function sweepUploadSessions() {
  let expired = 0;
  try {
    const stale = await UploadSession.find({ status: 'uploading', expiresAt: { $lte: new Date() } }).lean();
    for (const s of stale) {
      try { if (fs.existsSync(s.tempPath)) fs.unlinkSync(s.tempPath); } catch (_) { /* best-effort */ }
      await UploadSession.updateOne({ _id: s._id }, { $set: { status: 'cancelled', error: 'expired', updateDate: new Date() } });
      expired += 1;
    }
  } catch (err) {
    crashLogger.logError(err, { type: 'uploadSweepFailed' });
  }

  // Orphaned .part files (crash between file creation and the DB write).
  let orphans = 0;
  try {
    ensureTempDir();
    const live = new Set(
      (await UploadSession.find({ status: 'uploading' }).select('tempPath').lean()).map((s) => path.basename(s.tempPath))
    );
    for (const name of fs.readdirSync(TEMP_DIR)) {
      if (live.has(name)) continue;
      const full = path.join(TEMP_DIR, name);
      // Only touch files old enough that they can't be a session mid-creation.
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > 60 * 60 * 1000) { fs.unlinkSync(full); orphans += 1; }
      } catch (_) { /* best-effort */ }
    }
  } catch (err) {
    crashLogger.logError(err, { type: 'uploadOrphanSweepFailed' });
  }

  return { expired, orphans };
}

module.exports = {
  UploadSession,
  TEMP_DIR,
  SESSION_TTL_MS,
  assertUploadAllowed,
  createSession,
  getSession,
  appendChunk,
  completeSession,
  markCompleted,
  markFailed,
  cancelSession,
  listActiveSessions,
  listUploadHistory,
  sweepUploadSessions,
};
