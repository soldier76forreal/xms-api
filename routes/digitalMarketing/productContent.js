const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');

const dbConnection = require('../../connections/xmsPr');
const productContentSchema = require('../../models/websiteProductContentModel');
const productPreviewSchema = require('../../models/websiteProductPreviewModel');
const fileSchema = require('../../models/fileModel');
const productTaxonomySchema = require('../../models/websiteProductTaxonomyModel');
const inventoryProductSchema = require('../../models/inventoryProductModel');
const inventoryVariantSchema = require('../../models/inventoryVariantModel');
const branchSchema = require('../../models/branchModel');
const userSchema = require('../../models/userModel');
const verify = require('../users/verifyToken');
const { requirePermission, getEffectivePermissions, isSuperAdmin, getUserBranches } = require('../../utils/rbac');
const { sanitizeHtml } = require('../../utils/sanitizeHtml');
const { imagesOnly, imageUploadLimits } = require('../../utils/uploadGuards');
const { isHeic, convertHeicIfNeeded } = require('../../utils/mediaConvert');

const ProductContent = dbConnection.models.websiteProductContent
  || dbConnection.model('websiteProductContent', productContentSchema);
const ProductTaxonomy = dbConnection.models.websiteProductTaxonomy
  || dbConnection.model('websiteProductTaxonomy', productTaxonomySchema);
const InvProduct = dbConnection.models.inventoryProduct
  || dbConnection.model('inventoryProduct', inventoryProductSchema);
const InvVariant = dbConnection.models.inventoryVariant
  || dbConnection.model('inventoryVariant', inventoryVariantSchema);
const Branch = dbConnection.models.branch || dbConnection.model('branch', branchSchema);
const User = dbConnection.models.user || dbConnection.model('user', userSchema);
const ProductPreview = dbConnection.models.websiteProductPreview
  || dbConnection.model('websiteProductPreview', productPreviewSchema);
const File = dbConnection.models.file || dbConnection.model('file', fileSchema);

const router = express.Router();
const LANGS = ['en', 'ar', 'fa'];

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeProductCode(input) {
  const raw = String(input || '').trim().toUpperCase();
  const match = raw.match(/[A-Z]{2}\d{2}/);
  return match ? match[0] : raw;
}

async function getActorName(userId) {
  const actor = await User.findById(userId).select('firstName lastName').lean();
  return actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '';
}

function taxonomySelect(type) {
  return { type, deleteDate: null };
}

function buildTaxonomyFields(body, type) {
  const name = String(body.name || '').trim();
  const fields = { type };
  if (name) fields.name = name;
  ['nameAr', 'nameFa', 'description', 'descriptionAr', 'descriptionFa'].forEach((k) => {
    if (body[k] !== undefined) fields[k] = String(body[k] || '').trim();
  });
  ['slug', 'slugAr', 'slugFa'].forEach((k) => {
    if (body[k] !== undefined) fields[k] = slugify(body[k]);
  });
  if (!fields.slug && name) fields.slug = slugify(name);
  return fields;
}

function parseIdList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id) => mongoose.isValidObjectId(id));
}

function buildContentFields(body) {
  const fields = {};
  const code = normalizeProductCode(body.code);
  if (code) fields.code = code;

  ['title', 'titleAr', 'titleFa', 'excerpt', 'excerptAr', 'excerptFa', 'slug', 'slugAr', 'slugFa']
    .forEach((k) => {
      if (body[k] === undefined) return;
      if (['slug', 'slugAr', 'slugFa'].includes(k)) fields[k] = slugify(body[k]);
      // the website puts the excerpt on the page as HTML, so it is cleaned like the body
      else if (['excerpt', 'excerptAr', 'excerptFa'].includes(k)) fields[k] = sanitizeHtml(String(body[k] || '').trim());
      else fields[k] = String(body[k] || '').trim();
    });

  ['body', 'bodyAr', 'bodyFa'].forEach((k) => {
    if (body[k] !== undefined) fields[k] = sanitizeHtml(String(body[k] || ''));
  });

  if (body.status && ['draft', 'published'].includes(body.status)) fields.status = body.status;
  if (Array.isArray(body.categories)) fields.categories = parseIdList(body.categories);
  if (Array.isArray(body.tags)) fields.tags = parseIdList(body.tags);
  if (Array.isArray(body.gallery)) {
    fields.gallery = body.gallery.map((g, i) => ({
      url: String(g.url || '').trim(),
      attachmentId: Number.isFinite(Number(g.attachmentId)) ? Number(g.attachmentId) : null,
      alt: String(g.alt || '').trim(),
      order: Number.isFinite(Number(g.order)) ? Number(g.order) : i,
    })).filter((g) => g.url);
  }
  if (body.seo && typeof body.seo === 'object') {
    fields.seo = {};
    ['metaTitle', 'metaDescription', 'metaTitleAr', 'metaDescriptionAr', 'metaTitleFa', 'metaDescriptionFa']
      .forEach((k) => { fields.seo[k] = String(body.seo[k] || '').trim(); });
  }
  return fields;
}

