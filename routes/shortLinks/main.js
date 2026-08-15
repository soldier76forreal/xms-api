const express = require('express');
const verify = require('../users/verifyToken');
const { createShortLink, resolveShortLink } = require('../../utils/shortLink');

const router = express.Router();

const VALID_MODULES = ['crm', 'mis', 'inventory', 'digitalMarketing', 'users', 'files'];

// POST /shortlinks — mint a short code for a record the caller is already
// viewing. No extra permission gate on purpose: reaching this button at all
// means the caller already passed that record's own view-permission check.
// Access is re-checked independently, on the OTHER end, when the link is
// opened (each module's existing detail route does that — see resolve below).
router.post('/', verify, async (req, res) => {
  try {
    const { module: mod, entityType, entityId } = req.body || {};
    if (!VALID_MODULES.includes(mod) || !entityType || !entityId) {
      return res.status(400).json({ message: 'module, entityType and entityId are required' });
    }
    const code = await createShortLink({
      module: mod,
      entityType,
      entityId,
      expiresAt: null,
      createdBy: req.user.id,
    });
    return res.status(200).json({ code });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to create link' });
  }
});

// GET /shortlinks/:code/resolve — requires login (a logged-out hit is a
// plain 401, handled by the frontend redirecting to /logIn). Deliberately
// does NOT check permission/scope here — it only resolves the target; the
// frontend then re-fetches the entity through that module's own gated route,
// which is the single source of truth for whether this user may see it.
router.get('/:code/resolve', verify, async (req, res) => {
  try {
    const link = await resolveShortLink(req.params.code);
    if (!link) return res.status(404).json({ message: 'This link is no longer valid' });
    return res.status(200).json({
      module: link.module,
      entityType: link.entityType,
      entityId: link.entityId,
      payload: link.payload,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to resolve link' });
  }
});

module.exports = router;
