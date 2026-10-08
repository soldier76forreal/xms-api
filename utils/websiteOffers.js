// Website price-request offers.
//
// A customer asks for prices on the public website (models/priceRequestModel.js).
// The branch's associate answers in MIS by pricing the items; that answer is an
// ordinary QUOTATION (the same misInvoice collection as every other quotation)
// that carries `priceRequestId` and an absolute expiry, `validUntil`:
//
//   associate prices the request ──► quotation, status 'sent', valid for N hours
//        │                              (default 2h, the associate can change it)
//        ├─ the customer is e-mailed the quantities and prices — NOT the document —
//        │  with a button to the website dashboard
//        ├─ on the dashboard the customer sees the document and a countdown
//        ├─ accepts in time  ──► stock is reserved (like any accepted quotation)
//        │                       and the quotation becomes an invoice
//        └─ lets it lapse    ──► 'expired' (a sweep flips the status; the accept
//                                route also refuses an out-of-time offer itself)
//
// Everything money- or stock-related goes through the functions MIS already uses
// (routes/mis/invoices.js exports them) so an offer can never be priced, reserved
// or converted by different rules than a quotation made by hand.

const mongoose = require('mongoose');

const dbConnection = require('../connections/xmsPr');
const misInvoiceSchema = require('../models/misInvoiceModel');
const priceRequestSchema = require('../models/priceRequestModel');
const customerActivitySchema = require('../models/customerActivityModel');
const userSchema = require('../models/userModel');
const { Branch, assertBranchAccess } = require('./rbac');
const { amountToArabicWords } = require('./arabicWords');
const { renderInvoiceHtml } = require('./invoiceTemplate');
const { sendMail } = require('./mailer');
const { websiteBranchSlug } = require('./websiteBranchSlug');
const { sendNotificationToUser } = require('../routes/socket/xmsNotifications');

const MisInvoice = dbConnection.models.misInvoice || dbConnection.model('misInvoice', misInvoiceSchema);
const PriceRequest = dbConnection.models.priceRequest || dbConnection.model('priceRequest', priceRequestSchema);
const CustomerActivity = dbConnection.models.customerActivity || dbConnection.model('customerActivity', customerActivitySchema);
const User = dbConnection.models.user || dbConnection.model('user', userSchema);

// Resolved lazily: routes/mis/invoices.js is a route module, and this file must
// stay loadable on its own (a script, a test) without dragging the router in
// until an offer is actually built.
const mis = () => require('../routes/mis/invoices');

const DEFAULT_VALID_HOURS = 2;
const MAX_VALID_HOURS = 24 * 60;      // 60 days
const MIN_VALID_MINUTES = 5;

class OfferError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ── small helpers ─────────────────────────────────────────────────────────────

const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const money = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pickLang = (lang) => (['en', 'ar', 'fa'].includes(lang) ? lang : 'en');

// The company sells from the Gulf: time-limited offers must read in the branch's
// own clock, never the server's. Falls back to the UAE (head office).
const TZ_BY_COUNTRY = {
  AE: 'Asia/Dubai', SA: 'Asia/Riyadh', IR: 'Asia/Tehran', OM: 'Asia/Muscat', QA: 'Asia/Qatar',
  KW: 'Asia/Kuwait', BH: 'Asia/Bahrain', IQ: 'Asia/Baghdad', JO: 'Asia/Amman', EG: 'Africa/Cairo',
  TR: 'Europe/Istanbul',
};
const zoneFor = (branch) => TZ_BY_COUNTRY[String((branch && branch.country) || '').toUpperCase()] || 'Asia/Dubai';

function formatWhen(date, branch) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zoneFor(branch), day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    }).format(new Date(date));
  } catch (_) {
    return new Date(date).toISOString();
  }
}

function formatAddress(pr) {
  const a = pr.receivingAddress || {};
  return [a.address, a.city || pr.city, a.country || pr.country, a.postalCode].filter(Boolean).join(', ');
}

