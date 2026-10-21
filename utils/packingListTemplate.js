// Session 72 (Phase 3) — standalone Packing List + per-pallet Label PDF
// templates, built from the two real sample documents Pouriya provided (a
// per-pallet label and a consolidated packing-list/shipping-voucher).
// Reuses invoiceTemplate.js's visual language (same brand colors, same table/
// meta CSS classes) so every MIS PDF in the app looks like one family — see
// that file for the invoice/quotation template this deliberately mirrors.
const fs = require('fs');
const path = require('path');
const { LANG, resolveLang } = require('./invoiceLang');
const { parseStoneCode } = require('./stoneCodeParser');
const { formatDate } = require('./calendars');
const { documentFontCss, fontFaceCss, fontStack } = require('./documentFonts');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));

// The list's date, written in the calendar it was entered in (Gregorian, Jalali
// or Hijri — utils/calendars.js). Gregorian stays dd/mm/yyyy, as it always was.
const dateStr = (d, doc, lang) => (d ? formatDate(d, doc && doc.dateSystem, { lang }) : '');

let LOGO_DATA_URI = '';
try {
  const logoPath = path.join(__dirname, '..', 'public', 'branding', 'lmc-logo.png');
  LOGO_DATA_URI = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
} catch (e) { /* logo optional — template still renders without it */ }

const BRAND = { blue: '#1A3A78', blueDark: '#102A6E', blueTint: '#EEF1F8', blueTint2: '#E2E7F4' };

// profile.logoDataUri is resolved per-branch by the ROUTE (see
// utils/resolveBranchLogo.js) before this template ever runs — keeps this
// file DB-free, matching invoiceTemplate.js's architecture.
const logoFor = (profile) => (profile && profile.logoDataUri) || LOGO_DATA_URI;

// ── Print type ───────────────────────────────────────────────────────────────
// These documents are read on PAPER - often a photocopy of the printout, in a warehouse or at a border post. Type that
// is comfortable on a monitor (a 10 px table, pale grey notes, light-blue borders) comes out at 7 pt in washed-out ink.
// So, for print:
//   · body 12.5 px (9.4 pt), table cells 12 px, headers 11.5 px bold, nothing under 11 px;
//   · text is black (labels dark grey) - never the #555-#777 greys the screen layout used;
//   · borders are a mid blue-grey, strong enough to survive a photocopy;
//   · header cells are DARK text on a light fill. White-on-blue vanishes when the print dialog leaves "Background
//     graphics" off, so legibility never depends on a fill (the fills are still asked for, see print-color-adjust).
const INK = { border: '#8693b8', borderStrong: '#5c6b99', head: '#d9e0f2', headText: '#0b1f4d', zebra: '#f5f7fc', total: '#e3e9f7' };

const baseStyles = `
  @page { margin: 10mm; }
  :root { color-scheme: only light; }
  html, body { background: #ffffff; }
  /* The browser prints these too, and its print dialog leaves "Background graphics" OFF by default - which
     would drop every fill. Ask for the fills explicitly. */
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 12.5px; line-height: 1.35; color: #000; }
  .ltr { direction: ltr; text-align: left; }
  .rtl { direction: rtl; text-align: right; }
  .ltr-inline { direction: ltr; unicode-bidi: embed; }
  .muted { color: #222; font-size: 11.5px; }

  /* The page is a table whose THEAD is the page header: a browser prints a table's header again at the top of every
     page the table spills onto, so a long list keeps its logo, title and number (and its column headings, below) on
     every sheet. Nothing but the header goes in the thead. */
  table.frame { width: 100%; border-collapse: collapse; }
  table.frame > thead > tr > td, table.frame > tbody > tr > td { padding: 0; border: 0; }

  .header { display: flex; justify-content: space-between; align-items: center; gap: 8px; border-bottom: 3px solid ${BRAND.blue}; padding-bottom: 6px; margin-bottom: 8px; }
  .logo { height: 22mm; width: auto; flex-shrink: 0; }
  .co-name { font-size: 15px; font-weight: 700; color: ${BRAND.blue}; }
  /* The packing list's own number - what the paper is referred to by - stands out from the date line. */
  .pl-no { font-size: 12.5px; color: #000; margin: 3px 0 1px; }
  .pl-no b { font-size: 19px; color: ${BRAND.blue}; letter-spacing: 0.3px; }
  .doc-title { text-align: center; flex: 1; }
  .title-main { font-size: 17px; font-weight: 700; color: ${BRAND.blueDark}; }
  .title-sub { font-size: 11px; color: #333; }

  table.meta { width: 100%; border-collapse: collapse; margin: 5px 0; break-inside: avoid; }
  table.meta td { border: 1px solid ${INK.border}; padding: 5px 7px; background: ${BRAND.blueTint}; font-size: 12px; color: #000; }
  table.meta td b { font-weight: 700; }

  table.lines { width: 100%; border-collapse: collapse; margin: 8px 0; }
  table.lines th { border: 1px solid ${INK.borderStrong}; border-bottom: 2px solid ${BRAND.blue}; background: ${INK.head}; color: ${INK.headText}; padding: 5px 4px; font-size: 11.5px; font-weight: 800; }
  table.lines td { border: 1px solid ${INK.border}; padding: 4px 5px; text-align: center; font-size: 12px; color: #000; }
  /* A row is never cut across two pages: what does not fit moves to the next page whole. */
  table.lines tr { break-inside: avoid; }
  table.lines tbody tr:nth-child(even) td { background: ${INK.zebra}; }
  table.lines tbody tr.last { break-after: avoid; }
  table.lines tbody tr.grand td { font-weight: 700; font-size: 12.5px; background: ${INK.total}; border-top: 2px solid ${BRAND.blue}; }
  /* Notes: the person's own words - kept whole on one page, line breaks kept, each line in its own direction. */
  table.notes { margin-top: 10px; break-inside: avoid; }
  table.notes td { padding: 7px 9px; }
  .note-text { margin-top: 3px; font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; unicode-bidi: plaintext; text-align: start; }
  table.sign { margin-top: 12px; }
  table.sign .muted { color: #222; font-size: 11.5px; }
`;

