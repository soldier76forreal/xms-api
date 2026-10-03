const express  = require('express');
const mongoose = require('mongoose');

const dbConnection = require('../../connections/xmsPr');
const misPackingListSchema         = require('../../models/misPackingListModel');
const misPackingListActivitySchema = require('../../models/misPackingListActivityModel');
const misInvoiceSchema        = require('../../models/misInvoiceModel');
const supplyRecordSchema      = require('../../models/supplyRecordModel');
const invoiceCounterSchema    = require('../../models/invoiceCounterModel');
const userSchema              = require('../../models/userModel');

const verify = require('../users/verifyToken');
const { requirePermission, requireBranch, assertBranchAccess, getEffectiveScopes, Group, Branch } = require('../../utils/rbac');
const { loadCompanyProfile } = require('../../utils/loadCompanyProfile');
const { resolveBranchLogoDataUri } = require('../../utils/resolveBranchLogo');
const { renderPdfBuffer } = require('../../utils/pdfRenderer');
const { sendPdf } = require('../../utils/sendPdf');
const { renderPackingListHtml, renderPalletLabelHtml, labelPageSize, LABEL_KINDS } = require('../../utils/packingListTemplate');

// ?kind= picks the label: 'slab' (the per-pallet slab label, default) or
// 'short' (the short-pallet strip label). Anything else falls back to slab.
const labelKind = (req) => (LABEL_KINDS.includes(req.query.kind) ? req.query.kind : 'slab');

const MisPackingList         = dbConnection.models.misPackingList         || dbConnection.model('misPackingList', misPackingListSchema);
const MisPackingListActivity = dbConnection.models.misPackingListActivity || dbConnection.model('misPackingListActivity', misPackingListActivitySchema);
const MisInvoice     = dbConnection.models.misInvoice     || dbConnection.model('misInvoice', misInvoiceSchema);
const SupplyRecord   = dbConnection.models.supplyRecord   || dbConnection.model('supplyRecord', supplyRecordSchema);

// A client-sent supply record id is only kept when that record exists and
// belongs to the packing list's own branch — same rule as an invoice's link.
async function resolveSupplyRecordId(rawId, branchId) {
  if (!rawId || !mongoose.Types.ObjectId.isValid(rawId)) return null;
  const rec = await SupplyRecord.findOne({ _id: rawId, deleteDate: null }).select('branchId').lean();
  if (!rec || String(rec.branchId) !== String(branchId)) return null;
  return rec._id;
}
const InvoiceCounter = dbConnection.models.invoiceCounter || dbConnection.model('invoiceCounter', invoiceCounterSchema);
const User = dbConnection.models.user || dbConnection.model('user', userSchema);

const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getActorName(userId) {
  const u = await User.findById(userId).select('firstName lastName').lean();
  return u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '';
}

async function logActivity(packingListId, type, fields, actorId, actorName) {
  try {
    await MisPackingListActivity.create({
      packingListId, type, ...fields, actorId, actorName, date: new Date(), createdAt: new Date(),
    });
  } catch (_) {}
}

function computeTotals(pallets) {
  let totalSqm = 0, totalPcs = 0;
  for (const p of (pallets || [])) {
    for (const it of (p.items || [])) {
      totalSqm += Number(it.sqm) || 0;
      totalPcs += Number(it.pcs) || 0;
    }
  }
  return {
    totalPallets: (pallets || []).length,
    totalSqm: Math.round(totalSqm * 100) / 100,
    totalPcs,
  };
}

// A packing item's code is a nominal PRODUCT code (e.g. "TR09"), not
// necessarily a full variant SKU — the physical cut it describes doesn't map
// 1:1 onto an Inventory variant (same precedent as the legacy embedded
// packingRowSchema). Scope validation is therefore a product-code-prefix
// match, not a foreign-key constraint.
function productPrefix(code) {
  if (!code) return '';
  const m = String(code).toUpperCase().match(/^([A-Z]{2}\d{2})/);
  return m ? m[1] : String(code).toUpperCase();
}

