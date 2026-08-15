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

const verify = require('../users/verifyToken');
const { requirePermission, getEffectivePermissions, getEffectiveScopes, Group, requireBranch, assertBranchAccess, getUserBranches, isSuperAdmin } = require('../../utils/rbac');
const { renderInvoiceHtml } = require('../../utils/invoiceTemplate');
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
const InvoiceActivity = dbConnection.models.invoiceActivity || dbConnection.model('invoiceActivity', invoiceActivitySchema);
const Customer        = dbConnection.models.customer         || dbConnection.model('customer',         customerSchema);
const User            = dbConnection.models.user             || dbConnection.model('user',             userSchema);
const InvProduct      = dbConnection.models.inventoryProduct || dbConnection.model('inventoryProduct', inventoryProductSchema);
const InvVariant      = dbConnection.models.inventoryVariant || dbConnection.model('inventoryVariant', inventoryVariantSchema);
const InvChangeLog    = dbConnection.models.inventoryChangeLog || dbConnection.model('inventoryChangeLog', inventoryChangeLogSchema);

const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

// Valid status sets per docType (spec lifecycles — light, append later if needed)
const STATUS_SETS = {
  pre_invoice: ['draft', 'sent', 'accepted', 'converted', 'expired'],
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
    if (!li.variantId) continue;
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

// Loads the (live) doc onto req.misInvoice so the docType-aware guard can run
// BEFORE the handler. 404s early for missing/soft-deleted docs.
// Single chokepoint for every :id route (detail/update/delete/html/pdf/convert/
// payment) — row-level scope enforced HERE so all seven inherit it from one edit.
async function loadInvoice(req, res, next) {
  try {
    const doc = await MisInvoice.findOne({ _id: req.params.id, deleteDate: null });
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    if (!(await assertBranchAccess(req.user.id, doc.branchId))) {
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

// Singleton settings doc (upserted so it always exists)
async function loadProfile() {
  return CompanyProfile.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
}

// ── puppeteer (installed with PUPPETEER_SKIP_DOWNLOAD — bundled Chromium
// download was blocked, so we launch the SYSTEM Chrome/Edge instead).
// Lazy singleton: one headless browser, launched on first PDF, reused after.
const fs = require('fs');
let _browserPromise = null;

function resolveChromePath() {
  // IMPORTANT: never fall back to snap-packaged Chromium. Snap confinement breaks
  // Chrome's DevTools pipe so the browser launches but hangs at
  // "Target.setDiscoverTargets timed out" during the CDP handshake. On Ubuntu
  // BOTH /snap/bin/chromium AND /usr/bin/chromium[-browser] are usually snap
  // wrappers, so we only accept a real .deb Google Chrome here; otherwise we
  // return null and let Puppeteer use its OWN managed Chromium (install it on the
  // server with:  npx puppeteer browsers install chrome).
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,             // explicit override wins
    'C:/Program Files/Google/Chrome/Application/chrome.exe',        // local dev (win)
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome-stable',   // real .deb Chrome (apt install google-chrome-stable)
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null; // → Puppeteer's own managed Chromium (never snap)
}

function getBrowser() {
  if (!_browserPromise) {
    // puppeteer v25 is ESM-only — dynamic import() is the CommonJS-safe way in
    const executablePath = resolveChromePath();
    _browserPromise = import('puppeteer')
      .then((mod) => (mod.default || mod).launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        // Default WebSocket transport (NOT pipe). pipe:true got Chrome to launch
        // but then hung the CDP handshake ("Target.setDiscoverTargets timed out")
        // on this server — the DevTools pipe fds don't complete here. The
        // original reason for pipe (a snap-Chromium WS-endpoint timeout) is gone
        // now that a real, non-snap Chrome is installed, so standard WS works.
        timeout: 90000,
        protocolTimeout: 180000,
        // --disable-dev-shm-usage: default /dev/shm is too small on most VPS/
        // containers; --disable-gpu is standard for headless servers. This is the
        // standard, widely-proven server arg set — no exotic flags.
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      }))
      .then((browser) => {
        // If the shared browser dies (crash / lost pipe), drop the cached promise
        // so the NEXT render relaunches a fresh one instead of reusing a dead
        // handle — a dead singleton was 500ing ("Failed to generate PDF") on
        // every subsequent request even though the first one had downloaded fine.
        browser.on('disconnected', () => { _browserPromise = null; });
        return browser;
      })
      .catch((err) => { _browserPromise = null; throw err; });
  }
  return _browserPromise;
}

async function renderPdfBuffer(html) {
  // Retry once with a fresh browser: if the shared instance died between renders
  // the first newPage/pdf call throws "Target/Protocol closed" — relaunch and
  // try again so a transient browser death doesn't surface as a failed download.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      // 'load' not 'networkidle0' — the template is fully inline (no external
      // resources; CSP-safe), and networkidle0 is known to hang with setContent
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      await page.close().catch(() => {});
      return pdf;
    } catch (err) {
      lastErr = err;
      if (page) await page.close().catch(() => {});
      _browserPromise = null;   // force a clean relaunch on the retry
    }
  }
  throw lastErr;
}

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

