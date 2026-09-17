const express  = require('express');
const mongoose = require('mongoose');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const dbConnection            = require('../../connections/xmsPr');
const inventoryProductSchema  = require('../../models/inventoryProductModel');
const inventoryVariantSchema  = require('../../models/inventoryVariantModel');
const categorySchema          = require('../../models/categoryModel');
const tagSchema                = require('../../models/inventoryTagModel');
const branchSchema            = require('../../models/branchModel');
const websiteEmailOtpSchema   = require('../../models/websiteEmailOtpModel');
const priceRequestSchema      = require('../../models/priceRequestModel');
const customerSchema          = require('../../models/customerModel');
const customerActivitySchema  = require('../../models/customerActivityModel');
const blogPostSchema          = require('../../models/blogPostModel');
const { toPublicProduct, PUBLIC_PRODUCT_SELECT, PUBLIC_VARIANT_SELECT } = require('../../utils/publicWebsite');
const { toPublicBlogListItem, toPublicBlogPost, PUBLIC_BLOG_LIST_SELECT, PUBLIC_BLOG_POST_SELECT } = require('../../utils/publicBlog');
const requireWebsiteVisitor = require('../../utils/requireWebsiteVisitor');
const { sendMail } = require('../../utils/mailer');
const { sendNotificationToUser } = require('../socket/xmsNotifications');

const InvProduct = dbConnection.models.inventoryProduct  || dbConnection.model('inventoryProduct',  inventoryProductSchema);
const InvVariant = dbConnection.models.inventoryVariant  || dbConnection.model('inventoryVariant',  inventoryVariantSchema);
const Category   = dbConnection.models.inventoryCategory || dbConnection.model('inventoryCategory', categorySchema);
const Tag        = dbConnection.models.inventoryTag      || dbConnection.model('inventoryTag',      tagSchema);
const Branch     = dbConnection.models.branch            || dbConnection.model('branch',            branchSchema);
const WebsiteOtp = dbConnection.models.websiteEmailOtp    || dbConnection.model('websiteEmailOtp',    websiteEmailOtpSchema);
const PriceRequest = dbConnection.models.priceRequest     || dbConnection.model('priceRequest',       priceRequestSchema);
const Customer    = dbConnection.models.customer          || dbConnection.model('customer',           customerSchema);
const CustomerActivity = dbConnection.models.customerActivity || dbConnection.model('customerActivity', customerActivitySchema);
const BlogPost   = dbConnection.models.blogPost           || dbConnection.model('blogPost',           blogPostSchema);

const router = express.Router();

// ── Email OTP constants — same thresholds as the phone OTP system
// (authApi/routes/users/auth.js), just keyed by email instead of phone. ────
const OTP_COOLDOWN_MS      = 60 * 1000;          // 60s between sends
const OTP_WINDOW_MS        = 30 * 60 * 1000;     // 30-min rolling window
const OTP_MAX_SENDS        = 5;                  // max sends per window
const OTP_EXPIRES_MS       = 3 * 60 * 1000;      // 3 min
const OTP_LOCKOUT_DURATION = 2 * 60 * 60 * 1000; // 2h lock
const OTP_MAX_VERIFY_FAILS = 5;
const VISITOR_TOKEN_EXPIRES = '90d';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Every route in this file is PUBLIC — no verify, no requirePermission, by
// design (see api/server.js's /public/website rate-limit mount for the
// abuse-defense side of that). Every response goes through
// toPublicProduct()/PUBLIC_*_SELECT — see utils/publicWebsite.js's header
// comment for why that's a hard rule, not a convention.

const VALID_LANGS = ['en', 'ar', 'fa'];
function pickLang(q) { return VALID_LANGS.includes(q) ? q : 'en'; }