async function resolveAvailability(code, branchId) {
  const match = { code: normalizeProductCode(code), deleteDate: null, status: 'active' };
  if (branchId && mongoose.isValidObjectId(branchId)) match.branchId = new mongoose.Types.ObjectId(branchId);

  const products = await InvProduct.find(match)
    .select('_id branchId code name nameAr nameFa stoneTypeName quarryName totalsByUnit')
    .lean();
  if (!products.length) return { branches: [], totalVariants: 0 };

  const productIds = products.map((p) => p._id);
  const variants = await InvVariant.find({ productId: { $in: productIds }, deleteDate: null, status: 'active' })
    .select('_id productId branchId code spec unit quantity supply')
    .sort({ code: 1 })
    .lean();
  const branchIds = [...new Set(products.map((p) => String(p.branchId)))];
  const branches = await Branch.find({ _id: { $in: branchIds }, deleteDate: null })
    .select('name country address phone instagramHandle')
    .lean();
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
      code: v.code,
      spec: v.spec || {},
      unit: v.unit,
      quantity: v.quantity || 0,
      inStock: (v.quantity || 0) > 0,
    });
  });

  return { branches: [...byBranch.values()], totalVariants: variants.length };
}

function listItem(doc) {
  const cover = (doc.gallery || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0))[0];
  return {
    cover: cover ? cover.url : '',
    _id: doc._id,
    code: doc.code,
    title: doc.title,
    titleAr: doc.titleAr,
    titleFa: doc.titleFa,
    slug: doc.slug,
    status: doc.status,
    categories: doc.categories || [],
    tags: doc.tags || [],
    updateDate: doc.updateDate,
    source: doc.source,
  };
}

