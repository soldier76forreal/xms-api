const express = require('express');
const mongoose = require('mongoose');

const dbConnection = require('../../connections/xmsPr');
const priceRequestSchema = require('../../models/priceRequestModel');
const userSchema = require('../../models/userModel');
const verify = require('../users/verifyToken');
const { getEffectivePermissions, requirePermission, requireBranch, assertBranchAccess } = require('../../utils/rbac');
const { sendMail } = require('../../utils/mailer');
const inventoryVariantSchema = require('../../models/inventoryVariantModel');
const {
  createOffer, withdrawOffer, offersByRequest, toStaffOffer, startOfferExpirySweep,
  OfferError, DEFAULT_VALID_HOURS,
} = require('../../utils/websiteOffers');

const PriceRequest = dbConnection.models.priceRequest || dbConnection.model('priceRequest', priceRequestSchema);
const User = dbConnection.models.user || dbConnection.model('user', userSchema);
const InvVariant = dbConnection.models.inventoryVariant || dbConnection.model('inventoryVariant', inventoryVariantSchema);

// Keeps the MIS side of website offers honest: an offer whose time ran out is
// flipped to 'expired' (and its sender told) once a minute.
startOfferExpirySweep();

const router = express.Router();

// The MIS Requests tab is branch-scoped. Website requests keep their own
// price-free record shape instead of being turned into draft invoices.
router.get('/branch', verify, requirePermission('mis:view'), requireBranch(), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.branchId)) {
      return res.status(400).json({ message: 'Invalid branch ID' });
    }
    const { status = '', search = '' } = req.query;
    if (status && !['new', 'seen', 'responded', 'closed'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 30));
    const query = {
      $or: [
        { branchId: req.branchId },
        // Requests submitted before branchId was added still have item branches.
        { branchId: null, 'items.branchId': req.branchId },
      ],
    };
    if (status) query.status = status;
    if (String(search).trim()) {
      const term = String(search).trim().slice(0, 100).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const re = new RegExp(term, 'i');
      query.$and = [{ $or: [
        { name: re }, { email: re }, { phone: re },
        { 'items.variantCode': re }, { 'items.productName': re },
      ] }];
    }
    const [data, total] = await Promise.all([
      PriceRequest.find(query).sort({ insertDate: -1, _id: -1 })
        .skip((page - 1) * limit).limit(limit).lean(),
      PriceRequest.countDocuments(query),
    ]);
    const offers = await offersByRequest(data.map((row) => row._id));
    const now = new Date();
    const rows = data.map((row) => ({ ...row, offer: toStaffOffer(offers.get(String(row._id)), now) }));
    return res.status(200).json({ data: rows, total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

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
    if (!perms.has('inventory:website:manage') && !perms.has('crm:communication:create') && !perms.has('mis:preinvoice:edit')) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid ID' });

    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ message: 'Reply text is required' });

    const pr = await PriceRequest.findById(req.params.id);
    if (!pr) return res.status(404).json({ message: 'Price request not found' });
    const branchId = pr.branchId || pr.items?.[0]?.branchId;
    if (!branchId || !(await assertBranchAccess(req.user.id, branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }

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

// ── Website offers ───────────────────────────────────────────────────────────
// Answering a customer's website request with prices. The answer is a quotation
// that expires (default 2 hours, the associate chooses); the customer is e-mailed
// the quantities and prices and accepts it on the website dashboard, which turns
// it into an invoice. See utils/websiteOffers.js for the whole flow.

const requestBranchId = (pr) => pr.branchId || (pr.items && pr.items[0] && pr.items[0].branchId) || null;

// GET /price-requests/:id - one request with what the associate needs to price it:
// the items with their current stock and list price, the branch's VAT/validity
// defaults, and the offer that has gone out for it (if any).
router.get('/:id', verify, requirePermission('mis:view'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid ID' });
    const pr = await PriceRequest.findById(req.params.id).lean();
    if (!pr) return res.status(404).json({ message: 'Price request not found' });
    const branchId = requestBranchId(pr);
    if (!branchId || !(await assertBranchAccess(req.user.id, branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }

    const variants = await InvVariant.find({ _id: { $in: (pr.items || []).map((i) => i.variantId) } })
      .select('_id quantity price currency').lean();
    const byId = new Map(variants.map((v) => [String(v._id), v]));
    const items = (pr.items || []).map((item) => {
      const v = byId.get(String(item.variantId));
      return {
        ...item,
        stock: v ? v.quantity : null,
        listPrice: v && v.price != null ? v.price : null,
        listCurrency: v && v.currency ? v.currency : null,
      };
    });

    const { loadProfile } = require('../mis/invoices');
    const profile = await loadProfile(branchId);
    const offers = await offersByRequest([pr._id]);
    return res.status(200).json({
      data: {
        ...pr, items,
        offer: toStaffOffer(offers.get(String(pr._id)), new Date()),
        defaults: { vatRate: (profile && profile.vatRate) ?? 5, validForHours: DEFAULT_VALID_HOURS },
      },
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /price-requests/:id/seen - an associate opened a new request.
router.put('/:id/seen', verify, requirePermission('mis:view'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid ID' });
    const pr = await PriceRequest.findById(req.params.id).select('status branchId items');
    if (!pr) return res.status(404).json({ message: 'Price request not found' });
    const branchId = requestBranchId(pr);
    if (!branchId || !(await assertBranchAccess(req.user.id, branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }
    if (pr.status === 'new') {
      await PriceRequest.updateOne({ _id: pr._id, status: 'new' }, { $set: { status: 'seen', updateDate: new Date() } });
    }
    return res.status(200).json({ status: pr.status === 'new' ? 'seen' : pr.status });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /price-requests/:id/offer - price the request and send it to the customer.
// Body: { lines:[{index, include?, quantity?, unitPrice, discount?, discountType?}],
//         deliveryCharge?, vatRate?, validForHours? (default 2), note? }
router.post('/:id/offer', verify, requirePermission('mis:preinvoice:create'), async (req, res) => {
  try {
    const { doc, mailWarning } = await createOffer({
      priceRequestId: req.params.id, actor: { id: req.user.id }, input: req.body || {},
    });
    const offers = await offersByRequest([doc.priceRequestId]);
    return res.status(201).json({
      data: toStaffOffer(offers.get(String(doc.priceRequestId)), new Date()),
      ...(mailWarning ? { mailWarning } : {}),
    });
  } catch (err) {
    if (err instanceof OfferError) return res.status(err.status).json({ message: err.message, ...err.extra });
    console.error('POST /price-requests/:id/offer failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /price-requests/:id/offer/withdraw - pull back an offer the customer has
// not accepted yet.
router.put('/:id/offer/withdraw', verify, requirePermission('mis:preinvoice:edit'), async (req, res) => {
  try {
    const doc = await withdrawOffer({ priceRequestId: req.params.id, actor: { id: req.user.id } });
    const offers = await offersByRequest([doc.priceRequestId]);
    return res.status(200).json({ data: toStaffOffer(offers.get(String(doc.priceRequestId)), new Date()) });
  } catch (err) {
    if (err instanceof OfferError) return res.status(err.status).json({ message: err.message, ...err.extra });
    console.error('PUT /price-requests/:id/offer/withdraw failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
