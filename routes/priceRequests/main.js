const express = require('express');
const mongoose = require('mongoose');

const dbConnection = require('../../connections/xmsPr');
const priceRequestSchema = require('../../models/priceRequestModel');
const userSchema = require('../../models/userModel');
const verify = require('../users/verifyToken');
const { getEffectivePermissions } = require('../../utils/rbac');
const { sendMail } = require('../../utils/mailer');

const PriceRequest = dbConnection.models.priceRequest || dbConnection.model('priceRequest', priceRequestSchema);
const User = dbConnection.models.user || dbConnection.model('user', userSchema);

const router = express.Router();

// Price requests are visible/actionable from two different places in the app
// (Inventory's product detail, CRM's customer Requests tab) — kept as ONE
// route file rather than duplicated under each module, same reasoning as
// e.g. the shared shortLink resolver: one implementation, two entry points.

// GET /price-requests/product/:productId — mirrors the existing
// GET /inventory/products/:id/invoices reverse-lookup pattern. Gated by
// inventory:view (same as the invoices reverse-lookup).
router.get('/product/:productId', verify, async (req, res) => {
  try {
    const perms = await getEffectivePermissions(req.user.id);
    if (!perms.has('inventory:view')) return res.status(403).json({ message: 'Access denied' });
    if (!mongoose.isValidObjectId(req.params.productId)) return res.status(400).json({ message: 'Invalid ID' });

    const rows = await PriceRequest.find({ 'items.productId': req.params.productId })
      .sort({ insertDate: -1 }).limit(100).lean();
    return res.status(200).json({ data: rows });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /price-requests/:id/respond — the staff reply-by-email action. Callable
// by anyone holding EITHER inventory:website:manage (the Inventory tab) OR
// crm:communication:create (the CRM Requests tab) — a single shared action,
// not duplicated per surface, so there's exactly one permission check to
// reason about even though two different screens trigger it.
router.put('/:id/respond', verify, async (req, res) => {
  try {
    const perms = await getEffectivePermissions(req.user.id);
    if (!perms.has('inventory:website:manage') && !perms.has('crm:communication:create')) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid ID' });

    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ message: 'Reply text is required' });

    const pr = await PriceRequest.findById(req.params.id);
    if (!pr) return res.status(404).json({ message: 'Price request not found' });

    const staff = await User.findById(req.user.id).select('firstName lastName').lean();
    const staffName = staff ? `${staff.firstName || ''} ${staff.lastName || ''}`.trim() : '';

    pr.response = { body, respondedBy: req.user.id, respondedByName: staffName, respondedAt: new Date() };
    pr.status = 'responded';
    pr.updateDate = new Date();
    await pr.save();

    // The one place a price legitimately reaches the visitor — a human-typed
    // reply by email, never through the public API (see utils/publicWebsite.js).
    try {
      await sendMail({
        to: pr.email,
        subject: 'Re: your price request',
        text: body,
        html: `<p>${body.replace(/\n/g, '<br>')}</p>`,
      });
    } catch (mailErr) {
      // The reply is already saved — a delivery failure shouldn't roll that
      // back, but it also shouldn't silently look like success.
      return res.status(200).json({ data: pr, mailWarning: 'Reply saved, but the email failed to send' });
    }

    return res.status(200).json({ data: pr });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
