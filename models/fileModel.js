const mongoose = require('mongoose');

var fileSchema = new mongoose.Schema({
    name:{ type: String , require:true},
    supFolder:{type: String},
    metaData : {type:Object , required:true},
    format:{type:String},
    tags:{type:Array},
    generatedBy:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type:Date},
    insertDate : {type:Date , default:Date.now},
    updatedBy:{ type: mongoose.Schema.Types.ObjectId},
    logsStatus:{status:{type:String} , msg:{type:String}},
    logs:[mongoose.Mixed]
  });
module.exports = fileSchema;