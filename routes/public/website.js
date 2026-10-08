const express  = require('express');
const mongoose = require('mongoose');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const dbConnection            = require('../../connections/xmsPr');
const inventoryProductSchema  = require('../../models/inventoryProductModel');
const inventoryVariantSchema  = require('../../models/inventoryVariantModel');
const productContentSchema    = require('../../models/websiteProductContentModel');
const productTaxonomySchema   = require('../../models/websiteProductTaxonomyModel');
const productPreviewSchema    = require('../../models/websiteProductPreviewModel');
const branchSchema            = require('../../models/branchModel');
const websiteEmailOtpSchema   = require('../../models/websiteEmailOtpModel');
const priceRequestSchema      = require('../../models/priceRequestModel');
const customerSchema          = require('../../models/customerModel');
const customerActivitySchema  = require('../../models/customerActivityModel');
const blogPostSchema          = require('../../models/blogPostModel');
const { toPublicBlogListItem, toPublicBlogPost, PUBLIC_BLOG_LIST_SELECT, PUBLIC_BLOG_POST_SELECT } = require('../../utils/publicBlog');
const requireWebsiteVisitor = require('../../utils/requireWebsiteVisitor');
const { sendMail } = require('../../utils/mailer');
const { sendNotificationToUser } = require('../socket/xmsNotifications');
const { websiteBranchSlug } = require('../../utils/websiteBranchSlug');
const { AnalyticsEvent, sanitizeBatch, hostOf } = require('../../utils/websiteAnalytics');
const {
  offersByRequest, toPublicOffer, renderCustomerDocument, acceptOffer, OfferError,
} = require('../../utils/websiteOffers');

const InvProduct = dbConnection.models.inventoryProduct  || dbConnection.model('inventoryProduct',  inventoryProductSchema);
const InvVariant = dbConnection.models.inventoryVariant  || dbConnection.model('inventoryVariant',  inventoryVariantSchema);
const ProductContent = dbConnection.models.websiteProductContent || dbConnection.model('websiteProductContent', productContentSchema);
const ProductTaxonomy = dbConnection.models.websiteProductTaxonomy || dbConnection.model('websiteProductTaxonomy', productTaxonomySchema);
const ProductPreview = dbConnection.models.websiteProductPreview || dbConnection.model('websiteProductPreview', productPreviewSchema);
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

function visitorCan(req, capability) {
  return Array.isArray(req.visitor?.capabilities) && req.visitor.capabilities.includes(capability);
}

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeProductCode(input) {
  const raw = String(input || '').trim().toUpperCase();
  const match = raw.match(/[A-Z]{2}\d{2}/);
  return match ? match[0] : raw;
}

function localized(doc, field, lang) {
  if (!doc) return '';
  if (lang === 'ar' && doc[`${field}Ar`]) return doc[`${field}Ar`];
  if (lang === 'fa' && doc[`${field}Fa`]) return doc[`${field}Fa`];
  return doc[field] || '';
}

function toPublicTaxonomy(t, lang) {
  return {
    _id: t._id,
    type: t.type,
    name: localized(t, 'name', lang),
    slug: localized(t, 'slug', lang) || t.slug,
    description: localized(t, 'description', lang),
    image: t.image?.url ? {
      url: t.image.url,
      attachmentId: t.image.attachmentId || null,
      alt: t.image.alt || localized(t, 'name', lang),
    } : null,
  };
}

function branchPayload(branch) {
  if (!branch) return null;
  return {
    _id: branch._id,
    name: branch.name,
    country: branch.country || null,
    websiteSlug: websiteBranchSlug(branch),
    flagImage: branch.flagImage || '',
    address: branch.address || '',
    phone: branch.phone || '',
    instagramHandle: branch.instagramHandle || '',
  };
}

async function resolveWebsiteBranch(branchId) {
  if (branchId && mongoose.isValidObjectId(branchId)) {
    const selected = await Branch.findOne({ _id: branchId, deleteDate: null, status: 'active' })
      .select('name country websiteSlug flagImage address phone instagramHandle').lean();
    if (selected) return selected;
  }

  return await Branch.findOne({
    deleteDate: null,
    status: 'active',
    $or: [
      { country: /^AE$/i },
      { name: /(^|\b)(uae|united arab emirates)(\b|$)/i },
    ],
  }).select('name country websiteSlug flagImage address phone instagramHandle').sort({ name: 1 }).lean()
    || await Branch.findOne({ deleteDate: null, status: 'active' })
      .select('name country websiteSlug flagImage address phone instagramHandle').sort({ name: 1 }).lean();
}

