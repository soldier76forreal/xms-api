const express  = require('express');
const mongoose = require('mongoose');

const dbConnection = require('../../connections/xmsPr');
const misPackingListSchema         = require('../../models/misPackingListModel');
const misPackingListActivitySchema = require('../../models/misPackingListActivityModel');
const misInvoiceSchema        = require('../../models/misInvoiceModel');
const supplyRecordSchema      = require('../../models/supplyRecordModel');
const userSchema              = require('../../models/userModel');
const inventoryProductSchema  = require('../../models/inventoryProductModel');

const verify = require('../users/verifyToken');
const { requirePermission, requireBranch, assertBranchAccess, getEffectiveScopes, Group, Branch } = require('../../utils/rbac');
const { loadCompanyProfile } = require('../../utils/loadCompanyProfile');
const { resolveBranchLogoDataUri } = require('../../utils/resolveBranchLogo');
const { renderPdfBuffer } = require('../../utils/pdfRenderer');
const { sendPdf } = require('../../utils/sendPdf');
const {
  renderPackingListHtml, renderPalletLabelHtml, renderShortLabelSheetHtml, labelPageSize, LABEL_KINDS, SHORT_LABELS_PER_SHEET,
} = require('../../utils/packingListTemplate');
const { today, normalizeDateSystem } = require('../../utils/calendars');
const { branchDefaultsOf, readDocSettings } = require('../../utils/misDefaults');
const packingNumbers = require('../../utils/packingListNumbers');

// ?kind= picks the label: 'slab' (the per-pallet slab label, default) or
// 'short' (the short-pallet strip label). Anything else falls back to slab.
const labelKind = (req) => (LABEL_KINDS.includes(req.query.kind) ? req.query.kind : 'slab');

const MisPackingList         = dbConnection.models.misPackingList         || dbConnection.model('misPackingList', misPackingListSchema);
const MisPackingListActivity = dbConnection.models.misPackingListActivity || dbConnection.model('misPackingListActivity', misPackingListActivitySchema);
const MisInvoice     = dbConnection.models.misInvoice     || dbConnection.model('misInvoice', misInvoiceSchema);
const SupplyRecord   = dbConnection.models.supplyRecord   || dbConnection.model('supplyRecord', supplyRecordSchema);
const InvProduct     = dbConnection.models.inventoryProduct || dbConnection.model('inventoryProduct', inventoryProductSchema);

// A client-sent supply record id is only kept when that record exists and
// belongs to the packing list's own branch — same rule as an invoice's link.
async function resolveSupplyRecordId(rawId, branchId) {
  if (!rawId || !mongoose.Types.ObjectId.isValid(rawId)) return null;
  const rec = await SupplyRecord.findOne({ _id: rawId, deleteDate: null }).select('branchId').lean();
  if (!rec || String(rec.branchId) !== String(branchId)) return null;
  return rec._id;
}
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

