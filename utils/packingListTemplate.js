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

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));

const dateStr = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};

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
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 11px; color: #111; }
  .ltr { direction: ltr; text-align: left; }
  .rtl { direction: rtl; text-align: right; }
  .ltr-inline { direction: ltr; unicode-bidi: embed; }
  .muted { color: #555; font-size: 10px; }
  .header { display: flex; justify-content: space-between; align-items: center; gap: 8px; border-bottom: 3px solid ${BRAND.blue}; padding-bottom: 6px; margin-bottom: 6px; }
  .logo { height: 26mm; width: auto; flex-shrink: 0; }
  .co-name { font-size: 13px; font-weight: 700; color: ${BRAND.blue}; }
  .doc-title { text-align: center; flex: 1; }
  .title-main { font-size: 14px; font-weight: 700; color: ${BRAND.blueDark}; }
  .title-sub { font-size: 9px; color: #777; }
  table.meta { width: 100%; border-collapse: collapse; margin: 4px 0; }
  table.meta td { border: 1px solid ${BRAND.blueTint2}; padding: 4px 6px; background: ${BRAND.blueTint}; font-size: 10px; }
  table.lines { width: 100%; border-collapse: collapse; margin: 6px 0; }
  table.lines th { border: 1px solid ${BRAND.blue}; background: ${BRAND.blue}; color: #fff; padding: 4px 3px; font-size: 9.5px; }
  table.lines td { border: 1px solid ${BRAND.blueTint2}; padding: 3px 5px; text-align: center; font-size: 10px; }
  table.lines tr.grand td { font-weight: 700; background: ${BRAND.blueTint}; }
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
  body { direction: ${L.dir}; }
  .page { width: 190mm; margin: 0 auto; padding: 4mm 0; }
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
        <div class="muted">${esc(L.docNumber)} <b>${esc(doc.docNumber)}</b> · ${esc(L.date)} <b>${dateStr(doc.insertDate)}</b></div>
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
    ${packingListTable2(doc, L)}
    ${packingListSignatures(doc, L)}
  </div>
</body>
</html>`;
}

// ── Pallet label — compact, single pallet, not A4 ───────────────────────────

function renderClassicPalletLabelHtml(doc, pallet, branch, profile = {}, lang) {
  const langKey = resolveLang(lang);
  const L = LANG[langKey];
  const logo = logoFor(profile);
  const rows = (pallet.items || []).map((it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="ltr-inline">${esc(it.code)}</td>
      <td>${it.lengthCm != null ? num(it.lengthCm) : ''}</td>
      <td>${it.widthCm != null ? num(it.widthCm) : ''}</td>
      <td>${it.thicknessCm != null ? num(it.thicknessCm) : ''}</td>
      <td>${it.pcs != null ? esc(it.pcs) : ''}</td>
      <td>${it.sqm != null ? num(it.sqm) : ''}</td>
    </tr>`).join('');
  const totalPcs = (pallet.items || []).reduce((a, it) => a + (Number(it.pcs) || 0), 0);
  const totalSqm = (pallet.items || []).reduce((a, it) => a + (Number(it.sqm) || 0), 0);
  const address = branch?.address || '';

  return `<!doctype html>
<html dir="${L.dir}" lang="${langKey}">
<head>
<meta charset="utf-8"/>
<meta name="color-scheme" content="only light"/>
<title>${esc(L.labelPalletId)} ${esc(pallet.palletId)}</title>
<style>${baseStyles}
  body { direction: ${L.dir}; }
  .page { width: 90mm; margin: 0 auto; padding: 4mm; }
  .pallet-head { display: flex; justify-content: space-between; align-items: baseline; margin: 6px 0; }
  .pallet-id { font-size: 20px; font-weight: 700; color: ${BRAND.blueDark}; }
  .pallet-ref { font-size: 12px; color: #555; }
  .footer { margin-top: 8px; text-align: center; font-size: 9px; color: #777; border-top: 1px solid ${BRAND.blueTint2}; padding-top: 4px; }
</style>
</head>
<body>
  <div class="page">
    <div class="header" style="border-bottom-width: 2px;">
      ${logo ? `<img class="logo" src="${logo}" style="height:16mm;" alt="LMC"/>` : ''}
    </div>
    <div class="pallet-head">
      <div><div class="muted">${esc(L.labelPalletId)}</div><div class="pallet-id">${esc(pallet.palletId)}</div></div>
      <div style="text-align:right;"><div class="muted">${esc(L.labelReference)}</div><div class="pallet-ref">${esc(pallet.reference)}</div></div>
    </div>
    <table class="lines">
      <thead><tr>
        <th>${esc(L.col_no)}</th><th>${esc(L.col_code)}</th>
        <th>${esc(L.pl_length)}</th><th>${esc(L.pl_width)}</th><th>${esc(L.pl_thickness)}</th>
        <th>${esc(L.pl_pcs)}</th><th>${esc(L.pl_sqm)}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr class="grand">
        <td colspan="5">${esc(L.total)}</td><td>${totalPcs || ''}</td><td>${num(totalSqm)}</td>
      </tr></tfoot>
    </table>
    <div class="footer">
      ${address ? esc(address) + ' · ' : ''}WWW.LAZULITEMARBLE.COM
    </div>
  </div>
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
  @page { margin: 0; }
  :root { color-scheme: only light; }
  html, body { background: #ffffff; margin: 0; }
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
  td.logo img { max-width: 100%; max-height: ${SHORT_ROW_MM * (n + 2) - 3}mm; display: block; margin: 0 auto; }
  td.q { width: 28mm; font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-weight: 300;
         font-size: ${Math.min(48, 26 + n * 8)}pt; line-height: 1; }
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
//   slab  — the original 100 × 150 mm portrait label
//   short — a strip as wide as the sample (pallet number + 160 mm box) and as
//           tall as its rows
function labelPageSize(kind, pallet) {
  if (kind === 'short') {
    const n = shortLabelRows(pallet).length;
    return { width: '182mm', height: `${SHORT_ROW_MM * (n + 2) + 8}mm` };
  }
  return { width: '100mm', height: '150mm' };
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