// ── Packing list — A4, consolidated multi-pallet document ──────────────────

// The stone names a list was made for, in the language of the document: a name picked from Inventory carries its
// Arabic / Persian spelling when it has one, a typed name is printed as typed.
function stoneNamesFor(doc, langKey) {
  const names = [];
  for (const s of (doc.stoneNames || [])) {
    const localized = langKey === 'ar' ? s.nameAr : langKey === 'fa' ? s.nameFa : '';
    const text = String(localized || s.name || s.code || '').trim();
    if (text && !names.includes(text)) names.push(text);
  }
  return names;
}

function packingListMetaBlock(doc, L, langKey) {
  const d = doc.driverInfo || {}, v = doc.vehicleInfo || {}, c = doc.customsAgent || {};
  const stones = stoneNamesFor(doc, langKey);
  return `
  <table class="meta">
    <tr>
      <td>${esc(L.driverFullName)} <b>${esc(d.fullName)}</b></td>
      <td>${esc(L.driverNationalId)} <b>${esc(d.nationalId)}</b></td>
      <td>${esc(L.driverSmartNumber)} <b>${esc(d.smartNumber)}</b></td>
    </tr>
    <tr>
      <td>${esc(L.driverPhone)} <b class="ltr-inline">${esc(d.phone)}</b></td>
      <td>${esc(L.driverIban)} <b class="ltr-inline">${esc(d.iban)}</b></td>
      <td>${esc(L.trailerPlate)} <b>${esc(v.trailerPlateNumber)}</b></td>
    </tr>
    <tr>
      <td>${esc(L.trailerSmartNumber)} <b>${esc(v.trailerSmartNumber)}</b></td>
      <td>${esc(L.customsAgentName)} <b>${esc(c.name)}</b></td>
      <td>${esc(L.customsAgentPhone)} <b class="ltr-inline">${esc(c.phone)}</b></td>
    </tr>
    <tr>
      <td colspan="3">${esc(L.originAddress)} <b>${esc(doc.originAddress)}</b></td>
    </tr>
    <tr>
      <td colspan="2">${esc(L.destinationAddress)} <b>${esc(doc.destinationAddress)}</b></td>
      <td>${esc(L.standardThickness)} <b>${doc.standardThicknessCm != null ? esc(doc.standardThicknessCm) : ''}</b></td>
    </tr>
    ${doc.shippingDestination ? `<tr><td colspan="3">${esc(L.shippingDestination)} <b>${esc(doc.shippingDestination)}</b></td></tr>` : ''}
    ${stones.length ? `<tr><td colspan="3">${esc(stones.length === 1 ? L.stoneName : L.stoneNames)} <b>${stones.map(esc).join(' · ')}</b></td></tr>` : ''}
  </table>`;
}

// One row per cut on a pallet, in the order the pallets are listed. (The per-pallet summary table that used to
// precede this one was dropped from the print on request - the data it summarised is all still in the list.)
function packingListItemsTable(doc, L) {
  const rows = [];
  let i = 0;
  for (const p of (doc.pallets || [])) {
    for (const it of (p.items || [])) {
      i += 1;
      rows.push(`
      <tr>
        <td>${i}</td>
        <td>${esc(p.palletId)}${p.reference ? ` (${esc(p.reference)})` : ''}</td>
        <td class="ltr-inline">${esc(it.code)}</td>
        <td>${it.lengthCm != null ? num(it.lengthCm) : ''}</td>
        <td>${it.widthCm != null ? num(it.widthCm) : ''}</td>
        <td>${it.thicknessCm != null ? num(it.thicknessCm) : ''}</td>
        <td>${it.pcs != null ? esc(it.pcs) : ''}</td>
        <td>${it.sqm != null ? num(it.sqm) : ''}</td>
      </tr>`);
    }
  }
  // the last cut keeps company with the total row: a page never ends on the cut and starts on the total alone
  if (rows.length) rows[rows.length - 1] = rows[rows.length - 1].replace('<tr>', '<tr class="last">');
  // The total is a body row, not a tfoot: a browser prints a table's footer again at the bottom of EVERY page,
  // which would show a grand total under each page of a long list.
  return `
  <table class="lines">
    <thead><tr>
      <th>${esc(L.col_no)}</th><th>${esc(L.pl_pallet)}</th><th>${esc(L.col_code)}</th>
      <th>${esc(L.pl_length)}</th><th>${esc(L.pl_width)}</th><th>${esc(L.pl_thickness)}</th>
      <th>${esc(L.pl_pcs)}</th><th>${esc(L.pl_sqm)}</th>
    </tr></thead>
    <tbody>${rows.join('')}
    <tr class="grand">
      <td colspan="6">${esc(L.total)}</td>
      <td>${doc.totals?.totalPcs != null ? esc(doc.totals.totalPcs) : ''}</td>
      <td>${doc.totals?.totalSqm != null ? num(doc.totals.totalSqm) : ''}</td>
    </tr></tbody>
  </table>`;
}

