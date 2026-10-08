const mongoose = require('mongoose');

// Website product taxonomy cloned from WooCommerce product_cat/product_tag.
// This is intentionally separate from Inventory's internal categories/tags:
// website taxonomy is content/SEO/navigation data and can carry per-language
// labels, while Inventory categories remain variant classification.
const websiteProductTaxonomySchema = new mongoose.Schema({
  type: { type: String, enum: ['category', 'tag'], required: true, index: true },

  name:   { type: String, required: true, trim: true },
  nameAr: { type: String, default: '', trim: true },
  nameFa: { type: String, default: '', trim: true },

  slug:   { type: String, required: true, trim: true },
  slugAr: { type: String, default: '', trim: true },
  slugFa: { type: String, default: '', trim: true },

  description:   { type: String, default: '' },
  descriptionAr: { type: String, default: '' },
  descriptionFa: { type: String, default: '' },

  image: {
    url: { type: String, default: '' },
    attachmentId: { type: Number, default: null },
    alt: { type: String, default: '' },
  },

  source: {
    wordpressTermIds: [{ type: Number }],
    wordpressTermTaxonomyIds: [{ type: Number }],
    importedAt: { type: Date, default: null },
  },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: Date.now },
  deleteDate: { type: Date, default: null },
});

websiteProductTaxonomySchema.index(
  { type: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deleteDate: null } }
);

module.exports = websiteProductTaxonomySchema;
