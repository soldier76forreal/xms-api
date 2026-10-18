// The currencies a MIS document can be written in.
//
// A document carries ONE currency (`misInvoice.currency`, the ISO code). It is
// chosen per document, with each branch's own default (`branch.defaultCurrency`)
// as the starting point — a UAE branch starts in dirhams, a Saudi one in riyals,
// an Iranian one in rials.
//
// WHAT A CURRENCY CHANGES, beyond the label:
//   · how many decimals an amount has (a rial has none in practice, a dirham has
//     two) — totals are rounded to that, on the server, where they are computed;
//   · the Arabic words printed on a tax invoice ("فقط … درهماً … لا غير"), which
//     name the currency and its small unit in the right grammatical number.
//
// Adding a currency is ONE entry below: its code, its decimals, its names and its
// Arabic words. Nothing else has to change — the pickers, the printing and the
// totals all read this table. THE WORDS ARE LEGAL TEXT on a tax invoice, so have
// a native reader check a new currency's Arabic forms before it is used.
//
// This file exists twice (here and xms/src/tools/currencies.js, which has no
// Arabic words) — keep the codes, decimals and names the same.

// Arabic number agreement for a counted noun: 1 → singular, 2 → dual, 3–10 →
// plural, 11+ → accusative singular (the "many" form).
const forms = (one, two, few, many) => ({ one, two, few, many });

const CURRENCIES = {
  AED: {
    code: 'AED', decimals: 2,
    name: { en: 'UAE dirham', ar: 'درهم إماراتي', fa: 'درهم امارات' },
    words: {
      unit: forms('درهم واحد', 'درهمان', 'دراهم', 'درهماً'),
      sub: forms('فلس واحد', 'فلسان', 'فلوس', 'فلساً'),
      subPerUnit: 100, zero: 'صفر درهم',
    },
  },
  SAR: {
    code: 'SAR', decimals: 2,
    name: { en: 'Saudi riyal', ar: 'ريال سعودي', fa: 'ریال عربستان' },
    words: {
      unit: forms('ريال سعودي واحد', 'ريالان سعوديان', 'ريالات سعودية', 'ريالاً سعودياً'),
      sub: forms('هللة واحدة', 'هللتان', 'هللات', 'هللة'),
      subPerUnit: 100, zero: 'صفر ريال سعودي',
    },
  },
  IRR: {
    code: 'IRR', decimals: 0,
    name: { en: 'Iranian rial', ar: 'ريال إيراني', fa: 'ریال ایران' },
    words: {
      unit: forms('ريال إيراني واحد', 'ريالان إيرانيان', 'ريالات إيرانية', 'ريالاً إيرانياً'),
      sub: null,                                   // no small unit in use
      subPerUnit: 0, zero: 'صفر ريال إيراني',
    },
  },
  USD: {
    code: 'USD', decimals: 2,
    name: { en: 'US dollar', ar: 'دولار أمريكي', fa: 'دلار آمریکا' },
    words: {
      unit: forms('دولار أمريكي واحد', 'دولاران أمريكيان', 'دولارات أمريكية', 'دولاراً أمريكياً'),
      sub: forms('سنت واحد', 'سنتان', 'سنتات', 'سنتاً'),
      subPerUnit: 100, zero: 'صفر دولار أمريكي',
    },
  },
  EUR: {
    code: 'EUR', decimals: 2,
    name: { en: 'Euro', ar: 'يورو', fa: 'یورو' },
    words: {
      unit: forms('يورو واحد', 'يوروان', 'يورو', 'يورو'),
      sub: forms('سنت واحد', 'سنتان', 'سنتات', 'سنتاً'),
      subPerUnit: 100, zero: 'صفر يورو',
    },
  },
};

const CURRENCY_CODES = Object.keys(CURRENCIES);
const DEFAULT_CURRENCY = 'AED';     // what every document and branch had before currencies were selectable

const normalizeCurrency = (code, fallback = DEFAULT_CURRENCY) => {
  const c = String(code || '').trim().toUpperCase();
  return CURRENCIES[c] ? c : fallback;
};

const currencyInfo = (code) => CURRENCIES[normalizeCurrency(code)];
const decimalsOf = (code) => currencyInfo(code).decimals;

/** Round an amount to its currency's decimals (a rial to a whole number, a dirham to fils). */
function roundMoney(n, code = DEFAULT_CURRENCY) {
  const f = 10 ** decimalsOf(code);
  return Math.round(((Number(n) || 0) + Number.EPSILON) * f) / f;
}

/** "3,084.48" — or "1,250,000" for a rial. Latin digits, as every document prints them. */
function formatMoney(n, code = DEFAULT_CURRENCY) {
  const d = decimalsOf(code);
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

module.exports = {
  CURRENCIES, CURRENCY_CODES, DEFAULT_CURRENCY,
  normalizeCurrency, currencyInfo, decimalsOf, roundMoney, formatMoney,
};
