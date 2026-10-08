const mongoose = require('mongoose');

// A short-lived copy of a product page as it is being edited in Digital Marketing,
// so the REAL website page can show it before (or without) publishing: the editor
// posts its form here, gets a random token, and opens the website's own product
// page with ?xms-preview=<token>. The page then reads this document instead of the
// published record (GET /public/website/preview/:token).
//
// The token is the only secret - 144 random bits, never listed, never guessable -
// and the document deletes itself (TTL on expiresAt), so a preview of an
// unpublished product is not a standing public URL.
const websiteProductPreviewSchema = new mongoose.Schema({
  token:     { type: String, required: true, unique: true, index: true },
  // what the page needs: code, title/excerpt/body/slug (+Ar/Fa), categories, tags,
  // gallery, seo - the same shape as a websiteProductContent record
  payload:   { type: mongoose.Schema.Types.Mixed, required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, default: null },   // the record being edited, if it exists
  createdBy: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  insertDate:{ type: Date, default: Date.now },
  updateDate:{ type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

module.exports = websiteProductPreviewSchema;