async function taxonomyIdFromParam(raw, type) {
  if (!raw) return null;
  if (mongoose.isValidObjectId(raw)) return raw;
  const slug = String(raw || '').trim().toLowerCase();
  if (!slug) return null;
  const item = await ProductTaxonomy.findOne({ type, deleteDate: null, $or: [{ slug }, { slugAr: slug }, { slugFa: slug }] })
    .select('_id').lean();
  return item?._id || null;
}

async function resolveAvailability(code, branchId) {
  const match = { code: normalizeProductCode(code), deleteDate: null, status: 'active' };
  if (branchId && mongoose.isValidObjectId(branchId)) match.branchId = new mongoose.Types.ObjectId(branchId);

  const products = await InvProduct.find(match)
    .select('_id branchId code name nameAr nameFa totalsByUnit')
    .lean();
  if (!products.length) return { branches: [], totalVariants: 0 };

  const productIds = products.map((p) => p._id);
  const variants = await InvVariant.find({
    productId: { $in: productIds },
    deleteDate: null,
    status: 'active',
  }).select('_id productId branchId code spec unit quantity').sort({ code: 1 }).lean();

  const branchIds = [...new Set(products.map((p) => String(p.branchId)))];
  const branches = await Branch.find({ _id: { $in: branchIds }, deleteDate: null })
    .select('name country address phone instagramHandle').lean();
  const branchById = new Map(branches.map((b) => [String(b._id), b]));
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const byBranch = new Map();

  variants.forEach((v) => {
    const bid = String(v.branchId);
    const branch = branchById.get(bid) || {};
    const product = productById.get(String(v.productId)) || {};
    if (!byBranch.has(bid)) {
      byBranch.set(bid, {
        branchId: v.branchId,
        branchName: branch.name || '',
        country: branch.country || null,
        address: branch.address || '',
        phone: branch.phone || '',
        instagramHandle: branch.instagramHandle || '',
        productId: product._id,
        productName: product.name || '',
        totalsByUnit: product.totalsByUnit || {},
        variants: [],
      });
    }
    byBranch.get(bid).variants.push({
      _id: v._id,
      productId: v.productId,
      variantId: v._id,
      code: v.code,
      spec: v.spec || {},
      unit: v.unit,
      quantity: v.quantity || 0,
      inStock: (v.quantity || 0) > 0,
    });
  });

  return { branches: [...byBranch.values()], totalVariants: variants.length };
}

function refIds(refs) {
  return (refs || [])
    .map((ref) => String(ref?._id || ref))
    .filter((id) => mongoose.isValidObjectId(id));
}

async function attachProductTaxonomy(products) {
  const list = Array.isArray(products) ? products : [products];
  const ids = [...new Set(list.flatMap((product) => [
    ...refIds(product.categories),
    ...refIds(product.tags),
  ]))];
  if (!ids.length) return products;

  const taxonomy = await ProductTaxonomy.find({ _id: { $in: ids }, deleteDate: null }).lean();
  const byId = new Map(taxonomy.map((item) => [String(item._id), item]));
  list.forEach((product) => {
    product.categories = refIds(product.categories).map((id) => byId.get(id)).filter(Boolean);
    product.tags = refIds(product.tags).map((id) => byId.get(id)).filter(Boolean);
  });
  return products;
}

function toPublicProductContent(product, { lang, availability, branch, includeContent = false }) {
  const categories = (product.categories || []).map((c) => toPublicTaxonomy(c, lang));
  const tags = (product.tags || []).map((t) => toPublicTaxonomy(t, lang));
  const seo = product.seo || {};
  return {
    _id: product._id,
    code: product.code,
    name: localized(product, 'title', lang),
    title: localized(product, 'title', lang),
    slug: localized(product, 'slug', lang) || product.slug,
    excerpt: localized(product, 'excerpt', lang),
    ...(includeContent ? { body: localized(product, 'body', lang) } : {}),
    categories,
    tags,
    gallery: (product.gallery || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)),
    seo: {
      metaTitle: lang === 'ar' ? (seo.metaTitleAr || seo.metaTitle) : lang === 'fa' ? (seo.metaTitleFa || seo.metaTitle) : seo.metaTitle,
      metaDescription: lang === 'ar' ? (seo.metaDescriptionAr || seo.metaDescription) : lang === 'fa' ? (seo.metaDescriptionFa || seo.metaDescription) : seo.metaDescription,
    },
    branch: branchPayload(branch),
    availability: availability || { branches: [], totalVariants: 0 },
  };
}

