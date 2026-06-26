const mongoose = require('mongoose');

const inventoryVariantSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'inventoryProduct' },
  code:      { type: String, required: true, unique: true, uppercase: true, trim: true },
  spec: {
    stoneType:     String,
    stoneTypeName: String,
    quarryCode:    String,
    grade:         String,
    gradeName:     String,
    gradeRank:     Number,
    lengthCm:      Number,
    widthCm:       Number,
    thicknessMm:   Number,
    unsized:       Boolean,
    cut:           String,
    cutName:       String,
    fill:          String,
    fillName:      String,
    finish:        String,
    finishName:    String,
    raw:           String,
    parseWarnings: [String],
  },
  categories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'inventoryCategory' }],
  unit:     { type: String, enum: ['M2', 'ML', 'PCS', 'SQFT', 'LNFT'], default: 'M2' },
  quantity: { type: Number, default: 0 },
  price:    { type: Number, default: null },
  currency: { type: String, default: 'AED' },
  status:   { type: String, enum: ['active', 'archived'], default: 'active' },
  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
  deleteDate: { type: Date, default: null },
  createdBy:  { type: mongoose.Schema.Types.ObjectId },
  updatedBy:  { type: mongoose.Schema.Types.ObjectId },
});

module.exports = inventoryVariantSchema;
