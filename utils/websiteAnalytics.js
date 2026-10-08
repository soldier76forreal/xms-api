// Website analytics: what the public site may write, and what Digital Marketing reads.
//
// The ingest side is deliberately paranoid. Anything arriving here came from a browser
// nobody authenticated, so every field is clamped to a known shape before it is stored:
// unknown event names are dropped, strings are trimmed to a length, numbers are bounded,
// and nothing is ever used to build a query. No IP address and no user-agent string is
// kept - the device is bucketed and thrown away.
const mongoose = require('mongoose');
const dbConnection = require('../connections/xmsPr');
const eventSchema = require('../models/websiteAnalyticsEventModel');

const AnalyticsEvent = dbConnection.models.websiteAnalyticsEvent
  || dbConnection.model('websiteAnalyticsEvent', eventSchema);

const EVENT_NAMES = eventSchema.path('name').enumValues;
const CHANNELS = eventSchema.path('channel').enumValues;
const DEVICES = eventSchema.path('device').enumValues;

const MAX_EVENTS_PER_REQUEST = 25;
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
};
const id = (v) => (v && mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null);

// A referrer only ever becomes a host; the full URL can carry a search query or a
// session token from the referring site, which is not ours to store.
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase().slice(0, 120); }
  catch (_) { return ''; }
}

const SEARCH_HOSTS = /(^|\.)(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia|brave)\./;
const SOCIAL_HOSTS = /(^|\.)(facebook|instagram|twitter|x|t|telegram|linkedin|pinterest|youtube|tiktok|whatsapp)\./;

// The channel the visit came from, worked out from the referrer and the campaign tags -
// the same reading GA4 would make, done here so it is stored once per event instead of
// recomputed over every report.
function resolveChannel({ utm = {}, referrerHost, selfHost }) {
  const medium = String(utm.medium || '').toLowerCase();
  const source = String(utm.source || '').toLowerCase();
  if (/cpc|ppc|paid|cpm|display/.test(medium)) return 'paid';
  if (/email|newsletter/.test(medium) || /email/.test(source)) return 'email';
  if (/social/.test(medium)) return 'social';
  if (medium || source) return 'referral';
  if (!referrerHost) return 'direct';
  if (selfHost && referrerHost === selfHost) return 'internal';
  if (SEARCH_HOSTS.test(referrerHost)) return 'organic';
  if (SOCIAL_HOSTS.test(referrerHost)) return 'social';
  return 'referral';
}

// One event, clamped. Returns null for anything we will not store.
function sanitizeEvent(raw, context = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = str(raw.name, 40);
  if (!EVENT_NAMES.includes(name)) return null;
  const visitorId = str(raw.visitorId, 64);
  const sessionId = str(raw.sessionId, 64);
  if (!visitorId || !sessionId) return null;

  const utm = {
    source:   str(raw.utm && raw.utm.source, 80),
    medium:   str(raw.utm && raw.utm.medium, 80),
    campaign: str(raw.utm && raw.utm.campaign, 120),
    term:     str(raw.utm && raw.utm.term, 120),
    content:  str(raw.utm && raw.utm.content, 120),
  };
  const referrer = str(raw.referrer, 300);
  const referrerHost = hostOf(referrer);
  const channelIn = str(raw.channel, 20);
  const channel = CHANNELS.includes(channelIn)
    ? channelIn
    : resolveChannel({ utm, referrerHost, selfHost: context.selfHost });
  const device = DEVICES.includes(str(raw.device, 10)) ? str(raw.device, 10) : 'unknown';

  // the browser's clock is not ours to trust: only accept a timestamp inside a sane window
  let date = new Date();
  const sent = Number(raw.ts);
  if (Number.isFinite(sent)) {
    const d = new Date(sent);
    const age = Date.now() - d.getTime();
    if (age > -5 * 60 * 1000 && age < 6 * 60 * 60 * 1000) date = d;
  }

  return {
    name, visitorId, sessionId,
    customerId: context.customerId || null,
    date,
    path: str(raw.path, 300),
    title: str(raw.title, 200),
    language: str(raw.language, 8),
    branchSlug: str(raw.branchSlug, 60),
    branchId: id(raw.branchId),
    referrer: referrerHost ? referrer : '',
    referrerHost,
    channel,
    utm,
    productCode: str(raw.productCode, 20).toUpperCase(),
    variantCode: str(raw.variantCode, 40).toUpperCase(),
    productName: str(raw.productName, 160),
    inStock: typeof raw.inStock === 'boolean' ? raw.inStock : null,
    quantity: num(raw.quantity, 0, 1e7),
    value: num(raw.value, 0, 1e9),
    device,
    os: str(raw.os, 40),
    browser: str(raw.browser, 40),
    country: str(raw.country, 4).toUpperCase(),
    label: str(raw.label, 160),
    metric: num(raw.metric, -1e9, 1e9),
    insertDate: new Date(),
  };
}

function sanitizeBatch(body, context) {
  const list = Array.isArray(body && body.events) ? body.events : [body];
  return list.slice(0, MAX_EVENTS_PER_REQUEST).map((e) => sanitizeEvent(e, context)).filter(Boolean);
}

// ── reading ────────────────────────────────────────────────────────────────
const RANGES = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
function rangeToDates(range) {
  const days = RANGES[range] || RANGES['30d'];
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
  const prevFrom = new Date(from.getTime() - days * 24 * 3600 * 1000);
  return { from, to, prevFrom, days };
}

const dayKey = { $dateToString: { format: '%Y-%m-%d', date: '$date' } };

module.exports = {
  AnalyticsEvent,
  EVENT_NAMES,
  MAX_EVENTS_PER_REQUEST,
  sanitizeEvent,
  sanitizeBatch,
  resolveChannel,
  hostOf,
  rangeToDates,
  dayKey,
  RANGES,
};
