const mongoose = require('mongoose');

// Digital Marketing -> Product Content.
// One record per canonical product code (MA01/TR48/...), independent of branch.
// Live branch availability is resolved from Inventory at read time by code.
const websiteProductContentSchema = new mongoose.Schema({
  code: { type: String, required: true, uppercase: true, trim: true, index: true },

  title:   { type: String, required: true, trim: true },
  titleAr: { type: String, default: '', trim: true },
  titleFa: { type: String, default: '', trim: true },

  excerpt:   { type: String, default: '' },
  excerptAr: { type: String, default: '' },
  excerptFa: { type: String, default: '' },

  body:   { type: String, default: '' },
  bodyAr: { type: String, default: '' },
  bodyFa: { type: String, default: '' },

  slug:   { type: String, required: true, trim: true },
  slugAr: { type: String, default: '', trim: true },
  slugFa: { type: String, default: '', trim: true },

  status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
  publishedAt: { type: Date, default: null },

  categories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'websiteProductTaxonomy' }],
  tags:       [{ type: mongoose.Schema.Types.ObjectId, ref: 'websiteProductTaxonomy' }],

  gallery: [{
    url: { type: String, default: '' },
    attachmentId: { type: Number, default: null },
    alt: { type: String, default: '' },
    order: { type: Number, default: 0 },
  }],

  seo: {
    metaTitle: String, metaDescription: String,
    metaTitleAr: String, metaDescriptionAr: String,
    metaTitleFa: String, metaDescriptionFa: String,
  },

  source: {
    wordpressIds: {
      en: { type: Number, default: null },
      ar: { type: Number, default: null },
      fa: { type: Number, default: null },
    },
    wordpressSkus: [{ type: String }],
    needsCodeMapping: { type: Boolean, default: false },
    importedAt: { type: Date, default: null },
    importedFrom: { type: String, default: '' },
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
  createdByName: { type: String, default: '' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: Date.now },
  deleteDate: { type: Date, default: null },
});

websiteProductContentSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { deleteDate: null, code: { $type: 'string' } } }
);
websiteProductContentSchema.index(
  { slug: 1 },
  { unique: true, partialFilterExpression: { deleteDate: null, slug: { $type: 'string' } } }
);
websiteProductContentSchema.index({ status: 1, code: 1 });

module.exports = websiteProductContentSchema;
