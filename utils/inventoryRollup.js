// Shared product-level rollup recompute — extracted from routes/inventory/main.js
// (Session 72) so routes/supply/main.js's "receive into warehouse" action can
// call the SAME real-stock rollup after moving Supply quantity into
// InvVariant.quantity, instead of duplicating this logic. Pure extraction —
// behavior is unchanged from the original inline version.
const dbConnection = require('../connections/xmsPr');
const inventoryProductSchema = require('../models/inventoryProductModel');
const inventoryVariantSchema = require('../models/inventoryVariantModel');

const InvProduct = dbConnection.models.inventoryProduct || dbConnection.model('inventoryProduct', inventoryProductSchema);
const InvVariant = dbConnection.models.inventoryVariant || dbConnection.model('inventoryVariant', inventoryVariantSchema);

// Never sum quantities across units — totalsByUnit stays keyed per unit
// (e.g. {M2: 120.5, ML: 40}), m² and ml are not addable.
async function recomputeRollup(productId) {
  const variants = await InvVariant.find({
    productId,
    deleteDate: null,
    status: 'active',
  });

  const totalsByUnit = {};
  let minPrice = null;
  let maxPrice = null;

  for (const v of variants) {
    totalsByUnit[v.unit] = parseFloat(
      ((totalsByUnit[v.unit] || 0) + (v.quantity || 0)).toFixed(4)
    );
    if (v.price != null) {
      if (minPrice === null || v.price < minPrice) minPrice = v.price;
      if (maxPrice === null || v.price > maxPrice) maxPrice = v.price;
    }
  }

  await InvProduct.findByIdAndUpdate(productId, {
    totalsByUnit,
    variantCount: variants.length,
    priceRange: { min: minPrice, max: maxPrice, currency: 'AED' },
    updateDate: new Date(),
  });
}

module.exports = { recomputeRollup };
