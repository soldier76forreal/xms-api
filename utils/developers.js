// Who counts as a DEVELOPER — the people the bug and suggestion dashboard is for.
//
// Deliberately NOT a permission key and not a role: a role can be handed to
// whoever an administrator likes, and this dashboard is for the people who build
// the app. The same reasoning as the ghost feature's owner account (see
// utils/ghost.js OWNER_PHONE) — "who may do this" is pinned in code, not in a
// screen anybody with the right role can edit.
//
// The list is phone numbers, because the phone number is the account's identity
// here (it is the login). For now there is one. To add another without a code
// change, set DEVELOPER_PHONES in the API's environment (comma separated); it
// replaces the default list rather than adding to it, so include every number.
//
// Numbers are compared by their national digits, so 09918537814, +989918537814
// and 00989918537814 are all the same person.
const dbConnection = require('../connections/xmsPr');
const userSchema = require('../models/userModel');

const DEFAULT_DEVELOPER_PHONES = ['09918537814'];

// 09918537814 | +989918537814 | 00989918537814  →  9918537814
function nationalNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0098')) d = d.slice(4);
  else if (d.startsWith('98') && d.length >= 12) d = d.slice(2);
  return d.replace(/^0+/, '');
}

// Read on every call, not at load, so an environment change is picked up by a
// restart without anything being cached across tests.
function developerNumbers() {
  const raw = String(process.env.DEVELOPER_PHONES || '').trim();
  const list = raw ? raw.split(',') : DEFAULT_DEVELOPER_PHONES;
  return new Set(list.map(nationalNumber).filter(Boolean));
}

const isDeveloperPhone = (phone) => {
  const n = nationalNumber(phone);
  return !!n && developerNumbers().has(n);
};

// The REAL connection, on purpose: inside a ghost session the model proxy would
// route a lookup to the sandbox clone, and "is this account a developer" must be
// answered from the real accounts.
const realConn = dbConnection.realConnection;
const User = realConn.models.user || realConn.model('user', userSchema);

async function isDeveloper(userId) {
  if (!userId) return false;
  const user = await User.findById(userId).select('phoneNumber').lean();
  return !!user && isDeveloperPhone(user.phoneNumber);
}

// Every way an account's number may be written, for finding the developers'
// user records (to notify them).
const phoneVariants = (n) => [`0${n}`, n, `+98${n}`, `98${n}`, `0098${n}`];

async function developerUserIds() {
  const variants = [...developerNumbers()].flatMap(phoneVariants);
  if (!variants.length) return [];
  const users = await User.find({ phoneNumber: { $in: variants }, deleteDate: null }).select('_id').lean();
  return users.map((u) => String(u._id));
}

// Route gate. 403 for everyone else — and the dashboard's own routes answer the
// same whether the account is unknown or simply not a developer.
function requireDeveloper() {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) return res.status(401).json({ message: 'Not authenticated' });
      if (await isDeveloper(req.user.id)) return next();
      return res.status(403).json({ message: 'Developers only' });
    } catch (err) { return next(err); }
  };
}

module.exports = { isDeveloper, isDeveloperPhone, developerUserIds, requireDeveloper, nationalNumber, DEFAULT_DEVELOPER_PHONES };
