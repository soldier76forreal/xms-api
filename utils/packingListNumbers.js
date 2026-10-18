// A packing list's number: AUTOMATIC from a per-branch counter, and EDITABLE.
//
//   automatic   a new list takes the branch's next number. The counter is the same atomic one every MIS
//               document uses (`invoiceCounter`, docType 'packing_list') - never assigned by the browser.
//   editable    the person may type their own number, on a new list or on an existing one. It must be a
//               whole number nobody else in the SAME branch is using (the unique index on
//               {branchId, docNumber} for lists that are not deleted is the real guard; the checks here
//               only turn its error into a plain answer).
//   continuing  a hand-typed number higher than the counter MOVES the counter up to it, so the automatic
//               numbers carry on after it instead of walking into it. A lower number does not move it, and
//               a number that is already taken is skipped, so "automatic" can never fail on a number
//               somebody typed. A deleted list gives its number back (a manual one may reuse it); the
//               counter itself never rewinds.
//
// The printed packing list shows this number (utils/packingListTemplate.js).
const dbConnection = require('../connections/xmsPr');
const misPackingListSchema = require('../models/misPackingListModel');
const invoiceCounterSchema = require('../models/invoiceCounterModel');

const MisPackingList = dbConnection.models.misPackingList || dbConnection.model('misPackingList', misPackingListSchema);
const InvoiceCounter = dbConnection.models.invoiceCounter || dbConnection.model('invoiceCounter', invoiceCounterSchema);

const DOC_TYPE = 'packing_list';
const MAX_NUMBER = 99999999;   // eight digits: far more than a branch will ever print, short enough to read on paper

/** Read a number somebody typed: a whole number from 1 to MAX_NUMBER ("#14" is fine). */
function parseDocNumber(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim().replace(/^#/, '');
  const value = /^\d{1,8}$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > MAX_NUMBER) {
    return { error: `The packing list number must be a whole number from 1 to ${MAX_NUMBER}.` };
  }
  return { value };
}

/** Was a number sent at all? An empty string / null / undefined means "automatic". */
const isBlank = (raw) => raw === undefined || raw === null || String(raw).trim() === '';

/** Is `number` already on another (not deleted) list of this branch? */
async function isTaken(branchId, number, excludeId = null) {
  const q = { branchId, docNumber: number, deleteDate: null };
  if (excludeId) q._id = { $ne: excludeId };
  return Boolean(await MisPackingList.exists(q));
}

/** The number a new list would get right now - looked at, NOT taken (the form shows it as the suggestion). */
async function peekNext(branchId) {
  const counter = await InvoiceCounter.findOne({ branchId, docType: DOC_TYPE }).select('seq').lean();
  let n = (counter && counter.seq) || 0;
  // numbers above the counter can exist (typed by hand): skip the ones that are used
  const above = await MisPackingList.find({ branchId, deleteDate: null, docNumber: { $gt: n } })
    .select('docNumber').sort({ docNumber: 1 }).limit(1000).lean();
  const used = new Set(above.map((row) => row.docNumber));
  n += 1;
  while (used.has(n)) n += 1;
  return n;
}

/** TAKE the next automatic number (atomic), skipping any that a person already typed. */
async function claimNext(branchId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let counter;
    try {
      counter = await InvoiceCounter.findOneAndUpdate(
        { branchId, docType: DOC_TYPE },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
    } catch (err) {
      // the very first lists of a branch can race to create the counter itself: the loser simply asks again
      if (err.code === 11000) continue;
      throw err;
    }
    if (!(await isTaken(branchId, counter.seq))) return counter.seq;
  }
  throw new Error('Could not find a free packing list number');
}

/** After a number was typed by hand: automatic numbers carry on AFTER it (never backwards). */
async function carryOnAfter(branchId, number) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await InvoiceCounter.updateOne(
        { branchId, docType: DOC_TYPE },
        { $max: { seq: number } },
        { upsert: true },
      );
      return;
    } catch (err) {
      // same race as above (the counter being created by someone else at that instant): once it exists this is a plain update
      if (err.code !== 11000) throw err;
    }
  }
}

const takenMessage = (number) => `Packing list number ${number} is already used in this branch.`;

module.exports = {
  MAX_NUMBER, parseDocNumber, isBlank, isTaken, peekNext, claimNext, carryOnAfter, takenMessage,
};
