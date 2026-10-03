/**
 * seedTestDeployment.js — fills a fresh database for a TEST deployment of XMS
 * with a realistic, self-consistent working set:
 *
 *   catalog    the permission catalog + starter roles (from seedPermissions.js)
 *              and a "Branch Inventory Manager" role
 *   branches   Isfahan, KSA, Ahvaz, UAE. Isfahan shares its Inventory and
 *              Supply with KSA and Ahvaz (Branch.crossBranchAccess)
 *   profile    the company profile (scripts/launchData/companyprofiles.json)
 *   users      3 admins (superAdmin, every branch) and an inventory manager
 *              for each of Isfahan, KSA and Ahvaz
 *   crm        10 customers with some history
 *   inventory  Isfahan: a copy of the dev catalog (testSeedData/inventory.json).
 *              KSA and Ahvaz: a small starting stock of their own
 *   supply     5 Isfahan supply records (TR, MA, QU, ON, GR stone), 6 deal
 *              letters across every stage, follow-ups, a partial receive
 *   mis        Isfahan: 5 quotations + 5 invoices to customers. KSA and Ahvaz:
 *              their own invoice + quotation, and 8 stock requests to Isfahan
 *              (pending, priced, accepted, converted, declined)
 *   packing    10 Isfahan packing lists, 5 linked to invoices and 5 free
 *
 * Accepted quotations / requests and paid invoices have taken their quantities
 * out of stock, or out of their supply lot, the same way the app does it, with
 * the change-log and activity rows to show for it.
 *
 * Passwords are NOT in this file, only their bcrypt hashes. The passwords are
 * handed over with the deployment.
 *
 * It never deletes or overwrites anything, and it stops before writing if a
 * seed user's or seed customer's phone number, or stock in one of the seed
 * branches, is already in the database.
 *
 * Usage (from api/):
 *   node scripts/seedTestDeployment.js                          dry run on DB_CONNECT
 *   node scripts/seedTestDeployment.js --yes                    apply
 *   node scripts/seedTestDeployment.js --db "<mongodb uri>" --yes
 */
'use strict';

const path = require('path');
const fs = require('fs');

// ── arguments / environment ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--yes');
const dbAt = argv.indexOf('--db');
const DB_OVERRIDE = dbAt === -1 ? null : argv[dbAt + 1];
if (dbAt !== -1 && (!DB_OVERRIDE || DB_OVERRIDE.startsWith('--'))) {
  console.error('--db needs a MongoDB connection string, e.g. --db "mongodb://localhost:27017/xms_test"');
  process.exit(1);
}
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (DB_OVERRIDE) process.env.DB_CONNECT = DB_OVERRIDE;
if (!process.env.DB_CONNECT) {
  console.error('DB_CONNECT is not set. Put it in api/.env or pass --db "<mongodb uri>"');
  process.exit(1);
}

const mongoose = require('mongoose');
// A dry run leaves the database exactly as it found it, down to the empty
// collections and indexes Mongoose creates when it first compiles a model.
if (!APPLY) {
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
}

const { EJSON } = require('bson');
// The app's own connection and model names, so every write lands in exactly
// the collections the app reads, and the rollup helpers work on it too.
const dbConnection = require('../connections/xmsPr');
const { recomputeRollup } = require('../utils/inventoryRollup');
const { recomputeVariantSupplyRollup, recomputeProductSupplyRollup } = require('../utils/supplyRollup');
const { Sequence, formatCode } = require('../utils/sequence');
const { amountToArabicWords } = require('../utils/arabicWords');
const { PERMISSIONS, ROLES, ALL_KEYS } = require('./seedPermissions');

const model = (name, file) =>
  dbConnection.models[name] || dbConnection.model(name, require(`../models/${file}`));

const Permission               = model('permission', 'permissionModel');
const Role                     = model('role', 'roleModel');
const Branch                   = model('branch', 'branchModel');
const CompanyProfile           = model('companyProfile', 'companyProfileModel');
const User                     = model('user', 'userModel');
const UserAccess               = model('userAccess', 'userAccessModel');
const Customer                 = model('customer', 'customerModel');
const CustomerActivity         = model('customerActivity', 'customerActivityModel');
const InvProduct               = model('inventoryProduct', 'inventoryProductModel');
const InvVariant               = model('inventoryVariant', 'inventoryVariantModel');
const InvChangeLog             = model('inventoryChangeLog', 'inventoryChangeLogModel');
const SupplyRecord             = model('supplyRecord', 'supplyRecordModel');
const SupplyDealLetter         = model('supplyDealLetter', 'supplyDealLetterModel');
const SupplyDealLetterActivity = model('supplyDealLetterActivity', 'supplyDealLetterActivityModel');
const MisInvoice               = model('misInvoice', 'misInvoiceModel');
const InvoiceActivity          = model('invoiceActivity', 'invoiceActivityModel');
const InvoiceCounter           = model('invoiceCounter', 'invoiceCounterModel');
const MisPackingList           = model('misPackingList', 'misPackingListModel');
const MisPackingListActivity   = model('misPackingListActivity', 'misPackingListActivityModel');

// ── small helpers ───────────────────────────────────────────────────────────
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => parseFloat((Number(n) || 0).toFixed(4));
const oid = () => new mongoose.Types.ObjectId();
const NOW = new Date();
// N days ago at 09:00 + `minute` — the minute keeps several same-day events
// in their real order.
function daysAgo(n, minute = 0) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  d.setHours(9, 0, 0, 0);
  return new Date(d.getTime() + minute * 60000);
}
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const productPrefix = (code) => {
  const m = String(code || '').toUpperCase().match(/^([A-Z]{2}\d{2})/);
  return m ? m[1] : String(code || '').toUpperCase();
};
function assert(cond, msg) {
  if (!cond) throw new Error(`Seed data is inconsistent: ${msg}`);
}
// USERS is declared below; only called once the data is in place.
const fullName = (key) => { const u = USERS.find((x) => x.key === key); return `${u.firstName} ${u.lastName}`; };

// ═════════════════════════════════════════════════════════════════════════════
// DATA
// ═════════════════════════════════════════════════════════════════════════════

// ── people ──────────────────────────────────────────────────────────────────
// Sign-in is phone number + password. Only bcrypt hashes live here (cost 10,
// bcryptjs, which is what authApi's /auth/loginPassword compares against).
const USERS = [
  { key: 'admin1',    firstName: 'Admin',   lastName: 'One',               phone: '09000000001', hash: '$2a$10$8HN2hjLolyL8QShdliuS0u.uZbeT2NRj4B6tlJynBn54OoJ4ZIXMy' },
  { key: 'admin2',    firstName: 'Admin',   lastName: 'Two',               phone: '09000000002', hash: '$2a$10$GjZ2sXBNFuc4W4ezM68Bhud.jyXm0nalYNTEdTH7JZAediQDJomVG' },
  { key: 'admin3',    firstName: 'Admin',   lastName: 'Three',             phone: '09000000003', hash: '$2a$10$wnA373u7APRPvXncnfbVU.4i4g9jJs4JxC0Rk4Whr0iUVh3J8Ym5G' },
  { key: 'isfahanIM', firstName: 'Isfahan', lastName: 'Inventory Manager', phone: '09000000004', hash: '$2a$10$40YOXi78kFgsgoXxnCrzueqgL2k2dhW91B0rr19whNrXSSUD29T.G' },
  { key: 'ksaIM',     firstName: 'KSA',     lastName: 'Inventory Manager', phone: '09000000005', hash: '$2a$10$Ifkb4PuObNNL7WryG/r7Juey59Q6ngYoccpGHFeoqpSXPxr3MSf8G' },
  { key: 'ahvazIM',   firstName: 'Ahvaz',   lastName: 'Inventory Manager', phone: '09000000006', hash: '$2a$10$g9UoNuM375AC/KNFPokEC.P6USwPrWQ7d/NBMuFXFOJRx09sWCPeq' },
];

// A branch's inventory manager runs that branch's stock and the documents that
// move it. Which branch comes from the user's branch assignment, not the role.
const BRANCH_MANAGER_ROLE = {
  name: 'Branch Inventory Manager',
  description: 'Runs one branch\'s stock: its Inventory, the invoices, quotations and stock requests that move it, and its packing lists',
  permissions: [
    // forecast stone is granted per user, like the InventoryManager starter role
    ...ALL_KEYS.filter((k) => k.startsWith('inventory:') && !k.startsWith('inventory:forecast:')),
    // no delete keys and no company settings: those stay with the admins
    'mis:view',
    'mis:invoice:create', 'mis:invoice:edit', 'mis:invoice:pdf',
    'mis:preinvoice:create', 'mis:preinvoice:edit', 'mis:preinvoice:pdf', 'mis:preinvoice:convert',
    'mis:payment:edit', 'mis:crossBranch:quote',
    'mis:packingList:create', 'mis:packingList:edit', 'mis:packingList:pdf',
    'crm:view', 'crm:customer:create', 'crm:customer:edit',
    'crm:communication:view', 'crm:communication:create',
    'tutorials:view',
  ],
  dataScopes: { inventory: 'all', mis: 'all', packingList: 'all', crm: 'all' },
  isSystem: false,
  isSuperAdmin: false,
};

// roles: 'superAdmin' (the Admin role), 'branchManager' (above), 'supplyManager'
// (the SupplyManager starter role). Branches by key, see BRANCHES.
const ACCESS = {
  admin1:    { roles: ['superAdmin'], branches: ['isfahan', 'ksa', 'ahvaz', 'uae'] },
  admin2:    { roles: ['superAdmin'], branches: ['isfahan', 'ksa', 'ahvaz', 'uae'] },
  admin3:    { roles: ['superAdmin'], branches: ['isfahan', 'ksa', 'ahvaz', 'uae'] },
  // Isfahan is the supplying branch, so its manager also runs its Supply.
  isfahanIM: { roles: ['branchManager', 'supplyManager'], branches: ['isfahan'] },
  // KSA sees the stone Isfahan is preparing (forecasts) next to real stock.
  ksaIM:     { roles: ['branchManager'], branches: ['ksa'], grants: ['inventory:forecast:view'] },
  // Ahvaz also browses Isfahan's Supply records and deal letters.
  ahvazIM:   { roles: ['branchManager'], branches: ['ahvaz'], grants: ['supply:view', 'inventory:forecast:view'] },
};

// ── branches ────────────────────────────────────────────────────────────────
const BRANCHES = [
  { key: 'isfahan', name: 'Isfahan', country: 'IR', description: 'Supplying branch: buys quarry coupes, has them cut and ships stone to customers and to the other branches', address: 'Km 18, Isfahan–Najafabad Road, Isfahan, Iran' },
  { key: 'ksa',     name: 'KSA',     country: 'SA', description: 'Sales branch, Saudi Arabia', address: 'King Fahd Road, Al Olaya, Riyadh, Saudi Arabia' },
  { key: 'ahvaz',   name: 'Ahvaz',   country: 'IR', description: 'Sales branch, Khuzestan', address: 'Kianpars, Ahvaz, Iran' },
  { key: 'uae',     name: 'UAE',     country: 'AE', description: 'Sales branch, United Arab Emirates', address: 'RAK Airport Road, Ras Al Khaimah, UAE' },
];
// Isfahan shares its Inventory and Supply with the two branches it supplies.
const SHARES = { isfahan: ['ksa', 'ahvaz'] };