// The stone name(s) of a list: each one picked from Inventory or typed. A typed name is kept as typed (whitespace
// tidied, 120 characters at most). A picked one is never trusted as sent: the product is re-read and keeps its link
// only when it is a live product of THIS list's own branch, and then its code and its names in all three languages
// are the database's, not the client's - the same snapshot discipline as a line item. A reference that does not
// check out is not an error: the name that came with it stays, as plain text. At most 20, no repeats (case ignored).
const MAX_STONE_NAMES = 20;
const MAX_STONE_NAME_LENGTH = 120;
async function resolveStoneNames(raw, branchId) {
  if (!Array.isArray(raw)) return [];
  const wanted = [];
  for (const item of raw) {
    const entry = typeof item === 'string' ? { name: item } : (item && typeof item === 'object' ? item : null);
    if (!entry) continue;
    const name = String(entry.name == null ? '' : entry.name).replace(/\s+/g, ' ').trim().slice(0, MAX_STONE_NAME_LENGTH);
    const productId = entry.productId && mongoose.Types.ObjectId.isValid(entry.productId) ? String(entry.productId) : null;
    if (!name && !productId) continue;
    wanted.push({ name, productId });
    if (wanted.length >= MAX_STONE_NAMES) break;
  }
  const ids = wanted.map((w) => w.productId).filter(Boolean);
  const products = ids.length
    ? await InvProduct.find({ _id: { $in: ids }, branchId, deleteDate: null }).select('code name nameAr nameFa').lean()
    : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const out = [];
  const seen = new Set();
  for (const w of wanted) {
    const p = w.productId ? byId.get(w.productId) : null;
    const stone = p
      ? { productId: p._id, code: p.code || '', name: p.name || w.name || p.code || '', nameAr: p.nameAr || '', nameFa: p.nameFa || '' }
      : { name: w.name };
    const key = String(stone.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(stone);
  }
  return out;
}

// The list's own date, as sent by the form ('YYYY-MM-DD'). Anything unreadable is
// ignored rather than stored — the list then reads as its creation date.
function parseIssueDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A value the schema cannot take (a piece count of "abc", a block that is not an object) is the CALLER's mistake:
// it is answered with a 400 that says what, not with a server error.
const isBadValue = (err) => Boolean(err) && (err.name === 'ValidationError' || err.name === 'CastError');
function badValueMessage(err) {
  const first = err && err.errors ? Object.values(err.errors)[0] : null;
  const text = (first && first.message) || (err && err.message) || '';
  return text ? `The packing list has an invalid value: ${text}` : 'The packing list has an invalid value.';
}

// A pallet is found by its ID (the label route looks it up by it) and told apart on the load by its
// reference, so inside ONE packing list each must be its own: two pallets with the same reference cannot be
// told apart, and with the same ID the second one's label can never be reached. Case, spaces around a value
// and repeated inner spaces do not make two values different ("a 1" = "A  1"); an empty reference is "not
// given", not a duplicate of another empty one.
const palletKey = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();

/** [{ field: 'palletId' | 'reference', value, indexes: [rows that share it], palletIds: [their IDs] }] - empty = fine. */
function findPalletDuplicates(pallets) {
  const found = [];
  if (!Array.isArray(pallets)) return found;
  for (const field of ['palletId', 'reference']) {
    const groups = new Map();
    pallets.forEach((p, index) => {
      const key = palletKey(p && p[field]);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });
    for (const indexes of groups.values()) {
      if (indexes.length < 2) continue;
      found.push({
        field,
        value: String(pallets[indexes[0]][field]).trim(),
        indexes,
        palletIds: indexes.map((i) => String((pallets[i] && pallets[i].palletId) || '').trim()),
      });
    }
  }
  return found;
}

function duplicatePalletsMessage(duplicates) {
  return duplicates.map((d) => (d.field === 'reference'
    ? `Pallets ${d.palletIds.join(', ')} share the reference "${d.value}". Every pallet needs its own reference.`
    : `More than one pallet is called "${d.value}". Every pallet needs its own ID.`)).join(' ');
}

const refuseDuplicatePallets = (res, pallets) => {
  const duplicates = findPalletDuplicates(pallets);
  if (!duplicates.length) return false;
  res.status(400).json({ message: duplicatePalletsMessage(duplicates), code: 'DUPLICATE_PALLET', duplicates });
  return true;
};

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
        { 'stoneNames.name': re },
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

// The number a NEW list would get right now - the form shows it as the suggestion. It is looked at, not taken:
// if the person leaves it alone the server takes the next free one when the list is saved. Defined before
// /packing-lists/:id so "next-number" is not read as an id.
router.get('/packing-lists/next-number', verify, requirePermission('mis:view'), requireBranch(), async (req, res) => {
  try {
    return res.status(200).json({ next: await packingNumbers.peekNext(req.branchId) });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Is this number free in this branch? The form asks as the person types, so a taken number is flagged at once
// instead of after the whole list is filled in. `excludeId` is the list being edited (its own number is free to
// it). The save still re-checks: this answer can be out of date a moment later. Before /:id for the same reason.
router.get('/packing-lists/number-available', verify, requirePermission('mis:view'), requireBranch(), async (req, res) => {
  try {
    const parsed = packingNumbers.parseDocNumber(req.query.number);
    if (parsed.error) return res.status(200).json({ valid: false, available: false, message: parsed.error });
    const excludeId = mongoose.Types.ObjectId.isValid(req.query.excludeId) ? req.query.excludeId : null;
    const taken = await packingNumbers.isTaken(req.branchId, parsed.value, excludeId);
    return res.status(200).json({
      valid: true, available: !taken, number: parsed.value, message: taken ? packingNumbers.takenMessage(parsed.value) : '',
    });
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
    if (refuseDuplicatePallets(res, pallets)) return;

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

    // The date and the calendar it is written in: what the form chose, else this
    // branch's own default (a list has no money, so only the calendar applies).
    const branchDoc = await Branch.findById(req.branchId).select('defaultCurrency defaultDateSystem').lean();
    const settings = readDocSettings({ dateSystem: req.body.dateSystem }, branchDefaultsOf(branchDoc));
    if (settings.error) return res.status(400).json({ message: settings.error });

    // The number: typed by the person (then it must be free in this branch) or else the branch's next
    // automatic one. It is settled LAST, after every check above, so a refused list never uses one up.
    const typed = !packingNumbers.isBlank(req.body.docNumber);
    let manualNumber = null;
    if (typed) {
      const parsed = packingNumbers.parseDocNumber(req.body.docNumber);
      if (parsed.error) return res.status(400).json({ message: parsed.error, code: 'DOC_NUMBER_INVALID' });
      if (await packingNumbers.isTaken(req.branchId, parsed.value)) {
        return res.status(409).json({ message: packingNumbers.takenMessage(parsed.value), code: 'DOC_NUMBER_TAKEN', docNumber: parsed.value });
      }
      manualNumber = parsed.value;
    }

    const fields = {
      branchId: req.branchId,
      issueDate: parseIssueDate(req.body.issueDate) || today(),
      dateSystem: settings.dateSystem,
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
      stoneNames: await resolveStoneNames(req.body.stoneNames, req.branchId),
      pallets,
      totals: computeTotals(pallets),
      status: req.body.status === 'final' ? 'final' : 'draft',
      notes: req.body.notes || '',
      createdBy: userId,
    };

    // Let the schema judge the payload BEFORE a number is taken: a list it refuses must not use one up.
    try {
      await new MisPackingList({ ...fields, docNumber: 1 }).validate();
    } catch (err) {
      if (isBadValue(err)) return res.status(400).json({ message: badValueMessage(err), code: 'INVALID_PACKING_LIST' });
      throw err;
    }

    let doc = null;
    for (let attempt = 0; attempt < (typed ? 1 : 5) && !doc; attempt += 1) {
      const docNumber = typed ? manualNumber : await packingNumbers.claimNext(req.branchId);
      try {
        doc = await MisPackingList.create({ ...fields, docNumber });
      } catch (err) {
        if (err.code !== 11000) throw err;
        // typed: somebody took that number a moment ago. automatic: somebody typed that very number - take the next one.
        if (typed) {
          return res.status(409).json({ message: packingNumbers.takenMessage(manualNumber), code: 'DOC_NUMBER_TAKEN', docNumber: manualNumber });
        }
      }
    }
    if (!doc) return res.status(409).json({ message: 'Could not allocate a packing list number - please try again.' });
    // a hand-typed number moves the counter up to it, so the automatic numbers carry on AFTER it
    if (typed) await packingNumbers.carryOnAfter(req.branchId, manualNumber);

    const actorName = await getActorName(userId);
    await logActivity(doc._id, 'created', { newValue: doc.docNumber }, userId, actorName);
    if (type === 'linked') {
      for (const invId of validInvoiceIds) {
        await logActivity(doc._id, 'linked_to_invoice', { newValue: String(invId) }, userId, actorName);
      }
    }

    return res.status(201).json(doc);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Duplicate document number - please try again', code: 'DOC_NUMBER_TAKEN' });
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/packing-lists/:id', verify, requirePermission('mis:packingList:edit'), loadPackingList, async (req, res) => {
  try {
    const userId = req.user.id;
    const doc = req.packingList;
    const update = { updateDate: new Date(), updatedBy: userId };

    // Date and calendar can be changed on an existing list.
    const settings = readDocSettings({ dateSystem: req.body.dateSystem }, { currency: 'AED', dateSystem: normalizeDateSystem(doc.dateSystem) });
    if (settings.error) return res.status(400).json({ message: settings.error });
    if (req.body.dateSystem !== undefined) update.dateSystem = settings.dateSystem;
    if (req.body.issueDate !== undefined) {
      const issue = parseIssueDate(req.body.issueDate);
      if (issue) update.issueDate = issue;
    }

    const nextType = req.body.type === 'linked' || req.body.type === 'free' ? req.body.type : doc.type;
    const nextInvoiceIds = req.body.invoiceIds !== undefined ? req.body.invoiceIds : doc.invoiceIds;
    const nextPallets = req.body.pallets !== undefined ? req.body.pallets : doc.pallets;
    if (req.body.pallets !== undefined && refuseDuplicatePallets(res, nextPallets)) return;

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
    // only touched when the caller sends it: a plain edit of anything else never wipes the stone names
    if (req.body.stoneNames !== undefined) update.stoneNames = await resolveStoneNames(req.body.stoneNames, doc.branchId);
    if (req.body.status === 'draft' || req.body.status === 'final') update.status = req.body.status;
    if (req.body.notes !== undefined) update.notes = req.body.notes;

    // The number can be changed: a whole number that no other list of this branch is using. Sending the
    // number it already has, or none at all, changes nothing.
    let numberChange = null;
    if (!packingNumbers.isBlank(req.body.docNumber)) {
      const parsed = packingNumbers.parseDocNumber(req.body.docNumber);
      if (parsed.error) return res.status(400).json({ message: parsed.error, code: 'DOC_NUMBER_INVALID' });
      if (parsed.value !== doc.docNumber) {
        if (await packingNumbers.isTaken(doc.branchId, parsed.value, doc._id)) {
          return res.status(409).json({ message: packingNumbers.takenMessage(parsed.value), code: 'DOC_NUMBER_TAKEN', docNumber: parsed.value });
        }
        update.docNumber = parsed.value;
        numberChange = { from: doc.docNumber, to: parsed.value };
      }
    }

    let updated;
    try {
      updated = await MisPackingList.findOneAndUpdate({ _id: doc._id }, { $set: update }, { new: true }).lean();
    } catch (err) {
      if (err.code === 11000 && numberChange) {
        return res.status(409).json({ message: packingNumbers.takenMessage(numberChange.to), code: 'DOC_NUMBER_TAKEN', docNumber: numberChange.to });
      }
      if (isBadValue(err)) return res.status(400).json({ message: badValueMessage(err), code: 'INVALID_PACKING_LIST' });
      throw err;
    }

    const actorName = await getActorName(userId);
    await logActivity(doc._id, 'updated', {}, userId, actorName);
    if (numberChange) {
      await packingNumbers.carryOnAfter(doc.branchId, numberChange.to);
      await logActivity(doc._id, 'updated', { field: 'docNumber', oldValue: numberChange.from, newValue: numberChange.to }, userId, actorName);
    }

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

// ── up to five short-pallet labels on one A4 sheet ────────────────────────────
// ?palletId=P1&palletId=P2 ... (repeated, in the order wanted - a pallet ID may contain a comma, so it is not a
// comma list) and &duplex=1 for the same sheet again on the back ("back to back"). Strips go top to bottom in the
// order given. At most SHORT_LABELS_PER_SHEET pallets: the sheet is five strips tall.

function requestedPalletIds(query) {
  const raw = query.palletId;
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  const seen = new Set();
  const out = [];
  for (const value of list) {
    const id = String(value).trim();
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

const wantsDuplex = (query) => ['1', 'true', 'yes'].includes(String(query.duplex || '').toLowerCase());

/** -> { pallets } on success, { status, body } for the refusal to send. */
function pickSheetPallets(doc, query) {
  const ids = requestedPalletIds(query);
  if (!ids.length) return { status: 400, body: { message: 'Choose at least one pallet.', code: 'NO_PALLETS' } };
  if (ids.length > SHORT_LABELS_PER_SHEET) {
    return { status: 400, body: { message: `A sheet holds at most ${SHORT_LABELS_PER_SHEET} labels.`, code: 'TOO_MANY_PALLETS' } };
  }
  const pallets = [];
  for (const id of ids) {
    const pallet = doc.pallets.find((p) => p.palletId === id);
    if (!pallet) return { status: 404, body: { message: `Pallet not found on this packing list: ${id}`, code: 'PALLET_NOT_FOUND' } };
    pallets.push(pallet.toObject ? pallet.toObject() : pallet);
  }
  return { pallets };
}

async function renderShortSheet(req) {
  const doc = req.packingList;
  const picked = pickSheetPallets(doc, req.query);
  if (!picked.pallets) return { refusal: picked };
  const [branch, profile] = await Promise.all([
    Branch.findById(doc.branchId).lean(),
    loadCompanyProfileWithLogo(doc.branchId),
  ]);
  const duplex = wantsDuplex(req.query);
  const html = renderShortLabelSheetHtml(doc.toObject(), picked.pallets, branch, profile, { duplex });
  return { html, pallets: picked.pallets, duplex };
}

router.get('/packing-lists/:id/labels/short/html', verify, requirePermission('mis:view'), loadPackingList, async (req, res) => {
  try {
    const sheet = await renderShortSheet(req);
    if (sheet.refusal) return res.status(sheet.refusal.status).json(sheet.refusal.body);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(sheet.html);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/packing-lists/:id/labels/short/pdf', verify, requirePermission('mis:packingList:pdf'), loadPackingList, async (req, res) => {
  try {
    const sheet = await renderShortSheet(req);
    if (sheet.refusal) return res.status(sheet.refusal.status).json(sheet.refusal.body);
    const pdf = await renderPdfBuffer(sheet.html, { ...labelPageSize('sheet'), printBackground: true });

    const doc = req.packingList;
    const userId = req.user.id;
    const actorName = await getActorName(userId);
    await logActivity(doc._id, 'label_generated', {
      body: `Short labels on A4${sheet.duplex ? ' (both sides)' : ''}: ${sheet.pallets.map((p) => p.palletId).join(', ')}`,
    }, userId, actorName);

    return sendPdf(req, res, pdf, `labels-short-${doc.docNumber}.pdf`);
  } catch (err) {
    console.error('GET /mis/packing-lists/:id/labels/short/pdf failed:', err);
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
