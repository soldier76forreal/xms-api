const crypto = require('crypto');
const dbConnection = require('../connections/xmsPr');
const ghostSessionSchema = require('../models/ghostSessionModel');
const userSchema = require('../models/userModel');
const crashLogger = require('./crashLogger');

// Ghost-session lifecycle: create a throwaway clone of the production database,
// route a session to it, and reclaim it afterwards. See
// models/ghostSessionModel.js for why sessions exist and
// connections/xmsPr.js for how a request gets routed to the clone.

// GhostSession and User are read/written on the REAL connection deliberately —
// the session ledger and the identity lookup must not follow ghost routing, or
// a ghost would be able to see and end sessions inside its own sandbox copy.
const realConn = dbConnection.realConnection;
const GhostSession = realConn.models.ghostSession || realConn.model('ghostSession', ghostSessionSchema);
const User = realConn.models.user || realConn.model('user', userSchema);

// The single account allowed to hand out ghost access. Kept as an explicit
// constant (overridable by env for a different deployment) rather than a
// permission key, because "who may grant impersonation rights" is deliberately
// NOT delegatable — the whole point is that it cannot be spread around by
// whoever currently holds superAdmin. Mirrors how scripts/grantAdminAccess.js
// already pins an owner phone number.
const OWNER_PHONE = process.env.GHOST_OWNER_PHONE || '09918537814';

// Ghost databases are always named with this prefix so the cleanup sweep can
// recognise strays even if their session record was lost.
const GHOST_DB_PREFIX = 'xms_ghost_';

// How long a session may live without being explicitly exited. A closed browser
// tab never notifies the server, so this is what actually guarantees the clone
// is reclaimed. Refreshed by the heartbeat while the admin is active.
const SESSION_TTL_MS = Number(process.env.GHOST_TTL_MINUTES || 120) * 60 * 1000;

// Collections that must NOT be copied into a ghost clone.
//  - ghostsessions: the session ledger belongs to the real DB only.
//  - pwasubscriptions: push endpoints are real devices; a ghost must never be
//    able to trigger a push to someone's actual phone.
const SKIP_COLLECTIONS = new Set(['ghostsessions', 'pwasubscriptions']);

async function isOwner(userId) {
  const u = await User.findById(userId).select('phoneNumber').lean();
  return !!u && String(u.phoneNumber) === String(OWNER_PHONE);
}

/**
 * Copy every collection from the live database into `targetDbName`.
 *
 * Uses a batched cursor -> insertMany rather than mongodump/mongorestore so it
 * needs no external binary and no shell access. Indexes are recreated too:
 * without them a ghost session silently behaves differently from production
 * (unique constraints in particular), which would defeat the point of testing
 * against a copy.
 */
