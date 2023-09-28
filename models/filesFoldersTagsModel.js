const mongoose = require('mongoose');

var folderFileTagSchema = new mongoose.Schema({
    tag:{ type: String , require:true},
    files:{type: Array},
    folders:{type: Array},
    generatedBy:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type:Date},
    insertDate : {type:Date , default:Date.now},
    updatedBy:{ type: mongoose.Schema.Types.ObjectId},
    logsStatus:{status:{type:String} , msg:{type:String}},
    logs:[mongoose.Mixed],
    deleteDate:{type:Date , default:null}

  });
module.exports = folderFileTagSchema;