// "2 hours", "1 day 12 hours", "30 minutes" — in the customer's language.
const UNIT_TEXT = {
  en: {
    d: (n) => `${n} ${n === 1 ? 'day' : 'days'}`,
    h: (n) => `${n} ${n === 1 ? 'hour' : 'hours'}`,
    m: (n) => `${n} ${n === 1 ? 'minute' : 'minutes'}`,
    join: ' ',
  },
  ar: {
    d: (n) => (n === 1 ? 'يوم واحد' : n === 2 ? 'يومان' : n <= 10 ? `${n} أيام` : `${n} يومًا`),
    h: (n) => (n === 1 ? 'ساعة واحدة' : n === 2 ? 'ساعتان' : n <= 10 ? `${n} ساعات` : `${n} ساعة`),
    m: (n) => (n === 1 ? 'دقيقة واحدة' : n === 2 ? 'دقيقتان' : n <= 10 ? `${n} دقائق` : `${n} دقيقة`),
    join: ' و',
  },
  fa: {
    d: (n) => `${n} روز`,
    h: (n) => `${n} ساعت`,
    m: (n) => `${n} دقیقه`,
    join: ' و ',
  },
};

function durationText(lang, hours) {
  const U = UNIT_TEXT[pickLang(lang)];
  const totalMin = Math.max(1, Math.round(hours * 60));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = [];
  if (d) parts.push(U.d(d));
  if (h) parts.push(U.h(h));
  if (m && !d) parts.push(U.m(m));      // minutes only matter on short offers
  return parts.join(U.join);
}

function dashboardLink(branch, lang, priceRequestId) {
  const base = String(process.env.WEBSITE_BASE_URL || 'https://www.lazulitemarble.com').replace(/\/+$/, '');
  const slug = branch ? websiteBranchSlug(branch) : '';
  return `${base}/${slug ? slug + '/' : ''}${lang === 'en' ? '' : lang + '/'}my-account/?offer=${priceRequestId}`;
}

async function nameOf(userId) {
  if (!userId) return '';
  const u = await User.findById(userId).select('firstName lastName').lean();
  return u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '';
}

// Who hears about what happened to an offer: the branch's website associates
// plus whoever sent the offer.
async function offerRecipients(branchId, creatorId) {
  const branch = await Branch.findById(branchId).select('associates priceRequestNotifyUsers').lean();
  const ids = [...(branch?.associates || []), ...(branch?.priceRequestNotifyUsers || []), creatorId]
    .filter(Boolean).map(String).filter((id) => mongoose.isValidObjectId(id));
  return [...new Set(ids)];
}

async function notifyAll(userIds, payload) {
  await Promise.all(userIds.map((uid) => sendNotificationToUser(uid, payload).catch(() => {})));
}

// ── the e-mail ────────────────────────────────────────────────────────────────
// Carries the data (items, quantities, prices, totals, expiry) and a button — the
// document itself lives only on the website dashboard.

const MAIL = {
  en: {
    dir: 'ltr', align: 'left',
    subject: (n) => `Your price offer #${n} from Lazulite Marble`,
    hello: (name) => `Dear ${name || 'customer'},`,
    intro: (branch) => `Thank you for your request. ${branch ? `Our ${branch} branch has` : 'We have'} prepared this offer for you:`,
    code: 'Code', item: 'Item', qty: 'Quantity', price: 'Unit price', total: 'Total incl. VAT',
    subtotal: 'Subtotal', discount: 'Discount', vat: 'VAT', grand: 'Amount due',
    note: 'Note from the branch',
    valid: (duration, when) => `This offer is valid for ${duration} — until ${when}.`,
    after: 'After that the prices are no longer guaranteed.',
    button: 'View my invoice',
    hint: 'Sign in to your dashboard with this email address to see the invoice and accept the offer. The invoice is only available there.',
    delivery: 'Delivery to',
    bye: 'Lazulite Marble',
  },
  ar: {
    dir: 'rtl', align: 'right',
    subject: (n) => `عرض السعر رقم ${n} من لازولايت ماربل`,
    hello: (name) => `عزيزي ${name || 'العميل'}،`,
    intro: (branch) => `شكرًا لطلبك. ${branch ? `أعدّ فرع ${branch}` : 'أعددنا'} لك العرض التالي:`,
    code: 'الرمز', item: 'الصنف', qty: 'الكمية', price: 'سعر الوحدة', total: 'الإجمالي شامل الضريبة',
    subtotal: 'المجموع', discount: 'الخصم', vat: 'الضريبة', grand: 'المبلغ المطلوب',
    note: 'ملاحظة من الفرع',
    valid: (duration, when) => `هذا العرض ساري لمدة ${duration} — حتى ${when}.`,
    after: 'بعد ذلك لا تُضمن هذه الأسعار.',
    button: 'عرض فاتورتي',
    hint: 'سجّل الدخول إلى لوحتك بهذا البريد الإلكتروني لمشاهدة الفاتورة وقبول العرض. الفاتورة متاحة هناك فقط.',
    delivery: 'التوصيل إلى',
    bye: 'لازولايت ماربل',
  },
  fa: {
    dir: 'rtl', align: 'right',
    subject: (n) => `پیشنهاد قیمت شماره ${n} از لازولایت ماربل`,
    hello: (name) => `${name || 'مشتری'} گرامی،`,
    intro: (branch) => `از درخواست شما سپاسگزاریم. ${branch ? `شعبه ${branch}` : 'ما'} پیشنهاد زیر را برای شما آماده کرده است:`,
    code: 'کد', item: 'کالا', qty: 'مقدار', price: 'قیمت واحد', total: 'جمع با مالیات',
    subtotal: 'جمع کل', discount: 'تخفیف', vat: 'مالیات', grand: 'مبلغ قابل پرداخت',
    note: 'یادداشت شعبه',
    valid: (duration, when) => `این پیشنهاد به مدت ${duration} معتبر است — تا ${when}.`,
    after: 'پس از آن قیمت‌ها تضمین نمی‌شوند.',
    button: 'مشاهده فاکتور من',
    hint: 'برای دیدن فاکتور و پذیرش پیشنهاد، با همین ایمیل وارد پیشخوان خود شوید. فاکتور فقط در همان‌جا در دسترس است.',
    delivery: 'ارسال به',
    bye: 'لازولایت ماربل',
  },
};