// GET /public/website/products?branchId=&category=&tag=&search=&page=&limit=&lang=
router.get('/products', async (req, res) => {
  try {
    const lang = pickLang(req.query.lang);
    const { branchId, category, tag, search } = req.query;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    // Capped at 150 rather than 60 — the Product Table page fetches the whole
    // catalog in one request (flattens products into a per-variant row table
    // client-side, ~92 products today) since public/website has no separate
    // flat-variant endpoint. Still bounded + rate-limited, not unbounded.
    const limit = Math.min(150, parseInt(req.query.limit) || 24);
    const skip  = (page - 1) * limit;

    const productMatch = { deleteDate: null, 'website.published': true };
    if (branchId && mongoose.isValidObjectId(branchId)) productMatch.branchId = new mongoose.Types.ObjectId(branchId);
    if (tag && mongoose.isValidObjectId(tag)) productMatch['website.tags'] = new mongoose.Types.ObjectId(tag);
    if (search) {
      const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      productMatch.$or = [{ name: re }, { nameAr: re }, { nameFa: re }, { code: re }];
    }

    // category lives on the VARIANT (categories: [ObjectId]), not the
    // product — narrow to products that have at least one active variant in
    // that category before the main product query.
    if (category && mongoose.isValidObjectId(category)) {
      const ids = await InvVariant.distinct('productId', {
        deleteDate: null, status: 'active', categories: new mongoose.Types.ObjectId(category),
      });
      productMatch._id = { $in: ids };
    }

    const [products, total] = await Promise.all([
      InvProduct.find(productMatch).select(PUBLIC_PRODUCT_SELECT)
        .sort({ insertDate: -1 }).skip(skip).limit(limit).lean(),
      InvProduct.countDocuments(productMatch),
    ]);

    // One variants query for the whole page (not N+1) — active only, so an
    // out-of-stock/archived variant never shows publicly.
    const productIds = products.map((p) => p._id);
    const variants = await InvVariant.find({
      productId: { $in: productIds }, deleteDate: null, status: 'active',
    }).select(PUBLIC_VARIANT_SELECT).lean();
    const variantsByProduct = new Map();
    variants.forEach((v) => {
      const key = String(v.productId);
      if (!variantsByProduct.has(key)) variantsByProduct.set(key, []);
      variantsByProduct.get(key).push(v);
    });

    const data = products.map((p) => toPublicProduct(p, { lang, variants: variantsByProduct.get(String(p._id)) || [] }));
    return res.status(200).json({ data, total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /public/website/products/:slug?lang=
router.get('/products/:slug', async (req, res) => {
  try {
    const lang = pickLang(req.query.lang);
    const product = await InvProduct.findOne({
      'website.slug': req.params.slug, 'website.published': true, deleteDate: null,
    }).select(PUBLIC_PRODUCT_SELECT).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const variants = await InvVariant.find({
      productId: product._id, deleteDate: null, status: 'active',
    }).select(PUBLIC_VARIANT_SELECT).lean();

    return res.status(200).json(toPublicProduct(product, { lang, variants, includeContent: true }));
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /public/website/categories — id/name only; a category with zero
// published-product variants is still listed (an empty shelf is still a real
// nav entry), filtering that out is a frontend concern if wanted.
router.get('/categories', async (req, res) => {
  try {
    const cats = await Category.find({ deleteDate: null }).select('name').sort({ name: 1 }).lean();
    return res.status(200).json({ data: cats });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/tags', async (req, res) => {
  try {
    const tags = await Tag.find({ deleteDate: null }).select('name').sort({ name: 1 }).lean();
    return res.status(200).json({ data: tags });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /public/website/branches — id/name only, powers the branch-selector
// strip. Deliberately unfiltered by userAccess (there is no logged-in staff
// user here) — every active branch is a legitimate public choice.
router.get('/branches', async (req, res) => {
  try {
    const branches = await Branch.find({ deleteDate: null, status: 'active' }).select('name country address phone instagramHandle').sort({ name: 1 }).lean();
    return res.status(200).json({ data: branches });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /public/website/blog?page=&limit=&lang= — published posts only, newest first.
router.get('/blog', async (req, res) => {
  try {
    const lang = pickLang(req.query.lang);
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(30, parseInt(req.query.limit) || 12);
    const skip  = (page - 1) * limit;

    const match = { status: 'published', deleteDate: null };
    const [posts, total] = await Promise.all([
      BlogPost.find(match).select(PUBLIC_BLOG_LIST_SELECT)
        .sort({ publishedAt: -1 }).skip(skip).limit(limit).lean(),
      BlogPost.countDocuments(match),
    ]);
    return res.status(200).json({ data: posts.map((p) => toPublicBlogListItem(p, lang)), total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /public/website/blog/:slug?lang=
router.get('/blog/:slug', async (req, res) => {
  try {
    const lang = pickLang(req.query.lang);
    const post = await BlogPost.findOne({ slug: req.params.slug, status: 'published', deleteDate: null })
      .select(PUBLIC_BLOG_POST_SELECT).lean();
    if (!post) return res.status(404).json({ message: 'Post not found' });
    return res.status(200).json(toPublicBlogPost(post, lang));
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Email OTP — request ─────────────────────────────────────────────────────
router.post('/otp/request', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Enter a valid email address' });

    let rec = await WebsiteOtp.findOne({ email });
    const now = new Date();

    if (rec?.lockedUntil && rec.lockedUntil > now) {
      const remainingMin = Math.ceil((rec.lockedUntil - now) / 60000);
      return res.status(423).json({ message: `Too many attempts. Try again in ${remainingMin} minutes` });
    }
    if (rec?.otpLastSentAt && (now - new Date(rec.otpLastSentAt)) < OTP_COOLDOWN_MS) {
      const remainingS = Math.ceil((OTP_COOLDOWN_MS - (now - new Date(rec.otpLastSentAt))) / 1000);
      return res.status(429).json({ message: `Try again in ${remainingS} seconds` });
    }
    const inWindow = rec?.otpWindowStart && (now - new Date(rec.otpWindowStart)) < OTP_WINDOW_MS;
    if (inWindow && (rec.otpSendCount || 0) >= OTP_MAX_SENDS) {
      const remainingMin = Math.ceil((OTP_WINDOW_MS - (now - new Date(rec.otpWindowStart))) / 60000);
      return res.status(429).json({ message: `Send limit reached. Try again in ${remainingMin} minutes` });
    }

    const otp = String(crypto.randomInt(100000, 999999));
    const otpHash = await bcrypt.hash(otp, await bcrypt.genSalt(10));
    const otpExpiresAt = new Date(now.getTime() + OTP_EXPIRES_MS);

    const update = {
      otpHash, otpExpiresAt, otpLastSentAt: now,
      otpSendCount: inWindow ? (rec.otpSendCount || 0) + 1 : 1,
      otpWindowStart: inWindow ? rec.otpWindowStart : now,
      updateDate: now,
    };
    await WebsiteOtp.updateOne({ email }, { $set: update }, { upsert: true });

    try {
      await sendMail({
        to: email,
        subject: 'Your verification code',
        text: `Your verification code is ${otp}. It expires in 3 minutes.`,
        html: `<p>Your verification code is <b style="font-size:20px">${otp}</b>.</p><p>It expires in 3 minutes.</p>`,
      });
    } catch (mailErr) {
      return res.status(502).json({ message: 'Failed to send the code — please try again' });
    }

    return res.status(200).json({ message: 'Verification code sent' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Email OTP — verify → resolves/creates the CRM customer, issues the
// website-visitor JWT. Customer resolution happens HERE (not deferred to the
// price-request write) because every visitor-authenticated route needs a
// resolved customerId, not just price-requests — this is the one place
// "prove you own this email" and "have a CRM record" become the same act. ──
router.post('/otp/verify', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const otp = String(req.body.otp || '');
    if (!EMAIL_RE.test(email) || !otp) return res.status(400).json({ message: 'Missing required fields' });

    const rec = await WebsiteOtp.findOne({ email });
    const now = new Date();

    if (rec?.lockedUntil && rec.lockedUntil > now) {
      const remainingMin = Math.ceil((rec.lockedUntil - now) / 60000);
      return res.status(423).json({ message: `Too many attempts. Try again in ${remainingMin} minutes` });
    }
    if (!rec?.otpHash || !rec?.otpExpiresAt) return res.status(400).json({ message: 'Request a code first' });
    if (new Date(rec.otpExpiresAt) < now) return res.status(400).json({ message: 'Code expired — request a new one' });

    const valid = await bcrypt.compare(otp, rec.otpHash);
    if (!valid) {
      const newFailCount = (rec.failedAttempts || 0) + 1;
      if (newFailCount >= OTP_MAX_VERIFY_FAILS) {
        const lockedUntil = new Date(now.getTime() + OTP_LOCKOUT_DURATION);
        await WebsiteOtp.updateOne({ email }, { $set: { failedAttempts: 0, lockedUntil } });
        return res.status(423).json({ message: 'Too many failed attempts. Locked for 2 hours' });
      }
      await WebsiteOtp.updateOne({ email }, { $set: { failedAttempts: newFailCount } });
      return res.status(400).json({ message: 'Incorrect code', attemptsLeft: OTP_MAX_VERIFY_FAILS - newFailCount });
    }

    // Success — clear OTP state
    await WebsiteOtp.updateOne({ email }, { $set: { otpHash: null, otpExpiresAt: null, failedAttempts: 0, lockedUntil: null } });

    // Find-or-create the CRM customer by email. Website leads have no phone
    // at signup — the schema has no `required` validator on either field
    // (CRM's "only phoneNumber required" rule lives in the staff-facing
    // customerForm.js, not here), so this is a distinct, safe write path.
    let customer = await Customer.findOne({ 'commHandles.email': email, deleteDate: null });
    if (!customer) {
      customer = await Customer.create({
        commChannels: ['email'],
        commHandles: { email },
        status: 'new',
        owner: null,
        createdBy: null,
        insertDate: now,
      });
      await CustomerActivity.create({
        customerId: customer._id, type: 'created', actorId: null,
        actorName: 'Website visitor', body: 'Created via public website email verification', date: now,
      });
    }

    const token = jwt.sign({ customerId: String(customer._id), type: 'websiteVisitor' }, process.env.TOKEN_SECRET, { expiresIn: VISITOR_TOKEN_EXPIRES });
    return res.status(200).json({ accessToken: token, customerId: customer._id });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Price request — the core write. Requires the website-visitor JWT. ──────
router.post('/price-requests', requireWebsiteVisitor, async (req, res) => {
  try {
    const { items, name, phone, country, city, source, language } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'At least one item is required' });
    }
    if (!VALID_LANGS.includes(language)) {
      return res.status(400).json({ message: 'Invalid language' });
    }
    if (!['productPage', 'productTable'].includes(source)) {
      return res.status(400).json({ message: 'Invalid source' });
    }
    const visitorCountry = String(country || '').trim();
    const visitorCity = String(city || '').trim();
    if (!visitorCountry || !visitorCity) {
      return res.status(400).json({ message: 'Country and city are required' });
    }

    const customer = await Customer.findOne({ _id: req.visitor.customerId, deleteDate: null });
    if (!customer) return res.status(404).json({ message: 'Account not found' });

    // Resolve + snapshot every item server-side — never trust client-sent
    // productName/variantCode/branchId, only productId/variantId/quantity.
    const resolvedItems = [];
    for (const raw of items) {
      const { productId, variantId, quantity } = raw || {};
      if (!mongoose.isValidObjectId(productId) || !mongoose.isValidObjectId(variantId)) {
        return res.status(400).json({ message: 'Invalid product or variant' });
      }
      const qty = Number(quantity);
      if (!(qty > 0)) return res.status(400).json({ message: 'Quantity must be greater than zero' });

      const variant = await InvVariant.findOne({ _id: variantId, productId, deleteDate: null, status: 'active' })
        .select('code unit branchId').lean();
      const product = variant && await InvProduct.findOne({ _id: productId, deleteDate: null, 'website.published': true })
        .select('name').lean();
      if (!variant || !product) return res.status(404).json({ message: 'A requested item is no longer available' });

      resolvedItems.push({
        productId, variantId, productName: product.name, variantCode: variant.code,
        branchId: variant.branchId, quantity: qty, unit: variant.unit,
      });
    }

    const visitorName = String(name || '').trim();
    if (!visitorName) return res.status(400).json({ message: 'Name is required' });

    const visitorPhone = String(phone || '').trim();

    // Backfill the customer's name/phone on first contact only — never
    // overwrite values staff or a later visit already set.
    const custUpdate = { updateDate: new Date() };
    if (!customer.personalInformation?.firstName && !customer.personalInformation?.companyName) {
      custUpdate['personalInformation.firstName'] = visitorName;
    }
    if (visitorPhone && !customer.phoneNumber) {
      custUpdate.phoneNumber = visitorPhone;
    }
    const interestPush = resolvedItems.map((it) => ({ productId: it.productId, variantId: it.variantId }));
    await Customer.updateOne(
      { _id: customer._id },
      { $set: custUpdate, $push: { interestedProducts: { $each: interestPush } } }
    );

    const priceRequest = await PriceRequest.create({
      items: resolvedItems,
      customerId: customer._id,
      name: visitorName,
      email: customer.commHandles?.email || '',
      phone: visitorPhone, country: visitorCountry, city: visitorCity,
      source, language,
      insertDate: new Date(),
    });

    await CustomerActivity.create({
      customerId: customer._id, type: 'price_request', actorId: null, actorName: visitorName,
      body: `Requested a price for ${resolvedItems.length} item(s): ${resolvedItems.map((i) => i.variantCode).join(', ')}`,
      date: new Date(),
    });

    // Notify — group items by branch, one notification per branch's
    // configured recipients (fire-and-forget, never blocks the response).
    (async () => {
      try {
        const branchIds = [...new Set(resolvedItems.map((i) => String(i.branchId)))];
        const branches = await Branch.find({ _id: { $in: branchIds } }).select('priceRequestNotifyUsers').lean();
        const recipientIds = new Set();
        branches.forEach((b) => (b.priceRequestNotifyUsers || []).forEach((u) => recipientIds.add(String(u))));
        await Promise.all([...recipientIds].map((uid) => sendNotificationToUser(uid, {
          type: 'priceRequest',
          textKey: 'priceRequestNotify', textParams: { customerName: visitorName, itemCount: resolvedItems.length },
          entityType: 'customer', entityId: String(customer._id),
        })));
      } catch (_) { /* best-effort */ }
    })();

    return res.status(201).json({ _id: priceRequest._id });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Website-visitor profile ─────────────────────────────────────────────────
router.get('/me', requireWebsiteVisitor, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.visitor.customerId, deleteDate: null })
      .select('personalInformation commHandles').lean();
    if (!customer) return res.status(404).json({ message: 'Account not found' });
    const pi = customer.personalInformation || {};
    return res.status(200).json({
      name: pi.companyName || `${pi.firstName || ''} ${pi.lastName || ''}`.trim(),
      email: customer.commHandles?.email || '',
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/me/price-requests', requireWebsiteVisitor, async (req, res) => {
  try {
    const rows = await PriceRequest.find({ customerId: req.visitor.customerId })
      .sort({ insertDate: -1 }).lean();
    return res.status(200).json({ data: rows });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
