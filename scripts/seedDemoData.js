#!/usr/bin/env node
/**
 * Demo data for a local XMS.
 *
 *   node scripts/seedDemoData.js                 # dry run - says exactly what it would do
 *   node scripts/seedDemoData.js --yes           # does it
 *   node scripts/seedDemoData.js --db "<uri>"    # a database other than .env's DB_CONNECT
 *
 * KEEPS, and never writes to:
 *   the people and their access  - users, userAccesses, roles, permissions, groups
 *   the branches and settings    - branches, companyProfiles, pwaSubscriptions
 *   the inventory catalogue      - products, variants, categories, change logs, their media
 *   the website's own content    - product pages, categories/tags, blog posts
 *
 * CLEARS and refills everything else, so every section of the app has a fresh, consistent
 * set to demo: CRM, MIS (quotations / invoices / inter-branch requests / packing lists),
 * Supply, website price requests and offers, Digital Marketing, Tutorials, tasks,
 * notifications and the File Manager.
 *
 * It refuses a database that is not on localhost unless --force-remote is passed, and it
 * never touches a file on disk that it did not write itself.
 */
const path = require('path');
const fs = require('fs');

// ── arguments / environment ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--yes');
const FORCE_REMOTE = argv.includes('--force-remote');
// Demo testing is pointless from an account that cannot see the branch the data is in:
// this grants every kept user the seeded branches (additive, never removes one).
const OPEN_BRANCHES = argv.includes('--open-branches');
const dbAt = argv.indexOf('--db');
const DB_OVERRIDE = dbAt === -1 ? null : argv[dbAt + 1];
if (dbAt !== -1 && (!DB_OVERRIDE || DB_OVERRIDE.startsWith('--'))) {
  console.error('--db needs a MongoDB connection string, e.g. --db "mongodb://localhost:27017/xms"');
  process.exit(1);
}
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (DB_OVERRIDE) process.env.DB_CONNECT = DB_OVERRIDE;
if (!process.env.DB_CONNECT) {
  console.error('DB_CONNECT is not set. Put it in api/.env or pass --db "<mongodb uri>"');
  process.exit(1);
}
const URI = process.env.DB_CONNECT;
const isLocal = /(^|@|\/\/)(localhost|127\.0\.0\.1)(:|\/)/.test(URI);
if (!isLocal && !FORCE_REMOTE) {
  console.error(`Refusing: ${URI.replace(/\/\/[^@]*@/, '//<credentials>@')} is not a localhost database.`);
  console.error('This script deletes data. Pass --force-remote only if you really mean that one.');
  process.exit(1);
}

const mongoose = require('mongoose');
const dbConnection = require('../connections/xmsPr');
const { recomputeRollup } = require('../utils/inventoryRollup');
const { recomputeVariantSupplyRollup, recomputeProductSupplyRollup } = require('../utils/supplyRollup');
const { amountToArabicWords } = require('../utils/arabicWords');

const model = (name, file) =>
  dbConnection.models[name] || dbConnection.model(name, require(`../models/${file}`));

const Branch          = model('branch', 'branchModel');
const User            = model('user', 'userModel');
const UserAccess      = model('userAccess', 'userAccessModel');
const Role            = model('role', 'roleModel');
const InvProduct      = model('inventoryProduct', 'inventoryProductModel');
const InvVariant      = model('inventoryVariant', 'inventoryVariantModel');
const InvChangeLog    = model('inventoryChangeLog', 'inventoryChangeLogModel');
const Customer        = model('customer', 'customerModel');
const CustomerActivity= model('customerActivity', 'customerActivityModel');
const MisInvoice      = model('misInvoice', 'misInvoiceModel');
const InvoiceActivity = model('invoiceActivity', 'invoiceActivityModel');
const InvoiceCounter  = model('invoiceCounter', 'invoiceCounterModel');
const MisPackingList  = model('misPackingList', 'misPackingListModel');
const MisPackingListActivity = model('misPackingListActivity', 'misPackingListActivityModel');
const SupplyRecord    = model('supplyRecord', 'supplyRecordModel');
const SupplyDealLetter= model('supplyDealLetter', 'supplyDealLetterModel');
const SupplyDealLetterActivity = model('supplyDealLetterActivity', 'supplyDealLetterActivityModel');
const PriceRequest    = model('priceRequest', 'priceRequestModel');
const RawContent      = model('rawContent', 'rawContentModel');
const RawContentChat  = model('rawContentChat', 'rawContentChatModel');
const ReadyToUpload   = model('readyToUpload', 'readyToUploadModel');
const DmActivity      = model('dmActivity', 'dmActivityModel');
const ExternalLinkPage= model('externalLinkPage', 'externalLinkPageModel');
const WhatsappShare   = model('whatsappShare', 'whatsappShareModel');
const Tutorial        = model('tutorial', 'tutorialModel');
const TutorialActivity= model('tutorialActivity', 'tutorialActivityModel');
const Task            = model('task', 'taskModel');
const Notification    = model('notification', 'notificationModel');
const FileModel       = model('file', 'fileModel');
const FolderModel     = model('folder', 'folderModel');
const FileActivity    = model('fileActivity', 'fileActivityModel');
const { Sequence } = require('../utils/sequence');

// ── helpers ─────────────────────────────────────────────────────────────────
const oid = () => new mongoose.Types.ObjectId();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const NOW = new Date();
function daysAgo(n, minute = 0) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  d.setHours(9, 0, 0, 0);
  return new Date(d.getTime() + minute * 60000);
}
const hoursFromNow = (h) => new Date(NOW.getTime() + h * 3600 * 1000);
const pick = (arr, i) => arr[i % arr.length];
const n2 = (v) => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// the server's own money rule (routes/mis/invoices.js computeTotals), so a demo document
// adds up exactly like one the app made
function computeTotals(lineItems, shipping = 0) {
  let subtotal = 0, discountTotal = 0, vatTotal = 0;
  const items = lineItems.map((li) => {
    const base = (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0);
    const discountAmount = li.discountType === 'percent'
      ? base * (Number(li.discount) || 0) / 100
      : (Number(li.discount) || 0);
    const net = base - discountAmount;
    const vatAmount = net * (Number(li.vatRate) || 0) / 100;
    subtotal += base; discountTotal += discountAmount; vatTotal += vatAmount;
    return { ...li, vatAmount: round2(vatAmount), lineTotal: round2(net + vatAmount) };
  });
  const grandTotal = round2(subtotal - discountTotal + vatTotal + (Number(shipping) || 0));
  return { items, subtotal: round2(subtotal), discountTotal: round2(discountTotal), vatTotal: round2(vatTotal), grandTotal };
}

// Collections this script owns: emptied, then refilled. Everything not named here is
// left exactly as it is.
const CLEARED = [
  'customers', 'customeractivities',
  'misinvoices', 'invoiceactivities', 'invoicecounters',
  'mispackinglists', 'mispackinglistactivities',
  'supplyrecords', 'supplydealletters', 'supplydealletteractivities', 'sequences',
  'pricerequests', 'websiteproductpreviews', 'websiteemailotps',
  'rawcontents', 'rawcontentchats', 'readytouploads', 'dmactivities',
  'externallinkpages', 'whatsappshares',
  'tutorials', 'tutorialactivities',
  'tasks', 'notifications', 'usernotes',
  'fileactivities', 'filefolderstags', 'folders',
  'links', 'shortlinks', 'uploadsessions', 'ghostsessions',
  // retired modules, and the legacy pair the Project Manager used
  'userjobreports', 'products', 'invoices',
];
// Files are mixed: inventory media and the website's gallery belong to data we keep.
const KEPT_FILE_SCOPES = ['inventory'];
const KEPT_FILE_ATTACH = ['websiteProduct'];

