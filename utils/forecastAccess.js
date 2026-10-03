// Who may see Supply's forecast stone figures on Inventory (the forecast /
// final-but-unreceived amounts next to a variant's real quantity), and the
// helpers that strip them from a response when the caller may not.
//
// Seeing a forecast does NOT require Supply access: inventory:forecast:view
// grants exactly the figures, without the supply record behind them. Holding
// inventory:forecast:request (asking for a forecast lot from Inventory)
// implies seeing what you're asking for, and anyone with supply:view already
// sees these numbers in Supply itself.
const { getEffectivePermissions } = require('./rbac');

const FORECAST_KEYS = ['inventory:forecast:view', 'inventory:forecast:request', 'supply:view'];

async function canSeeForecast(userId) {
  const perms = await getEffectivePermissions(userId);
  return FORECAST_KEYS.some((k) => perms.has(k));
}

const plain = (x) => (x && typeof x.toObject === 'function' ? x.toObject() : { ...x });

// variant.supply = { forecastQty, finalQty }
function stripVariantForecast(variant) {
  if (!variant) return variant;
  const o = plain(variant);
  delete o.supply;
  return o;
}

// product.supplyTotalsByUnit = { forecast: {unit: qty}, final: {...} }
function stripProductForecast(product) {
  if (!product) return product;
  const o = plain(product);
  delete o.supplyTotalsByUnit;
  if (Array.isArray(o.variants)) o.variants = o.variants.map(stripVariantForecast);
  return o;
}

module.exports = { canSeeForecast, stripVariantForecast, stripProductForecast, FORECAST_KEYS };