function buildOfferEmail({ lang, pr, doc, branch, hours }) {
  const L = MAIL[pickLang(lang)];
  const lg = pickLang(lang);
  const when = formatWhen(doc.validUntil, branch);
  const duration = durationText(lg, hours);
  const link = dashboardLink(branch, lg, pr._id);
  const cell = `padding:8px 10px;border-bottom:1px solid #e3e7f0;text-align:${L.align};`;
  const head = `${cell}background:#eef1f8;color:#1a3a78;font-weight:700;font-size:12px;`;

  const rows = (doc.lineItems || []).map((li) => `
      <tr>
        <td style="${cell}font-family:monospace;font-size:12px;">${esc(li.code || '')}</td>
        <td style="${cell}">${esc(li.name)}</td>
        <td style="${cell}white-space:nowrap;">${esc(li.quantity)} ${esc(li.unit || '')}</td>
        <td style="${cell}white-space:nowrap;">${money(li.unitPrice)}</td>
        <td style="${cell}white-space:nowrap;font-weight:700;">${money(li.lineTotal)}</td>
      </tr>`).join('');

  const totalRow = (label, value, strong) => `
      <tr>
        <td colspan="4" style="padding:6px 10px;text-align:${L.align};${strong ? 'font-weight:700;font-size:15px;color:#1a3a78;' : 'color:#555;'}">${esc(label)}</td>
        <td style="padding:6px 10px;white-space:nowrap;text-align:${L.align};${strong ? 'font-weight:700;font-size:15px;color:#1a3a78;' : ''}">${money(value)} ${esc(doc.currency || 'AED')}</td>
      </tr>`;

  const html = `<!doctype html>
<html lang="${lg}" dir="${L.dir}">
<body style="margin:0;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#1c2333;">
  <div style="max-width:660px;margin:0 auto;padding:24px 14px;">
    <div style="background:#ffffff;border:1px solid #dde2ee;border-top:4px solid #1a3a78;padding:26px 24px;direction:${L.dir};text-align:${L.align};">
      <p style="margin:0 0 6px;font-size:16px;">${esc(L.hello(pr.name))}</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;">${esc(L.intro(branch && branch.name))}</p>

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;margin:0 0 6px;">
        <thead><tr>
          <th style="${head}">${esc(L.code)}</th><th style="${head}">${esc(L.item)}</th>
          <th style="${head}">${esc(L.qty)}</th><th style="${head}">${esc(L.price)}</th><th style="${head}">${esc(L.total)}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          ${totalRow(L.subtotal, doc.subtotal)}
          ${doc.discountTotal > 0 ? totalRow(L.discount, -doc.discountTotal) : ''}
          ${totalRow(L.vat, doc.vatTotal)}
          ${totalRow(L.grand, doc.grandTotal, true)}
        </tfoot>
      </table>

      ${doc.notes ? `<p style="margin:16px 0 0;padding:10px 12px;background:#f7f8fb;border-${L.dir === 'rtl' ? 'right' : 'left'}:3px solid #1a3a78;font-size:13px;line-height:1.6;white-space:pre-wrap;"><b>${esc(L.note)}:</b> ${esc(doc.notes)}</p>` : ''}

      <p style="margin:20px 0 4px;padding:12px 14px;background:#fff6e5;border:1px solid #f0d9a8;font-size:14px;line-height:1.6;"><b>${esc(L.valid(duration, when))}</b><br>${esc(L.after)}</p>

      <p style="margin:22px 0 10px;text-align:center;"><a href="${esc(link)}" style="display:inline-block;background:#1a3a78;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 30px;border-radius:4px;">${esc(L.button)}</a></p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:#667;text-align:center;">${esc(L.hint)}</p>
    </div>
    <p style="margin:14px 0 0;text-align:center;font-size:12px;color:#889;">${esc(L.bye)}</p>
  </div>
</body>
</html>`;

  const lines = (doc.lineItems || []).map((li) => `- ${li.code ? li.code + ' ' : ''}${li.name}: ${li.quantity} ${li.unit || ''} x ${money(li.unitPrice)} = ${money(li.lineTotal)}`);
  const text = [
    L.hello(pr.name), '', L.intro(branch && branch.name), '', ...lines, '',
    `${L.grand}: ${money(doc.grandTotal)} ${doc.currency || 'AED'}`,
    doc.notes ? `\n${L.note}: ${doc.notes}` : '',
    '', L.valid(duration, when), L.after, '', `${L.button}: ${link}`, L.hint,
  ].join('\n');

  return { subject: L.subject(doc.docNumber), html, text, link };
}

