// Phase 6 — MIS / Invoices. Arabic amount-in-words (المبلغ بالحروف).
// Custom util (no package — per the "no new packages unasked" rule; puppeteer
// was the one approved install). Spells the GRAND TOTAL (decision 2026-07-03),
// Currency-aware (utils/currencies.js); the default, AED: درهم (dirham) + فلس (fils), invoice boilerplate style:
//   "فقط ثلاثة آلاف وأربعة وثمانون درهماً وثمانية وأربعون فلساً لا غير"
// Pragmatic classical construction (units-before-tens, common scale agreement);
// wording tweaks are cosmetic and safe to adjust later.

const { DEFAULT_CURRENCY, currencyInfo } = require('./currencies');

const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة',
  'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر',
  'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة',
  'سبعمائة', 'ثمانمائة', 'تسعمائة'];

// 0–999 → words
function threeDigits(n) {
  const parts = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (r) {
    if (r < 20) parts.push(ONES[r]);
    else {
      const u = r % 10;
      const t = Math.floor(r / 10);
      // units BEFORE tens: أربعة وثمانون (four-and-eighty)
      parts.push(u ? `${ONES[u]} و${TENS[t]}` : TENS[t]);
    }
  }
  return parts.join(' و');
}

// scale-word agreement: 1 → singular · 2 → dual · 3–10 → plural · 11+ → accusative singular
function withScale(n, forms /* {one, two, few, many} */) {
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  const words = threeDigits(n);
  if (n % 100 >= 3 && n % 100 <= 10) return `${words} ${forms.few}`;
  if (n % 100 === 0) return `${words} ${forms.one}`;   // خمسمائة ألف (singular after round hundreds)
  return `${words} ${forms.many}`;
}

const SCALES = [
  { value: 1e9, forms: { one: 'مليار',  two: 'ملياران',  few: 'مليارات', many: 'ملياراً' } },
  { value: 1e6, forms: { one: 'مليون',  two: 'مليونان',  few: 'ملايين',  many: 'مليوناً' } },
  { value: 1e3, forms: { one: 'ألف',    two: 'ألفان',    few: 'آلاف',    many: 'ألفاً' } },
];

// integer → Arabic words (0 … 999,999,999,999)
function numberToArabicWords(num) {
  num = Math.floor(Math.abs(Number(num) || 0));
  if (num === 0) return 'صفر';

  const parts = [];
  for (const { value, forms } of SCALES) {
    const q = Math.floor(num / value);
    if (q) {
      parts.push(withScale(q, forms));
      num %= value;
    }
  }
  if (num) parts.push(threeDigits(num));
  return parts.join(' و');
}

// currency-unit agreement (same 1/2/3–10/11+ rule)
function currencyWord(n, forms) {
  const r = n % 100;
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  if (r >= 3 && r <= 10) return forms.few;
  return forms.many;
}

// amount (e.g. 3084.48) → "فقط ثلاثة آلاف وأربعة وثمانون درهماً وثمانية وأربعون فلساً لا غير"
// The currency's unit and small unit come from utils/currencies.js, each in the
// right grammatical number. Left at the default it is the same AED sentence it
// always was.
function amountToArabicWords(amount, { prefix = 'فقط', suffix = 'لا غير', currency = DEFAULT_CURRENCY } = {}) {
  const { words: cw } = currencyInfo(currency);
  const abs   = Math.abs(Number(amount) || 0);
  let whole   = Math.floor(abs);
  let small   = cw.sub ? Math.round((abs - whole) * cw.subPerUnit) : 0;
  if (cw.sub && small >= cw.subPerUnit) { whole += 1; small = 0; }   // 0.999 → one whole unit, not "100 fils"
  // A currency with no small unit (the rial) rounds a stray fraction instead of spelling it.
  if (!cw.sub && abs - whole >= 0.5) whole += 1;

  const parts = [];
  if (whole > 0) {
    const w = numberToArabicWords(whole);
    parts.push(whole <= 2 ? currencyWord(whole, cw.unit) : `${w} ${currencyWord(whole, cw.unit)}`);
  }
  if (small > 0) {
    const w = numberToArabicWords(small);
    parts.push(small <= 2 ? currencyWord(small, cw.sub) : `${w} ${currencyWord(small, cw.sub)}`);
  }
  if (!parts.length) parts.push(cw.zero);

  return [prefix, parts.join(' و'), suffix].filter(Boolean).join(' ');
}

module.exports = { numberToArabicWords, amountToArabicWords };
