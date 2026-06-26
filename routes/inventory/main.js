const express = require('express');
const mongoose = require('mongoose');
const dbConnection = require('../../connections/xmsPr');
const inventoryProductSchema  = require('../../models/inventoryProductModel');
const inventoryVariantSchema  = require('../../models/inventoryVariantModel');
const inventoryChangeLogSchema = require('../../models/inventoryChangeLogModel');
const verify = require('../users/verifyToken');
const { parseStoneCode } = require('../../utils/stoneCodeParser');
const { stoneTypes, grades, units, quarries } = require('./lookups');

const InvProduct   = dbConnection.model('inventoryProduct',   inventoryProductSchema);
const InvVariant   = dbConnection.model('inventoryVariant',   inventoryVariantSchema);
const InvChangeLog = dbConnection.model('inventoryChangeLog', inventoryChangeLogSchema);

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
  res.json({ stoneTypes, grades, units, quarries });
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

module.exports = router;
