// Supply deal letter, printed as the real stone sales contract
// (قرارداد فروش سنگ) supplied by Pouriya. Two A4 pages:
//   page 1 — parties block + stone order table + totals + payment
//   page 2 — the 14 numbered articles + the five signature boxes
//
// ONE render function, TWO consumers: the on-screen detail preview
// (GET /supply/deal-letters/:id/html) and the puppeteer PDF render
// (.../pdf) — same contract as invoiceTemplate.js / packingListTemplate.js.
//
// LANGUAGE: this document renders in Persian only, on purpose. The fourteen
// articles are binding legal text; re-expressing them in English or Arabic
// would mean inventing contract wording, which is exactly the kind of thing
// the invoice template already refuses to do for the Arabic amount-in-words.
// The template-variant registry below is kept so a genuinely different LAYOUT
// can be added later the same way the other templates do it.

const fs = require('fs');
const path = require('path');
const jalaliMoment = require('jalali-moment');
const { amountToPersianWords } = require('./persianWords');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Rial amounts are whole numbers; grouped with Latin digits, as on the sample.
const money = (n) => (Math.round(Number(n) || 0)).toLocaleString('en-US');
const num = (n, dp = 2) => {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });
};

// The printed date line is Jalali ("تاریخ ..../..../14").
const jalaliParts = (d) => {
  if (!d) return { y: '', m: '', day: '' };
  try {
    const m = jalaliMoment(new Date(d)).locale('fa');
    return { y: m.jYear(), m: String(m.jMonth() + 1).padStart(2, '0'), day: String(m.jDate()).padStart(2, '0') };
  } catch (e) {
    return { y: '', m: '', day: '' };
  }
};

let LOGO_DATA_URI = '';
try {
  const logoPath = path.join(__dirname, '..', 'public', 'branding', 'lmc-logo.png');
  LOGO_DATA_URI = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
} catch (e) { /* logo optional */ }

const BRAND = {
  blue:     '#1F3864',   // the header/section blue on the sample
  blueDark: '#17305A',
  rule:     '#C9CEDB',
  zebra:    '#F4F6FA',
  labelBg:  '#EFEFEF',
  red:      '#C00000',
};

// A dotted fill-in run, as printed on the blank form.
const dots = (n = 40) => '.'.repeat(n);

// A labelled value that falls back to the printed dotted blank when unset.
const val = (v, n = 40) => (v !== undefined && v !== null && String(v).trim() !== ''
  ? `<span class="v">${esc(v)}</span>`
  : `<span class="d">${dots(n)}</span>`);

// A number that falls back to a short dotted blank (used inside article text).
const inlineNum = (v) => (v === null || v === undefined || v === '' ? '<span class="d">..........</span>'
  : `<span class="v">${esc(v)}</span>`);

