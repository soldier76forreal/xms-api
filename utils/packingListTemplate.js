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

const baseStyles = `
  @page { margin: 10mm; }
  :root { color-scheme: only light; }
  html, body { background: #ffffff; }
  /* The browser prints these too, and its print dialog leaves "Background graphics" OFF by default - which
     would drop every fill (white header text on a blue band would vanish). Ask for the fills explicitly. */
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 11px; color: #111; }
  .ltr { direction: ltr; text-align: left; }
  .rtl { direction: rtl; text-align: right; }
  .ltr-inline { direction: ltr; unicode-bidi: embed; }
  .muted { color: #555; font-size: 10px; }
  .header { display: flex; justify-content: space-between; align-items: center; gap: 8px; border-bottom: 3px solid ${BRAND.blue}; padding-bottom: 6px; margin-bottom: 6px; }
  .logo { height: 26mm; width: auto; flex-shrink: 0; }
  .co-name { font-size: 13px; font-weight: 700; color: ${BRAND.blue}; }
  /* The packing list's own number - what the paper is referred to by - stands out from the date line. */
  .pl-no { font-size: 11px; color: #333; margin: 3px 0 1px; }
  .pl-no b { font-size: 17px; color: ${BRAND.blue}; letter-spacing: 0.3px; }
  .doc-title { text-align: center; flex: 1; }
  .title-main { font-size: 14px; font-weight: 700; color: ${BRAND.blueDark}; }
  .title-sub { font-size: 9px; color: #777; }
  table.meta { width: 100%; border-collapse: collapse; margin: 4px 0; }
  table.meta td { border: 1px solid ${BRAND.blueTint2}; padding: 4px 6px; background: ${BRAND.blueTint}; font-size: 10px; }
  table.lines { width: 100%; border-collapse: collapse; margin: 6px 0; }
  table.lines th { border: 1px solid ${BRAND.blue}; background: ${BRAND.blue}; color: #fff; padding: 4px 3px; font-size: 9.5px; }
  table.lines td { border: 1px solid ${BRAND.blueTint2}; padding: 3px 5px; text-align: center; font-size: 10px; }
  table.lines tr.grand td { font-weight: 700; background: ${BRAND.blueTint}; }
  /* Notes: the person's own words - kept whole on one page, line breaks kept, each line in its own direction. */
  table.notes { margin-top: 8px; break-inside: avoid; }
  table.notes td { padding: 6px 8px; }
  .note-text { margin-top: 3px; font-size: 11px; line-height: 1.5; white-space: pre-wrap; unicode-bidi: plaintext; text-align: start; }
`;

// ── Packing list — A4, consolidated multi-pallet document ──────────────────

