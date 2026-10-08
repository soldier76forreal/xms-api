const express  = require('express');
const mongoose = require('mongoose');
const multer   = require('multer');
const { blockExecutableFiles, uploadLimits, MAX_BATCH_FILES } = require('../../utils/uploadGuards');
const sharp    = require('sharp');
const ffmpeg   = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { extractVideoThumbnail, transcodeVideoAsync, isVideoUpload } = require('../../utils/mediaConvert');

const dbConnection = require('../../connections/xmsPr');
const supplyRecordSchema             = require('../../models/supplyRecordModel');
const supplyDealLetterSchema         = require('../../models/supplyDealLetterModel');
const supplyDealLetterActivitySchema = require('../../models/supplyDealLetterActivityModel');
const inventoryProductSchema = require('../../models/inventoryProductModel');
const inventoryVariantSchema = require('../../models/inventoryVariantModel');
const inventoryChangeLogSchema = require('../../models/inventoryChangeLogModel');
const fileSchema  = require('../../models/fileModel');
const userSchema  = require('../../models/userModel');
const groupSchema = require('../../models/groupModel');
const misInvoiceSchema = require('../../models/misInvoiceModel');
const misPackingListSchema = require('../../models/misPackingListModel');

const verify = require('../users/verifyToken');
const {
  requirePermission, requireBranch, requireBranchRead,
  assertBranchAccess, assertBranchReadAccess, getUserBranches,
  getEffectiveScopes, Group: RbacGroup, Branch,
} = require('../../utils/rbac');
const { loadCompanyProfile } = require('../../utils/loadCompanyProfile');
const { renderPdfBuffer } = require('../../utils/pdfRenderer');
const { sendPdf } = require('../../utils/sendPdf');
const { nextSequence, formatCode } = require('../../utils/sequence');
const { renderDealLetterHtml } = require('../../utils/dealLetterTemplate');
const { resolveBranchLogoDataUri } = require('../../utils/resolveBranchLogo');
const { recomputeRollup } = require('../../utils/inventoryRollup');
const { recomputeVariantSupplyRollup, recomputeProductSupplyRollup } = require('../../utils/supplyRollup');

ffmpeg.setFfmpegPath(ffmpegPath);

const SupplyRecord         = dbConnection.models.supplyRecord         || dbConnection.model('supplyRecord', supplyRecordSchema);
const SupplyDealLetter     = dbConnection.models.supplyDealLetter     || dbConnection.model('supplyDealLetter', supplyDealLetterSchema);
const SupplyDealLetterActivity = dbConnection.models.supplyDealLetterActivity || dbConnection.model('supplyDealLetterActivity', supplyDealLetterActivitySchema);
const InvProduct   = dbConnection.models.inventoryProduct   || dbConnection.model('inventoryProduct', inventoryProductSchema);
const InvVariant   = dbConnection.models.inventoryVariant   || dbConnection.model('inventoryVariant', inventoryVariantSchema);
const InvChangeLog = dbConnection.models.inventoryChangeLog || dbConnection.model('inventoryChangeLog', inventoryChangeLogSchema);
const File  = dbConnection.models.file  || dbConnection.model('file',  fileSchema);
const User  = dbConnection.models.user  || dbConnection.model('user',  userSchema);
const Group = dbConnection.models.group || dbConnection.model('group', groupSchema);
const MisInvoice = dbConnection.models.misInvoice || dbConnection.model('misInvoice', misInvoiceSchema);
const MisPackingList = dbConnection.models.misPackingList || dbConnection.model('misPackingList', misPackingListSchema);