async function issueStockDecrement(doc, userId, actorName) {
  const skipped = [];
  const touchedProducts = new Set();

  for (const li of (doc.lineItems || [])) {
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
      reason:      `Invoice #${doc.docNumber}`,
      source:      'order',
      changedBy:   userId,
      changedByName: actorName,
      date: new Date(), createdAt: new Date(),
    });
    touchedProducts.add(String(variant.productId));
  }

  for (const pid of touchedProducts) await recomputeRollup(pid);

  await MisInvoice.updateOne({ _id: doc._id }, { $set: { stockDecremented: true } });
  await logActivity(doc._id, doc.docType, 'stock_decremented', {
    body: skipped.length ? `No variant (skipped): ${skipped.join(', ')}` : undefined,
    newValue: doc.lineItems.filter(l => l.variantId).length,
  }, userId, actorName);
}

// Reverse of issueStockDecrement — used on delete when the caller opts to put
// the sold quantity back. Only meaningful if the doc actually decremented stock
// (stockDecremented guard). Adds each variant line's quantity back + writes a
// balancing inventoryChangeLog row (positive delta) + recomputes the rollup.
async function restoreStock(doc, userId, actorName) {
  if (!doc.stockDecremented) return;
  const touchedProducts = new Set();

  for (const li of (doc.lineItems || [])) {
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
      reason:      `Invoice #${doc.docNumber} deleted — stock restored`,
      source:      'correction',
      changedBy:   userId,
      changedByName: actorName,
      date: new Date(), createdAt: new Date(),
    });
    touchedProducts.add(String(variant.productId));
  }

  for (const pid of touchedProducts) await recomputeRollup(pid);
  await MisInvoice.updateOne({ _id: doc._id }, { $set: { stockDecremented: false } });
  await logActivity(doc._id, doc.docType, 'stock_restored', {
    newValue: doc.lineItems.filter(l => l.variantId).length,
  }, userId, actorName);
}

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

