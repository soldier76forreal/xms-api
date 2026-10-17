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
// A clone writes this collection FIRST, so a pre-made ghost database carries proof
// that this code filled it. The app only ever deletes a database it can show it
// filled: the boot tidy-up needs the marker, and a session refuses to start in a
// database that holds anything else (see assertSafeToEmpty). Two real mistakes
// led here — a test emptied a development database, and a restart emptied a
// database somebody had made for ghost sessions without checking what was in it.
const CLONE_MARKER = '_xms_ghost_clone';
const SKIP_COLLECTIONS = new Set(['ghostsessions', 'pwasubscriptions', CLONE_MARKER]);

// ── Pre-made ghost databases ─────────────────────────────────────────────────
// By default every session gets a NEW database with a random name
// (xms_ghost_<hex>) that this process creates, fills and finally DROPS. That
// only works when the MongoDB user may create and drop arbitrary databases —
// local development, a self-managed server. A scoped hosting user may not, and
// MongoDB cannot grant "any database named xms_ghost_*": its only wildcard is
// ALL databases, far more than a ghost session should ever be able to touch.
//
// GHOST_DB_NAMES sidesteps that. List one or more databases you made AHEAD of
// time (comma separated) and give the app's MongoDB user readWrite on exactly
// those. A session then takes a free one, EMPTIES it, clones into it, and
// empties it again at the end. Emptying drops collections one by one, which
// readWrite allows — dropDatabase would need dbAdmin. One database means one
// ghost session at a time; list more to allow more.
//
// ⚠️ Everything in a listed database is DELETED at the start and end of every
// session. The live database — and the system ones — are refused by name.
const SYSTEM_DATABASES = new Set(['admin', 'local', 'config']);

// Is this the database the app runs on (or one MongoDB itself needs)? Answered
// when it is ASKED, from every source there is, because no single one is
// reliable alone: the connection only learns its own name once it has opened,
// so a check made while this module loads sees an empty string and waves the
// live database through. (That is exactly how a test once emptied a real
// development database.) The DB_CONNECT URI is always there; the open
// connection is added whenever it can say.
function liveDatabaseNames() {
  const names = new Set();
  const uri = String(process.env.DB_CONNECT || '');
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]*)/i);
  if (m && m[1]) { try { names.add(decodeURIComponent(m[1]).toLowerCase()); } catch (_) { names.add(m[1].toLowerCase()); } }
  if (realConn.name) names.add(String(realConn.name).toLowerCase());
  if (realConn.db && realConn.db.databaseName) names.add(String(realConn.db.databaseName).toLowerCase());
  return names;
}

const isLiveDatabase = (name) => {
  const n = String(name || '').toLowerCase();
  return SYSTEM_DATABASES.has(n) || liveDatabaseNames().has(n);
};

function parseGhostPool(raw) {
  const pool = [];
  for (let entry of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    // A whole connection string was pasted: only its database name is used. The
    // app reuses its own connection and MongoDB user, so a host or credentials
    // in it would be ignored — say so rather than quietly pretending otherwise.
    if (/^mongodb(\+srv)?:\/\//i.test(entry)) {
      try {
        const name = decodeURIComponent(new URL(entry).pathname.replace(/^\//, ''));
        console.warn(`GHOST_DB_NAMES: "${name}" was given as a connection string. Only the database name is used; the app's own MongoDB user and host apply.`);
        entry = name;
      } catch (_) {
        console.warn('GHOST_DB_NAMES: an entry could not be read and was ignored.');
        continue;
      }
    }
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(entry)) {
      console.warn(`GHOST_DB_NAMES: "${entry}" is not a usable database name. Ignored.`);
      continue;
    }
    if (isLiveDatabase(entry)) {
      console.error(`GHOST_DB_NAMES: "${entry}" is the live or a system database. REFUSED — its contents would be deleted.`);
      continue;
    }
    if (!pool.includes(entry)) pool.push(entry);
  }
  return pool;
}

// DB_CONNECT_GHOST (see connections/xmsPr.js) is the same idea with its own
// connection. It is listed first, and a name given both ways counts once.
const DEDICATED = dbConnection.ghostDedicated || null;
const GHOST_DB_POOL = [
  ...(DEDICATED ? [DEDICATED.name] : []),
  ...parseGhostPool(process.env.GHOST_DB_NAMES).filter((n) => !DEDICATED || n !== DEDICATED.name),
];

// The handle for a ghost database: the dedicated connection's, or a database on
// the main connection (the only kind there was before).
async function ghostDb(name) {
  if (DEDICATED && name === DEDICATED.name) {
    await DEDICATED.connection.asPromise();
    return DEDICATED.connection.db;
  }
  return realConn.useDb(name, { useCache: true }).db;
}
const isPooledDb = (name) => GHOST_DB_POOL.includes(name) && !isLiveDatabase(name);

// dbName is UNIQUE across every session ever recorded, so a reusable database
// would collide with its own history on the second session. An ended session
// therefore hands the name back by recording where it was, not what it is.
const releasedName = (session) => (isPooledDb(session.dbName) ? `${session.dbName}@${session._id}` : session.dbName);

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
  const targetDb = await ghostDb(targetDbName);
  // Before anything else: from here on this database is demonstrably ours.
  await targetDb.collection(CLONE_MARKER).insertOne({
    startedAt: new Date(),
    note: 'Written by the ghost-session code. Everything in this database is a throwaway copy.',
  });

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

// Remove every collection from a pre-made database and leave the database
// itself. Needs only readWrite (listCollections + dropCollection).
async function emptyDatabase(dbName) {
  // The last line of defence, deliberately inside the one function that deletes:
  // however a name got here, the database the app runs on is never emptied.
  if (isLiveDatabase(dbName)) {
    throw new Error(`Refusing to empty the live or a system database: ${dbName}`);
  }
  const db = await ghostDb(dbName);
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const info of collections) {
    if (info.name.startsWith('system.')) continue;
    await db.collection(info.name).drop().catch((err) => {
      if (err && err.codeName !== 'NamespaceNotFound') throw err;
    });
  }
}

