const mongoose = require('mongoose');

// var moment = require('jalali-moment');

var preInvoiceSchema = new mongoose.Schema({
    productName:{ type: String , require:true},
    meterage:{ type: Number , require:true },
    destination:{ type: String , require:true },
    companyName:{ type: String , require:true },
    generatedBy:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type:Date},
    updatedBy:{ type: mongoose.Schema.Types.ObjectId},
    logsStatus:{status:{type:String} , msg:{type:String}},
    logs:mongoose.Mixed
  });

//   var phoneNumberSchema = new mongoose.Schema({
//     countryCode:{ type: String , require:true},
//     personTitle:{ type: String , require:true},
//     number:{ type: Number , require:true },
//     deleteDate : {type:Date , default:null },
//     logsStatus:{status:{type:String} , msg:{type:String}},
//     insertDate : {type:Date , default:Date.now},
//     logs:mongoose.Mixed,
//     lastUpdater:{ type: mongoose.Schema.Types.ObjectId , require:true },
//     updateDate:{type: Date , require:true },
//     deleteDate:{type:Date},
//     updatedBy:{ type: mongoose.Schema.Types.ObjectId  }
//   });

//   var emailSchema = new mongoose.Schema({
//     email:{ type: String , require:true},
//     deleteDate : {type:Date , default:null},
//     insertDate : {type:Date , default:Date.now},
//     logsStatus:{status:{type:String} , msg:{type:String}},
//     logs:mongoose.Mixed,
//     lastUpdater:{ type: mongoose.Schema.Types.ObjectId , require:true },
//     updateDate:{type: Date , require:true},
//     deleteDate:{type:Date},
//     updatedBy:{ type: mongoose.Schema.Types.ObjectId  }
//   });
  
//   var addressSchema = new mongoose.Schema({
//     country:{ type: String , require:true },
//     city:{ type: String , require:true },
//     province:{ type: String , require:true },
//     street:{ type: String , require:true },
//     plate : {type: String , require:true },
//     postalCode : {type: String , require:true },
//     explanations : {type: String , require:true },
//     mapLink : {type: String , require:true },
//     deleteDate:{type:Date},
//     logsStatus:{status:{type:String} , msg:{type:String}},
//     insertDate : {type:Date , default:Date.now},
//     logs:mongoose.Mixed,
//     lastUpdater:{ type: mongoose.Schema.Types.ObjectId , require:true },
//     updateDate:{type: Date , require:true },
//     updatedBy:{ type: mongoose.Schema.Types.ObjectId }
//   })
const invoice = new mongoose.Schema ({
    preInvoice:preInvoiceSchema,
    sharedTo:[{to:{type:mongoose.Schema.Types.ObjectId} , by:{type:mongoose.Schema.Types.ObjectId} , date:{type:Date}}],
    status:{type:Number , default:0},
    inisialInsert : {type: mongoose.Schema.Types.ObjectId },
    deleteDate:{type:Date}
});


module.exports = invoice;