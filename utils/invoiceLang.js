// Phase 6+ — label dictionaries for the 3 selectable PDF template languages.
// Arabic keeps the legally-worded tax-invoice phrasing; English/Farsi are direct
// working translations of the same labels (not re-litigated per-field legal text).
const LANG = {
  ar: {
    dir: 'rtl',
    invoiceTitle: 'فاتورة مبيعات ضريبية', invoiceTitleSub: 'TAX INVOICE',
    quoteTitle: 'عرض سعر', quoteTitleSub: 'QUOTATION',
    docNumber: 'رقم السند', date: 'التاريخ', printDate: 'تاريخ الطباعة',
    billTo: 'السيد / السادة', trn: 'ب.ضـ', country: 'الدولة', phone: 'الهاتف', address: 'العنوان',
    col_no: 'م', col_code: 'الرمز', col_item: 'الصنف', col_unit: 'الوحدة',
    col_qty: 'الكمية', col_price: 'السعر', col_disc: 'الخصم', col_discOffer: 'الخصم % العرض',
    col_vat: 'الضريبة', col_total: 'المجموع',
    subtotal: 'الاجمالي', discount: 'الخصم', vat: 'الضريبة', shipping: 'مصاريف الشحن', grandTotal: 'المطلوب',
    cash: 'نقدي', chequeBank: 'شيك / بنك', card: 'بطاقة مدفوعات', remaining: 'الباقي',
    currentBalance: 'الرصيد الحالي', credit: 'دائن', debit: 'مدين',
    amountInWords: 'المبلغ بالحروف', salesRep: 'مسؤول المبيعات',
    validity: (n) => `هذا العرض ساري لمدة ${n} يوم من تاريخه.`,
    bankDetails: 'التفاصيل البنكية',
    packingList: 'قائمة التعبئة', packingListSub: 'PACKING LIST', forDoc: 'سند رقم',
    pl_pallet: 'طبلية', pl_product: 'الصنف', pl_length: 'الطول', pl_width: 'العرض',
    pl_pcs: 'عدد', pl_thickness: 'السماكة', pl_sqm: 'م²', pl_notes: 'ملاحظات', total: 'الاجمالي',
    truckNumber: 'رقم الشاحنة', driverName: 'اسم السائق', driverMobile: 'رقم الموبايل',
  },
  en: {
    dir: 'ltr',
    invoiceTitle: 'TAX INVOICE', invoiceTitleSub: 'فاتورة مبيعات ضريبية',
    quoteTitle: 'QUOTATION', quoteTitleSub: 'عرض سعر',
    docNumber: 'Document No.', date: 'Date', printDate: 'Print date',
    billTo: 'Bill to', trn: 'TRN', country: 'Country', phone: 'Phone', address: 'Address',
    col_no: 'No', col_code: 'Code', col_item: 'Item', col_unit: 'Unit',
    col_qty: 'Qty', col_price: 'Price', col_disc: 'Disc.', col_discOffer: 'Offer disc. %',
    col_vat: 'VAT', col_total: 'Total',
    subtotal: 'Subtotal', discount: 'Discount', vat: 'VAT', shipping: 'Shipping', grandTotal: 'Amount due',
    cash: 'Cash', chequeBank: 'Cheque / Bank', card: 'Card', remaining: 'Remaining',
    currentBalance: 'Current balance', credit: 'Credit', debit: 'Debit',
    amountInWords: 'Amount in words', salesRep: 'Sales representative',
    validity: (n) => `This quotation is valid for ${n} days from its date.`,
    bankDetails: 'Bank details',
    packingList: 'PACKING LIST', packingListSub: 'قائمة التعبئة', forDoc: 'Document no.',
    pl_pallet: 'Pallet', pl_product: 'Product', pl_length: 'L', pl_width: 'W',
    pl_pcs: 'Pcs', pl_thickness: 'T', pl_sqm: 'Sqm', pl_notes: 'Notes', total: 'Total',
    truckNumber: 'Truck no.', driverName: 'Driver name', driverMobile: 'Driver mobile',
  },
  fa: {
    dir: 'rtl',
    invoiceTitle: 'فاکتور فروش مالیاتی', invoiceTitleSub: 'TAX INVOICE',
    quoteTitle: 'پیش‌فاکتور', quoteTitleSub: 'QUOTATION',
    docNumber: 'شماره سند', date: 'تاریخ', printDate: 'تاریخ چاپ',
    billTo: 'خریدار', trn: 'شناسه مالیاتی', country: 'کشور', phone: 'تلفن', address: 'آدرس',
    col_no: 'ردیف', col_code: 'کد کالا', col_item: 'شرح کالا', col_unit: 'واحد',
    col_qty: 'مقدار', col_price: 'قیمت واحد', col_disc: 'تخفیف', col_discOffer: 'درصد تخفیف',
    col_vat: 'مالیات', col_total: 'مبلغ کل',
    subtotal: 'جمع کل', discount: 'تخفیف', vat: 'مالیات بر ارزش افزوده', shipping: 'هزینه حمل', grandTotal: 'مبلغ قابل پرداخت',
    cash: 'نقدی', chequeBank: 'چک / بانک', card: 'کارتخوان', remaining: 'باقیمانده',
    currentBalance: 'مانده حساب', credit: 'بستانکار', debit: 'بدهکار',
    amountInWords: 'مبلغ به حروف', salesRep: 'مسئول فروش',
    validity: (n) => `این پیش‌فاکتور به مدت ${n} روز از تاریخ صدور اعتبار دارد.`,
    bankDetails: 'اطلاعات بانکی',
    packingList: 'لیست بسته‌بندی', packingListSub: 'PACKING LIST', forDoc: 'سند شماره',
    pl_pallet: 'پالت', pl_product: 'کالا', pl_length: 'طول', pl_width: 'عرض',
    pl_pcs: 'تعداد', pl_thickness: 'ضخامت', pl_sqm: 'متر مربع', pl_notes: 'یادداشت', total: 'جمع',
    truckNumber: 'شماره کامیون', driverName: 'نام راننده', driverMobile: 'موبایل راننده',
  },
};

const SUPPORTED_LANGS = Object.keys(LANG);
const DEFAULT_LANG = 'ar';

function resolveLang(lang) {
  return SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
}

module.exports = { LANG, SUPPORTED_LANGS, DEFAULT_LANG, resolveLang };