// The list's free-text notes, printed as written (line breaks kept) between the tables and the signatures.
// Nothing at all when there are none, so a list without notes prints exactly as it always did.
function packingListNotes(doc, L) {
  const notes = String(doc.notes || '').trim();
  if (!notes) return '';
  return `
  <table class="meta notes">
    <tr><td>
      <div class="muted">${esc(L.pl_notes)}</div>
      <div class="note-text">${esc(notes)}</div>
    </td></tr>
  </table>`;
}

function packingListSignatures(doc, L) {
  const officer = doc.loadingOfficer || {};
  return `
  <table class="meta sign">
    <tr>
      <td style="text-align:center;">
        <div class="muted">${esc(L.sigCustoms)}</div>
        <div style="height:14mm;"></div>
      </td>
      <td style="text-align:center;">
        <div class="muted">${esc(L.sigDriver)}</div>
        <div style="height:14mm;"></div>
      </td>
      <td style="text-align:center;">
        <div class="muted">${esc(L.sigLoadingOfficer)}</div>
        <b>${esc(officer.name)}${officer.phone ? ' · ' + esc(officer.phone) : ''}</b>
        <div style="height:10mm;"></div>
      </td>
    </tr>
  </table>`;
}

function renderClassicPackingListHtml(doc, branch, profile = {}, lang) {
  const langKey = resolveLang(lang);
  const L = LANG[langKey];
  const logo = logoFor(profile);
  const coName = langKey === 'en' ? (profile.nameEn || branch?.name) : (profile.nameAr || branch?.name);

  const pageHeader = `
    <div class="header">
      ${logo ? `<img class="logo" src="${logo}" alt="LMC"/>` : ''}
      <div class="doc-title">
        <div class="title-main">${esc(L.plConsolidatedTitle)}</div>
        <div class="title-sub">${esc(L.plConsolidatedTitleSub)}</div>
      </div>
      <div class="${langKey === 'en' ? 'ltr' : 'rtl'}" style="width:30%;">
        <div class="co-name">${esc(coName)}</div>
        <div class="pl-no">${esc(L.plNumber)} <b class="ltr-inline">${esc(doc.docNumber)}</b></div>
        <div class="muted">${esc(L.date)} <b class="ltr-inline">${dateStr(doc.issueDate || doc.insertDate, doc, langKey)}</b></div>
      </div>
    </div>`;

  return `<!doctype html>
<html dir="${L.dir}" lang="${langKey}">
<head>
<meta charset="utf-8"/>
<meta name="color-scheme" content="only light"/>
<title>${esc(L.plConsolidatedTitle)} ${esc(doc.docNumber)}</title>
<style>${baseStyles}
  /* The browser prints this document too (Save as PDF), not only the server —
     so it declares its own paper size. */
  @page { size: A4; margin: 10mm 10mm 12mm 10mm; }
  body { direction: ${L.dir}; }
  .page { width: 190mm; margin: 0 auto; padding: 4mm 0; }${documentFontCss(langKey)}
</style>
</head>
<body>
  <div class="page">
    <table class="frame">
      <thead><tr><td>${pageHeader}
      </td></tr></thead>
      <tbody><tr><td>
    ${packingListMetaBlock(doc, L, langKey)}

    <table class="meta">
      <tr>
        <td>${esc(L.totalPallets)} <b>${doc.totals?.totalPallets ?? ''}</b></td>
        <td>${esc(L.totalArea)} <b>${doc.totals?.totalSqm != null ? num(doc.totals.totalSqm) : ''}</b></td>
        <td>${esc(L.totalItems)} <b>${doc.totals?.totalPcs ?? ''}</b></td>
      </tr>
    </table>

    ${packingListItemsTable(doc, L)}${packingListNotes(doc, L)}
    ${packingListSignatures(doc, L)}
      </td></tr></tbody>
    </table>
  </div>
</body>
</html>`;
}

// ── Pallet label (slab) — A5 portrait, built from the real sample label ─────
//
// The sample ("llablesss.pdf") is an A5 portrait page, 148 × 210 mm: one bordered table that fills it —
// a header (the logo and the two addresses, the pallet id over its reference), the columns
// # · Code · L · W · H · PCS · m², every cut in a tall bold row, a grey Total row and the website.
// This template follows it. An earlier version was drawn on an inferred 100 × 150 mm page; on real paper
// that came out small, with type too fine to read — which is what this page size and layout replace.
//
// Everything is placed in millimetres and sized from the number of rows, so the label does not depend on
// how a browser or a printer happens to lay a table out. With a few cuts the rows are tall and the type
// large (up to 20 pt, as on the sample); with many they get shorter and the type steps down so the whole
// pallet still fits ONE page. Past SLAB.rowsPerPageMax rows the pallet continues on a second identical
// page (balanced, so no page holds a lone row) rather than shrinking into something nobody can read.

