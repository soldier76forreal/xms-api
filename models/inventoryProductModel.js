const mongoose = require('mongoose');

const inventoryProductSchema = new mongoose.Schema({
  code:          { type: String, required: true, unique: true, uppercase: true, trim: true },
  stoneType:     { type: String, required: true, uppercase: true, trim: true },
  stoneTypeName: { type: String, trim: true },
  quarryCode:    { type: String, required: true, trim: true },
  quarryName:    { type: String, trim: true },
  name:          { type: String, trim: true },
  nameAr:        { type: String, trim: true },
  description:   { type: String, trim: true },
  category:      { type: String, trim: true },
  defaultUnit:   { type: String, enum: ['M2', 'ML', 'PCS', 'SQFT', 'LNFT'], default: 'M2' },
  coverMediaId:  { type: mongoose.Schema.Types.ObjectId, default: null },
  status:        { type: String, enum: ['active', 'archived'], default: 'active' },
  totalsByUnit:  { type: mongoose.Schema.Types.Mixed, default: {} },
  variantCount:  { type: Number, default: 0 },
  priceRange: {
    min:      { type: Number, default: null },
    max:      { type: Number, default: null },
    currency: { type: String, default: 'AED' },
  },
  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
  deleteDate: { type: Date, default: null },
  createdBy:  { type: mongoose.Schema.Types.ObjectId },
  updatedBy:  { type: mongoose.Schema.Types.ObjectId },
});

module.exports = inventoryProductSchema;
