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
const { formatMoney, normalizeCurrency } = require('./currencies');
const { formatDate, normalizeDateSystem, today } = require('./calendars');
const { documentFontCss } = require('./documentFonts');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Quantities, dimensions and areas: two decimals, whatever the currency.
const num = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Money: as many decimals as the document's currency has (a dirham two, a rial none).
const amt = (n, doc) => formatMoney(n, doc && doc.currency);

// A date as this document prints it — in its own calendar (Gregorian, Jalali or
// Hijri) with the calendar's mark after a non-Gregorian one. Gregorian stays
// "dd/mm/yyyy", exactly as every document was always printed.
const dateStr = (d, doc, lang) => (d ? formatDate(d, doc && doc.dateSystem, { lang }) : '');

// An absolute expiry (a website offer) in the clock of the branch that made it —
// "07 Oct 2026, 17:30 GMT+4" — never the server's. en-GB for every language so
// the digits and month names stay unambiguous on a printed page. In another
// calendar the day is written in that calendar and the time and zone follow it.
const zonedWhen = (d, tz, doc, lang) => {
  const zone = tz || 'Asia/Dubai';
  try {
    const system = normalizeDateSystem(doc && doc.dateSystem);
    if (system === 'gregorian') {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
      }).format(new Date(d));
    }
    const when = new Date(d);
    // The calendar day IN THE BRANCH'S ZONE, then written in the document's calendar.
    const day = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when));
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(when);
    return `${formatDate(day, system, { lang })}, ${clock}`;
  } catch (_) {
    return dateStr(d, doc, lang);
  }
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

// Print type. A document is read on PAPER - often a photocopy of the printout - so it is sized and inked for that:
// text is black (labels dark grey, never the #555-#777 greys of the screen layout), nothing is under 11 px, borders
// are a mid blue-grey that survives a photocopy, and a header cell is DARK text on a light fill: white-on-blue
// disappears when the print dialog leaves "Background graphics" off. (The fills are asked for explicitly as well.)
const INK = { border: '#8693b8', borderStrong: '#5c6b99', head: '#d9e0f2', headText: '#0b1f4d', zebra: '#f5f7fc', total: '#e3e9f7' };

// A page is a table whose THEAD is the page header: a browser prints a table's header again at the top of every page
// the table spills onto, so a long document keeps its logo and title (and, below, its column headings) on every sheet.
const frame = (head, body) => `
    <table class="frame">
      <thead><tr><td>${head}
      </td></tr></thead>
      <tbody><tr><td>${body}
      </td></tr></tbody>
    </table>`;

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