const SLAB = (() => {
  const s = {
    pageW: 148, pageH: 210,   // A5 portrait
    pad: 6,                   // clear of the unprintable edge every printer has
    headRowH: 17,             // the header is two of these: the pallet id, then its reference
    theadH: 10, totalH: 10, footH: 10,
    maxRowH: 16,              // about the sample's own row height
    minRowH: 6.5,             // below this the type is too small to read from a pallet
  };
  s.boxW = s.pageW - 2 * s.pad;
  s.boxH = s.pageH - 2 * s.pad;
  s.rowsH = s.boxH - 2 * s.headRowH - s.theadH - s.totalH - s.footH;
  s.rowsPerPageMax = Math.floor(s.rowsH / s.minRowH);
  return s;
})();

const SLAB_SERIF = "Cambria, 'Times New Roman', Times, serif";
const SLAB_WEBSITE = 'WWW.LAZULITEMARBLE.COM';
const SLAB_COLS = ['no', 'code', 'l', 'w', 'h', 'pcs', 'sqm'];
// How the width left over is shared out once every column has what its widest entry needs.
const SLAB_WEIGHTS = [1, 2.2, 2, 2, 1.4, 1.6, 2.2];
const SLAB_HEAD_PT = 12.5;
const SLAB_CELL_PAD_MM = 3;      // left + right padding of a cell, together
const SLAB_LOGO_MM = 24;

const MM_PER_PT = 25.4 / 72;
// Average advance of a bold serif digit or capital as a share of its font size - measured, then rounded
// UP, so a value that "fits" on paper really does.
const GLYPH_EM = 0.6;
const slabChars = (s) => [...String(s == null ? '' : s)].length;
const slabTextMm = (chars, pt) => chars * pt * GLYPH_EM * MM_PER_PT;
const sumOf = (list) => list.reduce((a, b) => a + b, 0);
const fixed2 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The column captions: the sample's own for English, the translated ones otherwise.
function slabHeads(langKey, L) {
  if (langKey === 'en') return { no: '#', code: 'Code', l: 'L', w: 'W', h: 'H', pcs: 'PCS', sqm: 'm²', total: 'Total' };
  return { no: '#', code: L.col_code, l: L.pl_length, w: L.pl_width, h: L.pl_thickness, pcs: L.pl_pcs, sqm: L.pl_sqm, total: L.total };
}

// Row height, type size and column widths for a label with this many rows of this content.
function slabLayout(table, heads, totals) {
  const count = Math.max(1, table.length);
  const pages = Math.ceil(count / SLAB.rowsPerPageMax);
  const perPage = Math.ceil(count / pages);
  const rowH = Math.min(SLAB.maxRowH, SLAB.rowsH / perPage);

  // the longest thing in each column: its values, its caption and - for the last two - the totals
  const widest = SLAB_COLS.map((key, c) => {
    let w = key === 'no' ? Math.max(2, slabChars(count)) : 0;
    for (const row of table) w = Math.max(w, slabChars(row[c]));
    if (key === 'pcs') w = Math.max(w, slabChars(totals.pcs));
    if (key === 'sqm') w = Math.max(w, slabChars(totals.sqm));
    return w;
  });
  const headChars = SLAB_COLS.map((key) => slabChars(heads[key]));

  // Start from the biggest type the row height allows and step it down until every column fits the box.
  let pt = Math.max(9, Math.min(20, rowH * 1.4));
  let needs;
  for (;;) {
    const headPt = Math.min(SLAB_HEAD_PT, pt);
    needs = widest.map((w, c) => Math.max(slabTextMm(w, pt), slabTextMm(headChars[c], headPt)) + SLAB_CELL_PAD_MM);
    if (sumOf(needs) <= SLAB.boxW || pt <= 6) break;
    pt = Math.max(6, pt * 0.95);
  }

  const spare = SLAB.boxW - sumOf(needs);
  const weightSum = sumOf(SLAB_WEIGHTS);
  const widths = spare >= 0
    ? needs.map((n, c) => n + (spare * SLAB_WEIGHTS[c]) / weightSum)
    : needs.map((n) => (n * SLAB.boxW) / sumOf(needs));   // even 6 pt would not fit: squeeze, the cells clip
  return { pages, perPage, rowH, pt, headPt: Math.min(SLAB_HEAD_PT, pt), widths };
}

// The biggest type (13 pt down to 7) at which the header's text still fits beside the logo.
function slabAddressPt(paragraphs, widthMm, heightMm) {
  for (const pt of [13, 12, 11, 10, 9, 8]) {
    // 0.9: a line breaks at a space, so it never quite reaches the full width
    const perLine = Math.max(1, Math.floor((widthMm * 0.9) / (pt * 0.52 * MM_PER_PT)));
    let lines = 0;
    for (const p of paragraphs) {
      for (const segment of String(p).split('\n')) lines += Math.max(1, Math.ceil(slabChars(segment) / perLine));
    }
    if (lines * pt * 1.25 * MM_PER_PT + (paragraphs.length - 1) * 1.5 <= heightMm) return pt;
  }
  return 7;
}