// ── staff: send / withdraw ───────────────────────────────────────────────────

async function createOffer({ priceRequestId, actor, input = {} }) {
  const { computeTotals, nextDocNumber, logActivity, loadProfile, findStockOverages, buildCustomerSnapshot } = mis();

  if (!mongoose.isValidObjectId(priceRequestId)) throw new OfferError(400, 'Invalid ID');
  const pr = await PriceRequest.findById(priceRequestId);
  if (!pr) throw new OfferError(404, 'Price request not found');
  const branchId = pr.branchId || (pr.items && pr.items[0] && pr.items[0].branchId);
  if (!branchId) throw new OfferError(400, 'This request has no branch');
  if (!(await assertBranchAccess(actor.id, branchId))) throw new OfferError(403, 'You do not have access to this branch');

  // Offers made earlier for this request. One the customer already took ends it.
  const earlier = await MisInvoice.find({ priceRequestId: pr._id, docType: 'pre_invoice', deleteDate: null }).sort({ insertDate: -1 });
  if (earlier.some((d) => d.status === 'accepted' || d.status === 'converted')) {
    throw new OfferError(409, 'The customer has already accepted an offer for this request');
  }

  const profile = await loadProfile(branchId);
  const branch = await Branch.findById(branchId).select('name country websiteSlug misTemplates phone').lean();

  // VAT: the branch's own rate unless the associate set one for this offer.
  const vatRate = input.vatRate === undefined || input.vatRate === null || input.vatRate === ''
    ? ((profile && profile.vatRate) ?? 5)
    : Number(input.vatRate);
  if (!(vatRate >= 0 && vatRate <= 100)) throw new OfferError(400, 'VAT rate must be between 0 and 100');

  // Lines: every requested item, priced. The associate may leave one out
  // (include:false) or change its quantity; the price is always theirs.
  const requested = pr.items || [];
  const inputs = Array.isArray(input.lines) ? input.lines : [];
  const lineItems = [];
  for (let i = 0; i < requested.length; i++) {
    const item = requested[i];
    const given = inputs.find((l) => Number(l.index) === i) || {};
    if (given.include === false) continue;

    const quantity = given.quantity === undefined || given.quantity === null || given.quantity === ''
      ? Number(item.quantity) : Number(given.quantity);
    if (!(quantity > 0)) throw new OfferError(400, `Enter a quantity for ${item.variantCode}`);

    const unitPrice = Number(given.unitPrice);
    if (!(Number.isFinite(unitPrice) && unitPrice > 0)) throw new OfferError(400, `Enter a price for ${item.variantCode}`);

    const discountType = given.discountType === 'percent' ? 'percent' : 'amount';
    const discount = Math.max(0, Number(given.discount) || 0);
    if (discountType === 'percent' && discount > 100) throw new OfferError(400, `The discount on ${item.variantCode} cannot exceed 100%`);

    lineItems.push({
      productId: item.productId, variantId: item.variantId,
      code: item.variantCode, name: item.productName || item.variantCode,
      unit: item.unit || 'M2', quantity, unitPrice, discount, discountType, vatRate,
      sourceType: 'inventory',
    });
  }
  if (!lineItems.length) throw new OfferError(400, 'Include at least one item in the offer');

  // Delivery depends on where the load goes — a plain taxable line, so it shows
  // on the document and in the totals like anything else.
  const delivery = input.deliveryCharge === undefined || input.deliveryCharge === null || input.deliveryCharge === ''
    ? 0 : Number(input.deliveryCharge);
  if (!(delivery >= 0)) throw new OfferError(400, 'The delivery charge cannot be negative');
  if (delivery > 0) {
    const place = (pr.receivingAddress && pr.receivingAddress.city) || pr.city || '';
    lineItems.push({
      code: 'DELIVERY', name: place ? `Delivery to ${place}` : 'Delivery', unit: 'LS',
      quantity: 1, unitPrice: delivery, discount: 0, discountType: 'amount', vatRate, sourceType: 'inventory',
    });
  }

  // Stock may have moved since the customer asked.
  const overages = await findStockOverages(lineItems);
  if (overages.length) {
    throw new OfferError(400, 'Requested quantity exceeds available stock', { overages });
  }

  const hours = input.validForHours === undefined || input.validForHours === null || input.validForHours === ''
    ? DEFAULT_VALID_HOURS : Number(input.validForHours);
  if (!(hours * 60 >= MIN_VALID_MINUTES)) throw new OfferError(400, `An offer must stay valid for at least ${MIN_VALID_MINUTES} minutes`);
  if (hours > MAX_VALID_HOURS) throw new OfferError(400, 'An offer can stay valid for 60 days at most');

  const customerSnapshot = await buildCustomerSnapshot(pr.customerId, {
    name: pr.name, address: formatAddress(pr),
    country: (pr.receivingAddress && pr.receivingAddress.country) || pr.country || '',
    phone: pr.phone || '',
  });
  if (!customerSnapshot) throw new OfferError(404, 'Customer not found');

  const note = String(input.note || '').trim().slice(0, 2000);
  const totals = computeTotals(lineItems, 0);
  const now = new Date();
  const validUntil = new Date(now.getTime() + Math.round(hours * 3600 * 1000));

  const doc = await MisInvoice.create({
    branchId,
    docType: 'pre_invoice',
    docNumber: await nextDocNumber(branchId, 'pre_invoice'),
    status: 'sent',
    tradeMode: 'customer',
    issueDate: now,
    customerId: pr.customerId,
    customerSnapshot,
    lineItems: totals.lines,
    currency: 'AED',
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    vatTotal: totals.vatTotal,
    shipping: 0,
    grandTotal: totals.grandTotal,
    validityDays: Math.max(1, Math.ceil(hours / 24)),
    validUntil,
    validUntilTz: zoneFor(branch),
    priceRequestId: pr._id,
    assignedTo: [actor.id],
    notes: note || undefined,
    insertDate: now,
    createdBy: actor.id,
  });

  const actorName = await nameOf(actor.id);
  await logActivity(doc._id, 'pre_invoice', 'created', { newValue: doc.docNumber, body: 'From a website price request' }, actor.id, actorName);
  await logActivity(doc._id, 'pre_invoice', 'website_offer_sent', {
    body: `Sent to ${pr.email}; valid until ${validUntil.toISOString()}`, newValue: hours,
  }, actor.id, actorName);

  // Any earlier offer for this request that is still open is replaced by this one.
  for (const old of earlier) {
    if (old.status !== 'sent') continue;
    const cutoff = old.validUntil && old.validUntil < now ? old.validUntil : now;
    await MisInvoice.updateOne({ _id: old._id, status: 'sent' }, { $set: { status: 'expired', validUntil: cutoff, updateDate: now } });
    await logActivity(old._id, 'pre_invoice', 'website_offer_withdrawn', { body: `Replaced by offer #${doc.docNumber}` }, actor.id, actorName);
  }

  pr.status = 'responded';
  pr.response = {
    body: note || `Price offer #${doc.docNumber} sent`,
    respondedBy: actor.id, respondedByName: actorName, respondedAt: now,
  };
  pr.updateDate = now;
  await pr.save();

  await CustomerActivity.create({
    customerId: pr.customerId, type: 'price_request', actorId: actor.id, actorName,
    body: `Price offer #${doc.docNumber} sent — ${money(totals.grandTotal)} AED, valid until ${formatWhen(validUntil, branch)}`,
    date: now,
  }).catch(() => {});

  let mailWarning;
  const email = buildOfferEmail({ lang: pr.language, pr, doc: doc.toObject(), branch, hours });
  try {
    await sendMail({ to: pr.email, subject: email.subject, text: email.text, html: email.html });
  } catch (mailErr) {
    // The offer exists and is on the dashboard; only the e-mail failed.
    mailWarning = 'The offer was created, but the email to the customer failed to send';
  }

  return { doc: doc.toObject(), mailWarning };
}

