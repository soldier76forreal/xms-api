// The three calendars a MIS document can be dated in, and the conversions
// between them: Gregorian ("normal" English dates), Jalali / Shamsi (the Iranian
// solar calendar) and Hijri (the Islamic lunar calendar, Umm al-Qura — the one
// the Gulf uses).
//
// WHAT IS STORED. A document's date is ONE absolute day (a Date at 00:00 UTC,
// which is what `new Date('2026-10-17')` produces) — never a Jalali or Hijri
// string. What the person chose is only the calendar it is ENTERED and PRINTED
// in (`dateSystem`: 'gregorian' | 'jalali' | 'hijri'). So changing the calendar
// of a document never moves its date, filters and sorting keep working on real
// dates, and nothing downstream has to know which calendar anyone prefers.
//
// NO LIBRARY. The calendars come from the platform's own Intl data, which is the
// same data the browser uses to show them. That is deliberate: a hand-written
// Jalali algorithm and an Intl-formatted date could disagree by a day, and the
// page would then print a date its own form cannot produce.
//
// THIS FILE EXISTS TWICE, like the stone-code parser: here (the server prints the
// documents) and in xms/src/tools/calendars.js (the forms). Keep them identical —
// scripts/testCalendars.js in the scratch tests runs the same checks on both.

const SYSTEMS = ['gregorian', 'jalali', 'hijri'];
const DEFAULT_DATE_SYSTEM = 'gregorian';

// Intl's calendar names.
const CALENDAR = { gregorian: 'gregory', jalali: 'persian', hijri: 'islamic-umalqura' };

const normalizeDateSystem = (value, fallback = DEFAULT_DATE_SYSTEM) => (SYSTEMS.includes(value) ? value : fallback);

// One formatter per calendar and locale: building one is the expensive part.
const formatters = {};
function formatterFor(system, locale = 'en') {
  const key = `${system}|${locale}`;
  if (!formatters[key]) {
    formatters[key] = new Intl.DateTimeFormat(`${locale}-u-ca-${CALENDAR[system]}-nu-latn`, {
      timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
    });
  }
  return formatters[key];
}

const asDate = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** { year, month, day } of an absolute day, in the given calendar. */
function partsOf(value, system = DEFAULT_DATE_SYSTEM) {
  const d = asDate(value);
  if (!d) return null;
  const out = {};
  for (const p of formatterFor(normalizeDateSystem(system)).formatToParts(d)) {
    if (p.type === 'year' || p.type === 'month' || p.type === 'day') out[p.type] = Number(p.value);
  }
  return out.year ? out : null;
}

const DAY = 24 * 60 * 60 * 1000;
const sameParts = (a, y, m, d) => a && a.year === y && a.month === m && a.day === d;

// A first guess for the Gregorian day of a Jalali / Hijri date; fromParts then
// walks the last few days to the exact one.
function guessFor(year, month, day, system) {
  if (system === 'jalali') {
    const monthDays = month <= 6 ? (month - 1) * 31 : 186 + (month - 7) * 30;
    return Date.UTC(year + 621, 2, 21) + (monthDays + (day - 1)) * DAY;
  }
  // hijri: mean lengths of the year and the month.
  return Date.UTC(622, 6, 16) + ((year - 1) * 354.36707 + (month - 1) * 29.530588 + (day - 1)) * DAY;
}

/**
 * The absolute day (00:00 UTC) for a date written in `system`, or null when that
 * date does not exist — 30 Esfand in a common year, the 30th of a 29-day Hijri
 * month, 31 April.
 */
