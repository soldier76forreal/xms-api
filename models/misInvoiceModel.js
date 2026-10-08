const mongoose = require('mongoose');

// Phase 6 — MIS / Invoices. ONE collection for BOTH doc types, discriminated by
// docType (mirrors CRM customerType — do NOT fork two collections).
// NOTE: this intentionally does NOT reuse the legacy invoiceModel.js (old CNF/FOB
// concept, still required by jobReport/fileManager/users/socket/filters).
// Collection: 'misInvoices' (registered as dbConnection.model('misInvoice', schema)).

// One sold line — code/name/unit/unitPrice are a SNAPSHOT taken at add-time
// (issued documents are immutable history); productId/variantId stay only as
// soft refs powering the reverse lookups (product → its invoices).
const lineItemSchema = new mongoose.Schema({
  productId:    { type: mongoose.Schema.Types.ObjectId, index: true },   // soft ref → inventoryProduct
  variantId:    { type: mongoose.Schema.Types.ObjectId, index: true },   // soft ref → inventoryVariant
  code:         { type: String },                        // stone SKU snapshot (e.g. TR45Q10004018VFP)
  name:         { type: String, required: true },        // item/name snapshot
  unit:         { type: String, default: 'M2' },         // M2 / ML / PCS / …
  quantity:     { type: Number, required: true },
  unitPrice:    { type: Number, required: true },
  discount:     { type: Number, default: 0 },
  discountType: { type: String, enum: ['amount', 'percent'], default: 'amount' },
  vatRate:      { type: Number, default: 5 },            // % — per line, rolled up
  vatAmount:    { type: Number, default: 0 },            // computed server-side
  lineTotal:    { type: Number, default: 0 },            // computed server-side
  // Session 72 — a cross-branch line can be sourced from the target branch's
  // real Inventory (unchanged default) OR its in-progress Supply (a deal
  // letter's forecast/final variety). Supply-sourced lines are excluded from
  // stock-overage checks and stock decrement (nothing in real InvVariant.quantity
  // backs them yet — see routes/mis/invoices.js).
  sourceType:        { type: String, enum: ['inventory', 'supply'], default: 'inventory' },
  supplyDealLetterId:{ type: mongoose.Schema.Types.ObjectId },   // soft ref → supplyDealLetter, set only when sourceType==='supply'
}, { _id: false });

// Packing-list row (invoice page 2) — the PHYSICAL cut pieces that the nominal
// stone code doesn't capture (e.g. Ma01Q00000020 unsized slab → 240×180×2, 4 pcs).
const packingRowSchema = new mongoose.Schema({
  no:          { type: Number },
  pallet:      { type: String },
  productName: { type: String },
  length:      { type: Number },
  width:       { type: Number },
  pcs:         { type: Number },
  thickness:   { type: Number },
  sqm:         { type: Number },
  notes:       { type: String },
}, { _id: false });