async function dropGhostDatabase(dbName) {
  if (!dbName || !(dbName.startsWith(GHOST_DB_PREFIX) || isPooledDb(dbName)) || isLiveDatabase(dbName)) {
    // Refuse to drop anything that is not demonstrably a ghost clone. This
    // guard is the difference between "cleanup" and "deleted production".
    throw new Error(`Refusing to drop non-ghost database: ${dbName}`);
  }
  // A pre-made database stays; only what is in it goes.
  if (isPooledDb(dbName)) { await emptyDatabase(dbName); return; }
  await realConn.useDb(dbName, { useCache: true }).dropDatabase();
}

// A pre-made database is emptied before and after every session. Only do that
// to a database that is empty, or that carries our marker (a clone left behind).
// Anything else is somebody's data and the session does not start — checked
// BEFORE the session record exists, because a failed start cleans up by
// emptying the database.
async function assertSafeToEmpty(name) {
  const present = (await (await ghostDb(name)).listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name).filter((n) => !n.startsWith('system.'));
  if (!present.length || present.includes(CLONE_MARKER)) return;
  const err = new Error(
    `The ghost database "${name}" already holds data this app did not put there (${present.slice(0, 8).join(', ')}${present.length > 8 ? ', …' : ''}). `
    + 'A ghost session empties its database, so it will not start in one it does not own. Empty it yourself, or point '
    + 'DB_CONNECT_GHOST / GHOST_DB_NAMES at an empty database.');
  err.code = 'GHOST_DB_NOT_EMPTY';
  throw err;
}

function ghostBusyError(holders) {
  const who = holders
    .map((h) => `${h.adminName || 'another admin'} (since ${new Date(h.startedAt).toLocaleString()})`)
    .join(', ');
  const err = new Error(`Every ghost database is in use: ${who}. End that session, or wait for it to expire, then try again.`);
  err.code = 'GHOST_POOL_BUSY';
  return err;
}

// Which database this session will use: a free pre-made one if any are listed,
// otherwise a fresh random name (the default, unchanged).
async function chooseGhostDatabase() {
  if (!GHOST_DB_POOL.filter(isPooledDb).length) {
    return { dbName: `${GHOST_DB_PREFIX}${crypto.randomBytes(8).toString('hex')}`, pooled: false };
  }
  const usable = GHOST_DB_POOL.filter(isPooledDb);
  const holders = await GhostSession.find({ status: 'active', dbName: { $in: usable } })
    .select('adminName startedAt dbName').lean();
  const taken = new Set(holders.map((h) => h.dbName));
  const free = usable.find((name) => !taken.has(name));
  if (!free) throw ghostBusyError(holders);
  return { dbName: free, pooled: true };
}