// Pulls back an offer that is still open (the customer can no longer accept it).
async function withdrawOffer({ priceRequestId, actor }) {
  const { logActivity } = mis();
  if (!mongoose.isValidObjectId(priceRequestId)) throw new OfferError(400, 'Invalid ID');
  const pr = await PriceRequest.findById(priceRequestId).select('branchId items').lean();
  if (!pr) throw new OfferError(404, 'Price request not found');
  const branchId = pr.branchId || (pr.items && pr.items[0] && pr.items[0].branchId);
  if (!branchId || !(await assertBranchAccess(actor.id, branchId))) {
    throw new OfferError(403, 'You do not have access to this branch');
  }
  const now = new Date();
  const open = await MisInvoice.findOneAndUpdate(
    { priceRequestId, docType: 'pre_invoice', status: 'sent', deleteDate: null },
    { $set: { status: 'expired', validUntil: now, updateDate: now } },
    { new: true, sort: { insertDate: -1 } }
  );
  if (!open) throw new OfferError(409, 'There is no open offer to withdraw');
  await logActivity(open._id, 'pre_invoice', 'website_offer_withdrawn', { body: 'Withdrawn by the branch' }, actor.id, await nameOf(actor.id));
  return open.toObject();
}

// ── customer: accept ─────────────────────────────────────────────────────────

