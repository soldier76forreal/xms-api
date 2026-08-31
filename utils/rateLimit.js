// Minimal in-memory rate limiter.
//
// Hand-rolled rather than adding `express-rate-limit`, matching the convention
// authApi already uses for the OTP send-throttle and verify-lockout (this
// project's rule is no new dependency without asking, and the whole thing is
// ~40 lines).
//
// Scope and honest limitations, so nobody mistakes this for more than it is:
//  - State is per-process and in memory. It resets on restart and is NOT shared
//    across instances, so it is a brake on casual abuse and runaway clients,
//    not a defence against a distributed attacker. If the API is ever run
//    multi-instance behind a load balancer, this needs to move to Redis.
//  - Keyed by authenticated user id when available (so one logged-in account
//    cannot burn everyone else's budget from a shared office IP), falling back
//    to IP for unauthenticated requests.
//  - The auth-sensitive endpoints live in authApi, which already has its own
//    stricter per-phone/per-IP throttle; this covers the main data API.

const buckets = new Map();   // key -> { count, resetAt }

// Bounded sweep so the map cannot grow without limit on a long-running process.
function sweep(now) {
  if (buckets.size < 5000) return;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

function clientKey(req) {
  // req.user is set by verifyToken for authenticated routes.
  if (req.user && req.user.id) return `u:${req.user.id}`;
  const fwd = req.headers['x-forwarded-for'];
  const ip = (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.ip || req.socket?.remoteAddress || 'unknown';
  return `ip:${ip}`;
}

/**
 * @param {object}  opts
 * @param {number}  opts.windowMs  size of the rolling window
 * @param {number}  opts.max       requests allowed per window
 * @param {string}  opts.name      bucket namespace, so separate limiters don't share counters
 */
function rateLimit({ windowMs = 60_000, max = 300, name = 'default' } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    sweep(now);

    const key = `${name}|${clientKey(req)}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ message: 'Too many requests — please slow down.' });
    }
    return next();
  };
}

module.exports = { rateLimit };
