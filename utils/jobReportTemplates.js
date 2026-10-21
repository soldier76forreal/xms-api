// ── Job report form templates ─────────────────────────────────────────────────
// A role selects WHICH form its holders file their daily report on. 'classic'
// is the free-text report the app has always had; 'salesperson' is the real
// paper "التقرير اليومي" sheet the sales reps fill in by hand, turned into a
// dynamic form.
//
// THIS FILE IS THE ONLY SOURCE OF TRUTH for both halves of a template:
//   · the form the browser draws  (served by GET /users/jobReports/templates)
//   · the sheet the browser prints (rendered by utils/jobReportTemplate.js)
// so a field cannot exist on one and be missing from the other. Adding a
// template is a change to this file alone — no schema migration (same reason
// branch.misTemplates stores plain strings instead of a Mongoose enum: the
// registry decides what is valid, and an unknown key falls back to 'classic').
//
// LABELS LIVE HERE, IN ALL THREE LANGUAGES, not in xms/src/i18n/locales/*.json.
// A template's labels are domain content that the SERVER also has to print on
// a PDF in Arabic, Farsi or English; keeping one copy here is what stops the
// printed sheet and the on-screen form from drifting apart. The app's own
// chrome (buttons, "Save", "Submit") still goes through t() as usual.
//
// Field types the renderer understands:
//   date · time · number · money · text · textarea · select
//   customer   → CRM customer (picked, or created on the spot)
//   variety    → Inventory product / variety, by its stone code. With
//                `allowText: true` the field also takes plain text, for a
//                stone the catalogue does not carry — stored as {text}.
//   dmContent  → a Digital Marketing record (raw content, ready to upload,
//                WhatsApp share or external link page)
//   recipient  → who/what something went to: one of SOCIAL_CHANNELS, a CRM
//                customer, or plain text. Stored as {mode, …}.
//   lines      → (a table column only) a LIST inside one row, each entry a small
//                row of its own `columns` — a customer's purchase of several
//                stones, each with its own quantity and price. Stored as an
//                array of objects. A column may be computed from it:
//                `computed: 'sum:<list key>.<column key>'`.
// The three reference types are never trusted from the client: every one is
// re-fetched and re-snapshotted server-side (see resolveSections in
// utils/jobReportSections.js), the same discipline as an MIS line item.

'use strict';

const LANGS = ['en', 'ar', 'fa'];

// Where content goes. Defined here, beside the templates, for the same reason
// the labels are: the printed sheet has to name the channel in Arabic too, and
// a second copy would drift. `icon` is a NAME the frontend maps to a component
// — this file stays free of anything React.
// The VALUE is the English literal and is what gets stored; only the label is
// translated (brand names are not translated at all, per the i18n rules).
const SOCIAL_CHANNELS = [
  { value: 'whatsapp',  icon: 'whatsapp',  color: '#25D366', label: { en: 'WhatsApp',  ar: 'واتساب',   fa: 'واتساپ' } },
  { value: 'instagram', icon: 'instagram', color: '#E1306C', label: { en: 'Instagram', ar: 'إنستغرام', fa: 'اینستاگرام' } },
  { value: 'tiktok',    icon: 'tiktok',    color: '#000000', label: { en: 'TikTok',    ar: 'تيك توك',  fa: 'تیک‌تاک' } },
  { value: 'telegram',  icon: 'telegram',  color: '#229ED9', label: { en: 'Telegram',  ar: 'تيليغرام', fa: 'تلگرام' } },
  { value: 'facebook',  icon: 'facebook',  color: '#1877F2', label: { en: 'Facebook',  ar: 'فيسبوك',   fa: 'فیسبوک' } },
  { value: 'youtube',   icon: 'youtube',   color: '#FF0000', label: { en: 'YouTube',   ar: 'يوتيوب',   fa: 'یوتیوب' } },
  { value: 'snapchat',  icon: 'snapchat',  color: '#FFFC00', label: { en: 'Snapchat',  ar: 'سناب شات', fa: 'اسنپ‌چت' } },
  { value: 'x',         icon: 'x',         color: '#000000', label: { en: 'X',         ar: 'إكس',      fa: 'ایکس' } },
  { value: 'linkedin',  icon: 'linkedin',  color: '#0A66C2', label: { en: 'LinkedIn',  ar: 'لينكد إن', fa: 'لینکدین' } },
  { value: 'pinterest', icon: 'pinterest', color: '#E60023', label: { en: 'Pinterest', ar: 'بينتريست', fa: 'پینترست' } },
  { value: 'email',     icon: 'email',     color: '#6E7781', label: { en: 'Email',     ar: 'بريد إلكتروني', fa: 'ایمیل' } },
  { value: 'sms',       icon: 'sms',       color: '#6E7781', label: { en: 'SMS',       ar: 'رسالة نصية', fa: 'پیامک' } },
  { value: 'website',   icon: 'website',   color: '#6E7781', label: { en: 'Website',   ar: 'الموقع',   fa: 'وب‌سایت' } },
  { value: 'other',     icon: 'other',     color: '#6E7781', label: { en: 'Other',     ar: 'أخرى',     fa: 'سایر' } },
];

