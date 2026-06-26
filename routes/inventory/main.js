const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const jwt_decode = require('jwt-decode');
const dbConnection = require('../../connections/xmsPr');
const inventoryProductSchema   = require('../../models/inventoryProductModel');
const inventoryVariantSchema   = require('../../models/inventoryVariantModel');
const inventoryChangeLogSchema = require('../../models/inventoryChangeLogModel');
const fileSchema = require('../../models/fileModel');
const verify = require('../users/verifyToken');
const { parseStoneCode } = require('../../utils/stoneCodeParser');
const { stoneTypes, grades, units, quarries } = require('./lookups');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename:    (req, file, cb) => {
    const ext = file.originalname.match(/\..*$/)?.[0] || '';
    cb(null, `inv-${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

const InvProduct   = dbConnection.model('inventoryProduct',   inventoryProductSchema);
const InvVariant   = dbConnection.model('inventoryVariant',   inventoryVariantSchema);
const InvChangeLog = dbConnection.model('inventoryChangeLog', inventoryChangeLogSchema);
const File         = dbConnection.model('file',               fileSchema);

const router = express.Router();

// ─── helpers ──────────────────────────────────────────────────────────────────

async function recomputeRollup(productId) {
  const variants = await InvVariant.find({
    productId,
    deleteDate: null,
    status: 'active',
  });

  const totalsByUnit = {};
  let minPrice = null;
  let maxPrice = null;

  for (const v of variants) {
    totalsByUnit[v.unit] = parseFloat(
      ((totalsByUnit[v.unit] || 0) + (v.quantity || 0)).toFixed(4)
    );
    if (v.price != null) {
      if (minPrice === null || v.price < minPrice) minPrice = v.price;
      if (maxPrice === null || v.price > maxPrice) maxPrice = v.price;
    }
  }

  await InvProduct.findByIdAndUpdate(productId, {
    totalsByUnit,
    variantCount: variants.length,
    priceRange: { min: minPrice, max: maxPrice, currency: 'AED' },
    updateDate: new Date(),
  });
}

// ─── lookups ──────────────────────────────────────────────────────────────────

router.get('/lookups', verify, async (req, res) => {
  const categorySchema = require('../../models/categoryModel');
  const Category = dbConnection.model('inventoryCategory', categorySchema);
  const categories = await Category.find({ deleteDate: null }).sort({ name: 1 }).lean();
  res.json({ stoneTypes, grades, units, quarries, categories });
});

// ─── weekly/overall stats ─────────────────────────────────────────────────────
router.get('/stats', verify, async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [productCount, variantCount, variants, weekLogs] = await Promise.all([
    InvProduct.countDocuments({ deleteDate: null, status: 'active' }),
    InvVariant.countDocuments({ deleteDate: null, status: 'active' }),
    InvVariant.find({ deleteDate: null, status: 'active' }, 'unit quantity').lean(),
    InvChangeLog.find({ changeType: 'quantity', date: { $gte: weekAgo } }, 'delta').lean(),
  ]);

  const totalByUnit = {};
  for (const v of variants) {
    totalByUnit[v.unit] = parseFloat(((totalByUnit[v.unit] || 0) + (v.quantity || 0)).toFixed(4));
  }

  let addedThisWeek = 0;
  let soldThisWeek  = 0;
  for (const log of weekLogs) {
    const d = Number(log.delta);
    if (d > 0) addedThisWeek += d;
    else soldThisWeek += Math.abs(d);
  }

  res.json({
    productCount,
    variantCount,
    totalByUnit,
    addedThisWeek: parseFloat(addedThisWeek.toFixed(2)),
    soldThisWeek:  parseFloat(soldThisWeek.toFixed(2)),
  });
});

// ─── parse-code ───────────────────────────────────────────────────────────────

router.post('/parse-code', verify, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: 'code is required' });

  const parsed = parseStoneCode(code);
  res.json({ parsed });
});

// ─── products list ────────────────────────────────────────────────────────────

router.get('/products', verify, async (req, res) => {
  const {
    stoneType, quarryCode, status = 'active',
    search, sort = 'insertDate', order = 'desc',
    limit = 50, skip = 0,
  } = req.query;

  const filter = { deleteDate: null };

  if (status) filter.status = status;
  if (stoneType) filter.stoneType = stoneType.toUpperCase();
  if (quarryCode) filter.quarryCode = quarryCode;
  if (search) {
    const re = new RegExp(search, 'i');
    filter.$or = [{ code: re }, { name: re }, { nameAr: re }];
  }

  const sortDir = order === 'asc' ? 1 : -1;

  const [products, total] = await Promise.all([
    InvProduct.find(filter)
      .sort({ [sort]: sortDir })
      .skip(Number(skip))
      .limit(Number(limit))
      .lean(),
    InvProduct.countDocuments(filter),
  ]);

  res.json({ data: products, total });
});

// ─── product detail ───────────────────────────────────────────────────────────

router.get('/products/:id', verify, async (req, res) => {
  const product = await InvProduct.findOne({
    _id: req.params.id,
    deleteDate: null,
  }).lean();

  if (!product) return res.status(404).json({ message: 'Product not found' });

  const variants = await InvVariant.find({
    productId: product._id,
    deleteDate: null,
  })
    .sort({ 'spec.gradeRank': 1, 'spec.lengthCm': -1 })
    .lean();

  res.json({ data: { ...product, variants } });
});

// ─── create product (variety) ─────────────────────────────────────────────────

router.post('/products', verify, async (req, res) => {
  const {
    stoneType, quarryCode, quarryName,
    name, nameAr, description, category, defaultUnit,
  } = req.body;

  if (!stoneType || !quarryCode) {
    return res.status(400).json({ message: 'stoneType and quarryCode are required' });
  }

  const code = `${stoneType.toUpperCase()}${quarryCode}`;

  const existing = await InvProduct.findOne({ code, deleteDate: null });
  if (existing) {
    return res.status(409).json({ message: `Product code ${code} already exists` });
  }

  const { STONE_TYPES } = require('../../utils/stoneCodeParser');
  const stoneTypeName = STONE_TYPES[stoneType.toUpperCase()] || stoneType;

  const product = await InvProduct.create({
    code,
    stoneType: stoneType.toUpperCase(),
    stoneTypeName,
    quarryCode,
    quarryName: quarryName || '',
    name:        name        || '',
    nameAr:      nameAr      || '',
    description: description || '',
    category:    category    || '',
    defaultUnit: defaultUnit || 'M2',
    createdBy: req.user?._id,
  });

  res.status(201).json({ data: product });
});

// ─── update product ───────────────────────────────────────────────────────────

router.put('/products/:id', verify, async (req, res) => {
  const allowed = ['quarryName', 'name', 'nameAr', 'description', 'category', 'defaultUnit', 'status', 'coverMediaId'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // When setting coverMediaId explicitly, also denormalize the thumbnail filename
  if (req.body.coverMediaId) {
    const coverFile = await File.findById(req.body.coverMediaId).lean();
    if (coverFile?.thumbnail) updates.coverThumbnail = coverFile.thumbnail;
  } else if (req.body.coverMediaId === null) {
    updates.coverThumbnail = null;
  }

  updates.updateDate = new Date();
  updates.updatedBy  = req.user?._id;

  const product = await InvProduct.findOneAndUpdate(
    { _id: req.params.id, deleteDate: null },
    { $set: updates },
    { new: true }
  );

  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json({ data: product });
});

// ─── soft-delete product ──────────────────────────────────────────────────────

router.delete('/products/:id', verify, async (req, res) => {
  const product = await InvProduct.findOneAndUpdate(
    { _id: req.params.id, deleteDate: null },
    { $set: { deleteDate: new Date(), status: 'archived', updatedBy: req.user?._id } },
    { new: true }
  );

  if (!product) return res.status(404).json({ message: 'Product not found' });

  await InvVariant.updateMany(
    { productId: product._id, deleteDate: null },
    { $set: { deleteDate: new Date(), status: 'archived' } }
  );

  res.json({ message: 'Product archived' });
});

// ─── variants list for a product ─────────────────────────────────────────────

router.get('/products/:id/variants', verify, async (req, res) => {
  const product = await InvProduct.findOne({ _id: req.params.id, deleteDate: null }).lean();
  if (!product) return res.status(404).json({ message: 'Product not found' });

  const variants = await InvVariant.find({
    productId: req.params.id,
    deleteDate: null,
  })
    .sort({ 'spec.gradeRank': 1, 'spec.lengthCm': -1 })
    .lean();

  res.json({ data: variants });
});

// ─── create variant ───────────────────────────────────────────────────────────

router.post('/variants', verify, async (req, res) => {
  const { code, productId, unit, quantity = 0, price = null, currency = 'AED' } = req.body;

  if (!code)      return res.status(400).json({ message: 'code is required' });
  if (!productId) return res.status(400).json({ message: 'productId is required' });

  const product = await InvProduct.findOne({ _id: productId, deleteDate: null });
  if (!product) return res.status(404).json({ message: 'Product not found' });

  const parsed = parseStoneCode(code);

  if (!parsed.valid) {
    return res.status(400).json({
      message: 'Could not parse stone code',
      warnings: parsed.parseWarnings,
    });
  }

  // Warn if the code's productCode doesn't match the product
  const codeProductCode = parsed.productCode;
  if (codeProductCode !== product.code) {
    return res.status(400).json({
      message: `Code prefix "${codeProductCode}" does not match product "${product.code}"`,
    });
  }

  const normalizedCode = parsed.raw.trim().toUpperCase();

  const existing = await InvVariant.findOne({ code: normalizedCode, deleteDate: null });
  if (existing) {
    return res.status(409).json({ message: `Variant code ${normalizedCode} already exists` });
  }

  const variant = await InvVariant.create({
    productId: product._id,
    code: normalizedCode,
    spec: {
      stoneType:     parsed.stoneType,
      stoneTypeName: parsed.stoneTypeName,
      quarryCode:    parsed.quarryCode,
      grade:         parsed.grade,
      gradeName:     parsed.gradeName,
      gradeRank:     parsed.gradeRank,
      lengthCm:      parsed.lengthCm,
      widthCm:       parsed.widthCm,
      thicknessMm:   parsed.thicknessMm,
      unsized:       parsed.unsized,
      cut:           parsed.cut,
      cutName:       parsed.cutName,
      fill:          parsed.fill,
      fillName:      parsed.fillName,
      finish:        parsed.finish,
      finishName:    parsed.finishName,
      raw:           parsed.raw,
      parseWarnings: parsed.parseWarnings,
    },
    unit:     unit     || product.defaultUnit,
    quantity: Number(quantity),
    price:    price != null ? Number(price) : null,
    currency,
    createdBy: req.user?._id,
  });

  // Write "created" change log
  await InvChangeLog.create({
    subjectType:   'variant',
    subjectId:     variant._id,
    productId:     product._id,
    changeType:    'created',
    newValue:      { code: variant.code, unit: variant.unit, quantity: variant.quantity, price: variant.price },
    source:        'manual',
    changedBy:     req.user?._id,
    changedByName: req.user?.firstName ? `${req.user.firstName} ${req.user.lastName}` : undefined,
  });

  // Recompute product rollup
  await recomputeRollup(product._id);

  res.status(201).json({
    data: variant,
    parseWarnings: parsed.parseWarnings,
  });
});

// ─── change log for a product ─────────────────────────────────────────────────

router.get('/products/:id/logs', verify, async (req, res) => {
  const { changeType, limit = 50, skip = 0 } = req.query;

  const filter = { productId: req.params.id };
  if (changeType) filter.changeType = changeType;

  const [logs, total] = await Promise.all([
    InvChangeLog.find(filter)
      .sort({ date: -1 })
      .skip(Number(skip))
      .limit(Number(limit))
      .lean(),
    InvChangeLog.countDocuments(filter),
  ]);

  res.json({ data: logs, total });
});

// ─── update variant (spec / status) ──────────────────────────────────────────

router.put('/variants/:id', verify, async (req, res) => {
  const variant = await InvVariant.findOne({ _id: req.params.id, deleteDate: null });
  if (!variant) return res.status(404).json({ message: 'Variant not found' });

  const allowed = ['unit', 'status', 'categories'];
  const updates = { updateDate: new Date(), updatedBy: req.user?._id };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // Allow re-parsing if a new code is provided
  if (req.body.code) {
    const parsed = parseStoneCode(req.body.code);
    if (!parsed.valid) {
      return res.status(400).json({ message: 'Could not parse stone code', warnings: parsed.parseWarnings });
    }
    updates.code = parsed.raw.trim().toUpperCase();
    updates.spec = {
      stoneType: parsed.stoneType, stoneTypeName: parsed.stoneTypeName,
      quarryCode: parsed.quarryCode, grade: parsed.grade, gradeName: parsed.gradeName,
      gradeRank: parsed.gradeRank, lengthCm: parsed.lengthCm, widthCm: parsed.widthCm,
      thicknessMm: parsed.thicknessMm, unsized: parsed.unsized,
      cut: parsed.cut, cutName: parsed.cutName, fill: parsed.fill, fillName: parsed.fillName,
      finish: parsed.finish, finishName: parsed.finishName,
      raw: parsed.raw, parseWarnings: parsed.parseWarnings,
    };
    await InvChangeLog.create({
      subjectType: 'variant', subjectId: variant._id, productId: variant.productId,
      changeType: 'spec', field: 'code',
      oldValue: variant.code, newValue: updates.code,
      source: 'manual', changedBy: req.user?._id,
    });
  }

  const updated = await InvVariant.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
  if (updates.status) await recomputeRollup(variant.productId);

  res.json({ data: updated });
});

// ─── soft-delete variant ──────────────────────────────────────────────────────

router.delete('/variants/:id', verify, async (req, res) => {
  const variant = await InvVariant.findOneAndUpdate(
    { _id: req.params.id, deleteDate: null },
    { $set: { deleteDate: new Date(), status: 'archived', updatedBy: req.user?._id } },
    { new: true }
  );
  if (!variant) return res.status(404).json({ message: 'Variant not found' });

  await recomputeRollup(variant.productId);
  res.json({ message: 'Variant archived' });
});

// ─── stock adjust ─────────────────────────────────────────────────────────────

router.post('/variants/:id/adjust', verify, async (req, res) => {
  const { delta, reason, source = 'manual' } = req.body;

  if (delta === undefined || delta === null) {
    return res.status(400).json({ message: 'delta is required (positive to add, negative to subtract)' });
  }

  const variant = await InvVariant.findOne({ _id: req.params.id, deleteDate: null });
  if (!variant) return res.status(404).json({ message: 'Variant not found' });

  const oldQty = variant.quantity;
  const newQty = parseFloat((oldQty + Number(delta)).toFixed(4));

  if (newQty < 0) {
    return res.status(400).json({ message: `Adjustment would result in negative stock (${newQty})` });
  }

  await InvVariant.findByIdAndUpdate(req.params.id, {
    $set: { quantity: newQty, updateDate: new Date(), updatedBy: req.user?._id },
  });

  await InvChangeLog.create({
    subjectType:   'variant',
    subjectId:     variant._id,
    productId:     variant.productId,
    changeType:    'quantity',
    field:         'quantity',
    oldValue:      oldQty,
    newValue:      newQty,
    delta:         Number(delta),
    unit:          variant.unit,
    reason:        reason || null,
    source,
    changedBy:     req.user?._id,
    changedByName: req.user?.firstName ? `${req.user.firstName} ${req.user.lastName}` : undefined,
  });

  await recomputeRollup(variant.productId);

  res.json({ data: { oldQuantity: oldQty, newQuantity: newQty, delta: Number(delta), unit: variant.unit } });
});

// ─── price update ─────────────────────────────────────────────────────────────

router.put('/variants/:id/price', verify, async (req, res) => {
  const { price, currency = 'AED' } = req.body;

  if (price === undefined || price === null) {
    return res.status(400).json({ message: 'price is required' });
  }

  const variant = await InvVariant.findOne({ _id: req.params.id, deleteDate: null });
  if (!variant) return res.status(404).json({ message: 'Variant not found' });

  const oldPrice = variant.price;
  const newPrice = Number(price);

  await InvVariant.findByIdAndUpdate(req.params.id, {
    $set: { price: newPrice, currency, updateDate: new Date(), updatedBy: req.user?._id },
  });

  await InvChangeLog.create({
    subjectType:   'variant',
    subjectId:     variant._id,
    productId:     variant.productId,
    changeType:    'price',
    field:         'price',
    oldValue:      oldPrice,
    newValue:      newPrice,
    currency,
    source:        'manual',
    changedBy:     req.user?._id,
    changedByName: req.user?.firstName ? `${req.user.firstName} ${req.user.lastName}` : undefined,
  });

  await recomputeRollup(variant.productId);

  res.json({ data: { oldPrice, newPrice, currency } });
});

// ─── upload media for a variant ───────────────────────────────────────────────

router.post('/variants/:id/media', verify, upload.single('file'), async (req, res) => {
  const variant = await InvVariant.findOne({ _id: req.params.id, deleteDate: null });
  if (!variant) return res.status(404).json({ message: 'Variant not found' });

  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  const decoded = jwt_decode(req.headers.authorization);

  let thumbnailPath = null;
  if (req.file.mimetype.startsWith('image/')) {
    try {
      const thumbFilename = `thumb-${req.file.filename}`;
      const thumbPath = path.join('public/uploads', thumbFilename);
      await sharp(req.file.path).resize(300).jpeg({ quality: 80 }).toFile(thumbPath);
      thumbnailPath = thumbFilename;
    } catch (e) {
      // thumbnail failure is non-fatal
    }
  }

  const ext = req.file.originalname.slice(req.file.originalname.lastIndexOf('.') + 1);

  const fileDoc = await File.create({
    name:      req.file.originalname.split('.')[0],
    supFolder: null,
    metaData:  req.file,
    format:    ext,
    generatedBy: decoded.id,
    thumbnail: thumbnailPath,
    scope:     'inventory',
    attachedTo: { type: 'inventoryVariant', id: variant._id },
  });

  await InvChangeLog.create({
    subjectType: 'variant',
    subjectId:   variant._id,
    productId:   variant.productId,
    changeType:  'media',
    mediaRef:    { fileId: fileDoc._id, action: 'added', name: fileDoc.name },
    source:      'manual',
    changedBy:   decoded.id,
  });

  // Auto-set as product cover if none set yet
  const product = await InvProduct.findById(variant.productId);
  if (product && !product.coverMediaId && req.file.mimetype.startsWith('image/')) {
    await InvProduct.findByIdAndUpdate(variant.productId, {
      $set: { coverMediaId: fileDoc._id, coverThumbnail: thumbnailPath || null },
    });
  }

  res.status(201).json({ data: fileDoc });
});

// ─── upload media for a product (cover / product-level gallery) ───────────────

router.post('/products/:id/media', verify, upload.single('file'), async (req, res) => {
  const product = await InvProduct.findOne({ _id: req.params.id, deleteDate: null });
  if (!product) return res.status(404).json({ message: 'Product not found' });

  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  const decoded = jwt_decode(req.headers.authorization);

  let thumbnailPath = null;
  if (req.file.mimetype.startsWith('image/')) {
    try {
      const thumbFilename = `thumb-${req.file.filename}`;
      const thumbPath = path.join('public/uploads', thumbFilename);
      await sharp(req.file.path).resize(300).jpeg({ quality: 80 }).toFile(thumbPath);
      thumbnailPath = thumbFilename;
    } catch (e) {}
  }

  const ext = req.file.originalname.slice(req.file.originalname.lastIndexOf('.') + 1);

  const fileDoc = await File.create({
    name:      req.file.originalname.split('.')[0],
    supFolder: null,
    metaData:  req.file,
    format:    ext,
    generatedBy: decoded.id,
    thumbnail: thumbnailPath,
    scope:     'inventory',
    attachedTo: { type: 'inventoryProduct', id: product._id },
  });

  await InvChangeLog.create({
    subjectType: 'product',
    subjectId:   product._id,
    productId:   product._id,
    changeType:  'media',
    mediaRef:    { fileId: fileDoc._id, action: 'added', name: fileDoc.name },
    source:      'manual',
    changedBy:   decoded.id,
  });

  // Auto-set as cover if none exists
  if (!product.coverMediaId && req.file.mimetype.startsWith('image/')) {
    await InvProduct.findByIdAndUpdate(product._id, {
      $set: { coverMediaId: fileDoc._id, coverThumbnail: thumbnailPath || null },
    });
  }

  res.status(201).json({ data: fileDoc });
});

// ─── get media for a product or variant ───────────────────────────────────────

router.get('/media', verify, async (req, res) => {
  const { attachedToType, attachedToId } = req.query;
  if (!attachedToType || !attachedToId) {
    return res.status(400).json({ message: 'attachedToType and attachedToId are required' });
  }

  const files = await File.find({
    scope: 'inventory',
    'attachedTo.type': attachedToType,
    'attachedTo.id':   attachedToId,
    deleteDate:        null,
  }).sort({ insertDate: -1 }).lean();

  res.json({ data: files });
});

// ─── delete media ─────────────────────────────────────────────────────────────

router.delete('/media/:fileId', verify, async (req, res) => {
  const fileDoc = await File.findOne({ _id: req.params.fileId, deleteDate: null });
  if (!fileDoc) return res.status(404).json({ message: 'File not found' });

  if (fileDoc.scope !== 'inventory') {
    return res.status(403).json({ message: 'File does not belong to inventory' });
  }

  await File.findByIdAndUpdate(req.params.fileId, { $set: { deleteDate: new Date() } });

  const productId = fileDoc.attachedTo?.type === 'inventoryVariant'
    ? (await InvVariant.findById(fileDoc.attachedTo.id))?.productId
    : fileDoc.attachedTo?.id;

  if (productId) {
    await InvChangeLog.create({
      subjectType: fileDoc.attachedTo.type === 'inventoryVariant' ? 'variant' : 'product',
      subjectId:   fileDoc.attachedTo.id,
      productId,
      changeType:  'media',
      mediaRef:    { fileId: fileDoc._id, action: 'removed', name: fileDoc.name },
      source:      'manual',
      changedBy:   req.user?._id,
    });

    // Clear coverMediaId + coverThumbnail if this was the cover
    await InvProduct.updateOne(
      { _id: productId, coverMediaId: fileDoc._id },
      { $set: { coverMediaId: null, coverThumbnail: null } }
    );
  }

  res.json({ message: 'Media removed' });
});

module.exports = router;
