// Digital Marketing → Website analytics.
//
// Two sources, deliberately kept apart on screen as well as here:
//   · traffic   — the first-party events the website itself sends (page views, product
//                 views, contact clicks …). Empty until the site is instrumented.
//   · outcomes  — what XMS already knows: price requests, the offers answering them, the
//                 invoices they became, and the state of the product pages themselves.
//                 These are real from day one, with no tracking at all.
//
// Money is only ever returned to someone who may see MIS documents anyway (`mis:view`);
// everything else needs `digitalMarketing:view`, the key that opens the section.
const express = require('express');
const mongoose = require('mongoose');

const dbConnection = require('../../connections/xmsPr');
const verify = require('../users/verifyToken');
const { requirePermission, getEffectivePermissions } = require('../../utils/rbac');
const { AnalyticsEvent, rangeToDates, dayKey } = require('../../utils/websiteAnalytics');

const priceRequestSchema   = require('../../models/priceRequestModel');
const misInvoiceSchema     = require('../../models/misInvoiceModel');
const productContentSchema = require('../../models/websiteProductContentModel');
const customerSchema       = require('../../models/customerModel');
const branchSchema         = require('../../models/branchModel');

const PriceRequest   = dbConnection.models.priceRequest   || dbConnection.model('priceRequest', priceRequestSchema);
const MisInvoice     = dbConnection.models.misInvoice     || dbConnection.model('misInvoice', misInvoiceSchema);
const ProductContent = dbConnection.models.websiteProductContent || dbConnection.model('websiteProductContent', productContentSchema);
const Customer       = dbConnection.models.customer       || dbConnection.model('customer', customerSchema);
const Branch         = dbConnection.models.branch         || dbConnection.model('branch', branchSchema);

const router = express.Router();

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (now, before) => {
  if (!before) return now ? null : 0;        // null = "no basis to compare", not 0%
  return round2(((now - before) / before) * 100);
};

