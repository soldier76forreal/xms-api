const mongoose = require('mongoose');

// A deal letter tracks ONE coupe (raw stone block) purchase through
// Purchasing -> Processing -> Final product for a supply record. Multiple
// deal letters can exist under one supply record (e.g. re-buying the same
// product's coupe over time). Line-level forecast/final quantities and price
// live on varietyLines, one row per InvVariant (full SKU) under the supply
// record's productId.
const dealLetterVarietyLineSchema = new mongoose.Schema({
  variantId:   { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'inventoryVariant' },
  variantCode: { type: String, trim: true },   // snapshot
  unit:        { type: String, trim: true },   // snapshot (M2/ML/PCS/SQFT/LNFT)
  // "Forecasted Stone Production Volume" for this variety.
  forecastQty: { type: Number, default: 0 },
  // Must be set (non-null) on every line before status can advance to
  // 'final_product' — enforced in routes/supply/main.js, not here.
  finalQty:    { type: Number, default: null },
  // Per-variety price, updateable at any stage of the deal letter.
  price:       { type: Number, default: null },
  currency:    { type: String, default: 'AED' },
  // Cumulative amount already moved into real InvVariant.quantity via the
  // "receive into warehouse" action — never exceeds finalQty.
  receivedQty: { type: Number, default: 0 },
  // Promised to accepted quotations / requests (and paid invoices) that were
  // raised against this lot. It's no longer available: "left in the lot" is
  // (final or forecast) − received − allocated, Inventory's forecast figures
  // leave it out, and receiving never pulls it into sellable stock. Moved
  // only by routes/mis/invoices.js's commitStock / releaseStock.
  allocatedQty: { type: Number, default: 0 },

  // ── printed-contract columns (قرارداد فروش سنگ) ───────────────────────────
  // The deal letter prints as the real stone sales contract, whose order table
  // is نوع سنگ / تعداد / عرض / طول / متر مربع / فی / مبلغ کل. These are
  // SNAPSHOTS seeded from the variant (code + spec dimensions) at write time
  // and editable afterwards — a signed contract keeps the figures as they were
  // agreed rather than re-reading live Inventory. متر مربع and مبلغ کل are NOT
  // stored: the template derives them from the quantity and price already on
  // the line, so there is one source of truth for the money.
  stoneTypeLabel: { type: String, trim: true },     // نوع سنگ — defaults to variantCode
  count:          { type: Number, default: null },  // تعداد (pieces)
  widthCm:        { type: Number, default: null },  // عرض
  lengthCm:       { type: Number, default: null },  // طول
}, { _id: false });

const supplyDealLetterSchema = new mongoose.Schema({
  supplyId:  { type: mongoose.Schema.Types.ObjectId, required: true, index: true, ref: 'supplyRecord' },
  branchId:  { type: mongoose.Schema.Types.ObjectId, required: true, index: true },   // denormalized from supplyRecord
  productId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },   // denormalized — varietyLines must belong to this product
  coupeSpec: { type: String, trim: true },   // stone coupe specification, free text
  coupeSeller: {
    customerId: { type: mongoose.Schema.Types.ObjectId, default: null },   // optional soft ref -> CRM customer, if already a known contact
    name:  { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    notes: { type: String, trim: true },
  },
  status: { type: String, enum: ['purchasing', 'processing', 'final_product'], default: 'purchasing', index: true },
  varietyLines: [dealLetterVarietyLineSchema],

  // ── the printed contract (قرارداد فروش سنگ) ───────────────────────────────
  // Everything the signed document carries that isn't already modelled above.
  // All optional: a deal letter is usable as an internal tracking record long
  // before anyone prints a contract from it, and every pre-existing deal letter
  // simply has this unset.
  contract: {
    number: { type: String, trim: true },            // شماره
    date:   { type: Date, default: null },           // تاریخ

    // فروشنده — who is selling. In the supply flow this is the coupe seller;
    // left free-text because the counterparty on paper is not always the same
    // legal entity as the CRM contact.
    seller: {
      party:        { type: String, trim: true },    // این قرارداد از طرف
      addressPhone: { type: String, trim: true },    // نشانی و تلفن فروشنده
    },

    // خریدار — who is buying, plus the نمایندگی و شناسه block.
    buyer: {
      name:          { type: String, trim: true },   // جهت فروش سنگ به آقاي/خانم/شرکت
      position:      { type: String, trim: true },   // به سمت
      representedBy: { type: String, trim: true },   // به نمایندگی
      onBehalfOf:    { type: String, trim: true },   // به نمایندگی از
      nationalId:    { type: String, trim: true },   // داراي کد ملی/اقتصادي
      addressPhone:  { type: String, trim: true },   // نشانی و تلفن خریدار
    },

    // The contract is priced in Rial, unlike the rest of Supply (AED default).
    currency:     { type: String, default: 'IRR' },
    // جمع به حروف — auto-derived from the line totals, overridable, because the
    // spelled-out amount is the legally binding figure on a signed contract.
    totalInWords: { type: String, trim: true },
    paymentTerms: { type: String, trim: true },      // نحوه پرداخت

    // Blanks that appear inside the numbered articles themselves.
    guarantee:      { type: String, trim: true },    // ماده ۵ — ضمانت خریدار
    validityDays:   { type: Number, default: 3 },    // ماده ۳ — printed default is 3 days
    settlementDays: { type: Number, default: null }, // ماده ۱۲
    loadingDays:    { type: Number, default: null }, // ماده ۱۳
  },
  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
  deleteDate: { type: Date, default: null },
  createdBy:  { type: mongoose.Schema.Types.ObjectId },
  updatedBy:  { type: mongoose.Schema.Types.ObjectId },
});

supplyDealLetterSchema.index({ supplyId: 1 });
supplyDealLetterSchema.index({ branchId: 1, status: 1 });
supplyDealLetterSchema.index({ 'varietyLines.variantId': 1 });
supplyDealLetterSchema.index({ productId: 1 });

module.exports = supplyDealLetterSchema;