// ── the fourteen articles ────────────────────────────────────────────────────
// Verbatim from the supplied contract. The four blanks that the form fills are
// interpolated; everything else is fixed wording and must not be edited here.
function articles(c) {
  return [
    'قابل ذکر است به دلیل خواص طبیعی سنگ ۱۰ درصد تلورانس رنگ و ۱۵ درصد تلورانس نقوش سنگ غیر قابل تضمین است و کارخانه در قبال آن پاسخگو نمی‌باشد.',
    'حضور نماینده خریدار در حین بارگیری الزامی است و در صورت عدم حضور ایشان هیچ گونه مسئولیتی متوجه کارخانه نبوده و خریدار حق هرگونه اعتراضی را از خود سلب می‌نماید.',
    `این قرارداد از تاریخ صدور به مدت ${inlineNum(c.validityDays)} روز اعتبار دارد. در صورت کنسل شدن سفارش سنگ حکمی کلیه خسارت‌های وارده به عهده خریدار می‌باشد.`,
    'پس از خروج سنگ از کارخانه تحت هیچ عنوان عودت سنگ امکان‌پذیر نیست.',
    `خریدار متعهد می‌شود تمامی اقساط را در زمان مقرر پرداخت نماید و در غیر این صورت ضمانت خریدار که شامل ${val(c.guarantee, 30)} می‌باشد به اجرا گذاشته می‌شود.`,
    'معرف خریدار به عنوان ضامن بی‌قید و شرط در خصوص پرداخت بدهی تلقی می‌شود.',
    'قیمت‌ها مورد توافق طرفین می‌باشد و تخفیف در قیمت‌ها لحاظ شده است و هیچ گونه تخفیف اضافه‌ای داده نخواهد شد.',
    'چنانچه خریدار چک مشتری یا اشخاص ثالث را به فروشنده خرج نمود به عنوان ضامن، چک مسئولیت تضامنی دارد و هر گونه ادعای احتمالی نسبت به چک مشتری، مسئولیت متوجه خریدار می‌باشد و باید ظرف ۵ روز وجه چک را کارسازی نماید در غیر اینصورت خسارت احتمالی و دیرکرد بعهده خریدار خواهد بود.',
    'این قرارداد در محل اقامت فروشنده منعقد گردید و چنانچه اختلافی مابین طرفین حادث شود، دادگاه محل اقامت فروشنده صالح به حل اختلاف و رسیدگی قضایی است. ضمناً داوری که فروشنده در دادگاه معرفی می‌نماید قطعی و باید همانند احکام قضایی اجرایی شود.',
    'خریدار از کلیه خیارات قانونی حتی خیار غبن ولو به درجه فاحش را از خود ساقط نمود و با علم و آگاهی از کمیت و کیفیت مورد معامله، این قرارداد را منعقد کرده است و حق هر گونه اعتراض را از خود ساقط نموده معامله قطعی است. این قرارداد تابع قوانین بیع می‌باشد.',
    'فروشنده کلیه عیوب و ایرادات مورد معامله را از خود مبری و هیچ‌گونه مسئولیتی متوجه وی نمی‌باشد.',
    `خریدار موظف می‌باشد طی مدت ${inlineNum(c.settlementDays)} روز نسبت به تسویه مبلغ کل سنگ خریداری شده (چک / نقد) اقدام و پرداخت نماید در غیر اینصورت قرارداد کنسل می‌شود.`,
    `خریدار باید بعد از تسویه حساب کامل طی مدت ${inlineNum(c.loadingDays)} روز سنگ خود را بارگیری کند.`,
    'خریدار باید چک‌های صیادی جدید را قبل از بارگیری به فروشنده ثبت یا انتقال دهد در غیر اینصورت مبلغ کل حساب را بدهکار می‌باشد و مطابق ماده‌های قبل باید انجام دهد.',
  ];
}

const SIGNATURE_COLS = [
  'امضاء و مهر فروشنده',
  'امضاء و مهر خریدار',
  'امضاء شاهد ۱',
  'امضاء شاهد ۲',
  'امضاء معرف',
];

// Per-line figures. متر مربع comes from the quantity already tracked on the
// deal letter (final quantity once known, otherwise the forecast), so the
// contract and the supply pipeline never disagree about volume.
function lineFigures(line) {
  const sqm = (line.finalQty !== null && line.finalQty !== undefined)
    ? Number(line.finalQty)
    : Number(line.forecastQty) || 0;
  const unitPrice = Number(line.price) || 0;
  return { sqm, unitPrice, total: sqm * unitPrice };
}

function computeTotals(varietyLines) {
  let sqm = 0, amount = 0, count = 0;
  for (const l of (varietyLines || [])) {
    const f = lineFigures(l);
    sqm += f.sqm;
    amount += f.total;
    count += Number(l.count) || 0;
  }
  return { sqm: Math.round(sqm * 100) / 100, amount: Math.round(amount), count };
}

