const mongoose = require('mongoose');

var notficationSchema = new mongoose.Schema({
    from:{ type: mongoose.Schema.Types.ObjectId , require:true },
    document:{ type: mongoose.Schema.Types.ObjectId , require:true },
    to:{ type: mongoose.Schema.Types.ObjectId , require:true },
    insertDate : {type:Date , default:Date.now},
    status:{type:Number , default:0},
    deleteDate:{type:Date , default:null},
    type:{type:String  , require:true}


  });
  module.exports = notficationSchema;