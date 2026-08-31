const mongoose = require("mongoose");
const dotenv = require('dotenv')
const { AsyncLocalStorage } = require('async_hooks');
const crashLogger = require('../utils/crashLogger');
// useNewUrlParser/useUnifiedTopology/useFindAndModify are gone in Mongoose 6+
// (the driver always behaves as if they were true / findOneAndUpdate is native).
// strictQuery pinned explicitly to 'false' — that was Mongoose 5's actual
// default (queries may reference fields not in the schema); Mongoose 6.0.10+
// changed the default to 'true' (Mongoose 7 reverted it back to 'false'), so
// this line exists purely to keep behavior identical across that in-between window.
mongoose.set('strictQuery', false);
const dbConnection = mongoose.createConnection(process.env.DB_CONNECT);

// A Mongoose Connection is an EventEmitter — with no 'error' listener, a
// post-connect DB error (network blip, Atlas failover, auth expiry) throws as
// an unhandled exception and can take the whole process down with nothing
// logged. This is the single most important handler in this file: it's what
// stands between "brief DB hiccup" and "silent full outage."
dbConnection.on('error', (err) => {
  const crashId = crashLogger.logError(err, { type: 'mongoConnectionError' });
  console.error(`MongoDB connection error logged: ${crashId}`, err);
});
dbConnection.on('disconnected', () => {
  console.error('MongoDB connection lost — mongoose will keep retrying automatically.');
});
dbConnection.on('reconnected', () => {
  console.log('MongoDB connection restored.');
});

// ── Ghost-session database routing ───────────────────────────────────────────
// "Ghost in" lets an authorised admin browse the app AS another user to test
// that user's account. Anything the ghost creates must land in a throwaway
// database and never touch production data (see utils/ghost.js and
// routes/ghost/main.js).
//
// Routes bind their models once at module load (`dbConnection.model('customer',
// schema)`), so the switch cannot happen at the call site — it has to happen
// underneath. AsyncLocalStorage carries the active ghost database name for the
// lifetime of a request, and the model objects handed to routes are thin
// proxies that resolve to the right connection at property-access time.
//
// SAFETY PROPERTIES — the reason this is shaped the way it is:
//  * With no ghost context (every normal request, i.e. effectively all traffic)
//    the proxy returns the property off the SAME model object routes would have
//    got before this existed. The normal path is unchanged, not merely
//    equivalent.
//  * There is no fallback from ghost -> real. If a request is marked as a ghost
//    session, its queries can only ever reach the ghost database. A broken or
//    expired session is rejected at the auth layer (verifyToken) rather than
//    quietly degrading into writing production data.
//  * `useDb(..., { useCache: true })` reuses the existing connection pool, so a
//    ghost session costs no new sockets.
// KILL SWITCH — off by default, on purpose.
//
// Everything below puts a proxy in front of every model in the application, so
// a defect here would not be limited to ghost mode: it would affect every query
// the app makes. Until the feature has been exercised against a live database,
// the safe default is for this module to behave EXACTLY as it did before ghost
// mode existed — not "equivalently", but by returning the untouched connection
// object down the original code path.
//
// Set GHOST_ENABLED=true in .env to turn it on (and see routes/ghost/main.js,
// which reports 503 while it is off, so the UI can explain itself rather than
// failing obscurely).
const GHOST_ENABLED = String(process.env.GHOST_ENABLED || '').toLowerCase() === 'true';

const ghostContext = new AsyncLocalStorage();

/** Run `fn` with every DB access inside it routed to `ghostDbName`. */
function runInGhostContext(ghostDbName, fn) {
  return ghostContext.run({ ghostDbName }, fn);
}

/** The ghost database name active for the current async context, if any. */
function currentGhostDb() {
  const store = ghostContext.getStore();
  return (store && store.ghostDbName) || null;
}

function connectionFor(ghostDbName) {
  if (!ghostDbName) return dbConnection;
  return dbConnection.useDb(ghostDbName, { useCache: true });
}

// Models already compiled on the real connection, so the non-ghost path is a
// plain lookup returning the identical object every time.
const realModels = new Map();