// A single value (the pallet id, its reference) set as large as its cell allows.
function slabFitPt(text, widthMm, maxPt, minPt) {
  const chars = Math.max(1, slabChars(text));
  const pt = (widthMm - SLAB_CELL_PAD_MM) / (chars * GLYPH_EM * MM_PER_PT);
  return Math.round(Math.max(minPt, Math.min(maxPt, pt)) * 10) / 10;
}

function renderClassicPalletLabelHtml(doc, pallet, branch, profile = {}, lang) {
  const langKey = resolveLang(lang);
  const L = LANG[langKey];
  const heads = slabHeads(langKey, L);
  const logo = logoFor(profile);
  const items = pallet.items || [];

  // [#, code, L, W, H, PCS, m²] as text - the row number is filled in when a page is drawn
  const table = items.map((it) => [
    '', it.code || '',
    it.lengthCm != null ? num(it.lengthCm) : '', it.widthCm != null ? num(it.widthCm) : '',
    it.thicknessCm != null ? num(it.thicknessCm) : '',
    it.pcs != null ? String(it.pcs) : '', it.sqm != null ? fixed2(it.sqm) : '',
  ]);
  const totalPcs = items.reduce((a, it) => a + (Number(it.pcs) || 0), 0);
  const totalSqm = items.reduce((a, it) => a + (Number(it.sqm) || 0), 0);
  const totals = {
    pcs: totalPcs ? String(totalPcs) : '',
    sqm: items.some((it) => it.sqm != null) ? fixed2(totalSqm) : '',
  };

  const layout = slabLayout(table, heads, totals);
  const { widths, rowH, pt, headPt, pages } = layout;
  const leftW = sumOf(widths.slice(0, 6));   // the header's left block spans # .. PCS ...
  const rightW = widths[6];                  // ... and the pallet id sits over the m² column, as on the sample

  // The header: the origin and destination addresses as the sample has them (the issuing company when a
  // list carries neither), the pallet id big, its reference under it.
  const company = langKey === 'en' ? (profile.nameEn || branch?.name) : (profile.nameAr || branch?.name);
  let paragraphs = [doc.originAddress, doc.destinationAddress].map((s) => String(s || '').trim()).filter(Boolean);
  if (!paragraphs.length) paragraphs = [company, branch?.address].map((s) => String(s || '').trim()).filter(Boolean);
  const textW = leftW - (logo ? SLAB_LOGO_MM + 9 : 6);
  const addressPt = slabAddressPt(paragraphs, textW, SLAB.headRowH * 2 - 4);
  const idPt = slabFitPt(pallet.palletId, rightW, 28, 10);
  const refPt = slabFitPt(pallet.reference, rightW, 22, 9);

  const blank = ['', '', '', '', '', '', ''];
  const source = table.length ? table : [blank];
  const slices = [];
  for (let i = 0; i < source.length; i += layout.perPage) slices.push(source.slice(i, i + layout.perPage));

  const pageHtml = (slice, offset, pageNo) => {
    const rows = slice.map((r, i) => `
      <tr class="row">
        <td>${table.length ? offset + i + 1 : ''}</td>
        <td class="ltr">${esc(r[1])}</td>
        <td>${esc(r[2])}</td><td>${esc(r[3])}</td><td>${esc(r[4])}</td><td>${esc(r[5])}</td><td>${esc(r[6])}</td>
      </tr>`).join('');
    const last = pageNo === pages;
    const arrow = L.dir === 'rtl' ? '←' : '→';
    const totalRow = last
      ? `<tr class="tot"><td class="tl" colspan="5">${esc(heads.total)}</td><td>${esc(totals.pcs)}</td><td>${esc(totals.sqm)}</td></tr>`
      : `<tr class="tot"><td colspan="7">${pageNo} / ${pages} ${arrow}</td></tr>`;
    return `
  <section class="sheet">
    <table class="lbl">
      <colgroup>${widths.map((w) => `<col style="width:${w.toFixed(3)}mm"/>`).join('')}</colgroup>
      <tr class="hd">
        <td class="idc" colspan="6" rowspan="2">
          <div class="idw">
            ${logo ? `<div class="lg"><img src="${logo}" alt="LMC"/></div>` : ''}
            <div class="ad" style="font-size:${addressPt}pt">${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
          </div>
        </td>
        <td class="pid" style="font-size:${idPt}pt">${esc(pallet.palletId)}</td>
      </tr>
      <tr class="hd"><td class="pref" style="font-size:${refPt}pt">${esc(pallet.reference)}</td></tr>
      <tr class="th" style="font-size:${headPt}pt">
        ${SLAB_COLS.map((key) => `<th>${esc(heads[key])}</th>`).join('')}
      </tr>
      ${rows}
      ${totalRow}
      <tr class="ft"><td colspan="7"><span class="web">${SLAB_WEBSITE}</span>${pages > 1 ? `<span class="pg">${pageNo} / ${pages}</span>` : ''}</td></tr>
    </table>
  </section>`;
  };

  return `<!doctype html>
<html dir="${L.dir}" lang="${langKey}">
<head>
<meta charset="utf-8"/>
<meta name="color-scheme" content="only light"/>
<title>${esc(L.labelPalletId)} ${esc(pallet.palletId)}</title>
<style>
  /* The size labelPageSize('slab') hands the server renderer; declared here as well so a browser print
     uses it instead of A4 / Letter. */
  @page { size: ${SLAB.pageW}mm ${SLAB.pageH}mm; margin: 0; }
  :root { color-scheme: only light; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; background: #ffffff; }
  body { direction: ${L.dir}; font-family: ${SLAB_SERIF}; color: #111; }
  /* One A5 sheet per page. A hair under the page height, because a sheet exactly as tall as its page can
     spill a sliver onto a blank page of its own. A label with few rows sits in the middle of its sheet, as
     the sample does, instead of leaving the whole lower half blank. */
  .sheet { width: ${SLAB.pageW}mm; height: ${SLAB.pageH - 0.5}mm; padding: ${SLAB.pad}mm; overflow: hidden;
           display: flex; flex-direction: column; justify-content: center;
           break-inside: avoid; page-break-after: always; }
  .sheet:last-child { page-break-after: auto; }
  table.lbl { width: ${SLAB.boxW}mm; table-layout: fixed; border-collapse: collapse; border: 0.6mm solid #111; }
  table.lbl td, table.lbl th { border: 0.35mm solid #111; padding: 0 1.5mm; text-align: center; vertical-align: middle;
           font-weight: 700; line-height: 1.05; white-space: nowrap; overflow: hidden; }
  tr.hd { height: ${SLAB.headRowH}mm; }
  tr.th { height: ${SLAB.theadH}mm; }
  tr.th th { background: #d0d0d0; }
  tr.row { height: ${rowH.toFixed(3)}mm; font-size: ${pt.toFixed(2)}pt; }
  tr.tot { height: ${SLAB.totalH}mm; font-size: ${pt.toFixed(2)}pt; }
  tr.tot td { background: #c0c0c0; }
  tr.tot td.tl { text-align: end; padding-inline-end: 4mm; }
  tr.ft { height: ${SLAB.footH}mm; }
  tr.ft td { position: relative; font-size: 12pt; }
  .web { color: #0563c1; text-decoration: underline; }
  .pg { position: absolute; inset-inline-end: 3mm; top: 50%; transform: translateY(-50%); font-size: 10pt; font-weight: 400; }
  .ltr { direction: ltr; unicode-bidi: embed; }
  td.idc { padding: 0; }
  .idw { display: flex; align-items: center; gap: 3mm; height: ${SLAB.headRowH * 2 - 1}mm; padding: 0 3mm; }
  .lg { flex: 0 0 ${SLAB_LOGO_MM}mm; text-align: center; }
  .lg img { display: block; margin: 0 auto; max-width: ${SLAB_LOGO_MM}mm; max-height: ${SLAB.headRowH * 2 - 5}mm; }
  .ad { flex: 1; min-width: 0; line-height: 1.25; white-space: normal; unicode-bidi: plaintext; }
  .ad p { margin: 0 0 1.5mm; white-space: pre-line; text-wrap: balance; }
  .ad p:last-child { margin-bottom: 0; }${fontFaceCss(langKey) ? `\n  ${fontFaceCss(langKey)}\n  body { font-family: ${fontStack(langKey, SLAB_SERIF)}; }` : ''}
</style>
</head>
<body>${slices.map((slice, i) => pageHtml(slice, i * layout.perPage, i + 1)).join('')}
</body>
</html>`;
}

