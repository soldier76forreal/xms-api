const mongoose = require('mongoose');

// Website tag — mirrors categoryModel.js exactly. Inventory already has
// categories (one product picks one category); tags are the additional,
// multi-select website taxonomy WooCommerce's product-tag system covered and
// Inventory never had a concept for (see inventoryProductModel.js's
// website.tags[]).
const inventoryTagSchema = new mongoose.Schema({
  name:        { type: String, required: true, unique: true, trim: true },
  description: { type: String, trim: true, default: '' },
  insertDate:  { type: Date, default: Date.now },
  deleteDate:  { type: Date, default: null },
});

module.exports = inventoryTagSchema;
