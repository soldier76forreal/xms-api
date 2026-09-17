const mongoose = require('mongoose');

const inventoryProductSchema = new mongoose.Schema({
  // Branches are fully isolated catalogs — every product belongs to exactly
  // one branch; the same code CAN repeat across different branches (the
  // unique index below is scoped per-branch, not global).
  branchId:      { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  code:          { type: String, required: true, uppercase: true, trim: true },
  stoneType:     { type: String, required: true, uppercase: true, trim: true },
  stoneTypeName: { type: String, trim: true },
  quarryCode:    { type: String, required: true, trim: true },
  quarryName:    { type: String, trim: true },
  name:          { type: String, trim: true },
  nameAr:        { type: String, trim: true },
  nameFa:        { type: String, trim: true },
  description:   { type: String, trim: true },   // English website description
  descriptionAr: { type: String, trim: true },
  descriptionFa: { type: String, trim: true },
  category:      { type: String, trim: true },
  defaultUnit:   { type: String, enum: ['M2', 'ML', 'PCS', 'SQFT', 'LNFT'], default: 'M2' },
  coverMediaId:  { type: mongoose.Schema.Types.ObjectId, default: null },
  coverThumbnail: { type: String, default: null },  // denormalized thumbnail filename for list-page display
  status:        { type: String, enum: ['active', 'archived'], default: 'active' },
  totalsByUnit:  { type: mongoose.Schema.Types.Mixed, default: {} },
  variantCount:  { type: Number, default: 0 },
  priceRange: {
    min:      { type: Number, default: null },
    max:      { type: Number, default: null },
    currency: { type: String, default: 'AED' },
  },
  // Public website surface (added for the WordPress→Inventory merge) — kept
  // as its own subdocument rather than flat fields so "is this product on the
  // website, and how" stays visually and logically separate from the
  // descriptive/stock fields above. NOTHING here is ever price — price stays
  // app-only, enforced by the public API's field whitelist (api/utils/publicWebsite.js),
  // not by this schema.
  website: {
    published: { type: Boolean, default: false },
    // Sparse: an unpublished product needs no slug, and letting many docs share
    // slug:null would violate a plain unique index — sparse skips null entirely.
    slug: { type: String, trim: true, unique: true, sparse: true },
    gallery: [{
      fileId:   { type: mongoose.Schema.Types.ObjectId },
      diskName: { type: String },
      order:    { type: Number, default: 0 },
    }],
    tags: [{ type: mongoose.Schema.Types.ObjectId, ref: 'inventoryTag' }],
    seo: {
      metaTitle:       { type: String, trim: true },
      metaDescription: { type: String, trim: true },
      metaTitleAr:       { type: String, trim: true },
      metaDescriptionAr: { type: String, trim: true },
      metaTitleFa:       { type: String, trim: true },
      metaDescriptionFa: { type: String, trim: true },
    },
    // Long-form SEO content shown on the public product page, matching the
    // real production site's per-product template (Introduction / Key
    // Features / Applications / Why Choose Us / Care & Maintenance /
    // Conclusion). Each is TipTap-authored HTML, sanitized on write (same
    // utils/sanitizeHtml.js used for the Blog CMS) — content itself is a
    // separate migration pass, this just gives it a home.
    content: {
      introduction:   { type: String, default: '' },
      introductionAr: { type: String, default: '' },
      introductionFa: { type: String, default: '' },
      features:   { type: String, default: '' },
      featuresAr: { type: String, default: '' },
      featuresFa: { type: String, default: '' },
      applications:   { type: String, default: '' },
      applicationsAr: { type: String, default: '' },
      applicationsFa: { type: String, default: '' },
      whyUs:   { type: String, default: '' },
      whyUsAr: { type: String, default: '' },
      whyUsFa: { type: String, default: '' },
      careTips:   { type: String, default: '' },
      careTipsAr: { type: String, default: '' },
      careTipsFa: { type: String, default: '' },
      conclusion:   { type: String, default: '' },
      conclusionAr: { type: String, default: '' },
      conclusionFa: { type: String, default: '' },
    },
  },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
  deleteDate: { type: Date, default: null },
  createdBy:  { type: mongoose.Schema.Types.ObjectId },
  updatedBy:  { type: mongoose.Schema.Types.ObjectId },
});

inventoryProductSchema.index({ 'website.published': 1 });

// Code is unique WITHIN a branch, not globally — different branches can reuse the same code.
inventoryProductSchema.index({ branchId: 1, code: 1 }, { unique: true });

module.exports = inventoryProductSchema;