const CHANNEL_VALUES = SOCIAL_CHANNELS.map((c) => c.value);
const channelByValue = (value) => SOCIAL_CHANNELS.find((c) => c.value === value) || null;
const DEFAULT_TEMPLATE = 'classic';

// ── classic — the free-text report, unchanged in behaviour ──────────────────
// Its two fields bind straight onto the model's own title/body columns so
// every report filed before templates existed still reads, prints and shows in
// the admin list exactly as it did.
const classic = {
  key: 'classic',
  page: 'portrait',
  label: {
    en: 'Classic report',
    ar: 'التقرير الكلاسيكي',
    fa: 'گزارش کلاسیک',
  },
  description: {
    en: 'A free-text daily report with attachments.',
    ar: 'تقرير يومي نصي حر مع المرفقات.',
    fa: 'گزارش روزانه متنی آزاد همراه با پیوست‌ها.',
  },
  sections: [
    {
      key: 'core',
      kind: 'fields',
      core: true,
      label: { en: 'Report', ar: 'التقرير', fa: 'گزارش' },
      fields: [
        {
          key: 'reportDate', type: 'date', required: true, bind: 'reportDate',
          label: { en: 'Date', ar: 'التاريخ', fa: 'تاریخ' },
        },
        {
          key: 'title', type: 'text', bind: 'title',
          label: { en: 'Title', ar: 'العنوان', fa: 'عنوان' },
        },
      ],
    },
    {
      key: 'report',
      kind: 'fields',
      label: { en: 'What happened today', ar: 'ماذا حدث اليوم', fa: 'امروز چه گذشت' },
      fields: [
        {
          key: 'body', type: 'textarea', rows: 6, bind: 'body',
          label: { en: 'Report', ar: 'التقرير', fa: 'گزارش' },
        },
      ],
    },
  ],
};

