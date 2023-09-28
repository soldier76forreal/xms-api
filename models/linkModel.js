const mongoose = require('mongoose');

var linkSchema = new mongoose.Schema({
    document:{ type: Array , require:true},
    token:{type: String},
    secret:{type: String},
    opend:{type:String},
    msg:{type: String},
    showName:{type: Boolean},
    generatedBy:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type:Date},
    insertDate : {type:Date , default:Date.now},
    updatedBy:{ type: mongoose.Schema.Types.ObjectId},
    logsStatus:{status:{type:String} , msg:{type:String}},
    logs:[mongoose.Mixed],
    deleteDate:{type:Date , default:null}
  });
module.exports = linkSchema;