const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const archiver = require('archiver');
const XLSX = require('xlsx');
const jwt_decode = require('jwt-decode');
const dbConnection = require('../../connections/xmsPr');
const inventoryProductSchema   = require('../../models/inventoryProductModel');
const inventoryVariantSchema   = require('../../models/inventoryVariantModel');
const inventoryChangeLogSchema = require('../../models/inventoryChangeLogModel');
const fileSchema               = require('../../models/fileModel');
const groupSchema              = require('../../models/groupModel');
const userSchema                = require('../../models/userModel');
const categorySchema            = require('../../models/categoryModel');
const verify = require('../users/verifyToken');
const { getEffectiveScopes, requirePermission, requireBranch, assertBranchAccess } = require('../../utils/rbac');
const { parseStoneCode } = require('../../utils/stoneCodeParser');
const { stoneTypes, grades, units, quarries } = require('./lookups');

ffmpeg.setFfmpegPath(ffmpegPath);

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
const Group        = dbConnection.model('group',              groupSchema);
const User         = dbConnection.models.user || dbConnection.model('user', userSchema);
const Category     = dbConnection.models.inventoryCategory || dbConnection.model('inventoryCategory', categorySchema);

// Replace the old full unique index with a partial one so soft-deleted codes can be reused.
// syncIndexes() drops indexes not in the schema and creates missing ones — runs once at startup.
InvVariant.syncIndexes().catch(() => {});

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

async function getUploaderName(userId) {
  const u = await User.findById(userId).select('firstName lastName').lean();
  return u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '';
}

// Extracts a single preview frame from a video (10% in — robust against very
// short clips) and resizes it via the same thumbnail convention as images.
function extractVideoThumbnail(videoPath, thumbFilename) {
  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .on('end', () => resolve(thumbFilename))
      .on('error', () => resolve(null)) // non-fatal — falls back to the play-icon placeholder
      .screenshots({
        count: 1,
        timestamps: ['10%'],
        filename: thumbFilename,
        folder: 'public/uploads',
        size: '300x?',
      });
  });
}

// ─── lookups ──────────────────────────────────────────────────────────────────

router.get('/lookups', verify, requirePermission('inventory:view'), async (req, res) => {
  const categories = await Category.find({ deleteDate: null }).sort({ name: 1 }).lean();
  res.json({ stoneTypes, grades, units, quarries, categories });
});

// ─── Excel export ──────────────────────────────────────────────────────────────
// Field catalog — only fields that already exist on the models are offered
// (no schema changes). code/unit/quantity/price live on the variant; name/
// stoneType/category resolve through the parent product; grade/dimensions are
// parsed spec, informational only (not re-imported — they're derived from code).
const EXPORT_FIELDS = {
  code:        { label: 'Code',        get: (v) => v.code },
  name:        { label: 'Name',        get: (v) => v.product?.name || '' },
  stoneType:   { label: 'Stone type',  get: (v) => v.spec?.stoneTypeName || v.spec?.stoneType || '' },
  quarryCode:  { label: 'Quarry code', get: (v) => v.spec?.quarryCode || '' },
  grade:       { label: 'Grade',       get: (v) => v.spec?.gradeName || v.spec?.grade || '' },
  dimensions:  { label: 'Dimensions',  get: (v) => v.spec?.unsized
    ? `${v.spec.thicknessMm || ''}mm` : `${v.spec?.lengthCm || ''}x${v.spec?.widthCm || ''}x${v.spec?.thicknessMm || ''}` },
  unit:        { label: 'Unit',        get: (v) => v.unit },
  quantity:    { label: 'Quantity',    get: (v) => v.quantity },
  price:       { label: 'Price',       get: (v) => v.price },
  category:    { label: 'Category',    get: (v) => (v.categories || []).map((c) => c.name).join(', ') },
  status:      { label: 'Status',      get: (v) => v.status },
};

router.get('/export/fields', verify, requirePermission('inventory:export'), async (req, res) => {
  res.json({ fields: Object.entries(EXPORT_FIELDS).map(([key, f]) => ({ key, label: f.label })) });
});