// The customer takes an open offer: its quantities come out of stock (the same
// rule as any accepted quotation) and it becomes an invoice. Returns both.
async function acceptOffer({ offerId, customerId }) {
  const { computeTotals, nextDocNumber, logActivity, findStockOverages, issueStockDecrement, restoreStock } = mis();

  if (!mongoose.isValidObjectId(offerId)) throw new OfferError(404, 'Offer not found');
  const base = { _id: offerId, customerId, priceRequestId: { $ne: null }, docType: 'pre_invoice', deleteDate: null };
  const now = new Date();

  // One atomic flip decides who gets to accept: a double click, or two tabs,
  // can only ever create one invoice.
  const pre = await MisInvoice.findOneAndUpdate(
    { ...base, status: 'sent', validUntil: { $gt: now } },
    { $set: { status: 'accepted', customerAcceptedAt: now, updateDate: now } },
    { new: true }
  );
  if (!pre) {
    const current = await MisInvoice.findOne(base).lean();
    if (!current) throw new OfferError(404, 'Offer not found');
    if (current.status === 'converted' && current.convertedToInvoiceId) {
      const invoice = await MisInvoice.findById(current.convertedToInvoiceId).lean();
      return { offer: current, invoice, alreadyAccepted: true };
    }
    if (current.status === 'accepted') throw new OfferError(409, 'This offer is already being processed — refresh in a moment');
    throw new OfferError(410, 'This offer has expired', { code: 'OFFER_EXPIRED' });
  }

  const customerLabel = 'Customer (website)';
  let reserved = false;
  let invoice;
  const preObj = pre.toObject();
  try {
    // Stock may have moved since the offer went out.
    const overages = await findStockOverages(preObj.lineItems);
    if (overages.length) {
      throw new OfferError(409, 'Some items are no longer available in this quantity — please contact the branch', { code: 'OUT_OF_STOCK', overages });
    }

    await issueStockDecrement(preObj, null, customerLabel, `Quotation #${pre.docNumber} accepted by the customer`);
    reserved = true;

    const totals = computeTotals(preObj.lineItems, 0);
    invoice = await MisInvoice.create({
      branchId: pre.branchId,
      docType: 'invoice',
      docNumber: await nextDocNumber(pre.branchId, 'invoice'),
      status: 'issued',
      tradeMode: 'customer',
      issueDate: now,
      customerId: pre.customerId,
      customerSnapshot: preObj.customerSnapshot,
      lineItems: totals.lines,
      currency: pre.currency || 'AED',
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      vatTotal: totals.vatTotal,
      shipping: totals.shipping,
      grandTotal: totals.grandTotal,
      amountInWords: amountToArabicWords(totals.grandTotal),
      salesRepId: pre.createdBy,
      salesRepName: await nameOf(pre.createdBy),
      convertedFromPreInvoiceId: pre._id,
      priceRequestId: pre.priceRequestId,
      // the reservation made just above now belongs to the invoice
      stockDecremented: true,
      assignedTo: pre.assignedTo,
      notes: pre.notes,
      insertDate: now,
      createdBy: pre.createdBy,
    });
  } catch (err) {
    // No invoice exists — undo the half-done accept so the customer (or the
    // branch) can try again.
    try {
      if (reserved) {
        const fresh = await MisInvoice.findById(pre._id).lean();
        await restoreStock(fresh, null, customerLabel, `Quotation #${pre.docNumber} — accept failed, stock put back`);
      }
      await MisInvoice.updateOne({ _id: pre._id, status: 'accepted' }, { $set: { status: 'sent', customerAcceptedAt: null, updateDate: new Date() } });
    } catch (_) { /* nothing more to do */ }
    throw err;
  }

  // The invoice exists. Everything from here is bookkeeping and must not undo it.
  await MisInvoice.updateOne({ _id: pre._id }, {
    $set: { status: 'converted', convertedToInvoiceId: invoice._id, stockDecremented: false, updateDate: now },
  });
  await logActivity(pre._id, 'pre_invoice', 'website_offer_accepted', { body: 'Accepted by the customer on the website' }, null, customerLabel);
  await logActivity(pre._id, 'pre_invoice', 'converted', { newValue: invoice.docNumber }, null, customerLabel);
  await logActivity(invoice._id, 'invoice', 'created', { body: `Created when the customer accepted quotation #${pre.docNumber}`, newValue: invoice.docNumber }, null, customerLabel);
  await logActivity(invoice._id, 'invoice', 'stock_decremented', { body: `Already out of stock — reserved when quotation #${pre.docNumber} was accepted` }, null, customerLabel);

  await PriceRequest.updateOne({ _id: pre.priceRequestId }, { $set: { status: 'closed', updateDate: now } }).catch(() => {});
  await CustomerActivity.create({
    customerId: pre.customerId, type: 'price_request', actorId: null, actorName: customerLabel,
    body: `Accepted offer #${pre.docNumber} — invoice #${invoice.docNumber} (${money(invoice.grandTotal)} AED)`,
    date: now,
  }).catch(() => {});

  // Tell the branch (best effort).
  (async () => {
    try {
      const recipients = await offerRecipients(pre.branchId, pre.createdBy);
      await notifyAll(recipients, {
        type: 'priceRequest', textKey: 'websiteOfferAccepted',
        textParams: { customerName: (preObj.customerSnapshot && preObj.customerSnapshot.name) || '', offerNumber: pre.docNumber, invoiceNumber: invoice.docNumber },
        entityType: 'invoice', entityId: String(invoice._id),
      });
    } catch (_) { /* best-effort */ }
  })();

  return { offer: await MisInvoice.findById(pre._id).lean(), invoice: invoice.toObject() };
}

