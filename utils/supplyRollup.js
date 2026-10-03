// Recomputes the live forecast/final Supply totals shown alongside (never
// merged into) real Inventory quantity — mirrors recomputeRollup's unit-keyed
// discipline in utils/inventoryRollup.js, but sums across the SUPPLY-side
// fields instead of real stock.
const dbConnection = require('../connections/xmsPr');
const inventoryProductSchema = require('../models/inventoryProductModel');
const inventoryVariantSchema = require('../models/inventoryVariantModel');
const supplyDealLetterSchema = require('../models/supplyDealLetterModel');

const InvProduct       = dbConnection.models.inventoryProduct   || dbConnection.model('inventoryProduct',   inventoryProductSchema);
const InvVariant       = dbConnection.models.inventoryVariant   || dbConnection.model('inventoryVariant',   inventoryVariantSchema);
const SupplyDealLetter = dbConnection.models.supplyDealLetter   || dbConnection.model('supplyDealLetter',   supplyDealLetterSchema);

// A variant's live forecast/final supply figures are the sum across every
// non-deleted deal letter line referencing it:
//   forecastQty = sum of forecastQty on lines still in 'purchasing'/'processing'
//   finalQty    = sum of (finalQty - receivedQty) on lines in 'final_product'
//                 (only the NOT-YET-received remainder counts as "supply
//                 quantity" — once received it becomes real InvVariant.quantity)
async function recomputeVariantSupplyRollup(variantId) {
  const dealLetters = await SupplyDealLetter.find({
    deleteDate: null,
    'varietyLines.variantId': variantId,
  }).lean();

  let forecastQty = 0;
  let finalQty = 0;

  // Stone promised to accepted quotations / requests (allocatedQty) is no
  // longer available, so it's left out of both figures — the amount shown on
  // Inventory is what can still be asked for.
  for (const dl of dealLetters) {
    for (const line of dl.varietyLines) {
      if (String(line.variantId) !== String(variantId)) continue;
      const allocated = line.allocatedQty || 0;
      if (dl.status === 'final_product') {
        const remaining = (line.finalQty || 0) - (line.receivedQty || 0) - allocated;
        if (remaining > 0) finalQty += remaining;
      } else {
        const left = (line.forecastQty || 0) - allocated;
        if (left > 0) forecastQty += left;
      }
    }
  }

  await InvVariant.findByIdAndUpdate(variantId, {
    'supply.forecastQty': parseFloat(forecastQty.toFixed(4)),
    'supply.finalQty': parseFloat(finalQty.toFixed(4)),
  });
}

// Product-level rollup — unit-keyed, never summed across units (same rule as
// totalsByUnit). Re-reads variants fresh so it reflects whatever
// recomputeVariantSupplyRollup just wrote.
async function recomputeProductSupplyRollup(productId) {
  const variants = await InvVariant.find({ productId, deleteDate: null, status: 'active' }).lean();

  const forecast = {};
  const final = {};
  for (const v of variants) {
    const unit = v.unit;
    const fc = (v.supply && v.supply.forecastQty) || 0;
    const fn = (v.supply && v.supply.finalQty) || 0;
    if (fc) forecast[unit] = parseFloat(((forecast[unit] || 0) + fc).toFixed(4));
    if (fn) final[unit] = parseFloat(((final[unit] || 0) + fn).toFixed(4));
  }

  await InvProduct.findByIdAndUpdate(productId, {
    supplyTotalsByUnit: { forecast, final },
    updateDate: new Date(),
  });
}

module.exports = { recomputeVariantSupplyRollup, recomputeProductSupplyRollup };