// ── customers ───────────────────────────────────────────────────────────────
// Dummy numbers and .test addresses (a reserved domain, so nothing can reach a
// real inbox). `interested` points at Isfahan products.
const CUSTOMERS = [
  { key: 'alwan', type: 'company', companyName: 'Al Wan Stone Trading LLC', contactPerson: 'Khalid Al Wan',
    cc: 'AE', dial: '+971', phone: '501000101', country: 'UAE', city: 'Sharjah', street: 'Industrial Area 12, Warehouse 7',
    trn: '100428837600003', channels: { whatsApp: true, email: 'purchasing@alwan-stone.test' },
    status: 'active', attractedBy: 'Exhibition', owner: 'isfahanIM', created: 58, tags: ['wholesale', 'repeat'],
    call: { on: 7, body: 'Wants Armani Grey 60×60 for a hotel lobby plus an onyx feature wall. Quote sent.' },
    interested: ['MA01', 'ON05'] },
  { key: 'naseem', type: 'company', companyName: 'Naseem Marble Works', contactPerson: 'Yusuf Naseem',
    cc: 'SA', dial: '+966', phone: '551000102', country: 'Saudi Arabia', city: 'Dammam', street: 'King Fahd Industrial Road, Block 4',
    trn: '310277409500003', channels: { whatsApp: true },
    status: 'won', attractedBy: 'Referral', owner: 'ksaIM', created: 55, tags: ['contractor'],
    call: { on: 9, body: 'Happy with the Notcha Light delivery. Asked for onyx and cristal prices for the next phase.' },
    interested: ['TR32', 'QU10'] },
  { key: 'barati', type: 'individual', firstName: 'Reza', lastName: 'Barati',
    cc: 'IR', dial: '+98', phone: '9130000103', country: 'Iran', city: 'Isfahan', street: 'Shahid Montazeri Blvd, No. 214',
    trn: '', channels: { whatsApp: true, telegram: '@rbarati_test' },
    status: 'active', attractedBy: 'Website', owner: 'isfahanIM', created: 50, tags: ['villa'],
    call: { on: 16, body: 'Approved the Beige Hond sample on site. Second order placed.' },
    interested: ['TR21', 'TR45'] },
  { key: 'dohaLux', type: 'company', companyName: 'Doha Luxury Interiors W.L.L.', contactPerson: 'Mariam Al Kuwari',
    cc: 'QA', dial: '+974', phone: '55000104', country: 'Qatar', city: 'Doha', street: 'Salwa Road, Building 41',
    trn: '', channels: { email: 'projects@dohaluxury.test', whatsApp: true },
    status: 'follow_up', attractedBy: 'Social media', owner: 'admin1', created: 45, tags: ['designer'],
    call: { on: 29, body: 'Large-format Souza for a villa project. Sent samples with the quote; call back about the decision.' },
    followUpIn: 3, interested: ['MA27'] },
  { key: 'muscat', type: 'company', companyName: 'Muscat Build Supplies LLC', contactPerson: 'Salim Al Harthy',
    cc: 'OM', dial: '+968', phone: '92000105', country: 'Oman', city: 'Muscat', street: 'Ghala Industrial Area, Way 3412',
    trn: '', channels: { whatsApp: true },
    status: 'new', attractedBy: 'Cold call', owner: 'admin2', created: 12, tags: [],
    interested: ['GR55'] },
  { key: 'otaibi', type: 'individual', firstName: 'Fahad', lastName: 'Al Otaibi',
    cc: 'SA', dial: '+966', phone: '501000106', country: 'Saudi Arabia', city: 'Riyadh', street: 'Al Malqa District, Street 21',
    trn: '', channels: { whatsApp: true, phone: true },
    status: 'won', attractedBy: 'Referral', owner: 'ksaIM', created: 40, tags: ['villa'],
    call: { on: 25, body: 'Collected from the Riyadh showroom and paid in cash.' } },
  { key: 'basra', type: 'company', companyName: 'Basra Modern Construction Co.', contactPerson: 'Haider Kadhim',
    cc: 'IQ', dial: '+964', phone: '7800000107', country: 'Iraq', city: 'Basra', street: 'Al Jazair Street, Office 9',
    trn: '', channels: { whatsApp: true, telegram: '@basra_modern_test' },
    status: 'follow_up', attractedBy: 'Exhibition', owner: 'ahvazIM', created: 38, tags: ['contractor', 'tower'],
    call: { on: 8, body: 'Balance on the travertine invoice is due before the second truck. They also want a lobby option.' },
    followUpIn: -1, interested: ['TR46', 'MA25'] },
  { key: 'karun', type: 'company', companyName: 'Karun Tile & Stone', contactPerson: 'Ali Sharifi',
    cc: 'IR', dial: '+98', phone: '9160000108', country: 'Iran', city: 'Ahvaz', street: 'Kianpars, 7th Street East, No. 18',
    trn: '', channels: { whatsApp: true, instagram: '@karun.tile.test' },
    status: 'active', attractedBy: 'Social media', owner: 'ahvazIM', created: 30, tags: ['retail'],
    call: { on: 20, body: 'Delivery confirmed for Kianpars warehouse.' } },
  { key: 'kuwaitGulf', type: 'company', companyName: 'Kuwait Gulf Contracting', contactPerson: 'Bader Al Mutairi',
    cc: 'KW', dial: '+965', phone: '66000109', country: 'Kuwait', city: 'Kuwait City', street: 'Shuwaikh Industrial, Block 2',
    trn: '', channels: { email: 'bader@kuwaitgulf.test' },
    status: 'won', attractedBy: 'Website', owner: 'admin1', created: 33, tags: ['contractor'],
    call: { on: 20, body: 'Paid in full. Book-matched slabs to be crated in pairs.' } },
  { key: 'manama', type: 'company', companyName: 'Manama Stone Gallery', contactPerson: 'Hussain Al Aali',
    cc: 'BH', dial: '+973', phone: '36000110', country: 'Bahrain', city: 'Manama', street: 'Sitra Industrial Area, Road 120',
    trn: '', channels: { whatsApp: true, email: 'sales@manamastone.test' },
    status: 'lost', attractedBy: 'Exhibition', owner: 'admin3', created: 47, tags: [],
    call: { on: 31, body: 'Went with a local supplier on price. Keep them on the list for the next exhibition.' },
    interested: ['TR45'] },
];

// ── inventory ───────────────────────────────────────────────────────────────
// Isfahan gets the whole dev catalog; KSA and Ahvaz a small stock of their
// own, so their own invoices have something to sell from.
const CATALOG_FILE = path.join(__dirname, 'testSeedData', 'inventory.json');
const BRANCH_STOCK = {
  ksa: [
    ['TR43Q06003018VFP', 380], ['TR43Q08004018VFP', 120], ['TR43Q12006018VFP', 48.6],
    ['MA16Q06003020', 260], ['MA16Q00000020', 72.5],
    ['QU10Q00000020', 95.4],
    ['TR17Q00000020VUH', 140.25], ['TR17Q08004018VFP', 88],
  ],
  ahvaz: [
    ['TR46Q06003018VFP', 310], ['TR46Q08004018VFP', 205.6], ['TR46Q10004018VFP', 96],
    ['MA25Q06006020', 64.8], ['MA25Q00000020', 118.4],
    ['TR51Q08004018VUH', 240], ['TR51Q12004018VUH', 88.3],
    ['QU09Q00000020', 61.2],
  ],
};

// ── supply (Isfahan) ────────────────────────────────────────────────────────
// Deal-letter prices are per m² (or per metre for ML strips) in Rial, which is
// what the printed stone sales contract shows. `history` is replayed into the
// follow-up log: notes, price updates, status moves, final quantities, receive.
const BUYER = {
  name: 'Lazulite Marble Company',
  position: 'Purchasing',
  representedBy: 'Isfahan Inventory Manager',
  onBehalfOf: 'Lazulite Marble Company, Isfahan branch',
  nationalId: '10100000001',
  addressPhone: 'Km 18 Isfahan–Najafabad Road, Isfahan · 031 0000 0000',
};
const SUPPLY = [
  { key: 'srTR48', product: 'TR48', on: 50, title: 'Blond travertine, Kerman quarry coupes',
    notes: 'Two coupes from the same quarry face. The first is cut and partly in the warehouse.',
    dealLetters: [
      { key: 'dlTR48a', on: 50, status: 'final_product',
        coupeSpec: 'Block 2.8 × 1.9 × 1.6 m (about 8.5 m³), light blond, open veins on one face',
        seller: { name: 'Kerman Travertine Quarry Co.', phone: '09130000201', notes: 'Contact: Mahmoud Rezaei' },
        contract: { number: '1405-0031', sellerParty: 'Kerman Travertine Quarry Co. (Mahmoud Rezaei)', sellerAddressPhone: 'Km 22 Kerman–Bam Road, Kerman · 0913 000 0201',
          paymentTerms: '40% cash on signing, the balance in three monthly cheques', guarantee: 'Cheque for the balance', settlementDays: 90, loadingDays: 20 },
        lines: [
          { code: 'TR48Q06003018VFP', forecast: 420, final: 396.4, price: 4200000, received: 250 },
          { code: 'TR48Q08004018VFP', forecast: 260, final: 241.92, price: 4350000, received: 241.92 },
          { code: 'TR48Q10004018VFP', forecast: 180, final: 170.8, price: 4500000 },
        ],
        history: [
          { on: 48, note: 'Quarry visit: block is sound, two hairline cracks on the east face. Priced in.' },
          { on: 48, prices: true },
          { on: 44, status: 'processing' },
          { on: 41, note: 'Cutting started at the partner workshop. Yield looks around 94%.' },
          { on: 38, finals: true },
          { on: 38, status: 'final_product' },
          { on: 36, receive: true },
          { on: 14, note: 'Ahvaz asked for 100 m² of the 100×40. Holding it at the yard.' },
        ] },
      { key: 'dlTR48b', on: 20, status: 'processing',
        coupeSpec: 'Block 3.1 × 2.0 × 1.7 m (about 10.5 m³), blond with darker bands',
        seller: { name: 'Kerman Travertine Quarry Co.', phone: '09130000201', notes: 'Same quarry face as the first coupe' },
        contract: { number: '1405-0058', sellerParty: 'Kerman Travertine Quarry Co. (Mahmoud Rezaei)', sellerAddressPhone: 'Km 22 Kerman–Bam Road, Kerman · 0913 000 0201',
          paymentTerms: '30% on signing, 70% on loading', guarantee: 'Bank guarantee', settlementDays: 60, loadingDays: 25 },
        lines: [
          { code: 'TR48Q12004018VFP', forecast: 210, price: 4600000 },
          { code: 'TR48E10004018VFP', forecast: 150, price: 3600000 },
        ],
        history: [
          { on: 19, prices: true },
          { on: 18, note: 'Second coupe agreed at the same rate. Deposit paid.' },
          { on: 12, status: 'processing' },
          { on: 5, note: 'Half the block is through the gang saw.' },
        ] },
    ] },
  { key: 'srQU01', product: 'QU01', on: 40, title: 'Bianco, imported block lot (Bandar Abbas)',
    notes: 'Imported raw blocks cleared at Bandar Abbas, processed in two batches.',
    dealLetters: [
      { key: 'dlQU01', on: 40, status: 'processing',
        coupeSpec: '3 blocks, about 24 m³ in total, white with grey veins',
        seller: { name: 'Gulf Stone Import Co.', phone: '09170000202', notes: 'Bonded yard at Shahid Rajaee port' },
        contract: { number: '1405-0036', sellerParty: 'Gulf Stone Import Co.', sellerAddressPhone: 'Shahid Rajaee port, Bandar Abbas · 0917 000 0202',
          paymentTerms: '50% on signing, 50% on customs clearance', guarantee: 'Cheque', settlementDays: 45, loadingDays: 30 },
        lines: [
          { code: 'QU01Q00000020', forecast: 300, price: 6500000, count: 64, widthCm: 170, lengthCm: 275 },
          { code: 'QU01Q12003330', forecast: 260, price: 2900000 },
          { code: 'QU01Q13003330', forecast: 180, price: 3000000 },
        ],
        history: [
          { on: 39, prices: true },
          { on: 28, status: 'processing' },
          { on: 22, note: 'First batch of slabs is out. Polish quality is good.' },
          { on: 3, note: 'Second batch delayed by a saw blade change, about a week behind.' },
        ] },
    ] },
  { key: 'srON05', product: 'ON05', on: 34, title: 'Onyx, Yazd coupe',
    notes: 'Single onyx coupe. Slabs are back from the polishing line.',
    dealLetters: [
      { key: 'dlON05', on: 34, status: 'final_product',
        coupeSpec: 'Block 2.2 × 1.5 × 1.2 m (about 4 m³), honey onyx, translucent',
        seller: { name: 'Yazd Onyx Mine (Akbari Brothers)', phone: '09130000203', notes: '' },
        contract: { number: '1405-0040', sellerParty: 'Yazd Onyx Mine (Akbari Brothers)', sellerAddressPhone: 'Ardakan road, Yazd · 0913 000 0203',
          paymentTerms: 'Full payment on loading', guarantee: '', settlementDays: 15, loadingDays: 10 },
        lines: [
          { code: 'ON05Q00000020', forecast: 160, final: 148.5, price: 14500000, count: 36, widthCm: 160, lengthCm: 250 },
        ],
        history: [
          { on: 33, note: 'Translucency checked under light: top grade.' },
          { on: 33, prices: true },
          { on: 27, status: 'processing' },
          { on: 19, finals: true },
          { on: 19, status: 'final_product' },
          { on: 17, note: 'Slabs sent to the polishing workshop (see the packing list).' },
          { on: 10, note: 'KSA reserved 30 m² of this lot.' },
        ] },
    ] },
  { key: 'srMA01', product: 'MA01', on: 9, title: 'Armani Grey, Tabriz block purchase',
    notes: 'Three-block purchase. Price agreed for two sizes, the slab price is still open.',
    dealLetters: [
      { key: 'dlMA01', on: 9, status: 'purchasing',
        coupeSpec: '3 blocks, about 27 m³ in total, dark grey with white veining',
        seller: { name: 'Azar Stone Quarry (Tabriz)', phone: '09140000204', notes: '' },
        contract: { number: '1405-0071', sellerParty: 'Azar Stone Quarry', sellerAddressPhone: 'Tabriz–Marand road, Tabriz · 0914 000 0204',
          paymentTerms: '30% on signing, 70% on loading', guarantee: 'Cheque for the balance', settlementDays: 30, loadingDays: 15 },
        lines: [
          { code: 'MA01Q06006020', forecast: 480, price: 5200000 },
          { code: 'MA01Q12006020', forecast: 200, price: 6100000 },
          { code: 'MA01Q00000020', forecast: 160, price: null },
        ],
        history: [
          { on: 8, note: 'Samples received from the quarry. The colour matches our current stock.' },
          { on: 7, prices: true },
          { on: 2, note: 'Ahvaz asked for 200 m² of the 60×60 from this lot.' },
        ] },
    ] },
  { key: 'srGR55', product: 'GR55', on: 6, title: 'Sardo white granite, Zahedan quarry',
    notes: 'First purchase from this quarry: a trial lot.',
    dealLetters: [
      { key: 'dlGR55', on: 6, status: 'purchasing',
        coupeSpec: '1 block 2.6 × 1.8 × 1.5 m (about 7 m³), white with black mica spots',
        seller: { name: 'Zahedan Granite Co.', phone: '09150000205', notes: 'Trial lot' },
        contract: { number: '1405-0074', sellerParty: 'Zahedan Granite Co.', sellerAddressPhone: 'Industrial zone, Zahedan · 0915 000 0205',
          paymentTerms: 'Full payment on loading', guarantee: '', settlementDays: 20, loadingDays: 20 },
        lines: [
          { code: 'GR55Q12006020P', forecast: 260, price: 3400000 },
          { code: 'GR55Q13003330', forecast: 140, price: 1900000 },
        ],
        history: [
          { on: 6, prices: true },
          { on: 5, note: 'Trial lot: checking absorption and polish before committing to more.' },
        ] },
    ] },
];