const KEPT = [
  'users', 'useraccesses', 'roles', 'permissions', 'groups',
  'branches', 'companyprofiles', 'pwasubscriptions',
  'inventoryproducts', 'inventoryvariants', 'inventorycategories', 'inventorychangelogs',
  'websiteproductcontents', 'websiteproducttaxonomies', 'blogposts',
];

// ── the demo itself ─────────────────────────────────────────────────────────
const CUSTOMERS = [
  { company: 'Al Fahad Marble & Granite', contact: 'Khalid Al Fahad', country: 'AE', city: 'Dubai', phone: '+971501234567', status: 'won',       tags: ['wholesale', 'repeat'],   channels: ['whatsApp', 'email'],            trn: '100123456700003' },
  { company: 'Gulf Stone Trading LLC',    contact: 'Mariam Al Suwaidi', country: 'AE', city: 'Sharjah', phone: '+971502345678', status: 'active', tags: ['wholesale'],             channels: ['whatsApp', 'email', 'instagram'], trn: '100223456700003' },
  { company: 'Riyadh Facades Co.',        contact: 'Faisal Al Harbi',  country: 'SA', city: 'Riyadh', phone: '+966551234567', status: 'follow_up', tags: ['project', 'facade'],   channels: ['whatsApp'] },
  { company: 'Jeddah Interiors',          contact: 'Noura Al Qahtani', country: 'SA', city: 'Jeddah', phone: '+966552345678', status: 'active',   tags: ['interior'],             channels: ['email', 'telegram'] },
  { company: 'Doha Build Partners',       contact: 'Yousef Al Thani',  country: 'QA', city: 'Doha',   phone: '+97450123456', status: 'new',       tags: ['project'],              channels: ['whatsApp', 'email'] },
  { company: 'Kuwait Stone House',        contact: 'Dalal Al Sabah',   country: 'KW', city: 'Kuwait City', phone: '+96550123456', status: 'follow_up', tags: ['retail'],         channels: ['whatsApp'] },
  { company: 'Baghdad Marble Center',     contact: 'Omar Hassan',      country: 'IQ', city: 'Baghdad', phone: '+9647801234567', status: 'active',  tags: ['wholesale', 'export'], channels: ['whatsApp', 'telegram'] },
  { company: 'Istanbul Dogal Tas',        contact: 'Emre Yilmaz',      country: 'TR', city: 'Istanbul', phone: '+905321234567', status: 'new',     tags: ['export'],              channels: ['email'] },
  { person: 'Hossein Karimi',             country: 'IR', city: 'Isfahan', phone: '09131234567', status: 'active',   tags: ['architect'],   channels: ['whatsApp', 'telegram'] },
  { person: 'Sara Ahmadi',                country: 'IR', city: 'Tehran',  phone: '09121234568', status: 'follow_up', tags: ['designer'],    channels: ['whatsApp', 'instagram'] },
  { person: 'Reza Mohammadi',             country: 'IR', city: 'Shiraz',  phone: '09171234569', status: 'new',      tags: [],              channels: ['whatsApp'] },
  { company: 'Nordic Stone Imports',      contact: 'Lars Johansson',   country: 'SE', city: 'Malmo',  phone: '+46701234567', status: 'lost',     tags: ['export'],              channels: ['email'] },
  { company: 'Casa Pietra Milano',        contact: 'Giulia Rossi',     country: 'IT', city: 'Milan',  phone: '+393331234567', status: 'active',  tags: ['interior', 'export'],  channels: ['email', 'whatsApp'] },
  { person: 'Ahmed Mostafa',              country: 'EG', city: 'Cairo',  phone: '+201001234567', status: 'new',     tags: [],              channels: ['whatsApp'] },
];

const RAW_CONTENTS = [
  { title: 'Armani Grey slab walkthrough - quarry yard', status: 'ready_to_upload', platform: 'Instagram', useCase: 'Reels', language: 'en',
    text: 'Phone footage from the yard: three Armani Grey slabs under morning light, slow pan across the veining. Needs colour grading and the logo bumper at the end.' },
  { title: 'Travertine filling process - close ups', status: 'working_on_it', platform: 'Anything', useCase: 'Anything', language: 'en',
    text: 'Macro shots of the filling line. Good material for a "how travertine is finished" explainer.' },
  { title: 'KSA warehouse tour - voice notes', status: 'ready_to_upload', platform: 'YouTube', useCase: 'Short', language: 'ar',
    text: 'جولة في مستودع الرياض مع شرح لأنواع الرخام المتوفرة. الصوت يحتاج تنظيف.' },
  { title: 'Onyx backlit sample - studio test', status: 'working_on_it', platform: 'Instagram', useCase: 'Post', language: 'en',
    text: 'Backlit onyx on the light table. Two angles, one with the lamp dimmed. Pick the warmer one.' },
  { title: 'Customer site in Dubai Marina - before/after', status: 'rejected', platform: 'Anything', useCase: 'Anything', language: 'en',
    text: 'Client did not approve showing the villa. Keep for internal reference only.' },
  { title: 'New quarry block arrival - Isfahan', status: 'working_on_it', platform: 'Telegram', useCase: 'Anything', language: 'fa',
    text: 'رسیدن بلوک‌های جدید به کارگاه اصفهان. ویدیوی کوتاه از تخلیه بار.' },
];

const TUTORIALS = [
  { title: 'Creating a quotation from inventory', section: 'mis', language: 'en', tags: ['mis:preinvoice:create'],
    description: 'Pick the customer, search the catalogue by code or build the code from a specification, set quantities and send it.' },
  { title: 'Logging a call and setting a follow-up', section: 'crm', language: 'en', tags: ['crm:communication:create'],
    description: 'Open the customer, use the Communication tab, record a voice note if it is easier, then set the next follow-up date.' },
  { title: 'Receiving supply stone into the warehouse', section: 'inventory', language: 'en', tags: ['inventory:quantity:edit'],
    description: 'Only the receive action turns a finished coupe into sellable stock. Partial receipts are fine - the rest stays in the lot.' },
  { title: 'ثبت درخواست موجودی از شعبه دیگر', section: 'mis', language: 'fa', tags: ['mis:crossBranch:quote'],
    description: 'شعبه مقابل باید انبار خود را با شما به اشتراک گذاشته باشد. قیمت را آن‌ها تعیین می‌کنند.' },
];