// ── Short-pallet label (پالت کوتاه) — one wide strip, built from the sample
// "لیبل 120در60.pdf" ──────────────────────────────────────────────────────────
// Layout, left → right:  pallet number (outside the box) | logo | a table of
// Code · L · W · H · PCS · Pallet with "Made By LMC" under it | the quality
// letter, large. Code is the quarry-level product code (MA01) and quality is
// the grade letter (W) — both read off the stone code by the shared parser,
// the same one Inventory uses. Headers stay in English on purpose, as on the
// sample: it's the physical export label stuck on the pallet.
//
// A short pallet normally carries one size; items that share code + size are
// merged (their pieces summed), and if a pallet really does carry several
// sizes each gets its own row — the page grows to fit (see labelPageSize).
//
// The strip is drawn by ONE function (shortStrip) that two documents use: a page of its own for a single pallet
// (renderShortPalletLabelHtml) and an A4 sheet holding up to five of them (renderShortLabelSheetHtml).

const SHORT_ROW_MM = 12;   // every table row, header and "Made By" included

function shortLabelRows(pallet) {
  const merged = new Map();
  for (const it of pallet.items || []) {
    const parsed = parseStoneCode(it.code || '');
    const code = (parsed.productCode || pallet.productCode || it.code || '').toUpperCase();
    const key = [code, it.lengthCm, it.widthCm, it.thicknessCm].join('|');
    const row = merged.get(key) || {
      code, lengthCm: it.lengthCm, widthCm: it.widthCm, thicknessCm: it.thicknessCm, pcs: 0,
      grade: parsed.grade || '',
    };
    row.pcs += Number(it.pcs) || 0;
    merged.set(key, row);
  }
  const rows = [...merged.values()];
  if (!rows.length) {
    rows.push({ code: (pallet.productCode || '').toUpperCase(), lengthCm: null, widthCm: null, thicknessCm: null, pcs: null, grade: '' });
  }
  return rows;
}

