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
      enum: ['file_manager', 'inventory', 'users', 'crm', 'mis', 'jobReport', 'projectManager', 'digitalMarketing'],
      default: 'file_manager',
    },
    attachedTo: {
      type: {
        type: String,
        enum: ['inventoryProduct', 'inventoryVariant', 'user', 'customer', 'customerActivity', 'invoice', 'jobReport', 'rawContent', 'rawContentChat', 'readyToUpload'],
      },
      id: { type: mongoose.Schema.Types.ObjectId },
    },
    // Variant media batch (Inventory) — groups files uploaded together as one
    // replaceable set; batchId is shared by every file in the same batch.
    batchId:        { type: mongoose.Schema.Types.ObjectId, default: null },
    uploadDate:      { type: Date, default: Date.now },
    expirationDate:  { type: Date, default: null },
    uploadedByName:  { type: String },
    // Phase 9 — per-user pins (see folderModel)
    pinnedBy:       [{ type: mongoose.Schema.Types.ObjectId }],
  });
module.exports = fileSchema;