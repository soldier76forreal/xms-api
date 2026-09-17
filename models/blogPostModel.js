const mongoose = require('mongoose');

// Digital Marketing — Blog CMS (Phase C). One post record per article, authored
// in the DM "Blog" sub-section via a TipTap editor. Public read is served
// through api/routes/public/website.js's /blog routes (published only,
// same "never expose an unpublished/draft doc" rule as Inventory's website
// fields). Cover image + inline body images reuse the File Manager `files`
// collection (scope:'digitalMarketing', attachedTo:{type:'blogPost', id}) —
// no separate media store, same convention as every other DM sub-section.
const blogPostSchema = new mongoose.Schema({
  title:   { type: String, required: true, trim: true },
  titleAr: { type: String, default: '' },
  titleFa: { type: String, default: '' },

  excerpt:   { type: String, default: '' },
  excerptAr: { type: String, default: '' },
  excerptFa: { type: String, default: '' },

  // TipTap-authored HTML — sanitized server-side on write (see routes/digitalMarketing/blog.js).
  body:   { type: String, default: '' },
  bodyAr: { type: String, default: '' },
  bodyFa: { type: String, default: '' },

  slug: { type: String, unique: true, sparse: true },
  coverImage: {
    fileId:   { type: mongoose.Schema.Types.ObjectId, default: null },
    diskName: { type: String, default: null },
  },
  status: { type: String, enum: ['draft', 'published'], default: 'draft' },
  publishedAt: { type: Date, default: null },

  seo: {
    metaTitle: String, metaDescription: String,
    metaTitleAr: String, metaDescriptionAr: String,
    metaTitleFa: String, metaDescriptionFa: String,
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  createdByName: { type: String, default: '' },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: Date.now },
  deleteDate: { type: Date, default: null },
});

blogPostSchema.index({ status: 1, publishedAt: -1 });

module.exports = blogPostSchema;