// ── GET /digitalMarketing/analytics/overview?range=7d|30d|90d|365d ──────────
router.get('/overview', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const { from, to, prevFrom, days } = rangeToDates(req.query.range);
    const perms = await getEffectivePermissions(req.user.id);
    const showMoney = perms.has('mis:view');
    const window = { date: { $gte: from, $lte: to } };
    const prevWindow = { date: { $gte: prevFrom, $lt: from } };

    // ── traffic ────────────────────────────────────────────────────────────
    const [traffic, prevTraffic] = await Promise.all([
      AnalyticsEvent.aggregate([
        { $match: window },
        { $group: {
          _id: null,
          events: { $sum: 1 },
          pageViews: { $sum: { $cond: [{ $eq: ['$name', 'page_view'] }, 1, 0] } },
          productViews: { $sum: { $cond: [{ $eq: ['$name', 'product_view'] }, 1, 0] } },
          contactClicks: { $sum: { $cond: [{ $eq: ['$name', 'contact_click'] }, 1, 0] } },
          visitors: { $addToSet: '$visitorId' },
          sessions: { $addToSet: '$sessionId' },
        } },
        { $project: { events: 1, pageViews: 1, productViews: 1, contactClicks: 1,
          visitors: { $size: '$visitors' }, sessions: { $size: '$sessions' } } },
      ]),
      AnalyticsEvent.aggregate([
        { $match: prevWindow },
        { $group: { _id: null, pageViews: { $sum: { $cond: [{ $eq: ['$name', 'page_view'] }, 1, 0] } }, visitors: { $addToSet: '$visitorId' } } },
        { $project: { pageViews: 1, visitors: { $size: '$visitors' } } },
      ]),
    ]);
    const t = traffic[0] || { events: 0, pageViews: 0, productViews: 0, contactClicks: 0, visitors: 0, sessions: 0 };
    const pt = prevTraffic[0] || { pageViews: 0, visitors: 0 };

    // ── outcomes, from the records XMS already holds ───────────────────────
    const reqWindow = { insertDate: { $gte: from, $lte: to } };
    const [requests, prevRequests, offerDocs, newCustomers] = await Promise.all([
      PriceRequest.find(reqWindow).select('status insertDate country branchId items source language').lean(),
      PriceRequest.countDocuments({ insertDate: { $gte: prevFrom, $lt: from } }),
      MisInvoice.find({ priceRequestId: { $ne: null }, deleteDate: null, insertDate: { $gte: from, $lte: to } })
        .select('docType status grandTotal customerAcceptedAt insertDate').lean(),
      Customer.countDocuments({ insertDate: { $gte: from, $lte: to }, 'interestedProducts.source': 'website' }),
    ]);
    const offers = offerDocs.filter((d) => d.docType === 'pre_invoice');
    const acceptedOffers = offers.filter((d) => d.customerAcceptedAt || ['accepted', 'converted'].includes(d.status));
    const offerInvoices = offerDocs.filter((d) => d.docType === 'invoice');

    // ── the funnel, end to end ─────────────────────────────────────────────
    const funnel = [
      { key: 'productViews', value: t.productViews },
      { key: 'requests', value: requests.length },
      { key: 'offers', value: offers.length },
      { key: 'accepted', value: acceptedOffers.length },
      { key: 'invoices', value: offerInvoices.length },
    ];

    // ── how long an answer takes, and how long a customer takes to accept ───
    const answered = [];
    for (const offer of offers) {
      const request = requests.find((r) => String(r._id) === String(offer.priceRequestId));
      if (request) answered.push((new Date(offer.insertDate) - new Date(request.insertDate)) / 3600000);
    }
    const acceptHours = acceptedOffers
      .filter((o) => o.customerAcceptedAt)
      .map((o) => (new Date(o.customerAcceptedAt) - new Date(o.insertDate)) / 3600000);
    const avg = (arr) => (arr.length ? round2(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

    return res.status(200).json({
      range: { from, to, days },
      traffic: {
        visitors: t.visitors, sessions: t.sessions, pageViews: t.pageViews,
        productViews: t.productViews, contactClicks: t.contactClicks,
        pagesPerSession: t.sessions ? round2(t.pageViews / t.sessions) : 0,
        change: { visitors: pct(t.visitors, pt.visitors), pageViews: pct(t.pageViews, pt.pageViews) },
        instrumented: t.events > 0,
      },
      outcomes: {
        requests: requests.length,
        requestsChange: pct(requests.length, prevRequests),
        unanswered: requests.filter((r) => ['new', 'seen'].includes(r.status)).length,
        offers: offers.length,
        accepted: acceptedOffers.length,
        invoices: offerInvoices.length,
        newCustomers,
        acceptanceRate: offers.length ? round2((acceptedOffers.length / offers.length) * 100) : null,
        requestToOfferHours: avg(answered),
        offerToAcceptHours: avg(acceptHours),
        ...(showMoney ? {
          offeredValue: round2(offers.reduce((a, o) => a + (Number(o.grandTotal) || 0), 0)),
          acceptedValue: round2(acceptedOffers.reduce((a, o) => a + (Number(o.grandTotal) || 0), 0)),
          invoicedValue: round2(offerInvoices.reduce((a, o) => a + (Number(o.grandTotal) || 0), 0)),
        } : {}),
      },
      funnel,
      showMoney,
    });
  } catch (err) {
    console.error('GET /digitalMarketing/analytics/overview failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /digitalMarketing/analytics/timeseries?range= ───────────────────────
// One row per day: traffic on one axis, requests on the other.
router.get('/timeseries', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const { from, to } = rangeToDates(req.query.range);
    const [traffic, requests] = await Promise.all([
      AnalyticsEvent.aggregate([
        { $match: { date: { $gte: from, $lte: to } } },
        { $group: { _id: dayKey,
          pageViews: { $sum: { $cond: [{ $eq: ['$name', 'page_view'] }, 1, 0] } },
          productViews: { $sum: { $cond: [{ $eq: ['$name', 'product_view'] }, 1, 0] } },
          visitors: { $addToSet: '$visitorId' } } },
        { $project: { pageViews: 1, productViews: 1, visitors: { $size: '$visitors' } } },
      ]),
      PriceRequest.aggregate([
        { $match: { insertDate: { $gte: from, $lte: to } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$insertDate' } }, requests: { $sum: 1 } } },
      ]),
    ]);
    const byDay = new Map();
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      byDay.set(d.toISOString().slice(0, 10), { day: d.toISOString().slice(0, 10), pageViews: 0, productViews: 0, visitors: 0, requests: 0 });
    }
    for (const row of traffic) if (byDay.has(row._id)) Object.assign(byDay.get(row._id), { pageViews: row.pageViews, productViews: row.productViews, visitors: row.visitors });
    for (const row of requests) if (byDay.has(row._id)) byDay.get(row._id).requests = row.requests;
    return res.status(200).json({ data: [...byDay.values()] });
  } catch (err) {
    console.error('GET /digitalMarketing/analytics/timeseries failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /digitalMarketing/analytics/breakdown?range=&by=channel|country|device|language|page|referrer
router.get('/breakdown', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const { from, to } = rangeToDates(req.query.range);
    const FIELDS = {
      channel: '$channel', country: '$country', device: '$device',
      language: '$language', page: '$path', referrer: '$referrerHost',
      campaign: '$utm.campaign', branch: '$branchSlug',
    };
    const by = FIELDS[req.query.by] ? req.query.by : 'channel';
    const match = { date: { $gte: from, $lte: to } };
    if (by === 'page') match.name = 'page_view';
    if (by === 'referrer') match.referrerHost = { $ne: '' };
    if (by === 'campaign') match['utm.campaign'] = { $ne: '' };
    const rows = await AnalyticsEvent.aggregate([
      { $match: match },
      { $group: { _id: FIELDS[by], events: { $sum: 1 }, visitors: { $addToSet: '$visitorId' }, sessions: { $addToSet: '$sessionId' } } },
      { $project: { key: { $ifNull: ['$_id', ''] }, events: 1, visitors: { $size: '$visitors' }, sessions: { $size: '$sessions' } } },
      { $sort: { visitors: -1, events: -1 } },
      { $limit: 25 },
    ]);
    return res.status(200).json({ by, data: rows.map((r) => ({ key: r.key || '(none)', events: r.events, visitors: r.visitors, sessions: r.sessions })) });
  } catch (err) {
    console.error('GET /digitalMarketing/analytics/breakdown failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /digitalMarketing/analytics/products?range= ─────────────────────────
// Per product code: what the site showed, what people asked for, and - the one
// that usually pays for itself - demand for varieties that were out of stock.
router.get('/products', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const { from, to } = rangeToDates(req.query.range);
    const [views, requests, pages] = await Promise.all([
      AnalyticsEvent.aggregate([
        { $match: { date: { $gte: from, $lte: to }, name: { $in: ['product_view', 'variety_view'] }, productCode: { $ne: '' } } },
        { $group: {
          _id: '$productCode',
          views: { $sum: 1 },
          visitors: { $addToSet: '$visitorId' },
          outOfStockViews: { $sum: { $cond: [{ $eq: ['$inStock', false] }, 1, 0] } },
          name: { $last: '$productName' },
        } },
        { $project: { views: 1, outOfStockViews: 1, name: 1, visitors: { $size: '$visitors' } } },
      ]),
      PriceRequest.aggregate([
        { $match: { insertDate: { $gte: from, $lte: to } } },
        { $unwind: '$items' },
        { $group: {
          _id: { $toUpper: { $substrCP: ['$items.variantCode', 0, 4] } },
          requests: { $sum: 1 },
          quantity: { $sum: '$items.quantity' },
          name: { $last: '$items.productName' },
        } },
      ]),
      ProductContent.find({ deleteDate: null }).select('code slug status title gallery translations seo').lean(),
    ]);

    const rows = new Map();
    const row = (code) => {
      if (!rows.has(code)) rows.set(code, { code, name: '', views: 0, visitors: 0, outOfStockViews: 0, requests: 0, quantity: 0, hasPage: false, published: false, slug: '' });
      return rows.get(code);
    };
    for (const v of views) Object.assign(row(v._id), { views: v.views, visitors: v.visitors, outOfStockViews: v.outOfStockViews, name: v.name || '' });
    for (const r of requests) {
      if (!r._id) continue;
      const item = row(r._id);
      item.requests += r.requests; item.quantity += r.quantity;
      if (!item.name) item.name = r.name || '';
    }
    for (const p of pages) {
      if (!p.code) continue;
      const item = row(String(p.code).toUpperCase());
      item.hasPage = true;
      item.published = p.status === 'published';
      item.slug = p.slug || '';
      if (!item.name) item.name = p.title || '';
    }
    const data = [...rows.values()]
      .map((r) => ({ ...r, requestRate: r.views ? round2((r.requests / r.views) * 100) : null }))
      .sort((a, b) => (b.views - a.views) || (b.requests - a.requests));
    return res.status(200).json({ data: data.slice(0, 50) });
  } catch (err) {
    console.error('GET /digitalMarketing/analytics/products failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /digitalMarketing/analytics/content ────────────────────────────────
// The health of the pages themselves: published vs draft, what each is missing.
// No tracking needed - this is the part you can act on before any traffic lands.
router.get('/content', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const pages = await ProductContent.find({ deleteDate: null })
      .select('code slug status title excerpt body gallery translations seo updateDate insertDate').lean();
    const langs = ['en', 'ar', 'fa'];
    const missing = { title: [], images: [], description: [], seo: [], translations: [] };
    let published = 0;
    for (const p of pages) {
      if (p.status === 'published') published += 1;
      const label = p.code || p.slug || String(p._id);
      if (!String(p.title || '').trim()) missing.title.push(label);
      if (!(p.gallery || []).length) missing.images.push(label);
      if (!String(p.body || p.excerpt || '').trim()) missing.description.push(label);
      const seo = p.seo || {};
      if (!String(seo.metaTitle || '').trim() || !String(seo.metaDescription || '').trim()) missing.seo.push(label);
      const tr = p.translations || {};
      const incomplete = langs.filter((l) => l !== 'en' && !String((tr[l] && (tr[l].title || tr[l].body)) || '').trim());
      if (incomplete.length) missing.translations.push(`${label} (${incomplete.join(', ')})`);
    }
    const recent = [...pages]
      .sort((a, b) => new Date(b.updateDate || b.insertDate) - new Date(a.updateDate || a.insertDate))
      .slice(0, 8)
      .map((p) => ({ code: p.code, slug: p.slug, title: p.title, status: p.status, updated: p.updateDate || p.insertDate }));
    return res.status(200).json({
      total: pages.length, published, drafts: pages.length - published,
      missing: Object.fromEntries(Object.entries(missing).map(([k, v]) => [k, { count: v.length, examples: v.slice(0, 6) }])),
      recent,
    });
  } catch (err) {
    console.error('GET /digitalMarketing/analytics/content failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /digitalMarketing/analytics/requests?range= ─────────────────────────
// Where the requests came from and where they went - the outcome side, which is
// real whether or not the site is instrumented.
router.get('/requests', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const { from, to } = rangeToDates(req.query.range);
    const [bySource, byCountry, byStatus, byBranch, branches] = await Promise.all([
      PriceRequest.aggregate([{ $match: { insertDate: { $gte: from, $lte: to } } }, { $group: { _id: '$source', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      PriceRequest.aggregate([{ $match: { insertDate: { $gte: from, $lte: to } } }, { $group: { _id: '$country', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 12 }]),
      PriceRequest.aggregate([{ $match: { insertDate: { $gte: from, $lte: to } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      PriceRequest.aggregate([{ $match: { insertDate: { $gte: from, $lte: to } } }, { $group: { _id: '$branchId', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      Branch.find({ deleteDate: null }).select('name').lean(),
    ]);
    const branchName = new Map(branches.map((b) => [String(b._id), b.name]));
    return res.status(200).json({
      bySource: bySource.map((r) => ({ key: r._id || 'unknown', value: r.n })),
      byCountry: byCountry.map((r) => ({ key: r._id || '(none)', value: r.n })),
      byStatus: byStatus.map((r) => ({ key: r._id || 'new', value: r.n })),
      byBranch: byBranch.map((r) => ({ key: branchName.get(String(r._id)) || '(none)', value: r.n })),
    });
  } catch (err) {
    console.error('GET /digitalMarketing/analytics/requests failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
