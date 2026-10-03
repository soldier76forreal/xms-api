/**
 * Demo/test data seeder for the Isfahan branch.
 *
 * Creates a realistic, self-consistent slice of MIS data so the Session 72+1
 * features (invoices, quotations, packing lists, per-pallet labels) can be
 * clicked through end to end:
 *
 *   3 Inventory products (+ 8 variants)  - line items need real stock to point at
 *   3 CRM customers                      - invoice/quotation customer blocks
 *   3 Quotations (pre_invoice)           - draft / sent / accepted
 *   3 Invoices                           - issued / partially_paid / paid
 *   3 Packing lists                      - 2 linked to invoices, 1 free
 *   + invoiceActivity / packingListActivity rows so the Activity tabs aren't empty
 *
 * Every document gets a DETERMINISTIC _id from the DEMO_PREFIX below, so
 * `--undo` removes exactly what this script created and nothing else.
 *
 * Usage (from api/):
 *   node scripts/seedIsfahanDemoData.js                 # dry run - prints the plan
 *   node scripts/seedIsfahanDemoData.js --yes           # apply
 *   node scripts/seedIsfahanDemoData.js --undo --yes    # remove everything it made
 */

const mongoose = require('mongoose');
require('dotenv').config();

const { parseStoneCode }      = require('../utils/stoneCodeParser');
const { amountToArabicWords } = require('../utils/arabicWords');

const APPLY = process.argv.includes('--yes');
const UNDO  = process.argv.includes('--undo');

// All demo ids start with this, so undo is exact and can never touch real data.
const DEMO_PREFIX = 'dee0';
let idCounter = 0;
function demoId(tag) {
  idCounter += 1;
  const body = (tag + '0'.repeat(16)).slice(0, 16);
  const hex = Buffer.from(body, 'utf8').toString('hex').slice(0, 16);
  return new mongoose.Types.ObjectId(DEMO_PREFIX + hex + String(idCounter).padStart(4, '0'));
}

const ISFAHAN_NAME = 'Isfahan';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// -- content -----------------------------------------------------------------

// Isfahan is a processing/supplying branch - travertine and cream marble.
const PRODUCTS = [
  {
    tag: 'prodMA17', code: 'MA17', stoneType: 'MA', quarryCode: '17',
    name: 'Cream Marfil Ahrar Q', stoneTypeName: 'Marble', defaultUnit: 'M2',
    variants: [
      { tag: 'varA1', code: 'MA17Q06003018VFP', qty: 486.5, price: 82 },
      { tag: 'varA2', code: 'MA17Q08004020VFP', qty: 312.75, price: 95 },
      { tag: 'varA3', code: 'MA17Q00000020',    qty: 148.0,  price: 110 },
    ],
  },
  {
    tag: 'prodTR09', code: 'TR09', stoneType: 'TR', quarryCode: '09',
    name: 'Travertine Croscat Q', stoneTypeName: 'Travertine', defaultUnit: 'M2',
    variants: [
      { tag: 'varB1', code: 'TR09Q10004018CFP', qty: 642.3, price: 74 },
      { tag: 'varB2', code: 'TR09W06003018CUH', qty: 208.9, price: 58 },
      { tag: 'varB3', code: 'TR09Q00000030',    qty: 96.4,  price: 128 },
    ],
  },
  {
    tag: 'prodMA01', code: 'MA01', stoneType: 'MA', quarryCode: '01',
    name: 'Armani Grey W', stoneTypeName: 'Marble', defaultUnit: 'M2',
    variants: [
      { tag: 'varC1', code: 'MA01W12006020VFP', qty: 274.6, price: 138 },
      { tag: 'varC2', code: 'MA01W00000020',    qty: 187.2, price: 152 },
    ],
  },
];