// ── expiry ───────────────────────────────────────────────────────────────────

// Flips offers whose time has run out to 'expired' and tells whoever sent them.
// The accept route refuses a late offer by itself, so this is about the MIS
// side (status filters, cards) being right rather than about safety.
async function expireOffers() {
  const { logActivity } = mis();
  const now = new Date();
  const stale = await MisInvoice.find({
    priceRequestId: { $ne: null }, docType: 'pre_invoice', status: 'sent',
    validUntil: { $lte: now }, deleteDate: null,
  }).select('_id docNumber branchId createdBy customerSnapshot').limit(200).lean();

  for (const doc of stale) {
    const res = await MisInvoice.updateOne({ _id: doc._id, status: 'sent' }, { $set: { status: 'expired', updateDate: now } });
    if (!res.modifiedCount) continue;
    await logActivity(doc._id, 'pre_invoice', 'website_offer_expired', { body: 'The customer did not accept in time' }, null, 'System');
    if (doc.createdBy) {
      sendNotificationToUser(doc.createdBy, {
        type: 'priceRequest', textKey: 'websiteOfferExpired',
        textParams: { customerName: (doc.customerSnapshot && doc.customerSnapshot.name) || '', offerNumber: doc.docNumber },
        entityType: 'invoice', entityId: String(doc._id),
      }).catch(() => {});
    }
  }
  return stale.length;
}