// Taxonomy management
router.get('/taxonomy', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const type = req.query.type === 'tag' ? 'tag' : req.query.type === 'category' ? 'category' : null;
    const query = { deleteDate: null };
    if (type) query.type = type;
    const data = await ProductTaxonomy.find(query).sort({ type: 1, name: 1 }).lean();
    return res.status(200).json({ data });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/taxonomy', verify, requirePermission('digitalMarketing:productContent:taxonomy'), async (req, res) => {
  try {
    const type = req.body.type === 'tag' ? 'tag' : 'category';
    const fields = buildTaxonomyFields(req.body, type);
    if (!fields.name) return res.status(400).json({ message: 'Name is required' });
    if (!fields.slug) fields.slug = slugify(fields.name);
    const clash = await ProductTaxonomy.findOne({ ...taxonomySelect(type), slug: fields.slug }).select('_id').lean();
    if (clash) return res.status(409).json({ message: 'This slug already exists' });
    const doc = await ProductTaxonomy.create({ ...fields, insertDate: new Date(), updateDate: new Date() });
    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/taxonomy/:id', verify, requirePermission('digitalMarketing:productContent:taxonomy'), async (req, res) => {
  try {
    const doc = await ProductTaxonomy.findOne({ _id: req.params.id, deleteDate: null });
    if (!doc) return res.status(404).json({ message: 'Taxonomy item not found' });
    const fields = buildTaxonomyFields(req.body, doc.type);
    if (fields.slug) {
      const clash = await ProductTaxonomy.findOne({
        _id: { $ne: doc._id }, ...taxonomySelect(doc.type), slug: fields.slug,
      }).select('_id').lean();
      if (clash) return res.status(409).json({ message: 'This slug already exists' });
    }
    fields.updateDate = new Date();
    const updated = await ProductTaxonomy.findByIdAndUpdate(doc._id, { $set: fields }, { new: true });
    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/taxonomy/:id', verify, requirePermission('digitalMarketing:productContent:taxonomy'), async (req, res) => {
  try {
    const doc = await ProductTaxonomy.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: { deleteDate: new Date(), updateDate: new Date() } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: 'Taxonomy item not found' });
    return res.status(200).json({ message: 'Deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/availability', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const code = normalizeProductCode(req.query.code);
    if (!code) return res.status(400).json({ message: 'Code is required' });
    return res.status(200).json(await resolveAvailability(code, req.query.branchId));
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Editor helpers ──────────────────────────────────────────────────────────
// Everything below sits BEFORE the CRUD routes on purpose: GET /:id would
// otherwise answer /code-lookup and /check-slug itself.

const WRITE_KEYS = ['digitalMarketing:productContent:create', 'digitalMarketing:productContent:edit'];
async function requireContentWriter(req, res, next) {
  try {
    const perms = await getEffectivePermissions(req.user.id);
    if (WRITE_KEYS.some((key) => perms.has(key))) return next();
    return res.status(403).json({ message: 'Access denied', requiredPermission: WRITE_KEYS.join(' | ') });
  } catch (err) {
    return next(err);
  }
}

// GET /code-lookup?search= - the inventory product codes website content can be
// attached to (one row per code, however many branches stock it), with what is
// already known: names, how many varieties, whether it has content yet. Limited
// to the branches the caller holds, like the other Digital Marketing pickers.
router.get('/code-lookup', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 60);
    const match = { deleteDate: null, status: 'active' };
    if (!(await isSuperAdmin(req.user.id))) {
      match.branchId = { $in: (await getUserBranches(req.user.id)).filter((id) => mongoose.isValidObjectId(id)) };
    }
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      match.$or = [{ code: re }, { name: re }, { nameAr: re }, { nameFa: re }, { stoneTypeName: re }, { quarryName: re }];
    }
    const products = await InvProduct.find(match)
      .select('code name nameAr nameFa stoneTypeName quarryName branchId variantCount totalsByUnit')
      .sort({ code: 1 }).limit(200).lean();

    const byCode = new Map();
    for (const p of products) {
      const key = normalizeProductCode(p.code);
      if (!key) continue;
      if (!byCode.has(key)) {
        byCode.set(key, {
          code: key, name: p.name || '', nameAr: p.nameAr || '', nameFa: p.nameFa || '',
          stoneTypeName: p.stoneTypeName || '', quarryName: p.quarryName || '',
          branches: 0, variants: 0, totalsByUnit: {},
        });
      }
      const row = byCode.get(key);
      row.name = row.name || p.name || '';
      row.nameAr = row.nameAr || p.nameAr || '';
      row.nameFa = row.nameFa || p.nameFa || '';
      row.branches += 1;
      row.variants += p.variantCount || 0;
      Object.entries(p.totalsByUnit || {}).forEach(([unit, qty]) => {
        row.totalsByUnit[unit] = Math.round(((row.totalsByUnit[unit] || 0) + (Number(qty) || 0)) * 100) / 100;
      });
    }

    const rows = [...byCode.values()].slice(0, 60);
    const existing = await ProductContent.find({ code: { $in: rows.map((r) => r.code) }, deleteDate: null })
      .select('code title status').lean();
    const contentByCode = new Map(existing.map((c) => [c.code, c]));
    return res.status(200).json({
      data: rows.map((r) => ({
        ...r,
        content: contentByCode.has(r.code)
          ? { _id: contentByCode.get(r.code)._id, title: contentByCode.get(r.code).title, status: contentByCode.get(r.code).status }
          : null,
      })),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /check-slug?slug=&excludeId= - is this page address free?
router.get('/check-slug', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const slug = slugify(req.query.slug);
    if (!slug) return res.status(400).json({ message: 'Slug is required' });
    const query = { slug, deleteDate: null };
    if (mongoose.isValidObjectId(req.query.excludeId)) query._id = { $ne: req.query.excludeId };
    const clash = await ProductContent.findOne(query).select('code title').lean();
    return res.status(200).json({ slug, available: !clash, takenBy: clash ? { code: clash.code, title: clash.title } : null });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /preview - store the product page as it is in the editor right now (saved
// or not) and hand back a token; the website's own product page opened with
// ?xms-preview=<token> shows it exactly as a visitor would see it. Send the
// same token again to update that preview in place. Body: the record's fields,
// plus `id` of the saved record being edited (its fields fill what the body
// leaves out) and an optional `token`.
const PREVIEW_HOURS = 2;
const PREVIEW_FIELDS = ['code', 'title', 'titleAr', 'titleFa', 'excerpt', 'excerptAr', 'excerptFa',
  'body', 'bodyAr', 'bodyFa', 'slug', 'slugAr', 'slugFa', 'categories', 'tags', 'gallery', 'seo'];
router.post('/preview', verify, requireContentWriter, async (req, res) => {
  try {
    const body = req.body || {};
    let saved = null;
    if (mongoose.isValidObjectId(body.id)) {
      saved = await ProductContent.findOne({ _id: body.id, deleteDate: null }).lean();
      if (!saved) return res.status(404).json({ message: 'Product content not found' });
    }
    const fields = buildContentFields(body);
    const payload = {};
    PREVIEW_FIELDS.forEach((k) => {
      if (fields[k] !== undefined) payload[k] = fields[k];
      else if (saved && saved[k] !== undefined) payload[k] = saved[k];
    });
    payload.code = payload.code || 'PREVIEW';
    payload.title = payload.title || payload.code;
    payload.slug = payload.slug || slugify(payload.title) || 'preview';
    payload.categories = (payload.categories || []).map(String);
    payload.tags = (payload.tags || []).map(String);
    payload.gallery = payload.gallery || [];

    const now = new Date();
    const expiresAt = new Date(now.getTime() + PREVIEW_HOURS * 3600 * 1000);
    let record = null;
    if (/^[a-f0-9]{36}$/.test(String(body.token || ''))) {
      record = await ProductPreview.findOneAndUpdate(
        { token: body.token, createdBy: req.user.id },
        { $set: { payload, contentId: saved ? saved._id : null, updateDate: now, expiresAt } },
        { new: true }
      );
    }
    if (!record) {
      record = await ProductPreview.create({
        token: crypto.randomBytes(18).toString('hex'), payload, contentId: saved ? saved._id : null,
        createdBy: req.user.id, insertDate: now, updateDate: now, expiresAt,
      });
    }
    return res.status(200).json({ token: record.token, expiresAt: record.expiresAt, slug: payload.slug });
  } catch (err) {
    console.error('POST /digitalMarketing/product-content/preview failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /gallery/upload - product page images (multipart `images`, up to 12 at a
// time). Each one is made web-ready: HEIC from a phone becomes JPEG, anything over
// 2600 px on its long edge is shrunk (the page never shows more), and a 480 px
// thumbnail is written next to it for the editor. The response says what each file
// became so the editor can warn about small or heavy images.
const galleryUpload = multer({
  limits: imageUploadLimits, fileFilter: imagesOnly,
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads'),
    filename: (req, file, cb) => {
      const ext = (String(file.originalname).match(/\.[A-Za-z0-9]{1,6}$/) || [''])[0].toLowerCase();
      cb(null, `pc-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
});
const UPLOADS = 'public/uploads';
const MAX_EDGE = 2600;

async function prepareGalleryImage(file, userId) {
  let served = file.filename;
  const superseded = [];       // intermediate copies nothing will point at
  if (isHeic(file)) {
    const converted = await convertHeicIfNeeded(file);
    if (!converted) throw new Error('This HEIC image could not be converted');
    superseded.push(served);
    served = converted;
  }
  let meta = await sharp(path.join(UPLOADS, served)).metadata();
  if (meta.format !== 'gif' && Math.max(meta.width || 0, meta.height || 0) > MAX_EDGE) {
    const resized = served.replace(/(\.[^.]+)?$/, '-web$1');
    await sharp(path.join(UPLOADS, served)).rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .toFile(path.join(UPLOADS, resized));
    superseded.push(served);
    served = resized;
    meta = await sharp(path.join(UPLOADS, served)).metadata();
  }
  const thumb = `thumb-${served.replace(/\.[^.]+$/, '')}.jpg`;
  await sharp(path.join(UPLOADS, served)).rotate().resize(480).jpeg({ quality: 80 }).toFile(path.join(UPLOADS, thumb));

  const fileDoc = await File.create({
    name: String(file.originalname).replace(/\.[^.]+$/, ''),
    supFolder: null,
    metaData: file,
    format: String(file.originalname).slice(String(file.originalname).lastIndexOf('.') + 1),
    generatedBy: userId,
    thumbnail: thumb,
    scope: 'digitalMarketing',
    attachedTo: { type: 'websiteProduct', id: null },
  });
  // the page uses the web-ready copy only; keeping a 20 MB original next to it is dead weight
  superseded.forEach((name) => { try { fs.unlinkSync(path.join(UPLOADS, name)); } catch (_) { /* in use or gone - harmless */ } });
  return {
    url: `/uploads/${served}`, thumb: `/uploads/${thumb}`,
    width: meta.width || 0, height: meta.height || 0,
    bytes: fs.statSync(path.join(UPLOADS, served)).size,
    name: file.originalname, fileId: fileDoc._id,
  };
}

router.post('/gallery/upload', verify, requireContentWriter, galleryUpload.array('images', 12), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: 'No images provided' });
    const data = [];
    const failed = [];
    for (const file of files) {
      try {
        data.push(await prepareGalleryImage(file, req.user.id));
      } catch (err) {
        // not an image after all (or unreadable): don't keep what was written for it
        try { fs.unlinkSync(file.path); } catch (_) { /* already gone */ }
        failed.push({ name: file.originalname, message: err.message || 'Could not process this image' });
      }
    }
    return res.status(data.length ? 201 : 400).json({ data, failed });
  } catch (err) {
    console.error('POST /digitalMarketing/product-content/gallery/upload failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Product content CRUD
router.get('/', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const { status, category, tag, search } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
    const skip = (page - 1) * limit;
    const query = { deleteDate: null };
    if (status && ['draft', 'published'].includes(status)) query.status = status;
    if (mongoose.isValidObjectId(category)) query.categories = category;
    if (mongoose.isValidObjectId(tag)) query.tags = tag;
    if (search) {
      const re = new RegExp(escapeRegex(search.trim()), 'i');
      query.$or = [{ code: re }, { title: re }, { titleAr: re }, { titleFa: re }, { slug: re }];
    }

    const [rows, total] = await Promise.all([
      ProductContent.find(query).sort({ updateDate: -1 }).skip(skip).limit(limit).lean(),
      ProductContent.countDocuments(query),
    ]);
    return res.status(200).json({ data: rows.map(listItem), total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const doc = await ProductContent.findOne({ _id: req.params.id, deleteDate: null }).lean();
    if (!doc) return res.status(404).json({ message: 'Product content not found' });
    const availability = await resolveAvailability(doc.code, req.query.branchId);
    return res.status(200).json({ ...doc, availability });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', verify, requirePermission('digitalMarketing:productContent:create'), async (req, res) => {
  try {
    const fields = buildContentFields(req.body);
    if (!fields.code) return res.status(400).json({ message: 'Product code is required' });
    if (!fields.title) return res.status(400).json({ message: 'English title is required' });
    if (fields.status === 'published' && /^UNMAPPED-WP-/i.test(fields.code)) {
      return res.status(400).json({ message: 'Assign an inventory product code before publishing' });
    }
    if (!fields.slug) fields.slug = slugify(fields.title || fields.code);
    const clash = await ProductContent.findOne({ code: fields.code, deleteDate: null }).select('_id').lean();
    if (clash) return res.status(409).json({ message: 'This product code already has content' });
    const slugClash = await ProductContent.findOne({ slug: fields.slug, deleteDate: null }).select('_id').lean();
    if (slugClash) return res.status(409).json({ message: 'This slug already exists' });
    const actorName = await getActorName(req.user.id);
    const now = new Date();
    fields.publishedAt = fields.status === 'published' ? now : null;
    const doc = await ProductContent.create({
      ...fields, createdBy: req.user.id, updatedBy: req.user.id, createdByName: actorName,
      insertDate: now, updateDate: now,
    });
    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', verify, requirePermission('digitalMarketing:productContent:edit'), async (req, res) => {
  try {
    const doc = await ProductContent.findOne({ _id: req.params.id, deleteDate: null });
    if (!doc) return res.status(404).json({ message: 'Product content not found' });
    const fields = buildContentFields(req.body);
    const nextCode = fields.code || doc.code;
    if (fields.status === 'published' && /^UNMAPPED-WP-/i.test(nextCode)) {
      return res.status(400).json({ message: 'Assign an inventory product code before publishing' });
    }
    if (fields.code && fields.code !== doc.code) {
      const clash = await ProductContent.findOne({ code: fields.code, _id: { $ne: doc._id }, deleteDate: null }).select('_id').lean();
      if (clash) return res.status(409).json({ message: 'This product code already has content' });
    }
    if (fields.slug && fields.slug !== doc.slug) {
      const clash = await ProductContent.findOne({ slug: fields.slug, _id: { $ne: doc._id }, deleteDate: null }).select('_id').lean();
      if (clash) return res.status(409).json({ message: 'This slug already exists' });
    }
    if (fields.status === 'published' && doc.status !== 'published') fields.publishedAt = new Date();
    if (fields.status === 'draft') fields.publishedAt = null;
    if (fields.code && !/^UNMAPPED-WP-/i.test(fields.code)) fields['source.needsCodeMapping'] = false;
    fields.updatedBy = req.user.id;
    fields.updateDate = new Date();
    const updated = await ProductContent.findByIdAndUpdate(doc._id, { $set: fields }, { new: true });
    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', verify, requirePermission('digitalMarketing:productContent:delete'), async (req, res) => {
  try {
    const doc = await ProductContent.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: { deleteDate: new Date(), updateDate: new Date(), status: 'draft' }, $unset: { slug: '' } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: 'Product content not found' });
    return res.status(200).json({ message: 'Deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