// ── invoices, quotations and requests ───────────────────────────────────────
// `on` and every other day value is "days ago". Customer documents sell from
// the branch's own stock. Requests (`requester`) are raised BY a sales branch
// AGAINST Isfahan, so their stock and their numbering are Isfahan's, and only
// Isfahan's manager (`handler`) prices, accepts, converts or declines them.
// Accepting a quotation or request, or a payment that makes an invoice paid,
// takes its quantities out of stock (or out of its lot, for supply lines).
const L = (code, quantity, unitPrice = 0, more = {}) => ({ code, quantity, unitPrice, ...more });
const S = (dealLetter, code, quantity) => ({ code, quantity, unitPrice: 0, dealLetter });

const DOCS = [
  // Isfahan, to customers: 5 quotations
  { key: 'qNaseem', branch: 'isfahan', docType: 'pre_invoice', customer: 'naseem', by: 'isfahanIM', on: 42,
    lines: [L('TR32Q08004018VFP', 220, 110), L('TR32Q12004018VFP', 90, 110)], vatRate: 5, validityDays: 7,
    notes: 'Ex-works Isfahan, export crating included. Shipping to Dammam via Bandar Abbas.',
    flow: [[41, 'sent'], [38, 'accepted']], convert: { into: 'iNaseem', on: 36 } },
  { key: 'qDoha', branch: 'isfahan', docType: 'pre_invoice', customer: 'dohaLux', by: 'isfahanIM', on: 30,
    lines: [L('MA27Q12007020', 120, 140, { discount: 5, discountType: 'percent' }), L('MA27Q13007020', 60, 140)], vatRate: 5, validityDays: 14,
    notes: 'Large-format Souza for a villa project in Doha. 5% off the 120×70. Samples sent with this quote.',
    flow: [[29, 'sent']] },
  { key: 'qBarati', branch: 'isfahan', docType: 'pre_invoice', customer: 'barati', by: 'isfahanIM', on: 22,
    lines: [L('TR21Q06003018VFP', 260, 95), L('TR21Q14003330VFP', 120, 95)], vatRate: 5, validityDays: 10,
    notes: 'Pickup from the Isfahan yard. The customer arranges transport.',
    flow: [[21, 'sent'], [18, 'accepted']] },
  { key: 'qAlwan', branch: 'isfahan', docType: 'pre_invoice', customer: 'alwan', by: 'isfahanIM', on: 14,
    lines: [L('MA01Q06006020', 150, 110), L('ON05Q00000020', 25, 270)], vatRate: 5, validityDays: 10,
    notes: 'Armani Grey 60×60 for a hotel lobby, plus an onyx feature wall.',
    flow: [[13, 'sent'], [11, 'accepted']] },
  { key: 'qMuscat', branch: 'isfahan', docType: 'pre_invoice', customer: 'muscat', by: 'isfahanIM', on: 4,
    lines: [L('GR55Q12006020P', 90, 57), L('GR55Q13003330', 60, 45)], vatRate: 5, validityDays: 7,
    notes: 'First quote for a new contact. Waiting for their drawings.' },

  // Isfahan, to customers: 5 invoices
  { key: 'iNaseem', branch: 'isfahan', docType: 'invoice', from: 'qNaseem', by: 'isfahanIM', on: 36, status: 'issued', shipping: 1800,
    notes: 'Converted from the accepted quotation. Freight to Dammam billed as shipping.',
    payments: [{ on: 30, chequeBank: 'rest' }] },
  { key: 'iBasra', branch: 'isfahan', docType: 'invoice', customer: 'basra', by: 'isfahanIM', on: 33, status: 'issued', shipping: 3200,
    lines: [L('TR46Q08004018VFP', 400, 110, { discount: 1500, discountType: 'amount' }), L('TR46Q06003018VFP', 250, 110)], vatRate: 5,
    notes: 'Two trucks. The second leaves once the balance is cleared.',
    payments: [{ on: 27, cash: 20000, chequeBank: 25000 }] },
  { key: 'iKuwait', branch: 'isfahan', docType: 'invoice', customer: 'kuwaitGulf', by: 'isfahanIM', on: 26, status: 'issued', shipping: 2400,
    lines: [L('QU01Q00000020', 60, 145), L('QU01Q12003330', 100, 80)], vatRate: 5,
    notes: 'Slabs book-matched in pairs, crated.',
    payments: [{ on: 20, card: 5000, chequeBank: 'rest' }] },
  { key: 'iBarati', branch: 'isfahan', docType: 'invoice', customer: 'barati', by: 'isfahanIM', on: 16, status: 'issued',
    lines: [L('TR45Q08004018VFP', 75, 90)], vatRate: 5,
    notes: 'Second order, same lot as the sample approved on site.' },
  { key: 'iAlwan', branch: 'isfahan', docType: 'invoice', customer: 'alwan', by: 'isfahanIM', on: 6, status: 'draft',
    lines: [L('TR17Q08004018VFP', 180, 110), L('TR17Q00000020VUH', 64, 155)], vatRate: 5,
    notes: 'Draft: waiting for Al Wan to confirm the slab sizes.' },

  // KSA, its own stock
  { key: 'iOtaibi', branch: 'ksa', docType: 'invoice', customer: 'otaibi', by: 'ksaIM', on: 28, status: 'issued',
    lines: [L('TR43Q06003018VFP', 120, 95), L('MA16Q06003020', 60, 92)], vatRate: 15,
    notes: 'Collected from the Riyadh showroom.',
    payments: [{ on: 25, cash: 'rest' }] },
  { key: 'qKsaNaseem', branch: 'ksa', docType: 'pre_invoice', customer: 'naseem', by: 'ksaIM', on: 9,
    lines: [L('QU10Q00000020', 45, 170), L('TR17Q00000020VUH', 50, 155)], vatRate: 15, validityDays: 10,
    notes: 'Follow-up order for the Dammam project.',
    flow: [[8, 'sent']] },

  // KSA, requests to Isfahan
  { key: 'rKsa1', branch: 'isfahan', requester: 'ksa', docType: 'pre_invoice', by: 'ksaIM', handler: 'isfahanIM', on: 35,
    lines: [L('TR32Q10004018VFP', 150), L('TR43Q08004018VFP', 200)],
    notes: 'Restock for the Riyadh showroom. Beige Diamond and Notcha Light are running low.',
    priced: { on: 34, prices: [95, 82] }, flow: [[34, 'sent'], [33, 'accepted']], convert: { into: 'iKsa1', on: 31 } },
  { key: 'iKsa1', branch: 'isfahan', requester: 'ksa', docType: 'invoice', from: 'rKsa1', by: 'isfahanIM', on: 31, status: 'issued',
    notes: 'Inter-branch transfer, settled between the branch accounts.',
    payments: [{ on: 24, chequeBank: 'rest' }] },
  { key: 'rKsa2', branch: 'isfahan', requester: 'ksa', docType: 'pre_invoice', by: 'ksaIM', handler: 'isfahanIM', on: 12,
    lines: [S('dlON05', 'ON05Q00000020', 30)],
    notes: 'Onyx for a feature wall. Happy to wait for the lot to be ready.',
    priced: { on: 11, prices: [230] }, flow: [[11, 'sent'], [10, 'accepted']] },
  { key: 'rKsa3', branch: 'isfahan', requester: 'ksa', docType: 'pre_invoice', by: 'ksaIM', handler: 'isfahanIM', on: 3,
    lines: [L('MA16Q06003020', 300), L('MA25Q00000020', 80)],
    notes: 'Quarterly restock.' },

  // Ahvaz, its own stock
  { key: 'iKarun', branch: 'ahvaz', docType: 'invoice', customer: 'karun', by: 'ahvazIM', on: 20, status: 'issued',
    lines: [L('TR46Q06003018VFP', 140, 110), L('TR51Q08004018VUH', 90, 95)], vatRate: 5,
    notes: 'Delivered to the Karun warehouse, Kianpars.' },
  { key: 'qAhvazBasra', branch: 'ahvaz', docType: 'pre_invoice', customer: 'basra', by: 'ahvazIM', on: 7,
    lines: [L('MA25Q06006020', 40, 160), L('QU09Q00000020', 30, 210)], vatRate: 5, validityDays: 7,
    notes: 'Lobby flooring, option B, for the Basra tower project.' },

  // Ahvaz, requests to Isfahan
  { key: 'rAhvaz1', branch: 'isfahan', requester: 'ahvaz', docType: 'pre_invoice', by: 'ahvazIM', handler: 'isfahanIM', on: 27,
    lines: [L('TR21Q06003018VFP', 180), L('TR45Q06003018VUH', 150)],
    notes: 'For the Karun Tile & Stone order.',
    priced: { on: 26, prices: [80, 72] }, flow: [[26, 'sent'], [25, 'accepted']], convert: { into: 'iAhvaz1', on: 24 } },
  { key: 'iAhvaz1', branch: 'isfahan', requester: 'ahvaz', docType: 'invoice', from: 'rAhvaz1', by: 'isfahanIM', on: 24, status: 'issued',
    notes: 'Inter-branch transfer to Ahvaz.' },
  { key: 'rAhvaz2', branch: 'isfahan', requester: 'ahvaz', docType: 'pre_invoice', by: 'ahvazIM', handler: 'isfahanIM', on: 15,
    lines: [S('dlTR48a', 'TR48Q10004018VFP', 100)],
    notes: 'From the cut lot still at the yard.',
    priced: { on: 14, prices: [88] }, flow: [[14, 'sent'], [13, 'accepted']] },
  { key: 'rAhvaz3', branch: 'isfahan', requester: 'ahvaz', docType: 'pre_invoice', by: 'ahvazIM', handler: 'isfahanIM', on: 10,
    lines: [S('dlTR48b', 'TR48Q12004018VFP', 120)],
    notes: 'From the second coupe, when it is cut.',
    priced: { on: 9, prices: [92] }, flow: [[9, 'sent']] },
  { key: 'rAhvaz4', branch: 'isfahan', requester: 'ahvaz', docType: 'pre_invoice', by: 'ahvazIM', handler: 'isfahanIM', on: 5,
    lines: [L('TR46Q08004018VFP', 300)],
    notes: 'Urgent: needed this week.',
    flow: [[4, 'cancelled']] },
  { key: 'rAhvaz5', branch: 'isfahan', requester: 'ahvaz', docType: 'pre_invoice', by: 'ahvazIM', handler: 'isfahanIM', on: 2,
    lines: [S('dlMA01', 'MA01Q06006020', 200)],
    notes: 'Reserve from the Tabriz purchase once it is cut.' },
];

