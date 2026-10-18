// The two settings every MIS document carries — which CURRENCY it is written in
// and which CALENDAR its dates are entered and printed in — and where a new
// document gets them from when the form did not say.
//
//   branch.defaultCurrency / branch.defaultDateSystem   the branch's own starting point
//   the document itself                                 the person's choice, wins
//
// A branch that has never set them (every branch from before these existed) reads
// as dirhams and Gregorian dates — exactly how its documents have always been.
const { CURRENCY_CODES, normalizeCurrency, DEFAULT_CURRENCY } = require('./currencies');
const { SYSTEMS, normalizeDateSystem, DEFAULT_DATE_SYSTEM } = require('./calendars');

/** { currency, dateSystem } a branch starts its documents with. */
function branchDefaultsOf(branch) {
  return {
    currency: normalizeCurrency(branch && branch.defaultCurrency, DEFAULT_CURRENCY),
    dateSystem: normalizeDateSystem(branch && branch.defaultDateSystem, DEFAULT_DATE_SYSTEM),
  };
}

/**
 * Read `currency` and `dateSystem` off a request body.
 *   not sent (undefined / '')  → the fallback (the branch's default, or the document's own)
 *   sent but not a known value → { error } — refused, never quietly replaced by a
 *                                different currency than the one the person picked
 * @param fallback { currency, dateSystem }
 */
function readDocSettings(body, fallback) {
  const out = { currency: fallback.currency, dateSystem: fallback.dateSystem };
  const rawCurrency = body && body.currency;
  if (rawCurrency !== undefined && rawCurrency !== null && rawCurrency !== '') {
    const code = String(rawCurrency).trim().toUpperCase();
    if (!CURRENCY_CODES.includes(code)) return { error: `Unknown currency "${rawCurrency}". Use one of: ${CURRENCY_CODES.join(', ')}.` };
    out.currency = code;
  }
  const rawSystem = body && body.dateSystem;
  if (rawSystem !== undefined && rawSystem !== null && rawSystem !== '') {
    if (!SYSTEMS.includes(rawSystem)) return { error: `Unknown date system "${rawSystem}". Use one of: ${SYSTEMS.join(', ')}.` };
    out.dateSystem = rawSystem;
  }
  return out;
}

module.exports = { branchDefaultsOf, readDocSettings };