// The strip's style. What depends on the pallet - the strip's own height, the logo's height, the quality letter's
// size - is set inline on its element by shortStrip(), so the same rules serve a page of one and a sheet of five.
const SHORT_STRIP_CSS = `
  * { box-sizing: border-box; }
  body { font-family: Cambria, Georgia, 'Times New Roman', serif; color: #111; }
  .strip { display: flex; align-items: center; gap: 3mm; padding: 4mm 4mm; }
  .num { font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-weight: 700; font-size: 15pt;
         min-width: 9mm; text-align: center; }
  table.lbl { border-collapse: collapse; width: 160mm; table-layout: fixed; }
  table.lbl td, table.lbl th { border: 0.35mm solid #111; text-align: center; vertical-align: middle;
         height: ${SHORT_ROW_MM}mm; padding: 0 1mm; overflow: hidden; }
  table.lbl th { font-weight: 700; font-size: 11pt; }
  table.lbl tr.val td { font-weight: 700; font-size: 16pt; }
  table.lbl tr.val td.code { font-size: 12.5pt; }
  td.logo { width: 29mm; padding: 1mm; }
  td.logo img { max-width: 100%; display: block; margin: 0 auto; }
  td.q { width: 28mm; font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-weight: 300; line-height: 1; }
  td.made { font-weight: 700; font-size: 14pt; }
`;

// One pallet's strip: its markup and its height in mm (rows x 12 mm for the header, the cuts and "Made By", + 8 mm).
function shortStrip(pallet, logo) {
  const rows = shortLabelRows(pallet);
  const grades = [...new Set(rows.map((r) => r.grade).filter(Boolean))];
  const quality = grades.join('/');
  const n = rows.length;
  // One grade letter is set big; a pallet mixing grades ("Q/W") has to shrink to
  // stay inside the 28 mm cell instead of being clipped at the label's edge.
  const qualityPt = Math.round(Math.min(48, 26 + n * 8) * (quality.length <= 1 ? 1 : Math.max(0.35, 2.2 / quality.length)));
  // Cells are a fixed 17 mm wide; a longer value (a 5-digit pallet code, a
  // 4-digit piece count) steps the font down instead of spilling over.
  const fit = (text, base = 16) => {
    const len = String(text).length;
    const pt = len <= 3 ? base : len === 4 ? Math.min(base, 14) : len === 5 ? Math.min(base, 12) : Math.min(base, 10);
    return `style="font-size:${pt}pt"`;
  };
  const cell = (v) => {
    if (v == null || v === '') return '<td></td>';
    const text = num(v);
    return `<td ${fit(text)}>${esc(text)}</td>`;
  };

  const valueRows = rows.map((r, i) => `
      <tr class="val">
        <td class="code" ${fit(r.code, 12.5)}>${esc(r.code)}</td>
        ${cell(r.lengthCm)}
        ${cell(r.widthCm)}
        ${cell(r.thicknessCm)}
        ${cell(r.pcs)}
        ${i === 0 ? `<td rowspan="${n}" ${fit(pallet.reference || '')}>${esc(pallet.reference || '')}</td>` : ''}
      </tr>`).join('');

  const heightMm = SHORT_ROW_MM * (n + 2) + 8;
  const html = `
  <div class="strip" style="height:${heightMm}mm">
    <div class="num">${esc(pallet.palletId)}</div>
    <table class="lbl">
      <tr>
        <td class="logo" rowspan="${n + 2}">${logo ? `<img src="${logo}" alt="LMC" style="max-height:${SHORT_ROW_MM * (n + 2) - 3}mm"/>` : ''}</td>
        <th>Code</th><th>L</th><th>W</th><th>H</th><th>PCS</th><th>Pallet</th>
        <td class="q" rowspan="${n + 2}" style="font-size:${qualityPt}pt">${esc(quality)}</td>
      </tr>
      ${valueRows}
      <tr><td class="made" colspan="6">Made By LMC</td></tr>
    </table>
  </div>`;
  return { html, heightMm };
}

function renderShortPalletLabelHtml(doc, pallet, branch, profile = {}) {
  const { html: strip } = shortStrip(pallet, logoFor(profile));
  const size = labelPageSize('short', pallet);
  return `<!doctype html>
<html dir="ltr" lang="en">
<head>
<meta charset="utf-8"/>
<meta name="color-scheme" content="only light"/>
<title>Short pallet ${esc(pallet.palletId)}</title>
<style>
  /* Same size labelPageSize('short', pallet) hands the server renderer. */
  @page { size: ${size.width} ${size.height}; margin: 0; }
  :root { color-scheme: only light; }
  /* The page is exactly rows x 12 mm + 8 mm tall, but the table's 0.35 mm
     collapsed borders make its content a hair taller — enough to spill a sliver
     onto a SECOND page (a blank label from the printer). Pin everything to the
     page height and clip: any overflow lands in the strip's own padding. */
  html, body { background: #ffffff; margin: 0; height: ${size.height}; overflow: hidden; }${SHORT_STRIP_CSS}
</style>
</head>
<body>${strip}
</body>
</html>`;
}