// Product content routes are intentionally registered before the legacy
// inventory-website handlers below. Content is global by product code; live
// branch stock is resolved from Inventory for the selected/default branch.
router.get('/products', async (req, res) => {
  try {
    const lang = pickLang(req.query.lang);
    const { search } = req.query;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(150, parseInt(req.query.limit) || 24);
    const skip  = (page - 1) * limit;
    const branch = await resolveWebsiteBranch(req.query.branchId);

    const query = { deleteDate: null, status: 'published' };

    const categoryId = await taxonomyIdFromParam(req.query.category, 'category');
    if (categoryId) query.categories = categoryId;
    const tagId = await taxonomyIdFromParam(req.query.tag, 'tag');
    if (tagId) query.tags = tagId;
    if (search) {
      const re = new RegExp(escapeRegex(search.trim()), 'i');
      const taxonomyIds = await ProductTaxonomy.distinct('_id', {
        deleteDate: null,
        $or: [{ name: re }, { nameAr: re }, { nameFa: re }, { slug: re }, { slugAr: re }, { slugFa: re }],
      });
      query.$or = [
        { code: re }, { title: re }, { titleAr: re }, { titleFa: re }, { excerpt: re },
        { categories: { $in: taxonomyIds } }, { tags: { $in: taxonomyIds } },
      ];
    }

    const [products, total] = await Promise.all([
      ProductContent.find(query).sort({ updateDate: -1 }).skip(skip).limit(limit).lean(),
      ProductContent.countDocuments(query),
    ]);
    await attachProductTaxonomy(products);
    const availabilityPairs = await Promise.all(products.map((p) => resolveAvailability(p.code, branch?._id)));
    const data = products.map((p, index) => toPublicProductContent(p, {
      lang,
      branch,
      availability: availabilityPairs[index],
    }));
    return res.status(200).json({ data, total, page, limit, branch: branchPayload(branch) });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/products/:slug', async (req, res) => {
  try {
    const lang = pickLang(req.query.lang);
    const branch = await resolveWebsiteBranch(req.query.branchId);
    const slug = String(req.params.slug || '').trim();
    const code = normalizeProductCode(slug);
    const product = await ProductContent.findOne({
      deleteDate: null,
      status: 'published',
      $or: [{ slug }, { slugAr: slug }, { slugFa: slug }, { code }],
    }).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });
    await attachProductTaxonomy(product);

    const availability = await resolveAvailability(product.code, branch?._id);
    return res.status(200).json(toPublicProductContent(product, {
      lang,
      branch,
      availability,
      includeContent: true,
    }));
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/categories', async (req, res) => {
  try {
    const lang = pickLang(req.query.lang);
    const cats = await ProductTaxonomy.find({ type: 'category', deleteDate: null }).sort({ name: 1 }).lean();
    return res.status(200).json({ data: cats.map((c) => toPublicTaxonomy(c, lang)) });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/tags', async (req, res) => {
  try {
    const lang = pickLang(req.query.lang);
    const tags = await ProductTaxonomy.find({ type: 'tag', deleteDate: null }).sort({ name: 1 }).lean();
    return res.status(200).json({ data: tags.map((t) => toPublicTaxonomy(t, lang)) });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

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
    const branches = await Branch.find({ deleteDate: null, status: 'active' }).select('name country websiteSlug flagImage address phone instagramHandle').sort({ name: 1 }).lean();
    return res.status(200).json({ data: branches.map((branch) => branchPayload(branch)) });
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

// GET /public/website/preview/:token?branchId=&lang= - the product page as it is
// being edited in Digital Marketing (see models/websiteProductPreviewModel.js).
// Same shape as GET /products/:slug, so the website's own product page renders it
// without knowing the difference; the token is the only key and the record expires
// on its own. Never cached.
router.get('/preview/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{36}$/.test(token)) return res.status(404).json({ message: 'Preview not found' });
    const record = await ProductPreview.findOne({ token, expiresAt: { $gt: new Date() } }).lean();
    if (!record) return res.status(404).json({ message: 'This preview has expired' });

    const lang = pickLang(req.query.lang);
    const branch = await resolveWebsiteBranch(req.query.branchId);
    const product = { ...record.payload, _id: record.contentId || record._id };
    await attachProductTaxonomy(product);
    const availability = await resolveAvailability(product.code, branch && branch._id);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ...toPublicProductContent(product, { lang, branch, availability, includeContent: true }),
      preview: true,
    });
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

// Checkout verification resolves or creates a CRM customer. Request-history
// verification only accepts an existing customer with an existing request.
// Both tokens are limited by explicit request capabilities.
router.post('/otp/verify', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const otp = String(req.body.otp || '');
    const requestsOnly = req.body.purpose === 'requests';
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
    if (requestsOnly) {
      const hasRequests = customer && await PriceRequest.exists({ customerId: customer._id });
      if (!hasRequests) return res.status(404).json({ message: 'No customer requests were found for this email' });
    }

    const selectedBranch = requestsOnly ? null : await resolveWebsiteBranch(req.body.branchId);
    if (!customer) {
      customer = await Customer.create({
        commChannels: ['email'],
        commHandles: { email },
        status: 'new',
        branchId: selectedBranch?._id || null,
        assignedTo: [],
        owner: null,
        createdBy: null,
        insertDate: now,
      });
      await CustomerActivity.create({
        customerId: customer._id, type: 'created', actorId: null,
        actorName: 'Website visitor', body: 'Created via public website email verification', date: now,
      });
    } else if (!requestsOnly && !customer.branchId && selectedBranch?._id) {
      customer.branchId = selectedBranch._id;
      customer.updateDate = now;
      await customer.save();
    }

    // 'offers:accept' lets the signed-in customer take a price offer the branch
    // sent them (POST /me/offers/:id/accept). Tokens issued before it existed
    // simply have to sign in again to accept.
    const capabilities = requestsOnly
      ? ['requests:read', 'offers:accept']
      : ['requests:read', 'requests:create', 'offers:accept'];
    const token = jwt.sign({ customerId: String(customer._id), type: 'websiteVisitor', capabilities }, process.env.TOKEN_SECRET, { expiresIn: VISITOR_TOKEN_EXPIRES });
    return res.status(200).json({ accessToken: token });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Price request — the core write. Requires the website-visitor JWT. ──────
router.post('/price-requests', requireWebsiteVisitor, async (req, res) => {
  try {
    if (!visitorCan(req, 'requests:create')) {
      return res.status(403).json({ message: 'Verify your email at checkout to submit a request' });
    }
    const { items, name, phone, country, city, source, language, branchId, receivingAddress } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'At least one item is required' });
    }
    if (!VALID_LANGS.includes(language)) {
      return res.status(400).json({ message: 'Invalid language' });
    }
    if (!['productPage', 'productTable', 'purchaseList'].includes(source)) {
      return res.status(400).json({ message: 'Invalid source' });
    }
    const visitorCountry = String(country || '').trim();
    const visitorCity = String(city || '').trim();
    if (!visitorCountry || !visitorCity) {
      return res.status(400).json({ message: 'Country and city are required' });
    }
    const delivery = {
      country: visitorCountry,
      city: visitorCity,
      address: String(receivingAddress?.address || '').trim(),
      postalCode: String(receivingAddress?.postalCode || '').trim(),
      mapLink: String(receivingAddress?.mapLink || '').trim(),
    };
    if (!delivery.address) return res.status(400).json({ message: 'Receiving load address is required' });
    if (!mongoose.isValidObjectId(branchId)) return res.status(400).json({ message: 'A valid branch is required' });

    const requestBranch = await Branch.findOne({ _id: branchId, deleteDate: null, status: 'active' })
      .select('name associates priceRequestNotifyUsers').lean();
    if (!requestBranch) return res.status(404).json({ message: 'Branch not found' });
    const associates = [...new Set([
      ...(requestBranch.associates || []),
      ...(requestBranch.priceRequestNotifyUsers || []),
    ].map(String).filter((id) => mongoose.isValidObjectId(id)))];

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

      const variant = await InvVariant.findOne({
        _id: variantId,
        productId,
        branchId: requestBranch._id,
        deleteDate: null,
        status: 'active',
        quantity: { $gt: 0 },
      }).select('code unit branchId quantity').lean();
      const product = variant && await InvProduct.findOne({ _id: productId, deleteDate: null, status: 'active' })
        .select('name code').lean();
      const content = product && await ProductContent.findOne({
        code: product.code,
        status: 'published',
        deleteDate: null,
      }).select('title').lean();
      if (!variant || !product || !content) return res.status(404).json({ message: 'A requested item is no longer available' });
      if (qty > Number(variant.quantity)) {
        return res.status(409).json({ message: `${variant.code} only has ${variant.quantity} ${variant.unit || ''} available` });
      }

      resolvedItems.push({
        productId, variantId, productName: content.title || product.name || product.code, variantCode: variant.code,
        branchId: variant.branchId, quantity: qty, unit: variant.unit,
      });
    }

    const visitorName = String(name || '').trim();
    if (!visitorName) return res.status(400).json({ message: 'Name is required' });

    const visitorPhone = String(phone || '').trim();

    // Backfill the customer's name/phone on first contact only — never
    // overwrite values staff or a later visit already set.
    const custUpdate = {
      updateDate: new Date(),
      branchId: requestBranch._id,
      // Staff may already have assigned this customer to others — the branch's
      // website associates are ADDED to them, never swapped in.
      ...(associates.length
        ? { assignedTo: [...new Set([...(customer.assignedTo || []).map(String), ...associates])] }
        : {}),
    };
    if (!customer.personalInformation?.firstName && !customer.personalInformation?.companyName) {
      custUpdate['personalInformation.firstName'] = visitorName;
    }
    if (visitorPhone && !customer.phoneNumber) {
      custUpdate.phoneNumber = visitorPhone;
    }
    customer.set(custUpdate);

    // Where the load goes is part of the customer's record (and of the price), so
    // every distinct receiving address a request names is kept on the customer.
    const addressKey = (a) => [a.street, a.city, a.country, a.postalCode]
      .map((v) => String(v || '').trim().toLowerCase()).join('|');
    const receiving = {
      country: delivery.country,
      city: delivery.city,
      street: delivery.address,
      postalCode: delivery.postalCode,
      mapLink: delivery.mapLink,
      explanations: 'Receiving load address from a website request',
    };
    if (!(customer.address || []).some((a) => addressKey(a) === addressKey(receiving))) {
      customer.address.push(receiving);
    }

    // What they put on the purchase list becomes their interested products. An
    // entry that is already there (added by staff, or by an earlier request) is
    // updated rather than repeated.
    const askedAt = new Date();
    for (const item of resolvedItems) {
      const known = (customer.interestedProducts || []).find((p) =>
        String(p.productId) === String(item.productId) && String(p.variantId || '') === String(item.variantId));
      if (known) {
        known.addedToWebsitePurchaseList = true;
        known.requestedQuantity = item.quantity;
        known.branchId = item.branchId;
        known.addedAt = askedAt;
      } else {
        customer.interestedProducts.push({
          productId: item.productId, variantId: item.variantId, branchId: item.branchId,
          source: 'website', addedToWebsitePurchaseList: true, requestedQuantity: item.quantity, addedAt: askedAt,
        });
      }
    }
    await customer.save();

    const priceRequest = await PriceRequest.create({
      items: resolvedItems,
      customerId: customer._id,
      branchId: requestBranch._id,
      name: visitorName,
      email: customer.commHandles?.email || '',
      phone: visitorPhone, country: visitorCountry, city: visitorCity,
      receivingAddress: delivery,
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
        await Promise.all(associates.map((uid) => sendNotificationToUser(uid, {
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

// ── Customer's own website requests ─────────────────────────────────────────
router.get('/me/price-requests', requireWebsiteVisitor, async (req, res) => {
  try {
    if (!visitorCan(req, 'requests:read')) {
      return res.status(403).json({ message: 'Sign in to view your requests' });
    }
    const rows = await PriceRequest.find({ customerId: req.visitor.customerId })
      .sort({ insertDate: -1 }).lean();
    const offers = await offersByRequest(rows.map((row) => row._id));
    const now = new Date();
    const data = rows.map((row) => ({
      _id: row._id,
      offer: toPublicOffer(offers.get(String(row._id)), now),
      branchId: row.branchId || null,
      items: (row.items || []).map((item) => ({
        productName: item.productName || '',
        variantCode: item.variantCode || '',
        quantity: item.quantity,
        unit: item.unit || '',
      })),
      country: row.country || '',
      city: row.city || '',
      receivingAddress: {
        country: row.receivingAddress?.country || '',
        city: row.receivingAddress?.city || '',
        address: row.receivingAddress?.address || '',
        postalCode: row.receivingAddress?.postalCode || '',
        mapLink: row.receivingAddress?.mapLink || '',
      },
      status: row.status,
      source: row.source,
      language: row.language,
      insertDate: row.insertDate,
      updateDate: row.updateDate,
      response: row.response?.body ? {
        body: row.response.body,
        respondedByName: row.response.respondedByName || '',
        respondedAt: row.response.respondedAt || null,
      } : null,
    }));
    return res.status(200).json({ data, serverNow: now });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Price offers ────────────────────────────────────────────────────────────
// A branch answers a request with prices (utils/websiteOffers.js). The e-mail it
// sends carries the numbers only; the document itself - the quotation, and the
// invoice once it is accepted - is served here, to the signed-in customer it
// belongs to and nobody else.

// GET /public/website/me/offers/:id/html?lang= - the quotation / invoice as the
// branch prints it. A document that is not this customer's, or did not come from
// a website request, is a plain 404.
router.get('/me/offers/:id/html', requireWebsiteVisitor, async (req, res) => {
  try {
    if (!visitorCan(req, 'requests:read')) {
      return res.status(403).json({ message: 'Sign in to view your documents' });
    }
    const html = await renderCustomerDocument({
      docId: req.params.id, customerId: req.visitor.customerId, lang: pickLang(req.query.lang),
    });
    if (!html) return res.status(404).json({ message: 'Document not found' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The document is static HTML + CSS + an inline logo - nothing else may load or run.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:");
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /public/website/me/offers/:id/accept - the customer takes an open offer:
// its quantities come out of stock and it becomes an invoice.
router.post('/me/offers/:id/accept', requireWebsiteVisitor, async (req, res) => {
  try {
    if (!visitorCan(req, 'offers:accept')) {
      return res.status(403).json({ message: 'Please sign in again to accept this offer', code: 'REAUTH' });
    }
    const { offer, invoice, alreadyAccepted } = await acceptOffer({
      offerId: req.params.id, customerId: req.visitor.customerId,
    });
    return res.status(200).json({
      data: toPublicOffer({ offer, invoice }, new Date()),
      alreadyAccepted: Boolean(alreadyAccepted),
    });
  } catch (err) {
    if (err instanceof OfferError) {
      return res.status(err.status).json({ message: err.message, ...(err.extra && err.extra.code ? { code: err.extra.code } : {}) });
    }
    console.error('POST /public/website/me/offers/:id/accept failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /public/website/analytics — what the site's own visitors did.
//
// Unauthenticated by necessity (most visitors never sign in) and therefore treated as
// hostile input: utils/websiteAnalytics.js clamps every field and drops anything it does
// not recognise, so the worst a forged call can do is add rows that look like traffic.
// It answers 204 whatever happens — a browser must never retry or surface an error for a
// measurement call, and an attacker learns nothing from the reply. If the visitor happens
// to be signed in, their token ties the events to the CRM customer; otherwise they stay
// pseudonymous.
router.post('/analytics', async (req, res) => {
  try {
    let customerId = null;
    const header = req.headers.authorization;
    if (header) {
      try {
        const verified = jwt.verify(header.split(' ')[1], process.env.TOKEN_SECRET);
        if (verified.type === 'websiteVisitor' && verified.customerId) customerId = verified.customerId;
      } catch (_) { /* an expired or bogus token simply means "not signed in" here */ }
    }
    const events = sanitizeBatch(req.body, { customerId, selfHost: hostOf(`https://${req.headers.host || ''}`) });
    if (events.length) await AnalyticsEvent.insertMany(events, { ordered: false });
    return res.status(204).end();
  } catch (err) {
    console.error('POST /public/website/analytics failed:', err.message);
    return res.status(204).end();
  }
});

module.exports = router;
