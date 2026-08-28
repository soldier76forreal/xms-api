const mongoose = require('mongoose');

// Digital Marketing — External Link Pages. A small public "link in bio" page
// (cover image + company name + a list of contact links) a rep hands out to a
// customer who has no XMS account — resolved via GET /public/link-pages/:code,
// deliberately unauthenticated (see routes/digitalMarketing/main.js). `code`
// is its own generator, NOT utils/shortLink.js — that system is the internal,
// auth-gated one (its resolver bounces a logged-out visitor to /logIn), and
// this page must not inherit that behavior.
//
// Not personal/one-per-user — any permitted user can create any number of
// pages (a branch, a campaign, a showroom...). `restrictToOwner` is an
// opt-in per-record override: when true, only the creator (or a superAdmin)
// may edit/delete it, regardless of what their role's dataScope would
// otherwise allow — see the PUT/DELETE routes.

const linkEntrySchema = new mongoose.Schema({
  type:  { type: String, enum: ['whatsapp', 'whatsappChannel', 'telegram', 'phone', 'email', 'website', 'address', 'other'], required: true },
  label: { type: String, default: '' },   // mainly for 'other'
  value: { type: String, required: true },
}, { _id: false });
// `links` is a plain array — Mongoose/Mongo preserve array order as written,
// so drag/reorder in the form is purely a frontend concern (send the array in
// the order it should render); no ordinal field needed here.

const externalLinkPageSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },

  // Fixed at creation/edit time by whoever builds the page — the PUBLIC page
  // renders in this language always, for every visitor (no per-visitor
  // switcher: a random customer has no account/preference to honor, and a
  // switcher was a worse fit than just picking the right language up front).
  language: { type: String, enum: ['en', 'fa', 'ar'], default: 'en' },

  companyName: { type: String, required: true },
  coverImage: {
    fileId:   { type: mongoose.Schema.Types.ObjectId, default: null },
    diskName: { type: String, default: null },
    name:     { type: String, default: null },
    mimetype: { type: String, default: null },
  },
  links: [linkEntrySchema],

  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  restrictToOwner: { type: Boolean, default: false },

  owner:         { type: mongoose.Schema.Types.ObjectId },
  createdBy:     { type: mongoose.Schema.Types.ObjectId },
  createdByName: { type: String },
  updatedBy:     { type: mongoose.Schema.Types.ObjectId },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
  deleteDate: { type: Date, default: null },
});

externalLinkPageSchema.index({ insertDate: -1 });
externalLinkPageSchema.index({ owner: 1 });

module.exports = externalLinkPageSchema;