/** Create the session record and its cloned database. */
async function startGhostSession({ adminId, adminName, targetUserId, targetUserName }) {
  const { dbName, pooled } = await chooseGhostDatabase();
  if (pooled) await assertSafeToEmpty(dbName);

  let session;
  try {
    session = await GhostSession.create({
      adminId, adminName, targetUserId, targetUserName,
      dbName,
      status: 'active',
      startedAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
  } catch (err) {
    // dbName is unique, so two admins reaching for the same pre-made database in
    // the same instant cannot both win: the loser lands here, not in a clone
    // that is being filled underneath someone else.
    if (pooled && err && err.code === 11000) {
      throw ghostBusyError(await GhostSession.find({ status: 'active', dbName })
        .select('adminName startedAt dbName').lean());
    }
    throw err;
  }

  try {
    // Whatever an earlier session left in a pre-made database is not this one's.
    if (pooled) await emptyDatabase(dbName);
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
    // Only now give the name back — releasing it first would let another
    // session start while this one is still being emptied.
    if (pooled) await GhostSession.updateOne({ _id: session._id }, { $set: { dbName: releasedName(session) } });
    throw err;
  }
}

/**
 * Turn a start-up failure into something a person can act on. The raw MongoDB
 * message ("not authorized on xms_ghost_ab12… to execute command …") says what
 * failed, not what to do about it.
 */
function describeStartError(err) {
  if (err && (err.code === 'GHOST_POOL_BUSY' || err.code === 'GHOST_DB_NOT_EMPTY')) return { status: 409, message: err.message };
  const unauthorized = err && (err.code === 13 || err.codeName === 'Unauthorized' || /not authorized/i.test(err.message || ''));
  if (unauthorized) {
    return {
      status: 500,
      message: 'Could not start ghost session',
      detail: err.message,
      hint: DEDICATED
        ? `The user in DB_CONNECT_GHOST cannot write to "${DEDICATED.name}". Give that user readWrite on it.`
        : GHOST_DB_POOL.length
        ? `The database user has no write access to ${GHOST_DB_POOL.join(', ')}. Grant it readWrite on those databases.`
        : 'The database user may not create databases. Create a database for ghost sessions, give the user readWrite on it, and set GHOST_DB_NAMES=<that database> in .env (see utils/ghost.js).',
    };
  }
  return { status: 500, message: 'Could not start ghost session', detail: err && err.message };
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
        dbName: releasedName(session),
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
      // A pre-made database is reused, so a session can be starting in it while
      // this runs. Random names never are. Pre-made ones are tidied at boot only.
      if (isPooledDb(d.name)) continue;
      await dropGhostDatabase(d.name).catch(() => {});
      orphanCount += 1;
    }
  } catch (err) {
    // listDatabases needs cluster-level privileges that a scoped app user may
    // not have. TTL-based cleanup above still works, so this is non-fatal.
    crashLogger.logError(err, { type: 'ghostOrphanSweepSkipped' });
  }

  // Pre-made databases with no live session should hold nothing — a failed
  // wipe would otherwise leave a copy of production data lying around until the
  // next session. Boot only: nothing can be mid-start then, so this cannot
  // empty a database out from under a session that is filling it.
  let poolWiped = 0;
  if (reason === 'startupSweep') {
    for (const name of GHOST_DB_POOL) {
      try {
        if (await GhostSession.exists({ status: 'active', dbName: name })) continue;
        const left = await (await ghostDb(name)).listCollections({}, { nameOnly: true }).toArray();
        const real = left.filter((c) => !c.name.startsWith('system.'));
        if (real.some((c) => c.name === CLONE_MARKER)) {
          await emptyDatabase(name);        // a clone this code left behind
          poolWiped += 1;
        } else if (real.length) {
          // Not ours. Never touched here; a session refuses to start in it.
          console.warn(`Ghost database "${name}" holds data this app did not put there — left alone. A ghost session will not start in it until it is emptied.`);
        }
      } catch (err) {
        crashLogger.logError(err, { type: 'ghostPoolSweepFailed', dbName: name });
      }
    }
  }

  return { endedCount, orphanCount, poolWiped };
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
  CLONE_MARKER,
  GHOST_DB_POOL,
  GHOST_DEDICATED_NAME: DEDICATED ? DEDICATED.name : null,
  describeStartError,
  SESSION_TTL_MS,
  isOwner,
  cloneDatabase,
  dropGhostDatabase,
  emptyDatabase,
  isLiveDatabase,
  startGhostSession,
  endGhostSession,
  sweepGhostSessions,
  getActiveSession,
  touchSession,
};