// ── the classic layout ───────────────────────────────────────────────────────
function renderClassicDealLetterHtml(dealLetter, record, branch, profile) {
  const c = (dealLetter && dealLetter.contract) || {};
  const lines = dealLetter.varietyLines || [];
  const totals = computeTotals(lines);
  const jd = jalaliParts(c.date || dealLetter.insertDate);

  const inWords = (c.totalInWords && c.totalInWords.trim())
    ? c.totalInWords
    : amountToPersianWords(totals.amount);

  // The branch's own uploaded mark when it has one (resolved by the route),
  // the static LMC logo otherwise.
  const logo = (profile && profile.logoDataUri) || LOGO_DATA_URI;
  const brandName = (profile && profile.nameEn) || 'Lazulite Marble Company';

  // The blank form prints five order rows; keep that shape so a short contract
  // still looks like the document people are used to signing.
  const MIN_ROWS = 5;
  const rowCount = Math.max(lines.length, MIN_ROWS);
  const orderRows = [];
  for (let i = 0; i < rowCount; i++) {
    const l = lines[i];
    if (!l) {
      orderRows.push(`<tr>
        <td class="c">${i + 1}</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>
      </tr>`);
      continue;
    }
    const f = lineFigures(l);
    orderRows.push(`<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(l.stoneTypeLabel || l.variantCode || '')}</td>
      <td class="c">${l.count != null ? esc(num(l.count, 0)) : ''}</td>
      <td class="c">${l.widthCm != null ? esc(num(l.widthCm, 0)) : ''}</td>
      <td class="c">${l.lengthCm != null ? esc(num(l.lengthCm, 0)) : ''}</td>
      <td class="c">${esc(num(f.sqm))}</td>
      <td class="c">${f.unitPrice ? esc(money(f.unitPrice)) : ''}</td>
      <td class="c">${f.total ? esc(money(f.total)) : ''}</td>
    </tr>`);
  }

  const sellerParty = c.seller?.party
    || (dealLetter.coupeSeller && dealLetter.coupeSeller.name)
    || '';
  const sellerAddr = c.seller?.addressPhone
    || (dealLetter.coupeSeller && dealLetter.coupeSeller.phone)
    || '';
  const buyerName = c.buyer?.name || (branch && branch.name) || '';
  const buyerAddr = c.buyer?.addressPhone
    || [branch && branch.address, branch && branch.phone].filter(Boolean).join(' — ');

  const articleItems = articles(c).map((text, i) => `
    <div class="art"><span class="artno">ماده ${i + 1}:</span> ${text}</div>`).join('');

  const signatureCells = SIGNATURE_COLS.map((s) => `<th>${esc(s)}</th>`).join('');

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<title>قرارداد فروش سنگ</title>
<style>
  @page { size: A4; margin: 12mm 12mm 12mm 12mm; }
  * { box-sizing: border-box; }
  /* Explicit white: this markup is also injected into an iframe inside the
     app, where the dark theme would otherwise show through a transparent
     background and make the contract unreadable. */
  html, body { background: #ffffff; }
  body {
    margin: 0; direction: rtl;
    font-family: Tahoma, 'Segoe UI', 'Iranian Sans', Arial, sans-serif;
    font-size: 10.5px; color: #111; line-height: 1.9;
  }
  .page { background: #ffffff; page-break-after: always; }
  .page:last-child { page-break-after: auto; }

  /* letterhead — title block on the start (right, RTL) side, the company mark
     on the end side at a size that actually reads on paper, a blue rule under
     both. The mark was previously 34px tall tucked under the title, which on a
     printed A4 page was barely visible. */
  .head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding-bottom: 10px; margin-bottom: 12px;
    border-bottom: 2px solid ${BRAND.blue};
  }
  .head-title { display: flex; flex-direction: column; gap: 4px; }
  .title { font-size: 22px; font-weight: 700; color: ${BRAND.blue}; line-height: 1.3; }
  .head-meta { font-size: 10.5px; line-height: 1.9; color: #333; }
  .head-meta b { color: #111; }
  .brand { display: flex; flex-direction: column; align-items: center; gap: 3px; flex-shrink: 0; }
  .logo { height: 22mm; width: auto; display: block; }
  .brand-name { font-size: 9.5px; font-weight: 700; color: ${BRAND.blue};
    letter-spacing: 0.4px; text-align: center; white-space: nowrap; }

  h2.sec {
    font-size: 12px; font-weight: 700; color: ${BRAND.blue};
    margin: 16px 0 7px;
  }

  /* parties */
  table.parties { width: 100%; border-collapse: collapse; }
  table.parties td { border: 1px solid ${BRAND.rule}; padding: 7px 9px; vertical-align: top; background: #fff; }
  table.parties td.lbl {
    width: 105px; background: ${BRAND.labelBg}; font-weight: 700;
    color: #222; white-space: nowrap;
  }
  .prow { display: block; }
  .prow + .prow { margin-top: 4px; }
  .cols { display: flex; gap: 18px; flex-wrap: wrap; }

  /* order table */
  table.order { width: 100%; border-collapse: collapse; margin-top: 4px; }
  table.order th {
    background: ${BRAND.blue}; color: #fff; font-weight: 700;
    border: 1px solid ${BRAND.blueDark}; padding: 7px 4px; font-size: 10.5px;
  }
  table.order td { border: 1px solid ${BRAND.rule}; padding: 7px 4px; height: 26px; background: #fff; }
  table.order tbody tr:nth-child(even) td { background: ${BRAND.zebra}; }
  table.order tr.sum td { background: #E8E8E8; font-weight: 700; height: 24px; }
  td.c, th.c { text-align: center; }

  .totline { margin-top: 8px; display: flex; gap: 26px; flex-wrap: wrap; }
  ul.notes { margin: 10px 0 0; padding-inline-start: 16px; }
  ul.notes li { margin-bottom: 5px; }
  li.red { color: ${BRAND.red}; }
  .payline { margin-top: 3px; }

  /* articles */
  .art { margin-bottom: 8px; text-align: justify; }
  .artno { font-weight: 700; color: #111; }

  /* signatures */
  table.sign { width: 100%; border-collapse: collapse; margin-top: 26px; }
  table.sign th {
    border: 1px solid ${BRAND.rule}; background: ${BRAND.zebra};
    color: ${BRAND.blue}; font-weight: 700; padding: 8px 4px; font-size: 10.5px;
  }
  table.sign td { border: 1px solid ${BRAND.rule}; height: 92px; }

  .d { color: #9AA0AC; letter-spacing: 0.5px; }
  .v { font-weight: 600; }
</style>
</head>
<body>

<!-- ── page 1 ── -->
<div class="page">
  <div class="head">
    <div class="head-title">
      <div class="title">قرارداد فروش سنگ</div>
      <div class="head-meta">
        <div><b>تاریخ:</b> ${jd.day ? `${esc(jd.day)} / ${esc(jd.m)} / ${esc(jd.y)}` : '..... / ..... / 14'}</div>
        <div><b>شماره:</b> ${c.number ? esc(c.number) : dots(12)}</div>
      </div>
    </div>
    ${logo ? `
    <div class="brand">
      <img class="logo" src="${logo}" alt="" />
      ${brandName ? `<div class="brand-name">${esc(brandName)}</div>` : ''}
    </div>` : ''}
  </div>

  <h2 class="sec">مشخصات طرفین قرارداد</h2>
  <table class="parties">
    <tr>
      <td class="lbl">فروشنده:</td>
      <td>
        <span class="prow">این قرارداد از طرف: ${val(sellerParty, 46)}</span>
        <span class="prow">نشانی و تلفن فروشنده: ${val(sellerAddr, 46)}</span>
      </td>
    </tr>
    <tr>
      <td class="lbl">خریدار / شرکت:</td>
      <td><span class="prow">جهت فروش سنگ به آقای / خانم / شرکت: ${val(buyerName, 40)}</span></td>
    </tr>
    <tr>
      <td class="lbl">نمایندگی و شناسه:</td>
      <td>
        <span class="prow cols">
          <span>به سمت: ${val(c.buyer?.position, 16)}</span>
          <span>به نمایندگی: ${val(c.buyer?.representedBy, 16)}</span>
          <span>به نمایندگی از: ${val(c.buyer?.onBehalfOf, 16)}</span>
        </span>
        <span class="prow">دارای کد ملی / اقتصادی: ${val(c.buyer?.nationalId, 40)}</span>
      </td>
    </tr>
    <tr>
      <td class="lbl">نشانی خریدار:</td>
      <td><span class="prow">نشانی و تلفن خریدار: ${val(buyerAddr, 46)}</span></td>
    </tr>
  </table>

  <h2 class="sec">مشخصات سفارش سنگ</h2>
  <table class="order">
    <thead>
      <tr>
        <th style="width:34px">ردیف</th>
        <th>نوع سنگ</th>
        <th style="width:56px">تعداد</th>
        <th style="width:56px">عرض</th>
        <th style="width:56px">طول</th>
        <th style="width:68px">متر مربع</th>
        <th style="width:86px">فی (ریال)</th>
        <th style="width:104px">مبلغ کل (ریال)</th>
      </tr>
    </thead>
    <tbody>
      ${orderRows.join('')}
      <tr class="sum">
        <td class="c">جمع</td>
        <td></td>
        <td class="c">${totals.count ? esc(num(totals.count, 0)) : ''}</td>
        <td></td>
        <td></td>
        <td class="c">${totals.sqm ? esc(num(totals.sqm)) : ''}</td>
        <td></td>
        <td class="c">${totals.amount ? esc(money(totals.amount)) : ''}</td>
      </tr>
    </tbody>
  </table>

  <div class="totline">
    <span>جمع به عدد: ${totals.amount ? `<span class="v">${esc(money(totals.amount))}</span>` : `<span class="d">${dots(22)}</span>`}</span>
    <span>جمع به حروف: ${totals.amount ? `<span class="v">${esc(inWords)}</span>` : `<span class="d">${dots(26)}</span>`}</span>
  </div>

  <ul class="notes">
    <li class="red">هزینه‌های جانبی مانند بسته‌بندی، ابزار و کرایه حمل شامل قیمت‌های مذکور نمی‌باشد و به عهده خریدار است.</li>
    <li><b>جمع مبلغ کل:</b> ${totals.amount ? `<span class="v">${esc(money(totals.amount))}</span>` : `<span class="d">${dots(22)}</span>`} ریال</li>
    <li>
      <b>نحوه پرداخت:</b> مبلغ فوق به شرح زیر پرداخت خواهد شد:
      <div class="payline">${c.paymentTerms ? esc(c.paymentTerms) : `<span class="d">${dots(96)}</span>`}</div>
    </li>
  </ul>

  <h2 class="sec">شروط و مواد قرارداد</h2>
</div>

<!-- ── page 2 ── -->
<div class="page">
  ${articleItems}

  <table class="sign">
    <thead><tr>${signatureCells}</tr></thead>
    <tbody><tr>${SIGNATURE_COLS.map(() => '<td></td>').join('')}</tr></tbody>
  </table>
</div>

</body>
</html>`;
}

// Registry + dispatcher, same shape as invoiceTemplate.js — an unknown variant
// falls back to 'classic' rather than throwing.
const TEMPLATES = { classic: renderClassicDealLetterHtml };

function renderDealLetterHtml(dealLetter, record, branch, profile, templateVariant) {
  const render = TEMPLATES[templateVariant] || TEMPLATES.classic;
  return render(dealLetter, record, branch, profile);
}

module.exports = { renderDealLetterHtml, computeTotals, TEMPLATES };