async function cloneDatabase(targetDbName) {
  const sourceDb = realConn.db;
  const targetDb = realConn.useDb(targetDbName, { useCache: true }).db;

  const collections = await sourceDb.listCollections({ type: 'collection' }).toArray();
  let copiedDocs = 0;
  const copiedCollections = [];

  for (const info of collections) {
    const name = info.name;
    if (name.startsWith('system.') || SKIP_COLLECTIONS.has(name.toLowerCase())) continue;

    const source = sourceDb.collection(name);
    const target = targetDb.collection(name);

    const cursor = source.find({});
    let batch = [];
    while (await cursor.hasNext()) {
      batch.push(await cursor.next());
      if (batch.length >= 500) {
        await target.insertMany(batch, { ordered: false });
        copiedDocs += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await target.insertMany(batch, { ordered: false });
      copiedDocs += batch.length;
    }

    // Recreate indexes so uniqueness/lookup behaviour matches production.
    try {
      const indexes = await source.indexes();
      for (const idx of indexes) {
        if (idx.name === '_id_') continue;   // created implicitly
        const { key, name: idxName, v, ns, ...options } = idx;
        await target.createIndex(key, { ...options, name: idxName }).catch(() => {});
      }
    } catch (_) { /* index copy is best-effort — data is already there */ }

    copiedCollections.push(name);
  }

  return { copiedDocs, collections: copiedCollections.length };
}

async function dropGhostDatabase(dbName) {
  if (!dbName || !dbName.startsWith(GHOST_DB_PREFIX)) {
    // Refuse to drop anything that is not demonstrably a ghost clone. This
    // guard is the difference between "cleanup" and "deleted production".
    throw new Error(`Refusing to drop non-ghost database: ${dbName}`);
  }
  await realConn.useDb(dbName, { useCache: true }).dropDatabase();
}

/** Create the session record and its cloned database. */
async function startGhostSession({ adminId, adminName, targetUserId, targetUserName }) {
  const dbName = `${GHOST_DB_PREFIX}${crypto.randomBytes(8).toString('hex')}`;

  const session = await GhostSession.create({
    adminId, adminName, targetUserId, targetUserName,
    dbName,
    status: 'active',
    startedAt: new Date(),
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });

  try {
    const stats = await cloneDatabase(dbName);
    return { session, stats };
  } catch (err) {
    // A half-cloned database must never be handed to a session — mark it failed
    // and clean up, rather than letting the admin work against partial data.
    await GhostSession.updateOne(
      { _id: session._id },
      { $set: { status: 'failed', endedAt: new Date(), endedReason: 'failed', cleanupError: err.message } }
    );
    await dropGhostDatabase(dbName).catch(() => {});
    throw err;
  }
}

/** End a session and reclaim its database. Idempotent. */
async function endGhostSession(sessionId, reason = 'exited') {
  const session = await GhostSession.findById(sessionId);
  if (!session) return null;
  if (session.status !== 'active') return session;

  let cleanupError = null;
  try {
    await dropGhostDatabase(session.dbName);
  } catch (err) {
    cleanupError = err.message;
    crashLogger.logError(err, { type: 'ghostCleanupFailed', dbName: session.dbName });
  }

  await GhostSession.updateOne(
    { _id: session._id },
    {
      $set: {
        status: reason === 'expired' ? 'expired' : 'ended',
        endedAt: new Date(),
        endedReason: reason,
        cleanupError,
      },
    }
  );
  return GhostSession.findById(session._id).lean();
}

/**
 * Reclaim anything left behind: sessions past their TTL, and ghost databases
 * with no matching active session (a crash between clone and record write, or
 * a failed drop). Safe to call repeatedly; runs on boot and on a timer.
 */
async function sweepGhostSessions(reason = 'expired') {
  let endedCount = 0;
  const stale = await GhostSession.find({ status: 'active', expiresAt: { $lte: new Date() } }).lean();
  for (const s of stale) {
    await endGhostSession(s._id, reason);
    endedCount += 1;
  }

  // Orphan sweep — a ghost DB whose session is no longer active.
  let orphanCount = 0;
  try {
    const admin = realConn.db.admin();
    const { databases } = await admin.listDatabases();
    const activeNames = new Set(
      (await GhostSession.find({ status: 'active' }).select('dbName').lean()).map((s) => s.dbName)
    );
    for (const d of databases) {
      if (!d.name.startsWith(GHOST_DB_PREFIX)) continue;
      if (activeNames.has(d.name)) continue;
      await dropGhostDatabase(d.name).catch(() => {});
      orphanCount += 1;
    }
  } catch (err) {
    // listDatabases needs cluster-level privileges that a scoped app user may
    // not have. TTL-based cleanup above still works, so this is non-fatal.
    crashLogger.logError(err, { type: 'ghostOrphanSweepSkipped' });
  }

  return { endedCount, orphanCount };
}

/** Look up an active, unexpired session. Used by the auth layer on every ghost request. */
async function getActiveSession(sessionId) {
  if (!sessionId) return null;
  const s = await GhostSession.findOne({ _id: sessionId, status: 'active' }).lean();
  if (!s) return null;
  if (new Date(s.expiresAt).getTime() <= Date.now()) {
    endGhostSession(s._id, 'expired').catch(() => {});
    return null;
  }
  return s;
}

/** Push the expiry out while the admin is actively using the session. */
async function touchSession(sessionId) {
  await GhostSession.updateOne(
    { _id: sessionId, status: 'active' },
    { $set: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } }
  ).catch(() => {});
}

module.exports = {
  GhostSession,
  OWNER_PHONE,
  GHOST_DB_PREFIX,
  SESSION_TTL_MS,
  isOwner,
  cloneDatabase,
  dropGhostDatabase,
  startGhostSession,
  endGhostSession,
  sweepGhostSessions,
  getActiveSession,
  touchSession,
};
