const jwt = require('jsonwebtoken');

// The website-visitor counterpart to routes/users/verifyToken.js — DELIBERATELY
// a separate middleware and a separate req property (req.visitor, never
// req.user) so a website-visitor token can never be mistaken for a staff
// token by any existing `verify`-gated route, or vice versa. Issued only by
// POST /public/website/otp/verify, payload shape { customerId, type:'websiteVisitor' }.
module.exports = function requireWebsiteVisitor(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ message: 'Not authenticated' });

  const token = header.split(' ')[1];
  let verified;
  try {
    verified = jwt.verify(token, process.env.TOKEN_SECRET);
  } catch (err) {
    return res.status(400).json({ message: 'Invalid token' });
  }

  if (verified.type !== 'websiteVisitor' || !verified.customerId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  req.visitor = verified;
  return next();
};
