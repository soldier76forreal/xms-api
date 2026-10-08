const mongoose = require('mongoose');

// One thing a visitor did on the public website. Written by the unauthenticated
// ingest route (POST /public/website/analytics), read only in aggregate by
// Digital Marketing → Website analytics.
//
// It is deliberately first-party and thin: no third-party script, no cookie that
// follows anyone between sites, no raw IP. A visitor is a random id their browser
// keeps, a session is that id plus a 30-minute gap, and that is the whole identity
// model — until they sign in, when `customerId` ties the session to a CRM customer
// and the request/offer/invoice chain already in XMS.
const websiteAnalyticsEventSchema = new mongoose.Schema({
  // what happened
  name: {
    type: String,
    required: true,
    index: true,
    enum: [
      'page_view', 'product_view', 'variety_view', 'search',
      'purchase_list_add', 'purchase_list_remove',
      'price_request_submit', 'offer_view', 'offer_accept',
      'contact_click', 'outbound_click', 'file_download',
      'login_start', 'login_complete', 'scroll_depth', 'web_vital',
    ],
  },

  // who (pseudonymous) and when
  visitorId: { type: String, required: true, index: true },   // random, set by the browser
  sessionId: { type: String, required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },  // once signed in
  date: { type: Date, default: Date.now, index: true },

  // where on the site
  path:     { type: String, default: '' },
  title:    { type: String, default: '' },
  language: { type: String, default: '' },
  branchSlug: { type: String, default: '' },
  branchId:   { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

  // how they got here — first touch is stamped on every event of the session
  referrer:     { type: String, default: '' },
  referrerHost: { type: String, default: '' },
  channel: {
    type: String,
    enum: ['direct', 'organic', 'paid', 'social', 'referral', 'email', 'internal', 'unknown'],
    default: 'unknown',
    index: true,
  },
  utm: {
    source:   { type: String, default: '' },
    medium:   { type: String, default: '' },
    campaign: { type: String, default: '' },
    term:     { type: String, default: '' },
    content:  { type: String, default: '' },
  },

  // what they were looking at
  productCode: { type: String, default: '', index: true },
  variantCode: { type: String, default: '' },
  productName: { type: String, default: '' },
  inStock:     { type: Boolean, default: null },   // product_view: could we actually serve it?
  quantity:    { type: Number, default: null },
  value:       { type: Number, default: null },    // offer value, request total …

  // the device, in buckets - never a raw user-agent string
  device:  { type: String, enum: ['desktop', 'tablet', 'phone', 'unknown'], default: 'unknown' },
  os:      { type: String, default: '' },
  browser: { type: String, default: '' },
  country: { type: String, default: '', index: true },

  // event-specific extras: scroll percent, search term, vital name/value, channel clicked
  label:  { type: String, default: '' },
  metric: { type: Number, default: null },

  insertDate: { type: Date, default: Date.now },
});

// the queries the dashboard actually runs
websiteAnalyticsEventSchema.index({ date: -1, name: 1 });
websiteAnalyticsEventSchema.index({ name: 1, productCode: 1, date: -1 });
websiteAnalyticsEventSchema.index({ sessionId: 1, date: 1 });

module.exports = websiteAnalyticsEventSchema;
