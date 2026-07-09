// Phase 6 — MIS / Invoices. Shared A4 template — ONE render function, TWO
// consumers: the on-screen detail preview (GET /mis/invoices/:id/html) and the
// puppeteer PDF render (GET /mis/invoices/:id/pdf). Selectable template
// language (Arabic / English / Farsi — see invoiceLang.js) re-labels every
// static string; the underlying document VALUES never change with language.
// Invoice (فاتورة مبيعات ضريبية) = 2 pages: tax invoice + packing list.
// Pre-invoice (عرض سعر) = 1 page + validity note.
// Seller header / bank / thank-you values come from the companyProfile doc —
// NEVER hardcoded. Branding: LMC logo + brand blue (utils/branding.js).

const fs = require('fs');
const path = require('path');
const { amountToArabicWords } = require('./arabicWords');
const { LANG, resolveLang } = require('./invoiceLang');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dateStr = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};

// LMC brand logo, embedded as a base64 data URI (read once at module load —
// puppeteer renders from an in-memory HTML string with no server to fetch
// static assets from, so a data URI is the reliable path).
let LOGO_DATA_URI = '';
try {
  const logoPath = path.join(__dirname, '..', 'public', 'branding', 'lmc-logo.png');
  LOGO_DATA_URI = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
} catch (e) { /* logo optional — template still renders without it */ }

const BRAND = {
  blue:      '#1A3A78',
  blueDark:  '#102A6E',
  blueTint:  '#EEF1F8',
  blueTint2: '#E2E7F4',
};

// ── page fragments ────────────────────────────────────────────────────────────

function headerBlock(profile, doc, L) {
  const isInvoice = doc.docType === 'invoice';
  return `
  <div class="header">
    ${LOGO_DATA_URI ? `<img class="logo" src="${LOGO_DATA_URI}" alt="LMC"/>` : ''}
    <div class="header-side ltr">
      <div class="co-name-en">${esc(profile.nameEn)}</div>
      <div class="muted">${(profile.phones || []).map(esc).join(' · ')}</div>
      <div class="muted">${esc(profile.email)}${profile.website ? ' · ' + esc(profile.website) : ''}</div>
    </div>
    <div class="doc-title">
      <div class="title-main">${isInvoice ? esc(L.invoiceTitle) : esc(L.quoteTitle)}</div>
      <div class="title-sub muted">${isInvoice ? esc(L.invoiceTitleSub) : esc(L.quoteTitleSub)}</div>
    </div>
    <div class="header-side rtl">
      <div class="co-name-ar">${esc(profile.nameAr)}</div>
      <div class="muted">${esc(profile.branchAddressAr)}</div>
      <div class="muted">${esc(L.trn)}: ${esc(profile.trn)}</div>
    </div>
  </div>`;
}

function metaBlock(doc, L) {
  return `
  <table class="meta">
    <tr>
      <td>${esc(L.docNumber)} <b>${esc(doc.docNumber)}</b></td>
      <td>${esc(L.date)} <b>${dateStr(doc.issueDate)}</b>${doc.issueTime ? ' ' + esc(doc.issueTime) : ''}</td>
      <td>${esc(L.printDate)} <b>${dateStr(new Date())}</b></td>
    </tr>
  </table>`;
}

function customerBlock(doc, L) {
  const c = doc.customerSnapshot;
  if (!c || !c.name) return '';   // pre-invoices may have no customer at all
  return `
  <table class="meta customer">
    <tr>
      <td>${esc(L.billTo)} <b>${esc(c.name)}</b></td>
      ${c.trn ? `<td>${esc(L.trn)} <b>${esc(c.trn)}</b></td>` : '<td></td>'}
      ${c.country ? `<td>${esc(L.country)} <b>${esc(c.country)}</b></td>` : '<td></td>'}
    </tr>
    ${c.phone || c.address ? `<tr>
      ${c.phone ? `<td>${esc(L.phone)} <b class="ltr-inline">${esc(c.phone)}</b></td>` : '<td></td>'}
      ${c.address ? `<td colspan="2">${esc(L.address)} <b>${esc(c.address)}</b></td>` : '<td colspan="2"></td>'}
    </tr>` : ''}
  </table>`;
}

