// ── Printed job report sheet ─────────────────────────────────────────────────
// Renders a filed report as a standalone HTML document in English, Arabic or
// Farsi. The browser prints it — same route as every other document in the app
// since 2026-10-07 (the production server cannot run headless Chrome), so this
// template declares its OWN `@page { size }` or a browser falls back to A4
// portrait and clips the salesperson sheet, which is landscape on paper.
//
// Field labels are NOT duplicated here: they come from the one template spec
// in utils/jobReportTemplates.js, which is what guarantees the printed sheet
// and the on-screen form always say the same thing in the same language.
// Only the document's own chrome ("Filed by", "Total", …) lives below.
//
// ONE PAGE, then whole pages. A day's report is meant to be a single sheet, so
// the layout is tight and a section with nothing in it collapses to a single
// strip instead of an empty bordered box. What genuinely does not fit is never
// sliced in half: every block carries `break-inside: avoid`, so an overflowing
// section moves to the next page in one piece and gets the full page there.

'use strict';

const { resolveJobReportTemplate, pickLabel, channelByValue } = require('./jobReportTemplates');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const BRAND = { blue: '#1A3A78', blueDark: '#102A6E', blueTint: '#EEF1F8', blueTint2: '#E2E7F4' };

const RTL = new Set(['ar', 'fa']);
const SUPPORTED = new Set(['en', 'ar', 'fa']);
const resolveLang = (lang) => (SUPPORTED.has(String(lang || '').toLowerCase()) ? String(lang).toLowerCase() : 'en');

// The sheet's own words — everything that is not a template field label.
const CHROME = {
  en: {
    title: 'Daily report', filedBy: 'Filed by', date: 'Date', printed: 'Printed',
    none: 'Nothing recorded', attachments: 'Attachments',
    thread: 'Follow-ups and replies', draft: 'DRAFT — not yet submitted',
    signature: 'Signature', representative: 'Representative', manager: 'Manager',
  },
  ar: {
    title: 'التقرير اليومي', filedBy: 'مقدم من', date: 'التاريخ', printed: 'تاريخ الطباعة',
    none: 'لا توجد بيانات', attachments: 'المرفقات',
    thread: 'المتابعات والردود', draft: 'مسودة — لم تُرسل بعد',
    signature: 'التوقيع', representative: 'المندوب', manager: 'المدير',
  },
  fa: {
    title: 'گزارش روزانه', filedBy: 'ثبت‌کننده', date: 'تاریخ', printed: 'تاریخ چاپ',
    none: 'موردی ثبت نشده', attachments: 'پیوست‌ها',
    thread: 'پیگیری‌ها و پاسخ‌ها', draft: 'پیش‌نویس — هنوز ارسال نشده',
    signature: 'امضا', representative: 'نماینده', manager: 'مدیر',
  },
};

const dateStr = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};

const num = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));

// Is there anything in this cell? A reference is an object, so truthiness alone
// would call {text:''} filled.
const cellIsEmpty = (v) => {
  if (v == null || v === '') return true;
  if (typeof v !== 'object') return false;
  return Object.values(v).every((inner) => inner == null || inner === '');
};

// How one stored cell prints. A reference prints its snapshot, never an id —
// the whole reason the references are snapshotted at save time.
function cellText(field, value, lang) {
  if (cellIsEmpty(value)) return '';
  switch (field.type) {
    case 'customer':
      return [value.name, value.phone].filter(Boolean).join(' · ');
    case 'variety':
      // A stone the catalogue does not carry was typed as plain text.
      if (value.text) return value.text;
      // Arabic sheets get the Arabic product name where the catalogue has one.
      return [value.code, (lang === 'ar' && value.productNameAr) || value.productName]
        .filter(Boolean).join(' — ');
    case 'recipient': {
      if (value.mode === 'channel') {
        const ch = channelByValue(value.channel);
        return ch ? pickLabel(ch.label, lang) : value.channel;
      }
      if (value.mode === 'customer') return [value.name, value.phone].filter(Boolean).join(' · ');
      return value.text || '';
    }
    case 'dmContent':
      return value.title || '';
    case 'date':   return dateStr(value);
    case 'number':
    case 'money':  return num(value);
    case 'select': {
      const opt = (field.options || []).find((o) => o.value === value);
      return opt ? pickLabel(opt.label, lang) : String(value);
    }
    default:       return String(value);
  }
}

// A number/money column is read as a figure, so it stays left-to-right even on
// an Arabic sheet; everything else follows the document's own direction.
const cellClass = (field) => (field.type === 'number' || field.type === 'money' ? 'numcell' : '');