// ── packing lists (Isfahan) ─────────────────────────────────────────────────
// Every pallet is a list of items. T = tiles/strips (size from the stone code),
// SL = slabs with their real cut size. A 'linked' list's codes must match the
// linked invoices' products (the same rule the app enforces).
const T = (code, pcs) => ({ code, pcs });
const SL = (code, lengthCm, widthCm, pcs) => ({ code, pcs, lengthCm, widthCm });
const ISFAHAN_YARD = 'LMC yard, Km 18 Isfahan–Najafabad Road, Isfahan, Iran';
const ISFAHAN_WAREHOUSE = 'LMC warehouse, Km 18 Isfahan–Najafabad Road, Isfahan, Iran';
const DRIVERS = {
  jafari:  { fullName: 'Hassan Jafari',  nationalId: '1270000001', smartNumber: 'SM-448127', phone: '09130000301', iban: 'IR000170000000000000000301' },
  sabbagh: { fullName: 'Ali Sabbagh',    nationalId: '0060000002', smartNumber: 'SM-551903', phone: '09120000302', iban: 'IR000540000000000000000302' },
  ahmadi:  { fullName: 'Morteza Ahmadi', nationalId: '1280000003', smartNumber: 'SM-620114', phone: '09130000303', iban: '' },
  karimi:  { fullName: 'Reza Karimi',    nationalId: '1290000004', smartNumber: 'SM-702266', phone: '09160000304', iban: 'IR000120000000000000000304' },
};
const TRUCKS = {
  a: { trailerPlateNumber: '53 T 419 IR 13', trailerSmartNumber: 'TR-902318' },
  b: { trailerPlateNumber: '77 E 286 IR 53', trailerSmartNumber: 'TR-771540' },
  c: { trailerPlateNumber: '21 B 704 IR 13', trailerSmartNumber: 'TR-618277' },
  d: { trailerPlateNumber: '44 J 518 IR 14', trailerSmartNumber: 'TR-655093' },
};
const CUSTOMS = {
  bandar:     { name: 'Bandar Abbas customs (M. Rasouli)', phone: '09170000401' },
  shalamcheh: { name: 'Shalamcheh border (A. Dehghan)',    phone: '09160000402' },
};
const PACKING = [
  { key: 'plYard', type: 'free', on: 37, status: 'final', supplyRecord: 'srTR48', driver: 'ahmadi', truck: 'c',
    origin: 'Partner cutting yard, Km 22 Kerman–Bam Road, Kerman, Iran', destination: ISFAHAN_WAREHOUSE,
    shippingDestination: 'Isfahan (internal transfer)', thickness: 1.8,
    notes: 'First cut lot of the Kerman coupe, into the warehouse.',
    pallets: [[T('TR48Q06003018VFP', 700)], [T('TR48Q06003018VFP', 689)], [T('TR48Q08004018VFP', 378)], [T('TR48Q08004018VFP', 378)]] },
  { key: 'plNaseem', type: 'linked', invoices: ['iNaseem'], on: 35, status: 'final', driver: 'jafari', truck: 'a', customs: 'bandar',
    origin: ISFAHAN_YARD, destination: 'Naseem Marble Works, King Fahd Industrial Road, Block 4, Dammam, Saudi Arabia',
    shippingDestination: 'Dammam, Saudi Arabia (via Bandar Abbas)', thickness: 1.8,
    notes: 'Loaded and sealed. Seal no. 41827.',
    pallets: [[T('TR32Q08004018VFP', 230)], [T('TR32Q08004018VFP', 230)], [T('TR32Q08004018VFP', 228)], [T('TR32Q12004018VFP', 188)]] },
  { key: 'plKsa', type: 'linked', invoices: ['iKsa1'], on: 31, status: 'final', driver: 'sabbagh', truck: 'b', customs: 'bandar',
    origin: ISFAHAN_YARD, destination: 'LMC KSA branch, King Fahd Road, Al Olaya, Riyadh, Saudi Arabia',
    shippingDestination: 'Riyadh, Saudi Arabia (via Bandar Abbas)', thickness: 1.8,
    notes: 'Inter-branch transfer for the Riyadh showroom.',
    pallets: [[T('TR32Q10004018VFP', 188)], [T('TR32Q10004018VFP', 187)], [T('TR43Q08004018VFP', 313)], [T('TR43Q08004018VFP', 312)]] },
  { key: 'plBasra', type: 'linked', invoices: ['iBasra'], on: 27, status: 'final', driver: 'karimi', truck: 'd', customs: 'shalamcheh',
    origin: ISFAHAN_YARD, destination: 'Basra Modern Construction Co., Al Jazair Street, Basra, Iraq',
    shippingDestination: 'Basra, Iraq (via Shalamcheh)', thickness: 1.8,
    notes: 'First of two trucks. The second leaves once the balance is cleared.',
    pallets: [[T('TR46Q08004018VFP', 313)], [T('TR46Q08004018VFP', 312)], [T('TR46Q06003018VFP', 695)], [T('TR46Q06003018VFP', 694)]] },
  { key: 'plAhvaz', type: 'linked', invoices: ['iAhvaz1'], on: 23, status: 'draft', driver: 'karimi', truck: 'd',
    origin: ISFAHAN_YARD, destination: 'LMC Ahvaz branch, Kianpars, Ahvaz, Iran',
    shippingDestination: 'Ahvaz, Iran (internal transfer)', thickness: 1.8,
    notes: 'Loading. Two pallets still to wrap.',
    pallets: [[T('TR21Q06003018VFP', 500)], [T('TR21Q06003018VFP', 500)], [T('TR45Q06003018VUH', 417)], [T('TR45Q06003018VUH', 417)]] },
  { key: 'plKuwait', type: 'linked', invoices: ['iKuwait'], on: 20, status: 'final', driver: 'jafari', truck: 'a', customs: 'bandar',
    origin: ISFAHAN_YARD, destination: 'Kuwait Gulf Contracting, Shuwaikh Industrial, Block 2, Kuwait City, Kuwait',
    shippingDestination: 'Kuwait City, Kuwait (via Bandar Abbas)', thickness: 2,
    notes: 'Slabs book-matched in pairs, A-frame crates.',
    pallets: [
      [SL('QU01Q00000020', 275, 165, 6), SL('QU01Q00000020', 280, 190, 1)],
      [SL('QU01Q00000020', 275, 165, 6)],
      [T('QU01Q12003330', 84)],
    ] },
  { key: 'plShowroom', type: 'free', on: 19, status: 'draft', driver: 'ahmadi', truck: 'c',
    origin: ISFAHAN_WAREHOUSE, destination: 'LMC showroom, Saadat Abad, Tehran, Iran',
    shippingDestination: 'Tehran, Iran (internal transfer)', thickness: 2,
    notes: 'Showroom samples, not linked to an invoice.',
    pallets: [[T('MA27Q12007020', 12), T('MA16Q06003020', 40)]] },
  { key: 'plOnyx', type: 'free', on: 17, status: 'final', supplyRecord: 'srON05', driver: 'ahmadi', truck: 'c',
    origin: ISFAHAN_YARD, destination: 'Polishing workshop, Mahmoudabad industrial zone, Isfahan, Iran',
    shippingDestination: 'Isfahan (internal transfer)', thickness: 2,
    notes: 'Onyx slabs to the polishing line.',
    pallets: [
      [SL('ON05Q00000020', 245, 160, 6), SL('ON05Q00000020', 230, 150, 4)],
      [SL('ON05Q00000020', 250, 165, 5), SL('ON05Q00000020', 220, 140, 3)],
    ] },
  { key: 'plExpo', type: 'free', on: 8, status: 'draft', driver: 'sabbagh', truck: 'b', customs: 'bandar',
    origin: ISFAHAN_WAREHOUSE, destination: 'Dubai World Trade Centre, exhibition stand, Dubai, UAE',
    shippingDestination: 'Dubai, UAE (via Bandar Abbas)', thickness: 2,
    notes: 'Exhibition samples. They come back after the show.',
    pallets: [[T('TR45Q08004018VFP', 30), T('MA01Q06006020', 20)], [SL('QU01Q00000020', 270, 160, 2)]] },
  { key: 'plPort', type: 'free', on: 1, status: 'draft', supplyRecord: 'srQU01', driver: 'karimi', truck: 'd',
    origin: 'Shahid Rajaee port bonded yard, Bandar Abbas, Iran', destination: ISFAHAN_WAREHOUSE,
    shippingDestination: 'Isfahan (inland transfer)', thickness: 2,
    notes: 'First batch of processed Bianco slabs.',
    pallets: [[SL('QU01Q00000020', 280, 180, 8)], [SL('QU01Q00000020', 265, 170, 7), SL('QU01Q00000020', 240, 150, 3)]] },
];

// ═════════════════════════════════════════════════════════════════════════════
// BUILD — everything is assembled in memory first, so a dry run prints exactly
// what --yes writes.
// ═════════════════════════════════════════════════════════════════════════════

