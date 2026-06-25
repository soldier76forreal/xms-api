const mongoose = require("mongoose");

// ---------- Quantity & Price SubSchema ----------
const quantityPriceSchema = new mongoose.Schema(
  {
    quantity: {
      type: Number,
      required: true,
      min: 0
    },

    // e.g. "kg", "ton", "piece"
    scale: {
      type: String,
      trim: true
    },

    // from quantity (for tier pricing)
    from: {
      type: String,
    },

    price: {
      sector: {
        type: Number,
        min: 0
      },
      wholesale: {
        type: Number,
        min: 0
      },
      bulk: {
        type: Number,
        min: 0
      },
      currency: {
        type: String,
        uppercase: true,
        default: "USD"
      }
    }
  },
  { _id: false }
);

// ---------- Product Schema ----------
const productSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true
    },

    // 🌍 MULTI-LANGUAGE NAMES
    names: {
      ar: { type: String },
      fa: { type: String },
      en: { type: String},
      mine: { type: String }
    },

    // TREE STRUCTURE
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null
    },

    isRoot: {
      type: Boolean,
      default: false
    },

    // SUB PRODUCT ONLY
    quality: {
      type: String,
      enum: ["Q", "W", "E", "R", "T", "Y"]
    },

    // ✅ Quantity & Price (ARRAY)
    quantityAndPrice: {
      type: [quantityPriceSchema],
      default: []
    },

    dimensions: {
      width: Number,
      height: Number,
      thickness: Number
    },

    description: String,

    active: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

module.exports = productSchema;