const misInvoiceSchema = new mongoose.Schema({
  // Branches are fully isolated catalogs — every invoice/pre-invoice belongs to
  // exactly one branch; docNumber sequences are per-branch (see invoiceCounters).
  branchId:  { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  docType:   { type: String, enum: ['invoice', 'pre_invoice'], required: true, index: true },
  docNumber: { type: Number, required: true },           // per-type atomic sequence (invoiceCounters $inc)

  // Session 72 — inter-branch trading. `branchId` above stays the FULFILLING/
  // target branch (owns docNumber sequence, template, company-profile settings
  // — unchanged semantics). `requestingBranchId` is the NEW initiating/buyer
  // branch, only set when tradeMode==='interBranch'. A 'customer' doc is
  // unchanged in every way (default value, no new fields populated).
  tradeMode: { type: String, enum: ['customer', 'interBranch'], default: 'customer', index: true },
  requestingBranchId: { type: mongoose.Schema.Types.ObjectId, index: true },
  requestingBranchSnapshot: {
    name: { type: String },   // immutable snapshot, same principle as customerSnapshot
  },

  // Optional link to a Supply record, so the commercial documents raised
  // against one sourcing effort can be found from it (and vice versa). A soft
  // ref, same discipline as customerId: the doc keeps its own immutable
  // snapshots and does not read back through this link when rendering.
  // Many invoices/quotations → one supply record; set either at creation or by
  // assigning an existing doc (PUT /mis/invoices/:id/supply-record).
  supplyRecordId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

  // "Send to" assignment — one or more users this doc has been handed to for
  // follow-up. Lets a 'mine'-scoped or view-only user still see a doc they
  // didn't create, as long as they're an assignee (see the scope filter).
  assignedTo:   [{ type: mongoose.Schema.Types.ObjectId }],
  assignedBy:   { type: mongoose.Schema.Types.ObjectId },
  assignedByName: { type: String },              // snapshot — recipients see who sent it without a user lookup
  assignedAt:   { type: Date },
  status: {
    type: String,
    // pre_invoice: draft → sent → accepted → converted | expired (expired derived from issueDate+validityDays)
    // invoice:     draft → issued → paid | partially_paid | cancelled
    // 'requested' is the entry state for a cross-branch stock REQUEST: the
    // requesting branch raises it, the target branch's MIS operator reviews it
    // and moves it on (sent/accepted/converted) exactly like any other quote.
    enum: ['requested',
           'draft', 'sent', 'accepted', 'converted', 'expired',
           'issued', 'paid', 'partially_paid', 'cancelled'],
    default: 'draft',
    index: true,
  },
  issueDate: { type: Date, required: true, default: Date.now },
  issueTime: { type: String },                           // optional HH:mm as printed
  printDate: { type: Date },

  // Customer — CRM ref + immutable snapshot captured at issue-time.
  // Required for invoices (goods need a destination); optional for pre-invoices/
  // quotes, which can be drafted before a customer is confirmed.
  customerId:       { type: mongoose.Schema.Types.ObjectId, index: true },
  customerSnapshot: {
    name:    { type: String },
    trn:     { type: String },                           // customer VAT no. (ب.ضـ)
    country: { type: String },
    phone:   { type: String },
    address: { type: String },
  },

  lineItems: [lineItemSchema],

  currency:      { type: String, default: 'AED' },
  // Totals computed SERVER-SIDE and stored, so list + PDF never recompute divergently. 2dp (fils).
  subtotal:      { type: Number, default: 0 },           // الاجمالي
  discountTotal: { type: Number, default: 0 },           // الخصم
  vatTotal:      { type: Number, default: 0 },           // الضريبة
  shipping:      { type: Number, default: 0 },           // مصاريف الشحن — invoice only
  grandTotal:    { type: Number, default: 0 },           // المطلوب

  // ── invoice-only ──────────────────────────────────────────────────────────
  payment: {
    cash:           { type: Number, default: 0 },        // نقدي
    chequeBank:     { type: Number, default: 0 },        // شيك / بنك
    card:           { type: Number, default: 0 },        // بطاقة مدفوعات
    remaining:      { type: Number, default: 0 },        // الباقي
    currentBalance: { type: Number, default: 0 },        // الرصيد الحالي
    balanceSign:    { type: String, enum: ['debit', 'credit'], default: 'debit' },  // مدين / دائن
  },
  amountInWords: { type: String },                       // المبلغ بالحروف — Arabic, from grandTotal
  salesRepId:    { type: mongoose.Schema.Types.ObjectId },
  salesRepName:  { type: String },                       // مسؤول المبيعات
  packingList: {
    rows:        [packingRowSchema],
    totalPcs:    { type: Number },
    totalSqm:    { type: Number },
    truckNumber: { type: String },                       // رقم الشاحنة
    driverName:  { type: String },                       // اسم السائق
    driverMobile:{ type: String },                       // رقم الموبايل
  },
  // Issue-time stock decrement (opted in 2026-07-03): set once the issue path has
  // decremented the matching inventory variants + written inventoryChangeLogs,
  // so re-issuing / re-saving never double-decrements.
  stockDecremented: { type: Boolean, default: false },

  // ── pre-invoice-only ──────────────────────────────────────────────────────
  validityDays: { type: Number },                        // "valid for N days from its date"

  // ── website price-request offers ──────────────────────────────────────────
  // A quotation raised in answer to a customer's website purchase request
  // (utils/websiteOffers.js). It is the SAME misInvoice doc as any other
  // quotation — these three fields are all that mark it. `validUntil` is an
  // absolute expiry (hours matter here, days don't): while the status is 'sent'
  // the customer can accept it on the website until then, which converts it into
  // an invoice (the invoice carries the same priceRequestId, so the customer
  // sees both on their dashboard). Customer-visible documents are ONLY those
  // with a priceRequestId.
  priceRequestId:     { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  validUntil:         { type: Date, default: null },
  validUntilTz:       { type: String },                  // IANA zone the expiry is printed in (the branch's clock)
  customerAcceptedAt: { type: Date, default: null },

  // ── conversion links ──────────────────────────────────────────────────────
  convertedToInvoiceId:      { type: mongoose.Schema.Types.ObjectId },
  convertedFromPreInvoiceId: { type: mongoose.Schema.Types.ObjectId },

  notes: { type: String },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date },
  deleteDate: { type: Date, default: null },
  createdBy:  { type: mongoose.Schema.Types.ObjectId },
  updatedBy:  { type: mongoose.Schema.Types.ObjectId },
});

// docNumber is unique PER BRANCH PER TYPE among live docs (soft-deleted numbers
// stay burned — counters never rewind, so no reuse; partial index keeps legacy
// imports safe). Branches are fully isolated, so two branches independently
// have their own "#1", "#2", etc.
misInvoiceSchema.index(
  { branchId: 1, docType: 1, docNumber: 1 },
  { unique: true, partialFilterExpression: { deleteDate: null } }
);
misInvoiceSchema.index({ 'lineItems.productId': 1 });    // product → invoices reverse lookup
misInvoiceSchema.index({ customerId: 1, issueDate: -1 }); // CRM Requests tab
misInvoiceSchema.index({ issueDate: -1 });
misInvoiceSchema.index({ assignedTo: 1 });                // assignee lookup (user detail, scope check)
misInvoiceSchema.index({ requestingBranchId: 1 });         // Session 72 — so the requesting branch's MIS list can find its own cross-branch docs

module.exports = misInvoiceSchema;
