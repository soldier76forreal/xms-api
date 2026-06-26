const mongoose = require('mongoose');

var fileSchema = new mongoose.Schema({
    name:{ type: String , require:true},
    supFolder:{type: String},
    metaData : {type:Object , required:true},
    format:{type:String},
    hidden:{type:Boolean},
    tags:{type: Array},
    generatedBy:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type:Date},
    insertDate : {type:Date , default:Date.now},
    updatedBy:{ type: mongoose.Schema.Types.ObjectId},
    logsStatus:{status:{type:String} , msg:{type:String}},
    logs:[mongoose.Mixed],
    thumbnail: { type: String, default: null },
    deleteDate: { type: Date, default: null },
    scope: {
      type: String,
      enum: ['file_manager', 'inventory', 'crm', 'mis', 'jobReport', 'projectManager'],
      default: 'file_manager',
    },
    attachedTo: {
      type: {
        type: String,
        enum: ['inventoryProduct', 'inventoryVariant', 'customer', 'invoice', 'jobReport'],
      },
      id: { type: mongoose.Schema.Types.ObjectId },
    },
  });
module.exports = fileSchema;