let sweepTimer = null;
function startOfferExpirySweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { expireOffers().catch(() => {}); }, 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();   // never keeps the process alive on its own
  expireOffers().catch(() => {});
}

// ── reading ──────────────────────────────────────────────────────────────────

// priceRequestId → { offer, invoice }: the latest quotation raised for the
// request and the invoice it became, if any.
async function offersByRequest(requestIds) {
  const ids = (requestIds || []).filter((id) => mongoose.isValidObjectId(id));
  const out = new Map();
  if (!ids.length) return out;
  const docs = await MisInvoice.find({ priceRequestId: { $in: ids }, deleteDate: null }).sort({ insertDate: -1 }).lean();
  for (const d of docs) {
    const key = String(d.priceRequestId);
    if (!out.has(key)) out.set(key, { offer: null, invoice: null });
    const slot = out.get(key);
    if (d.docType === 'pre_invoice' && !slot.offer) slot.offer = d;
    if (d.docType === 'invoice' && !slot.invoice) slot.invoice = d;
  }
  return out;
}

// open | expired | accepted (invoice exists) — never trusts the stored status
// alone, since the sweep runs once a minute.
function offerState(offer, now = new Date()) {
  if (!offer) return 'none';
  if (offer.status === 'converted' || offer.status === 'accepted') return 'accepted';
  if (offer.status === 'sent' && offer.validUntil && new Date(offer.validUntil) > now) return 'open';
  return 'expired';
}

// What MIS staff see next to a request.
function toStaffOffer(slot, now = new Date()) {
  if (!slot || !slot.offer) return null;
  const { offer, invoice } = slot;
  return {
    _id: offer._id, docNumber: offer.docNumber, state: offerState(offer, now),
    status: offer.status, validUntil: offer.validUntil, grandTotal: offer.grandTotal,
    currency: offer.currency || 'AED', customerAcceptedAt: offer.customerAcceptedAt || null,
    invoice: invoice ? { _id: invoice._id, docNumber: invoice.docNumber, status: invoice.status, grandTotal: invoice.grandTotal } : null,
    serverNow: now,
  };
}

const publicLine = (li) => ({
  code: li.code || '', name: li.name || '', unit: li.unit || '', quantity: li.quantity,
  unitPrice: li.unitPrice, discount: li.discount || 0, discountType: li.discountType || 'amount',
  vatRate: li.vatRate, lineTotal: li.lineTotal,
});

const publicDoc = (d) => ({
  _id: d._id, docNumber: d.docNumber, docType: d.docType, status: d.status, currency: d.currency || 'AED',
  lines: (d.lineItems || []).map(publicLine),
  subtotal: d.subtotal, discountTotal: d.discountTotal, vatTotal: d.vatTotal, grandTotal: d.grandTotal,
  notes: d.notes || '', issueDate: d.issueDate,
});

// What the customer sees on the dashboard — never internal fields (who created
// it, assignees, activity, stock flags).
function toPublicOffer(slot, now = new Date()) {
  if (!slot || !slot.offer) return null;
  const { offer, invoice } = slot;
  return {
    ...publicDoc(offer),
    state: offerState(offer, now),
    validUntil: offer.validUntil,
    serverNow: now,
    invoice: invoice ? publicDoc(invoice) : null,
  };
}

// The document itself, rendered by the very template MIS prints. Only for a
// document that belongs to this customer AND came from a website request.
async function renderCustomerDocument({ docId, customerId, lang }) {
  const { loadProfile, resolveTemplateVariant } = mis();
  if (!mongoose.isValidObjectId(docId)) return null;
  const doc = await MisInvoice.findOne({
    _id: docId, customerId, priceRequestId: { $ne: null }, deleteDate: null, status: { $ne: 'draft' },
  }).lean();
  if (!doc) return null;
  const [profile, branch] = await Promise.all([
    loadProfile(doc.branchId),
    Branch.findById(doc.branchId).select('misTemplates').lean(),
  ]);
  const variant = resolveTemplateVariant(branch, doc.docType, doc.tradeMode);
  return renderInvoiceHtml(doc, profile, pickLang(lang), variant);
}

module.exports = {
  OfferError,
  DEFAULT_VALID_HOURS,
  createOffer, withdrawOffer, acceptOffer,
  expireOffers, startOfferExpirySweep,
  offersByRequest, offerState, toStaffOffer, toPublicOffer, renderCustomerDocument,
  formatAddress, formatWhen,
};