// ── salesperson — the real daily sheet (التقرير اليومي) ─────────────────────
// Built column-for-column from the printed form the reps carry. Everything the
// paper leaves as handwriting but the app already knows — the customer, the
// marble variety, a piece of content that went out — is a live reference
// instead of free text, so a report ties back to CRM, Inventory and Digital
// Marketing rather than restating them.
const salesperson = {
  key: 'salesperson',
  page: 'landscape',
  label: {
    en: 'Salesperson daily report',
    ar: 'التقرير اليومي للمندوب',
    fa: 'گزارش روزانه فروشنده',
  },
  description: {
    en: 'The daily sales sheet: calls, confirmed and lost orders, follow-ups, collections and market intelligence.',
    ar: 'التقرير اليومي للمبيعات: الاتصالات، الطلبات المؤكدة وغير المتفق عليها، المتابعات، التحصيلات ومعلومات السوق.',
    fa: 'گزارش روزانه فروش: تماس‌ها، سفارش‌های قطعی و منتفی، پیگیری‌ها، وصولی‌ها و اطلاعات بازار.',
  },
  sections: [
    {
      key: 'core',
      kind: 'fields',
      core: true,
      label: {
        en: 'General information about the work day',
        ar: 'معلومات عامة عن يوم العمل',
        fa: 'اطلاعات کلی روز کاری',
      },
      fields: [
        {
          key: 'reportDate', type: 'date', required: true, bind: 'reportDate',
          label: { en: 'Date', ar: 'التاريخ', fa: 'تاریخ' },
        },
        {
          key: 'callsCount', type: 'number', min: 0,
          label: { en: 'Number of calls', ar: 'عدد الاتصالات', fa: 'تعداد تماس‌ها' },
        },
        {
          key: 'messagesCount', type: 'number', min: 0,
          label: { en: 'Number of messages', ar: 'عدد الرسائل', fa: 'تعداد پیام‌ها' },
        },
        {
          key: 'startTime', type: 'time',
          label: { en: 'Work start time', ar: 'وقت بداية العمل', fa: 'ساعت شروع کار' },
        },
        {
          key: 'endTime', type: 'time',
          label: { en: 'Work end time', ar: 'وقت نهاية العمل', fa: 'ساعت پایان کار' },
        },
      ],
    },

    {
      key: 'confirmedOrders',
      kind: 'table',
      label: { en: 'Confirmed orders', ar: 'الطلبات المؤكدة', fa: 'سفارش‌های قطعی' },
      columns: [
        { key: 'customer', type: 'customer', width: 2, label: { en: 'Customer', ar: 'العميل', fa: 'مشتری' } },
        {
          // One purchase can be several kinds of stone, each with its own quantity and price, so the stones are
          // a LIST inside the order (not one stone per order). Orders filed before this existed have the stone's
          // fields on the order itself; liftLegacyRow() reads those as a one-stone list.
          key: 'items', type: 'lines', width: 7,
          label: { en: 'Stone types bought', ar: 'أنواع الرخام المشتراة', fa: 'سنگ‌های خریداری‌شده' },
          columns: [
            { key: 'variety', type: 'variety', width: 3, label: { en: 'Stone type', ar: 'نوع الرخام', fa: 'نوع سنگ' }, allowText: true },
            { key: 'quantity', type: 'number', min: 0, label: { en: 'Quantity (m³)', ar: 'الكمية (م3)', fa: 'مقدار (م۳)' } },
            { key: 'unitPrice', type: 'money', label: { en: 'Price per metre', ar: 'سعر المتر', fa: 'قیمت هر متر' } },
            {
              key: 'total', type: 'money', computed: 'quantity*unitPrice',
              label: { en: 'Stone total', ar: 'اجمالي الصنف', fa: 'جمع این سنگ' },
            },
          ],
        },
        {
          key: 'total', type: 'money', computed: 'sum:items.total',
          label: { en: 'Order total', ar: 'اجمالي الطلب', fa: 'جمع سفارش' },
        },
      ],
      // Printed under the table, exactly as the paper form's two summary cells.
      totals: [
        { key: 'count', of: null, label: { en: 'Number of orders', ar: 'عدد الطلبات', fa: 'تعداد سفارش‌ها' } },
        { key: 'value', of: 'total', label: { en: 'Total order value', ar: 'اجمالي قيمة الطلبات', fa: 'ارزش کل سفارش‌ها' } },
      ],
    },

    {
      key: 'lostOrders',
      kind: 'table',
      label: { en: 'Orders not agreed', ar: 'طلبات لم تتفق', fa: 'سفارش‌های منتفی' },
      columns: [
        { key: 'customer', type: 'customer', width: 2, label: { en: 'Customer', ar: 'العميل', fa: 'مشتری' } },
        { key: 'variety', type: 'variety', width: 2, label: { en: 'Stone type', ar: 'نوع الرخام', fa: 'نوع سنگ' }, allowText: true },
        { key: 'quantity', type: 'number', min: 0, label: { en: 'Quantity', ar: 'الكمية', fa: 'مقدار' } },
        { key: 'price', type: 'money', label: { en: 'Price', ar: 'السعر', fa: 'قیمت' } },
        {
          key: 'reason', type: 'text', width: 2,
          label: { en: 'Reason it did not close', ar: 'سبب عدم الاتفاق', fa: 'علت عدم توافق' },
        },
      ],
    },

    {
      key: 'customerFollowUps',
      kind: 'table',
      label: {
        en: 'Follow-up with previous customers',
        ar: 'متابعة العملاء السابقين',
        fa: 'پیگیری مشتریان قبلی',
      },
      columns: [
        { key: 'customer', type: 'customer', width: 2, label: { en: 'Customer', ar: 'العميل', fa: 'مشتری' } },
        {
          key: 'state', type: 'select', width: 2,
          label: { en: 'Status', ar: 'الحالة', fa: 'وضعیت' },
          // The stored value is always the English literal — only the shown
          // label is translated (the data-integrity rule in CLAUDE.md's i18n
          // section: never persist a translated string).
          options: [
            { value: 'interested', label: { en: 'Interested', ar: 'مهتم', fa: 'علاقه‌مند' } },
            { value: 'not_interested', label: { en: 'Not interested', ar: 'غير مهتم', fa: 'بی‌علاقه' } },
            { value: 'postponed', label: { en: 'Postponed', ar: 'مؤجل', fa: 'به تعویق افتاد' } },
            { value: 'ordered', label: { en: 'Placed an order', ar: 'قام بالطلب', fa: 'سفارش داد' } },
            { value: 'no_answer', label: { en: 'No answer', ar: 'لم يرد', fa: 'پاسخ نداد' } },
          ],
        },
        { key: 'notes', type: 'text', width: 3, label: { en: 'Notes', ar: 'ملاحظات', fa: 'یادداشت‌ها' } },
      ],
    },

    {
      key: 'collections',
      kind: 'table',
      label: { en: 'Collections', ar: 'التحصيلات', fa: 'وصولی‌ها' },
      columns: [
        { key: 'customer', type: 'customer', width: 2, label: { en: 'Customer', ar: 'العميل', fa: 'مشتری' } },
        { key: 'amount', type: 'money', label: { en: 'Amount', ar: 'المبلغ', fa: 'مبلغ' } },
        {
          key: 'method', type: 'select', width: 2,
          label: { en: 'Payment method', ar: 'طريقة الدفع', fa: 'روش پرداخت' },
          options: [
            { value: 'cash', label: { en: 'Cash', ar: 'نقدي', fa: 'نقدی' } },
            { value: 'cheque', label: { en: 'Cheque', ar: 'شيك', fa: 'چک' } },
            { value: 'transfer', label: { en: 'Bank transfer', ar: 'تحويل بنكي', fa: 'حواله بانکی' } },
            { value: 'card', label: { en: 'Card', ar: 'بطاقة', fa: 'کارت' } },
          ],
        },
        { key: 'notes', type: 'text', width: 2, label: { en: 'Notes', ar: 'ملاحظات', fa: 'یادداشت‌ها' } },
      ],
      totals: [
        {
          key: 'collected', of: 'amount',
          label: { en: 'Total collected', ar: 'اجمالي مبلغ التحصيل', fa: 'جمع کل وصولی' },
        },
      ],
    },

    {
      key: 'marketIntel',
      kind: 'table',
      label: {
        en: 'Market and competitor information obtained today',
        ar: 'معلومات السوق والمنافسين التي تم الحصول عليها اليوم',
        fa: 'اطلاعات بازار و رقبا که امروز به دست آمد',
      },
      columns: [
        { key: 'variety', type: 'variety', width: 2, label: { en: 'Stone type', ar: 'نوع الرخام', fa: 'نوع سنگ' }, allowText: true },
        { key: 'competitor', type: 'text', width: 2, label: { en: 'Competitor', ar: 'المنافس', fa: 'رقیب' } },
        { key: 'price', type: 'money', label: { en: 'Price', ar: 'السعر', fa: 'قیمت' } },
        { key: 'notes', type: 'text', width: 3, label: { en: 'Notes', ar: 'ملاحظات', fa: 'یادداشت‌ها' } },
      ],
    },

    {
      key: 'mostRequested',
      kind: 'table',
      label: {
        en: 'Most requested types today',
        ar: 'اكثر الانواع المطلوبة اليوم',
        fa: 'پرتقاضاترین انواع امروز',
      },
      columns: [
        { key: 'variety', type: 'variety', width: 2, label: { en: 'Stone type', ar: 'نوع الرخام', fa: 'نوع سنگ' }, allowText: true },
        { key: 'notes', type: 'text', width: 4, label: { en: 'Notes', ar: 'ملاحظات', fa: 'یادداشت‌ها' } },
      ],
    },

    {
      key: 'weakDemand',
      kind: 'table',
      label: {
        en: 'Items in stock but with weak demand',
        ar: 'اصناف متوفرة ولكن عليها طلب ضعيف',
        fa: 'اقلام موجود اما کم‌تقاضا',
      },
      columns: [
        { key: 'variety', type: 'variety', width: 2, label: { en: 'Stone type', ar: 'نوع الرخام', fa: 'نوع سنگ' }, allowText: true },
        { key: 'notes', type: 'text', width: 4, label: { en: 'Notes', ar: 'ملاحظات', fa: 'یادداشت‌ها' } },
      ],
    },

    {
      key: 'unavailableRequested',
      kind: 'table',
      label: {
        en: 'Items customers asked for that we do not stock',
        ar: 'اصناف طلبها العملاء وغير متوفرة لدينا',
        fa: 'اقلامی که مشتریان خواستند و موجود نداریم',
      },
      // Deliberately free text first: the whole point of this row is a stone
      // the catalogue does NOT have, so a variety picker cannot be required.
      // The optional picker is there for the near-miss case ("we have it, but
      // not in that size").
      columns: [
        {
          key: 'description', type: 'text', width: 3,
          label: { en: 'What was asked for', ar: 'الصنف المطلوب', fa: 'قلم درخواستی' },
        },
        { key: 'customer', type: 'customer', width: 2, label: { en: 'Customer', ar: 'العميل', fa: 'مشتری' } },
        {
          key: 'closestVariety', type: 'variety', width: 2, allowText: true,
          label: { en: 'Closest variety we carry', ar: 'أقرب صنف لدينا', fa: 'نزدیک‌ترین نوع موجود' },
        },
        { key: 'notes', type: 'text', width: 2, label: { en: 'Notes', ar: 'ملاحظات', fa: 'یادداشت‌ها' } },
      ],
    },

    {
      key: 'contentShared',
      kind: 'table',
      label: {
        en: 'Content shared today',
        ar: 'المحتوى الذي تمت مشاركته اليوم',
        fa: 'محتوای منتشرشده امروز',
      },
      columns: [
        {
          key: 'content', type: 'dmContent', width: 3,
          label: { en: 'Content', ar: 'المحتوى', fa: 'محتوا' },
        },
        { key: 'sentTo', type: 'recipient', width: 2, label: { en: 'Sent to', ar: 'أُرسل إلى', fa: 'ارسال به' } },
        { key: 'notes', type: 'text', width: 3, label: { en: 'Notes', ar: 'ملاحظات', fa: 'یادداشت‌ها' } },
      ],
    },

    {
      key: 'notes',
      kind: 'fields',
      label: { en: "Representative's notes", ar: 'ملاحظات المندوب', fa: 'یادداشت‌های نماینده' },
      fields: [
        {
          key: 'body', type: 'textarea', rows: 5, bind: 'body',
          label: { en: 'Notes', ar: 'ملاحظات', fa: 'یادداشت‌ها' },
        },
      ],
    },
  ],
};

