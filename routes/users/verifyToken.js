const jwt = require("jsonwebtoken");
const dbConnection = require("../../connections/xmsPr");

// Loaded lazily: utils/ghost.js requires this connection module too, and
// pulling it in at module scope would create a require cycle on boot.
let ghost = null;
function ghostUtils() {
  if (!ghost) ghost = require("../../utils/ghost");
  return ghost;
}

// Verifies the caller's JWT and, when the token belongs to a ghost session,
// runs the ENTIRE remainder of the request inside that session's database
// context (see connections/xmsPr.js).
//
// A ghost token carries { id: <target user id>, ghostSessionId, realAdminId }.
// `id` is the impersonated user on purpose: every downstream permission check,
// data scope and branch filter then resolves exactly as it would for that
// user, with no per-route special-casing — which is what makes the ghost view
// a faithful copy rather than an approximation.
//
// SAFETY: a token claiming a ghost session whose record is missing, ended or
// expired is REJECTED (401). It must never fall through to the real database,
// because the caller would then be writing production data while believing
// they are in a sandbox.
module.exports = function (req, res, next) {
  var token = req.headers.authorization;

  if (!token) {
    return res.status(401).send('Not available');
  }

  token = token.split(" ")[1];
  let verified;
  try {
    verified = jwt.verify(token, process.env.TOKEN_SECRET);
  } catch (err) {
    return res.status(400).send("Invalid token");
  }

  if (!verified.ghostSessionId) {
    req.user = verified;
    return next();
  }

  // ── Ghost request ──────────────────────────────────────────────────────────
  ghostUtils().getActiveSession(verified.ghostSessionId)
    .then((session) => {
      if (!session) {
        return res.status(401).json({
          message: 'Ghost session has ended or expired',
          ghostSessionEnded: true,
        });
      }

      req.user = verified;
      req.ghostSession = session;
      // Keep the session alive while the admin is actively working, without
      // blocking the request on the write.
      ghostUtils().touchSession(session._id).catch(() => {});

      // Everything from here on — routers, models, async continuations — reads
      // and writes the cloned database instead of production.
      dbConnection.runInGhostContext(session.dbName, () => next());
    })
    .catch((err) => next(err));
};