function resolveModel(name, schema) {
  const ghostDb = currentGhostDb();
  if (!ghostDb) {
    let m = realModels.get(name);
    if (!m) {
      m = dbConnection.models[name] || dbConnection.model(name, schema);
      realModels.set(name, m);
    }
    return m;
  }
  const conn = connectionFor(ghostDb);
  return conn.models[name] || conn.model(name, schema);
}

// A Model is a constructor function, so the proxy target must be callable for
// `new Model()` to remain possible even though this codebase currently always
// goes through Model.create().
function makeModelProxy(name, schema) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop, receiver) {
      const M = resolveModel(name, schema);
      const value = Reflect.get(M, prop, M);
      // Methods must keep their Model as `this` (Model.find, Model.create, …).
      return typeof value === 'function' ? value.bind(M) : value;
    },
    set(_t, prop, value) {
      const M = resolveModel(name, schema);
      M[prop] = value;
      return true;
    },
    has(_t, prop) { return prop in resolveModel(name, schema); },
    ownKeys() { return Reflect.ownKeys(resolveModel(name, schema)); },
    getOwnPropertyDescriptor(_t, prop) {
      const d = Reflect.getOwnPropertyDescriptor(resolveModel(name, schema), prop);
      // A proxy may only report a non-configurable descriptor if the target has
      // one, which this dummy target never does.
      return d ? { ...d, configurable: true } : undefined;
    },
    getPrototypeOf() { return Reflect.getPrototypeOf(resolveModel(name, schema)); },
    construct(_t, args) {
      const M = resolveModel(name, schema);
      return Reflect.construct(M, args);
    },
    apply(_t, thisArg, args) {
      const M = resolveModel(name, schema);
      return M.apply(thisArg, args);
    },
  });
}

const modelProxies = new Map();

// Drop-in replacement for `dbConnection.model(name, schema)`. Same signature,
// same call sites; the returned object just knows how to follow a ghost
// session. Called with one argument (a lookup) it returns whatever already
// exists, matching mongoose's own behaviour.
function model(name, schema) {
  if (!schema) return dbConnection.model(name);
  if (!modelProxies.has(name)) modelProxies.set(name, makeModelProxy(name, schema));
  return modelProxies.get(name);
}

// Routes use the `dbConnection.models.x || dbConnection.model('x', schema)`
// idiom, so `.models` has to report the proxy for anything already registered —
// otherwise the left side would hand back a real-connection model and silently
// bypass ghost routing.
const modelsView = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop === 'string' && modelProxies.has(prop)) return modelProxies.get(prop);
    return dbConnection.models[prop];
  },
  has(_t, prop) {
    return (typeof prop === 'string' && modelProxies.has(prop)) || prop in dbConnection.models;
  },
  ownKeys() {
    return Array.from(new Set([...Object.keys(dbConnection.models), ...modelProxies.keys()]));
  },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
});

// Ghost disabled → hand back the real connection, byte-for-byte the original
// behaviour, with none of the proxy machinery above in the request path. The
// two helpers are still attached so callers (utils/ghost.js, verifyToken) can
// load without special-casing; they simply have nothing to route.
if (!GHOST_ENABLED) {
  dbConnection.realConnection = dbConnection;
  dbConnection.currentGhostDb = () => null;
  dbConnection.connectionFor = () => dbConnection;
  dbConnection.runInGhostContext = (_dbName, fn) => fn();
  dbConnection.ghostEnabled = false;
  module.exports = dbConnection;
  return;
}

// The module's public shape stays "a mongoose Connection" — everything not
// overridden below is forwarded to the real connection untouched.
module.exports = new Proxy(dbConnection, {
  get(conn, prop, receiver) {
    if (prop === 'model') return model;
    if (prop === 'models') return modelsView;
    if (prop === 'runInGhostContext') return runInGhostContext;
    if (prop === 'currentGhostDb') return currentGhostDb;
    if (prop === 'realConnection') return conn;
    if (prop === 'connectionFor') return connectionFor;
    if (prop === 'ghostEnabled') return true;
    const value = Reflect.get(conn, prop, conn);
    return typeof value === 'function' ? value.bind(conn) : value;
  },
});