// Returns an array of out-of-scope item codes (empty = valid). Only meaningful
// for type:'linked' — a 'free' packing list has no scope to violate.
async function findOutOfScopeCodes(invoiceIds, pallets) {
  const invoices = await MisInvoice.find({ _id: { $in: invoiceIds }, deleteDate: null }).select('lineItems.code').lean();
  const allowed = new Set();
  for (const inv of invoices) {
    for (const li of (inv.lineItems || [])) {
      if (li.code) allowed.add(productPrefix(li.code));
    }
  }
  const bad = [];
  for (const p of (pallets || [])) {
    for (const it of (p.items || [])) {
      if (it.code && !allowed.has(productPrefix(it.code))) bad.push(it.code);
    }
  }
  return [...new Set(bad)];
}

function resolveTemplateVariant(branch, key) {
  return (branch && branch.misTemplates && branch.misTemplates[key]) || 'classic';
}

// Row-level scope for packing lists — its own "Packing lists" setting on the
// role (mine / group / all), keyed off who created the list, same mechanism
// as CRM / Invoices / Inventory. Resolved server-side, never from the client.
async function packingListScope(userId) {
  const effScopes = await getEffectiveScopes(userId);
  const scope = effScopes.packingList || 'all';
  if (scope === 'all') return { scope, filter: {} };
  const uid = new mongoose.Types.ObjectId(String(userId));
  if (scope === 'mine') return { scope, filter: { createdBy: uid } };
  const groups = await Group.find({ members: uid, deleteDate: null }).select('members').lean();
  const memberIds = [...new Set(groups.flatMap((g) => (g.members || []).map(String)))]
    .map((id) => new mongoose.Types.ObjectId(id));
  return { scope, filter: { createdBy: memberIds.length ? { $in: memberIds } : uid } };
}

async function inPackingListScope(userId, doc) {
  const { scope, filter } = await packingListScope(userId);
  if (scope === 'all') return true;
  const allowed = filter.createdBy.$in ? filter.createdBy.$in.map(String) : [String(filter.createdBy)];
  return allowed.includes(String(doc.createdBy));
}

