const express  = require('express');
const mongoose = require('mongoose');

const dbConnection = require('../../connections/xmsPr');
const misInvoiceSchema      = require('../../models/misInvoiceModel');
const invoiceCounterSchema  = require('../../models/invoiceCounterModel');
const companyProfileSchema  = require('../../models/companyProfileModel');
const invoiceActivitySchema = require('../../models/invoiceActivityModel');
const customerSchema         = require('../../models/customerModel');
const userSchema             = require('../../models/userModel');
const inventoryProductSchema = require('../../models/inventoryProductModel');
const inventoryVariantSchema = require('../../models/inventoryVariantModel');
const inventoryChangeLogSchema = require('../../models/inventoryChangeLogModel');
const supplyRecordSchema     = require('../../models/supplyRecordModel');
const supplyDealLetterSchema = require('../../models/supplyDealLetterModel');

const verify = require('../users/verifyToken');
const { requirePermission, getEffectivePermissions, getEffectiveScopes, Group, requireBranch, assertBranchAccess, getUserBranches, isSuperAdmin, getUsersWithPermission, Branch } = require('../../utils/rbac');
const { renderInvoiceHtml } = require('../../utils/invoiceTemplate');
const { renderPdfBuffer } = require('../../utils/pdfRenderer');
const { sendPdf } = require('../../utils/sendPdf');
const { recomputeVariantSupplyRollup, recomputeProductSupplyRollup } = require('../../utils/supplyRollup');
const { canSeeForecast, stripVariantForecast } = require('../../utils/forecastAccess');
const { amountToArabicWords } = require('../../utils/arabicWords');
const { sendNotificationToUser } = require('../socket/xmsNotifications');

// Phase 6 — MIS / Invoices (Sessions 41–42).
// ONE misInvoice collection, docType:'invoice'|'pre_invoice'. Every route is
// permission-guarded (default-deny; BUG-04 pattern); every mutation writes an
// invoiceActivity row in the same operation. Totals are computed SERVER-SIDE
// and stored so list + PDF never recompute divergently.
// Session 43 fills in: PDF render, pre→invoice convert, payment block, and the
// opted-in issue-time stock decrement (inventory:quantity:edit + changeLog).
// NOTE: legacy routes/mis/invoice.js stays mounted alongside (Project Manager
// still posts /mis/newPreInvoice until its Session 50 rebuild) — paths disjoint.

const MisInvoice      = dbConnection.models.misInvoice      || dbConnection.model('misInvoice',      misInvoiceSchema);
const InvoiceCounter  = dbConnection.models.invoiceCounter  || dbConnection.model('invoiceCounter',  invoiceCounterSchema);
const CompanyProfile  = dbConnection.models.companyProfile  || dbConnection.model('companyProfile',  companyProfileSchema);
// Session 72: replaced the old full-unique index on `key` with a partial
// unique index on `branchId` (see companyProfileModel.js) — every doc,
// including new per-branch overrides, still carries key:'default', so the
// STALE old index must actually be dropped in the live DB, not just removed
// from the schema. Same precedent as InvVariant.syncIndexes() in
// routes/inventory/main.js. Runs once at startup, errors swallowed.
CompanyProfile.syncIndexes().catch(() => {});
const InvoiceActivity = dbConnection.models.invoiceActivity || dbConnection.model('invoiceActivity', invoiceActivitySchema);
const Customer        = dbConnection.models.customer         || dbConnection.model('customer',         customerSchema);
const User            = dbConnection.models.user             || dbConnection.model('user',             userSchema);
const InvProduct      = dbConnection.models.inventoryProduct || dbConnection.model('inventoryProduct', inventoryProductSchema);
const InvVariant      = dbConnection.models.inventoryVariant || dbConnection.model('inventoryVariant', inventoryVariantSchema);
const InvChangeLog    = dbConnection.models.inventoryChangeLog || dbConnection.model('inventoryChangeLog', inventoryChangeLogSchema);
const SupplyRecord     = dbConnection.models.supplyRecord     || dbConnection.model('supplyRecord',     supplyRecordSchema);
const SupplyDealLetter = dbConnection.models.supplyDealLetter || dbConnection.model('supplyDealLetter', supplyDealLetterSchema);

const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

// Valid status sets per docType (spec lifecycles — light, append later if needed)
const STATUS_SETS = {
  // 'requested' is reachable only on an inter-branch quotation — a stock
  // request raised by another branch, awaiting this branch's review.
  pre_invoice: ['requested', 'draft', 'sent', 'accepted', 'converted', 'expired'],
  invoice:     ['draft', 'issued', 'paid', 'partially_paid', 'cancelled'],
};

