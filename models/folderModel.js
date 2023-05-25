const mongoose = require('mongoose');

var folderSchema = new mongoose.Schema({
    name:{ type: String , require:true},
    subFolders:{ type: Array},
    subFiles:{type: Array},
    supFolder:{type: String},
    generatedBy:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type:Date},
    insertDate : {type:Date , default:Date.now},
    updatedBy:{ type: mongoose.Schema.Types.ObjectId},
    logsStatus:{status:{type:String} , msg:{type:String}},
    logs:[mongoose.Mixed],
    deleteDate:{type:Date , default:null}

  });
module.exports = folderSchema;