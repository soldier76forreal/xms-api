const crypto = require('crypto');
const dbConnection = require('../connections/xmsPr');
const shortLinkSchema = require('../models/shortLinkModel');

const ShortLink = dbConnection.models.shortLink || dbConnection.model('shortLink', shortLinkSchema);

function generateCode() {
  return crypto.randomBytes(6).toString('base64url');
}

async function createShortLink({ module, entityType, entityId = null, payload = null, expiresAt = null, createdBy }) {
  let code = generateCode();
  // Collision odds are astronomically small (6 random bytes), but a unique
  // index is cheap insurance against a duplicate-key throw.
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await ShortLink.findOne({ code }).select('_id').lean();
    if (!clash) break;
    code = generateCode();
  }

  const doc = await ShortLink.create({
    code, module, entityType, entityId, payload, expiresAt, createdBy,
  });
  return doc.code;
}

async function resolveShortLink(code) {
  const link = await ShortLink.findOne({ code, deleteDate: null }).lean();
  if (!link) return null;
  if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) return null;
  return link;
}

module.exports = { ShortLink, createShortLink, resolveShortLink };