function fromParts({ year, month, day }, system = DEFAULT_DATE_SYSTEM) {
  const y = Number(year); const m = Number(month); const d = Number(day);
  if (![y, m, d].every(Number.isInteger) || m < 1 || m > 12 || d < 1 || d > 31 || y < 1) return null;
  const sys = normalizeDateSystem(system);

  if (sys === 'gregorian') {
    const out = new Date(Date.UTC(y, m - 1, d));
    out.setUTCFullYear(y);                     // years 0–99 are otherwise read as 19xx
    return sameParts(partsOf(out, sys), y, m, d) ? out : null;
  }

  // The calendar's own (year, month, day) rises with time, so the day is found by
  // a binary search over a window around the first guess — exact, and a date that
  // does not exist lands on a neighbour and is refused below.
  const ordinal = (p) => p.year * 10000 + p.month * 100 + p.day;
  const target = y * 10000 + m * 100 + d;
  const at = (n) => ordinal(partsOf(new Date(n * DAY), sys));
  let lo = Math.round(guessFor(y, m, d, sys) / DAY) - 45;
  let hi = lo + 90;
  for (let i = 0; i < 6 && (at(lo) > target || at(hi) < target); i += 1) { lo -= 90; hi += 90; }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (at(mid) < target) lo = mid + 1; else hi = mid;
  }
  const found = new Date(lo * DAY);
  return sameParts(partsOf(found, sys), y, m, d) ? found : null;
}

/** How many days a month has (29–31) — to keep a day picker from offering one that does not exist. */
function daysInMonth(year, month, system = DEFAULT_DATE_SYSTEM) {
  for (let d = 31; d >= 28; d -= 1) {
    if (fromParts({ year, month, day: d }, system)) return d;
  }
  return 30;
}

/** 'YYYY-MM-DD' for an absolute day — what an <input type="date"> and the API use. */
function toIsoDay(value) {
  const d = asDate(value);
  return d ? d.toISOString().slice(0, 10) : '';
}

/** Today's day (as the person's own clock sees it) as an absolute day. */
function today() {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}

// The short mark after a Jalali / Hijri date, so a printed "1448/04/05" cannot be
// mistaken for a Jalali one. A Gregorian date carries none — it is what the
// documents always showed.
const TAGS = {
  en: { jalali: 'SH', hijri: 'AH' },
  ar: { jalali: 'هـ.ش', hijri: 'هـ' },
  fa: { jalali: 'ه‍.ش', hijri: 'ه‍.ق' },
};
const calendarTag = (system, lang = 'en') => {
  const sys = normalizeDateSystem(system);
  if (sys === 'gregorian') return '';
  return (TAGS[lang] || TAGS.en)[sys];
};

const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * A date as the document prints it, in Latin digits:
 *   gregorian  17/10/2026            (day first — as the documents always showed it)
 *   jalali     1405/07/25 SH         (year first — the Iranian convention)
 *   hijri      04/05/1448 AH         (day first — the Gulf convention)
 * Pass { tag: false } for the bare numbers (a label that already names the calendar).
 */
function formatDate(value, system = DEFAULT_DATE_SYSTEM, { lang = 'en', tag = true } = {}) {
  const sys = normalizeDateSystem(system);
  const p = partsOf(value, sys);
  if (!p) return '';
  const body = sys === 'jalali'
    ? `${pad(p.year, 4)}/${pad(p.month)}/${pad(p.day)}`
    : `${pad(p.day)}/${pad(p.month)}/${pad(p.year, 4)}`;
  const mark = tag ? calendarTag(sys, lang) : '';
  return mark ? `${body} ${mark}` : body;
}

/** The twelve month names of a calendar, in a language — for a month picker. */
function monthNames(system, lang = 'en') {
  const sys = normalizeDateSystem(system);
  const fmt = new Intl.DateTimeFormat(`${lang}-u-ca-${CALENDAR[sys]}-nu-latn`, { timeZone: 'UTC', month: 'long' });
  const year = sys === 'jalali' ? 1405 : sys === 'hijri' ? 1448 : 2026;
  const out = [];
  for (let m = 1; m <= 12; m += 1) {
    const day = fromParts({ year, month: m, day: 1 }, sys);
    out.push(day ? fmt.format(day) : String(m));
  }
  return out;
}

module.exports = {
  SYSTEMS, DEFAULT_DATE_SYSTEM, normalizeDateSystem,
  partsOf, fromParts, daysInMonth, toIsoDay, today,
  calendarTag, formatDate, monthNames,
};