const CUSTOMERS = [
  {
    tag: 'custAlwan', type: 'company',
    companyName: 'Al Wan Stone Trading LLC', contactPerson: 'Khalid Al Wan',
    phone: '971504418823', trn: '100428837600003', country: 'United Arab Emirates',
    city: 'Sharjah', street: 'Industrial Area 12, Warehouse 7',
  },
  {
    tag: 'custNaseem', type: 'company',
    companyName: 'Naseem Marble Works', contactPerson: 'Yusuf Naseem',
    phone: '966553380914', trn: '310277409500003', country: 'Saudi Arabia',
    city: 'Dammam', street: 'King Fahd Industrial Road, Block 4',
  },
  {
    tag: 'custBarati', type: 'individual',
    firstName: 'Reza', lastName: 'Barati',
    phone: '989131147705', trn: '', country: 'Iran',
    city: 'Isfahan', street: 'Shahid Montazeri Blvd, No. 214',
  },
];

// -- main --------------------------------------------------------------------

(async () => {
  await mongoose.connect(process.env.DB_CONNECT);
  const db = mongoose.connection.db;
  const C = {
    products:  db.collection('inventoryproducts'),
    variants:  db.collection('inventoryvariants'),
    customers: db.collection('customers'),
    invoices:  db.collection('misinvoices'),
    invAct:    db.collection('invoiceactivities'),
    packing:   db.collection('mispackinglists'),
    packAct:   db.collection('mispackinglistactivities'),
    counters:  db.collection('invoicecounters'),
    branches:  db.collection('branches'),
    users:     db.collection('users'),
  };

  const branch = await C.branches.findOne({ name: ISFAHAN_NAME });
  if (!branch) throw new Error('Branch "' + ISFAHAN_NAME + '" not found');
  const branchId = branch._id;

  if (UNDO) {
    console.log('Removing demo data (ids starting ' + DEMO_PREFIX + ') from ' + ISFAHAN_NAME + '...\n');
    const re = new RegExp('^' + DEMO_PREFIX);
    const targets = [
      ['inventoryproducts', C.products], ['inventoryvariants', C.variants],
      ['customers', C.customers], ['misinvoices', C.invoices],
      ['invoiceactivities', C.invAct], ['mispackinglists', C.packing],
      ['mispackinglistactivities', C.packAct],
    ];
    for (const [name, col] of targets) {
      const docs = await col.find({}).project({ _id: 1 }).toArray();
      const ids = docs.map((d) => d._id).filter((id) => re.test(id.toString()));
      if (!ids.length) { console.log('  ' + name + ': nothing to remove'); continue; }
      if (APPLY) {
        const r = await col.deleteMany({ _id: { $in: ids } });
        console.log('  ' + name + ': deleted ' + r.deletedCount);
      } else {
        console.log('  ' + name + ': would delete ' + ids.length);
      }
    }
    if (APPLY) {
      await C.counters.deleteMany({ branchId });
      console.log('  invoicecounters: reset for Isfahan');
    } else {
      console.log('  invoicecounters: would reset for Isfahan');
    }
    console.log(APPLY ? '\nDone.' : '\nDRY RUN - re-run with --undo --yes to apply.');
    await mongoose.disconnect();
    return;
  }

  const actor = await C.users.findOne({});
  const actorId = actor ? actor._id : null;
  const actorName = actor ? ((actor.firstName || '') + ' ' + (actor.lastName || '')).trim() : 'System';
  const now = new Date();
  const daysAgo = (n) => new Date(now.getTime() - n * 864e5);

  // -- 1. Inventory ----------------------------------------------------------
  const productDocs = [], variantDocs = [], byTag = {};
  for (const p of PRODUCTS) {
    const pid = demoId(p.tag);
    const totalsByUnit = {};
    const mine = [];
    for (const v of p.variants) {
      const spec = parseStoneCode(v.code);
      const vid = demoId(v.tag);
      const doc = {
        _id: vid, productId: pid, branchId, code: v.code.toUpperCase(),
        spec, categories: [], unit: p.defaultUnit,
        quantity: v.qty, price: v.price, currency: 'AED',
        status: 'active', insertDate: daysAgo(40), updateDate: daysAgo(6),
        deleteDate: null, createdBy: actorId, updatedBy: actorId,
      };
      variantDocs.push(doc);
      mine.push(doc);
      byTag[v.tag] = Object.assign({}, doc, { productName: p.name });
      totalsByUnit[p.defaultUnit] = round2((totalsByUnit[p.defaultUnit] || 0) + v.qty);
    }
    const prices = mine.map((v) => v.price);
    productDocs.push({
      _id: pid, branchId, code: p.code, name: p.name,
      stoneType: p.stoneType, stoneTypeName: p.stoneTypeName, quarryCode: p.quarryCode,
      nameFa: '', descriptionAr: '', descriptionFa: '',
      defaultUnit: p.defaultUnit, status: 'active',
      variantCount: mine.length, totalsByUnit,
      priceRange: { min: Math.min.apply(null, prices), max: Math.max.apply(null, prices), currency: 'AED' },
      coverMediaId: null, coverThumbnail: null,
      website: { published: false, tags: [], seo: { metaTitle: '', metaDescriptionAr: '' } },
      insertDate: daysAgo(40), updateDate: daysAgo(6), deleteDate: null,
      createdBy: actorId, updatedBy: actorId,
    });
    byTag[p.tag] = { _id: pid, code: p.code, name: p.name };
  }

  // -- 2. Customers ----------------------------------------------------------
  const customerDocs = [];
  for (const c of CUSTOMERS) {
    const cid = demoId(c.tag);
    const displayName = c.type === 'company' ? c.companyName : (c.firstName + ' ' + c.lastName);
    customerDocs.push({
      _id: cid,
      personalInformation: {
        personOrCompany: c.type, customerType: c.type,
        firstName: c.firstName || '', lastName: c.lastName || '',
        companyName: c.companyName || '', contactPerson: c.contactPerson || '',
        country: c.country, attractedBy: 'Exhibition', favoriteProducts: [],
      },
      contactInfo: { phoneNumbers: [], emails: [], instagrams: [], linkedIns: [], websites: [], botims: [], facebooks: [] },
      phoneNumber: c.phone, trn: c.trn,
      commChannels: ['whatsApp'], commHandles: { whatsApp: c.phone },
      address: [{ country: c.country, city: c.city, province: '', street: c.street, postalCode: '' }],
      status: 'active', tags: [], assignedTo: [], interestedProducts: [],
      frequentBtnClick: [], communication: [], explanations: '',
      owner: actorId, createdBy: actorId,
      insertDate: daysAgo(35), updateDate: daysAgo(4), lastCallAt: daysAgo(4),
      deleteDate: null,
    });
    byTag[c.tag] = {
      _id: cid, name: displayName, trn: c.trn, country: c.country,
      phone: c.phone, address: c.street + ', ' + c.city + ', ' + c.country,
    };
  }

  // -- 3. Invoices + quotations ----------------------------------------------
  function buildLine(varTag, quantity, unitPrice, opts) {
    opts = opts || {};
    const v = byTag[varTag];
    const discount = opts.discount || 0;
    const discountType = opts.discountType || 'amount';
    const vatRate = opts.vatRate === undefined ? 5 : opts.vatRate;
    const base = round2(quantity * unitPrice);
    const discountAmount = discountType === 'percent' ? round2(base * discount / 100) : round2(discount);
    const vatAmount = round2((base - discountAmount) * vatRate / 100);
    return {
      productId: v.productId, variantId: v._id, code: v.code, name: v.productName,
      unit: v.unit, quantity, unitPrice, discount, discountType, vatRate, vatAmount,
      lineTotal: round2(base - discountAmount + vatAmount),
      sourceType: 'inventory',
      _base: base, _discountAmount: discountAmount,
    };
  }
  function totalsOf(lines, shipping) {
    let subtotal = 0, discountTotal = 0, vatTotal = 0;
    for (const l of lines) { subtotal += l._base; discountTotal += l._discountAmount; vatTotal += l.vatAmount; }
    subtotal = round2(subtotal); discountTotal = round2(discountTotal); vatTotal = round2(vatTotal);
    const ship = round2(shipping || 0);
    return {
      subtotal, discountTotal, vatTotal, shipping: ship,
      grandTotal: round2(subtotal - discountTotal + vatTotal + ship),
    };
  }
  const strip = (lines) => lines.map((l) => {
    const copy = Object.assign({}, l);
    delete copy._base; delete copy._discountAmount;
    return copy;
  });
  const custSnap = (tag) => {
    const c = byTag[tag];
    return { name: c.name, trn: c.trn, country: c.country, phone: c.phone, address: c.address };
  };
  const emptyPayment = { cash: 0, chequeBank: 0, card: 0, remaining: 0, currentBalance: 0, balanceSign: 'debit' };

  const invoiceDocs = [], activityDocs = [];
  function pushDoc(doc, extraActivity) {
    invoiceDocs.push(doc);
    activityDocs.push({
      _id: demoId('act' + doc.docNumber + doc.docType.slice(0, 3)),
      invoiceId: doc._id, docType: doc.docType, type: 'created',
      body: (doc.docType === 'invoice' ? 'Invoice' : 'Quotation') + ' #' + doc.docNumber + ' created',
      actorId, actorName, date: doc.insertDate, createdAt: doc.insertDate,
    });
    for (const a of (extraActivity || [])) {
      activityDocs.push(Object.assign({
        _id: demoId(a.tag), invoiceId: doc._id, docType: doc.docType,
        actorId, actorName, date: a.date, createdAt: a.date,
      }, a.fields));
    }
  }

  // - Quotations (pre_invoice) x3 -
  const q1Lines = [buildLine('varA1', 240, 82), buildLine('varA2', 120, 95)];
  pushDoc({
    _id: demoId('quote1'), branchId, docType: 'pre_invoice', docNumber: 1,
    tradeMode: 'customer', status: 'draft', issueDate: daysAgo(12),
    customerId: byTag.custAlwan._id, customerSnapshot: custSnap('custAlwan'),
    lineItems: strip(q1Lines), currency: 'AED',
    ...totalsOf(q1Lines),
    validityDays: 15, notes: 'Prices quoted ex-works Isfahan. Crating included.',
    payment: Object.assign({}, emptyPayment), packingList: { rows: [] },
    stockDecremented: false, assignedTo: [],
    insertDate: daysAgo(12), deleteDate: null, createdBy: actorId,
  });

  const q2Lines = [
    buildLine('varB1', 520, 74, { discount: 5, discountType: 'percent' }),
    buildLine('varB2', 180, 58),
  ];
  pushDoc({
    _id: demoId('quote2'), branchId, docType: 'pre_invoice', docNumber: 2,
    tradeMode: 'customer', status: 'sent', issueDate: daysAgo(8),
    customerId: byTag.custNaseem._id, customerSnapshot: custSnap('custNaseem'),
    lineItems: strip(q2Lines), currency: 'AED',
    ...totalsOf(q2Lines),
    validityDays: 30, notes: '5% volume discount applied on Croscat 100x40.',
    payment: Object.assign({}, emptyPayment), packingList: { rows: [] },
    stockDecremented: false, assignedTo: [],
    insertDate: daysAgo(8), updateDate: daysAgo(7), deleteDate: null,
    createdBy: actorId, updatedBy: actorId,
  }, [
    { tag: 'q2sent', date: daysAgo(7), fields: { type: 'status', field: 'status', oldValue: 'draft', newValue: 'sent' } },
  ]);

  const q3Lines = [buildLine('varC1', 96, 138), buildLine('varC2', 60, 152)];
  pushDoc({
    _id: demoId('quote3'), branchId, docType: 'pre_invoice', docNumber: 3,
    tradeMode: 'customer', status: 'accepted', issueDate: daysAgo(5),
    customerId: byTag.custBarati._id, customerSnapshot: custSnap('custBarati'),
    lineItems: strip(q3Lines), currency: 'AED',
    ...totalsOf(q3Lines),
    validityDays: 10, notes: 'Client confirmed by phone; awaiting deposit.',
    payment: Object.assign({}, emptyPayment), packingList: { rows: [] },
    stockDecremented: false, assignedTo: [],
    insertDate: daysAgo(5), updateDate: daysAgo(2), deleteDate: null,
    createdBy: actorId, updatedBy: actorId,
  }, [
    { tag: 'q3sent', date: daysAgo(4), fields: { type: 'status', field: 'status', oldValue: 'draft', newValue: 'sent' } },
    { tag: 'q3acc',  date: daysAgo(2), fields: { type: 'status', field: 'status', oldValue: 'sent', newValue: 'accepted' } },
  ]);

  // - Invoices x3 -
  const i1Lines = [buildLine('varA1', 186.5, 82), buildLine('varA3', 42, 110)];
  const i1Tot = totalsOf(i1Lines, 850);
  pushDoc(Object.assign({
    _id: demoId('inv1'), branchId, docType: 'invoice', docNumber: 1,
    tradeMode: 'customer', status: 'issued', issueDate: daysAgo(10), issueTime: '09:40',
    customerId: byTag.custAlwan._id, customerSnapshot: custSnap('custAlwan'),
    lineItems: strip(i1Lines), currency: 'AED',
  }, i1Tot, {
    amountInWords: amountToArabicWords(i1Tot.grandTotal, 'AED'),
    salesRepId: actorId, salesRepName: actorName,
    payment: {
      cash: 0, chequeBank: 0, card: 0, remaining: i1Tot.grandTotal,
      currentBalance: i1Tot.grandTotal, balanceSign: 'debit',
    },
    packingList: { rows: [] }, stockDecremented: false, assignedTo: [],
    notes: 'Delivery to Sharjah warehouse. Freight billed separately.',
    insertDate: daysAgo(10), deleteDate: null, createdBy: actorId,
  }), [
    { tag: 'i1iss', date: daysAgo(10), fields: { type: 'status', field: 'status', oldValue: 'draft', newValue: 'issued' } },
  ]);

  const i2Lines = [buildLine('varB1', 310, 74), buildLine('varB3', 28, 128)];
  const i2Tot = totalsOf(i2Lines, 1200);
  const i2Paid = 15000;
  pushDoc(Object.assign({
    _id: demoId('inv2'), branchId, docType: 'invoice', docNumber: 2,
    tradeMode: 'customer', status: 'partially_paid', issueDate: daysAgo(6), issueTime: '14:05',
    customerId: byTag.custNaseem._id, customerSnapshot: custSnap('custNaseem'),
    lineItems: strip(i2Lines), currency: 'AED',
  }, i2Tot, {
    amountInWords: amountToArabicWords(i2Tot.grandTotal, 'AED'),
    salesRepId: actorId, salesRepName: actorName,
    payment: {
      cash: 5000, chequeBank: 10000, card: 0,
      remaining: round2(i2Tot.grandTotal - i2Paid),
      currentBalance: round2(i2Tot.grandTotal - i2Paid), balanceSign: 'debit',
    },
    packingList: { rows: [] }, stockDecremented: false, assignedTo: [],
    notes: 'Balance due on collection.',
    insertDate: daysAgo(6), updateDate: daysAgo(3), deleteDate: null,
    createdBy: actorId, updatedBy: actorId,
  }), [
    { tag: 'i2iss', date: daysAgo(6), fields: { type: 'status', field: 'status', oldValue: 'draft', newValue: 'issued' } },
    { tag: 'i2pay', date: daysAgo(3), fields: { type: 'payment', body: 'Payment recorded: 5,000 cash + 10,000 cheque' } },
  ]);

  const i3Lines = [buildLine('varC1', 78, 138), buildLine('varC2', 34.5, 152)];
  const i3Tot = totalsOf(i3Lines, 0);
  pushDoc(Object.assign({
    _id: demoId('inv3'), branchId, docType: 'invoice', docNumber: 3,
    tradeMode: 'customer', status: 'paid', issueDate: daysAgo(3), issueTime: '11:20',
    customerId: byTag.custBarati._id, customerSnapshot: custSnap('custBarati'),
    lineItems: strip(i3Lines), currency: 'AED',
  }, i3Tot, {
    amountInWords: amountToArabicWords(i3Tot.grandTotal, 'AED'),
    salesRepId: actorId, salesRepName: actorName,
    payment: {
      cash: 0, chequeBank: i3Tot.grandTotal, card: 0, remaining: 0,
      currentBalance: 0, balanceSign: 'credit',
    },
    packingList: { rows: [] }, stockDecremented: false, assignedTo: [],
    notes: 'Paid in full by bank transfer.',
    insertDate: daysAgo(3), updateDate: daysAgo(1), deleteDate: null,
    createdBy: actorId, updatedBy: actorId,
  }), [
    { tag: 'i3iss', date: daysAgo(3), fields: { type: 'status', field: 'status', oldValue: 'draft', newValue: 'issued' } },
    { tag: 'i3pay', date: daysAgo(1), fields: { type: 'payment', body: 'Paid in full by bank transfer' } },
    { tag: 'i3pd',  date: daysAgo(1), fields: { type: 'status', field: 'status', oldValue: 'issued', newValue: 'paid' } },
  ]);

  const invByKey = {};
  for (const d of invoiceDocs) invByKey[d.docNumber + d.docType] = d;

  // -- 4. Packing lists ------------------------------------------------------
  // 'linked' item codes must product-code-prefix-match a line on the linked
  // invoice (findOutOfScopeCodes) - MA17 / TR09 / MA01 below all do.
  const sqm = (l, w, pcs) => round2((l / 100) * (w / 100) * pcs);
  function palletTotals(pallets) {
    let s = 0, p = 0;
    for (const pl of pallets) for (const it of pl.items) { s += it.sqm; p += it.pcs; }
    return { totalPallets: pallets.length, totalSqm: round2(s), totalPcs: p };
  }

  const packingDocs = [], packActDocs = [];
  function pushPacking(doc) {
    packingDocs.push(doc);
    packActDocs.push({
      _id: demoId('pact' + doc.docNumber), packingListId: doc._id, type: 'created',
      body: 'Packing list #' + doc.docNumber + ' created',
      actorId, actorName, date: doc.insertDate, createdAt: doc.insertDate,
    });
  }

  const pl1Pallets = [
    {
      palletId: 'P1', reference: '00812', productCode: 'MA17', processingType: 'FLD (tile)',
      items: [
        { code: 'MA17Q06003018VFP', lengthCm: 60, widthCm: 30, thicknessCm: 1.8, pcs: 240, sqm: sqm(60, 30, 240) },
        { code: 'MA17Q06003018VFP', lengthCm: 60, widthCm: 30, thicknessCm: 1.8, pcs: 180, sqm: sqm(60, 30, 180) },
      ],
    },
    {
      palletId: 'P2', reference: '00813', productCode: 'MA17', processingType: 'UNFLD (slab)',
      items: [
        { code: 'MA17Q00000020', lengthCm: 240, widthCm: 170, thicknessCm: 2, pcs: 6, sqm: sqm(240, 170, 6) },
        { code: 'MA17Q00000020', lengthCm: 228, widthCm: 165, thicknessCm: 2, pcs: 4, sqm: sqm(228, 165, 4) },
      ],
    },
  ];
  pushPacking({
    _id: demoId('pack1'), branchId, docNumber: 1, type: 'linked',
    invoiceIds: [invByKey['1invoice']._id], productId: byTag.prodMA17._id,
    driverInfo: {
      fullName: 'Hassan Jafari', nationalId: '1272884519', smartNumber: 'SM-448127',
      phone: '989133218844', iban: 'IR330170000000212648339001',
    },
    vehicleInfo: { trailerPlateNumber: '53 T 419 IR 13', trailerSmartNumber: 'TR-902318' },
    customsAgent: { name: 'Bandar Abbas Customs - M. Rasouli', phone: '989171204466' },
    loadingOfficer: { name: 'Mehdi Karimi', phone: '989132277019' },
    originAddress: 'Isfahan Stone Processing Plant, Km 18 Isfahan-Najafabad Rd, Iran',
    destinationAddress: 'Al Wan Stone Trading LLC, Industrial Area 12, Warehouse 7, Sharjah, UAE',
    shippingDestination: 'Sharjah, UAE (via Bandar Abbas)',
    standardThicknessCm: 1.8,
    pallets: pl1Pallets, totals: palletTotals(pl1Pallets),
    status: 'final', notes: 'Loaded and sealed. Seal no. 41827.',
    insertDate: daysAgo(9), updateDate: daysAgo(9), deleteDate: null,
    createdBy: actorId, updatedBy: actorId,
  });

  const pl2Pallets = [
    {
      palletId: 'P1', reference: '00901', productCode: 'TR09', processingType: 'CRSCT (tile)',
      items: [
        { code: 'TR09Q10004018CFP', lengthCm: 100, widthCm: 40, thicknessCm: 1.8, pcs: 160, sqm: sqm(100, 40, 160) },
      ],
    },
    {
      palletId: 'P2', reference: '00902', productCode: 'TR09', processingType: 'CRSCT (tile)',
      items: [
        { code: 'TR09Q10004018CFP', lengthCm: 100, widthCm: 40, thicknessCm: 1.8, pcs: 155, sqm: sqm(100, 40, 155) },
      ],
    },
    {
      palletId: 'P3', reference: '00903', productCode: 'TR09', processingType: 'UNFLD (slab)',
      items: [
        { code: 'TR09Q00000030', lengthCm: 260, widthCm: 150, thicknessCm: 3, pcs: 5, sqm: sqm(260, 150, 5) },
        { code: 'TR09Q00000030', lengthCm: 245, widthCm: 142, thicknessCm: 3, pcs: 3, sqm: sqm(245, 142, 3) },
      ],
    },
  ];
  pushPacking({
    _id: demoId('pack2'), branchId, docNumber: 2, type: 'linked',
    invoiceIds: [invByKey['2invoice']._id], productId: byTag.prodTR09._id,
    driverInfo: {
      fullName: 'Ali Sabbagh', nationalId: '0069441238', smartNumber: 'SM-551903',
      phone: '989127714402', iban: 'IR620540000000318877420002',
    },
    vehicleInfo: { trailerPlateNumber: '77 E 286 IR 53', trailerSmartNumber: 'TR-771540' },
    customsAgent: { name: 'Shalamcheh Border - A. Dehghan', phone: '989163302288' },
    loadingOfficer: { name: 'Saeed Tavakoli', phone: '989131884471' },
    originAddress: 'Isfahan Stone Processing Plant, Km 18 Isfahan-Najafabad Rd, Iran',
    destinationAddress: 'Naseem Marble Works, King Fahd Industrial Road, Block 4, Dammam, KSA',
    shippingDestination: 'Dammam, Saudi Arabia (via Shalamcheh)',
    standardThicknessCm: 1.8,
    pallets: pl2Pallets, totals: palletTotals(pl2Pallets),
    status: 'final', notes: 'Three pallets, mixed tile and slab. Seal no. 41903.',
    insertDate: daysAgo(5), updateDate: daysAgo(5), deleteDate: null,
    createdBy: actorId, updatedBy: actorId,
  });

  const pl3Pallets = [
    {
      palletId: 'P1', reference: '01044', productCode: 'MA01', processingType: 'UNFLD (slab)',
      items: [
        { code: 'MA01W00000020', lengthCm: 250, widthCm: 160, thicknessCm: 2, pcs: 4, sqm: sqm(250, 160, 4) },
        { code: 'MA01W00000020', lengthCm: 238, widthCm: 155, thicknessCm: 2, pcs: 3, sqm: sqm(238, 155, 3) },
      ],
    },
    {
      palletId: 'P2', reference: '01045', productCode: 'MA01', processingType: 'VNCT (tile)',
      items: [
        { code: 'MA01W12006020VFP', lengthCm: 120, widthCm: 60, thicknessCm: 2, pcs: 48, sqm: sqm(120, 60, 48) },
      ],
    },
  ];
  pushPacking({
    _id: demoId('pack3'), branchId, docNumber: 3, type: 'free',
    invoiceIds: [], productId: byTag.prodMA01._id,
    driverInfo: {
      fullName: 'Morteza Ahmadi', nationalId: '1288740033', smartNumber: 'SM-620114',
      phone: '989135540127', iban: 'IR180190000000229943811007',
    },
    vehicleInfo: { trailerPlateNumber: '21 B 704 IR 13', trailerSmartNumber: 'TR-618277' },
    customsAgent: { name: '', phone: '' },
    loadingOfficer: { name: 'Mehdi Karimi', phone: '989132277019' },
    originAddress: 'Isfahan Stone Processing Plant, Km 18 Isfahan-Najafabad Rd, Iran',
    destinationAddress: 'LMC Showroom - Tehran, Saadat Abad',
    shippingDestination: 'Tehran, Iran (internal transfer)',
    standardThicknessCm: 2,
    pallets: pl3Pallets, totals: palletTotals(pl3Pallets),
    status: 'draft', notes: 'Showroom sample shipment - not linked to an invoice.',
    insertDate: daysAgo(2), deleteDate: null, createdBy: actorId,
  });

  // -- report / write --------------------------------------------------------
  console.log('Branch: ' + ISFAHAN_NAME + ' (' + branchId + ')');
  console.log('Actor:  ' + actorName + ' (' + actorId + ')\n');
  console.log('Will create:');
  console.log('  inventoryproducts        ' + productDocs.length);
  console.log('  inventoryvariants        ' + variantDocs.length);
  console.log('  customers                ' + customerDocs.length);
  console.log('  misinvoices              ' + invoiceDocs.length + '  (3 quotations + 3 invoices)');
  console.log('  invoiceactivities        ' + activityDocs.length);
  console.log('  mispackinglists          ' + packingDocs.length + '  (2 linked + 1 free)');
  console.log('  mispackinglistactivities ' + packActDocs.length);
  console.log('\nDocuments:');
  for (const d of invoiceDocs) {
    console.log('  ' + (d.docType === 'invoice' ? 'INV ' : 'QUO ') + '#' + d.docNumber + '  ' +
      String(d.status).padEnd(15) + d.customerSnapshot.name.padEnd(28) +
      d.currency + ' ' + d.grandTotal.toLocaleString());
  }
  for (const d of packingDocs) {
    console.log('  PL  #' + d.docNumber + '  ' + d.type.padEnd(15) +
      d.totals.totalPallets + ' pallets, ' + d.totals.totalPcs + ' pcs, ' + d.totals.totalSqm + ' sqm');
  }

  if (!APPLY) {
    console.log('\nDRY RUN - nothing written. Re-run with --yes to apply.');
    await mongoose.disconnect();
    return;
  }

  await C.products.insertMany(productDocs);
  await C.variants.insertMany(variantDocs);
  await C.customers.insertMany(customerDocs);
  await C.invoices.insertMany(invoiceDocs);
  await C.invAct.insertMany(activityDocs);
  await C.packing.insertMany(packingDocs);
  await C.packAct.insertMany(packActDocs);

  // Counters must not rewind - park them past the demo numbers so the next
  // real document created in the UI gets #4, not a duplicate-key error.
  for (const docType of ['invoice', 'pre_invoice', 'packing_list']) {
    await C.counters.updateOne({ branchId, docType }, { $set: { seq: 3 } }, { upsert: true });
  }

  console.log('\nWritten. Counters for Isfahan parked at seq=3 (next doc is #4).');
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