// Atomic per-BRANCH per-docType number assignment — NEVER client-side, gap-safe
// under concurrent creates. Counters never rewind (deleted docs burn their
// number). Branches are fully isolated, so each has its own independent sequence.
async function nextDocNumber(branchId, docType) {
  const counter = await InvoiceCounter.findOneAndUpdate(
    { branchId, docType },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return counter.seq;
}

// Validates a client-sent supplyRecordId against the doc's own branch before
// it is stored. Never trust the id as sent — same discipline as every other
// cross-resource ref here. Returns the id to store, or null.
async function resolveSupplyRecordId(rawId, branchId) {
  if (!rawId) return null;
  if (!mongoose.Types.ObjectId.isValid(rawId)) return null;
  const rec = await SupplyRecord.findOne({ _id: rawId, deleteDate: null }).select('branchId').lean();
  if (!rec) return null;
  if (String(rec.branchId) !== String(branchId)) return null;   // cross-branch link is not allowed
  return rec._id;
}

// Notifies the OTHER side of a cross-branch document. Both branches can see an
// inter-branch doc, so whoever didn't act is the one who needs telling: an
// operator on the fulfilling branch acting notifies the requesting branch, and
// vice versa. A no-op for ordinary customer documents.
async function notifyCrossBranchCounterparty(doc, { textKey, textParams, actorId, permission = 'mis:view' }) {
  try {
    if (!doc || doc.tradeMode !== 'interBranch' || !doc.requestingBranchId) return;

    // Which side did the actor act from? Default to treating them as the
    // fulfilling branch, so the requester still hears about it either way.
    const actorHoldsTarget = await assertBranchAccess(actorId, doc.branchId);
    const notifyBranchId = actorHoldsTarget ? doc.requestingBranchId : doc.branchId;

    const recipients = await getUsersWithPermission(permission);
    for (const uid of recipients) {
      if (String(uid) === String(actorId)) continue;          // never notify the actor
      if (!(await assertBranchAccess(uid, notifyBranchId))) continue;
      await sendNotificationToUser(uid, {
        fromId: actorId, type: 'invoice', textKey, textParams,
        entityType: 'invoice', entityId: String(doc._id),
      });
    }
  } catch (err) {
    // Never let a notification failure break the mutation that triggered it.
    console.error('notifyCrossBranchCounterparty failed:', err);
  }
}

// Audit rule: every mutation writes an invoiceActivity row in the SAME operation.
async function logActivity(invoiceId, docType, type, fields, actorId, actorName) {
  try {
    await InvoiceActivity.create({
      invoiceId, docType, type,
      ...fields,
      actorId, actorName,
      date: new Date(), createdAt: new Date(),
    });
  } catch (_) {}
}

async function getActorName(userId) {
  const actor = await User.findById(userId).select('firstName lastName').lean();
  return actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '';
}

// Server-side money math (2dp / fils). Per line:
//   base = qty × unitPrice
//   discountAmount = percent ? base × discount/100 : discount
//   vatAmount = (base − discountAmount) × vatRate/100     (sample: 146.88 = 5% × 2937.60)
//   lineTotal = base − discountAmount + vatAmount
// Rollups: subtotal = Σ base · discountTotal = Σ discountAmount · vatTotal = Σ vat
//   grandTotal (المطلوب) = subtotal − discountTotal + vatTotal + shipping
function computeTotals(lineItems, shipping) {
  let subtotal = 0, discountTotal = 0, vatTotal = 0;
  const lines = (lineItems || []).map((li) => {
    const qty       = Number(li.quantity)  || 0;
    const unitPrice = Number(li.unitPrice) || 0;
    const discount  = Number(li.discount)  || 0;
    const vatRate   = Number(li.vatRate)   || 0;

    const base           = round2(qty * unitPrice);
    const discountAmount = li.discountType === 'percent' ? round2(base * discount / 100) : round2(discount);
    const vatAmount      = round2((base - discountAmount) * vatRate / 100);
    const lineTotal      = round2(base - discountAmount + vatAmount);

    subtotal      += base;
    discountTotal += discountAmount;
    vatTotal      += vatAmount;

    return { ...li, quantity: qty, unitPrice, discount, vatRate, vatAmount, lineTotal };
  });

  subtotal      = round2(subtotal);
  discountTotal = round2(discountTotal);
  vatTotal      = round2(vatTotal);
  const ship       = round2(shipping);
  const grandTotal = round2(subtotal - discountTotal + vatTotal + ship);

  return { lines, subtotal, discountTotal, vatTotal, shipping: ship, grandTotal };
}

// Server-side safety net (defense in depth — the form already blocks this
// client-side): reject any line whose requested quantity exceeds the variant's
// CURRENT stock. Product-level lines (no variantId) aren't stock-tracked, so
// they're skipped. Returns an array of { code, available } overages, or [].
async function findStockOverages(lineItems) {
  const overages = [];
  for (const li of (lineItems || [])) {
    // Supply-sourced lines (Session 72) aren't backed by real InvVariant.quantity
    // yet — reconciling them against Supply's own "receive" action is out of
    // scope for this phase, so they're skipped here the same as a product-level line.
    if (!li.variantId || li.sourceType === 'supply') continue;
    const variant = await InvVariant.findOne({ _id: li.variantId, deleteDate: null }).select('code quantity').lean();
    if (!variant) continue;
    const requested = Number(li.quantity) || 0;
    const available = variant.quantity || 0;
    if (requested > available) overages.push({ code: variant.code || li.code, available });
  }
  return overages;
}

// Row-level scope (mine/group/all), same pattern as CRM/Inventory — MIS
// invoices have no owner concept, but DO have "Send to" assignedTo[]: a
// 'mine'-scoped or view-only user must still see a doc explicitly assigned to
// them, even if they didn't create it (mirrors CRM's own/assigned scope).
// BUG FIX (2026-07-06): rolesManager's UI has always exposed an "Invoices"
// dataScope option, but nothing here ever read/enforced it — every MIS route
// silently ran as if scope were always 'all'. Never trust ?scope from the client.
async function buildMisScopeFilter(userId, misScope) {
  if (!misScope || misScope === 'all') return null;
  const uid = new mongoose.Types.ObjectId(userId);
  if (misScope === 'mine') return { $or: [{ createdBy: uid }, { assignedTo: uid }] };
  const userGroups = await Group.find({ members: uid, deleteDate: null }).select('members').lean();
  const memberIds  = [...new Set(userGroups.flatMap(g => (g.members || []).map(String)))]
    .map(id => new mongoose.Types.ObjectId(id));
  const createdByFilter = memberIds.length ? { $in: memberIds } : uid;
  return { $or: [{ createdBy: createdByFilter }, { assignedTo: uid }] };
}

// In-memory boolean check for a single already-loaded doc (used by loadInvoice,
// which needs a yes/no answer rather than a Mongo query fragment).
async function canAccessMisDoc(userId, misScope, doc) {
  if (!misScope || misScope === 'all') return true;
  // An incoming request belongs to the branch it was sent to — its MIS staff
  // can open it whatever their row scope (same rule as the list route).
  if (doc.tradeMode === 'interBranch' && await assertBranchAccess(userId, doc.branchId)) return true;
  const uid = String(userId);
  const assignedTo = (doc.assignedTo || []).map(String);
  if (assignedTo.includes(uid)) return true;   // assignee always sees it, any scope
  if (misScope === 'mine') return String(doc.createdBy) === uid;
  // group
  const userGroups = await Group.find({ members: new mongoose.Types.ObjectId(userId), deleteDate: null }).select('members').lean();
  const memberIds  = new Set(userGroups.flatMap((g) => (g.members || []).map(String)));
  memberIds.add(uid);
  return memberIds.has(String(doc.createdBy));
}

// Authoritative customerSnapshot: derived server-side from the CRM customer doc,
// then overlaid with the body's editable fields (trn/country per spec). A later
// CRM edit never rewrites a historical document.
async function buildCustomerSnapshot(customerId, bodySnapshot = {}) {
  const c = await Customer.findOne({ _id: customerId, deleteDate: null }).lean();
  if (!c) return null;
  const pi = c.personalInformation || {};
  const isCompany = (pi.customerType || pi.personOrCompany) === 'company';
  const name = isCompany
    ? (pi.companyName || `${pi.firstName || ''} ${pi.lastName || ''}`.trim())
    : `${pi.firstName || ''} ${pi.lastName || ''}`.trim() || pi.companyName || '';
  return {
    name:    bodySnapshot.name    || name,
    trn:     bodySnapshot.trn     || c.trn || '',
    country: bodySnapshot.country || pi.country || '',
    phone:   bodySnapshot.phone   || c.phoneNumber || '',
    address: bodySnapshot.address || '',
  };
}

// docType-aware permission picker: create/edit/delete/pdf differ per doc type.
// Reads docType from the body (create) or the loaded doc (set by loadInvoice).
function requireDocTypePermission(action) {
  return async (req, res, next) => {
    const docType = (req.misInvoice && req.misInvoice.docType) || req.body.docType;
    if (docType !== 'invoice' && docType !== 'pre_invoice') {
      return res.status(400).json({ message: 'Invalid docType' });
    }
    const key = docType === 'invoice' ? `mis:invoice:${action}` : `mis:preinvoice:${action}`;
    return requirePermission(key)(req, res, next);
  };
}

// Session 72 — branch access check for a loaded MIS doc. Identical to
// assertBranchAccess for a 'customer' doc (unchanged behavior). For an
// 'interBranch' doc, EITHER side may see/edit it while pending: the target/
// fulfilling branch (doc.branchId) OR the requesting/buyer branch
// (doc.requestingBranchId) — only the target side can actually approve it
// (see the extra check inside POST /invoices/:id/convert).
async function assertMisDocBranchAccess(userId, doc) {
  if (await assertBranchAccess(userId, doc.branchId)) return true;
  if (doc.tradeMode === 'interBranch' && doc.requestingBranchId) {
    return assertBranchAccess(userId, doc.requestingBranchId);
  }
  return false;
}

// Loads the (live) doc onto req.misInvoice so the docType-aware guard can run
// BEFORE the handler. 404s early for missing/soft-deleted docs.
// Single chokepoint for every :id route (detail/update/delete/html/pdf/convert/
// payment) — row-level scope enforced HERE so all seven inherit it from one edit.
async function loadInvoice(req, res, next) {
  try {
    const doc = await MisInvoice.findOne({ _id: req.params.id, deleteDate: null });
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    if (!(await assertMisDocBranchAccess(req.user.id, doc))) {
      return res.status(403).json({ message: 'You do not have access to this branch' });
    }

    const scopes   = await getEffectiveScopes(req.user.id);
    const misScope = scopes.mis;
    if (!(await canAccessMisDoc(req.user.id, misScope, doc))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    req.misInvoice = doc;
    return next();
  } catch (err) {
    return res.status(400).json({ message: 'Invalid ID' });
  }
}

// Session 72 — per-branch override, falling back to the global singleton
// (upserted so IT always exists, exactly as before). A branchId with no
// override doc yet does NOT get one auto-created here — only PUT
// /company-profile with a branchId creates/updates a real per-branch doc;
// a bare read must keep falling back to the richer global doc, not freeze on
// an empty just-created one.
async function loadProfile(branchId) {
  if (branchId) {
    const branchProfile = await CompanyProfile.findOne({ branchId }).lean();
    if (branchProfile) return branchProfile;
  }
  return CompanyProfile.findOneAndUpdate(
    { key: 'default', branchId: null },
    { $setOnInsert: { key: 'default', branchId: null } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
}

// Session 72 — which PDF template a doc renders with. Plain lookup against the
// branch's misTemplates strings (see branchModel.js) — an unset/unknown value
// falls back to 'classic', the only template that actually exists today.
function resolveTemplateVariant(branch, docType, tradeMode) {
  const key = tradeMode === 'interBranch'
    ? (docType === 'invoice' ? 'interBranchInvoice' : 'interBranchQuotation')
    : (docType === 'invoice' ? 'customerInvoice' : 'customerQuotation');
  return (branch && branch.misTemplates && branch.misTemplates[key]) || 'classic';
}

// Puppeteer plumbing (getBrowser/renderPdfBuffer/resolveChromePath) now lives
// in utils/pdfRenderer.js (Session 72) — imported above — so the new packing-
// list/label PDF routes can share the exact same singleton browser instead of
// launching a second one. Pure extraction, behavior unchanged.

// ── payment-time stock decrement (OPTED IN 2026-07-03, retriggered to 'paid' 2026-07-05) ─
// Fires ONCE when an invoice transitions to 'paid' (stockDecremented guard) —
// via either a manual status change or the payment route's auto-transition.
// Same discipline as inventory routes: every quantity write → inventoryChangeLog
// row + product rollup recompute, in the same operation. Lines without a
// variantId (product-level lines) are skipped and noted in the activity row.
async function recomputeRollup(productId) {
  const variants = await InvVariant.find({ productId, deleteDate: null, status: 'active' });
  const totalsByUnit = {};
  let minPrice = null, maxPrice = null;
  for (const v of variants) {
    totalsByUnit[v.unit] = parseFloat(((totalsByUnit[v.unit] || 0) + (v.quantity || 0)).toFixed(4));
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

// ── Stock commitment ──────────────────────────────────────────────────────────
// What a document takes out of what's available, and when:
//   • an invoice when it's PAID (unchanged rule — see the PUT and payment routes)
//   • a quotation or request when it's ACCEPTED (see the PUT route)
// Inventory lines come off the variant's real stock (with a change-log row);
// supply lines are promised against their lot (deal letter line allocatedQty),
// which takes them out of "left in the lot" and out of Inventory's forecast.
// stockDecremented guards against doing it twice; converting an accepted
// quotation hands it to the invoice instead of committing again.

// What a document takes out of stock — which variety (and lot), how much.
// Prices don't matter here; only items and quantities.
const stockSignature = (lines) => JSON.stringify((lines || [])
  .filter((li) => li.variantId)
  .map((li) => [String(li.variantId), li.sourceType === 'supply' ? String(li.supplyDealLetterId || '') : '', Number(li.quantity) || 0])
  .map((x) => x.join('|'))
  .sort());

const touchesInventory = (lines) => (lines || []).some((li) => li.variantId && li.sourceType !== 'supply');
const docLabelOf = (doc) => (doc.docType === 'invoice' ? 'Invoice' : (doc.tradeMode === 'interBranch' ? 'Request' : 'Quotation'));

// A supply line's lot can't promise more than it has left.
async function findSupplyOverages(lineItems) {
  const overages = [];
  for (const li of (lineItems || [])) {
    if (li.sourceType !== 'supply' || !li.supplyDealLetterId || !li.variantId) continue;
    const dl = await SupplyDealLetter.findOne({ _id: li.supplyDealLetterId, deleteDate: null }).lean();
    const line = dl && (dl.varietyLines || []).find((v) => String(v.variantId) === String(li.variantId));
    if (!line) { overages.push({ code: li.code, available: 0 }); continue; }
    const base = dl.status === 'final_product'
      ? (line.finalQty || 0) - (line.receivedQty || 0)
      : (line.forecastQty || 0);
    const left = base - (line.allocatedQty || 0);
    if ((Number(li.quantity) || 0) > left) overages.push({ code: li.code || line.variantCode, available: Math.max(0, left) });
  }
  return overages;
}

// Promise (sign +1) or release (sign -1) a supply line against its lot.
async function allocateSupplyLine(li, sign) {
  if (!li.supplyDealLetterId || !li.variantId) return false;
  const qty = (Number(li.quantity) || 0) * sign;
  const where = { _id: li.supplyDealLetterId, 'varietyLines.variantId': li.variantId };
  const res = await SupplyDealLetter.updateOne(where, { $inc: { 'varietyLines.$.allocatedQty': qty } });
  // never below zero, whatever the history
  if (sign < 0) await SupplyDealLetter.updateOne(where, { $max: { 'varietyLines.$.allocatedQty': 0 } });
  return res.modifiedCount > 0 || res.matchedCount > 0;
}

async function refreshSupplyRollups(variantIds) {
  const productIds = new Set();
  for (const vid of variantIds) {
    await recomputeVariantSupplyRollup(vid);
    const v = await InvVariant.findById(vid).select('productId').lean();
    if (v) productIds.add(String(v.productId));
  }
  for (const pid of productIds) await recomputeProductSupplyRollup(pid);
}

async function issueStockDecrement(doc, userId, actorName, reason) {
  const label = reason || `Invoice #${doc.docNumber}`;
  const skipped = [];
  const touchedProducts = new Set();
  const touchedSupply = new Set();

  for (const li of (doc.lineItems || [])) {
    if (li.sourceType === 'supply') {
      if (await allocateSupplyLine(li, +1)) touchedSupply.add(String(li.variantId));
      else skipped.push(`${li.code || li.name} (lot not found)`);
      continue;
    }
    if (!li.variantId) { skipped.push(li.code || li.name); continue; }
    const variant = await InvVariant.findOne({ _id: li.variantId, deleteDate: null });
    if (!variant) { skipped.push(li.code || li.name); continue; }

    const oldQty = variant.quantity || 0;
    const delta  = -(Number(li.quantity) || 0);
    const newQty = parseFloat((oldQty + delta).toFixed(4));

    await InvVariant.updateOne({ _id: variant._id }, { $set: { quantity: newQty, updateDate: new Date() } });
    await InvChangeLog.create({
      subjectType: 'variant',
      subjectId:   variant._id,
      productId:   variant.productId,
      changeType:  'quantity',
      field:       'quantity',
      oldValue:    oldQty,
      newValue:    newQty,
      delta,
      unit:        variant.unit,
      reason:      label,
      source:      'order',
      changedBy:   userId,
      changedByName: actorName,
      date: new Date(), createdAt: new Date(),
    });
    touchedProducts.add(String(variant.productId));
  }

  for (const pid of touchedProducts) await recomputeRollup(pid);
  if (touchedSupply.size) await refreshSupplyRollups([...touchedSupply]);

  await MisInvoice.updateOne({ _id: doc._id }, { $set: { stockDecremented: true } });
  await logActivity(doc._id, doc.docType, 'stock_decremented', {
    body: [label, skipped.length ? `Skipped: ${skipped.join(', ')}` : ''].filter(Boolean).join(' — '),
    newValue: (doc.lineItems || []).filter((l) => l.variantId).length,
  }, userId, actorName);
}

// Reverse of issueStockDecrement — puts inventory quantities back and releases
// supply lines from their lot. Only acts if the doc actually committed stock.
async function restoreStock(doc, userId, actorName, reason) {
  if (!doc.stockDecremented) return;
  const label = reason || `Invoice #${doc.docNumber} deleted — stock restored`;
  const touchedProducts = new Set();
  const touchedSupply = new Set();

  for (const li of (doc.lineItems || [])) {
    if (li.sourceType === 'supply') {
      if (await allocateSupplyLine(li, -1)) touchedSupply.add(String(li.variantId));
      continue;
    }
    if (!li.variantId) continue;
    const variant = await InvVariant.findOne({ _id: li.variantId, deleteDate: null });
    if (!variant) continue;

    const oldQty = variant.quantity || 0;
    const delta  = Number(li.quantity) || 0;   // positive — putting it back
    const newQty = parseFloat((oldQty + delta).toFixed(4));

    await InvVariant.updateOne({ _id: variant._id }, { $set: { quantity: newQty, updateDate: new Date() } });
    await InvChangeLog.create({
      subjectType: 'variant',
      subjectId:   variant._id,
      productId:   variant.productId,
      changeType:  'quantity',
      field:       'quantity',
      oldValue:    oldQty,
      newValue:    newQty,
      delta,
      unit:        variant.unit,
      reason:      label,
      source:      'correction',
      changedBy:   userId,
      changedByName: actorName,
      date: new Date(), createdAt: new Date(),
    });
    touchedProducts.add(String(variant.productId));
  }

  for (const pid of touchedProducts) await recomputeRollup(pid);
  if (touchedSupply.size) await refreshSupplyRollups([...touchedSupply]);
  await MisInvoice.updateOne({ _id: doc._id }, { $set: { stockDecremented: false } });
  await logActivity(doc._id, doc.docType, 'stock_restored', {
    body: label,
    newValue: (doc.lineItems || []).filter((l) => l.variantId).length,
  }, userId, actorName);
}

// Passes when the caller holds ANY of the keys.
const requireAnyPermission = (keys) => async (req, res, next) => {
  try {
    const perms = await getEffectivePermissions(req.user.id);
    if (keys.some((k) => perms.has(k))) return next();
    return res.status(403).json({ message: 'Access denied', requiredPermission: keys.join(' | ') });
  } catch (err) {
    return next(err);
  }
};

// ── GET /mis/products-lookup — inventory line picker (BEFORE /invoices/:id) ───
// Returns matching varieties WITH their active variants (code/unit/price) so the
// form can add variant-level snapshot lines. Reuses inventory data read-only.
router.get('/products-lookup', verify, requirePermission('mis:view'), requireBranch(), async (req, res) => {
  try {
    const { search = '' } = req.query;
    const query = { branchId: req.branchId, deleteDate: null, status: 'active' };
    if (search.trim()) {
      const re = new RegExp(escapeRegex(search.trim()), 'i');
      query.$or = [{ name: re }, { code: re }];
    }
    const products = await InvProduct.find(query)
      .select('_id code name stoneType quarryCode defaultUnit')
      .sort('name')
      .limit(30)
      .lean();

    const productIds = products.map((p) => p._id);
    const variants = await InvVariant.find({
      productId: { $in: productIds }, deleteDate: null, status: 'active',
    })
      .select('_id productId code unit quantity price currency spec.lengthCm spec.widthCm spec.thicknessMm spec.unsized')
      .lean();

    const byProduct = {};
    for (const v of variants) {
      (byProduct[String(v.productId)] = byProduct[String(v.productId)] || []).push(v);
    }
    const data = products.map((p) => ({ ...p, variants: byProduct[String(p._id)] || [] }));
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Cross-branch browsing (Session 72) — gated ONLY by mis:crossBranch:quote,
// deliberately bypasses assertBranchAccess: the whole point is letting a
// requesting branch's authorized user see ANOTHER branch's catalog to build a
// quote against it. Read-only, quantities only (price is read here too since
// it's needed to seed the quote's line prices — this is staff-only tooling,
// not the public website's price-stripped surface).
// Which branches has the caller been GRANTED access to? A branch appears only
// when it has explicitly listed one of the caller's own branches in its
// crossBranchAccess (set in Branch settings). Default-deny: an empty list on a
// branch means nobody can browse it, so this returns [] until someone grants.
// superAdmins are NOT exempt — the grant models a commercial arrangement
// between branches, not an access level.
// requestingBranchId (optional, the caller's active branch): narrow to branches
// that shared with THAT branch specifically. A request is always raised from
// one branch, and the create route checks the grant against exactly that one —
// so the pickers must ask the same question, or they'd offer a branch the
// create would then refuse. Without it: shared with any branch the caller holds.
async function grantedCrossBranchIds(userId, requestingBranchId = null) {
  let ownBranchIds;
  if (requestingBranchId) {
    if (!mongoose.Types.ObjectId.isValid(requestingBranchId)
      || !(await assertBranchAccess(userId, requestingBranchId))) {
      return { ownBranchIds: [], branches: [] };
    }
    ownBranchIds = [String(requestingBranchId)];
  } else {
    ownBranchIds = (await getUserBranches(userId)).map((id) => String(id));
  }
  if (!ownBranchIds.length) return { ownBranchIds, branches: [] };
  const branches = await Branch.find({
    status: 'active', deleteDate: null,
    crossBranchAccess: { $in: ownBranchIds.map((id) => new mongoose.Types.ObjectId(id)) },
  }).select('_id name country').lean();
  return { ownBranchIds, branches: branches.filter((b) => !ownBranchIds.includes(String(b._id))) };
}

// Throws nothing — returns true/false, so callers can 403 with their own message.
async function assertCrossBranchGrant(userId, targetBranchId, requestingBranchId = null) {
  const { branches } = await grantedCrossBranchIds(userId, requestingBranchId);
  return branches.some((b) => String(b._id) === String(targetBranchId));
}

// Also open to inventory:forecast:request — asking for a forecast lot from
// Inventory without Supply access or the general cross-branch key.
router.get('/cross-branch/branches', verify, requireAnyPermission(['mis:crossBranch:quote', 'inventory:forecast:request']), async (req, res) => {
  try {
    const { branches } = await grantedCrossBranchIds(req.user.id, req.query.requestingBranchId || null);
    return res.status(200).json({ data: branches });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/cross-branch/inventory', verify, requirePermission('mis:crossBranch:quote'), async (req, res) => {
  try {
    const { branchId, search = '' } = req.query;
    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
      return res.status(400).json({ message: 'branchId is required' });
    }
    if (!(await assertCrossBranchGrant(req.user.id, branchId, req.query.requestingBranchId || null))) {
      return res.status(403).json({ message: 'That branch has not shared its inventory with you' });
    }
    const query = { branchId, deleteDate: null, status: 'active' };
    if (search.trim()) {
      const re = new RegExp(escapeRegex(search.trim()), 'i');
      query.$or = [{ name: re }, { code: re }];
    }
    const products = await InvProduct.find(query)
      .select('_id code name stoneType quarryCode defaultUnit')
      .sort('name')
      .limit(30)
      .lean();

    const productIds = products.map((p) => p._id);
    const variants = await InvVariant.find({ productId: { $in: productIds }, deleteDate: null, status: 'active' })
      .select('_id productId code unit quantity price currency supply spec.lengthCm spec.widthCm spec.thicknessMm spec.unsized')
      .lean();

    // Forecast figures only for those allowed to see them.
    const showForecast = await canSeeForecast(req.user.id);
    const byProduct = {};
    for (const v of variants) {
      (byProduct[String(v.productId)] = byProduct[String(v.productId)] || []).push(showForecast ? v : stripVariantForecast(v));
    }
    const data = products.map((p) => ({ ...p, variants: byProduct[String(p._id)] || [] }));
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// One row per variety line across every non-deleted deal letter in the target
// branch — enough for the quote form to seed a sourceType:'supply' line
// (supplyDealLetterId + a forecast/final quantity + a price).
router.get('/cross-branch/supply', verify, requireAnyPermission(['mis:crossBranch:quote', 'inventory:forecast:request']), async (req, res) => {
  try {
    const { branchId, search = '' } = req.query;
    if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
      return res.status(400).json({ message: 'branchId is required' });
    }
    if (!(await assertCrossBranchGrant(req.user.id, branchId, req.query.requestingBranchId || null))) {
      return res.status(403).json({ message: 'That branch has not shared its supply with you' });
    }
    const dealLetters = await SupplyDealLetter.find({ branchId, deleteDate: null }).limit(100).lean();
    // each lot's supply record code (SR-0001…), so the picker can name it
    const records = await SupplyRecord.find({ _id: { $in: dealLetters.map((d) => d.supplyId) } }).select('code').lean();
    const codeOf = new Map(records.map((r) => [String(r._id), r.code]));
    let rows = [];
    for (const dl of dealLetters) {
      for (const line of dl.varietyLines || []) {
        rows.push({
          dealLetterId: dl._id, productId: dl.productId, status: dl.status,
          supplyRecordId: dl.supplyId, recordCode: codeOf.get(String(dl.supplyId)) || null,
          // Which lot this is — the same variety can be in several deal
          // letters at once, and the picker has to tell them apart.
          contractNumber: (dl.contract && dl.contract.number) || null,
          seller: (dl.coupeSeller && dl.coupeSeller.name) || null,
          variantId: line.variantId, variantCode: line.variantCode, unit: line.unit,
          forecastQty: line.forecastQty, finalQty: line.finalQty, receivedQty: line.receivedQty,
          // already promised to accepted quotations / requests
          allocatedQty: line.allocatedQty || 0,
          left: Math.max(0, (dl.status === 'final_product'
            ? (line.finalQty || 0) - (line.receivedQty || 0)
            : (line.forecastQty || 0)) - (line.allocatedQty || 0)),
          price: line.price, currency: line.currency,
        });
      }
    }
    if (search.trim()) {
      const re = new RegExp(escapeRegex(search.trim()), 'i');
      rows = rows.filter((r) => re.test(r.variantCode || ''));
    }
    return res.status(200).json({ data: rows.slice(0, 100) });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET/PUT /mis/company-profile — template header settings ───────────────────
router.get('/company-profile', verify, requirePermission('mis:view'), async (req, res) => {
  try {
    const { branchId } = req.query;
    if (branchId) {
      if (!mongoose.Types.ObjectId.isValid(branchId)) return res.status(400).json({ message: 'Invalid branchId' });
      if (!(await assertBranchAccess(req.user.id, branchId))) {
        return res.status(403).json({ message: 'You do not have access to this branch' });
      }
    }
    const profile = await loadProfile(branchId || null);
    return res.status(200).json(profile);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/company-profile', verify, requirePermission('mis:settings:edit'), async (req, res) => {
  try {
    const { branchId } = req.body;
    if (branchId) {
      if (!mongoose.Types.ObjectId.isValid(branchId)) return res.status(400).json({ message: 'Invalid branchId' });
      if (!(await assertBranchAccess(req.user.id, branchId))) {
        return res.status(403).json({ message: 'You do not have access to this branch' });
      }
    }

    const allowed = ['nameAr', 'nameEn', 'phones', 'email', 'website', 'trn',
                     'branchAddressAr', 'logoFileId', 'bank', 'vatRate',
                     'thankYouNoteAr', 'quotationValidityDefaultDays'];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];
    update.updateDate = new Date();
    update.updatedBy  = req.user.id;

    const filter = branchId ? { branchId } : { key: 'default', branchId: null };
    const setOnInsert = branchId ? { key: 'default', branchId } : { key: 'default', branchId: null };

    const profile = await CompanyProfile.findOneAndUpdate(
      filter,
      { $set: update, $setOnInsert: setOnInsert },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    return res.status(200).json(profile);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /mis/filter-memory — persist active tab/filter/sort (BEFORE /:id) ─────
router.put('/filter-memory', verify, async (req, res) => {
  try {
    const { sort, order, filter } = req.body;
    const update = {};
    if (sort   !== undefined) update['filterMemory.mis.sort']   = sort;
    if (order  !== undefined) update['filterMemory.mis.order']  = order;
    if (filter !== undefined) update['filterMemory.mis.filter'] = filter;
    if (Object.keys(update).length) {
      await User.updateOne({ _id: req.user.id }, { $set: update });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /mis/invoices/creators — distinct users who created a doc ─────────────
// BEFORE /:id to avoid capture. Powers the "created by" filter.
router.get('/invoices/creators', verify, requirePermission('mis:view'), requireBranch(), async (req, res) => {
  try {
    const ids = await MisInvoice.distinct('createdBy', { branchId: req.branchId, deleteDate: null, createdBy: { $ne: null } });
    const users = await User.find({ _id: { $in: ids } }).select('firstName lastName').lean();
    const data = users.map((u) => ({ _id: u._id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Unknown' }));
    return res.status(200).json({ data });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /mis/invoices — list (server-side filter / sort / pagination) ─────────
router.get('/invoices', verify, requirePermission('mis:view'), requireBranch(), async (req, res) => {
  try {
    const userId  = req.user.id;
    const scopes  = await getEffectiveScopes(userId);
    const misScope = scopes.mis;

    const {
      docType = 'all', search = '', status = '',
      customerId = '', productId = '', createdBy = '',
      dateFrom = '', dateTo = '',
      sort = 'issueDate', order = 'desc',
      page = 1, limit = 30, tradeMode = '',
    } = req.query;

    const filters = [];

    // the tabs — Quote / Invoice / Requests / All. docType splits invoice from
    // quotation; tradeMode splits a customer quotation from a REQUEST (an
    // inter-branch quotation: one branch asking another for stock). Docs older
    // than tradeMode have no such field, so "customer" means "not inter-branch".
    if (docType === 'invoice' || docType === 'pre_invoice') filters.push({ docType });
    if (tradeMode === 'interBranch') filters.push({ tradeMode: 'interBranch' });
    else if (tradeMode === 'customer') filters.push({ tradeMode: { $ne: 'interBranch' } });

    // search: docNumber + customer name + line code/name
    if (search.trim()) {
      const term = search.trim();
      const re = new RegExp(escapeRegex(term), 'i');
      const or = [
        { 'customerSnapshot.name': re },
        { 'lineItems.code': re },
        { 'lineItems.name': re },
      ];
      if (/^\d+$/.test(term)) or.push({ docNumber: Number(term) });
      filters.push({ $or: or });
    }

    if (status) filters.push({ status });

    if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
      filters.push({ customerId: new mongoose.Types.ObjectId(customerId) });
    }

    // reverse lookup — invoices containing this product (or one of its variants)
    if (productId && mongoose.Types.ObjectId.isValid(productId)) {
      const pid = new mongoose.Types.ObjectId(productId);
      filters.push({ $or: [{ 'lineItems.productId': pid }, { 'lineItems.variantId': pid }] });
    }

    // date range → issueDate
    if (dateFrom || dateTo) {
      const df = {};
      if (dateFrom) df.$gte = new Date(dateFrom);
      if (dateTo)   df.$lte = new Date(dateTo);
      filters.push({ issueDate: df });
    }

    // row-level scope (server-side — never trust ?scope from the client)
    let scopeFilter = await buildMisScopeFilter(userId, misScope);

    // "created by" filter — a refinement WITHIN whatever the scope already
    // allows; disabled client-side (and ignored here) when scope === 'mine'.
    // Refining still keeps the assignee OR (a filtered-to-one-creator view
    // should still surface docs assigned to the current user).
    if (createdBy && mongoose.Types.ObjectId.isValid(createdBy) && misScope !== 'mine') {
      const requested = new mongoose.Types.ObjectId(createdBy);
      let allowed = true;
      if (misScope === 'group') {
        const uid = new mongoose.Types.ObjectId(userId);
        const userGroups = await Group.find({ members: uid, deleteDate: null }).select('members').lean();
        const memberIds  = new Set(userGroups.flatMap((g) => (g.members || []).map(String)));
        allowed = memberIds.has(String(requested));
      }
      if (allowed) {
        scopeFilter = { $or: [{ createdBy: requested }, { assignedTo: new mongoose.Types.ObjectId(userId) }] };
      }
    }
    // Requests are addressed to a BRANCH, not to a person: everyone working
    // the branch being asked must see what came in, whatever their row scope —
    // otherwise a 'mine'-scoped operator is notified about a request they then
    // can't find (or open — canAccessMisDoc carries the same exception).
    if (scopeFilter) filters.push({ $or: [scopeFilter, { tradeMode: 'interBranch', branchId: req.branchId }] });

    // Session 72 — a cross-branch doc's branchId is the FULFILLING branch, but
    // the REQUESTING branch's own list must also surface it (that's the whole
    // point of showing them a pending quote they sent out) — see requestingBranchId.
    const query = {
      $or: [{ branchId: req.branchId }, { requestingBranchId: req.branchId }],
      deleteDate: null,
    };
    if (filters.length) query.$and = filters;

    const validSort = { issueDate: 'issueDate', docNumber: 'docNumber', grandTotal: 'grandTotal' };
    const sortField = validSort[sort] || 'issueDate';
    const sortDir   = order === 'asc' ? 1 : -1;
    const lim       = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const skip      = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [data, total] = await Promise.all([
      MisInvoice.find(query)
        .select('-packingList.rows -notes')   // card fields only; detail loads the rest
        .sort({ [sortField]: sortDir, _id: -1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      MisInvoice.countDocuments(query),
    ]);

    return res.status(200).json({ data, total, page: Number(page) || 1, limit: lim });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /mis/invoices/assigned/:userId — docs "Sent to" this user ─────────────
// Reverse lookup for the Users section's "Assigned Invoices" card (mirrors the
// CRM Requests tab / Inventory Invoices tab pattern). Branch isolation still
// applies to the VIEWER: a non-superAdmin only sees assigned docs in branches
// they themselves hold, even if the target user's assignment spans others.
router.get('/invoices/assigned/:userId', verify, requirePermission('mis:view'), async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ message: 'Invalid user ID' });
    }

    const query = {
      assignedTo: new mongoose.Types.ObjectId(targetUserId),
      deleteDate: null,
    };

    const superAdmin = await isSuperAdmin(req.user.id);
    if (!superAdmin) {
      const branchIds = await getUserBranches(req.user.id);
      if (!branchIds.length) return res.status(200).json({ data: [], total: 0 });
      query.branchId = { $in: branchIds };
    }

    const data = await MisInvoice.find(query)
      .select('-packingList.rows -notes')
      .sort({ issueDate: -1 })
      .limit(50)
      .lean();

    return res.status(200).json({ data, total: data.length });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /mis/invoices/:id — detail ────────────────────────────────────────────
router.get('/invoices/:id', verify, requirePermission('mis:view'), loadInvoice, async (req, res) => {
  try {
    const [activity, supplyRecord] = await Promise.all([
      InvoiceActivity.find({ invoiceId: req.misInvoice._id }).sort({ date: -1 }).limit(50).lean(),
      // the supply record this document was raised against — by its code, so
      // both branches can tell which record it is
      req.misInvoice.supplyRecordId
        ? SupplyRecord.findById(req.misInvoice.supplyRecordId).select('code title productCode').lean()
        : null,
    ]);
    return res.status(200).json({ ...req.misInvoice.toObject(), activity, supplyRecord });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── POST /mis/invoices — create (counter + snapshot + totals + activity) ──────
// Session 72: NOT gated by requireBranch() any more — a tradeMode:'interBranch'
// create legitimately targets a branch the caller does NOT hold, so branch
// authorization is resolved manually below depending on tradeMode instead.
router.post('/invoices', verify, requireDocTypePermission('create'), async (req, res) => {
  try {
    const userId   = req.user.id;
    const docType  = req.body.docType;
    const tradeMode = req.body.tradeMode === 'interBranch' ? 'interBranch' : 'customer';

    let branchId;                    // fulfilling branch — owns docNumber/template/profile either way
    let requestingBranchId = null;
    let requestingBranchSnapshot = null;

    if (tradeMode === 'interBranch') {
      if (docType !== 'pre_invoice') {
        return res.status(400).json({ message: 'An inter-branch document must start as a quotation' });
      }
      const perms = await getEffectivePermissions(userId);
      // The cross-branch key covers any request; a request made only of
      // forecast (Supply) stone also passes with inventory:forecast:request.
      const forecastOnly = Array.isArray(req.body.lineItems) && req.body.lineItems.length > 0
        && req.body.lineItems.every((li) => li.sourceType === 'supply');
      if (!perms.has('mis:crossBranch:quote') && !(forecastOnly && perms.has('inventory:forecast:request'))) {
        return res.status(403).json({ message: 'Access denied', requiredPermission: 'mis:crossBranch:quote' });
      }
      branchId = req.body.branchId;
      requestingBranchId = req.body.requestingBranchId;
      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
        return res.status(400).json({ message: 'A target branch is required' });
      }
      if (!requestingBranchId || !mongoose.Types.ObjectId.isValid(requestingBranchId)) {
        return res.status(400).json({ message: 'Your requesting branch is required' });
      }
      if (String(branchId) === String(requestingBranchId)) {
        return res.status(400).json({ message: 'A branch cannot place a request with itself' });
      }
      // The caller must hold their OWN (requesting) branch — access to the
      // TARGET branch is exactly what mis:crossBranch:quote grants instead.
      if (!(await assertBranchAccess(userId, requestingBranchId))) {
        return res.status(403).json({ message: 'You do not have access to this requesting branch' });
      }
      const targetBranch = await Branch.findOne({ _id: branchId, deleteDate: null, status: 'active' }).lean();
      if (!targetBranch) return res.status(404).json({ message: 'Target branch not found' });
      // ...and that branch must have shared itself with the REQUESTING branch
      // specifically — not just with some other branch the caller happens to
      // hold. Re-checked here and not just on the browse routes, so a
      // hand-crafted POST can't raise a request against a branch that never
      // opened up to the branch it's coming from.
      if (!(await assertCrossBranchGrant(userId, branchId, requestingBranchId))) {
        return res.status(403).json({ message: 'That branch has not shared its inventory with your branch' });
      }
      const requestingBranch = await Branch.findOne({ _id: requestingBranchId, deleteDate: null }).lean();
      if (!requestingBranch) return res.status(404).json({ message: 'Requesting branch not found' });
      requestingBranchSnapshot = { name: requestingBranch.name };
    } else {
      branchId = req.body.branchId;
      if (!branchId) return res.status(400).json({ message: 'No branch selected', code: 'BRANCH_REQUIRED' });
      if (!(await assertBranchAccess(userId, branchId))) {
        return res.status(403).json({ message: 'You do not have access to this branch' });
      }
    }

    // basic validation — customer is required for invoices (goods need a
    // destination) but OPTIONAL for pre-invoices/quotes (can be drafted before
    // a customer is confirmed). Inter-branch docs have no CRM customer at all.
    const hasCustomerId = tradeMode === 'customer' && req.body.customerId && mongoose.Types.ObjectId.isValid(req.body.customerId);
    if (docType === 'invoice' && !hasCustomerId) {
      return res.status(400).json({ message: 'Customer is required' });
    }
    if (req.body.customerId && !hasCustomerId) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }
    if (!Array.isArray(req.body.lineItems) || req.body.lineItems.length === 0) {
      return res.status(400).json({ message: 'At least one line item is required' });
    }
    const overages = await findStockOverages(req.body.lineItems);
    if (overages.length) {
      return res.status(400).json({
        message: 'Requested quantity exceeds available stock',
        overages,
      });
    }
    const status = req.body.status || 'draft';
    if (!STATUS_SETS[docType].includes(status)) {
      return res.status(400).json({ message: 'Invalid status for this document type' });
    }
    // 'requested' means "another branch is asking us for stock" — it is only
    // meaningful on an inter-branch doc, never on a customer-facing one.
    if (status === 'requested' && tradeMode !== 'interBranch') {
      return res.status(400).json({ message: 'Only an inter-branch document can be a request' });
    }

    // authoritative snapshot (CRM doc + editable overlay) — skipped entirely
    // when no customer is picked (allowed for pre-invoices)
    let customerSnapshot = null;
    if (hasCustomerId) {
      customerSnapshot = await buildCustomerSnapshot(req.body.customerId, req.body.customerSnapshot);
      if (!customerSnapshot) return res.status(404).json({ message: 'Customer not found' });
    }

    // server-side money math — never trust client totals
    const shipping = docType === 'invoice' ? req.body.shipping : 0;
    const totals = computeTotals(req.body.lineItems, shipping);

    // default quote validity from companyProfile when not provided — per-branch
    // override, falls back to global (Session 72)
    let validityDays = req.body.validityDays;
    if (docType === 'pre_invoice' && (validityDays === undefined || validityDays === null)) {
      const profile = await loadProfile(branchId);
      validityDays = (profile && profile.quotationValidityDefaultDays) || 2;
    }

    const doc = await MisInvoice.create({
      branchId,
      docType,
      docNumber: await nextDocNumber(branchId, docType),   // atomic, per-branch, server-assigned
      status,
      tradeMode,
      requestingBranchId: tradeMode === 'interBranch' ? requestingBranchId : undefined,
      requestingBranchSnapshot: tradeMode === 'interBranch' ? requestingBranchSnapshot : undefined,
      issueDate: req.body.issueDate ? new Date(req.body.issueDate) : new Date(),
      issueTime: req.body.issueTime,
      customerId: hasCustomerId ? req.body.customerId : undefined,
      // undefined rather than null when there's no customer (inter-branch):
      // a null here is what later broke conversion by failing to cast.
      customerSnapshot: customerSnapshot || undefined,
      lineItems: totals.lines,
      currency: 'AED',
      subtotal:      totals.subtotal,
      discountTotal: totals.discountTotal,
      vatTotal:      totals.vatTotal,
      shipping:      totals.shipping,
      grandTotal:    totals.grandTotal,
      // invoice-only blocks (payment figures maintained via PUT /:id/payment)
      amountInWords: docType === 'invoice' ? amountToArabicWords(totals.grandTotal) : undefined,
      salesRepId:   docType === 'invoice' ? req.body.salesRepId   : undefined,
      salesRepName: docType === 'invoice' ? req.body.salesRepName : undefined,
      // packingList is intentionally NOT written here any more (Session 72,
      // Phase 3) — packing lists are now their own standalone MIS resource
      // (routes/mis/packingLists.js). The schema field is kept, unset, for a
      // brand-new doc; only historical pre-Session-72 invoices carry it.
      // pre-invoice-only
      validityDays: docType === 'pre_invoice' ? validityDays : undefined,
      // Optional Supply link — re-validated against this doc's branch.
      supplyRecordId: await resolveSupplyRecordId(req.body.supplyRecordId, branchId),
      notes: req.body.notes,
      insertDate: new Date(),
      createdBy: userId,
    });

    const actorName = await getActorName(userId);
    await logActivity(doc._id, docType, 'created', { newValue: doc.docNumber }, userId, actorName);

    // Notify the TARGET branch's MIS staff — the requesting branch already
    // knows it just created this (its own UI just did it); the fulfilling
    // branch is the one that needs to hear about a new pending request.
    if (tradeMode === 'interBranch') {
      const editors = await getUsersWithPermission('mis:preinvoice:edit');
      for (const uid of editors) {
        if (!(await assertBranchAccess(uid, branchId))) continue;
        await sendNotificationToUser(uid, {
          fromId: userId, fromName: actorName, type: 'invoice',
          textKey: 'misCrossBranchQuoteReceived',
          textParams: { docNumber: doc.docNumber, fromBranch: requestingBranchSnapshot.name },
          entityType: 'invoice', entityId: String(doc._id),
        });
      }
    }

    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /mis/invoices/:id — update (recompute totals + activity) ──────────────
router.put('/invoices/:id', verify, loadInvoice, requireDocTypePermission('edit'), async (req, res) => {
  try {
    const userId = req.user.id;
    const doc    = req.misInvoice;

    // identity fields are immutable — docType switches would corrupt counters
    delete req.body.docType;
    delete req.body.docNumber;
    delete req.body.stockDecremented;
    delete req.body.convertedToInvoiceId;
    delete req.body.convertedFromPreInvoiceId;
    // payment figures move ONLY through PUT /:id/payment (mis:payment:edit — S43)
    delete req.body.payment;

    const update = {};
    const actorName = await getActorName(userId);

    // An inter-branch doc has no CRM customer — the buyer is the requesting
    // branch. Ignore any customer fields a form sends along with it.
    if (doc.tradeMode === 'interBranch') {
      delete req.body.customerId;
      delete req.body.customerSnapshot;
    }

    // ── Stock follows acceptance (see "Stock commitment" above) ──
    const isQuote = doc.docType === 'pre_invoice';
    const effectiveLines = req.body.lineItems !== undefined ? req.body.lineItems : doc.lineItems;
    const linesChanging = req.body.lineItems !== undefined && stockSignature(req.body.lineItems) !== stockSignature(doc.lineItems);
    const leavingAccepted = isQuote && doc.status === 'accepted' && req.body.status
      && req.body.status !== 'accepted' && req.body.status !== 'converted';
    if (isQuote && doc.stockDecremented && linesChanging && !leavingAccepted) {
      return res.status(409).json({
        message: `This ${docLabelOf(doc).toLowerCase()} is accepted — its quantities are already out of stock. Move it out of Accepted to change items or quantities.`,
      });
    }
    let stockAction = null;   // 'commit' | 'release', applied after the update is saved

    // status transition (validated per docType, logged separately)
    if (req.body.status && req.body.status !== doc.status) {
      // A request can also be declined ('cancelled') by the branch it was sent to.
      const isRequest = doc.tradeMode === 'interBranch' && doc.docType === 'pre_invoice';
      const allowedStatuses = isRequest ? [...STATUS_SETS.pre_invoice, 'cancelled'] : STATUS_SETS[doc.docType];
      if (!allowedStatuses.includes(req.body.status)) {
        return res.status(400).json({ message: 'Invalid status for this document type' });
      }
      // 'converted' means an invoice exists — only converting it gets it there.
      if (req.body.status === 'converted' && !doc.convertedToInvoiceId) {
        return res.status(400).json({ message: 'Convert the quotation to set it as converted' });
      }
      if (req.body.status === 'requested' && doc.tradeMode !== 'interBranch') {
        return res.status(400).json({ message: 'Only an inter-branch document can be a request' });
      }
      // A request's status is the ASKED branch's call (review → price →
      // accept); the requesting side watches it move but can't move it.
      if (doc.tradeMode === 'interBranch' && !(await assertBranchAccess(userId, doc.branchId))) {
        return res.status(403).json({ message: 'Only the branch this request was sent to can change its status' });
      }
      // Accepting takes the quantities out; leaving Accepted puts them back.
      if (isQuote && req.body.status === 'accepted' && !doc.stockDecremented) stockAction = 'commit';
      if (leavingAccepted && doc.stockDecremented) stockAction = 'release';
      if (stockAction) {
        const lines = stockAction === 'commit' ? effectiveLines : doc.lineItems;
        if (touchesInventory(lines)) {
          const perms = await getEffectivePermissions(userId);
          if (!perms.has('inventory:quantity:edit')) {
            return res.status(403).json({
              message: stockAction === 'commit'
                ? 'Accepting takes these quantities out of stock — inventory quantity permission required'
                : 'Leaving Accepted puts these quantities back in stock — inventory quantity permission required',
              requiredPermission: 'inventory:quantity:edit',
            });
          }
        }
        if (stockAction === 'commit') {
          const overages = [...await findStockOverages(lines), ...await findSupplyOverages(lines)];
          if (overages.length) {
            return res.status(400).json({ message: 'Accepting it would take more than is available', overages });
          }
        }
      }
      update.status = req.body.status;
      await logActivity(doc._id, doc.docType, 'status',
        { field: 'status', oldValue: doc.status, newValue: req.body.status }, userId, actorName);

      // Keep the other branch informed about their request's progress.
      await notifyCrossBranchCounterparty(doc, {
        textKey: 'misCrossBranchStatusChanged',
        textParams: { docNumber: doc.docNumber, status: req.body.status, actorName },
        actorId: userId,
      });

      // Stock decrement (opted in, moved to 'paid' 2026-07-05 — was 'issued'):
      // fires once, when a manual status change lands the invoice on 'paid'.
      // The triggering path CARRIES inventory:quantity:edit — without it, no decrement.
      if (doc.docType === 'invoice' && req.body.status === 'paid' && !doc.stockDecremented) {
        const perms = await getEffectivePermissions(userId);
        if (!perms.has('inventory:quantity:edit')) {
          return res.status(403).json({
            message: 'Marking an invoice paid decrements stock — inventory quantity permission required',
            requiredPermission: 'inventory:quantity:edit',
          });
        }
        await issueStockDecrement(doc, userId, actorName);
      }
    }

    // re-snapshot only when the customer itself changes
    if (req.body.customerId && String(req.body.customerId) !== String(doc.customerId)) {
      if (!mongoose.Types.ObjectId.isValid(req.body.customerId)) {
        return res.status(400).json({ message: 'Invalid customer' });
      }
      const snap = await buildCustomerSnapshot(req.body.customerId, req.body.customerSnapshot);
      if (!snap) return res.status(404).json({ message: 'Customer not found' });
      update.customerId       = req.body.customerId;
      update.customerSnapshot = snap;
    } else if (req.body.customerSnapshot) {
      // editable overlay (trn/country) without switching customer
      update.customerSnapshot = { ...doc.customerSnapshot, ...req.body.customerSnapshot };
    }

    // lines / shipping changed → recompute all totals server-side
    if (req.body.lineItems !== undefined || req.body.shipping !== undefined) {
      const lineItems = req.body.lineItems !== undefined ? req.body.lineItems : doc.lineItems;
      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        return res.status(400).json({ message: 'At least one line item is required' });
      }
      const overages = await findStockOverages(lineItems);
      if (overages.length) {
        return res.status(400).json({
          message: 'Requested quantity exceeds available stock',
          overages,
        });
      }
      const shipping = doc.docType === 'invoice'
        ? (req.body.shipping !== undefined ? req.body.shipping : doc.shipping)
        : 0;
      const totals = computeTotals(lineItems, shipping);
      update.lineItems     = totals.lines;
      update.subtotal      = totals.subtotal;
      update.discountTotal = totals.discountTotal;
      update.vatTotal      = totals.vatTotal;
      update.shipping      = totals.shipping;
      update.grandTotal    = totals.grandTotal;
      if (doc.docType === 'invoice') update.amountInWords = amountToArabicWords(totals.grandTotal);
    }

    // simple pass-through fields
    if (req.body.issueDate    !== undefined) update.issueDate    = new Date(req.body.issueDate);
    if (req.body.issueTime    !== undefined) update.issueTime    = req.body.issueTime;
    if (req.body.notes        !== undefined) update.notes        = req.body.notes;
    if (doc.docType === 'invoice') {
      if (req.body.salesRepId   !== undefined) update.salesRepId   = req.body.salesRepId;
      if (req.body.salesRepName !== undefined) update.salesRepName = req.body.salesRepName;
      // packingList is intentionally no longer accepted here (Session 72, Phase 3)
      // — see the create route's comment above.
    } else if (req.body.validityDays !== undefined) {
      update.validityDays = req.body.validityDays;
    }

    update.updateDate = new Date();
    update.updatedBy  = userId;

    let updated = await MisInvoice.findOneAndUpdate(
      { _id: doc._id }, { $set: update }, { new: true }
    ).lean();

    if (stockAction === 'commit') {
      await issueStockDecrement(updated, userId, actorName, `${docLabelOf(doc)} #${doc.docNumber} accepted`);
      updated = await MisInvoice.findById(doc._id).lean();
    } else if (stockAction === 'release') {
      await restoreStock(doc, userId, actorName, `${docLabelOf(doc)} #${doc.docNumber} no longer accepted — stock put back`);
      updated = await MisInvoice.findById(doc._id).lean();
    }

    await logActivity(doc._id, doc.docType, 'updated', {}, userId, actorName);

    // Content changes (lines, prices, totals) matter to the other branch too —
    // skipped when this PUT only moved the status, which already notified.
    if (update.lineItems) {
      await notifyCrossBranchCounterparty(doc, {
        textKey: 'misCrossBranchUpdated',
        textParams: { docNumber: doc.docNumber, actorName },
        actorId: userId,
      });
    }

    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── DELETE /mis/invoices/:id — soft delete (+ activity) ───────────────────────
router.delete('/invoices/:id', verify, loadInvoice, requireDocTypePermission('delete'), async (req, res) => {
  try {
    const userId = req.user.id;
    const doc    = req.misInvoice;
    const actorName = await getActorName(userId);

    // Stock restore is only relevant when this invoice actually decremented
    // stock. The caller decides (frontend prompts on delete); restoring writes
    // to inventory so it requires the same guard as any quantity change.
    // A quotation/request's reservation (from being accepted) always goes
    // back — a deleted quotation can't keep stock out. An invoice's paid
    // decrement goes back only if the user opts in (the dialog asks).
    const autoRelease = doc.docType === 'pre_invoice' && doc.stockDecremented;
    const wantsRestore = doc.stockDecremented &&
      (autoRelease || req.query.restoreStock === 'true' || req.body.restoreStock === true);
    if (wantsRestore && touchesInventory(doc.lineItems)) {
      const perms = await getEffectivePermissions(userId);
      if (!perms.has('inventory:quantity:edit')) {
        return res.status(403).json({
          message: 'Restoring stock requires the inventory quantity permission',
          requiredPermission: 'inventory:quantity:edit',
        });
      }
    }
    if (wantsRestore) {
      await restoreStock(doc, userId, actorName, `${docLabelOf(doc)} #${doc.docNumber} deleted — stock put back`);
    }

    await MisInvoice.updateOne(
      { _id: doc._id },
      { $set: { deleteDate: new Date(), updatedBy: userId } }
    );
    await logActivity(doc._id, doc.docType, 'deleted',
      { oldValue: doc.docNumber, body: wantsRestore ? 'Stock restored' : undefined }, userId, actorName);
    return res.status(200).json({ message: 'Document deleted', stockRestored: wantsRestore });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /mis/invoices/:id/html — screen preview (same template as the PDF) ────
router.get('/invoices/:id/html', verify, requirePermission('mis:view'), loadInvoice, async (req, res) => {
  try {
    const doc = req.misInvoice;
    const [profile, branch] = await Promise.all([
      loadProfile(doc.branchId),
      Branch.findById(doc.branchId).select('misTemplates').lean(),
    ]);
    const templateVariant = resolveTemplateVariant(branch, doc.docType, doc.tradeMode);
    const html = renderInvoiceHtml(doc.toObject(), profile, req.query.lang, templateVariant);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /mis/invoices/:id/pdf — final export (own key, NOT gated by :edit) ────
router.get('/invoices/:id/pdf', verify, loadInvoice, requireDocTypePermission('pdf'), async (req, res) => {
  try {
    const doc = req.misInvoice;
    const [profile, branch] = await Promise.all([
      loadProfile(doc.branchId),
      Branch.findById(doc.branchId).select('misTemplates').lean(),
    ]);
    const templateVariant = resolveTemplateVariant(branch, doc.docType, doc.tradeMode);
    const html = renderInvoiceHtml(doc.toObject(), profile, req.query.lang, templateVariant);
    const pdf  = await renderPdfBuffer(html);

    const userId    = req.user.id;
    const actorName = await getActorName(userId);
    await logActivity(doc._id, doc.docType, 'pdf_generated', { newValue: doc.docNumber }, userId, actorName);

    const prefix = doc.docType === 'invoice' ? 'invoice' : 'quotation';
    return sendPdf(req, res, pdf, `${prefix}-${doc.docNumber}.pdf`);
  } catch (err) {
    // browser launch failures land here (no Chrome/Edge found) — logged so the
    // real cause is visible on the server; the client only gets the generic message.
    console.error('GET /mis/invoices/:id/pdf failed:', err);
    return res.status(500).json({ message: 'Failed to generate PDF' });
  }
});

// ── POST /mis/invoices/:id/convert — pre-invoice → invoice ────────────────────
router.post('/invoices/:id/convert', verify, loadInvoice, requirePermission('mis:preinvoice:convert'), async (req, res) => {
  try {
    const pre = req.misInvoice;
    if (pre.docType !== 'pre_invoice') {
      return res.status(400).json({ message: 'Only a pre-invoice can be converted' });
    }
    if (pre.convertedToInvoiceId || pre.status === 'converted') {
      return res.status(409).json({ message: 'This pre-invoice has already been converted', invoiceId: pre.convertedToInvoiceId });
    }
    if (pre.status === 'cancelled') {
      return res.status(400).json({ message: 'A declined request cannot be converted' });
    }
    const userId = req.user.id;
    // Session 72 — an inter-branch quote's REQUESTING branch can view/edit it
    // while pending (loadInvoice already allows that), but only the TARGET/
    // fulfilling branch (pre.branchId) may actually approve it into an invoice.
    if (pre.tradeMode === 'interBranch' && !(await assertBranchAccess(userId, pre.branchId))) {
      return res.status(403).json({ message: 'Only the fulfilling branch can convert this quote into an invoice' });
    }

    const actorName = await getActorName(userId);

    // customerSnapshot is a NESTED PATH, not a subdocument — Mongoose hands back
    // a proxy object for it that is truthy even when the stored value is null
    // (which is what an inter-branch quote has, since it has no CRM customer).
    // Reading it off the plain object is the only reliable emptiness check; the
    // proxy passed a truthiness guard and then failed to cast, which is what
    // broke converting every inter-branch quotation.
    const preObj = pre.toObject ? pre.toObject() : pre;

    // Two ways in:
    //  • with a draft (the app): the invoice form opens pre-filled from the
    //    quotation, the user completes it — customer, address, prices, shipping,
    //    notes — and posts it here. Validated exactly like a new invoice:
    //    server-side totals, stock check, customer re-snapshotted from CRM.
    //  • without one (legacy callers): the quotation is copied as-is.
    const draft = req.body && Array.isArray(req.body.lineItems) && req.body.lineItems.length ? req.body : null;
    const isInterBranch = pre.tradeMode === 'interBranch';
    let lineSource;
    let shipping = 0;
    let customerId = pre.customerId;
    let customerSnapshot = preObj.customerSnapshot || null;
    let notes = pre.notes;
    let issueDate = new Date();
    let issueTime;
    let salesRepId;
    let salesRepName;
    let status = 'draft';

    // An accepted quotation already took its quantities out (see the PUT
    // route). If the invoice keeps the same items and quantities, that
    // reservation simply moves to it — paying it later won't take them again.
    // If the form changed them, the reservation is released and the invoice
    // takes its own lines when it's paid.
    const reserved = Boolean(pre.stockDecremented);
    const keepsReservation = reserved && (!draft || stockSignature(draft.lineItems) === stockSignature(pre.lineItems));
    if (reserved && !keepsReservation) {
      if (touchesInventory(pre.lineItems)) {
        const perms = await getEffectivePermissions(userId);
        if (!perms.has('inventory:quantity:edit')) {
          return res.status(403).json({
            message: 'Changing the items of an accepted quotation puts its reserved stock back — inventory quantity permission required',
            requiredPermission: 'inventory:quantity:edit',
          });
        }
      }
      await restoreStock(pre, userId, actorName, `${docLabelOf(pre)} #${pre.docNumber} converted with different items — reservation released`);
    }

    if (draft) {
      if (!keepsReservation) {
        const overages = await findStockOverages(draft.lineItems);
        if (overages.length) {
          return res.status(400).json({ message: 'Requested quantity exceeds available stock', overages });
        }
      }
      lineSource = draft.lineItems;
      shipping = Number(draft.shipping) || 0;
      if (!isInterBranch) {
        // An invoice needs a customer — the quotation may not have had one.
        const cid = draft.customerId || pre.customerId;
        if (!cid || !mongoose.Types.ObjectId.isValid(cid)) {
          return res.status(400).json({ message: 'Customer is required' });
        }
        const snap = await buildCustomerSnapshot(cid, draft.customerSnapshot);
        if (!snap) return res.status(404).json({ message: 'Customer not found' });
        customerId = cid;
        customerSnapshot = snap;
      }
      if (draft.notes !== undefined) notes = draft.notes;
      if (draft.issueDate) issueDate = new Date(draft.issueDate);
      issueTime = draft.issueTime;
      salesRepId = draft.salesRepId;
      salesRepName = draft.salesRepName;
      // Payment-driven statuses go through the payment route (and 'paid'
      // carries the stock decrement), so a fresh conversion is draft or issued.
      if (draft.status === 'issued') status = 'issued';
    } else {
      lineSource = pre.lineItems.map(l => l.toObject ? l.toObject() : l);
    }

    // recompute totals as an invoice
    const totals = computeTotals(lineSource, shipping);

    const invoice = await MisInvoice.create({
      branchId: pre.branchId,                              // converted invoice stays in the pre-invoice's branch
      docType: 'invoice',
      docNumber: await nextDocNumber(pre.branchId, 'invoice'),   // NEW per-branch invoice number
      status,
      tradeMode: pre.tradeMode,
      requestingBranchId: pre.requestingBranchId,
      requestingBranchSnapshot: pre.requestingBranchSnapshot,
      issueDate,
      issueTime,
      customerId: isInterBranch ? undefined : customerId,
      ...(!isInterBranch && customerSnapshot ? { customerSnapshot } : {}),
      lineItems: totals.lines,
      currency: 'AED',
      subtotal:      totals.subtotal,
      discountTotal: totals.discountTotal,
      vatTotal:      totals.vatTotal,
      shipping:      totals.shipping,
      grandTotal:    totals.grandTotal,
      amountInWords: amountToArabicWords(totals.grandTotal),
      salesRepId,
      salesRepName,
      convertedFromPreInvoiceId: pre._id,
      // Carries the accepted quotation's reservation (see above).
      stockDecremented: keepsReservation,
      // The quotation's supply-record link travels with it — an invoice raised
      // from a lot stays visible under that lot.
      supplyRecordId: pre.supplyRecordId || undefined,
      notes,
      insertDate: new Date(),
      createdBy: userId,
    });

    await MisInvoice.updateOne(
      { _id: pre._id },
      { $set: {
        status: 'converted', convertedToInvoiceId: invoice._id, updateDate: new Date(), updatedBy: userId,
        // the reservation now belongs to the invoice
        ...(keepsReservation ? { stockDecremented: false } : {}),
      } }
    );
    if (keepsReservation) {
      await logActivity(invoice._id, 'invoice', 'stock_decremented', {
        body: `Already out of stock — reserved when ${docLabelOf(pre).toLowerCase()} #${pre.docNumber} was accepted`,
      }, userId, actorName);
    }

    await logActivity(pre._id, 'pre_invoice', 'converted',
      { newValue: invoice.docNumber }, userId, actorName);
    await logActivity(invoice._id, 'invoice', 'created',
      { body: `Converted from pre-invoice #${pre.docNumber}`, newValue: invoice.docNumber }, userId, actorName);

    // The requesting branch asked for this — tell them it became a real invoice.
    await notifyCrossBranchCounterparty(pre, {
      textKey: 'misCrossBranchConverted',
      textParams: { docNumber: pre.docNumber, invoiceNumber: invoice.docNumber, actorName },
      actorId: userId,
    });

    return res.status(201).json(invoice);
  } catch (err) {
    // Logged, not swallowed — this path previously reported a bare 500 with no
    // trace of the underlying validation failure.
    console.error('POST /mis/invoices/:id/convert failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /mis/invoices/:id/payment — payment block (invoice only) ──────────────
router.put('/invoices/:id/payment', verify, loadInvoice, requirePermission('mis:payment:edit'), async (req, res) => {
  try {
    const doc = req.misInvoice;
    if (doc.docType !== 'invoice') {
      return res.status(400).json({ message: 'A pre-invoice has no payment block' });
    }

    const userId    = req.user.id;
    const actorName = await getActorName(userId);

    const cash       = round2(req.body.cash       !== undefined ? req.body.cash       : doc.payment.cash);
    const chequeBank = round2(req.body.chequeBank !== undefined ? req.body.chequeBank : doc.payment.chequeBank);
    const card       = round2(req.body.card       !== undefined ? req.body.card       : doc.payment.card);
    const paidSum    = round2(cash + chequeBank + card);
    const remaining  = round2(doc.grandTotal - paidSum);   // الباقي — server-computed

    const payment = {
      cash, chequeBank, card, remaining,
      currentBalance: req.body.currentBalance !== undefined ? round2(req.body.currentBalance) : doc.payment.currentBalance,
      balanceSign:    req.body.balanceSign === 'credit' ? 'credit' : (req.body.balanceSign === 'debit' ? 'debit' : doc.payment.balanceSign),
    };

    const update = { payment, updateDate: new Date(), updatedBy: userId };

    // auto-derive lifecycle from payment state (only once the invoice is issued)
    if (['issued', 'paid', 'partially_paid'].includes(doc.status)) {
      const newStatus = remaining <= 0 ? 'paid' : (paidSum > 0 ? 'partially_paid' : 'issued');
      if (newStatus !== doc.status) {
        update.status = newStatus;
        await logActivity(doc._id, doc.docType, 'status',
          { field: 'status', oldValue: doc.status, newValue: newStatus }, userId, actorName);

        // Stock decrement fires here too — clearing the balance via a payment
        // record is the far more common real-world path to 'paid' than a
        // manual status edit. Same permission gate as the manual path.
        if (newStatus === 'paid' && !doc.stockDecremented) {
          const perms = await getEffectivePermissions(userId);
          if (!perms.has('inventory:quantity:edit')) {
            return res.status(403).json({
              message: 'Marking an invoice paid decrements stock — inventory quantity permission required',
              requiredPermission: 'inventory:quantity:edit',
            });
          }
          await issueStockDecrement(doc, userId, actorName);
        }
      }
    }

    const updated = await MisInvoice.findOneAndUpdate({ _id: doc._id }, { $set: update }, { new: true }).lean();

    await logActivity(doc._id, doc.docType, 'payment',
      { oldValue: doc.payment && doc.payment.remaining, newValue: remaining,
        body: `Cash ${cash} · Cheque/Bank ${chequeBank} · Card ${card}` }, userId, actorName);

    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /mis/invoices/:id/assign — "Send to" one or more users ────────────────
// Hands a doc to users so it surfaces in their queue even under a 'mine' scope
// or a view-only role. Gated by :edit for the doc type (assigning is a mutation
// of the doc). Each newly-added assignee gets a notification. assignedTo is a
// full replace of the set the caller sends (so it doubles as "unassign").
router.put('/invoices/:id/assign', verify, loadInvoice, requireDocTypePermission('edit'), async (req, res) => {
  try {
    const doc    = req.misInvoice;
    const userId = req.user.id;
    const actorName = await getActorName(userId);

    const requested = Array.isArray(req.body.assignedTo) ? req.body.assignedTo : [];
    const validIds  = [...new Set(requested
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => String(id)))];

    // notify only the users newly added (not already on the doc)
    const prev = (doc.assignedTo || []).map(String);
    const newlyAdded = validIds.filter((id) => !prev.includes(id));

    const update = validIds.length
      ? { assignedTo: validIds, assignedBy: userId, assignedByName: actorName, assignedAt: new Date(), updateDate: new Date(), updatedBy: userId }
      : { assignedTo: [], assignedBy: null, assignedByName: null, assignedAt: null, updateDate: new Date(), updatedBy: userId };

    const updated = await MisInvoice.findOneAndUpdate({ _id: doc._id }, { $set: update }, { new: true }).lean();

    const label = doc.docType === 'invoice' ? 'Invoice' : 'Pre-invoice';
    await logActivity(doc._id, doc.docType, 'assigned',
      { body: `Sent to ${validIds.length} user(s)`, newValue: validIds.length }, userId, actorName);

    for (const uid of newlyAdded) {
      await sendNotificationToUser(uid, {
        fromId: userId, fromName: actorName, type: 'invoice',
        textKey: 'misInvoiceSent', textParams: { label, docNumber: doc.docNumber, actorName },
        entityType: 'invoice', entityId: String(doc._id),
      });
    }

    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Attach this document to a Supply record, or detach it (send supplyRecordId
// null/empty). The link is validated against the doc's OWN branch, so a doc can
// never be attached to another branch's sourcing effort.
router.put('/invoices/:id/supply-record', verify, loadInvoice, requireDocTypePermission('edit'), async (req, res) => {
  try {
    const doc    = req.misInvoice;
    const userId = req.user.id;
    const actorName = await getActorName(userId);

    const raw = req.body.supplyRecordId;
    const clearing = raw === null || raw === undefined || raw === '';
    const resolved = clearing ? null : await resolveSupplyRecordId(raw, doc.branchId);
    if (!clearing && !resolved) {
      return res.status(400).json({ message: 'Supply record not found in this branch' });
    }

    const updated = await MisInvoice.findOneAndUpdate(
      { _id: doc._id },
      { $set: { supplyRecordId: resolved, updateDate: new Date(), updatedBy: userId } },
      { new: true }
    ).lean();

    await logActivity(doc._id, doc.docType, 'updated', {
      field: 'supplyRecordId',
      oldValue: doc.supplyRecordId ? String(doc.supplyRecordId) : null,
      newValue: resolved ? String(resolved) : null,
      body: resolved ? 'Linked to a supply record' : 'Unlinked from its supply record',
    }, userId, actorName);

    return res.status(200).json({ data: updated });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
// exported for Session 43 (convert recompute) + tests; frontend util/money.js mirrors this
module.exports.computeTotals = computeTotals;
module.exports.nextDocNumber = nextDocNumber;
module.exports.logActivity   = logActivity;
