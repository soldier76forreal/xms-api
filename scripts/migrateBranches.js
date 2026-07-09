// One-off migration (idempotent): branches are now a required, fully-isolating
// dimension on Inventory + MIS. Pre-existing data has no branchId, so:
//   1. Create (or reuse) a "Main Branch" as the home for all pre-existing data.
//   2. Backfill branchId onto every inventoryProduct / inventoryVariant /
//      misInvoice / invoiceCounter document that doesn't have one yet.
//   3. Give every existing user access to Main Branch (via userAccess.branches)
//      so nobody loses access to data they could already see before this change.
// Safe to re-run — every step is a targeted update on missing/absent branchId.
require('dotenv').config();
const mongoose = require('mongoose');
const dbConnection = require('../connections/xmsPr');

const branchSchema             = require('../models/branchModel');
const inventoryProductSchema   = require('../models/inventoryProductModel');
const inventoryVariantSchema   = require('../models/inventoryVariantModel');
const misInvoiceSchema         = require('../models/misInvoiceModel');
const invoiceCounterSchema     = require('../models/invoiceCounterModel');
const userAccessSchema         = require('../models/userAccessModel');

const Branch         = dbConnection.model('branch', branchSchema);
const InvProduct     = dbConnection.model('inventoryProduct', inventoryProductSchema);
const InvVariant     = dbConnection.model('inventoryVariant', inventoryVariantSchema);
const MisInvoice     = dbConnection.model('misInvoice', misInvoiceSchema);
const InvoiceCounter = dbConnection.model('invoiceCounter', invoiceCounterSchema);
const UserAccess     = dbConnection.model('userAccess', userAccessSchema);

function waitForConnection(conn) {
  return new Promise((resolve, reject) => {
    if (conn.readyState === 1) return resolve();
    conn.once('open', resolve);
    conn.once('error', reject);
  });
}

async function migrate() {
  await waitForConnection(dbConnection);
  console.log('Connected. Migrating to branch-isolated Inventory/MIS...');

  let mainBranch = await Branch.findOne({ name: 'Main Branch', deleteDate: null });
  if (!mainBranch) {
    mainBranch = await Branch.create({ name: 'Main Branch', description: 'Default branch — pre-existing data before multi-branch support.' });
    console.log('Created Main Branch:', mainBranch._id.toString());
  } else {
    console.log('Reusing existing Main Branch:', mainBranch._id.toString());
  }
  const branchId = mainBranch._id;

  const r1 = await InvProduct.updateMany({ branchId: { $exists: false } }, { $set: { branchId } });
  console.log(`inventoryProducts backfilled: ${r1.modifiedCount}`);

  const r2 = await InvVariant.updateMany({ branchId: { $exists: false } }, { $set: { branchId } });
  console.log(`inventoryVariants backfilled: ${r2.modifiedCount}`);

  const r3 = await MisInvoice.updateMany({ branchId: { $exists: false } }, { $set: { branchId } });
  console.log(`misInvoices backfilled: ${r3.modifiedCount}`);

  const r4 = await InvoiceCounter.updateMany({ branchId: { $exists: false } }, { $set: { branchId } });
  console.log(`invoiceCounters backfilled: ${r4.modifiedCount}`);

  const r5 = await UserAccess.updateMany(
    { branches: { $nin: [branchId] } },
    { $addToSet: { branches: branchId } }
  );
  console.log(`userAccess docs given Main Branch access: ${r5.modifiedCount}`);

  // Sync indexes on the models whose unique-index shape changed (global →
  // per-branch compound) so Mongo actually drops the old index and builds the new one.
  await InvProduct.syncIndexes();
  await InvVariant.syncIndexes();
  await MisInvoice.syncIndexes();
  await InvoiceCounter.syncIndexes();
  console.log('Indexes synced.');

  console.log('Done. Main Branch id:', branchId.toString());
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