router.get('/export', verify, requirePermission('inventory:export'), requireBranch(), async (req, res) => {
  try {
    const requested = (req.query.fields || '').split(',').map((s) => s.trim()).filter(Boolean);
    const fieldKeys = requested.length ? requested.filter((k) => EXPORT_FIELDS[k]) : Object.keys(EXPORT_FIELDS);
    if (!fieldKeys.length) return res.status(400).json({ message: 'No valid fields selected' });

    const filter = { branchId: req.branchId, deleteDate: null };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.stoneType) filter['spec.stoneType'] = req.query.stoneType.toUpperCase();

    const variants = await InvVariant.find(filter)
      .populate({ path: 'productId', select: 'name', model: InvProduct })
      .populate({ path: 'categories', select: 'name', model: Category })
      .lean();
    // .lean() + populate keeps the populated doc under the ref field name;
    // normalize productId → product for the field getters above.
    for (const v of variants) v.product = v.productId;

    const header = fieldKeys.map((k) => EXPORT_FIELDS[k].label);
    const rows = variants.map((v) => fieldKeys.map((k) => EXPORT_FIELDS[k].get(v)));

    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-export-${Date.now()}.xlsx"`);
    return res.status(200).end(buf);
  } catch (err) {
    console.error('GET /inventory/export failed:', err);
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

// ─── Excel import ──────────────────────────────────────────────────────────────
// Settable fields — the ones actually written onto product/variant docs.
// code drives matching/creation and is always read regardless of selection.
const IMPORT_SETTABLE_FIELDS = ['name', 'unit', 'quantity', 'price', 'category'];

// Real supplier sheets write the unit as "M²" (superscript-2), not the schema's
// literal enum value "M2" — normalize common spellings so those rows don't all
// fail model validation.
const UNIT_ENUM = ['M2', 'ML', 'PCS', 'SQFT', 'LNFT'];
function normalizeUnit(raw) {
  const u = String(raw).trim().toUpperCase().replace(/²/g, '2').replace(/\./g, '').replace(/\s+/g, '');
  if (UNIT_ENUM.includes(u)) return u;
  if (u === 'SQM' || u === 'SQUAREMETER' || u === 'SQUAREMETERS') return 'M2';
  if (u === 'LINEARMETER' || u === 'METERLINEAR' || u === 'LM') return 'ML';
  if (u === 'PIECE' || u === 'PIECES' || u === 'PC') return 'PCS';
  if (u === 'SQUAREFEET' || u === 'SQFEET') return 'SQFT';
  if (u === 'LINEARFEET' || u === 'LINFT') return 'LNFT';
  return null;   // unrecognized — caller should skip setting unit rather than fail validation
}

router.post('/import', verify, requirePermission('inventory:import'), upload.single('file'), requireBranch(), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const decoded = jwt_decode(req.headers.authorization);
    const userId  = decoded.id;
    const branchId = req.branchId;

    const requested = (req.body.fields || '').split(',').map((s) => s.trim()).filter(Boolean);
    const applyFields = new Set(requested.length ? requested.filter((f) => IMPORT_SETTABLE_FIELDS.includes(f)) : IMPORT_SETTABLE_FIELDS);

    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Locate the header row by scanning the first 10 rows for a cell that
    // reads "CODE" (case-insensitive) — templates vary in how many title/
    // sub-header rows precede it (see MATIN STORE.xlsx: title + EN header +
    // AR header + dash row, THEN data).
    let headerRowIdx = -1, codeCol = -1, nameCol = -1, unitCol = -1, qtyCol = -1, remainingCol = -1, priceCol = -1, categoryCol = -1;
    for (let r = 0; r < Math.min(10, rows.length); r++) {
      const idx = rows[r].findIndex((c) => String(c).trim().toUpperCase() === 'CODE');
      if (idx !== -1) {
        headerRowIdx = r; codeCol = idx;
        rows[r].forEach((cell, ci) => {
          const c = String(cell).trim().toUpperCase();
          if (c === 'NAME') nameCol = ci;
          else if (c === 'UNIT') unitCol = ci;
          else if (c === 'QTY') qtyCol = ci;
          else if (c.includes('REMAINING') || c === 'THE REMAINING QUANTITY') remainingCol = ci;
          else if (c.includes('SECTOR')) priceCol = ci;
          else if (c === 'CATEGORY') categoryCol = ci;
        });
        break;
      }
    }
    if (headerRowIdx === -1) {
      return res.status(400).json({ message: 'Could not find a CODE column in this file' });
    }
    const qCol = remainingCol !== -1 ? remainingCol : qtyCol;

    const summary = { processed: 0, created: 0, updated: 0, skipped: 0, errors: [] };
    const touchedProducts = new Set();
    const categoryCache = new Map();

    async function resolveCategory(name) {
      const key = name.trim().toLowerCase();
      if (categoryCache.has(key)) return categoryCache.get(key);
      let cat = await Category.findOne({ name: new RegExp(`^${name.trim()}$`, 'i'), deleteDate: null });
      if (!cat) cat = await Category.create({ name: name.trim() });
      categoryCache.set(key, cat._id);
      return cat._id;
    }

    for (let r = headerRowIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const rawCode = row[codeCol];
      if (!rawCode || typeof rawCode !== 'string' || !rawCode.trim() || rawCode.trim() === '-') continue;

      summary.processed++;
      const parsed = parseStoneCode(rawCode.trim());
      if (!parsed.valid) {
        summary.skipped++;
        summary.errors.push({ row: r + 1, code: rawCode, message: 'Code does not match the stone-code format' });
        continue;
      }

      try {
        let product = await InvProduct.findOne({ branchId, code: parsed.productCode, deleteDate: null });
        if (!product) {
          product = await InvProduct.create({
            branchId,
            code: parsed.productCode,
            stoneType: parsed.stoneType, stoneTypeName: parsed.stoneTypeName,
            quarryCode: parsed.quarryCode,
            name: applyFields.has('name') && nameCol !== -1 ? String(row[nameCol] || '') : parsed.productCode,
            createdBy: userId,
          });
        } else if (applyFields.has('name') && nameCol !== -1 && row[nameCol]) {
          await InvProduct.updateOne({ _id: product._id }, { $set: { name: String(row[nameCol]), updateDate: new Date() } });
        }

        const spec = {
          stoneType: parsed.stoneType, stoneTypeName: parsed.stoneTypeName,
          quarryCode: parsed.quarryCode, grade: parsed.grade, gradeName: parsed.gradeName, gradeRank: parsed.gradeRank,
          lengthCm: parsed.lengthCm, widthCm: parsed.widthCm, thicknessMm: parsed.thicknessMm, unsized: parsed.unsized,
          cut: parsed.cut, cutName: parsed.cutName, fill: parsed.fill, fillName: parsed.fillName,
          finish: parsed.finish, finishName: parsed.finishName, raw: parsed.raw, parseWarnings: parsed.parseWarnings,
        };

        const code = parsed.raw.trim().toUpperCase();
        let variant = await InvVariant.findOne({ branchId, code, deleteDate: null });

        const newUnit     = applyFields.has('unit')     && unitCol     !== -1 && row[unitCol]     ? normalizeUnit(row[unitCol]) : undefined;
        if (applyFields.has('unit') && unitCol !== -1 && row[unitCol] && newUnit === null) {
          summary.errors.push({ row: r + 1, code: rawCode, message: `Unrecognized unit "${row[unitCol]}" — left unchanged` });
        }
        const newQuantity = applyFields.has('quantity') && qCol       !== -1 && row[qCol]     !== '' ? Number(row[qCol])     : undefined;
        const newPrice    = applyFields.has('price')    && priceCol   !== -1 && row[priceCol] !== '' ? Number(row[priceCol]) : undefined;
        const catCellName = applyFields.has('category') && categoryCol !== -1 && row[categoryCol] ? String(row[categoryCol]).trim() : undefined;
        const categoryId  = catCellName ? await resolveCategory(catCellName) : undefined;

        if (!variant) {
          variant = await InvVariant.create({
            branchId, productId: product._id, code, spec,
            unit: newUnit || 'M2',
            quantity: newQuantity != null && !Number.isNaN(newQuantity) ? newQuantity : 0,
            price: newPrice != null && !Number.isNaN(newPrice) ? newPrice : null,
            categories: categoryId ? [categoryId] : [],
            createdBy: userId,
          });
          await InvChangeLog.create({
            subjectType: 'variant', subjectId: variant._id, productId: product._id,
            changeType: 'created', source: 'import', changedBy: userId,
          });
          summary.created++;
        } else {
          const update = { updateDate: new Date(), updatedBy: userId };
          if (newUnit) update.unit = newUnit;
          if (categoryId) update.categories = [categoryId];

          if (newQuantity != null && !Number.isNaN(newQuantity) && newQuantity !== variant.quantity) {
            await InvChangeLog.create({
              subjectType: 'variant', subjectId: variant._id, productId: product._id,
              changeType: 'quantity', field: 'quantity', oldValue: variant.quantity, newValue: newQuantity,
              delta: newQuantity - variant.quantity, unit: variant.unit, source: 'import', changedBy: userId,
            });
            update.quantity = newQuantity;
          }
          if (newPrice != null && !Number.isNaN(newPrice) && newPrice !== variant.price) {
            await InvChangeLog.create({
              subjectType: 'variant', subjectId: variant._id, productId: product._id,
              changeType: 'price', field: 'price', oldValue: variant.price, newValue: newPrice,
              currency: variant.currency, source: 'import', changedBy: userId,
            });
            update.price = newPrice;
          }
          await InvVariant.updateOne({ _id: variant._id }, { $set: update });
          summary.updated++;
        }

        touchedProducts.add(String(product._id));
      } catch (rowErr) {
        summary.skipped++;
        summary.errors.push({ row: r + 1, code: rawCode, message: rowErr.message });
      }
    }

    for (const pid of touchedProducts) await recomputeRollup(pid);

    fs.unlink(req.file.path, () => {});
    return res.status(200).json({ data: summary });
  } catch (err) {
    console.error('POST /inventory/import failed:', err);
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

// ─── weekly/overall stats ─────────────────────────────────────────────────────
router.get('/stats', verify, requirePermission('inventory:view'), requireBranch(), async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const branchId = req.branchId;

  const branchVariantIds = (await InvVariant.find({ branchId, deleteDate: null }).select('_id').lean()).map((v) => v._id);

  const [productCount, variantCount, variants, weekLogs] = await Promise.all([
    InvProduct.countDocuments({ branchId, deleteDate: null, status: 'active' }),
    InvVariant.countDocuments({ branchId, deleteDate: null, status: 'active' }),
    InvVariant.find({ branchId, deleteDate: null, status: 'active' }, 'unit quantity').lean(),
    InvChangeLog.find({ changeType: 'quantity', date: { $gte: weekAgo }, subjectId: { $in: branchVariantIds } }, 'delta').lean(),
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

router.post('/parse-code', verify, requirePermission('inventory:view'), async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: 'code is required' });

  const parsed = parseStoneCode(code);
  res.json({ parsed });
});

// ─── products/creators — distinct users who created a product ─────────────────
// Powers the "created by" filter (gated by inventory:view, not users:view).

router.get('/products/creators', verify, requirePermission('inventory:view'), requireBranch(), async (req, res) => {
  try {
    const ids = await InvProduct.distinct('createdBy', { branchId: req.branchId, deleteDate: null, createdBy: { $ne: null } });
    const users = await User.find({ _id: { $in: ids } }).select('firstName lastName').lean();
    const data = users.map((u) => ({ _id: u._id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Unknown' }));
    return res.status(200).json({ data });
  } catch (err) {
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

// ─── products list ────────────────────────────────────────────────────────────

router.get('/products', verify, requirePermission('inventory:view'), requireBranch(), async (req, res) => {
  const {
    stoneType, quarryCode, status = 'active',
    search, sort = 'insertDate', order = 'desc',
    limit = 50, skip = 0, createdBy,
  } = req.query;

  // Scope enforcement
  const effScopes = await getEffectiveScopes(req.user.id);
  const scope     = effScopes.inventory || 'all';
  const uid       = String(req.user.id);

  const filter = { branchId: req.branchId, deleteDate: null };

  if (status) filter.status = status;
  if (stoneType) filter.stoneType = stoneType.toUpperCase();
  if (quarryCode) filter.quarryCode = quarryCode;
  if (search) {
    const re = new RegExp(search, 'i');
    filter.$or = [{ code: re }, { name: re }, { nameAr: re }];
  }
  // Apply scope filter first (never trust the client — this is the real gate)
  if (scope === 'mine') {
    filter.createdBy = mongoose.Types.ObjectId(uid);
  } else if (scope === 'group') {
    const userGroups = await Group.find({ members: mongoose.Types.ObjectId(uid), deleteDate: null }).select('members').lean();
    const memberIds  = [...new Set(userGroups.flatMap(g => g.members.map(String)))].map(id => mongoose.Types.ObjectId(id));
    filter.createdBy = memberIds.length ? { $in: memberIds } : mongoose.Types.ObjectId(uid);
  }

  // "created by" filter — a refinement WITHIN whatever the scope already
  // allows. Meaningless (and disabled client-side) when scope === 'mine'
  // since createdBy is already pinned to the current user above.
  if (createdBy && mongoose.Types.ObjectId.isValid(createdBy) && scope !== 'mine') {
    const requested = mongoose.Types.ObjectId(createdBy);
    if (scope === 'group' && filter.createdBy.$in) {
      // must be one of the group's members — otherwise ignore (keep the group filter)
      if (filter.createdBy.$in.some((id) => String(id) === String(requested))) {
        filter.createdBy = requested;
      }
    } else {
      filter.createdBy = requested;
    }
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

  res.json({ data: products, total, scope });
});

// ─── product detail ───────────────────────────────────────────────────────────

router.get('/products/:id', verify, requirePermission('inventory:view'), async (req, res) => {
  const product = await InvProduct.findOne({
    _id: req.params.id,
    deleteDate: null,
  }).lean();

  if (!product) return res.status(404).json({ message: 'Product not found' });

  if (!(await assertBranchAccess(req.user.id, product.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

  // Scope enforcement on detail
  const effScopes = await getEffectiveScopes(req.user.id);
  const scope     = effScopes.inventory || 'all';
  const uid       = String(req.user.id);

  if (scope === 'mine') {
    if (String(product.createdBy) !== uid) {
      return res.status(403).json({ message: 'دسترسی ندارید' });
    }
  } else if (scope === 'group') {
    const userGroups = await Group.find({ members: mongoose.Types.ObjectId(uid), deleteDate: null }).select('members').lean();
    const memberIds  = new Set(userGroups.flatMap(g => g.members.map(String)));
    memberIds.add(uid);
    if (!memberIds.has(String(product.createdBy))) {
      return res.status(403).json({ message: 'دسترسی ندارید' });
    }
  }

  const variants = await InvVariant.find({
    productId: product._id,
    deleteDate: null,
  })
    .sort({ 'spec.gradeRank': 1, 'spec.lengthCm': -1 })
    .lean();

  res.json({ data: { ...product, variants } });
});

// ─── create product (variety) ─────────────────────────────────────────────────

router.post('/products', verify, requirePermission('inventory:product:create'), requireBranch(), async (req, res) => {
  const {
    stoneType, quarryCode, quarryName,
    name, nameAr, description, category, defaultUnit,
  } = req.body;

  if (!stoneType || !quarryCode) {
    return res.status(400).json({ message: 'stoneType and quarryCode are required' });
  }

  const paddedQuarryCode = String(quarryCode).padStart(2, '0');
  const code = `${stoneType.toUpperCase()}${paddedQuarryCode}`;

  const existing = await InvProduct.findOne({ branchId: req.branchId, code, deleteDate: null });
  if (existing) {
    return res.status(409).json({ message: `Product code ${code} already exists` });
  }

  const { STONE_TYPES } = require('../../utils/stoneCodeParser');
  const stoneTypeName = STONE_TYPES[stoneType.toUpperCase()] || stoneType;

  const product = await InvProduct.create({
    branchId: req.branchId,
    code,
    stoneType: stoneType.toUpperCase(),
    stoneTypeName,
    quarryCode: paddedQuarryCode,
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

router.put('/products/:id', verify, requirePermission('inventory:edit'), async (req, res) => {
  const existing = await InvProduct.findOne({ _id: req.params.id, deleteDate: null }).lean();
  if (!existing) return res.status(404).json({ message: 'Product not found' });
  if (!(await assertBranchAccess(req.user.id, existing.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

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

router.delete('/products/:id', verify, requirePermission('inventory:delete'), async (req, res) => {
  const existing = await InvProduct.findOne({ _id: req.params.id, deleteDate: null }).lean();
  if (!existing) return res.status(404).json({ message: 'Product not found' });
  if (!(await assertBranchAccess(req.user.id, existing.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

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

router.get('/products/:id/variants', verify, requirePermission('inventory:view'), async (req, res) => {
  const product = await InvProduct.findOne({ _id: req.params.id, deleteDate: null }).lean();
  if (!product) return res.status(404).json({ message: 'Product not found' });
  if (!(await assertBranchAccess(req.user.id, product.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

  const variants = await InvVariant.find({
    productId: req.params.id,
    deleteDate: null,
  })
    .sort({ 'spec.gradeRank': 1, 'spec.lengthCm': -1 })
    .lean();

  res.json({ data: variants });
});

// ─── create variant ───────────────────────────────────────────────────────────

router.post('/variants', verify, requirePermission('inventory:subproduct:create'), async (req, res) => {
  const { code, productId, unit, quantity = 0, price = null, currency = 'AED' } = req.body;

  if (!code)      return res.status(400).json({ message: 'code is required' });
  if (!productId) return res.status(400).json({ message: 'productId is required' });

  const product = await InvProduct.findOne({ _id: productId, deleteDate: null });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  if (!(await assertBranchAccess(req.user.id, product.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

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

  const existing = await InvVariant.findOne({ branchId: product.branchId, code: normalizedCode, deleteDate: null });
  if (existing) {
    return res.status(409).json({ message: `Variant code ${normalizedCode} already exists` });
  }

  const variant = await InvVariant.create({
    branchId: product.branchId,
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

// ─── invoices containing this product (Phase 6 reverse lookup) ────────────────
// Symmetric mirror of the CRM Requests tab: every invoice/pre-invoice whose
// lineItems.productId (or .variantId) matches. Read gated by inventory:view + mis:view.

router.get('/products/:id/invoices', verify, requirePermission('inventory:view'), requirePermission('mis:view'), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'شناسه نامعتبر است' });
    }
    const product = await InvProduct.findOne({ _id: req.params.id, deleteDate: null }).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (!(await assertBranchAccess(req.user.id, product.branchId))) {
      return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
    }
    const misInvoiceSchema = require('../../models/misInvoiceModel');
    const MisInvoice = dbConnection.models.misInvoice || dbConnection.model('misInvoice', misInvoiceSchema);

    const { docType = 'all', order = 'desc' } = req.query;

    const pid = new mongoose.Types.ObjectId(req.params.id);
    // matches the product itself OR any of its variants on either line ref
    const variantIds = (await InvVariant.find({ productId: pid }).select('_id').lean()).map(v => v._id);
    const idPool = [pid, ...variantIds];
    const query = {
      branchId: product.branchId,
      deleteDate: null,
      $or: [{ 'lineItems.productId': { $in: idPool } }, { 'lineItems.variantId': { $in: idPool } }],
    };
    if (docType === 'invoice' || docType === 'pre_invoice') query.docType = docType;

    const sortDir = order === 'asc' ? 1 : -1;

    const [rows, total] = await Promise.all([
      MisInvoice.find(query)
        .select('docType docNumber status issueDate grandTotal currency customerSnapshot.name lineItems.productId lineItems.variantId lineItems.code')
        .sort({ issueDate: sortDir, _id: sortDir })
        .limit(100)
        .lean(),
      MisInvoice.countDocuments(query),
    ]);

    // Expose only the codes of THIS product's matching lines (not the whole
    // lineItems array) — answers "why does this invoice show up here".
    const idPoolStr = idPool.map((id) => String(id));
    const data = rows.map((doc) => {
      const matchedCodes = (doc.lineItems || [])
        .filter((li) => idPoolStr.includes(String(li.productId)) || idPoolStr.includes(String(li.variantId)))
        .map((li) => li.code);
      const { lineItems, ...rest } = doc;
      return { ...rest, matchedCodes };
    });

    return res.status(200).json({ data, total });
  } catch (err) {
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

// ─── change log for a product ─────────────────────────────────────────────────

router.get('/products/:id/logs', verify, requirePermission('inventory:view'), async (req, res) => {
  const product = await InvProduct.findOne({ _id: req.params.id, deleteDate: null }).lean();
  if (!product) return res.status(404).json({ message: 'Product not found' });
  if (!(await assertBranchAccess(req.user.id, product.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

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

router.put('/variants/:id', verify, requirePermission('inventory:edit'), async (req, res) => {
  const variant = await InvVariant.findOne({ _id: req.params.id, deleteDate: null });
  if (!variant) return res.status(404).json({ message: 'Variant not found' });
  if (!(await assertBranchAccess(req.user.id, variant.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

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

router.delete('/variants/:id', verify, requirePermission('inventory:delete'), async (req, res) => {
  const existing = await InvVariant.findOne({ _id: req.params.id, deleteDate: null }).lean();
  if (!existing) return res.status(404).json({ message: 'Variant not found' });
  if (!(await assertBranchAccess(req.user.id, existing.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

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

router.post('/variants/:id/adjust', verify, requirePermission('inventory:quantity:edit'), async (req, res) => {
  const { delta, reason, source = 'manual' } = req.body;

  if (delta === undefined || delta === null) {
    return res.status(400).json({ message: 'delta is required (positive to add, negative to subtract)' });
  }

  const variant = await InvVariant.findOne({ _id: req.params.id, deleteDate: null });
  if (!variant) return res.status(404).json({ message: 'Variant not found' });
  if (!(await assertBranchAccess(req.user.id, variant.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

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

router.put('/variants/:id/price', verify, requirePermission('inventory:price:edit'), async (req, res) => {
  const { price, currency = 'AED' } = req.body;

  if (price === undefined || price === null) {
    return res.status(400).json({ message: 'price is required' });
  }

  const variant = await InvVariant.findOne({ _id: req.params.id, deleteDate: null });
  if (!variant) return res.status(404).json({ message: 'Variant not found' });
  if (!(await assertBranchAccess(req.user.id, variant.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

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

router.post('/variants/:id/media', verify, requirePermission('inventory:media:edit'), upload.single('file'), async (req, res) => {
  const variant = await InvVariant.findOne({ _id: req.params.id, deleteDate: null });
  if (!variant) return res.status(404).json({ message: 'Variant not found' });
  if (!(await assertBranchAccess(req.user.id, variant.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

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

// ─── variant media BATCH (image/video set with upload + expiration dates) ────
// Only one batch exists per variant at a time. Uploading a new batch soft-
// deletes the previous one first (this IS the "delete & replace" action) —
// every removed + added file still gets its own inventoryChangeLogs row,
// same shape/discipline as the single-file route above.

router.post('/variants/:id/media-batch', verify, requirePermission('inventory:media:edit'), upload.array('files', 20), async (req, res) => {
  const variant = await InvVariant.findOne({ _id: req.params.id, deleteDate: null });
  if (!variant) return res.status(404).json({ message: 'Variant not found' });
  if (!(await assertBranchAccess(req.user.id, variant.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

  if (!req.files || !req.files.length) {
    return res.status(400).json({ message: 'No files uploaded' });
  }

  const decoded = jwt_decode(req.headers.authorization);
  const uploaderName   = await getUploaderName(decoded.id);
  const uploadDate      = req.body.uploadDate      ? new Date(req.body.uploadDate)      : new Date();
  const expirationDate  = req.body.expirationDate  ? new Date(req.body.expirationDate)  : null;

  // Replace: soft-delete the current batch (if any) for this variant first
  const oldFiles = await File.find({
    scope: 'inventory',
    'attachedTo.type': 'inventoryVariant',
    'attachedTo.id':   variant._id,
    deleteDate:        null,
  });
  if (oldFiles.length) {
    await File.updateMany(
      { _id: { $in: oldFiles.map((f) => f._id) } },
      { $set: { deleteDate: new Date() } }
    );
    await InvChangeLog.insertMany(oldFiles.map((f) => ({
      subjectType: 'variant', subjectId: variant._id, productId: variant.productId,
      changeType: 'media', mediaRef: { fileId: f._id, action: 'removed', name: f.name },
      source: 'manual', changedBy: decoded.id, changedByName: uploaderName,
    })));
  }

  const batchId = new mongoose.Types.ObjectId();
  const uploadedFileDocs = [];

  for (const file of req.files) {
    let thumbnailPath = null;
    if (file.mimetype.startsWith('image/')) {
      try {
        const thumbFilename = `thumb-${file.filename}`;
        const thumbPath = path.join('public/uploads', thumbFilename);
        await sharp(file.path).resize(300).jpeg({ quality: 80 }).toFile(thumbPath);
        thumbnailPath = thumbFilename;
      } catch (e) { /* thumbnail failure is non-fatal */ }
    } else if (file.mimetype.startsWith('video/')) {
      const videoThumbFilename = `thumb-${file.filename}.jpg`;
      thumbnailPath = await extractVideoThumbnail(file.path, videoThumbFilename);
    }

    const ext = file.originalname.slice(file.originalname.lastIndexOf('.') + 1);

    const fileDoc = await File.create({
      name:      file.originalname.split('.')[0],
      supFolder: null,
      metaData:  file,
      format:    ext,
      generatedBy: decoded.id,
      uploadedByName: uploaderName,
      thumbnail: thumbnailPath,
      scope:     'inventory',
      attachedTo: { type: 'inventoryVariant', id: variant._id },
      batchId, uploadDate, expirationDate,
    });
    uploadedFileDocs.push(fileDoc);
  }

  await InvChangeLog.insertMany(uploadedFileDocs.map((f) => ({
    subjectType: 'variant', subjectId: variant._id, productId: variant.productId,
    changeType: 'media', mediaRef: { fileId: f._id, action: 'added', name: f.name },
    source: 'manual', changedBy: decoded.id, changedByName: uploaderName,
  })));

  // Auto-set as product cover if none set yet (mirrors the single-file route)
  const firstImage = uploadedFileDocs.find((f) => f.metaData?.mimetype?.startsWith('image/'));
  const product = await InvProduct.findById(variant.productId);
  if (product && !product.coverMediaId && firstImage) {
    await InvProduct.findByIdAndUpdate(variant.productId, {
      $set: { coverMediaId: firstImage._id, coverThumbnail: firstImage.thumbnail || null },
    });
  }

  res.status(201).json({ data: uploadedFileDocs });
});

// ─── download the whole variant media batch as one .zip ──────────────────────
router.get('/variants/:id/media-batch/zip', verify, requirePermission('inventory:view'), async (req, res) => {
  const variant = await InvVariant.findOne({ _id: req.params.id, deleteDate: null });
  if (!variant) return res.status(404).json({ message: 'Variant not found' });
  if (!(await assertBranchAccess(req.user.id, variant.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

  const files = await File.find({
    scope: 'inventory',
    'attachedTo.type': 'inventoryVariant',
    'attachedTo.id':   variant._id,
    deleteDate:        null,
  }).lean();

  if (!files.length) return res.status(404).json({ message: 'No media batch to download' });

  res.attachment(`${variant.code || 'variant'}-media-batch.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', () => res.end());
  archive.pipe(res);

  for (const f of files) {
    if (!f.metaData?.filename) continue;
    const diskPath = path.join('public/uploads', f.metaData.filename);
    if (fs.existsSync(diskPath)) {
      const ext = f.format ? `.${f.format}` : '';
      archive.file(diskPath, { name: `${f.name}${ext}` });
    }
  }

  archive.finalize();
});

// ─── upload media for a product (cover / product-level gallery) ───────────────

router.post('/products/:id/media', verify, requirePermission('inventory:media:edit'), upload.single('file'), async (req, res) => {
  const product = await InvProduct.findOne({ _id: req.params.id, deleteDate: null });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  if (!(await assertBranchAccess(req.user.id, product.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

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

router.get('/media', verify, requirePermission('inventory:view'), async (req, res) => {
  const { attachedToType, attachedToId } = req.query;
  if (!attachedToType || !attachedToId) {
    return res.status(400).json({ message: 'attachedToType and attachedToId are required' });
  }

  const owner = attachedToType === 'inventoryVariant'
    ? await InvVariant.findOne({ _id: attachedToId, deleteDate: null }).select('branchId').lean()
    : await InvProduct.findOne({ _id: attachedToId, deleteDate: null }).select('branchId').lean();
  if (!owner) return res.status(404).json({ message: 'Not found' });
  if (!(await assertBranchAccess(req.user.id, owner.branchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
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

router.delete('/media/:fileId', verify, requirePermission('inventory:media:edit'), async (req, res) => {
  const fileDoc = await File.findOne({ _id: req.params.fileId, deleteDate: null });
  if (!fileDoc) return res.status(404).json({ message: 'File not found' });

  if (fileDoc.scope !== 'inventory') {
    return res.status(403).json({ message: 'File does not belong to inventory' });
  }

  const ownerVariant = fileDoc.attachedTo?.type === 'inventoryVariant'
    ? await InvVariant.findById(fileDoc.attachedTo.id).select('branchId productId').lean()
    : null;
  const ownerBranchId = ownerVariant
    ? ownerVariant.branchId
    : (await InvProduct.findById(fileDoc.attachedTo?.id).select('branchId').lean())?.branchId;
  if (!(await assertBranchAccess(req.user.id, ownerBranchId))) {
    return res.status(403).json({ message: 'دسترسی به این شعبه ندارید' });
  }

  await File.findByIdAndUpdate(req.params.fileId, { $set: { deleteDate: new Date() } });

  const productId = fileDoc.attachedTo?.type === 'inventoryVariant'
    ? ownerVariant?.productId
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