function fieldsSection(section, data, lang) {
  const values = data || {};
  const filled = (section.fields || []).filter((f) => !cellIsEmpty(values[f.key]));
  if (!filled.length) return null;

  const cells = filled.map((field) => {
    const text = cellText(field, values[field.key], lang);
    if (field.type === 'textarea') {
      return `<tr><td class="lbl">${esc(pickLabel(field.label, lang))}</td>
        <td class="val longval" colspan="3">${esc(text)}</td></tr>`;
    }
    return `<tr><td class="lbl">${esc(pickLabel(field.label, lang))}</td>
      <td class="val ${cellClass(field)}">${esc(text)}</td></tr>`;
  });

  // Two label/value pairs per row — a one-per-row list of five short answers
  // wastes half the width, and the width is what buys the single page.
  const rows = [];
  let buffer = '';
  cells.forEach((cell) => {
    if (cell.includes('colspan="3"')) {
      if (buffer) { rows.push(`<tr>${buffer}</tr>`); buffer = ''; }
      rows.push(cell);
      return;
    }
    const inner = cell.replace(/^\s*<tr>/, '').replace(/<\/tr>\s*$/, '');
    if (buffer) { rows.push(`<tr>${buffer}${inner}</tr>`); buffer = ''; } else { buffer = inner; }
  });
  if (buffer) rows.push(`<tr>${buffer}<td class="lbl"></td><td class="val"></td></tr>`);

  return `<table class="meta">${rows.join('')}</table>`;
}

function tableSection(section, rows, lang) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => !Object.values(r || {}).every(cellIsEmpty));
  if (!list.length) return null;

  const cols = section.columns || [];
  const head = cols.map((c) => `<th>${esc(pickLabel(c.label, lang))}</th>`).join('');
  const body = list.map((row, i) => `<tr><td class="idx">${i + 1}</td>${cols.map((c) =>
    `<td class="${cellClass(c)}">${esc(cellText(c, row[c.key], lang))}</td>`).join('')}</tr>`).join('');

  // The paper form carries its summary cells under the table; so does this.
  let totals = '';
  if (section.totals && section.totals.length) {
    totals = `<tr class="grand">
      <td colspan="${cols.length + 1}">${section.totals.map((tot) => {
    const value = tot.of
      ? list.reduce((sum, r) => sum + (Number(r[tot.of]) || 0), 0)
      : list.length;
    return `<span class="tot"><b>${esc(pickLabel(tot.label, lang))}:</b> <span class="ltr-inline">${esc(num(value))}</span></span>`;
  }).join('')}</td></tr>`;
  }

  return `<table class="lines">
    <thead><tr><th class="idx">#</th>${head}</tr></thead>
    <tbody>${body}${totals}</tbody>
  </table>`;
}