// ── Short-pallet labels on an A4 sheet ───────────────────────────────────────
// Up to five strips go on one sheet of A4, one under the other, each with a dashed cut line under it, so a whole
// shipment's labels come out of the printer together instead of one page at a time. A pallet with several sizes has a
// taller strip; when the next strip does not fit under the ones already on the sheet it starts a new sheet.
//
// "Back to back": with `duplex` every sheet is followed by an identical page, so a printer set to print on both sides
// puts the same labels on the front and the back of each strip. The strips are centred side to side, so the back
// page's strips sit exactly behind the front page's (a sheet turned over on its long edge keeps the top at the top).
const SHEET = { w: 210, h: 297, padX: 14, padY: 8 };
const SHORT_LABELS_PER_SHEET = 5;

function renderShortLabelSheetHtml(doc, pallets, branch, profile = {}, { duplex = true } = {}) {
  const logo = logoFor(profile);
  const strips = (pallets || []).slice(0, SHORT_LABELS_PER_SHEET).map((p) => shortStrip(p, logo));
  const usable = SHEET.h - 2 * SHEET.padY - 1;
  const sheets = [];
  let current = [], used = 0;
  for (const s of strips) {
    if (current.length && used + s.heightMm > usable) { sheets.push(current); current = []; used = 0; }
    current.push(s); used += s.heightMm;
  }
  if (current.length) sheets.push(current);

  const sheetHtml = (list, back) => `
  <section class="sheet${back ? ' back' : ''}">${list.map((s, i) => `
    <div class="cell${i < list.length - 1 ? ' cut' : ''}">${s.html}</div>`).join('')}
  </section>`;
  const pages = sheets.map((list) => (duplex ? sheetHtml(list, false) + sheetHtml(list, true) : sheetHtml(list, false))).join('');

  return `<!doctype html>
<html dir="ltr" lang="en">
<head>
<meta charset="utf-8"/>
<meta name="color-scheme" content="only light"/>
<title>Short pallet labels ${esc(doc && doc.docNumber)}</title>
<style>
  @page { size: ${SHEET.w}mm ${SHEET.h}mm; margin: 0; }
  :root { color-scheme: only light; }
  html, body { background: #ffffff; margin: 0; }${SHORT_STRIP_CSS}
  /* One A4 sheet per page. A hair under the page height: a sheet exactly as tall as its page can spill a sliver onto
     a blank page of its own. */
  .sheet { width: ${SHEET.w}mm; height: ${SHEET.h - 0.5}mm; padding: ${SHEET.padY}mm ${SHEET.padX}mm; overflow: hidden;
           break-after: page; page-break-after: always; }
  .sheet:last-child { break-after: auto; page-break-after: auto; }
  .cell { width: ${SHEET.w - 2 * SHEET.padX}mm; }
  .cell.cut { border-bottom: 0.3mm dashed #555; }
</style>
</head>
<body>${pages}
</body>
</html>`;
}

// PDF page size per label kind, so a label prints at its real size.
//   slab  — A5 portrait, 148 × 210 mm: the size of the label sample (it was 100 × 150 mm until 2026-10-20,
//           a size inferred rather than measured, which printed small and unclear)
//   short — a strip as wide as the sample (pallet number + 160 mm box) and as
//           tall as its rows
//   sheet — A4 portrait: up to five short strips on one page
function labelPageSize(kind, pallet) {
  if (kind === 'short') {
    const n = shortLabelRows(pallet).length;
    return { width: '182mm', height: `${SHORT_ROW_MM * (n + 2) + 8}mm` };
  }
  if (kind === 'sheet') return { width: `${SHEET.w}mm`, height: `${SHEET.h}mm` };
  return { width: `${SLAB.pageW}mm`, height: `${SLAB.pageH}mm` };
}

// ── template registries + dispatchers (Session 72 — same pattern as
// invoiceTemplate.js's renderInvoiceHtml: 'classic' is the only real template
// today, the selector/lookup is wired for a real second one later) ──────────

const PACKING_LIST_TEMPLATES = { classic: renderClassicPackingListHtml };
const LABEL_TEMPLATES = { classic: renderClassicPalletLabelHtml };

function renderPackingListHtml(doc, branch, profile, lang, templateVariant) {
  const render = PACKING_LIST_TEMPLATES[templateVariant] || PACKING_LIST_TEMPLATES.classic;
  return render(doc, branch, profile, lang);
}

// kind picks WHICH label (slab / short pallet); templateVariant picks the
// slab label's visual style per branch, exactly as before.
function renderPalletLabelHtml(doc, pallet, branch, profile, lang, templateVariant, kind = 'slab') {
  if (kind === 'short') return renderShortPalletLabelHtml(doc, pallet, branch, profile);
  const render = LABEL_TEMPLATES[templateVariant] || LABEL_TEMPLATES.classic;
  return render(doc, pallet, branch, profile, lang);
}

const LABEL_KINDS = ['slab', 'short'];

module.exports = { renderPackingListHtml, renderPalletLabelHtml, renderShortLabelSheetHtml, labelPageSize, LABEL_KINDS, SHORT_LABELS_PER_SHEET };
