// Persian number-to-words, for the stone sales contract's "جمع به حروف" line.
//
// Deliberately NOT a new dependency (same rule as the Arabic amount-in-words in
// utils/arabicWords.js, which this mirrors). Persian differs from Arabic in
// ways that make arabicWords.js unusable here: the "و" joiner sits between
// every part, the teens and tens are different words, and Persian uses the
// short scale with هزار / میلیون / میلیارد.

const ONES = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
const TEENS = ['ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
const TENS = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
const HUNDREDS = ['', 'صد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
// Short scale, in groups of three digits.
const SCALES = ['', 'هزار', 'میلیون', 'میلیارد', 'بیلیون'];

// 0..999 -> words (empty string for 0, callers skip empty groups).
function threeDigits(n) {
  const parts = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (rest >= 10 && rest < 20) {
    parts.push(TEENS[rest - 10]);
  } else {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    if (t) parts.push(TENS[t]);
    if (o) parts.push(ONES[o]);
  }
  return parts.join(' و ');
}

// Whole non-negative integer -> Persian words.
function numberToPersianWords(value) {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return 'صفر';

  // Split into groups of three, least significant first.
  const groups = [];
  while (n > 0) {
    groups.push(n % 1000);
    n = Math.floor(n / 1000);
  }

  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue;
    const words = threeDigits(groups[i]);
    parts.push(SCALES[i] ? `${words} ${SCALES[i]}` : words);
  }
  return parts.join(' و ');
}

// Amount -> "<words> ریال". Contract amounts in Rial are whole numbers, so any
// fraction is rounded rather than spelled out as a sub-unit.
function amountToPersianWords(value, currencyLabel = 'ریال') {
  const rounded = Math.round(Number(value) || 0);
  const negative = rounded < 0;
  const words = numberToPersianWords(Math.abs(rounded));
  return `${negative ? 'منفی ' : ''}${words} ${currencyLabel}`.trim();
}

module.exports = { numberToPersianWords, amountToPersianWords };
