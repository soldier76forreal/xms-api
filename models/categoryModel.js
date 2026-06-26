const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  name:        { type: String, required: true, unique: true, trim: true },
  description: { type: String, trim: true, default: '' },
  insertDate:  { type: Date, default: Date.now },
  deleteDate:  { type: Date, default: null },
});

module.exports = categorySchema;