// Same money math as routes/mis/invoices.js computeTotals (2dp).
function computeTotals(lineItems, shipping) {
  let subtotal = 0, discountTotal = 0, vatTotal = 0;
  const lines = (lineItems || []).map((li) => {
    const qty = Number(li.quantity) || 0;
    const unitPrice = Number(li.unitPrice) || 0;
    const discount = Number(li.discount) || 0;
    const vatRate = Number(li.vatRate) || 0;
    const base = round2(qty * unitPrice);
    const discountAmount = li.discountType === 'percent' ? round2(base * discount / 100) : round2(discount);
    const vatAmount = round2((base - discountAmount) * vatRate / 100);
    const lineTotal = round2(base - discountAmount + vatAmount);
    subtotal += base; discountTotal += discountAmount; vatTotal += vatAmount;
    return { ...li, quantity: qty, unitPrice, discount, vatRate, vatAmount, lineTotal };
  });
  subtotal = round2(subtotal); discountTotal = round2(discountTotal); vatTotal = round2(vatTotal);
  const ship = round2(shipping);
  return { lines, subtotal, discountTotal, vatTotal, shipping: ship, grandTotal: round2(subtotal - discountTotal + vatTotal + ship) };
}

function loadCatalog() {
  const data = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const variantsByRef = {};
  for (const v of data.variants) (variantsByRef[v.productRef] = variantsByRef[v.productRef] || []).push(v);
  // a product with no varieties is an unfinished dev entry, not stock
  const products = data.products.filter((p) => (variantsByRef[p.ref] || []).length);
  return { source: data.source, products, variantsByRef };
}