const activityUpload = multer({ limits: uploadLimits, fileFilter: blockExecutableFiles, storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename:    (req, file, cb) => {
    const ext = file.originalname.match(/\..*$/)?.[0] || '';
    cb(null, `supply-dl-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
}) });

const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────────────

async function getActorName(userId) {
  const u = await User.findById(userId).select('firstName lastName').lean();
  return u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '';
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function scopeFilterFor(userId, module) {
  const effScopes = await getEffectiveScopes(userId);
  const scope = effScopes[module] || 'all';
  const uid = String(userId);
  const filter = {};
  if (scope === 'mine') {
    filter.createdBy = mongoose.Types.ObjectId(uid);
  } else if (scope === 'group') {
    const userGroups = await Group.find({ members: mongoose.Types.ObjectId(uid), deleteDate: null }).select('members').lean();
    const memberIds = [...new Set(userGroups.flatMap((g) => g.members.map(String)))].map((id) => mongoose.Types.ObjectId(id));
    filter.createdBy = memberIds.length ? { $in: memberIds } : mongoose.Types.ObjectId(uid);
  }
  return { scope, filter };
}

// Row-level scope for ONE record — the same rule the list applies (createdBy
// mine/group), so a 'mine'-scoped user can't open someone else's record by
// link either. Only for the user's OWN branch: a branch that merely shared
// its Supply is browsed in full (the grant is the decision there).
async function inSupplyScope(userId, record) {
  const effScopes = await getEffectiveScopes(userId);
  const scope = effScopes.supply || 'all';
  if (scope === 'all') return true;
  const uid = String(userId);
  if (String(record.createdBy) === uid) return true;
  if (scope === 'mine') return false;
  const groups = await Group.find({ members: mongoose.Types.ObjectId(uid), deleteDate: null }).select('members').lean();
  return groups.some((g) => (g.members || []).map(String).includes(String(record.createdBy)));
}

// SR-0001, SR-0002… — one system-wide sequence (see utils/sequence.js).
const nextSupplyRecordCode = async () => formatCode('SR', await nextSequence('supplyRecord'));

// Records created before codes existed get one at startup, oldest first.
// Idempotent: only records still without a code are touched, and the write
// re-checks that, so a second process can't double-assign.
const NO_CODE = { $or: [{ code: { $exists: false } }, { code: null }, { code: '' }] };
async function backfillSupplyRecordCodes() {
  const missing = await SupplyRecord.find(NO_CODE).sort({ insertDate: 1, _id: 1 }).select('_id').lean();
  for (const r of missing) {
    const code = await nextSupplyRecordCode();
    await SupplyRecord.updateOne({ _id: r._id, ...NO_CODE }, { $set: { code } });
  }
  if (missing.length) console.log(`Supply: assigned codes to ${missing.length} existing record(s)`);
}
backfillSupplyRecordCodes().catch((err) => console.error('Supply record code backfill failed:', err));

async function loadSupplyRecord(req, res, next) {
  try {
    const record = await SupplyRecord.findOne({ _id: req.params.id, deleteDate: null });
    if (!record) return res.status(404).json({ message: 'Supply record not found' });
    // Read access — own branch, or one that shared its Supply with us. The
    // mutating record routes re-check assertBranchAccess themselves.
    if (!(await assertBranchReadAccess(req.user.id, record.branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }
    if (await assertBranchAccess(req.user.id, record.branchId) && !(await inSupplyScope(req.user.id, record))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    req.supplyRecord = record;
    return next();
  } catch (err) {
    return next(err);
  }
}

async function loadDealLetter(req, res, next) {
  try {
    const dealLetter = await SupplyDealLetter.findOne({ _id: req.params.id, deleteDate: null });
    if (!dealLetter) return res.status(404).json({ message: 'Deal letter not found' });

    // A branch that SHARED its Supply can read its deal letters (that's how the
    // other branch decides what to request), but must never write to them.
    // Keyed off the HTTP method rather than a per-route flag, so a route added
    // later can't forget the write check: every mutation here is PUT/POST/DELETE.
    const isRead = req.method === 'GET';
    const owns = await assertBranchAccess(req.user.id, dealLetter.branchId);
    const allowed = owns || (isRead && await assertBranchReadAccess(req.user.id, dealLetter.branchId));
    if (!allowed) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }
    // Same row-level scope as its supply record (own branch only).
    if (owns) {
      const parent = await SupplyRecord.findById(dealLetter.supplyId).select('createdBy').lean();
      if (parent && !(await inSupplyScope(req.user.id, parent))) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    req.dealLetter = dealLetter;
    req.dealLetterReadOnly = !owns;
    return next();
  } catch (err) {
    return next(err);
  }
}

// Re-validates and snapshots a {variantId, forecastQty?, finalQty?} array
// against LIVE Inventory — a variant must exist, be active, belong to the
// deal letter's own productId, and its branch must match. Never trusts
// client-sent variantCode/unit. Silently drops anything that doesn't
// resolve, mirroring the DM resolveTaggedProducts() convention.
async function resolveVarietyLines(productId, rawLines) {
  if (!Array.isArray(rawLines) || !rawLines.length) return [];
  const variantIds = rawLines.map((l) => l.variantId).filter((id) => mongoose.Types.ObjectId.isValid(id));
  const variants = await InvVariant.find({
    _id: { $in: variantIds }, productId, deleteDate: null, status: 'active',
  }).lean();
  const variantMap = new Map(variants.map((v) => [String(v._id), v]));

  const resolved = [];
  for (const line of rawLines) {
    const v = variantMap.get(String(line.variantId));
    if (!v) continue;
    const numOrNull = (x, fallback = null) =>
      (x === undefined || x === null || x === '' ? fallback : Number(x));
    resolved.push({
      variantId: v._id,
      variantCode: v.code,
      unit: v.unit,
      forecastQty: Number(line.forecastQty) || 0,
      finalQty: numOrNull(line.finalQty),
      price: numOrNull(line.price),
      currency: line.currency || 'AED',
      receivedQty: 0,
      allocatedQty: 0,
      // Printed-contract columns. Dimensions default from the variant's parsed
      // stone code so the contract table fills itself, but a client-sent value
      // wins — a cut can differ from the nominal code (same reasoning as the
      // packing list's free-text item codes).
      stoneTypeLabel: (line.stoneTypeLabel && String(line.stoneTypeLabel).trim()) || v.code,
      count:    numOrNull(line.count),
      widthCm:  numOrNull(line.widthCm,  v.spec && v.spec.widthCm  ? v.spec.widthCm  : null),
      lengthCm: numOrNull(line.lengthCm, v.spec && v.spec.lengthCm ? v.spec.lengthCm : null),
    });
  }
  return resolved;
}

// Whitelists the printed-contract block. Only known keys survive, numbers are
// coerced, and strings are trimmed — the client never writes arbitrary paths
// into the document (same discipline as the MIS line-item snapshot).
function sanitizeContract(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
  const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  const b = raw.buyer || {};
  const s = raw.seller || {};
  return {
    number: str(raw.number),
    date: raw.date ? new Date(raw.date) : null,
    seller: { party: str(s.party), addressPhone: str(s.addressPhone) },
    buyer: {
      name: str(b.name), position: str(b.position),
      representedBy: str(b.representedBy), onBehalfOf: str(b.onBehalfOf),
      nationalId: str(b.nationalId), addressPhone: str(b.addressPhone),
    },
    currency: str(raw.currency) || 'IRR',
    totalInWords: str(raw.totalInWords),
    paymentTerms: str(raw.paymentTerms),
    guarantee: str(raw.guarantee),
    validityDays: numOrNull(raw.validityDays) ?? 3,
    settlementDays: numOrNull(raw.settlementDays),
    loadingDays: numOrNull(raw.loadingDays),
  };
}

async function touchSupplyRollups(variantIds, productId) {
  for (const variantId of variantIds) {
    await recomputeVariantSupplyRollup(variantId);
  }
  await recomputeProductSupplyRollup(productId);
}

// ─── product / variant lookups (for the New Supply / New Deal Letter forms) ───

router.get('/products-lookup', verify, requirePermission('supply:view'), requireBranchRead(), async (req, res) => {
  try {
    const { search = '' } = req.query;
    const filter = { branchId: req.branchId, deleteDate: null, status: 'active' };
    if (search.trim()) {
      const re = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [{ code: re }, { name: re }, { nameAr: re }, { quarryCode: re }];
    }
    const products = await InvProduct.find(filter).select('_id code name nameAr quarryCode stoneType').sort({ code: 1 }).limit(50).lean();
    res.json({ data: products });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/variants-lookup', verify, requirePermission('supply:view'), async (req, res) => {
  try {
    const { productId } = req.query;
    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ message: 'productId is required' });
    }
    const product = await InvProduct.findOne({ _id: productId, deleteDate: null }).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (!(await assertBranchAccess(req.user.id, product.branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }
    const variants = await InvVariant.find({ productId, deleteDate: null, status: 'active' })
      .select('_id code unit quantity supply spec.lengthCm spec.widthCm spec.thicknessMm spec.unsized').sort({ code: 1 }).lean();
    // `product` lets the deal letter form's specification builder name the record's product
    res.json({
      data: variants,
      product: { _id: product._id, code: product.code, name: product.name, defaultUnit: product.defaultUnit },
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── supply records ────────────────────────────────────────────────────────────

router.get('/records', verify, requirePermission('supply:view'), requireBranchRead(), async (req, res) => {
  try {
    const {
      search, productId, status = 'active', stage, createdBy, dateFrom, dateTo,
      sort = 'date', order = 'desc', limit = 50, skip = 0,
    } = req.query;

    // Row-level scope ('mine'/'group') answers "which of MY branch's records may
    // I see" — it keys off createdBy, so applying it to a branch that merely
    // SHARED its catalogue with us would filter everything away (none of those
    // records were created by this user). A shared branch is browsed in full;
    // the branch grant is itself the access decision there.
    const { scope, filter: scopeFilter } = req.branchReadOnly
      ? { scope: 'all', filter: {} }
      : await scopeFilterFor(req.user.id, 'supply');

    const filter = { branchId: req.branchId, deleteDate: null, ...scopeFilter };
    if (status && status !== 'all') filter.status = status;
    if (productId && mongoose.Types.ObjectId.isValid(productId)) filter.productId = productId;
    // "Created by" refines WITHIN the scope — a 'mine'-scoped user stays on
    // their own records whatever they pick.
    if (createdBy && mongoose.Types.ObjectId.isValid(createdBy) && !scopeFilter.createdBy) {
      filter.createdBy = mongoose.Types.ObjectId(createdBy);
    }
    if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) filter.date.$gte = new Date(dateFrom);
      if (dateTo) { const end = new Date(dateTo); end.setHours(23, 59, 59, 999); filter.date.$lte = end; }
    }
    // Where the record's lots stand: at least one deal letter in that stage,
    // or 'none' for a record with no deal letter yet.
    if (['purchasing', 'processing', 'final_product', 'none'].includes(stage)) {
      const withLetters = await SupplyDealLetter.distinct('supplyId', {
        branchId: req.branchId, deleteDate: null, ...(stage === 'none' ? {} : { status: stage }),
      });
      filter._id = stage === 'none' ? { $nin: withLetters } : { $in: withLetters };
    }
    if (search && search.trim()) {
      const re = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [{ code: re }, { title: re }, { productCode: re }, { productName: re }];
    }

    const sortDir = order === 'asc' ? 1 : -1;
    const [records, total] = await Promise.all([
      SupplyRecord.find(filter).sort({ [sort]: sortDir }).skip(Number(skip)).limit(Number(limit)).lean(),
      SupplyRecord.countDocuments(filter),
    ]);

    // Per-record deal-letter stage breakdown, so the list card can show where
    // each record actually stands instead of a bare count. One grouped query
    // for the whole page, not one per record.
    if (records.length) {
      const grouped = await SupplyDealLetter.aggregate([
        { $match: { supplyId: { $in: records.map((r) => r._id) }, deleteDate: null } },
        { $group: { _id: { supplyId: '$supplyId', status: '$status' }, n: { $sum: 1 } } },
      ]);
      const byRecord = {};
      for (const g of grouped) {
        const key = String(g._id.supplyId);
        (byRecord[key] || (byRecord[key] = {}))[g._id.status] = g.n;
      }
      for (const r of records) r.stageCounts = byRecord[String(r._id)] || {};
    }

    res.json({ data: records, total, scope });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Options for the records filter drawer: the products this branch has records
// for, and who created them (within the caller's scope).
router.get('/records/filter-options', verify, requirePermission('supply:view'), requireBranchRead(), async (req, res) => {
  try {
    const { filter: scopeFilter } = req.branchReadOnly ? { filter: {} } : await scopeFilterFor(req.user.id, 'supply');
    const base = { branchId: req.branchId, deleteDate: null, ...scopeFilter };
    const [productIds, creatorIds] = await Promise.all([
      SupplyRecord.distinct('productId', base),
      SupplyRecord.distinct('createdBy', base),
    ]);
    const [products, users] = await Promise.all([
      InvProduct.find({ _id: { $in: productIds } }).select('_id code name').sort('code').lean(),
      User.find({ _id: { $in: creatorIds.filter(Boolean) } }).select('_id firstName lastName').lean(),
    ]);
    res.json({ data: {
      products,
      creators: users.map((u) => ({ _id: u._id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || '—' })),
    } });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/records/:id', verify, requirePermission('supply:view'), loadSupplyRecord, async (req, res) => {
  try {
    const dealLetters = await SupplyDealLetter.find({ supplyId: req.supplyRecord._id, deleteDate: null })
      .sort({ insertDate: -1 }).lean();
    res.json({ data: { ...req.supplyRecord.toObject(), dealLetters } });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/records', verify, requirePermission('supply:record:create'), requireBranch(), async (req, res) => {
  try {
    const { productId, title, date, notes } = req.body;
    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ message: 'productId is required' });
    }
    if (!title || !title.trim()) return res.status(400).json({ message: 'Title is required' });

    const product = await InvProduct.findOne({ _id: productId, branchId: req.branchId, deleteDate: null }).lean();
    if (!product) return res.status(404).json({ message: 'Product not found in this branch' });

    const record = await SupplyRecord.create({
      code: await nextSupplyRecordCode(),
      branchId: req.branchId,
      productId: product._id,
      productCode: product.code,
      productName: product.name,
      title: title.trim(),
      date: date ? new Date(date) : new Date(),
      notes: notes || '',
      createdBy: req.user.id,
    });
    res.status(201).json({ data: record });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/records/:id', verify, requirePermission('supply:record:edit'), loadSupplyRecord, async (req, res) => {
  try {
    // loadSupplyRecord allows READ access from a branch this one shared with —
    // editing still requires actually holding the branch.
    if (!(await assertBranchAccess(req.user.id, req.supplyRecord.branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }
    const { title, date, notes, status } = req.body;
    const updates = { updateDate: new Date(), updatedBy: req.user.id };
    if (title !== undefined && title.trim()) updates.title = title.trim();
    if (date !== undefined) updates.date = new Date(date);
    if (notes !== undefined) updates.notes = notes;
    if (status !== undefined && ['active', 'archived'].includes(status)) updates.status = status;

    const record = await SupplyRecord.findByIdAndUpdate(req.supplyRecord._id, { $set: updates }, { new: true });
    res.json({ data: record });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/records/:id', verify, requirePermission('supply:record:delete'), loadSupplyRecord, async (req, res) => {
  try {
    // Read access is not delete access — see the PUT above.
    if (!(await assertBranchAccess(req.user.id, req.supplyRecord.branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }
    if (req.supplyRecord.dealLetterCount > 0) {
      return res.status(409).json({ message: 'This supply record still has deal letters — delete or move them first' });
    }
    await SupplyRecord.findByIdAndUpdate(req.supplyRecord._id, { $set: { deleteDate: new Date() } });
    res.json({ message: 'Supply record deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── deal letters ───────────────────────────────────────────────────────────────

router.get('/deal-letters', verify, requirePermission('supply:view'), async (req, res) => {
  try {
    const { supplyId } = req.query;
    if (!supplyId || !mongoose.Types.ObjectId.isValid(supplyId)) {
      return res.status(400).json({ message: 'supplyId is required' });
    }
    const record = await SupplyRecord.findOne({ _id: supplyId, deleteDate: null }).lean();
    if (!record) return res.status(404).json({ message: 'Supply record not found' });
    // Read access — a shared branch needs to see the deal letters to know what
    // is actually available to request against.
    if (!(await assertBranchReadAccess(req.user.id, record.branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }
    const dealLetters = await SupplyDealLetter.find({ supplyId, deleteDate: null }).sort({ insertDate: -1 }).lean();
    res.json({ data: dealLetters });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/deal-letters/:id', verify, requirePermission('supply:view'), loadDealLetter, async (req, res) => {
  res.json({ data: req.dealLetter });
});

router.post('/deal-letters', verify, requirePermission('supply:dealLetter:create'), async (req, res) => {
  try {
    const { supplyId, coupeSpec, coupeSeller, varietyLines, contract } = req.body;
    if (!supplyId || !mongoose.Types.ObjectId.isValid(supplyId)) {
      return res.status(400).json({ message: 'supplyId is required' });
    }
    if (!coupeSeller || !coupeSeller.name || !coupeSeller.name.trim()) {
      return res.status(400).json({ message: 'Coupe seller name is required' });
    }

    const record = await SupplyRecord.findOne({ _id: supplyId, deleteDate: null });
    if (!record) return res.status(404).json({ message: 'Supply record not found' });
    if (!(await assertBranchAccess(req.user.id, record.branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }

    const resolvedLines = await resolveVarietyLines(record.productId, varietyLines);

    const dealLetter = await SupplyDealLetter.create({
      supplyId: record._id,
      branchId: record.branchId,
      productId: record.productId,
      coupeSpec: coupeSpec || '',
      coupeSeller: {
        customerId: coupeSeller.customerId && mongoose.Types.ObjectId.isValid(coupeSeller.customerId) ? coupeSeller.customerId : null,
        name: coupeSeller.name.trim(),
        phone: coupeSeller.phone || '',
        notes: coupeSeller.notes || '',
      },
      varietyLines: resolvedLines,
      contract: sanitizeContract(contract),
      createdBy: req.user.id,
    });

    await SupplyRecord.findByIdAndUpdate(record._id, { $inc: { dealLetterCount: 1 } });

    const actorName = await getActorName(req.user.id);
    await SupplyDealLetterActivity.create({
      dealLetterId: dealLetter._id, stage: dealLetter.status, type: 'created',
      body: 'Deal letter created', actorId: req.user.id, actorName, date: new Date(),
    });

    if (resolvedLines.length) {
      await touchSupplyRollups(resolvedLines.map((l) => l.variantId), record.productId);
    }

    res.status(201).json({ data: dealLetter });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/deal-letters/:id', verify, requirePermission('supply:dealLetter:edit'), loadDealLetter, async (req, res) => {
  try {
    const { coupeSpec, coupeSeller, varietyLines, contract } = req.body;
    const updates = { updateDate: new Date(), updatedBy: req.user.id };
    if (coupeSpec !== undefined) updates.coupeSpec = coupeSpec;
    if (contract !== undefined) updates.contract = sanitizeContract(contract);
    if (coupeSeller !== undefined && coupeSeller.name && coupeSeller.name.trim()) {
      updates.coupeSeller = {
        customerId: coupeSeller.customerId && mongoose.Types.ObjectId.isValid(coupeSeller.customerId) ? coupeSeller.customerId : null,
        name: coupeSeller.name.trim(),
        phone: coupeSeller.phone || '',
        notes: coupeSeller.notes || '',
      };
    }

    let touchedVariantIds = [];
    if (Array.isArray(varietyLines)) {
      // Preserve price/receivedQty already on file for lines that already
      // existed — this route only ever touches forecast/final quantity, never
      // price (that's pricing's own endpoint) or receivedQty (only `receive` writes it).
      const existingByVariant = new Map(req.dealLetter.varietyLines.map((l) => [String(l.variantId), l]));
      const resolved = await resolveVarietyLines(req.dealLetter.productId, varietyLines);
      // A variety promised to accepted documents can't be dropped from the lot.
      const kept = new Set(resolved.map((l) => String(l.variantId)));
      const promised = req.dealLetter.varietyLines.filter((l) => (l.allocatedQty || 0) > 0 && !kept.has(String(l.variantId)));
      if (promised.length) {
        return res.status(409).json({
          message: `${promised.map((l) => l.variantCode).join(', ')} is promised to accepted quotations or requests and can't be removed from this deal letter`,
        });
      }
      updates.varietyLines = resolved.map((line) => {
        const existing = existingByVariant.get(String(line.variantId));
        return existing
          ? { ...line, price: existing.price, currency: existing.currency, receivedQty: existing.receivedQty,
              allocatedQty: existing.allocatedQty || 0 }
          : line;
      });
      touchedVariantIds = updates.varietyLines.map((l) => l.variantId);
    }

    const dealLetter = await SupplyDealLetter.findByIdAndUpdate(req.dealLetter._id, { $set: updates }, { new: true });

    if (touchedVariantIds.length) {
      const actorName = await getActorName(req.user.id);
      await SupplyDealLetterActivity.create({
        dealLetterId: dealLetter._id, stage: dealLetter.status, type: 'forecast_updated',
        body: 'Variety lines updated', actorId: req.user.id, actorName, date: new Date(),
      });
      await touchSupplyRollups(touchedVariantIds, dealLetter.productId);
    }

    res.json({ data: dealLetter });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/deal-letters/:id/status', verify, requirePermission('supply:dealLetter:edit'), loadDealLetter, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['purchasing', 'processing', 'final_product'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${validStatuses.join(', ')}` });
    }
    if (status === 'final_product') {
      const missing = req.dealLetter.varietyLines.some((l) => l.finalQty === null || l.finalQty === undefined);
      if (missing || !req.dealLetter.varietyLines.length) {
        return res.status(400).json({ message: 'Every variety line needs a final quantity before moving to Final product' });
      }
    }

    const oldStatus = req.dealLetter.status;
    const dealLetter = await SupplyDealLetter.findByIdAndUpdate(
      req.dealLetter._id,
      { $set: { status, updateDate: new Date(), updatedBy: req.user.id } },
      { new: true }
    );

    const actorName = await getActorName(req.user.id);
    await SupplyDealLetterActivity.create({
      dealLetterId: dealLetter._id, stage: status, type: 'status_changed',
      field: 'status', oldValue: oldStatus, newValue: status,
      actorId: req.user.id, actorName, date: new Date(),
    });

    const variantIds = dealLetter.varietyLines.map((l) => l.variantId);
    if (variantIds.length) await touchSupplyRollups(variantIds, dealLetter.productId);

    res.json({ data: dealLetter });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/deal-letters/:id/pricing', verify, requirePermission('supply:dealLetter:price:edit'), loadDealLetter, async (req, res) => {
  try {
    const { lines } = req.body;
    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ message: 'lines is required' });
    }
    const priceByVariant = new Map(lines.map((l) => [String(l.variantId), l.price]));
    const updatedLines = req.dealLetter.varietyLines.map((line) => {
      if (!priceByVariant.has(String(line.variantId))) return line;
      const price = priceByVariant.get(String(line.variantId));
      return { ...line.toObject(), price: price === null || price === '' ? null : Number(price) };
    });

    const dealLetter = await SupplyDealLetter.findByIdAndUpdate(
      req.dealLetter._id,
      { $set: { varietyLines: updatedLines, updateDate: new Date(), updatedBy: req.user.id } },
      { new: true }
    );

    const actorName = await getActorName(req.user.id);
    await SupplyDealLetterActivity.create({
      dealLetterId: dealLetter._id, stage: dealLetter.status, type: 'price_updated',
      body: 'Per-variety pricing updated', actorId: req.user.id, actorName, date: new Date(),
    });

    res.json({ data: dealLetter });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Moves confirmed final-product quantity into REAL, sellable InvVariant.quantity —