function linesTable(doc, L) {
  const isPre = doc.docType === 'pre_invoice';
  const rows = (doc.lineItems || []).map((li, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="ltr-inline">${esc(li.code)}</td>
      <td class="right">${esc(li.name)}</td>
      <td>${esc(li.unit)}</td>
      <td>${money(li.quantity)}</td>
      <td>${money(li.unitPrice)}</td>
      <td>${isPre && li.discountType === 'percent' ? money(li.discount) + '%' : money(li.discountType === 'percent' ? 0 : li.discount)}</td>
      <td>${money(li.vatAmount)}</td>
      <td>${money(li.lineTotal)}</td>
    </tr>`).join('');
  return `
  <table class="lines">
    <thead>
      <tr>
        <th>${esc(L.col_no)}</th>
        <th>${esc(L.col_code)}</th>
        <th>${esc(L.col_item)}</th>
        <th>${esc(L.col_unit)}</th>
        <th>${esc(L.col_qty)}</th>
        <th>${esc(L.col_price)}</th>
        <th>${isPre ? esc(L.col_discOffer) : esc(L.col_disc)}</th>
        <th>${esc(L.col_vat)}</th>
        <th>${esc(L.col_total)}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function totalsBlock(doc, L) {
  const isInvoice = doc.docType === 'invoice';
  return `
  <table class="totals">
    <tr><td>${esc(L.subtotal)}</td><td class="num">${money(doc.subtotal)}</td></tr>
    ${doc.discountTotal ? `<tr><td>${esc(L.discount)}</td><td class="num">${money(doc.discountTotal)}</td></tr>` : ''}
    <tr><td>${esc(L.vat)}</td><td class="num">${money(doc.vatTotal)}</td></tr>
    ${isInvoice && doc.shipping ? `<tr><td>${esc(L.shipping)}</td><td class="num">${money(doc.shipping)}</td></tr>` : ''}
    <tr class="grand"><td>${esc(L.grandTotal)} (${esc(doc.currency || 'AED')})</td><td class="num">${money(doc.grandTotal)}</td></tr>
  </table>`;
}

function paymentBlock(doc, L) {
  const p = doc.payment || {};
  return `
  <table class="meta payment">
    <tr>
      <td>${esc(L.cash)} <b>${money(p.cash)}</b></td>
      <td>${esc(L.chequeBank)} <b>${money(p.chequeBank)}</b></td>
      <td>${esc(L.card)} <b>${money(p.card)}</b></td>
      <td>${esc(L.remaining)} <b>${money(p.remaining)}</b></td>
      <td>${esc(L.currentBalance)} <b>${money(p.currentBalance)} ${p.balanceSign === 'credit' ? esc(L.credit) : esc(L.debit)}</b></td>
    </tr>
  </table>`;
}

function bankBlock(profile, L) {
  const b = profile.bank || {};
  if (!b.name && !b.iban) return '';
  return `
  <div class="bank ltr">
    <b>${esc(L.bankDetails)}:</b>
    ${esc(b.name)}${b.accountNumber ? ' · A/C ' + esc(b.accountNumber) : ''}${b.iban ? ' · IBAN ' + esc(b.iban) : ''}${b.branch ? ' · ' + esc(b.branch) : ''}${b.swift ? ' · SWIFT ' + esc(b.swift) : ''}
  </div>`;
}

function packingListPage(doc, profile, L) {
  const pl = doc.packingList || {};
  const rows = (pl.rows || []).map((r, i) => `
    <tr>
      <td>${r.no != null ? esc(r.no) : i + 1}</td>
      <td>${esc(r.pallet)}</td>
      <td class="right">${esc(r.productName)}</td>
      <td>${r.length != null ? money(r.length) : ''}</td>
      <td>${r.width != null ? money(r.width) : ''}</td>
      <td>${r.pcs != null ? esc(r.pcs) : ''}</td>
      <td>${r.thickness != null ? money(r.thickness) : ''}</td>
      <td>${r.sqm != null ? money(r.sqm) : ''}</td>
      <td class="right">${esc(r.notes)}</td>
    </tr>`).join('');
  return `
  <div class="page">
    ${headerBlock(profile, doc, L)}
    <div class="doc-title-inline">${esc(L.packingList)} <span class="en">${esc(L.packingListSub)}</span> — ${esc(L.forDoc)} ${esc(doc.docNumber)}</div>
    ${customerBlock(doc, L)}
    <table class="lines">
      <thead>
        <tr>
          <th>${esc(L.col_no)}</th><th>${esc(L.pl_pallet)}</th><th>${esc(L.pl_product)}</th>
          <th>${esc(L.pl_length)}</th><th>${esc(L.pl_width)}</th>
          <th>${esc(L.pl_pcs)}</th><th>${esc(L.pl_thickness)}</th>
          <th>${esc(L.pl_sqm)}</th><th>${esc(L.pl_notes)}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="grand">
          <td colspan="5">${esc(L.total)}</td>
          <td>${pl.totalPcs != null ? esc(pl.totalPcs) : ''}</td>
          <td></td>
          <td>${pl.totalSqm != null ? money(pl.totalSqm) : ''}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
    <table class="meta logistics">
      <tr>
        <td>${esc(L.truckNumber)} <b>${esc(pl.truckNumber)}</b></td>
        <td>${esc(L.driverName)} <b>${esc(pl.driverName)}</b></td>
        <td>${esc(L.driverMobile)} <b class="ltr-inline">${esc(pl.driverMobile)}</b></td>
      </tr>
    </table>
  </div>`;
}

// ── main render ───────────────────────────────────────────────────────────────

function renderInvoiceHtml(doc, profile = {}, lang) {
  const langKey = resolveLang(lang);
  const L = LANG[langKey];
  const isInvoice = doc.docType === 'invoice';
  // Amount-in-words stays Arabic regardless of template language — it's the
  // tax-invoice's legally-worded Arabic phrase, not a translatable UI label.
  const words = doc.amountInWords || amountToArabicWords(doc.grandTotal);

  const page1 = `
  <div class="page">
    ${headerBlock(profile, doc, L)}
    ${metaBlock(doc, L)}
    ${customerBlock(doc, L)}
    ${linesTable(doc, L)}
    <div class="bottom-row">
      <div class="bottom-left">
        ${isInvoice ? `<div class="words">${esc(L.amountInWords)}: <b>${esc(words)}</b></div>` : ''}
        ${isInvoice ? paymentBlock(doc, L) : ''}
        ${isInvoice && doc.salesRepName ? `<div class="muted">${esc(L.salesRep)}: <b>${esc(doc.salesRepName)}</b></div>` : ''}
        ${!isInvoice && doc.validityDays ? `<div class="validity">${esc(L.validity(doc.validityDays))}</div>` : ''}
        ${doc.notes ? `<div class="muted notes">${esc(doc.notes)}</div>` : ''}
      </div>
      ${totalsBlock(doc, L)}
    </div>
    ${isInvoice ? bankBlock(profile, L) : ''}
    ${profile.thankYouNoteAr ? `<div class="thanks">${esc(profile.thankYouNoteAr)}</div>` : ''}
  </div>`;

  const page2 = isInvoice ? packingListPage(doc, profile, L) : '';

  return `<!doctype html>
<html dir="${L.dir}" lang="${langKey}">
<head>
<meta charset="utf-8"/>
<meta name="color-scheme" content="only light"/>
<title>${isInvoice ? 'Invoice' : 'Quotation'} ${esc(doc.docNumber)}</title>
<style>
  @page { size: A4; margin: 10mm 10mm 12mm 10mm; }
  /* force light — blocks Chrome auto-dark from inverting the print colors */
  :root { color-scheme: only light; }
  html, body { background: #ffffff; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 11px; color: #111; direction: ${L.dir}; }
  .page { width: 190mm; margin: 0 auto; page-break-after: always; padding: 4mm 0; }
  .page:last-child { page-break-after: auto; }
  .ltr { direction: ltr; text-align: left; }
  .rtl { direction: rtl; text-align: right; }
  .ltr-inline { direction: ltr; unicode-bidi: embed; }
  .muted { color: #555; font-size: 10px; }
  .right { text-align: right; }
  .en { font-size: 8.5px; color: #777; font-weight: 400; }

  .header { display: flex; justify-content: space-between; align-items: center; gap: 8px; border-bottom: 3px solid ${BRAND.blue}; padding-bottom: 6px; margin-bottom: 6px; }
  .logo { height: 34mm; width: auto; flex-shrink: 0; }
  .header-side { width: 30%; }
  .co-name-ar { font-size: 15px; font-weight: 700; color: ${BRAND.blue}; }
  .co-name-en { font-size: 13px; font-weight: 700; color: ${BRAND.blue}; }
  .doc-title { text-align: center; flex: 1; }
  .title-main { font-size: 16px; font-weight: 700; color: ${BRAND.blueDark}; }
  .title-sub { font-size: 10px; }
  .doc-title-inline { text-align: center; font-size: 14px; font-weight: 700; margin: 6px 0; color: ${BRAND.blueDark}; }

  table.meta { width: 100%; border-collapse: collapse; margin: 4px 0; }
  table.meta td { border: 1px solid ${BRAND.blueTint2}; padding: 4px 6px; }
  table.customer td, table.payment td, table.logistics td { background: ${BRAND.blueTint}; }

  table.lines { width: 100%; border-collapse: collapse; margin: 6px 0; }
  table.lines th { border: 1px solid ${BRAND.blue}; background: ${BRAND.blue}; color: #fff; padding: 4px 3px; font-size: 10px; }
  table.lines td { border: 1px solid ${BRAND.blueTint2}; padding: 4px 5px; text-align: center; }
  table.lines td.right { text-align: right; }

  .bottom-row { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
  .bottom-left { flex: 1; }
  .words { margin: 4px 0; font-size: 11px; }
  .validity { margin: 6px 0; font-weight: 600; }
  .notes { margin-top: 4px; white-space: pre-wrap; }

  table.totals { width: 62mm; border-collapse: collapse; margin-right: auto; }
  table.totals td { border: 1px solid ${BRAND.blueTint2}; padding: 4px 6px; }
  table.totals td.num { text-align: left; direction: ltr; width: 26mm; }
  table.totals tr.grand td, table.lines tr.grand td { font-weight: 700; background: ${BRAND.blueTint}; }
  table.lines tr.grand td { color: #111; }

  .bank { margin-top: 8px; font-size: 10px; border-top: 1px solid ${BRAND.blueTint2}; padding-top: 4px; }
  .thanks { margin-top: 6px; text-align: center; font-size: 11px; color: ${BRAND.blue}; }
</style>
</head>
<body>
${page1}
${page2}
</body>
</html>`;
}

module.exports = { renderInvoiceHtml };
