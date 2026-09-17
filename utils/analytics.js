// Shared analytics primitives — every module's GET .../analytics route builds
// its response from these three functions instead of hand-writing its own
// aggregation pipeline. Kept deliberately generic (Model + a small options
// object) so the same helpers work whether the caller is grouping
// inventoryChangeLogs by day or misInvoices by month.

const DAY_MS = 24 * 60 * 60 * 1000;
const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 };

// Reads ?preset=7d|30d|90d|12m|custom&from&to off the request. 'custom'
// requires both from/to and falls back to 30d if either is missing/invalid —
// a malformed custom range should never 500 the whole analytics call.
function parseDateRange(req) {
  const preset = req.query.preset;
  const now = new Date();

  if (preset === 'custom' && req.query.from && req.query.to) {
    const from = new Date(req.query.from);
    const to   = new Date(req.query.to);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to) {
      return { from, to, preset: 'custom' };
    }
  }

  const key  = PRESET_DAYS[preset] ? preset : '30d';
  const days = PRESET_DAYS[key];
  return { from: new Date(now.getTime() - days * DAY_MS), to: now, preset: key };
}

// Auto-picks a sensible bucket size for a range unless the caller forces one —
// a year at daily granularity is 365 unreadable bars, a week at monthly
// granularity is one bar.
function pickGranularity(from, to, explicit) {
  if (explicit) return explicit;
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (days <= 31)  return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

// One aggregation: $match the date range (+ caller's own match, e.g. branch/
// scope filters) → $group into day/week/month buckets via $dateTrunc (Mongo
// 5+; this deployment runs 8.0) → count + optional summed expressions (e.g.
// { revenue: '$grandTotal' }) → sorted oldest-first, ready for a line/bar chart.
async function timeSeries(Model, { match = {}, dateField = 'insertDate', from, to, granularity, sumFields = {} }) {
  const gran = pickGranularity(from, to, granularity);

  const sumStage = {};
  Object.entries(sumFields).forEach(([key, expr]) => { sumStage[key] = { $sum: expr }; });

  const rows = await Model.aggregate([
    { $match: { ...match, [dateField]: { $gte: from, $lte: to } } },
    { $group: {
        _id: { $dateTrunc: { date: `$${dateField}`, unit: gran, timezone: 'UTC' } },
        count: { $sum: 1 },
        ...sumStage,
      } },
    { $sort: { _id: 1 } },
  ]);

  return {
    granularity: gran,
    points: rows.map((r) => {
      const point = { date: r._id, count: r.count };
      Object.keys(sumFields).forEach((k) => { point[k] = r[k] || 0; });
      return point;
    }),
  };
}

// One aggregation: group by an arbitrary field (status, changeType, docType,
// productId, ...), count + optional sums, sorted descending, top N. Powers
// every "top products" / "status funnel" / "activity mix" breakdown.
async function topBreakdown(Model, { match = {}, groupField, limit = 8, sumFields = {}, labelMap = null }) {
  const sumStage = {};
  Object.entries(sumFields).forEach(([key, expr]) => { sumStage[key] = { $sum: expr }; });

  const rows = await Model.aggregate([
    { $match: match },
    { $group: { _id: `$${groupField}`, count: { $sum: 1 }, ...sumStage } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);

  return rows.map((r) => {
    const key = r._id;
    const row = {
      key,
      label: labelMap ? (labelMap[key] || String(key ?? 'Unknown')) : String(key ?? 'Unknown'),
      count: r.count,
    };
    Object.keys(sumFields).forEach((k) => { row[k] = r[k] || 0; });
    return row;
  });
}

// Percent change of `current` vs `previous` (the equal-length window right
// before the selected range), rounded to one decimal. previous=0 with a
// positive current reads as +100% rather than Infinity/NaN.
function kpiDelta(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// The equal-length window immediately preceding {from, to} — for KPI deltas
// ("this range vs the one before it").
function previousRange(from, to) {
  const span = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - span), to: new Date(from.getTime()) };
}

module.exports = { parseDateRange, pickGranularity, timeSeries, topBreakdown, kpiDelta, previousRange };