// the ONLY path from Supply into real stock. Requires inventory:quantity:edit
// in addition to supply:dealLetter:receive, same "extra permission to touch
// real stock" pattern as MIS's issueStockDecrement.
router.post('/deal-letters/:id/receive',
  verify, requirePermission('supply:dealLetter:receive'), requirePermission('inventory:quantity:edit'),
  loadDealLetter, async (req, res) => {
  try {
    if (req.dealLetter.status !== 'final_product') {
      return res.status(400).json({ message: 'Only a deal letter in Final product status can be received' });
    }
    const { lines } = req.body;
    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ message: 'lines is required' });
    }

    const dealLetter = req.dealLetter;
    const actorName = await getActorName(req.user.id);
    const updatedLines = dealLetter.varietyLines.map((l) => l.toObject());

    // Validate EVERY requested line before writing anything — this app has no
    // multi-document Mongo transactions anywhere, so a mid-loop 400 after some
    // variants were already incremented would leave a partially-applied
    // receive. Resolve + bounds-check the whole batch first, only then write.
    const plan = [];
    for (const reqLine of lines) {
      const idx = updatedLines.findIndex((l) => String(l.variantId) === String(reqLine.variantId));
      if (idx === -1) continue;
      const qty = Number(reqLine.quantity);
      if (!qty || qty <= 0) continue;
      // Stone promised to accepted quotations / requests stays out of
      // sellable stock — it's already spoken for.
      const remaining = (updatedLines[idx].finalQty || 0) - (updatedLines[idx].receivedQty || 0)
        - (updatedLines[idx].allocatedQty || 0);
      if (qty > remaining) {
        return res.status(400).json({ message: `Cannot receive ${qty} — only ${Math.max(0, remaining)} of ${updatedLines[idx].variantCode} is unreceived and not promised to accepted documents` });
      }
      plan.push({ idx, qty });
    }

    const touchedVariantIds = [];
    for (const { idx, qty } of plan) {
      const variant = await InvVariant.findById(updatedLines[idx].variantId);
      if (!variant) continue;

      const oldQty = variant.quantity || 0;
      const newQty = oldQty + qty;
      variant.quantity = newQty;
      await variant.save();

      await InvChangeLog.create({
        subjectType: 'variant', subjectId: variant._id, productId: variant.productId,
        changeType: 'quantity', field: 'quantity',
        oldValue: oldQty, newValue: newQty, delta: qty, unit: variant.unit,
        reason: `Received from Supply deal letter (${dealLetter._id})`,
        source: 'supply', changedBy: req.user.id, changedByName: actorName,
      });

      updatedLines[idx].receivedQty = (updatedLines[idx].receivedQty || 0) + qty;
      touchedVariantIds.push(variant._id);
    }

    await SupplyDealLetter.findByIdAndUpdate(dealLetter._id, {
      $set: { varietyLines: updatedLines, updateDate: new Date(), updatedBy: req.user.id },
    });

    await SupplyDealLetterActivity.create({
      dealLetterId: dealLetter._id, stage: dealLetter.status, type: 'received',
      body: `Received ${touchedVariantIds.length} variety line(s) into warehouse`,
      actorId: req.user.id, actorName, date: new Date(),
    });

    if (touchedVariantIds.length) {
      await recomputeRollup(dealLetter.productId);   // real stock rollup
      await touchSupplyRollups(touchedVariantIds, dealLetter.productId);   // supply rollup
    }

    const fresh = await SupplyDealLetter.findById(dealLetter._id).lean();
    res.json({ data: fresh });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/deal-letters/:id', verify, requirePermission('supply:dealLetter:delete'), loadDealLetter, async (req, res) => {
  try {
    if (req.dealLetter.varietyLines.some((l) => (l.allocatedQty || 0) > 0)) {
      return res.status(409).json({ message: 'This lot is promised to accepted quotations or requests — release them before deleting it' });
    }
    await SupplyDealLetter.findByIdAndUpdate(req.dealLetter._id, { $set: { deleteDate: new Date() } });
    await SupplyRecord.findByIdAndUpdate(req.dealLetter.supplyId, { $inc: { dealLetterCount: -1 } });

    const variantIds = req.dealLetter.varietyLines.map((l) => l.variantId);
    if (variantIds.length) await touchSupplyRollups(variantIds, req.dealLetter.productId);

    res.json({ message: 'Deal letter deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── deal letter activity / follow-ups ──────────────────────────────────────────

router.get('/deal-letters/:id/activity', verify, requirePermission('supply:view'), loadDealLetter, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const lim = Math.min(Number(limit) || 30, 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [activities, total] = await Promise.all([
      SupplyDealLetterActivity.find({ dealLetterId: req.dealLetter._id }).sort({ date: -1 }).skip(skip).limit(lim).lean(),
      SupplyDealLetterActivity.countDocuments({ dealLetterId: req.dealLetter._id }),
    ]);
    res.json({ data: activities, total, page: Number(page) || 1, limit: lim });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/deal-letters/:id/activity',
  verify, requirePermission('supply:dealLetter:followUp:create'), loadDealLetter,
  activityUpload.array('files', MAX_BATCH_FILES), async (req, res) => {
  try {
    const { body = '' } = req.body;
    const actorName = await getActorName(req.user.id);
    const now = new Date();

    const activity = await SupplyDealLetterActivity.create({
      dealLetterId: req.dealLetter._id, stage: req.dealLetter.status, type: 'note',
      body, actorId: req.user.id, actorName, date: now, createdAt: now,
    });

    const files = req.files || [];
    if (files.length) {
      const media = [];
      for (const file of files) {
        const mime = file.mimetype || '';
        const kind = mime.startsWith('audio/') ? 'audio' : isVideoUpload(file) ? 'video' : 'image';

        let thumbnail = null;
        if (kind === 'image') {
          try {
            const thumbFilename = `thumb-${file.filename}`;
            await sharp(file.path).resize(300).jpeg({ quality: 80 }).toFile(`public/uploads/${thumbFilename}`);
            thumbnail = thumbFilename;
          } catch (_) { /* non-fatal */ }
        } else if (kind === 'video') {
          thumbnail = await extractVideoThumbnail(file.path, `thumb-${file.filename}.png`);
        }

        const fileDoc = await File.create({
          name: file.originalname.split('.')[0],
          supFolder: null,
          metaData: file,
          format: file.originalname.slice(file.originalname.lastIndexOf('.') + 1),
          generatedBy: req.user.id,
          thumbnail,
          scope: 'supply',
          attachedTo: { type: 'supplyDealLetterActivity', id: activity._id },
        });

        if (kind === 'video') transcodeVideoAsync(File, fileDoc, file.path);

        media.push({ fileId: fileDoc._id, kind, diskName: file.filename, name: file.originalname, thumbnail });
      }
      activity.media = media;
      await activity.save();
    }

    res.status(201).json(activity);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── reverse lookup for Inventory's product detail panel ───────────────────────

// Product-scoped (not variant-scoped) — a supply record/deal letter is always
// for exactly one PRODUCT (quarry-level code), so this is what showProduct.js's
// new Supply section embeds. A variant's own forecast/final numbers are
// already denormalized onto InvVariant.supply.{forecastQty,finalQty} (see
// utils/supplyRollup.js) and shown inline in variantsTable.js/variantDetail.js
// without needing a separate lookup call.
router.get('/by-product/:productId', verify, requirePermission('supply:view'), async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(productId)) return res.status(400).json({ message: 'Invalid productId' });

    const product = await InvProduct.findOne({ _id: productId, deleteDate: null }).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (!(await assertBranchAccess(req.user.id, product.branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }

    // Only lots of records the caller may see (Supply row scope), each tagged
    // with its record's code so the panel can name it.
    const { filter: scopeFilter } = await scopeFilterFor(req.user.id, 'supply');
    const records = await SupplyRecord.find({ productId: product._id, deleteDate: null, ...scopeFilter })
      .select('_id code').lean();
    const codeOf = new Map(records.map((r) => [String(r._id), r.code]));
    const dealLetters = await SupplyDealLetter.find({
      deleteDate: null, productId: product._id, supplyId: { $in: records.map((r) => r._id) },
    }).sort({ insertDate: -1 }).limit(50).lean();

    res.json({ data: dealLetters.map((dl) => ({ ...dl, recordCode: codeOf.get(String(dl.supplyId)) || null })) });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── printed contract (قرارداد فروش سنگ) ─────────────────────────────────────
// Same two-consumer contract as the invoice and packing-list documents: /html
// backs the on-screen preview, /pdf renders the identical markup via puppeteer.
// A deal letter's own branch owns the template choice, falling back to 'classic'.

async function buildDealLetterHtml(dealLetter) {
  const [record, branch, baseProfile] = await Promise.all([
    SupplyRecord.findOne({ _id: dealLetter.supplyId }).lean(),
    Branch.findOne({ _id: dealLetter.branchId }).lean(),
    loadCompanyProfile(dealLetter.branchId),
  ]);
  // Per-branch logo, same resolution as the packing list / label documents:
  // the branch's uploaded logo when set, the static LMC mark otherwise.
  const logoDataUri = await resolveBranchLogoDataUri(baseProfile && baseProfile.logoFileId);
  const profile = { ...(baseProfile || {}), logoDataUri };
  const variant = (branch && branch.misTemplates && branch.misTemplates.dealLetter) || 'classic';
  return renderDealLetterHtml(dealLetter.toObject ? dealLetter.toObject() : dealLetter,
    record, branch, profile, variant);
}

router.get('/deal-letters/:id/html', verify, requirePermission('supply:view'), loadDealLetter, async (req, res) => {
  try {
    const html = await buildDealLetterHtml(req.dealLetter);
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    console.error('GET /supply/deal-letters/:id/html failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/deal-letters/:id/pdf', verify, requirePermission('supply:view'), loadDealLetter, async (req, res) => {
  try {
    const html = await buildDealLetterHtml(req.dealLetter);
    // Puppeteer (v22+) returns a Uint8Array, NOT a Buffer. Express's res.send()
    // only treats a real Buffer as binary — anything else is JSON-serialized —
    // so sending it directly delivered a file of {"0":37,"1":80,...} with a
    // .pdf extension, which downloaded fine and then wouldn't open. Wrap it and
    // write raw bytes with end(), the same as every other PDF route here.
    const pdf = await renderPdfBuffer(html);
    // sendPdf normalizes the Uint8Array, makes the filename header-safe (a
    // contract number may be typed in Persian digits) and — when the app asks
    // for it — sends JSON instead of a raw download, which is what keeps
    // download managers like IDM from swallowing it. See utils/sendPdf.js.
    const number = (req.dealLetter.contract && req.dealLetter.contract.number) || String(req.dealLetter._id).slice(-6);
    return sendPdf(req, res, pdf, `contract-${number}.pdf`);
  } catch (err) {
    console.error('GET /supply/deal-letters/:id/pdf failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Reverse lookup — the invoices/quotations raised against this supply record.
// Mirrors GET /crm/customers/:id/requests and /inventory/products/:id/invoices:
// read-only, snapshot fields only, no recompute.
router.get('/records/:id/invoices', verify, requirePermission('supply:view'), loadSupplyRecord, async (req, res) => {
  try {
    const { docType } = req.query;
    const filter = { supplyRecordId: req.supplyRecord._id, deleteDate: null };
    if (docType === 'invoice' || docType === 'pre_invoice') filter.docType = docType;
    // A branch that merely SHARED its Supply opens the record to us, not its
    // paperwork: someone viewing it from another branch sees only the requests
    // their own branches raised against it — never the owner's customer
    // invoices and quotations.
    if (!(await assertBranchAccess(req.user.id, req.supplyRecord.branchId))) {
      const mine = (await getUserBranches(req.user.id)).map((id) => new mongoose.Types.ObjectId(String(id)));
      filter.tradeMode = 'interBranch';
      filter.requestingBranchId = { $in: mine };
    }

    const docs = await MisInvoice.find(filter)
      .select('docType docNumber status issueDate grandTotal currency customerSnapshot tradeMode requestingBranchSnapshot')
      .sort({ issueDate: -1 })
      .limit(100)
      .lean();

    res.json({ data: docs });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Everything raised against this supply record, for its Documents section:
// quotations, invoices, requests (inter-branch quotations) and packing lists —
// the ones created from the record plus any packing list of its invoices.
// Someone viewing from a branch this one merely SHARED its Supply with sees
// only the requests their own branches sent; the owner's quotations,
// invoices and packing lists stay the owner's.
router.get('/records/:id/documents', verify, requirePermission('supply:view'), loadSupplyRecord, async (req, res) => {
  try {
    const rec = req.supplyRecord;
    const owns = await assertBranchAccess(req.user.id, rec.branchId);
    const docFilter = { supplyRecordId: rec._id, deleteDate: null };
    if (owns) {
      // The record's owner sees its documents through their Invoices scope —
      // created by me (or my groups), sent to me, or a request addressed to
      // this branch (same rule as the MIS list).
      const { scope: misScope, filter: misScopeFilter } = await scopeFilterFor(req.user.id, 'mis');
      if (misScope !== 'all') {
        docFilter.$or = [
          misScopeFilter,
          { assignedTo: mongoose.Types.ObjectId(String(req.user.id)) },
          { tradeMode: 'interBranch', branchId: rec.branchId },
        ];
      }
    }
    if (!owns) {
      const mine = (await getUserBranches(req.user.id)).map((id) => new mongoose.Types.ObjectId(String(id)));
      docFilter.tradeMode = 'interBranch';
      docFilter.requestingBranchId = { $in: mine };
    }
    const documents = await MisInvoice.find(docFilter)
      .select('docType docNumber status issueDate grandTotal currency customerSnapshot tradeMode branchId requestingBranchId requestingBranchSnapshot')
      .sort({ issueDate: -1 })
      .limit(100)
      .lean();

    let packingLists = [];
    if (owns) {
      const invoiceIds = documents.filter((d) => d.docType === 'invoice').map((d) => d._id);
      // same "Packing lists" row scope as MIS's own packing list section
      const { filter: plScope } = await scopeFilterFor(req.user.id, 'packingList');
      packingLists = await MisPackingList.find({
        deleteDate: null,
        ...plScope,
        $or: [{ supplyRecordId: rec._id }, ...(invoiceIds.length ? [{ invoiceIds: { $in: invoiceIds } }] : [])],
      })
        .select('docNumber type status totals insertDate invoiceIds supplyRecordId')
        .sort({ insertDate: -1 })
        .limit(100)
        .lean();
    }
    return res.json({ data: { documents, packingLists, owns } });
  } catch (err) {
    console.error('GET /supply/records/:id/documents failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