// ── GET/PUT /mis/company-profile — template header settings ───────────────────
router.get('/company-profile', verify, requirePermission('mis:view'), async (req, res) => {
  try {
    // Singleton — upsert the default doc on first read so the settings editor
    // always has something to edit (values then maintained via PUT).
    const profile = await CompanyProfile.findOneAndUpdate(
      { key: 'default' },
      { $setOnInsert: { key: 'default' } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    return res.status(200).json(profile);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/company-profile', verify, requirePermission('mis:settings:edit'), async (req, res) => {
  try {
    const allowed = ['nameAr', 'nameEn', 'phones', 'email', 'website', 'trn',
                     'branchAddressAr', 'logoFileId', 'bank', 'vatRate',
                     'thankYouNoteAr', 'quotationValidityDefaultDays'];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];
    update.updateDate = new Date();
    update.updatedBy  = req.user.id;

    const profile = await CompanyProfile.findOneAndUpdate(
      { key: 'default' },
      { $set: update },
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
      page = 1, limit = 30,
    } = req.query;

    const filters = [];

    // the three tabs — Invoice / Pre-invoice / All
    if (docType === 'invoice' || docType === 'pre_invoice') filters.push({ docType });

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
    if (scopeFilter) filters.push(scopeFilter);

    const query = { branchId: req.branchId, deleteDate: null };
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
    const activity = await InvoiceActivity.find({ invoiceId: req.misInvoice._id })
      .sort({ date: -1 })
      .limit(50)
      .lean();
    return res.status(200).json({ ...req.misInvoice.toObject(), activity });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── POST /mis/invoices — create (counter + snapshot + totals + activity) ──────
router.post('/invoices', verify, requireDocTypePermission('create'), requireBranch(), async (req, res) => {
  try {
    const userId   = req.user.id;
    const docType  = req.body.docType;
    const branchId = req.branchId;

    // basic validation — customer is required for invoices (goods need a
    // destination) but OPTIONAL for pre-invoices/quotes (can be drafted before
    // a customer is confirmed)
    const hasCustomerId = req.body.customerId && mongoose.Types.ObjectId.isValid(req.body.customerId);
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

    // default quote validity from companyProfile when not provided
    let validityDays = req.body.validityDays;
    if (docType === 'pre_invoice' && (validityDays === undefined || validityDays === null)) {
      const profile = await CompanyProfile.findOne({ key: 'default' }).lean();
      validityDays = (profile && profile.quotationValidityDefaultDays) || 2;
    }

    const doc = await MisInvoice.create({
      branchId,
      docType,
      docNumber: await nextDocNumber(branchId, docType),   // atomic, per-branch, server-assigned
      status,
      issueDate: req.body.issueDate ? new Date(req.body.issueDate) : new Date(),
      issueTime: req.body.issueTime,
      customerId: hasCustomerId ? req.body.customerId : undefined,
      customerSnapshot,
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
      packingList:  docType === 'invoice' ? req.body.packingList  : undefined,
      // pre-invoice-only
      validityDays: docType === 'pre_invoice' ? validityDays : undefined,
      notes: req.body.notes,
      insertDate: new Date(),
      createdBy: userId,
    });

    const actorName = await getActorName(userId);
    await logActivity(doc._id, docType, 'created', { newValue: doc.docNumber }, userId, actorName);

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

    // status transition (validated per docType, logged separately)
    if (req.body.status && req.body.status !== doc.status) {
      if (!STATUS_SETS[doc.docType].includes(req.body.status)) {
        return res.status(400).json({ message: 'Invalid status for this document type' });
      }
      update.status = req.body.status;
      await logActivity(doc._id, doc.docType, 'status',
        { field: 'status', oldValue: doc.status, newValue: req.body.status }, userId, actorName);

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
      if (req.body.packingList  !== undefined) update.packingList  = req.body.packingList;
    } else if (req.body.validityDays !== undefined) {
      update.validityDays = req.body.validityDays;
    }

    update.updateDate = new Date();
    update.updatedBy  = userId;

    const updated = await MisInvoice.findOneAndUpdate(
      { _id: doc._id }, { $set: update }, { new: true }
    ).lean();

    await logActivity(doc._id, doc.docType, 'updated', {}, userId, actorName);

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
    const wantsRestore = doc.stockDecremented &&
      (req.query.restoreStock === 'true' || req.body.restoreStock === true);
    if (wantsRestore) {
      const perms = await getEffectivePermissions(userId);
      if (!perms.has('inventory:quantity:edit')) {
        return res.status(403).json({
          message: 'Restoring stock requires the inventory quantity permission',
          requiredPermission: 'inventory:quantity:edit',
        });
      }
      await restoreStock(doc, userId, actorName);
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
    const profile = await loadProfile();
    const html = renderInvoiceHtml(req.misInvoice.toObject(), profile, req.query.lang);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /mis/invoices/:id/pdf — final export (own key, NOT gated by :edit) ────
router.get('/invoices/:id/pdf', verify, loadInvoice, requireDocTypePermission('pdf'), async (req, res) => {
  try {
    const doc     = req.misInvoice;
    const profile = await loadProfile();
    const html    = renderInvoiceHtml(doc.toObject(), profile, req.query.lang);
    const pdf     = await renderPdfBuffer(html);

    const userId    = req.user.id;
    const actorName = await getActorName(userId);
    await logActivity(doc._id, doc.docType, 'pdf_generated', { newValue: doc.docNumber }, userId, actorName);

    const prefix = doc.docType === 'invoice' ? 'invoice' : 'quotation';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${prefix}-${doc.docNumber}.pdf"`);
    return res.status(200).end(pdf);
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

    const userId    = req.user.id;
    const actorName = await getActorName(userId);

    // copy lines + customer; recompute totals as an invoice (shipping starts 0)
    const totals = computeTotals(pre.lineItems.map(l => l.toObject ? l.toObject() : l), 0);

    const invoice = await MisInvoice.create({
      branchId: pre.branchId,                              // converted invoice stays in the pre-invoice's branch
      docType: 'invoice',
      docNumber: await nextDocNumber(pre.branchId, 'invoice'),   // NEW per-branch invoice number
      status: 'draft',
      issueDate: new Date(),
      customerId: pre.customerId,
      customerSnapshot: pre.customerSnapshot,
      lineItems: totals.lines,
      currency: 'AED',
      subtotal:      totals.subtotal,
      discountTotal: totals.discountTotal,
      vatTotal:      totals.vatTotal,
      shipping:      0,
      grandTotal:    totals.grandTotal,
      amountInWords: amountToArabicWords(totals.grandTotal),
      convertedFromPreInvoiceId: pre._id,
      notes: pre.notes,
      insertDate: new Date(),
      createdBy: userId,
    });

    await MisInvoice.updateOne(
      { _id: pre._id },
      { $set: { status: 'converted', convertedToInvoiceId: invoice._id, updateDate: new Date(), updatedBy: userId } }
    );

    await logActivity(pre._id, 'pre_invoice', 'converted',
      { newValue: invoice.docNumber }, userId, actorName);
    await logActivity(invoice._id, 'invoice', 'created',
      { body: `Converted from pre-invoice #${pre.docNumber}`, newValue: invoice.docNumber }, userId, actorName);

    return res.status(201).json(invoice);
  } catch (err) {
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

module.exports = router;
// exported for Session 43 (convert recompute) + tests; frontend util/money.js mirrors this
module.exports.computeTotals = computeTotals;
module.exports.nextDocNumber = nextDocNumber;
module.exports.logActivity   = logActivity;
