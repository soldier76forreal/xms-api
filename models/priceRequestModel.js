const mongoose = require('mongoose');

// A public-website visitor's price request — the core record the whole Phase
// B flow (POST /public/website/price-requests) revolves around. Items are a
// SNAPSHOT (name/code copied at request time), same immutability principle
// as an issued MIS invoice or a saved WhatsApp share — a product's name can
// change later without rewriting history here.
const priceRequestItemSchema = new mongoose.Schema({
  productId:   { type: mongoose.Schema.Types.ObjectId, required: true },
  variantId:   { type: mongoose.Schema.Types.ObjectId, required: true },
  productName: { type: String, default: '' },
  variantCode: { type: String, default: '' },
  branchId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  // The amount the visitor wants, in that variant's OWN unit (m²/ml/pcs/...) —
  // not a price, just a quantity signal for whoever responds.
  quantity: { type: Number, required: true },
  unit:     { type: String, default: '' },
}, { _id: false });

const priceRequestSchema = new mongoose.Schema({
  items: { type: [priceRequestItemSchema], required: true, validate: { validator: (a) => Array.isArray(a) && a.length > 0, message: 'At least one item is required' } },

  // Always resolved to a real CRM customer (find-or-create by email) — see
  // the route. Never null; a price request with no attributable customer
  // shouldn't be able to exist.
  customerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name:  { type: String, required: true },   // snapshot of what the visitor typed
  email: { type: String, required: true },   // snapshot — customer's email may change later

  // Matches the field set the real production WordPress site's own price-
  // request flow already collects (wp-content/mu-plugins/wpt-price-request.php)
  // — phone optional (email is already OTP-verified as the primary identity),
  // country/city required same as that real precedent.
  phone:   { type: String, default: '' },
  country: { type: String, required: true },
  city:    { type: String, required: true },

  status: { type: String, enum: ['new', 'seen', 'responded', 'closed'], default: 'new', index: true },

  // Staff's reply — see the Respond action in routes/inventory/main.js /
  // routes/crm/customer.js. A human-typed reply is the one place a price
  // legitimately reaches the visitor (by email, never through the public API).
  response: {
    body:           { type: String, default: '' },
    respondedBy:    { type: mongoose.Schema.Types.ObjectId, default: null },
    respondedByName:{ type: String, default: '' },
    respondedAt:    { type: Date, default: null },
  },

  source:   { type: String, enum: ['productPage', 'productTable'], required: true },
  language: { type: String, enum: ['en', 'ar', 'fa'], default: 'en' },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
});

priceRequestSchema.index({ customerId: 1, insertDate: -1 });
priceRequestSchema.index({ 'items.productId': 1 });
priceRequestSchema.index({ 'items.branchId': 1 });

module.exports = priceRequestSchema;