async function main() {
  const conn = dbConnection;
  await new Promise((resolve, reject) => {
    if (conn.readyState === 1) return resolve();
    conn.once('connected', resolve); conn.once('error', reject);
    return undefined;
  });
  const db = conn.db;
  console.log(`database: ${db.databaseName} (${URI.replace(/\/\/[^@]*@/, '//<credentials>@')})`);
  console.log(APPLY ? 'MODE: apply\n' : 'MODE: dry run - nothing is written\n');

  // ── what we keep ──────────────────────────────────────────────────────────
  const branches = await Branch.find({ deleteDate: null }).lean();
  const users = await User.find({ deleteDate: null }).lean();
  const accesses = await UserAccess.find({}).lean();
  const roles = await Role.find({ deleteDate: null }).lean();
  if (!branches.length) throw new Error('no branches - this script seeds onto existing branches');
  if (!users.length) throw new Error('no users - this script keeps the people it finds and seeds around them');

  const superRoleIds = roles.filter((r) => r.isSuperAdmin).map((r) => String(r._id));
  const isSuper = (u) => {
    const a = accesses.find((x) => String(x.userId) === String(u._id));
    return Boolean(a && (a.roles || []).some((r) => superRoleIds.includes(String(r))));
  };
  const nameOf = (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'XMS user';
  const admin = users.find(isSuper) || users[0];
  const second = users.find((u) => String(u._id) !== String(admin._id)) || admin;

  // the branches that actually hold stock - the demo is built on their real varieties
  const variants = await InvVariant.find({ deleteDate: null, status: 'active' })
    .select('_id productId branchId code unit quantity price currency spec').lean();
  const products = await InvProduct.find({ deleteDate: null }).select('_id branchId code name defaultUnit').lean();
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const byBranch = new Map();
  for (const v of variants) {
    const key = String(v.branchId);
    if (!byBranch.has(key)) byBranch.set(key, []);
    byBranch.get(key).push(v);
  }
  const stocked = branches
    .filter((b) => (byBranch.get(String(b._id)) || []).length)
    .sort((a, b) => (byBranch.get(String(b._id)).length - (byBranch.get(String(a._id)) || []).length));
  if (!stocked.length) throw new Error('no branch has any inventory - nothing to build documents from');
  const home = stocked[0];
  const away = stocked[1] || stocked[0];

  // sellable varieties: real stock, a price, and a parseable product behind them
  const sellable = (branch, count) => (byBranch.get(String(branch._id)) || [])
    .filter((v) => (Number(v.quantity) || 0) > 5 && productById.has(String(v.productId)))
    .sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0))
    .slice(0, count);
  const homeStock = sellable(home, 40);
  const awayStock = sellable(away, 20);
  if (homeStock.length < 6) throw new Error(`${home.name} has too few stocked varieties to build a demo`);
  const priceOf = (v, i) => Number(v.price) > 0 ? Number(v.price) : [85, 120, 145, 180, 220, 260][i % 6];
  // the demo asks for more varieties than a small branch may have; wrap rather than crash
  const hs = (i) => homeStock[i % homeStock.length];
  const as = (i) => awayStock[i % awayStock.length] || hs(i);
  const crossBranch = String(away._id) !== String(home._id);

  console.log('Keeping:');
  console.log(`  ${users.length} user(s): ${users.map(nameOf).join(', ')}`);
  console.log(`  ${branches.length} branch(es); inventory in ${stocked.map((b) => b.name).join(', ')}`);
  console.log(`  ${products.length} products / ${variants.length} varieties, their change logs and media`);
  console.log(`  the website's pages, categories/tags and blog posts`);
  console.log(`  documents will be built for: ${home.name} (main) and ${away.name}\n`);

  // ── what we clear ─────────────────────────────────────────────────────────
  const clearPlan = [];
  for (const name of CLEARED) {
    const n = await db.collection(name).countDocuments({}).catch(() => 0);
    if (n) clearPlan.push([name, n]);
  }
  const fileFilter = { scope: { $nin: KEPT_FILE_SCOPES }, 'attachedTo.type': { $nin: KEPT_FILE_ATTACH } };
  const filesToClear = await FileModel.countDocuments(fileFilter);
  const filesKept = await FileModel.countDocuments({ $or: [{ scope: { $in: KEPT_FILE_SCOPES } }, { 'attachedTo.type': { $in: KEPT_FILE_ATTACH } }] });
  console.log('Clearing:');
  for (const [name, n] of clearPlan) console.log(`  ${String(n).padStart(5)}  ${name}`);
  console.log(`  ${String(filesToClear).padStart(5)}  files (keeping ${filesKept} inventory / website ones; no file is removed from disk)`);
  if (!clearPlan.length && !filesToClear) console.log('  (already empty)');
  console.log('');

  // ═══ build ════════════════════════════════════════════════════════════════
  const out = {
    customers: [], customerActivities: [], tasks: [], notifications: [],
    invoices: [], invoiceActivities: [], counters: [],
    packingLists: [], packingListActivities: [],
    supplyRecords: [], dealLetters: [], dealActivities: [],
    priceRequests: [],
    rawContents: [], chats: [], readyToUploads: [], dmActivities: [],
    linkPages: [], shares: [], tutorials: [], tutorialActivities: [],
    folders: [], files: [], fileActivities: [],
    stockMoves: [],           // [{ variantId, quantity, reason }]
  };

  // ── CRM ───────────────────────────────────────────────────────────────────
  const displayName = (c) => {
    const pi = (c && c.personalInformation) || {};
    return pi.companyName || `${pi.firstName || ''} ${pi.lastName || ''}`.trim() || '-';
  };
  const customerIds = [];
  CUSTOMERS.forEach((c, i) => {
    const id = oid();
    customerIds.push(id);
    const owner = i % 3 === 0 ? second._id : admin._id;
    const variant = homeStock[i % homeStock.length];
    const product = productById.get(String(variant.productId));
    const handles = {};
    for (const ch of c.channels) {
      handles[ch] = ch === 'email'
        ? `${(c.contact || c.person || 'info').toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`
        : c.phone;
    }
    out.customers.push({
      _id: id,
      // name, type and country live under personalInformation - the top level only carries
      // the fields the schema declares there, and Mongoose drops anything else in silence
      personalInformation: {
        country: c.country,
        customerType: c.company ? 'company' : 'individual',
        personOrCompany: c.company ? 'company' : 'individual',
        companyName: c.company || '',
        contactPerson: c.contact || '',
        firstName: c.person ? c.person.split(' ')[0] : '',
        lastName: c.person ? c.person.split(' ').slice(1).join(' ') : '',
      },
      phoneNumber: c.phone,
      address: [{ country: c.country, city: c.city, street: `${c.city} industrial area`, postalCode: '' }],
      commChannels: c.channels,
      commHandles: handles,
      status: c.status,
      tags: c.tags,
      trn: c.trn || '',
      branchId: i % 4 === 3 ? away._id : home._id,
      lastCallAt: ['active', 'follow_up', 'won'].includes(c.status) ? daysAgo(2 + (i % 20)) : null,
      nextFollowUpAt: c.status === 'follow_up' ? daysAgo(-(1 + (i % 9))) : null,
      owner,
      assignedTo: i % 5 === 0 ? [second._id] : [],
      interestedProducts: [{
        productId: variant.productId, variantId: variant._id, branchId: variant.branchId,
        note: 'asked for a price in the last call', source: 'xms', addedAt: daysAgo(5 + i),
      }],
      createdBy: owner,
      insertDate: daysAgo(30 + i * 3),
    });
    out.customerActivities.push({
      customerId: id, type: 'created', body: 'Added from the website enquiry form',
      actorId: owner, actorName: nameOf(users.find((u) => String(u._id) === String(owner)) || admin),
      date: daysAgo(30 + i * 3), createdAt: daysAgo(30 + i * 3),
    });
    if (['active', 'follow_up', 'won'].includes(c.status)) {
      out.customerActivities.push({
        customerId: id, type: 'call_logged',
        body: `Called about ${product ? product.name : 'the catalogue'} - wants a quotation for ${10 + i} m².`,
        actorId: owner, actorName: nameOf(users.find((u) => String(u._id) === String(owner)) || admin),
        date: daysAgo(2 + (i % 20)), createdAt: daysAgo(2 + (i % 20)),
      });
    }
    if (c.status === 'follow_up') {
      out.customerActivities.push({
        customerId: id, type: 'follow_up_set', field: 'nextFollowUpAt', newValue: daysAgo(-(1 + (i % 9))),
        body: 'Call back with the final price', actorId: owner, actorName: nameOf(admin),
        date: daysAgo(1 + (i % 5)), createdAt: daysAgo(1 + (i % 5)),
      });
    }
    if (c.status === 'won') {
      out.customerActivities.push({
        customerId: id, type: 'status_changed', field: 'status', oldValue: 'active', newValue: 'won',
        actorId: owner, actorName: nameOf(admin), date: daysAgo(4), createdAt: daysAgo(4),
      });
    }
  });

  // My Desk: a personal working set (created by the same user) and assigned work
  const TASKS = [
    { title: 'Send the Armani Grey quotation to Al Fahad', by: admin, to: admin, status: 'open', customer: 0 },
    { title: 'Chase the Riyadh facade project drawings', by: admin, to: admin, status: 'open', customer: 2 },
    { title: 'Collect the remaining balance from Gulf Stone', by: admin, to: second, status: 'open', customer: 1 },
    { title: 'Prepare samples for the Milan showroom', by: second, to: admin, status: 'claimed', customer: 12 },
    { title: 'Call Sara Ahmadi back about the onyx', by: second, to: second, status: 'open', customer: 9 },
    { title: 'Close the Nordic enquiry - no response in 3 weeks', by: admin, to: admin, status: 'done', customer: 11 },
  ];
  TASKS.forEach((t, i) => {
    out.tasks.push({
      title: t.title, description: '', assigneeType: 'user', assignedUser: t.to._id,
      status: t.status, claimedBy: t.status === 'claimed' ? t.to._id : null,
      claimedByName: t.status === 'claimed' ? nameOf(t.to) : '',
      createdBy: t.by._id, createdByName: nameOf(t.by),
      module: 'crm', subjects: [{ subjectType: 'customer', subjectId: customerIds[t.customer] }],
      insertDate: daysAgo(6 + i),
    });
    if (String(t.by._id) !== String(t.to._id)) {
      out.notifications.push({
        userId: t.to._id, fromId: t.by._id, fromName: nameOf(t.by), type: 'task',
        title: 'A task was assigned to you', body: t.title,
        entityType: 'task', entityId: null, isRead: i % 2 === 0, insertDate: daysAgo(6 + i),
      });
    }
  });

  // ── MIS: quotations, invoices, inter-branch requests ──────────────────────
  const counterSeq = new Map();   // `${branchId}|${docType}` -> last number
  const nextNumber = (branchId, docType) => {
    const key = `${branchId}|${docType}`;
    const next = (counterSeq.get(key) || 0) + 1;
    counterSeq.set(key, next);
    return next;
  };
  const lineFrom = (v, qty, i, discount = 0, discountType = 'amount') => {
    const p = productById.get(String(v.productId));
    return {
      productId: v.productId, variantId: v._id, code: v.code,
      name: p ? p.name : v.code, unit: v.unit || 'M2',
      quantity: qty, unitPrice: priceOf(v, i), discount, discountType, vatRate: 5,
      sourceType: 'inventory',
    };
  };
  const makeDoc = (spec) => {
    const branch = spec.branch || home;
    const docNumber = nextNumber(String(branch._id), spec.docType);
    const totals = computeTotals(spec.lines, spec.shipping || 0);
    const customer = spec.customerIndex === undefined ? null : out.customers[spec.customerIndex];
    const id = oid();
    const doc = {
      _id: id,
      branchId: branch._id, docType: spec.docType, docNumber,
      tradeMode: spec.tradeMode || 'customer',
      status: spec.status,
      issueDate: spec.date,
      lineItems: totals.items,
      currency: 'AED',
      subtotal: totals.subtotal, discountTotal: totals.discountTotal, vatTotal: totals.vatTotal,
      shipping: spec.shipping || 0, grandTotal: totals.grandTotal,
      notes: spec.notes || '',
      createdBy: (spec.by || admin)._id,
      insertDate: spec.date,
      stockDecremented: Boolean(spec.takesStock),
    };
    if (spec.tradeMode === 'interBranch') {
      doc.requestingBranchId = spec.requestingBranch._id;
      doc.requestingBranchSnapshot = { name: spec.requestingBranch.name };
    } else if (customer) {
      doc.customerId = customer._id;
      doc.customerSnapshot = {
        name: displayName(customer),
        trn: customer.trn || '', country: customer.personalInformation.country, phone: customer.phoneNumber,
        address: `${customer.address[0].street}, ${customer.address[0].city}`,
      };
    }
    if (spec.docType === 'pre_invoice') doc.validityDays = spec.validityDays || 15;
    if (spec.docType === 'invoice') {
      doc.amountInWords = amountToArabicWords(totals.grandTotal);
      doc.salesRepId = (spec.by || admin)._id;
      doc.salesRepName = nameOf(spec.by || admin);
      const paid = spec.paid === undefined ? 0 : spec.paid;
      doc.payment = {
        cash: paid, chequeBank: 0, card: 0,
        remaining: round2(totals.grandTotal - paid), currentBalance: round2(totals.grandTotal - paid),
        balanceSign: 'debit',
      };
    }
    if (spec.priceRequestId) {
      doc.priceRequestId = spec.priceRequestId;
      if (spec.validUntil) { doc.validUntil = spec.validUntil; doc.validUntilTz = 'Asia/Dubai'; }
      if (spec.acceptedAt) doc.customerAcceptedAt = spec.acceptedAt;
    }
    if (spec.assignTo) {
      doc.assignedTo = [spec.assignTo._id];
      doc.assignedBy = admin._id; doc.assignedByName = nameOf(admin); doc.assignedAt = spec.date;
    }
    out.invoices.push(doc);
    out.invoiceActivities.push({
      invoiceId: id, docType: spec.docType, type: 'created',
      actorId: (spec.by || admin)._id, actorName: nameOf(spec.by || admin),
      date: spec.date, createdAt: spec.date,
    });
    if (spec.status !== 'draft') {
      out.invoiceActivities.push({
        invoiceId: id, docType: spec.docType, type: 'status', field: 'status',
        oldValue: 'draft', newValue: spec.status,
        actorId: (spec.by || admin)._id, actorName: nameOf(spec.by || admin),
        date: new Date(spec.date.getTime() + 3600 * 1000), createdAt: spec.date,
      });
    }
    if (spec.takesStock) {
      for (const li of totals.items) {
        if (li.sourceType === 'supply') continue;
        out.stockMoves.push({ variantId: li.variantId, quantity: li.quantity, reason: `${spec.docType === 'invoice' ? 'Invoice' : 'Quotation'} #${docNumber}` });
      }
      out.invoiceActivities.push({
        invoiceId: id, docType: spec.docType, type: 'stock_decremented',
        body: 'Stock taken out for this document',
        actorId: (spec.by || admin)._id, actorName: nameOf(spec.by || admin),
        date: spec.date, createdAt: spec.date,
      });
    }
    return doc;
  };

  // quotations
  makeDoc({ docType: 'pre_invoice', status: 'sent',     date: daysAgo(3),  customerIndex: 0, lines: [lineFrom(hs(0), 24, 0), lineFrom(hs(1), 12, 1)] });
  makeDoc({ docType: 'pre_invoice', status: 'sent',     date: daysAgo(6),  customerIndex: 2, lines: [lineFrom(hs(2), 60, 2, 5, 'percent')] });
  makeDoc({ docType: 'pre_invoice', status: 'draft',    date: daysAgo(1),  customerIndex: 4, lines: [lineFrom(hs(3), 18, 3)] });
  makeDoc({ docType: 'pre_invoice', status: 'accepted', date: daysAgo(9),  customerIndex: 1, lines: [lineFrom(hs(4), 30, 4)], takesStock: true });
  makeDoc({ docType: 'pre_invoice', status: 'expired',  date: daysAgo(40), customerIndex: 7, lines: [lineFrom(hs(5), 15, 5)], validityDays: 10 });
  makeDoc({ docType: 'pre_invoice', status: 'sent',     date: daysAgo(2),  customerIndex: 12, lines: [lineFrom(hs(6), 42, 6), lineFrom(hs(7), 8, 7, 200)], by: second });

  // invoices
  makeDoc({ docType: 'invoice', status: 'paid',           date: daysAgo(12), customerIndex: 0, lines: [lineFrom(hs(8), 36, 8)], shipping: 450, paid: null, takesStock: true });
  makeDoc({ docType: 'invoice', status: 'paid',           date: daysAgo(20), customerIndex: 6, lines: [lineFrom(hs(9), 54, 9), lineFrom(hs(10), 20, 10)], shipping: 800, takesStock: true });
  makeDoc({ docType: 'invoice', status: 'partially_paid', date: daysAgo(8),  customerIndex: 1, lines: [lineFrom(hs(11), 28, 11)], shipping: 300, paid: 2000 });
  makeDoc({ docType: 'invoice', status: 'issued',         date: daysAgo(4),  customerIndex: 3, lines: [lineFrom(hs(12), 16, 12)], assignTo: second });
  makeDoc({ docType: 'invoice', status: 'issued',         date: daysAgo(2),  customerIndex: 8, lines: [lineFrom(hs(13), 22, 13)] });
  makeDoc({ docType: 'invoice', status: 'cancelled',      date: daysAgo(26), customerIndex: 11, lines: [lineFrom(hs(14), 10, 14)] });
  makeDoc({ docType: 'invoice', status: 'draft',          date: daysAgo(0),  customerIndex: 5, lines: [lineFrom(hs(15), 12, 15)], by: second });
  // the away branch does business too
  if (crossBranch) {
    makeDoc({ docType: 'invoice', status: 'paid', branch: away, date: daysAgo(14), customerIndex: 3, lines: [lineFrom(as(0), 26, 0)], shipping: 350, takesStock: true });
    makeDoc({ docType: 'pre_invoice', status: 'sent', branch: away, date: daysAgo(5), customerIndex: 5, lines: [lineFrom(as(1), 19, 1)] });
  }

  // the fixed payment figure for the 'paid' ones (computed after totals are known)
  for (const d of out.invoices) {
    if (d.docType === 'invoice' && d.status === 'paid') {
      d.payment = { cash: d.grandTotal, chequeBank: 0, card: 0, remaining: 0, currentBalance: 0, balanceSign: 'debit' };
    }
  }

  // inter-branch requests: the away branch asks the home branch for stock
  if (crossBranch) {
    makeDoc({ docType: 'pre_invoice', tradeMode: 'interBranch', status: 'requested', branch: home, requestingBranch: away, date: daysAgo(3), lines: [{ ...lineFrom(hs(16), 40, 16), unitPrice: 0 }], notes: 'Needed for a showroom order in the other branch' });
    makeDoc({ docType: 'pre_invoice', tradeMode: 'interBranch', status: 'accepted', branch: home, requestingBranch: away, date: daysAgo(11), lines: [lineFrom(hs(17), 25, 17)], takesStock: true });
    makeDoc({ docType: 'pre_invoice', tradeMode: 'interBranch', status: 'cancelled', branch: home, requestingBranch: away, date: daysAgo(18), lines: [{ ...lineFrom(hs(18), 12, 18), unitPrice: 0 }], notes: 'Declined - the slabs were already committed' });
  }

  // ── packing lists ─────────────────────────────────────────────────────────
  const paidInvoices = out.invoices.filter((d) => d.docType === 'invoice' && d.status === 'paid' && String(d.branchId) === String(home._id));
  const palletItems = (li, pallets) => {
    const per = Math.max(1, Math.round((li.quantity / pallets) / 1.2));
    return Array.from({ length: pallets }, (_, p) => ({
      palletId: `P${p + 1}`, reference: String(755 + p).padStart(5, '0'),
      productCode: li.code.slice(0, 4), processingType: p % 2 ? 'UNFLD (slab)' : 'FLD (tile)',
      items: [{ code: li.code, lengthCm: 240, widthCm: 120, thicknessCm: 2, pcs: per, sqm: round2(240 / 100 * 120 / 100 * per) }],
    }));
  };
  [0, 1].forEach((idx, i) => {
    const inv = paidInvoices[idx];
    if (!inv) return;
    const pallets = palletItems(inv.lineItems[0], 2 + i);
    const totals = pallets.reduce((a, p) => {
      for (const it of p.items) { a.totalPcs += it.pcs; a.totalSqm = round2(a.totalSqm + it.sqm); }
      a.totalPallets += 1; return a;
    }, { totalPallets: 0, totalPcs: 0, totalSqm: 0 });
    const id = oid();
    out.packingLists.push({
      _id: id, branchId: home._id, docNumber: nextNumber(String(home._id), 'packing_list'),
      type: 'linked', invoiceIds: [inv._id], pallets, totals, status: i === 0 ? 'final' : 'draft',
      driverInfo: { fullName: pick(['Ali Reza Naderi', 'Mehdi Shirazi'], i), nationalId: '1289456732', smartNumber: '4417823', phone: '09131002200', iban: 'IR820540102680020817909002' },
      vehicleInfo: { trailerPlateNumber: pick(['67 ع 341 ایران 13', '22 ب 785 ایران 53'], i), trailerSmartNumber: '9912345' },
      customsAgent: { name: 'Bandar Abbas Customs Services', phone: '07633334444' },
      loadingOfficer: { name: nameOf(admin), phone: '09120000000' },
      originAddress: `${home.name} yard`, destinationAddress: inv.customerSnapshot.address,
      shippingDestination: inv.customerSnapshot.country, standardThicknessCm: 2,
      createdBy: admin._id, insertDate: daysAgo(10 - i * 3),
    });
    out.packingListActivities.push({ packingListId: id, type: 'created', actorId: admin._id, actorName: nameOf(admin), date: daysAgo(10 - i * 3), createdAt: daysAgo(10 - i * 3) });
  });
  {
    const v = hs(19) || hs(0);
    const id = oid();
    const pallets = [{ palletId: 'P1', reference: '00812', productCode: v.code.slice(0, 4), processingType: 'UNFLD (slab)', items: [{ code: v.code, lengthCm: 280, widthCm: 160, thicknessCm: 3, pcs: 6, sqm: round2(2.8 * 1.6 * 6) }] }];
    out.packingLists.push({
      _id: id, branchId: home._id, docNumber: nextNumber(String(home._id), 'packing_list'),
      type: 'free', invoiceIds: [], pallets,
      totals: { totalPallets: 1, totalPcs: 6, totalSqm: round2(2.8 * 1.6 * 6) }, status: 'draft',
      driverInfo: { fullName: 'Hamid Esmaili', phone: '09121119999' }, vehicleInfo: {}, customsAgent: {},
      loadingOfficer: { name: nameOf(second), phone: '09120000001' },
      originAddress: `${home.name} yard`, destinationAddress: 'Samples - internal transfer', shippingDestination: 'Showroom',
      createdBy: second._id, insertDate: daysAgo(2),
    });
    out.packingListActivities.push({ packingListId: id, type: 'created', actorId: second._id, actorName: nameOf(second), date: daysAgo(2), createdAt: daysAgo(2) });
  }

  // ── Supply (on the branch that has the deepest catalogue) ─────────────────
  const supplyProducts = [...new Set(homeStock.map((v) => String(v.productId)))].slice(0, 3);
  const SUPPLY_SPECS = [
    { title: 'Spring coupe - first cut', status: 'final_product', seller: 'Kavir Stone Quarries', spec: 'Block 2.8 × 1.6 × 1.4 m, light veining, cut to 2 cm slabs' },
    { title: 'Summer lot - processing', status: 'processing', seller: 'Azarshahr Quarry Co.', spec: 'Two blocks, mixed grade, to be filled and polished' },
    { title: 'New purchase - awaiting delivery', status: 'purchasing', seller: 'Yazd Natural Stone', spec: 'Coupe bought at the yard, dimensions to be confirmed on arrival' },
  ];
  supplyProducts.forEach((pid, i) => {
    const product = productById.get(pid);
    const spec = SUPPLY_SPECS[i];
    const recordId = oid();
    const code = `SR-${String(i + 1).padStart(4, '0')}`;
    out.supplyRecords.push({
      _id: recordId, code, branchId: home._id, productId: product._id,
      productCode: product.code, productName: product.name,
      title: `${product.name} - ${spec.title}`, date: daysAgo(45 - i * 10),
      notes: '', dealLetterCount: 1, status: 'active',
      createdBy: admin._id, insertDate: daysAgo(45 - i * 10),
    });
    const lines = homeStock.filter((v) => String(v.productId) === pid).slice(0, 3).map((v, j) => ({
      variantId: v._id, variantCode: v.code, unit: v.unit || 'M2',
      forecastQty: 120 + j * 40,
      finalQty: spec.status === 'final_product' ? 110 + j * 38 : null,
      price: spec.status === 'purchasing' ? null : 60 + j * 15,
      currency: 'AED', receivedQty: spec.status === 'final_product' && j === 0 ? 40 : 0,
      allocatedQty: 0,
      stoneTypeLabel: v.code, count: 20 + j * 5, widthCm: 120, lengthCm: 240,
    }));
    const dlId = oid();
    out.dealLetters.push({
      _id: dlId, supplyId: recordId, branchId: home._id, productId: product._id,
      coupeSpec: spec.spec,
      coupeSeller: { customerId: null, name: spec.seller, phone: '09131110000', notes: '' },
      status: spec.status, varietyLines: lines,
      contract: { number: `C-${1400 + i}`, date: daysAgo(44 - i * 10), currency: 'IRR', validityDays: 3 },
      createdBy: admin._id, insertDate: daysAgo(44 - i * 10),
    });
    out.dealActivities.push({
      dealLetterId: dlId, stage: 'purchasing', type: 'created',
      body: `Coupe bought from ${spec.seller}`, actorId: admin._id, actorName: nameOf(admin),
      date: daysAgo(44 - i * 10), createdAt: daysAgo(44 - i * 10),
    });
    if (spec.status !== 'purchasing') {
      out.dealActivities.push({
        dealLetterId: dlId, stage: 'processing', type: 'status_changed', field: 'status',
        oldValue: 'purchasing', newValue: 'processing', body: 'Cutting started at the workshop',
        actorId: admin._id, actorName: nameOf(admin), date: daysAgo(30 - i * 6), createdAt: daysAgo(30 - i * 6),
      });
    }
    if (spec.status === 'final_product') {
      out.dealActivities.push({
        dealLetterId: dlId, stage: 'final_product', type: 'status_changed', field: 'status',
        oldValue: 'processing', newValue: 'final_product', body: 'Final quantities measured and recorded',
        actorId: admin._id, actorName: nameOf(admin), date: daysAgo(12), createdAt: daysAgo(12),
      });
      out.dealActivities.push({
        dealLetterId: dlId, stage: 'final_product', type: 'received',
        body: 'First 40 m² received into the warehouse', actorId: admin._id, actorName: nameOf(admin),
        date: daysAgo(10), createdAt: daysAgo(10),
      });
    }
  });

  // ── website price requests, and two offers ────────────────────────────────
  const webCustomers = [0, 1, 4, 9, 12];
  const REQ_STATUS = ['responded', 'new', 'seen', 'new', 'responded'];
  const prIds = [];
  webCustomers.forEach((ci, i) => {
    const c = out.customers[ci];
    const v = homeStock[(i * 3) % homeStock.length];
    const p = productById.get(String(v.productId));
    const id = oid();
    prIds.push(id);
    out.priceRequests.push({
      _id: id,
      items: [{ productId: v.productId, variantId: v._id, productName: p.name, variantCode: v.code, branchId: home._id, quantity: 20 + i * 10, unit: v.unit || 'M2' }],
      customerId: c._id, branchId: home._id,
      name: displayName(c),
      email: c.commHandles.email || `${displayName(c).toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
      phone: c.phoneNumber, country: c.personalInformation.country, city: c.address[0].city,
      receivingAddress: { country: c.personalInformation.country, city: c.address[0].city, address: c.address[0].street, postalCode: '', mapLink: '' },
      status: REQ_STATUS[i], source: pick(['productPage', 'productTable', 'purchaseList'], i),
      language: 'en', insertDate: daysAgo(1 + i * 2),
    });
  });
  // an offer the customer can still accept, and one they already accepted
  const offerVariant = hs(2);
  const openOffer = makeDoc({
    docType: 'pre_invoice', status: 'sent', date: daysAgo(0), customerIndex: webCustomers[0],
    lines: [lineFrom(offerVariant, 20, 2)], priceRequestId: prIds[0], validUntil: hoursFromNow(6),
    notes: 'Price holds until the deadline shown on your dashboard.',
  });
  out.invoiceActivities.push({ invoiceId: openOffer._id, docType: 'pre_invoice', type: 'website_offer_sent', body: 'Offer sent to the customer', actorId: admin._id, actorName: nameOf(admin), date: daysAgo(0), createdAt: daysAgo(0) });
  const acceptedVariant = hs(5);
  const acceptedOffer = makeDoc({
    docType: 'pre_invoice', status: 'converted', date: daysAgo(7), customerIndex: webCustomers[4],
    lines: [lineFrom(acceptedVariant, 15, 5)], priceRequestId: prIds[4], validUntil: daysAgo(6), acceptedAt: daysAgo(6, 30),
  });
  const offerInvoice = makeDoc({
    docType: 'invoice', status: 'issued', date: daysAgo(6, 35), customerIndex: webCustomers[4],
    lines: [lineFrom(acceptedVariant, 15, 5)], priceRequestId: prIds[4], takesStock: true,
  });
  acceptedOffer.convertedToInvoiceId = offerInvoice._id;
  offerInvoice.convertedFromPreInvoiceId = acceptedOffer._id;
  out.invoiceActivities.push({ invoiceId: acceptedOffer._id, docType: 'pre_invoice', type: 'website_offer_accepted', body: 'Accepted by the customer on the website', actorId: null, actorName: 'Customer (website)', date: daysAgo(6, 30), createdAt: daysAgo(6, 30) });

  // ── Digital Marketing ─────────────────────────────────────────────────────
  const rawIds = [];
  RAW_CONTENTS.forEach((rc, i) => {
    const id = oid();
    rawIds.push(id);
    const v = homeStock[(i * 2) % homeStock.length];
    const p = productById.get(String(v.productId));
    const owner = i % 2 ? second : admin;
    out.rawContents.push({
      _id: id, title: rc.title, language: rc.language, useCase: rc.useCase, platform: rc.platform,
      status: rc.status, files: [], textContent: rc.text,
      products: [{ productId: v.productId, variantId: v._id, code: v.code, productName: p.name, branchId: home._id, branchName: home.name, addedAt: daysAgo(9 - i) }],
      owner: owner._id, branchId: home._id, createdBy: owner._id, createdByName: nameOf(owner),
      insertDate: daysAgo(9 - i),
    });
    out.dmActivities.push({ subjectType: 'rawContent', subjectId: id, action: 'created', actorId: owner._id, actorName: nameOf(owner), date: daysAgo(9 - i) });
    // a short conversation on the first few
    if (i < 3) {
      const talk = [
        { who: admin, body: 'Nice material. Can you trim the first four seconds?' },
        { who: second, body: 'Done - re-uploaded the cut version. The light is better from 0:06.' },
        { who: admin, body: 'Perfect, moving it to ready to upload.' },
      ];
      talk.forEach((m, j) => out.chats.push({
        rawContentId: id, senderId: m.who._id, senderName: nameOf(m.who), type: 'text', body: m.body,
        date: daysAgo(8 - i, j * 20), createdAt: daysAgo(8 - i, j * 20),
      }));
    }
  });
  // the ones that graduated
  const READY = [
    { from: 0, platform: 'Reels', caption: 'Armani Grey, straight from the yard. Book a slab view this week. #marble #armanigrey' },
    { from: 2, platform: 'YouTube Short', caption: 'جولة سريعة في مستودعنا بالرياض - رخام جاهز للتسليم' },
  ];
  READY.forEach((r, i) => {
    const id = oid();
    const raw = out.rawContents[r.from];
    raw.readyToUploadId = id;
    out.readyToUploads.push({
      _id: id, rawContentId: raw._id, title: raw.title.replace(/ - .*/, '') + ' - final cut',
      files: [], language: raw.language, platform: r.platform, caption: r.caption,
      products: raw.products, owner: raw.owner, branchId: home._id,
      createdBy: raw.createdBy, createdByName: raw.createdByName, insertDate: daysAgo(4 - i),
    });
    out.dmActivities.push({ subjectType: 'readyToUpload', subjectId: id, action: 'created', actorId: raw.createdBy, actorName: raw.createdByName, date: daysAgo(4 - i) });
    out.dmActivities.push({ subjectType: 'rawContent', subjectId: raw._id, action: 'status_changed', oldValue: 'working_on_it', newValue: 'ready_to_upload', actorId: raw.createdBy, actorName: raw.createdByName, date: daysAgo(4 - i) });
  });
  out.linkPages.push({
    code: 'lmc-demo', language: 'en', companyName: 'Lazulite Marble Company',
    links: [
      { type: 'whatsapp', label: '', value: '+971501234567' },
      { type: 'whatsappChannel', label: 'Stone updates', value: 'https://whatsapp.com/channel/demo' },
      { type: 'website', label: '', value: 'https://www.lazulitemarble.com' },
      { type: 'other', label: 'Instagram', value: 'https://instagram.com/lazulitemarble' },
      { type: 'address', label: 'Showroom', value: 'Sharjah Industrial Area 10, UAE' },
    ],
    status: 'active', restrictToOwner: false,
    owner: admin._id, createdBy: admin._id, createdByName: nameOf(admin), insertDate: daysAgo(15),
  });
  [0, 4, 8].forEach((idx, i) => {
    const v = homeStock[idx];
    const p = productById.get(String(v.productId));
    out.shares.push({
      variantId: v._id, productId: v.productId, productName: p.name, productNameAr: '',
      variantCode: v.code, unsized: false,
      lengthCm: (v.spec && v.spec.lengthCm) || null, widthCm: (v.spec && v.spec.widthCm) || null, thicknessMm: (v.spec && v.spec.thicknessMm) || null,
      languages: i === 0 ? ['en'] : ['en', 'ar'], nameLanguage: 'en',
      includeName: true, includeDimensions: true, includeCode: true, includeContact: true,
      branches: [{ branchId: home._id, branchName: home.name, country: home.country || null, quantity: v.quantity, unit: v.unit || 'M2' }],
      contacts: [{ userId: admin._id, name: nameOf(admin), waNumber: '971501234567', branchNames: [home.name] }],
      text: `${p.name}\n${v.code}\nAvailable at ${home.name}: ${v.quantity} ${v.unit || 'M2'}`,
      action: i % 2 ? 'openedWhatsApp' : 'copied',
      owner: admin._id, createdBy: admin._id, createdByName: nameOf(admin), insertDate: daysAgo(3 + i * 4),
    });
  });

  // ── Tutorials ─────────────────────────────────────────────────────────────
  TUTORIALS.forEach((t, i) => {
    const id = oid();
    out.tutorials.push({
      _id: id, title: t.title, description: t.description, language: t.language,
      section: t.section, tags: t.tags, files: [],
      owner: admin._id, createdBy: admin._id, createdByName: nameOf(admin), insertDate: daysAgo(20 - i * 3),
    });
    out.tutorialActivities.push({ tutorialId: id, type: 'created', actorId: admin._id, actorName: nameOf(admin), date: daysAgo(20 - i * 3), createdAt: daysAgo(20 - i * 3) });
  });

  // ── File Manager: real (small) files on disk, so previews and downloads work ─
  const UPLOADS = path.join(__dirname, '..', 'public', 'uploads');
  const stamp = Date.now();
  const DEMO_FILES = [
    { folder: 'Price lists', name: 'price-list-2026.txt', mime: 'text/plain', body: 'Lazulite Marble - indicative price list 2026\n\nArmani Grey  2cm polished   220 AED/m2\nTravertine Beige 2cm filled  145 AED/m2\nOnyx backlit slab            480 AED/m2\n' },
    { folder: 'Price lists', name: 'export-terms.txt', mime: 'text/plain', body: 'Export terms\n\nFOB Bandar Abbas unless agreed otherwise.\nPacking: wooden crates, 2 cm slabs on A-frames.\n' },
    { folder: 'Certificates', name: 'quality-statement.txt', mime: 'text/plain', body: 'Quality statement\n\nAll material is natural stone; veining and tone vary between blocks.\n' },
    { folder: null, name: 'showroom-plan.txt', mime: 'text/plain', body: 'Showroom layout notes\n\nFront wall: backlit onyx.\nCentre island: Armani Grey 240x120.\n' },
  ];
  // The File Manager addresses a parent by id, not by path: an item at the top level has
  // supFolder 'root', anything else carries its folder's _id, and the folder lists its own
  // children in subFolders / subFiles (routes/fileManager/main.js). A file's `name` has no
  // extension and `format` has no leading dot - that is what the uploader stores.
  const folderIds = new Map();
  ['Price lists', 'Certificates'].forEach((folderName, i) => {
    const id = oid();
    folderIds.set(folderName, id);
    out.folders.push({
      _id: id, name: folderName, subFolders: [], subFiles: [], supFolder: 'root',
      generatedBy: admin._id, tags: [], pinnedBy: [], insertDate: daysAgo(25 - i * 5),
    });
  });
  DEMO_FILES.forEach((f, i) => {
    const diskName = `demo-${stamp}-${i}-${f.name}`;
    const id = oid();
    const parent = f.folder ? folderIds.get(f.folder) : null;
    const bare = f.name.replace(/\.[^.]+$/, '');
    out.files.push({
      _doc_diskName: diskName, _doc_body: f.body,          // used at apply time, stripped before insert
      _id: id, name: bare, supFolder: parent ? String(parent) : 'root',
      metaData: {
        fieldname: 'files', originalname: f.name, encoding: '7bit', mimetype: f.mime,
        destination: 'public/uploads', filename: diskName, path: `public/uploads/${diskName}`,
        size: Buffer.byteLength(f.body),
      },
      format: 'txt', hidden: false, tags: i === 0 ? ['price'] : [],
      generatedBy: admin._id, uploadedByName: nameOf(admin), scope: 'file_manager',
      insertDate: daysAgo(24 - i * 3), uploadDate: daysAgo(24 - i * 3),
    });
    if (parent) out.folders.find((x) => String(x._id) === String(parent)).subFiles.push(id);
    out.fileActivities.push({
      type: 'upload', itemKind: 'file', itemId: id, itemName: bare,
      path: parent ? String(parent) : 'root',
      actorId: admin._id, actorName: nameOf(admin), date: daysAgo(24 - i * 3),
    });
  });

  // a few notifications that are not task related
  out.notifications.push(
    { userId: admin._id, fromId: null, fromName: '', type: 'priceRequest', title: 'New website request', body: `${out.priceRequests[1].name} asked for a price`, isRead: false, insertDate: daysAgo(1) },
    { userId: admin._id, fromId: second._id, fromName: nameOf(second), type: 'invoice', title: 'A document was sent to you', body: 'Invoice assigned for follow-up', isRead: false, insertDate: daysAgo(4) },
    { userId: second._id, fromId: admin._id, fromName: nameOf(admin), type: 'dmChat', title: 'New message on a raw content', body: 'Nice material. Can you trim the first four seconds?', isRead: true, insertDate: daysAgo(8) },
    { userId: admin._id, fromId: null, fromName: '', type: 'request', title: 'Stock request from ' + away.name, body: 'A branch asked for stock from ' + home.name, isRead: false, insertDate: daysAgo(3) },
  );

  // ── report ────────────────────────────────────────────────────────────────
  const counts = {
    customers: out.customers.length, 'customer activities': out.customerActivities.length,
    tasks: out.tasks.length, notifications: out.notifications.length,
    'MIS documents': out.invoices.length, 'document activities': out.invoiceActivities.length,
    'packing lists': out.packingLists.length,
    'supply records': out.supplyRecords.length, 'deal letters': out.dealLetters.length, 'supply follow-ups': out.dealActivities.length,
    'website price requests': out.priceRequests.length,
    'raw contents': out.rawContents.length, 'chat messages': out.chats.length, 'ready to upload': out.readyToUploads.length,
    'link pages': out.linkPages.length, 'whatsapp shares': out.shares.length,
    tutorials: out.tutorials.length, folders: out.folders.length, files: out.files.length,
  };
  console.log('Creating:');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log('');
  console.log('Documents:');
  for (const d of out.invoices) {
    const kind = d.docType === 'invoice' ? 'INV' : (d.tradeMode === 'interBranch' ? 'REQ' : 'QUO');
    const who = d.customerSnapshot ? d.customerSnapshot.name : (d.requestingBranchSnapshot ? `from ${d.requestingBranchSnapshot.name}` : '');
    console.log(`  ${kind} #${String(d.docNumber).padEnd(3)} ${String(d.status).padEnd(15)} ${String(who).slice(0, 30).padEnd(31)} AED ${n2(d.grandTotal).padStart(11)}${d.stockDecremented ? '  (stock taken)' : ''}`);
  }
  const moved = out.stockMoves.reduce((a, m) => a + m.quantity, 0);
  console.log(`\nStock: ${out.stockMoves.length} line(s) across the committed documents take ${n2(moved)} units out of the kept catalogue,`);
  console.log('       each writing an inventory change log, exactly as the app does.');

  // Two settings on records we keep. Both are additive, and both are things a superAdmin
  // would otherwise click: without the share, nobody can raise the cross-branch request
  // the demo documents show; without the branch, a user simply sees an empty app.
  const homeDoc = branches.find((b) => String(b._id) === String(home._id));
  const needsShare = crossBranch && !(homeDoc.crossBranchAccess || []).some((id) => String(id) === String(away._id));
  const seededBranchIds = [String(home._id), ...(crossBranch ? [String(away._id)] : [])];
  const needBranch = OPEN_BRANCHES
    ? accesses.filter((a) => seededBranchIds.some((bid) => !(a.branches || []).some((x) => String(x) === bid)))
    : [];
  if (needsShare || needBranch.length) {
    console.log('\nSettings on kept records (additive):');
    if (needsShare) console.log(`  ${home.name} will share its Inventory and Supply with ${away.name}, so a stock request can be raised`);
    for (const a of needBranch) {
      const u = users.find((x) => String(x._id) === String(a.userId));
      console.log(`  ${u ? nameOf(u) : a.userId} gains access to ${seededBranchIds.length} seeded branch(es)`);
    }
  } else if (crossBranch && !OPEN_BRANCHES) {
    const blind = accesses.filter((a) => !(a.branches || []).some((x) => String(x) === String(home._id)));
    for (const a of blind) {
      const u = users.find((x) => String(x._id) === String(a.userId));
      const sup = u && isSuper(u);
      if (!sup) console.log(`\nNote: ${u ? nameOf(u) : a.userId} holds no branch with demo data - re-run with --open-branches to let them see it.`);
    }
  }

  if (!APPLY) {
    console.log('\nDry run complete. Nothing was written. Re-run with --yes to apply.');
    return;
  }

  // ═══ apply ════════════════════════════════════════════════════════════════
  console.log('\nWriting...');
  for (const name of CLEARED) await db.collection(name).deleteMany({}).catch(() => {});
  await FileModel.deleteMany(fileFilter);
  console.log('  cleared');

  await Customer.insertMany(out.customers);
  await CustomerActivity.insertMany(out.customerActivities);
  await Task.insertMany(out.tasks);
  await Notification.insertMany(out.notifications);
  console.log(`  CRM: ${out.customers.length} customers, ${out.customerActivities.length} activities, ${out.tasks.length} tasks`);

  await MisInvoice.insertMany(out.invoices);
  await InvoiceActivity.insertMany(out.invoiceActivities);
  for (const [key, seq] of counterSeq.entries()) {
    const [branchId, docType] = key.split('|');
    await InvoiceCounter.create({ branchId, docType, seq });
  }
  await MisPackingList.insertMany(out.packingLists);
  await MisPackingListActivity.insertMany(out.packingListActivities);
  console.log(`  MIS: ${out.invoices.length} documents, ${out.packingLists.length} packing lists`);

  await SupplyRecord.insertMany(out.supplyRecords);
  await SupplyDealLetter.insertMany(out.dealLetters);
  await SupplyDealLetterActivity.insertMany(out.dealActivities);
  await Sequence.create({ key: 'supplyRecord', seq: out.supplyRecords.length });
  console.log(`  Supply: ${out.supplyRecords.length} records, ${out.dealLetters.length} deal letters`);

  await PriceRequest.insertMany(out.priceRequests);
  await RawContent.insertMany(out.rawContents);
  await RawContentChat.insertMany(out.chats);
  await ReadyToUpload.insertMany(out.readyToUploads);
  await DmActivity.insertMany(out.dmActivities);
  await ExternalLinkPage.insertMany(out.linkPages);
  await WhatsappShare.insertMany(out.shares);
  console.log(`  Website + DM: ${out.priceRequests.length} requests, ${out.rawContents.length} raw contents, ${out.readyToUploads.length} ready to upload`);

  await Tutorial.insertMany(out.tutorials);
  await TutorialActivity.insertMany(out.tutorialActivities);

  fs.mkdirSync(UPLOADS, { recursive: true });
  const fileDocs = out.files.map((f) => {
    const { _doc_diskName, _doc_body, ...rest } = f;
    fs.writeFileSync(path.join(UPLOADS, _doc_diskName), _doc_body, 'utf8');
    return rest;
  });
  await FolderModel.insertMany(out.folders);
  await FileModel.insertMany(fileDocs);
  await FileActivity.insertMany(out.fileActivities).catch(() => {});
  console.log(`  Tutorials + files: ${out.tutorials.length} tutorials, ${out.folders.length} folders, ${fileDocs.length} files`);

  // stock the committed documents took, written the way the app writes it
  const touched = new Set();
  for (const move of out.stockMoves) {
    const variant = await InvVariant.findOne({ _id: move.variantId, deleteDate: null });
    if (!variant) continue;
    const oldQty = Number(variant.quantity) || 0;
    const newQty = parseFloat((oldQty - move.quantity).toFixed(4));
    await InvVariant.updateOne({ _id: variant._id }, { $set: { quantity: newQty, updateDate: new Date() } });
    await InvChangeLog.create({
      subjectType: 'variant', subjectId: variant._id, productId: variant.productId,
      changeType: 'quantity', field: 'quantity', oldValue: oldQty, newValue: newQty,
      delta: -move.quantity, unit: variant.unit, reason: move.reason, source: 'order',
      changedBy: admin._id, changedByName: nameOf(admin), date: new Date(), createdAt: new Date(),
    });
    touched.add(String(variant.productId));
  }
  for (const pid of touched) await recomputeRollup(pid);
  console.log(`  Stock: ${out.stockMoves.length} committed lines, ${touched.size} product rollups recomputed`);

  // supply figures sit beside the real quantity, never inside it
  const supplyVariants = new Set();
  for (const dl of out.dealLetters) for (const l of dl.varietyLines) supplyVariants.add(String(l.variantId));
  for (const vid of supplyVariants) await recomputeVariantSupplyRollup(vid);
  for (const pid of new Set(out.supplyRecords.map((r) => String(r.productId)))) await recomputeProductSupplyRollup(pid);
  console.log(`  Supply rollups: ${supplyVariants.size} varieties`);

  if (needsShare) {
    await Branch.updateOne({ _id: home._id }, { $addToSet: { crossBranchAccess: away._id } });
    console.log(`  Sharing: ${home.name} -> ${away.name}`);
  }
  for (const a of needBranch) {
    await UserAccess.updateOne({ _id: a._id }, { $addToSet: { branches: { $each: seededBranchIds.map((id) => new mongoose.Types.ObjectId(id)) } } });
  }
  if (needBranch.length) console.log(`  Branch access: ${needBranch.length} user(s) can now see the seeded branches`);

  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error('\nFAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    dbConnection.removeAllListeners('disconnected');
    await dbConnection.close().catch(() => {});
  });