function metaBlock(doc, L, lang) {
  return `
  <table class="meta">
    <tr>
      <td>${esc(L.docNumber)} <b>${esc(doc.docNumber)}</b></td>
      <td>${esc(L.date)} <b class="ltr-inline">${dateStr(doc.issueDate, doc, lang)}</b>${doc.issueTime ? ' ' + esc(doc.issueTime) : ''}</td>
      <td>${esc(L.printDate)} <b class="ltr-inline">${dateStr(today(), doc, lang)}</b></td>
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

// Session 72 — used INSTEAD of customerBlock for an inter-branch document
// (tradeMode==='interBranch'): there's no CRM customer, just the requesting
// branch. "To" is already shown by headerBlock's seller identity (profile is
// resolved to the TARGET/fulfilling branch's own companyProfile), so this
// only needs to name the "From" side.
function interBranchPartiesBlock(doc, L) {
  const name = doc.requestingBranchSnapshot && doc.requestingBranchSnapshot.name;
  return `
  <table class="meta customer">
    <tr><td colspan="3">${esc(L.fromBranch)} <b>${esc(name || '—')}</b></td></tr>
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
      <td>${num(li.quantity)}</td>
      <td>${amt(li.unitPrice, doc)}</td>
      <td>${isPre && li.discountType === 'percent' ? num(li.discount) + '%' : amt(li.discountType === 'percent' ? 0 : li.discount, doc)}</td>
      <td>${amt(li.vatAmount, doc)}</td>
      <td>${amt(li.lineTotal, doc)}</td>
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
    <tr><td>${esc(L.subtotal)}</td><td class="num">${amt(doc.subtotal, doc)}</td></tr>
    ${doc.discountTotal ? `<tr><td>${esc(L.discount)}</td><td class="num">${amt(doc.discountTotal, doc)}</td></tr>` : ''}
    <tr><td>${esc(L.vat)}</td><td class="num">${amt(doc.vatTotal, doc)}</td></tr>
    ${isInvoice && doc.shipping ? `<tr><td>${esc(L.shipping)}</td><td class="num">${amt(doc.shipping, doc)}</td></tr>` : ''}
    <tr class="grand"><td>${esc(L.grandTotal)} (${esc(normalizeCurrency(doc.currency))})</td><td class="num">${amt(doc.grandTotal, doc)}</td></tr>
  </table>`;
}

function paymentBlock(doc, L) {
  const p = doc.payment || {};
  return `
  <table class="meta payment">
    <tr>
      <td>${esc(L.cash)} <b>${amt(p.cash, doc)}</b></td>
      <td>${esc(L.chequeBank)} <b>${amt(p.chequeBank, doc)}</b></td>
      <td>${esc(L.card)} <b>${amt(p.card, doc)}</b></td>
      <td>${esc(L.remaining)} <b>${amt(p.remaining, doc)}</b></td>
      <td>${esc(L.currentBalance)} <b>${amt(p.currentBalance, doc)} ${p.balanceSign === 'credit' ? esc(L.credit) : esc(L.debit)}</b></td>
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
      <td>${r.length != null ? num(r.length) : ''}</td>
      <td>${r.width != null ? num(r.width) : ''}</td>
      <td>${r.pcs != null ? esc(r.pcs) : ''}</td>
      <td>${r.thickness != null ? num(r.thickness) : ''}</td>
      <td>${r.sqm != null ? num(r.sqm) : ''}</td>
      <td class="right">${esc(r.notes)}</td>
    </tr>`).join('');
  return `
  <div class="page">${frame(headerBlock(profile, doc, L), `
    <div class="doc-title-inline">${esc(L.packingList)} <span class="en">${esc(L.packingListSub)}</span> — ${esc(L.forDoc)} ${esc(doc.docNumber)}</div>
    ${doc.tradeMode === 'interBranch' ? interBranchPartiesBlock(doc, L) : customerBlock(doc, L)}
    <table class="lines">
      <thead>
        <tr>
          <th>${esc(L.col_no)}</th><th>${esc(L.pl_pallet)}</th><th>${esc(L.pl_product)}</th>
          <th>${esc(L.pl_length)}</th><th>${esc(L.pl_width)}</th>
          <th>${esc(L.pl_pcs)}</th><th>${esc(L.pl_thickness)}</th>
          <th>${esc(L.pl_sqm)}</th><th>${esc(L.pl_notes)}</th>
        </tr>
      </thead>
      <tbody>${rows}
        <tr class="grand">
          <td colspan="5">${esc(L.total)}</td>
          <td>${pl.totalPcs != null ? esc(pl.totalPcs) : ''}</td>
          <td></td>
          <td>${pl.totalSqm != null ? num(pl.totalSqm) : ''}</td>
          <td></td>
        </tr>
      </tbody>
    </table>
    <table class="meta logistics">
      <tr>
        <td>${esc(L.truckNumber)} <b>${esc(pl.truckNumber)}</b></td>
        <td>${esc(L.driverName)} <b>${esc(pl.driverName)}</b></td>
        <td>${esc(L.driverMobile)} <b class="ltr-inline">${esc(pl.driverMobile)}</b></td>
      </tr>
    </table>`)}
  </div>`;
}

// ── main render ───────────────────────────────────────────────────────────────

// Session 72 — the ONLY template that exists today (a per-branch template
// SELECTOR is wired end-to-end — see routes/mis/invoices.js's
// resolveTemplateVariant() and branchModel.js's misTemplates — but nothing
// else has been designed yet, so every key falls back here). Renamed from
// renderInvoiceHtml so a real second template can be added later without
// touching this function's internals; the exported renderInvoiceHtml below is
// now a dispatcher, not this function directly.
function renderClassicInvoiceHtml(doc, profile = {}, lang) {
  const langKey = resolveLang(lang);
  const L = LANG[langKey];
  const isInvoice = doc.docType === 'invoice';
  const isInterBranch = doc.tradeMode === 'interBranch';
  // Amount-in-words stays Arabic regardless of template language — it's the
  // tax-invoice's legally-worded Arabic phrase, not a translatable UI label.
  const words = doc.amountInWords || amountToArabicWords(doc.grandTotal, { currency: doc.currency });

  const page1 = `
  <div class="page">${frame(headerBlock(profile, doc, L), `
    ${metaBlock(doc, L, langKey)}
    ${isInterBranch ? interBranchPartiesBlock(doc, L) : customerBlock(doc, L)}
    ${linesTable(doc, L)}
    <div class="bottom-row">
      <div class="bottom-left">
        ${isInvoice ? `<div class="words">${esc(L.amountInWords)}: <b>${esc(words)}</b></div>` : ''}
        ${isInvoice ? paymentBlock(doc, L) : ''}
        ${isInvoice && doc.salesRepName ? `<div class="muted">${esc(L.salesRep)}: <b>${esc(doc.salesRepName)}</b></div>` : ''}
        ${!isInvoice && doc.validUntil
          ? `<div class="validity">${esc(L.validUntil(zonedWhen(doc.validUntil, doc.validUntilTz, doc, langKey)))}</div>`
          : (!isInvoice && doc.validityDays ? `<div class="validity">${esc(L.validity(doc.validityDays))}</div>` : '')}
        ${doc.notes ? `<div class="muted notes">${esc(doc.notes)}</div>` : ''}
      </div>
      ${totalsBlock(doc, L)}
    </div>
    ${isInvoice ? bankBlock(profile, L) : ''}
    ${profile.thankYouNoteAr ? `<div class="thanks">${esc(profile.thankYouNoteAr)}</div>` : ''}`)}
  </div>`;

  // Session 72 (Phase 3) — packing lists are now their own standalone MIS
  // resource; new invoices never populate doc.packingList.rows again, so this
  // page naturally stops appearing for them. A PRE-Session-72 invoice that
  // still carries real rows keeps its page 2 with exactly the same CONTENT as
  // before: nothing is added, dropped or recomputed (tplRegress.cjs compares the
  // text of old and new output). Since 2026-10-21 it is set like page 1 - larger
  // type, and a long list continues on the next page under the repeated header.
  const page2 = (isInvoice && doc.packingList && doc.packingList.rows && doc.packingList.rows.length)
    ? packingListPage(doc, profile, L) : '';

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
  /* The print dialog leaves "Background graphics" OFF by default, which drops every fill: ask for them explicitly. */
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 12.5px; line-height: 1.35; color: #000; direction: ${L.dir}; }
  .page { width: 190mm; margin: 0 auto; page-break-after: always; padding: 4mm 0; }
  .page:last-child { page-break-after: auto; }
  .ltr { direction: ltr; text-align: left; }
  .rtl { direction: rtl; text-align: right; }
  .ltr-inline { direction: ltr; unicode-bidi: embed; }
  .muted { color: #222; font-size: 11.5px; }
  .right { text-align: right; }
  .en { font-size: 11px; color: #333; font-weight: 400; }

  /* The page header is the THEAD of this table, so it is printed again on every page a long document spills onto. */
  table.frame { width: 100%; border-collapse: collapse; }
  table.frame > thead > tr > td, table.frame > tbody > tr > td { padding: 0; border: 0; }

  .header { display: flex; justify-content: space-between; align-items: center; gap: 8px; border-bottom: 3px solid ${BRAND.blue}; padding-bottom: 6px; margin-bottom: 8px; }
  .logo { height: 26mm; width: auto; flex-shrink: 0; }
  .header-side { width: 30%; }
  .co-name-ar { font-size: 16px; font-weight: 700; color: ${BRAND.blue}; }
  .co-name-en { font-size: 14px; font-weight: 700; color: ${BRAND.blue}; }
  .doc-title { text-align: center; flex: 1; }
  .title-main { font-size: 17px; font-weight: 700; color: ${BRAND.blueDark}; }
  .title-sub { font-size: 11px; }
  .doc-title-inline { text-align: center; font-size: 15px; font-weight: 700; margin: 6px 0; color: ${BRAND.blueDark}; }

  table.meta { width: 100%; border-collapse: collapse; margin: 5px 0; break-inside: avoid; }
  table.meta td { border: 1px solid ${INK.border}; padding: 5px 7px; font-size: 12px; }
  table.customer td, table.payment td, table.logistics td { background: ${BRAND.blueTint}; }

  table.lines { width: 100%; border-collapse: collapse; margin: 8px 0; }
  table.lines th { border: 1px solid ${INK.borderStrong}; border-bottom: 2px solid ${BRAND.blue}; background: ${INK.head}; color: ${INK.headText}; padding: 5px 3px; font-size: 11.5px; font-weight: 800; }
  table.lines td { border: 1px solid ${INK.border}; padding: 5px 5px; text-align: center; font-size: 12px; }
  table.lines td.right { text-align: right; }
  /* A row is never cut across two pages: what does not fit moves to the next page whole. */
  table.lines tr { break-inside: avoid; }
  table.lines tbody tr:nth-child(even) td { background: ${INK.zebra}; }

  /* The blocks under the lines stay whole: they move to the next page together rather than being sliced. */
  .bottom-row { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; break-inside: avoid; }
  .bottom-left { flex: 1; }
  .words { margin: 4px 0; font-size: 12.5px; }
  .validity { margin: 6px 0; font-weight: 700; font-size: 12.5px; }
  .notes { margin-top: 4px; white-space: pre-wrap; }

  table.totals { width: 68mm; border-collapse: collapse; margin-right: auto; break-inside: avoid; }
  table.totals td { border: 1px solid ${INK.border}; padding: 5px 7px; font-size: 12.5px; }
  table.totals td.num { text-align: left; direction: ltr; width: 28mm; }
  table.totals tr.grand td, table.lines tbody tr.grand td { font-weight: 700; background: ${INK.total}; }
  table.totals tr.grand td { font-size: 13.5px; }
  table.lines tbody tr.grand td { color: #000; border-top: 2px solid ${BRAND.blue}; font-size: 12.5px; }

  .bank { margin-top: 8px; font-size: 11.5px; border-top: 1px solid ${INK.border}; padding-top: 5px; break-inside: avoid; }
  .thanks { margin-top: 6px; text-align: center; font-size: 12.5px; color: ${BRAND.blue}; break-inside: avoid; }${documentFontCss(langKey)}
</style>
</head>
<body>
${page1}
${page2}
</body>
</html>`;
}

// Session 72 — template registry + dispatcher. `templateVariant` comes from
// the doc's branch (branchModel.js's misTemplates, resolved server-side in
// routes/mis/invoices.js) — an unset/unrecognized value falls back to
// 'classic', so every pre-Session-72 call site (3 args, no templateVariant)
// keeps rendering byte-for-byte the same as before.
const TEMPLATES = { classic: renderClassicInvoiceHtml };

function renderInvoiceHtml(doc, profile, lang, templateVariant) {
  const render = TEMPLATES[templateVariant] || TEMPLATES.classic;
  return render(doc, profile, lang);
}

module.exports = { renderInvoiceHtml };
