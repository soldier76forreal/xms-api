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

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveJobReportTemplate, pickLabel } = require('./jobReportTemplates');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let LOGO_DATA_URI = '';
try {
  const logoPath = path.join(__dirname, '..', 'public', 'branding', 'lmc-logo.png');
  LOGO_DATA_URI = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
} catch (e) { /* logo optional — the sheet still prints without it */ }

const BRAND = { blue: '#1A3A78', blueDark: '#102A6E', blueTint: '#EEF1F8', blueTint2: '#E2E7F4' };

const RTL = new Set(['ar', 'fa']);
const SUPPORTED = new Set(['en', 'ar', 'fa']);
const resolveLang = (lang) => (SUPPORTED.has(String(lang || '').toLowerCase()) ? String(lang).toLowerCase() : 'en');

// The sheet's own words — everything that is not a template field label.
const CHROME = {
  en: {
    title: 'Daily report', filedBy: 'Filed by', date: 'Date', printed: 'Printed',
    total: 'Total', count: 'Count', none: 'Nothing recorded', notes: 'Notes',
    attachments: 'Attachments', thread: 'Follow-ups and replies', draft: 'DRAFT — not yet submitted',
    signature: 'Signature', representative: 'Representative', manager: 'Manager',
  },
  ar: {
    title: 'التقرير اليومي', filedBy: 'مقدم من', date: 'التاريخ', printed: 'تاريخ الطباعة',
    total: 'الإجمالي', count: 'العدد', none: 'لا توجد بيانات', notes: 'ملاحظات',
    attachments: 'المرفقات', thread: 'المتابعات والردود', draft: 'مسودة — لم تُرسل بعد',
    signature: 'التوقيع', representative: 'المندوب', manager: 'المدير',
  },
  fa: {
    title: 'گزارش روزانه', filedBy: 'ثبت‌کننده', date: 'تاریخ', printed: 'تاریخ چاپ',
    total: 'جمع', count: 'تعداد', none: 'موردی ثبت نشده', notes: 'یادداشت‌ها',
    attachments: 'پیوست‌ها', thread: 'پیگیری‌ها و پاسخ‌ها', draft: 'پیش‌نویس — هنوز ارسال نشده',
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

// How one stored cell prints. A reference prints its snapshot, never an id —
// the whole reason the references are snapshotted at save time.
function cellText(field, value, lang) {
  if (value == null || value === '') return '';
  switch (field.type) {
    case 'customer':
      return [value.name, value.phone].filter(Boolean).join(' · ');
    case 'variety':
      // Arabic sheets get the Arabic product name where the catalogue has one.
      return [value.code, (lang === 'ar' && value.productNameAr) || value.productName]
        .filter(Boolean).join(' — ');
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
  const cells = (section.fields || []).map((field) => {
    const text = cellText(field, values[field.key], lang);
    if (field.type === 'textarea') {
      return `<tr><td class="lbl">${esc(pickLabel(field.label, lang))}</td>
        <td class="val longval">${esc(text) || '<span class="muted">—</span>'}</td></tr>`;
    }
    return `<tr><td class="lbl">${esc(pickLabel(field.label, lang))}</td>
      <td class="val ${cellClass(field)}">${esc(text) || '—'}</td></tr>`;
  }).join('');

  return `<table class="meta">${cells}</table>`;
}

function tableSection(section, rows, lang, C) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return `<div class="empty">${esc(C.none)}</div>`;

  const cols = section.columns || [];
  const head = cols.map((c) => `<th>${esc(pickLabel(c.label, lang))}</th>`).join('');
  const body = list.map((row, i) => `<tr><td class="idx">${i + 1}</td>${cols.map((c) =>
    `<td class="${cellClass(c)}">${esc(cellText(c, row[c.key], lang)) || ''}</td>`).join('')}</tr>`).join('');

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
  const logo = options.logoDataUri || LOGO_DATA_URI;

  const body = (tpl.sections || []).map((section) => {
    const content = section.kind === 'table'
      ? tableSection(section, sections[section.key], lang, C)
      : fieldsSection(section, sections[section.key], lang);
    return `<div class="block ${section.core ? 'core' : ''}">
      <div class="sec-title">${esc(pickLabel(section.label, lang))}</div>
      ${content}
    </div>`;
  }).join('');

  const files = (report.files || []).filter((f) => f && f.name);
  const attachments = files.length ? `<div class="block">
    <div class="sec-title">${esc(C.attachments)}</div>
    <div class="muted">${files.map((f) => esc(f.name)).join(' · ')}</div>
  </div>` : '';

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<title>${esc(pickLabel(tpl.label, lang))} — ${esc(dateStr(report.reportDate))}</title>
<style>
  /* The template declares its own paper size: the salesperson sheet is
     landscape on paper and is clipped if a browser prints it as portrait. */
  @page { size: A4 ${tpl.page === 'landscape' ? 'landscape' : 'portrait'}; margin: 10mm; }
  :root { color-scheme: only light; }
  html, body { background: #ffffff; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 11px; color: #111; direction: ${dir}; }
  .ltr-inline { direction: ltr; unicode-bidi: embed; display: inline-block; }
  .muted { color: #555; font-size: 10px; }
  .header { display: flex; justify-content: space-between; align-items: center; gap: 8px;
    border-bottom: 3px solid ${BRAND.blue}; padding-bottom: 6px; margin-bottom: 8px; }
  .logo { height: 18mm; width: auto; flex-shrink: 0; }
  .doc-title { text-align: center; flex: 1; }
  .title-main { font-size: 15px; font-weight: 700; color: ${BRAND.blueDark}; }
  .title-sub { font-size: 9.5px; color: #777; }
  .who { font-size: 10px; text-align: ${dir === 'rtl' ? 'left' : 'right'}; }
  .who b { color: ${BRAND.blueDark}; }
  .draft { display: inline-block; margin-top: 3px; padding: 1px 6px; border-radius: 3px;
    background: #FFF3CD; color: #7A5B00; font-size: 9px; font-weight: 700; }
  .block { margin-bottom: 7px; break-inside: avoid; }
  .sec-title { font-size: 10.5px; font-weight: 700; color: #fff; background: ${BRAND.blue};
    padding: 3px 7px; border-radius: 3px 3px 0 0; }
  table.meta { width: 100%; border-collapse: collapse; }
  table.meta td { border: 1px solid ${BRAND.blueTint2}; padding: 4px 6px; font-size: 10px; }
  table.meta td.lbl { background: ${BRAND.blueTint}; width: 22%; color: #444; }
  table.meta td.longval { white-space: pre-wrap; }
  table.lines { width: 100%; border-collapse: collapse; }
  table.lines th { border: 1px solid ${BRAND.blue}; background: ${BRAND.blueTint}; color: ${BRAND.blueDark};
    padding: 4px 3px; font-size: 9.5px; font-weight: 700; }
  table.lines td { border: 1px solid ${BRAND.blueTint2}; padding: 3px 5px; font-size: 10px; }
  table.lines td.idx, table.lines th.idx { width: 22px; text-align: center; color: #888; }
  table.lines td.numcell { direction: ltr; text-align: ${dir === 'rtl' ? 'right' : 'left'}; }
  table.lines tr.grand td { background: ${BRAND.blueTint}; font-size: 10px; padding: 4px 7px; }
  .tot { margin-${dir === 'rtl' ? 'left' : 'right'}: 18px; }
  .empty { border: 1px dashed ${BRAND.blueTint2}; padding: 6px; color: #999; font-size: 10px; }
  .thread { border-${dir === 'rtl' ? 'right' : 'left'}: 3px solid ${BRAND.blueTint2};
    padding: 3px 7px; margin-top: 4px; font-size: 10px; }
  .thread.reply { border-color: #B26A00; }
  .signatures { display: flex; gap: 24px; margin-top: 14px; break-inside: avoid; }
  .sig { flex: 1; border-top: 1px solid #999; padding-top: 4px; font-size: 9.5px; color: #555; text-align: center; }
</style>
</head>
<body>
  <div class="header">
    ${logo ? `<img class="logo" src="${logo}" alt="">` : '<div></div>'}
    <div class="doc-title">
      <div class="title-main">${esc(pickLabel(tpl.label, lang))}</div>
      <div class="title-sub">${esc(C.title)}</div>
      ${report.status === 'draft' ? `<div class="draft">${esc(C.draft)}</div>` : ''}
    </div>
    <div class="who">
      <div>${esc(C.filedBy)}: <b>${esc(report.authorName || '')}</b></div>
      <div>${esc(C.date)}: <b class="ltr-inline">${esc(dateStr(report.reportDate))}</b></div>
      <div class="muted">${esc(C.printed)}: <span class="ltr-inline">${esc(dateStr(new Date()))}</span></div>
    </div>
  </div>

  ${body}
  ${attachments}
  ${threadBlock(report, C)}

  <div class="signatures">
    <div class="sig">${esc(C.representative)} — ${esc(C.signature)}</div>
    <div class="sig">${esc(C.manager)} — ${esc(C.signature)}</div>
  </div>
</body>
</html>`;
}

module.exports = { renderJobReportHtml, resolveLang, CHROME };
