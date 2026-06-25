const mongoose = require('mongoose');

var pwaSubscriptionSchema = new mongoose.Schema({
    subscription:[{ type: String , require:true }],
    userId:{ type: mongoose.Schema.Types.ObjectId , require:true , unique:true }
  });
  module.exports = pwaSubscriptionSchema;