function build(ctx) {
  const out = {
    users: [], userAccesses: [], customers: [], customerActivities: [],
    products: [], variants: [], changeLogs: [],
    records: [], dealLetters: [], dealActivities: [],
    invoices: [], invoiceActivities: [], stockEvents: [],
    packingLists: [], packingActivities: [],
    report: { catalogSource: '', docs: [], packing: [], records: [] },
  };
  const userById = {};
  const uid = (k) => { assert(ctx.userIds[k], `unknown user ${k}`); return ctx.userIds[k]; };
  const nameOf = fullName;
  const bid = (k) => { assert(ctx.branchIds[k], `unknown branch ${k}`); return ctx.branchIds[k]; };
  const branchName = (k) => BRANCHES.find((b) => b.key === k).name;

  // ── users ──
  for (const u of USERS) {
    const a = ACCESS[u.key];
    out.users.push({
      _id: uid(u.key), firstName: u.firstName, lastName: u.lastName, phoneNumber: u.phone,
      password: u.hash, oldPasswords: [], validation: true, access: [],
      countryCode: '+98', language: 'en',
      insertDate: daysAgo(62), updateDate: null, deleteDate: null,
    });
    out.userAccesses.push({
      userId: uid(u.key), roles: a.roles.map((r) => ctx.roleIds[r]), groups: [],
      grants: a.grants || [], denies: [], branches: a.branches.map(bid),
      canGhost: false, insertDate: daysAgo(62),
    });
    userById[u.key] = u;
  }

  // ── inventory ──
  const catalog = loadCatalog();
  out.report.catalogSource = catalog.source;
  const products = {};   // `${branch}:${productCode}` → product doc
  const variants = {};   // `${branch}:${variantCode}` → variant doc (+ productName)
  const sourceByCode = {};
  for (const p of catalog.products) {
    for (const v of catalog.variantsByRef[p.ref]) sourceByCode[v.code] = { p, v };
  }
  const addProduct = (branch, p, createdOn, by) => {
    const key = `${branch}:${p.code}`;
    if (products[key]) return products[key];
    const doc = {
      _id: oid(), branchId: bid(branch), code: p.code,
      stoneType: p.stoneType, stoneTypeName: p.stoneTypeName, quarryCode: p.quarryCode,
      name: p.name, nameAr: p.nameAr || '', nameFa: p.nameFa || '',
      descriptionAr: p.descriptionAr || '', descriptionFa: p.descriptionFa || '',
      defaultUnit: p.defaultUnit || 'M2', status: p.status || 'active',
      insertDate: daysAgo(createdOn), createdBy: uid(by), updatedBy: uid(by),
    };
    products[key] = doc;
    out.products.push(doc);
    return doc;
  };
  const addVariant = (branch, product, v, quantity, createdOn, by) => {
    const key = `${branch}:${v.code}`;
    assert(!variants[key], `duplicate variety ${key}`);
    const doc = {
      _id: oid(), branchId: bid(branch), productId: product._id, code: v.code,
      spec: v.spec || {}, categories: [], unit: v.unit || 'M2',
      quantity: round4(quantity), supply: { forecastQty: 0, finalQty: 0 },
      price: v.price === undefined ? null : v.price, currency: v.currency || 'AED',
      status: v.status || 'active',
      insertDate: daysAgo(createdOn), createdBy: uid(by), updatedBy: uid(by),
    };
    variants[key] = doc;
    out.variants.push(doc);
    out.changeLogs.push({
      subjectType: 'variant', subjectId: doc._id, productId: product._id, changeType: 'created',
      newValue: { code: doc.code, unit: doc.unit, quantity: doc.quantity, price: doc.price },
      source: 'import', reason: 'Opening stock (test deployment)',
      changedBy: uid(by), changedByName: nameOf(by), date: daysAgo(createdOn), createdAt: daysAgo(createdOn),
    });
    return doc;
  };
  for (const p of catalog.products) {
    const prod = addProduct('isfahan', p, 60, 'isfahanIM');
    for (const v of catalog.variantsByRef[p.ref]) addVariant('isfahan', prod, v, v.quantity || 0, 60, 'isfahanIM');
  }
  for (const [branch, rows] of Object.entries(BRANCH_STOCK)) {
    const by = `${branch}IM`;
    for (const [code, qty] of rows) {
      const src = sourceByCode[code];
      assert(src, `${code} is not in the catalog`);
      addVariant(branch, addProduct(branch, src.p, 45, by), src.v, qty, 45, by);
    }
  }
  out.report.inventory = BRANCHES.map((b) => ({
    branch: b.name,
    products: out.products.filter((p) => String(p.branchId) === String(ctx.branchIds[b.key])).length,
    variants: out.variants.filter((v) => String(v.branchId) === String(ctx.branchIds[b.key])).length,
  })).filter((x) => x.products);
  const productNameOf = (variant) => out.products.find((p) => String(p._id) === String(variant.productId)).name;
  const variantOf = (branch, code) => {
    const v = variants[`${branch}:${code}`];
    assert(v, `${code} is not stocked at ${branch}`);
    return v;
  };
  const productOf = (branch, code) => {
    const p = products[`${branch}:${code}`];
    assert(p, `product ${code} is not stocked at ${branch}`);
    return p;
  };
  // Live stock as the story plays out — every document is checked against it.
  const stock = {};
  for (const v of out.variants) stock[String(v._id)] = v.quantity;

  // ── customers ──
  const customers = {};
  for (const c of CUSTOMERS) {
    const _id = oid();
    const owner = uid(c.owner);
    const created = daysAgo(c.created);
    const channels = Object.keys(c.channels);
    const handles = {};
    for (const ch of channels) {
      const val = c.channels[ch];
      handles[ch] = typeof val === 'string' ? val : `${c.dial} ${c.phone}`;
    }
    const isCompany = c.type === 'company';
    const name = isCompany ? c.companyName : `${c.firstName} ${c.lastName}`;
    const followUp = c.followUpIn !== undefined ? daysAgo(-c.followUpIn) : undefined;
    const doc = {
      _id, inisialInsert: owner,
      personalInformation: {
        country: c.country, firstName: c.firstName || '', lastName: c.lastName || '',
        companyName: c.companyName || '', contactPerson: c.contactPerson || '',
        customerType: c.type, personOrCompany: c.type, attractedBy: c.attractedBy, favoriteProducts: [],
      },
      contactInfo: { phoneNumbers: [], emails: [], instagrams: [], linkedIns: [], websites: [], botims: [], facebooks: [] },
      address: [{ country: c.country, city: c.city, province: '', street: c.street, postalCode: '' }],
      phoneNumber: c.phone, phoneCountryCode: c.cc,
      commChannels: channels, commHandles: handles,
      status: c.status, tags: c.tags || [],
      lastCallAt: c.call ? daysAgo(c.call.on) : undefined,
      nextFollowUpAt: followUp,
      owner, assignedTo: [], createdBy: owner, trn: c.trn || '',
      interestedProducts: (c.interested || []).map((code) => ({ productId: productOf('isfahan', code)._id, note: '' })),
      communication: [], frequentBtnClick: [], explanations: '',
      insertDate: created, updateDate: c.call ? daysAgo(c.call.on) : created, updatedBy: owner, deleteDate: null,
    };
    out.customers.push(doc);
    customers[c.key] = { doc, name, address: [c.street, c.city, c.country].filter(Boolean).join(', ') };
    const act = (type, at, fields) => out.customerActivities.push({
      customerId: _id, type, ...fields, actorId: owner, actorName: nameOf(c.owner), date: at, createdAt: at,
    });
    act('created', created, {});
    if (c.call) act('call_logged', daysAgo(c.call.on), { field: 'channel', newValue: channels[0], body: c.call.body });
    if (c.status !== 'new') act('status_changed', daysAgo(c.call ? c.call.on : c.created, 5), { field: 'status', oldValue: 'new', newValue: c.status });
    if (followUp) act('follow_up_set', daysAgo(c.call ? c.call.on : c.created, 10), { oldValue: null, newValue: followUp });
  }

  // ── supply ──
  const records = {};
  const dealLetters = {};
  const supplyOrder = [...SUPPLY].sort((a, b) => b.on - a.on);   // oldest first: codes follow time
  supplyOrder.forEach((s, i) => {
    const product = productOf('isfahan', s.product);
    const code = formatCode('SR', ctx.srBase + i + 1);
    const rec = {
      _id: oid(), code, branchId: bid('isfahan'), productId: product._id,
      productCode: product.code, productName: product.name, title: s.title,
      date: daysAgo(s.on), notes: s.notes, dealLetterCount: s.dealLetters.length, status: 'active',
      insertDate: daysAgo(s.on), updateDate: daysAgo(Math.min(...s.dealLetters.map((d) => d.on))),
      createdBy: uid('isfahanIM'), updatedBy: uid('isfahanIM'),
    };
    records[s.key] = rec;
    out.records.push(rec);
    out.report.records.push({ code, product: product.code, title: s.title, dealLetters: s.dealLetters.map((d) => d.status) });

    for (const d of s.dealLetters) {
      const lines = d.lines.map((l) => {
        const v = variantOf('isfahan', l.code);
        assert(String(v.productId) === String(product._id), `${l.code} is not a variety of ${s.product}`);
        const qty = l.final !== undefined ? l.final : l.forecast;
        const sp = v.spec || {};
        // Contract columns, snapshotted the way the deal-letter form seeds them.
        let count = l.count !== undefined ? l.count : null;
        if (count === null && !sp.unsized && sp.lengthCm && sp.widthCm) {
          count = v.unit === 'ML'
            ? Math.round(qty / (sp.lengthCm / 100))
            : Math.round(qty / ((sp.lengthCm / 100) * (sp.widthCm / 100)));
        }
        return {
          variantId: v._id, variantCode: v.code, unit: v.unit,
          forecastQty: l.forecast, finalQty: l.final === undefined ? null : l.final,
          price: l.price === undefined ? null : l.price, currency: 'IRR',
          receivedQty: l.received || 0, allocatedQty: 0,
          stoneTypeLabel: v.code, count,
          widthCm: l.widthCm !== undefined ? l.widthCm : (sp.unsized ? null : sp.widthCm || null),
          lengthCm: l.lengthCm !== undefined ? l.lengthCm : (sp.unsized ? null : sp.lengthCm || null),
        };
      });
      if (d.status === 'final_product') assert(lines.every((l) => l.finalQty !== null), `${d.key} is final without final quantities`);
      const last = Math.min(...d.history.map((h) => h.on), d.on);
      const dl = {
        _id: oid(), supplyId: rec._id, branchId: rec.branchId, productId: product._id,
        coupeSpec: d.coupeSpec,
        coupeSeller: { customerId: null, name: d.seller.name, phone: d.seller.phone, notes: d.seller.notes },
        status: d.status, varietyLines: lines,
        contract: {
          number: d.contract.number, date: daysAgo(d.on),
          seller: { party: d.contract.sellerParty, addressPhone: d.contract.sellerAddressPhone },
          buyer: { ...BUYER },
          currency: 'IRR', totalInWords: '', paymentTerms: d.contract.paymentTerms,
          guarantee: d.contract.guarantee, validityDays: 3,
          settlementDays: d.contract.settlementDays, loadingDays: d.contract.loadingDays,
        },
        insertDate: daysAgo(d.on), updateDate: daysAgo(last, 30),
        createdBy: uid('isfahanIM'), updatedBy: uid('isfahanIM'),
      };
      dealLetters[d.key] = { doc: dl, record: rec };
      out.dealLetters.push(dl);

      // follow-up log, replayed in order
      let stage = 'purchasing';
      const by = uid('isfahanIM');
      const actorName = nameOf('isfahanIM');
      const log = (type, at, fields) => out.dealActivities.push({
        dealLetterId: dl._id, stage, type, ...fields, actorId: by, actorName, date: at, createdAt: at,
      });
      log('created', daysAgo(d.on), { body: 'Deal letter created' });
      d.history.forEach((h, idx) => {
        const at = daysAgo(h.on, 20 + idx * 7);
        if (h.note) log('note', at, { body: h.note });
        if (h.prices) log('price_updated', at, { body: 'Per-variety pricing updated' });
        if (h.finals) log('final_updated', at, { body: 'Final quantities recorded' });
        if (h.status) {
          const old = stage;
          stage = h.status;
          log('status_changed', at, { field: 'status', oldValue: old, newValue: h.status });
        }
        if (h.receive) {
          const recvLines = d.lines.filter((l) => l.received);
          log('received', at, { body: `Received ${recvLines.length} variety line(s) into warehouse` });
          out.stockEvents.push({
            at, kind: 'receive', dealLetterId: dl._id, actor: 'isfahanIM',
            lines: recvLines.map((l) => ({ variant: variantOf('isfahan', l.code), qty: l.received })),
          });
        }
      });
      assert(stage === d.status, `${d.key} history ends at ${stage}, not ${d.status}`);
    }
  });

  // ── invoices, quotations, requests ──
  // Numbers follow time, per branch and document type, from the counters' base.
  const ordered = DOCS.map((d, i) => ({ d, i })).sort((a, b) => (b.d.on - a.d.on) || (a.i - b.i)).map((x) => x.d);
  const nextNumber = {};
  const numbers = {};
  for (const d of ordered) {
    const k = `${d.branch}:${d.docType}`;
    nextNumber[k] = (nextNumber[k] || ctx.counterBase[k] || 0) + 1;
    numbers[d.key] = nextNumber[k];
  }
  out.counterUse = {};
  for (const [k, last] of Object.entries(nextNumber)) out.counterUse[k] = last - (ctx.counterBase[k] || 0);

  const docs = {};
  const labelOf = (d) => (d.docType === 'invoice' ? 'Invoice' : (d.requester ? 'Request' : 'Quotation'));
  const resolveLines = (d) => d.lines.map((l) => {
    if (l.dealLetter) {
      const dl = dealLetters[l.dealLetter];
      assert(dl, `unknown deal letter ${l.dealLetter}`);
      const line = dl.doc.varietyLines.find((x) => x.variantCode === l.code);
      assert(line, `${l.code} is not on ${l.dealLetter}`);
      return {
        productId: dl.doc.productId, variantId: line.variantId, code: line.variantCode, name: line.variantCode,
        unit: line.unit, quantity: l.quantity, unitPrice: l.unitPrice || 0, discount: 0, discountType: 'amount',
        vatRate: 0, sourceType: 'supply', supplyDealLetterId: dl.doc._id,
      };
    }
    const v = variantOf(d.branch, l.code);
    return {
      productId: v.productId, variantId: v._id, code: v.code, name: productNameOf(v), unit: v.unit,
      quantity: l.quantity, unitPrice: l.unitPrice || 0,
      discount: l.discount || 0, discountType: l.discountType || 'amount',
      vatRate: d.requester ? 0 : (d.vatRate || 0), sourceType: 'inventory',
    };
  });

  for (const d of ordered) {
    const _id = oid();
    const number = numbers[d.key];
    const creatorId = uid(d.by);
    const handler = d.handler || d.by;
    const created = daysAgo(d.on);
    const acts = [];
    const act = (type, at, fields, actor) => acts.push({
      invoiceId: _id, docType: d.docType, type, ...fields,
      actorId: uid(actor), actorName: nameOf(actor), date: at, createdAt: at,
    });

    let lines;
    let from = null;
    if (d.from) {
      from = docs[d.from];
      assert(from, `${d.key} converts from ${d.from}, which must come first`);
      lines = from.doc.lineItems.map((l) => ({ ...l }));   // same items → the reservation carries over
    } else {
      lines = resolveLines(d);
      if (d.priced) {
        assert(d.priced.prices.length === lines.length, `${d.key} prices do not match its lines`);
      }
    }
    // a request is created unpriced; Isfahan prices it later
    const finalLines = d.priced ? lines.map((l, i) => ({ ...l, unitPrice: d.priced.prices[i] })) : lines;
    const totals = computeTotals(finalLines, d.shipping || 0);

    const doc = {
      _id, branchId: bid(d.branch), docType: d.docType, docNumber: number,
      tradeMode: d.requester ? 'interBranch' : 'customer',
      status: d.docType === 'pre_invoice' ? (d.requester ? 'requested' : 'draft') : (d.status || 'draft'),
      issueDate: created,
      lineItems: totals.lines, currency: 'AED',
      subtotal: totals.subtotal, discountTotal: totals.discountTotal, vatTotal: totals.vatTotal,
      shipping: totals.shipping, grandTotal: totals.grandTotal,
      stockDecremented: false, assignedTo: [],
      notes: d.notes, insertDate: created, createdBy: creatorId,
    };
    if (d.requester) {
      doc.requestingBranchId = bid(d.requester);
      doc.requestingBranchSnapshot = { name: branchName(d.requester) };
    } else {
      const c = customers[d.customer || (from && from.spec.customer)];
      assert(c, `${d.key} has no customer`);
      doc.customerId = c.doc._id;
      doc.customerSnapshot = { name: c.name, trn: c.doc.trn || '', country: c.doc.personalInformation.country, phone: c.doc.phoneNumber, address: c.address };
    }
    if (d.docType === 'pre_invoice') doc.validityDays = d.requester ? 2 : d.validityDays;
    if (d.docType === 'invoice') {
      doc.issueTime = hhmm(created);
      doc.amountInWords = amountToArabicWords(totals.grandTotal);
      doc.salesRepId = creatorId;
      doc.salesRepName = nameOf(d.by);
    }
    const supplyLine = finalLines.find((l) => l.sourceType === 'supply');
    if (supplyLine) {
      const dl = Object.values(dealLetters).find((x) => String(x.doc._id) === String(supplyLine.supplyDealLetterId));
      doc.supplyRecordId = dl.record._id;
    }
    if (from && from.doc.supplyRecordId) doc.supplyRecordId = from.doc.supplyRecordId;
    if (from) doc.convertedFromPreInvoiceId = from.doc._id;

    // history
    let lastAt = created;
    let lastBy = d.by;
    if (from) {
      act('created', created, { body: `Converted from pre-invoice #${from.doc.docNumber}`, newValue: number }, d.by);
      if (from.committed) {
        doc.stockDecremented = true;
        act('stock_decremented', daysAgo(d.on, 1), {
          body: `Already out of stock — reserved when ${labelOf(from.spec).toLowerCase()} #${from.doc.docNumber} was accepted`,
        }, d.by);
      }
    } else {
      act('created', created, { newValue: number }, d.by);
    }
    if (d.priced) {
      act('updated', daysAgo(d.priced.on), {}, handler);
      lastAt = daysAgo(d.priced.on); lastBy = handler;
    }
    let status = doc.status;
    let committed = false;
    for (const [day, next] of (d.flow || [])) {
      const at = daysAgo(day, 10);
      const actor = d.requester ? handler : d.by;
      act('status', at, { field: 'status', oldValue: status, newValue: next }, actor);
      status = next;
      lastAt = at; lastBy = actor;
      if (next === 'accepted') {
        committed = true;
        out.stockEvents.push({ at: daysAgo(day, 11), kind: 'commit', docKey: d.key, actor, label: `${labelOf(d)} #${number} accepted` });
        act('stock_decremented', daysAgo(day, 11), {
          body: `${labelOf(d)} #${number} accepted`,
          newValue: finalLines.filter((l) => l.variantId).length,
        }, actor);
      }
    }
    // payments: each entry is the payment block after that payment
    const payment = { cash: 0, chequeBank: 0, card: 0, remaining: totals.grandTotal, currentBalance: totals.grandTotal, balanceSign: 'debit' };
    for (const p of (d.payments || [])) {
      const at = daysAgo(p.on, 10);
      const known = ['cash', 'chequeBank', 'card'].reduce((s, k) => s + (typeof p[k] === 'number' ? p[k] : 0), 0);
      const amount = (k) => (p[k] === 'rest' ? round2(totals.grandTotal - known) : round2(p[k] || 0));
      const before = payment.remaining;
      payment.cash = amount('cash'); payment.chequeBank = amount('chequeBank'); payment.card = amount('card');
      const paid = round2(payment.cash + payment.chequeBank + payment.card);
      payment.remaining = round2(totals.grandTotal - paid);
      payment.currentBalance = payment.remaining;
      payment.balanceSign = payment.remaining <= 0 ? 'credit' : 'debit';
      const derived = payment.remaining <= 0 ? 'paid' : (paid > 0 ? 'partially_paid' : 'issued');
      if (derived !== status) {
        act('status', at, { field: 'status', oldValue: status, newValue: derived }, d.by);
        status = derived;
        if (status === 'paid' && !doc.stockDecremented) {
          committed = true;
          out.stockEvents.push({ at: daysAgo(p.on, 11), kind: 'commit', docKey: d.key, actor: d.by, label: `Invoice #${number}` });
          act('stock_decremented', daysAgo(p.on, 11), {
            body: `Invoice #${number}`, newValue: finalLines.filter((l) => l.variantId).length,
          }, d.by);
        }
      }
      act('payment', daysAgo(p.on, 12), {
        oldValue: before, newValue: payment.remaining,
        body: `Cash ${payment.cash} · Cheque/Bank ${payment.chequeBank} · Card ${payment.card}`,
      }, d.by);
      lastAt = daysAgo(p.on, 12); lastBy = d.by;
    }
    if (d.docType === 'invoice') doc.payment = payment;
    if (committed) doc.stockDecremented = true;
    doc.status = status;
    if (lastAt > created) { doc.updateDate = lastAt; doc.updatedBy = uid(lastBy); }

    docs[d.key] = { spec: d, doc, acts, committed, lines: finalLines };
    out.invoices.push(doc);
  }

  // conversions: the quotation / request points at its invoice and hands it
  // the reservation
  for (const d of ordered) {
    if (!d.convert) continue;
    const pre = docs[d.key];
    const inv = docs[d.convert.into];
    assert(inv && inv.spec.from === d.key, `${d.key} converts into ${d.convert.into}, which must convert from it`);
    assert(pre.doc.status === 'accepted', `${d.key} must be accepted before it is converted`);
    const at = daysAgo(d.convert.on);
    pre.doc.status = 'converted';
    pre.doc.convertedToInvoiceId = inv.doc._id;
    pre.doc.updateDate = at;
    pre.doc.updatedBy = uid(inv.spec.by);
    if (pre.committed) pre.doc.stockDecremented = false;   // the invoice holds it now
    pre.acts.push({
      invoiceId: pre.doc._id, docType: 'pre_invoice', type: 'converted', newValue: inv.doc.docNumber,
      actorId: uid(inv.spec.by), actorName: nameOf(inv.spec.by), date: at, createdAt: at,
    });
  }
  for (const d of ordered) {
    out.invoiceActivities.push(...docs[d.key].acts);
    const x = docs[d.key].doc;
    out.report.docs.push({
      branch: branchName(d.branch), number: x.docNumber, docType: x.docType, tradeMode: x.tradeMode,
      party: x.tradeMode === 'interBranch' ? `${x.requestingBranchSnapshot.name} → ${branchName(d.branch)}` : x.customerSnapshot.name,
      status: x.status, total: x.grandTotal, stock: x.stockDecremented,
    });
  }

  // ── replay stock (receives + commits) in time order, checking it never goes negative ──
  out.stockEvents.sort((a, b) => a.at - b.at);
  const allocated = {};   // `${dealLetterId}:${variantId}` → qty
  for (const e of out.stockEvents) {
    if (e.kind === 'receive') {
      for (const { variant, qty } of e.lines) stock[String(variant._id)] = round4(stock[String(variant._id)] + qty);
      continue;
    }
    const dd = docs[e.docKey];
    e.doc = dd.doc;
    for (const l of dd.lines) {
      if (l.sourceType === 'supply') {
        const dl = out.dealLetters.find((x) => String(x._id) === String(l.supplyDealLetterId));
        const line = dl.varietyLines.find((x) => String(x.variantId) === String(l.variantId));
        const k = `${dl._id}:${l.variantId}`;
        const base = dl.status === 'final_product' ? (line.finalQty || 0) - (line.receivedQty || 0) : (line.forecastQty || 0);
        assert(l.quantity <= base - (allocated[k] || 0), `${e.label}: ${l.code} is more than is left in its lot`);
        allocated[k] = round4((allocated[k] || 0) + l.quantity);
        continue;
      }
      const left = stock[String(l.variantId)];
      assert(l.quantity <= left, `${e.label}: ${l.code} needs ${l.quantity}, only ${left} in stock`);
      stock[String(l.variantId)] = round4(left - l.quantity);
    }
  }
  out.finalAllocated = allocated;

  // Documents that never took stock must still have been possible when made:
  // inventory lines within what was in stock at the time.
  for (const d of ordered) {
    const dd = docs[d.key];
    if (dd.committed || d.from) continue;
    const at = daysAgo(d.on);
    for (const l of dd.lines) {
      if (l.sourceType === 'supply') continue;
      const v = out.variants.find((x) => String(x._id) === String(l.variantId));
      let qty = v.quantity;
      for (const e of out.stockEvents) {
        if (e.at > at) break;
        if (e.kind === 'receive') { for (const r of e.lines) if (String(r.variant._id) === String(v._id)) qty += r.qty; continue; }
        for (const x of docs[e.docKey].lines) if (x.sourceType !== 'supply' && String(x.variantId) === String(v._id)) qty -= x.quantity;
      }
      assert(l.quantity <= round4(qty), `${d.key}: ${l.code} asks for ${l.quantity}, only ${round4(qty)} in stock on that day`);
    }
  }

  // ── packing lists ──
  const packOrder = [...PACKING].sort((a, b) => b.on - a.on);
  let reference = 600;
  packOrder.forEach((pl, i) => {
    const number = (ctx.counterBase['isfahan:packing_list'] || 0) + i + 1;
    const invoiceDocs = (pl.invoices || []).map((k) => { assert(docs[k], `unknown invoice ${k}`); return docs[k].doc; });
    const allowed = new Set();
    for (const inv of invoiceDocs) for (const li of inv.lineItems) allowed.add(productPrefix(li.code));
    const pallets = pl.pallets.map((items, idx) => {
      reference += 1;
      const built = items.map((it) => {
        const v = variantOf('isfahan', it.code);
        const sp = v.spec || {};
        const lengthCm = it.lengthCm !== undefined ? it.lengthCm : sp.lengthCm;
        const widthCm = it.widthCm !== undefined ? it.widthCm : sp.widthCm;
        assert(lengthCm && widthCm, `${it.code} needs a cut size on ${pl.key}`);
        if (pl.type === 'linked') assert(allowed.has(productPrefix(it.code)), `${it.code} is not on the invoices linked to ${pl.key}`);
        return {
          code: v.code, lengthCm, widthCm, thicknessCm: sp.thicknessMm ? sp.thicknessMm / 10 : pl.thickness,
          pcs: it.pcs, sqm: round2((lengthCm / 100) * (widthCm / 100) * it.pcs),
        };
      });
      const first = variantOf('isfahan', items[0].code);
      const sp = first.spec || {};
      const form = sp.unsized ? 'slab' : (first.unit === 'ML' ? 'strip' : 'tile');
      const fill = sp.fill === 'F' ? 'FLD' : (sp.fill === 'U' ? 'UNFLD' : null);
      return {
        palletId: `P${idx + 1}`, reference: String(reference).padStart(5, '0'),
        productCode: productPrefix(items[0].code),
        processingType: fill ? `${fill} (${form})` : form.charAt(0).toUpperCase() + form.slice(1),
        items: built,
      };
    });
    let totalSqm = 0, totalPcs = 0;
    for (const p of pallets) for (const it of p.items) { totalSqm += it.sqm; totalPcs += it.pcs; }
    const codes = new Set(pallets.flatMap((p) => p.items.map((it) => productPrefix(it.code))));
    const at = daysAgo(pl.on);
    const doc = {
      _id: oid(), branchId: bid('isfahan'), docNumber: number, type: pl.type,
      invoiceIds: invoiceDocs.map((x) => x._id),
      productId: codes.size === 1 ? productOf('isfahan', [...codes][0])._id : null,
      supplyRecordId: pl.supplyRecord ? records[pl.supplyRecord]._id : null,
      driverInfo: { ...DRIVERS[pl.driver] }, vehicleInfo: { ...TRUCKS[pl.truck] },
      customsAgent: pl.customs ? { ...CUSTOMS[pl.customs] } : { name: '', phone: '' },
      loadingOfficer: { name: nameOf('isfahanIM'), phone: userById.isfahanIM.phone },
      originAddress: pl.origin, destinationAddress: pl.destination,
      shippingDestination: pl.shippingDestination, standardThicknessCm: pl.thickness,
      pallets, totals: { totalPallets: pallets.length, totalSqm: round2(totalSqm), totalPcs },
      status: pl.status, notes: pl.notes,
      insertDate: at, updateDate: pl.status === 'final' ? daysAgo(pl.on, 240) : null,
      createdBy: uid('isfahanIM'), updatedBy: uid('isfahanIM'),
    };
    out.packingLists.push(doc);
    const actorId = uid('isfahanIM');
    const actorName = nameOf('isfahanIM');
    out.packingActivities.push({ packingListId: doc._id, type: 'created', body: `Packing list #${number} created`, actorId, actorName, date: at, createdAt: at });
    if (pl.status === 'final') {
      const done = daysAgo(pl.on, 240);
      out.packingActivities.push({ packingListId: doc._id, type: 'updated', field: 'status', oldValue: 'draft', newValue: 'final', actorId, actorName, date: done, createdAt: done });
    }
    out.report.packing.push({
      number, type: pl.type, status: pl.status,
      linked: invoiceDocs.map((x) => `INV #${x.docNumber}`).join(', '),
      supply: pl.supplyRecord ? records[pl.supplyRecord].code : '',
      ...doc.totals,
    });
  });
  out.counterUse['isfahan:packing_list'] = PACKING.length;

  out.finalStock = stock;
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// RUN
// ═════════════════════════════════════════════════════════════════════════════
const maskUri = (uri) => uri.replace(/\/\/([^@/]+)@/, '//***@');

async function main() {
  await dbConnection.asPromise();
  console.log(`Database: ${maskUri(process.env.DB_CONNECT)} (${dbConnection.name})`);
  console.log(APPLY ? '*** APPLY — writing ***\n' : '--- DRY RUN — nothing is written (add --yes to apply) ---\n');

  // ── pre-flight: refuse anything that would collide ──
  const problems = [];
  const takenPhones = await User.find({ phoneNumber: { $in: USERS.map((u) => u.phone) } }).select('phoneNumber').lean();
  if (takenPhones.length) problems.push(`users already exist with ${takenPhones.map((u) => u.phoneNumber).join(', ')} — this database looks seeded already`);
  const takenCustomers = await Customer.find({ phoneNumber: { $in: CUSTOMERS.map((c) => c.phone) }, deleteDate: null }).select('phoneNumber').lean();
  if (takenCustomers.length) problems.push(`customers already exist with ${takenCustomers.map((c) => c.phoneNumber).join(', ')}`);
  const existingBranches = await Branch.find({ name: { $in: BRANCHES.map((b) => b.name) }, deleteDate: null }).lean();
  for (const b of existingBranches) {
    const n = await InvProduct.countDocuments({ branchId: b._id, deleteDate: null });
    if (n) problems.push(`branch "${b.name}" already has ${n} inventory product(s)`);
  }
  if (problems.length) {
    console.error('Stopped before writing anything:');
    for (const p of problems) console.error(`  • ${p}`);
    console.error('\nThis seed is for a fresh test database. Point it at an empty one with --db "<uri>".');
    process.exitCode = 1;
    return;
  }

  // ── ids: reuse what's there, create the rest ──
  const branchIds = {};
  for (const b of BRANCHES) {
    const found = existingBranches.find((x) => x.name === b.name);
    branchIds[b.key] = found ? found._id : oid();
  }
  const superAdminRole = await Role.findOne({ isSuperAdmin: true, deleteDate: null }).lean()
    || await Role.findOne({ name: 'Admin', deleteDate: null }).lean();
  const supplyRole = await Role.findOne({ name: 'SupplyManager', deleteDate: null }).lean();
  const managerRole = await Role.findOne({ name: BRANCH_MANAGER_ROLE.name, deleteDate: null }).lean();
  const roleIds = {
    superAdmin: superAdminRole ? superAdminRole._id : oid(),
    supplyManager: supplyRole ? supplyRole._id : oid(),
    branchManager: managerRole ? managerRole._id : oid(),
  };
  const userIds = Object.fromEntries(USERS.map((u) => [u.key, oid()]));

  const unknownKeys = BRANCH_MANAGER_ROLE.permissions.filter((k) => !ALL_KEYS.includes(k));
  if (unknownKeys.length) throw new Error(`Role uses keys missing from the catalog: ${unknownKeys.join(', ')}`);

  // ── numbering: document counters per branch + supply record codes ──
  const counterKeys = new Set([...DOCS.map((d) => `${d.branch}:${d.docType}`), 'isfahan:packing_list']);
  const counterBase = {};
  for (const k of counterKeys) {
    const [branch, docType] = k.split(':');
    const c = await InvoiceCounter.findOne({ branchId: branchIds[branch], docType }).lean();
    counterBase[k] = c ? c.seq : 0;
  }
  const srSeq = await Sequence.findOne({ key: 'supplyRecord' }).lean();
  let srBase = srSeq ? srSeq.seq : 0;

  // dry run: build against the current counters and report
  let plan = build({ branchIds, roleIds, userIds, counterBase, srBase });

  const profileFile = path.join(__dirname, 'launchData', 'companyprofiles.json');
  const hasProfile = await CompanyProfile.findOne({ branchId: null }).lean();   // also matches docs without the field

  report(plan, { existingBranches, superAdminRole, supplyRole, managerRole, hasProfile, profileFile });

  if (!APPLY) {
    console.log('\nDry run complete. Nothing was written. Re-run with --yes to apply.');
    return;
  }

  // ── apply ──
  // Build every index first: the unique ones guard this run, and the app
  // expects them anyway.
  for (const M of [Permission, Role, Branch, CompanyProfile, User, UserAccess, Customer, CustomerActivity,
    InvProduct, InvVariant, InvChangeLog, SupplyRecord, SupplyDealLetter, SupplyDealLetterActivity,
    MisInvoice, InvoiceActivity, InvoiceCounter, MisPackingList, MisPackingListActivity, Sequence]) {
    await M.init();
  }

  // Reserve the numbers atomically, then rebuild from what was actually
  // reserved (identical to the dry run unless something else wrote meanwhile).
  for (const [k, count] of Object.entries(plan.counterUse)) {
    const [branch, docType] = k.split(':');
    const c = await InvoiceCounter.findOneAndUpdate(
      { branchId: branchIds[branch], docType }, { $inc: { seq: count } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    counterBase[k] = c.seq - count;
  }
  const sr = await Sequence.findOneAndUpdate(
    { key: 'supplyRecord' }, { $inc: { seq: SUPPLY.length } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  srBase = sr.seq - SUPPLY.length;
  plan = build({ branchIds, roleIds, userIds, counterBase, srBase });

  const step = (label, n) => console.log(`  ${label.padEnd(30)} ${n}`);
  console.log('\nWriting:');

  // catalog: permissions are upserted (same as seedPermissions.js); starter
  // roles created when missing, Admin synced to the whole catalog.
  for (const p of PERMISSIONS) await Permission.updateOne({ key: p.key }, { $set: p }, { upsert: true });
  step('permissions (upserted)', PERMISSIONS.length);
  for (const r of ROLES) {
    const existing = await Role.findOne({ name: r.name, deleteDate: null }).lean();
    if (r.isSuperAdmin) {
      if (existing || superAdminRole) {
        await Role.updateOne({ _id: roleIds.superAdmin }, { $set: { permissions: ALL_KEYS, isSystem: true, isSuperAdmin: true } });
      } else {
        await Role.create({ ...r, _id: roleIds.superAdmin });
      }
    } else if (!existing) {
      await Role.create(r.name === 'SupplyManager' ? { ...r, _id: roleIds.supplyManager } : r);
    }
  }
  if (!managerRole) await Role.create({ ...BRANCH_MANAGER_ROLE, _id: roleIds.branchManager });
  step('roles', `${ROLES.length} starter + ${BRANCH_MANAGER_ROLE.name}`);

  for (const b of BRANCHES) {
    if (existingBranches.some((x) => x.name === b.name)) continue;
    await Branch.create({
      _id: branchIds[b.key], name: b.name, description: b.description, country: b.country,
      address: b.address, status: 'active', insertDate: daysAgo(62), createdBy: userIds.admin1,
    });
  }
  for (const [owner, shared] of Object.entries(SHARES)) {
    await Branch.updateOne({ _id: branchIds[owner] }, { $addToSet: { crossBranchAccess: { $each: shared.map((k) => branchIds[k]) } } });
  }
  step('branches', BRANCHES.map((b) => b.name).join(', '));

  if (!hasProfile && fs.existsSync(profileFile)) {
    const src = EJSON.parse(fs.readFileSync(profileFile, 'utf8'))[0] || {};
    const { _id, __v, updatedBy, updateDate, ...profile } = src;
    await CompanyProfile.create({ ...profile, key: 'default', branchId: null, updateDate: new Date() });
    step('company profile', 1);
  }

  await User.insertMany(plan.users);
  await UserAccess.insertMany(plan.userAccesses);
  step('users', plan.users.length);

  await Customer.insertMany(plan.customers);
  await CustomerActivity.insertMany(plan.customerActivities);
  step('customers', plan.customers.length);

  await InvProduct.insertMany(plan.products);
  await InvVariant.insertMany(plan.variants);
  await InvChangeLog.insertMany(plan.changeLogs);
  step('inventory products / varieties', `${plan.products.length} / ${plan.variants.length}`);

  await SupplyRecord.insertMany(plan.records);
  await SupplyDealLetter.insertMany(plan.dealLetters);
  await SupplyDealLetterActivity.insertMany(plan.dealActivities);
  step('supply records / deal letters', `${plan.records.length} / ${plan.dealLetters.length}`);

  await MisInvoice.insertMany(plan.invoices);
  await InvoiceActivity.insertMany(plan.invoiceActivities);
  step('invoices, quotations, requests', plan.invoices.length);

  // Stock, in the order it happened: receives into the warehouse, then each
  // accepted / paid document taking its quantities, with a change-log row.
  const touchedProducts = new Set();
  for (const e of plan.stockEvents) {
    if (e.kind === 'receive') {
      for (const { variant, qty } of e.lines) {
        const v = await InvVariant.findById(variant._id).lean();
        const newQty = round4((v.quantity || 0) + qty);
        await InvVariant.updateOne({ _id: v._id }, { $set: { quantity: newQty, updateDate: e.at } });
        await InvChangeLog.create({
          subjectType: 'variant', subjectId: v._id, productId: v.productId, changeType: 'quantity', field: 'quantity',
          oldValue: v.quantity, newValue: newQty, delta: qty, unit: v.unit,
          reason: `Received from Supply deal letter (${e.dealLetterId})`, source: 'supply',
          changedBy: userIds[e.actor], changedByName: fullName(e.actor), date: e.at, createdAt: e.at,
        });
        touchedProducts.add(String(v.productId));
      }
      continue;
    }
    for (const li of e.doc.lineItems) {
      if (li.sourceType === 'supply') {
        await SupplyDealLetter.updateOne(
          { _id: li.supplyDealLetterId, 'varietyLines.variantId': li.variantId },
          { $inc: { 'varietyLines.$.allocatedQty': li.quantity } },
        );
        continue;
      }
      const v = await InvVariant.findById(li.variantId).lean();
      const newQty = round4((v.quantity || 0) - li.quantity);
      await InvVariant.updateOne({ _id: v._id }, { $set: { quantity: newQty, updateDate: e.at } });
      await InvChangeLog.create({
        subjectType: 'variant', subjectId: v._id, productId: v.productId, changeType: 'quantity', field: 'quantity',
        oldValue: v.quantity, newValue: newQty, delta: -li.quantity, unit: v.unit,
        reason: e.label, source: 'order',
        changedBy: userIds[e.actor], changedByName: fullName(e.actor), date: e.at, createdAt: e.at,
      });
      touchedProducts.add(String(v.productId));
    }
  }
  step('stock movements', plan.stockEvents.length);

  // Rollups: every product's stock totals, then the supply figures shown next
  // to them (forecast / final-unreceived, minus what accepted documents hold).
  for (const p of plan.products) await recomputeRollup(p._id);
  const supplyVariants = new Set();
  for (const dl of plan.dealLetters) for (const l of dl.varietyLines) supplyVariants.add(String(l.variantId));
  for (const vid of supplyVariants) await recomputeVariantSupplyRollup(vid);
  for (const p of new Set(plan.dealLetters.map((dl) => String(dl.productId)))) await recomputeProductSupplyRollup(p);
  step('rollups', `${plan.products.length} products, ${supplyVariants.size} supply varieties`);

  await MisPackingList.insertMany(plan.packingLists);
  await MisPackingListActivity.insertMany(plan.packingActivities);
  step('packing lists', plan.packingLists.length);

  // what the app will read back, as a check
  const finalChecks = [];
  for (const [id, expected] of Object.entries(plan.finalStock)) {
    const v = await InvVariant.findById(id).select('code quantity').lean();
    if (round4(v.quantity) !== round4(expected)) finalChecks.push(`${v.code}: ${v.quantity}, expected ${expected}`);
  }
  for (const [k, qty] of Object.entries(plan.finalAllocated)) {
    const [dlId, vid] = k.split(':');
    const dl = await SupplyDealLetter.findById(dlId).lean();
    const line = dl.varietyLines.find((l) => String(l.variantId) === vid);
    if (round4(line.allocatedQty) !== round4(qty)) finalChecks.push(`${line.variantCode} allocated ${line.allocatedQty}, expected ${qty}`);
  }
  if (finalChecks.length) {
    console.error('\nStock does not match the plan:');
    for (const c of finalChecks) console.error(`  • ${c}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nDone. Sign in with any phone number above; the passwords come with the deployment notes.');
}

function report(plan, info) {
  const n = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });
  console.log('Catalog:   permissions', PERMISSIONS.length, '· starter roles', ROLES.map((r) => r.name).join(', '));
  console.log(`           role "${BRANCH_MANAGER_ROLE.name}": ${info.managerRole ? 'exists, kept as is' : `new, ${BRANCH_MANAGER_ROLE.permissions.length} permissions`}`);
  console.log('Branches: ', BRANCHES.map((b) => `${b.name}${info.existingBranches.some((x) => x.name === b.name) ? ' (exists)' : ''}`).join(', '),
    `· Isfahan shared with ${SHARES.isfahan.map((k) => BRANCHES.find((b) => b.key === k).name).join(' + ')}`);
  console.log('Profile:  ', info.hasProfile ? 'company profile exists, kept' : (fs.existsSync(info.profileFile) ? 'from scripts/launchData/companyprofiles.json' : 'none (launchData file missing)'));

  console.log('\nUsers:');
  for (const u of USERS) {
    const a = ACCESS[u.key];
    const roles = a.roles.map((r) => ({ superAdmin: 'Admin (superAdmin)', branchManager: BRANCH_MANAGER_ROLE.name, supplyManager: 'SupplyManager' }[r])).join(' + ');
    const branches = a.branches.map((k) => BRANCHES.find((b) => b.key === k).name).join(', ');
    console.log(`  ${u.phone}  ${`${u.firstName} ${u.lastName}`.padEnd(28)} ${roles.padEnd(42)} ${branches}${a.grants ? `  + ${a.grants.join(', ')}` : ''}`);
  }

  console.log(`\nCustomers: ${plan.customers.length}`);
  console.log(`Inventory: ${plan.report.inventory.map((x) => `${x.branch} ${x.products} products / ${x.variants} varieties`).join(' · ')}`);
  console.log(`           (Isfahan copied from: ${plan.report.catalogSource})`);

  console.log('\nSupply (Isfahan):');
  for (const r of plan.report.records) console.log(`  ${r.code}  ${r.product.padEnd(5)} ${r.title.padEnd(46)} deal letters: ${r.dealLetters.join(', ')}`);

  console.log('\nInvoices / quotations / requests:');
  const rank = (d) => `${BRANCHES.findIndex((b) => b.name === d.branch)}${d.docType === 'invoice' ? 1 : 0}${String(d.number).padStart(5, '0')}`;
  for (const d of [...plan.report.docs].sort((a, b) => rank(a).localeCompare(rank(b)))) {
    const kind = d.docType === 'invoice' ? 'INV' : (d.tradeMode === 'interBranch' ? 'REQ' : 'QUO');
    console.log(`  ${d.branch.padEnd(8)} ${kind} #${String(d.number).padEnd(3)} ${d.status.padEnd(15)} ${d.party.padEnd(32)} AED ${n(d.total).padStart(12)}${d.stock ? '  (stock taken)' : ''}`);
  }

  console.log('\nPacking lists (Isfahan):');
  for (const p of plan.report.packing) {
    console.log(`  PL #${String(p.number).padEnd(3)} ${p.type.padEnd(7)} ${p.status.padEnd(6)} ${String(p.totalPallets).padStart(2)} pallets ${String(p.totalPcs).padStart(5)} pcs ${n(p.totalSqm).padStart(8)} m²  ${p.linked || ''}${p.supply ? `supply ${p.supply}` : ''}`);
  }
}

main()
  .catch((err) => {
    console.error('\nFAILED:', err.message);
    if (APPLY) console.error('Writes are not transactional — drop the test database and run again.');
    process.exitCode = 1;
  })
  .finally(async () => {
    dbConnection.removeAllListeners('disconnected');
    await dbConnection.close().catch(() => {});
  });