function threadBlock(report, C) {
  const entries = [
    ...(report.followUps || []).map((f) => ({ ...f, kind: 'followUp' })),
    ...(report.replies || []).map((r) => ({ ...r, kind: 'reply' })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!entries.length) return '';

  return `<div class="block">
    <div class="sec-title">${esc(C.thread)}</div>
    ${entries.map((e) => `<div class="thread ${e.kind}">
      <b>${esc(e.authorName || '')}</b>
      <span class="muted ltr-inline">${esc(dateStr(e.date))}</span>
      <div>${esc(e.body || '')}</div>
    </div>`).join('')}
  </div>`;
}

function renderJobReportHtml(report, options = {}) {
  const lang = resolveLang(options.lang);
  const dir = RTL.has(lang) ? 'rtl' : 'ltr';
  const C = CHROME[lang];
  const tpl = resolveJobReportTemplate(report.templateKey);
  const sections = report.sections || {};

  // Sections with content are laid out in full; the ones with nothing in them
  // are named together on a single strip, which is what keeps an ordinary day
  // on one page instead of spending nine blocks saying "nothing".
  const empties = [];
  const body = (tpl.sections || []).map((section) => {
    const content = section.kind === 'table'
      ? tableSection(section, sections[section.key], lang)
      : fieldsSection(section, sections[section.key], lang);
    if (!content) { empties.push(pickLabel(section.label, lang)); return ''; }
    return `<div class="block">
      <div class="sec-title">${esc(pickLabel(section.label, lang))}</div>
      ${content}
    </div>`;
  }).join('');

  const emptyStrip = empties.length
    ? `<div class="block empties"><b>${esc(C.none)}:</b> ${empties.map(esc).join(' · ')}</div>`
    : '';

  const files = (report.files || []).filter((f) => f && f.name);
  const attachments = files.length ? `<div class="block">
    <div class="sec-title">${esc(C.attachments)}</div>
    <div class="pad muted">${files.map((f) => esc(f.name)).join(' · ')}</div>
  </div>` : '';

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<title>${esc(pickLabel(tpl.label, lang))} — ${esc(dateStr(report.reportDate))}</title>
<style>
  /* The template declares its own paper size: the salesperson sheet is
     landscape on paper and is clipped if a browser prints it as portrait. */
  @page { size: A4 ${tpl.page === 'landscape' ? 'landscape' : 'portrait'}; margin: 8mm; }
  :root { color-scheme: only light; }
  html, body { background: #ffffff; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 10px; color: #111; direction: ${dir}; }
  .ltr-inline { direction: ltr; unicode-bidi: embed; display: inline-block; }
  .muted { color: #555; font-size: 9px; }

  /* No logo: the sheet is an internal record, and the space it took is worth
     more as content — one line of identification is enough. */
  .header { display: flex; align-items: baseline; gap: 10px;
    border-bottom: 2px solid ${BRAND.blue}; padding-bottom: 4px; margin-bottom: 6px; }
  .title-main { font-size: 13px; font-weight: 700; color: ${BRAND.blueDark}; }
  .title-sub { font-size: 9px; color: #888; }
  .who { margin-inline-start: auto; font-size: 9.5px; text-align: ${dir === 'rtl' ? 'left' : 'right'}; }
  .who b { color: ${BRAND.blueDark}; }
  .who span + span { margin-inline-start: 10px; }
  .draft { display: inline-block; padding: 0 5px; border-radius: 3px;
    background: #FFF3CD; color: #7A5B00; font-size: 8.5px; font-weight: 700; }

  /* A section is never sliced across a page break: what does not fit moves
     whole to the next page and has the full page there. */
  .block { margin-bottom: 5px; break-inside: avoid; page-break-inside: avoid; }
  .sec-title { font-size: 9.5px; font-weight: 700; color: #fff; background: ${BRAND.blue};
    padding: 2px 6px; border-radius: 3px 3px 0 0; }
  .pad { padding: 3px 6px; }
  .empties { font-size: 9px; color: #777; border: 1px dashed ${BRAND.blueTint2};
    border-radius: 3px; padding: 3px 6px; }

  table.meta { width: 100%; border-collapse: collapse; }
  table.meta td { border: 1px solid ${BRAND.blueTint2}; padding: 2px 6px; font-size: 9.5px; }
  table.meta td.lbl { background: ${BRAND.blueTint}; width: 16%; color: #444; }
  table.meta td.longval { white-space: pre-wrap; }

  table.lines { width: 100%; border-collapse: collapse; }
  table.lines th { border: 1px solid ${BRAND.blue}; background: ${BRAND.blueTint}; color: ${BRAND.blueDark};
    padding: 2px 3px; font-size: 9px; font-weight: 700; }
  table.lines td { border: 1px solid ${BRAND.blueTint2}; padding: 2px 5px; font-size: 9.5px; }
  table.lines td.idx, table.lines th.idx { width: 20px; text-align: center; color: #888; }
  table.lines td.numcell { direction: ltr; text-align: ${dir === 'rtl' ? 'right' : 'left'}; }
  table.lines tr.grand td { background: ${BRAND.blueTint}; padding: 2px 6px; }
  .tot { margin-inline-end: 16px; }

  .thread { border-inline-start: 3px solid ${BRAND.blueTint2};
    padding: 2px 6px; margin-top: 3px; font-size: 9.5px; }
  .thread.reply { border-color: #B26A00; }

  .signatures { display: flex; gap: 24px; margin-top: 10px; break-inside: avoid; }
  .sig { flex: 1; border-top: 1px solid #999; padding-top: 3px; font-size: 9px; color: #555; text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title-main">${esc(pickLabel(tpl.label, lang))}</div>
      <div class="title-sub">${esc(C.title)}</div>
    </div>
    ${report.status === 'draft' ? `<div class="draft">${esc(C.draft)}</div>` : ''}
    <div class="who">
      <span>${esc(C.filedBy)}: <b>${esc(report.authorName || '')}</b></span>
      <span>${esc(C.date)}: <b class="ltr-inline">${esc(dateStr(report.reportDate))}</b></span>
      <span class="muted">${esc(C.printed)}: <span class="ltr-inline">${esc(dateStr(new Date()))}</span></span>
    </div>
  </div>

  ${body}
  ${attachments}
  ${threadBlock(report, C)}
  ${emptyStrip}

  <div class="signatures">
    <div class="sig">${esc(C.representative)} — ${esc(C.signature)}</div>
    <div class="sig">${esc(C.manager)} — ${esc(C.signature)}</div>
  </div>
</body>
</html>`;
}

module.exports = { renderJobReportHtml, resolveLang, CHROME };