function packingListMetaBlock(doc, L) {
  const d = doc.driverInfo || {}, v = doc.vehicleInfo || {}, c = doc.customsAgent || {};
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
  </table>`;
}

function packingListTable1(doc, L) {
  const rows = (doc.pallets || []).map((p, i) => {
    const pcs = (p.items || []).reduce((a, it) => a + (Number(it.pcs) || 0), 0);
    const sqm = (p.items || []).reduce((a, it) => a + (Number(it.sqm) || 0), 0);
    return `
    <tr>
      <td>${i + 1}</td>
      <td>${esc(p.palletId)}</td>
      <td>${esc(p.reference)}</td>
      <td>${esc(p.productCode)}</td>
      <td>${pcs || ''}</td>
      <td>${num(sqm)}</td>
      <td>${esc(p.processingType)}</td>
    </tr>`;
  }).join('');
  return `
  <table class="lines">
    <thead><tr>
      <th>${esc(L.col_no)}</th><th>${esc(L.palletId)}</th><th>${esc(L.reference)}</th>
      <th>${esc(L.col_code)}</th><th>${esc(L.pl_pcs)}</th><th>${esc(L.pl_sqm)}</th><th>${esc(L.processingType)}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr class="grand">
      <td colspan="4">${esc(L.total)}</td>
      <td>${doc.totals?.totalPcs != null ? esc(doc.totals.totalPcs) : ''}</td>
      <td>${doc.totals?.totalSqm != null ? num(doc.totals.totalSqm) : ''}</td>
      <td>${doc.totals?.totalPallets != null ? esc(doc.totals.totalPallets) : ''}</td>
    </tr></tfoot>
  </table>`;
}

function packingListTable2(doc, L) {
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
  return `
  <table class="lines">
    <thead><tr>
      <th>${esc(L.col_no)}</th><th>${esc(L.pl_pallet)}</th><th>${esc(L.col_code)}</th>
      <th>${esc(L.pl_length)}</th><th>${esc(L.pl_width)}</th><th>${esc(L.pl_thickness)}</th>
      <th>${esc(L.pl_pcs)}</th><th>${esc(L.pl_sqm)}</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr class="grand">
      <td colspan="6">${esc(L.total)}</td>
      <td>${doc.totals?.totalPcs != null ? esc(doc.totals.totalPcs) : ''}</td>
      <td>${doc.totals?.totalSqm != null ? num(doc.totals.totalSqm) : ''}</td>
    </tr></tfoot>
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
  <table class="meta" style="margin-top:10px;">
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

  return `<!doctype html>
<html dir="${L.dir}" lang="${langKey}">
<head>
<meta charset="utf-8"/>
<meta name="color-scheme" content="only light"/>
<title>${esc(L.plConsolidatedTitle)} ${esc(doc.docNumber)}</title>
<style>${baseStyles}
  /* The browser prints this document too (Save as PDF), not only the server —
     so it declares its own paper size. */
  @page { size: A4; margin: 10mm; }
  body { direction: ${L.dir}; }
  .page { width: 190mm; margin: 0 auto; padding: 4mm 0; }${documentFontCss(langKey)}
</style>
</head>
<body>
  <div class="page">
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
    </div>

    ${packingListMetaBlock(doc, L)}

    <table class="meta">
      <tr>
        <td>${esc(L.totalPallets)} <b>${doc.totals?.totalPallets ?? ''}</b></td>
        <td>${esc(L.totalArea)} <b>${doc.totals?.totalSqm != null ? num(doc.totals.totalSqm) : ''}</b></td>
        <td>${esc(L.totalItems)} <b>${doc.totals?.totalPcs ?? ''}</b></td>
      </tr>
    </table>

    ${packingListTable1(doc, L)}
    ${packingListTable2(doc, L)}${packingListNotes(doc, L)}
    ${packingListSignatures(doc, L)}
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

function renderShortPalletLabelHtml(doc, pallet, branch, profile = {}) {
  const logo = logoFor(profile);
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

  return `<!doctype html>
<html dir="ltr" lang="en">
<head>
<meta charset="utf-8"/>
<meta name="color-scheme" content="only light"/>
<title>Short pallet ${esc(pallet.palletId)}</title>
<style>
  /* Same size labelPageSize('short', pallet) hands the server renderer. */
  @page { size: ${labelPageSize('short', pallet).width} ${labelPageSize('short', pallet).height}; margin: 0; }
  :root { color-scheme: only light; }
  /* The page is exactly rows x 12 mm + 8 mm tall, but the table's 0.35 mm
     collapsed borders make its content a hair taller — enough to spill a sliver
     onto a SECOND page (a blank label from the printer). Pin everything to the
     page height and clip: any overflow lands in the strip's own padding. */
  html, body { background: #ffffff; margin: 0; height: ${labelPageSize('short', pallet).height}; overflow: hidden; }
  * { box-sizing: border-box; }
  body { font-family: Cambria, Georgia, 'Times New Roman', serif; color: #111; }
  .strip { display: flex; align-items: center; gap: 3mm; padding: 4mm 4mm; height: ${labelPageSize('short', pallet).height}; }
  .num { font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-weight: 700; font-size: 15pt;
         min-width: 9mm; text-align: center; }
  table.lbl { border-collapse: collapse; width: 160mm; table-layout: fixed; }
  table.lbl td, table.lbl th { border: 0.35mm solid #111; text-align: center; vertical-align: middle;
         height: ${SHORT_ROW_MM}mm; padding: 0 1mm; overflow: hidden; }
  table.lbl th { font-weight: 700; font-size: 11pt; }
  table.lbl tr.val td { font-weight: 700; font-size: 16pt; }
  table.lbl tr.val td.code { font-size: 12.5pt; }
  td.logo { width: 29mm; padding: 1mm; }
  td.logo img { max-width: 100%; max-height: ${SHORT_ROW_MM * (n + 2) - 3}mm; display: block; margin: 0 auto; }
  td.q { width: 28mm; font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-weight: 300;
         font-size: ${qualityPt}pt; line-height: 1; }
  td.made { font-weight: 700; font-size: 14pt; }
</style>
</head>
<body>
  <div class="strip">
    <div class="num">${esc(pallet.palletId)}</div>
    <table class="lbl">
      <tr>
        <td class="logo" rowspan="${n + 2}">${logo ? `<img src="${logo}" alt="LMC"/>` : ''}</td>
        <th>Code</th><th>L</th><th>W</th><th>H</th><th>PCS</th><th>Pallet</th>
        <td class="q" rowspan="${n + 2}">${esc(quality)}</td>
      </tr>
      ${valueRows}
      <tr><td class="made" colspan="6">Made By LMC</td></tr>
    </table>
  </div>
</body>
</html>`;
}

// PDF page size per label kind, so a label prints at its real size.
//   slab  — A5 portrait, 148 × 210 mm: the size of the label sample (it was 100 × 150 mm until 2026-10-20,
//           a size inferred rather than measured, which printed small and unclear)
//   short — a strip as wide as the sample (pallet number + 160 mm box) and as
//           tall as its rows
function labelPageSize(kind, pallet) {
  if (kind === 'short') {
    const n = shortLabelRows(pallet).length;
    return { width: '182mm', height: `${SHORT_ROW_MM * (n + 2) + 8}mm` };
  }
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

module.exports = { renderPackingListHtml, renderPalletLabelHtml, labelPageSize, LABEL_KINDS };
