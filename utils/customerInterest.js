// A stone that is tied to a customer is one that customer is interested in.
//
// When a daily report is FILED (submitted, or a filed one edited) every row that names a customer and a catalogue
// stone — a confirmed order, a lost order, a request for something we do not have — adds that stone to the
// customer's `interestedProducts`, so the CRM record carries what the person actually talks about and buys.
//
//   · only a stone from the catalogue counts (a variant id); a stone typed as plain text has nothing to link;
//   · it adds, never removes: editing a report to drop a stone leaves the customer's interest in it;
//   · one entry per variety — a stone the customer already has is not added again (the check is part of the
//     update itself, so two reports filed at the same instant cannot both add it);
//   · a draft never touches the CRM: it is nobody's record yet;
//   · it is a side effect of a report whose customers and stones were resolved under the author's own scopes, so it
//     cannot reach a customer the author could not already open — and it never fails the report.
'use strict';

const dbConnection = require('../connections/xmsPr');
const customerSchema = require('../models/customerModel');
const customerActivitySchema = require('../models/customerActivityModel');
const { resolveJobReportTemplate, liftLegacyRow } = require('./jobReportTemplates');

const Customer = dbConnection.models.customer || dbConnection.model('customer', customerSchema);
const CustomerActivity = dbConnection.models.customerActivity || dbConnection.model('customerActivity', customerActivitySchema);

/** Map<customerId, [{ variantId, productId, branchId }]> — which catalogue stones a filed report ties to which customers. */
function productsLinkedToCustomers(templateKey, sections) {
  const tpl = resolveJobReportTemplate(templateKey);
  const byCustomer = new Map();
  const take = (customerId, variety) => {
    if (!variety || !variety.variantId || !variety.productId) return;
    const key = String(customerId);
    if (!byCustomer.has(key)) byCustomer.set(key, new Map());
    byCustomer.get(key).set(String(variety.variantId), {
      variantId: variety.variantId, productId: variety.productId, branchId: variety.branchId || null,
    });
  };

  (tpl.sections || []).forEach((section) => {
    if (section.kind !== 'table') return;
    const cols = section.columns || [];
    const customerCols = cols.filter((c) => c.type === 'customer');
    if (!customerCols.length) return;
    ((sections || {})[section.key] || []).forEach((rawRow) => {
      const row = liftLegacyRow(section, rawRow) || {};
      const customer = customerCols.map((c) => row[c.key]).find((v) => v && v.customerId);
      if (!customer) return;
      cols.forEach((c) => {
        if (c.type === 'variety') take(customer.customerId, row[c.key]);
        if (c.type === 'lines') {
          (Array.isArray(row[c.key]) ? row[c.key] : []).forEach((item) => {
            (c.columns || []).forEach((nc) => { if (nc.type === 'variety') take(customer.customerId, item && item[nc.key]); });
          });
        }
      });
    });
  });
  return new Map([...byCustomer.entries()].map(([id, stones]) => [id, [...stones.values()]]));
}

/** Add stones to a customer's interested products; returns the ones that were new. */
async function addInterestedProducts(customerId, products, { userId, actorName = '', source = 'xms', body = '' } = {}) {
  const added = [];
  for (const p of products) {
    const now = new Date();
    const result = await Customer.updateOne(
      { _id: customerId, deleteDate: null, 'interestedProducts.variantId': { $ne: p.variantId } },
      {
        $push: {
          interestedProducts: {
            productId: p.productId, variantId: p.variantId, branchId: p.branchId || null, note: '',
            source, addedToWebsitePurchaseList: false, requestedQuantity: null, addedAt: now,
          },
        },
        $set: { updateDate: now, updatedBy: userId },
      },
    );
    if (result.modifiedCount) added.push({ productId: p.productId, variantId: p.variantId });
  }
  if (added.length) {
    await CustomerActivity.create({
      customerId, type: 'interest', body, newValue: added, actorId: userId, actorName, date: new Date(), createdAt: new Date(),
    });
  }
  return added;
}

/** After a daily report is filed: every stone tied to a customer becomes that customer's interest. Never throws. */
async function syncReportInterest(report, userId, actorName) {
  try {
    const linked = productsLinkedToCustomers(report.templateKey, report.sections);
    for (const [customerId, products] of linked) {
      await addInterestedProducts(customerId, products, { userId, actorName, source: 'jobReport', body: 'From a daily report' });
    }
  } catch (err) {
    console.error('syncReportInterest failed:', err && err.message);
  }
}

module.exports = { productsLinkedToCustomers, addInterestedProducts, syncReportInterest };