async function loadPackingList(req, res, next) {
  try {
    const doc = await MisPackingList.findOne({ _id: req.params.id, deleteDate: null });
    if (!doc) return res.status(404).json({ message: 'Packing list not found' });
    if (!(await assertBranchAccess(req.user.id, doc.branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }
    if (!(await inPackingListScope(req.user.id, doc))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    req.packingList = doc;
    return next();
  } catch (err) {
    return res.status(400).json({ message: 'Invalid ID' });
  }
}

// ── list / detail ────────────────────────────────────────────────────────────

router.get('/packing-lists', verify, requirePermission('mis:view'), requireBranch(), async (req, res) => {
  try {
    const { type, invoiceId, status, search, limit = 30, skip = 0 } = req.query;
    const { filter: scopeFilter } = await packingListScope(req.user.id);
    const filter = { branchId: req.branchId, deleteDate: null, ...scopeFilter };
    if (type === 'linked' || type === 'free') filter.type = type;
    if (status) filter.status = status;
    if (invoiceId && mongoose.Types.ObjectId.isValid(invoiceId)) filter.invoiceIds = invoiceId;
    if (req.query.supplyRecordId && mongoose.Types.ObjectId.isValid(req.query.supplyRecordId)) {
      filter.supplyRecordId = req.query.supplyRecordId;
    }
    if (search && search.trim()) {
      const term = search.trim();
      const re = new RegExp(escapeRegex(term), 'i');
      const or = [
        { 'driverInfo.fullName': re },
        { 'pallets.palletId': re },
        { 'pallets.reference': re },
        { 'pallets.items.code': re },
        { shippingDestination: re },
        { destinationAddress: re },
      ];
      // Searching by document number is the most obvious thing to try, so a
      // bare number also matches docNumber exactly (a regex can't, it's a Number).
      const asNumber = Number(term.replace(/^#/, ''));
      if (Number.isFinite(asNumber)) or.push({ docNumber: asNumber });
      filter.$or = or;
    }
    const [data, total] = await Promise.all([
      MisPackingList.find(filter).sort({ insertDate: -1 }).skip(Number(skip)).limit(Number(limit)).lean(),
      MisPackingList.countDocuments(filter),
    ]);
    return res.status(200).json({ data, total });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/packing-lists/:id', verify, requirePermission('mis:view'), loadPackingList, async (req, res) => {
  try {
    const activity = await MisPackingListActivity.find({ packingListId: req.packingList._id })
      .sort({ date: -1 }).limit(50).lean();
    return res.status(200).json({ ...req.packingList.toObject(), activity });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── create / edit / delete ───────────────────────────────────────────────────

router.post('/packing-lists', verify, requirePermission('mis:packingList:create'), requireBranch(), async (req, res) => {
  try {
    const userId = req.user.id;
    const { type, invoiceIds = [], pallets = [] } = req.body;
    if (type !== 'linked' && type !== 'free') {
      return res.status(400).json({ message: "type must be 'linked' or 'free'" });
    }

    let validInvoiceIds = [];
    if (type === 'linked') {
      if (!Array.isArray(invoiceIds) || !invoiceIds.length) {
        return res.status(400).json({ message: 'A linked packing list needs at least one invoice' });
      }
      const invoices = await MisInvoice.find({
        _id: { $in: invoiceIds }, branchId: req.branchId, deleteDate: null,
      }).select('_id').lean();
      validInvoiceIds = invoices.map((i) => i._id);
      if (!validInvoiceIds.length) {
        return res.status(400).json({ message: 'None of the given invoices belong to this branch' });
      }
      const outOfScope = await findOutOfScopeCodes(validInvoiceIds, pallets);
      if (outOfScope.length) {
        return res.status(400).json({ message: `These codes are outside the linked invoices' scope: ${outOfScope.join(', ')}` });
      }
    }

    const counter = await InvoiceCounter.findOneAndUpdate(
      { branchId: req.branchId, docType: 'packing_list' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const doc = await MisPackingList.create({
      branchId: req.branchId,
      docNumber: counter.seq,
      type,
      invoiceIds: type === 'linked' ? validInvoiceIds : [],
      productId: req.body.productId && mongoose.Types.ObjectId.isValid(req.body.productId) ? req.body.productId : null,
      supplyRecordId: await resolveSupplyRecordId(req.body.supplyRecordId, req.branchId),
      driverInfo: req.body.driverInfo || {},
      vehicleInfo: req.body.vehicleInfo || {},
      customsAgent: req.body.customsAgent || {},
      loadingOfficer: req.body.loadingOfficer || {},
      originAddress: req.body.originAddress || '',
      destinationAddress: req.body.destinationAddress || '',
      shippingDestination: req.body.shippingDestination || '',
      standardThicknessCm: req.body.standardThicknessCm,
      pallets,
      totals: computeTotals(pallets),
      status: req.body.status === 'final' ? 'final' : 'draft',
      notes: req.body.notes || '',
      createdBy: userId,
    });

    const actorName = await getActorName(userId);
    await logActivity(doc._id, 'created', { newValue: doc.docNumber }, userId, actorName);
    if (type === 'linked') {
      for (const invId of validInvoiceIds) {
        await logActivity(doc._id, 'linked_to_invoice', { newValue: String(invId) }, userId, actorName);
      }
    }

    return res.status(201).json(doc);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Duplicate document number — please retry' });
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/packing-lists/:id', verify, requirePermission('mis:packingList:edit'), loadPackingList, async (req, res) => {
  try {
    const userId = req.user.id;
    const doc = req.packingList;
    const update = { updateDate: new Date(), updatedBy: userId };

    const nextType = req.body.type === 'linked' || req.body.type === 'free' ? req.body.type : doc.type;
    const nextInvoiceIds = req.body.invoiceIds !== undefined ? req.body.invoiceIds : doc.invoiceIds;
    const nextPallets = req.body.pallets !== undefined ? req.body.pallets : doc.pallets;

    let validInvoiceIds = [];
    if (nextType === 'linked') {
      if (!Array.isArray(nextInvoiceIds) || !nextInvoiceIds.length) {
        return res.status(400).json({ message: 'A linked packing list needs at least one invoice' });
      }
      const invoices = await MisInvoice.find({
        _id: { $in: nextInvoiceIds }, branchId: doc.branchId, deleteDate: null,
      }).select('_id').lean();
      validInvoiceIds = invoices.map((i) => i._id);
      const outOfScope = await findOutOfScopeCodes(validInvoiceIds, nextPallets);
      if (outOfScope.length) {
        return res.status(400).json({ message: `These codes are outside the linked invoices' scope: ${outOfScope.join(', ')}` });
      }
    }

    update.type = nextType;
    update.invoiceIds = nextType === 'linked' ? validInvoiceIds : [];
    update.pallets = nextPallets;
    update.totals = computeTotals(nextPallets);

    if (req.body.productId !== undefined) update.productId = mongoose.Types.ObjectId.isValid(req.body.productId) ? req.body.productId : null;
    if (req.body.driverInfo !== undefined) update.driverInfo = req.body.driverInfo;
    if (req.body.vehicleInfo !== undefined) update.vehicleInfo = req.body.vehicleInfo;
    if (req.body.customsAgent !== undefined) update.customsAgent = req.body.customsAgent;
    if (req.body.loadingOfficer !== undefined) update.loadingOfficer = req.body.loadingOfficer;
    if (req.body.originAddress !== undefined) update.originAddress = req.body.originAddress;
    if (req.body.destinationAddress !== undefined) update.destinationAddress = req.body.destinationAddress;
    if (req.body.shippingDestination !== undefined) update.shippingDestination = req.body.shippingDestination;
    if (req.body.standardThicknessCm !== undefined) update.standardThicknessCm = req.body.standardThicknessCm;
    if (req.body.status === 'draft' || req.body.status === 'final') update.status = req.body.status;
    if (req.body.notes !== undefined) update.notes = req.body.notes;

    const updated = await MisPackingList.findOneAndUpdate({ _id: doc._id }, { $set: update }, { new: true }).lean();

    const actorName = await getActorName(userId);
    await logActivity(doc._id, 'updated', {}, userId, actorName);

    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/packing-lists/:id', verify, requirePermission('mis:packingList:delete'), loadPackingList, async (req, res) => {
  try {
    const userId = req.user.id;
    await MisPackingList.updateOne({ _id: req.packingList._id }, { $set: { deleteDate: new Date(), updatedBy: userId } });
    const actorName = await getActorName(userId);
    await logActivity(req.packingList._id, 'deleted', { oldValue: req.packingList.docNumber }, userId, actorName);
    return res.status(200).json({ message: 'Packing list deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PDF / label export ───────────────────────────────────────────────────────

router.get('/packing-lists/:id/html', verify, requirePermission('mis:view'), loadPackingList, async (req, res) => {
  try {
    const doc = req.packingList;
    const [branch, profile] = await Promise.all([
      Branch.findById(doc.branchId).lean(),
      loadCompanyProfileWithLogo(doc.branchId),
    ]);
    const templateVariant = resolveTemplateVariant(branch, 'packingList');
    const html = renderPackingListHtml(doc.toObject(), branch, profile, req.query.lang, templateVariant);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/packing-lists/:id/pdf', verify, requirePermission('mis:packingList:pdf'), loadPackingList, async (req, res) => {
  try {
    const doc = req.packingList;
    const [branch, profile] = await Promise.all([
      Branch.findById(doc.branchId).lean(),
      loadCompanyProfileWithLogo(doc.branchId),
    ]);
    const templateVariant = resolveTemplateVariant(branch, 'packingList');
    const html = renderPackingListHtml(doc.toObject(), branch, profile, req.query.lang, templateVariant);
    const pdf = await renderPdfBuffer(html);

    const userId = req.user.id;
    const actorName = await getActorName(userId);
    await logActivity(doc._id, 'pdf_generated', { newValue: doc.docNumber }, userId, actorName);

    return sendPdf(req, res, pdf, `packing-list-${doc.docNumber}.pdf`);
  } catch (err) {
    console.error('GET /mis/packing-lists/:id/pdf failed:', err);
    return res.status(500).json({ message: 'Failed to generate PDF' });
  }
});

router.get('/packing-lists/:id/pallets/:palletId/label/html', verify, requirePermission('mis:view'), loadPackingList, async (req, res) => {
  try {
    const doc = req.packingList;
    const pallet = doc.pallets.find((p) => p.palletId === req.params.palletId);
    if (!pallet) return res.status(404).json({ message: 'Pallet not found on this packing list' });
    const [branch, profile] = await Promise.all([
      Branch.findById(doc.branchId).lean(),
      loadCompanyProfileWithLogo(doc.branchId),
    ]);
    const templateVariant = resolveTemplateVariant(branch, 'label');
    const html = renderPalletLabelHtml(doc.toObject(), pallet.toObject ? pallet.toObject() : pallet, branch, profile, req.query.lang, templateVariant, labelKind(req));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/packing-lists/:id/pallets/:palletId/label/pdf', verify, requirePermission('mis:packingList:pdf'), loadPackingList, async (req, res) => {
  try {
    const doc = req.packingList;
    const pallet = doc.pallets.find((p) => p.palletId === req.params.palletId);
    if (!pallet) return res.status(404).json({ message: 'Pallet not found on this packing list' });
    const [branch, profile] = await Promise.all([
      Branch.findById(doc.branchId).lean(),
      loadCompanyProfileWithLogo(doc.branchId),
    ]);
    const templateVariant = resolveTemplateVariant(branch, 'label');
    const kind = labelKind(req);
    const plainPallet = pallet.toObject ? pallet.toObject() : pallet;
    const html = renderPalletLabelHtml(doc.toObject(), plainPallet, branch, profile, req.query.lang, templateVariant, kind);
    // Printed at the label's real size, not A4: the slab label is a compact
    // portrait page, the short-pallet label a wide strip (see labelPageSize).
    const pdf = await renderPdfBuffer(html, { ...labelPageSize(kind, plainPallet), printBackground: true });

    const userId = req.user.id;
    const actorName = await getActorName(userId);
    await logActivity(doc._id, 'label_generated', {
      body: `Pallet ${pallet.palletId}${kind === 'short' ? ' (short pallet)' : ''}`,
    }, userId, actorName);

    return sendPdf(req, res, pdf, `label-${kind === 'short' ? 'short-' : ''}${doc.docNumber}-${pallet.palletId}.pdf`);
  } catch (err) {
    console.error('GET /mis/packing-lists/:id/pallets/:palletId/label/pdf failed:', err);
    return res.status(500).json({ message: 'Failed to generate label PDF' });
  }
});

// ── reverse lookup for the invoice detail page ───────────────────────────────

router.get('/invoices/:id/packing-lists', verify, requirePermission('mis:view'), async (req, res) => {
  try {
    const invoice = await MisInvoice.findOne({ _id: req.params.id, deleteDate: null }).select('branchId').lean();
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    if (!(await assertBranchAccess(req.user.id, invoice.branchId))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }
    const { filter: scopeFilter } = await packingListScope(req.user.id);
    const data = await MisPackingList.find({ invoiceIds: req.params.id, deleteDate: null, ...scopeFilter })
      .sort({ insertDate: -1 }).lean();
    return res.status(200).json({ data });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Wraps loadCompanyProfile with per-branch logo resolution — kept local to
// this route file since only the packing-list/label templates use it today
// (see utils/resolveBranchLogo.js's comment on why the invoice template is untouched).
async function loadCompanyProfileWithLogo(branchId) {
  const profile = await loadCompanyProfile(branchId);
  const logoDataUri = await resolveBranchLogoDataUri(profile.logoFileId);
  return { ...profile, logoDataUri };
}

module.exports = router;
// exported for the live-DB verification harness — same precedent as
// routes/mis/invoices.js's computeTotals/nextDocNumber/logActivity exports.
module.exports.computeTotals = computeTotals;
module.exports.findOutOfScopeCodes = findOutOfScopeCodes;