const TEMPLATES = { classic, salesperson };

// An unknown key is never an error — it falls back, so a role carrying a
// template that was later removed keeps working instead of breaking its
// holders' ability to file a report at all.
function resolveJobReportTemplate(key) {
  return TEMPLATES[key] || TEMPLATES[DEFAULT_TEMPLATE];
}

function isKnownTemplate(key) {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, key);
}

// The catalog the role form's selector and the report form both read.
function listJobReportTemplates() {
  return Object.values(TEMPLATES).map((tpl) => ({
    key: tpl.key, label: tpl.label, description: tpl.description,
  }));
}

// The `lines` column of a table section, if it has one (at most one per section).
const linesColumnOf = (section) => (section.columns || []).find((c) => c.type === 'lines') || null;

// A row filed BEFORE a column became a list holds that list's fields on the row itself ({variety, quantity,
// unitPrice} instead of {items: [{variety, quantity, unitPrice}]}). Read as the one-entry list it always was, so an
// old report prints and opens exactly as it did and a stale form posting the old shape is not lost.
function liftLegacyRow(section, row) {
  if (!row || typeof row !== 'object') return row;
  const lines = linesColumnOf(section);
  if (!lines || Array.isArray(row[lines.key])) return row;
  const item = {};
  let any = false;
  const next = { ...row };
  (lines.columns || []).forEach((c) => {
    if (c.computed) return;
    const v = row[c.key];
    item[c.key] = v === undefined ? null : v;
    delete next[c.key];
    const filled = v != null && v !== '' && !(typeof v === 'object' && !Object.values(v).some((x) => x != null && x !== ''));
    if (filled) any = true;
  });
  next[lines.key] = any ? [item] : [];
  return next;
}

// Flat walk over every field in a template, whichever kind of section holds
// it — used by the save path and the printer so neither has to know the
// difference between a fields section and a table's columns.
function eachField(tpl, fn) {
  (tpl.sections || []).forEach((section) => {
    const fields = section.kind === 'table' ? (section.columns || []) : (section.fields || []);
    fields.forEach((field) => fn(field, section));
  });
}

// Pick a label in the requested language, falling back to English and then to
// the key itself — a template is never allowed to render a blank header.
function pickLabel(label, lang) {
  if (!label) return '';
  if (typeof label === 'string') return label;
  return label[lang] || label.en || '';
}

module.exports = {
  TEMPLATES, LANGS, DEFAULT_TEMPLATE,
  SOCIAL_CHANNELS, CHANNEL_VALUES, channelByValue,
  resolveJobReportTemplate, isKnownTemplate, listJobReportTemplates,
  eachField, pickLabel, linesColumnOf, liftLegacyRow,
};
