const mongoose = require('mongoose');

var preInvoiceSchema = new mongoose.Schema({
    productName:{ type: String , require:true},
    meterage:{ type: String , default:null},
    dimentions:{ width :{type: String , require:true}, height:{type:String , require:true}, diameter:{type:String , require:true}},
    destination:{ type: String , require:true },
    companyName:{ type: String , require:true },
    generatedBy:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type:Date},
    insertDate : {type:Date , default:Date.now},
    updatedBy:{ type: mongoose.Schema.Types.ObjectId},
    logsStatus:{status:{type:String} , msg:{type:String}},
    logs:[mongoose.Mixed]
  });
  var completeInvoiceSchema = new mongoose.Schema({
    invoiceDate:{ type: Date , require:true},
    costCnf:{ type: String , require:true},
    costFob:{ type: String , require:true},
    factoryPrice:{ type: String , require:true},
    stoneThickness:{ type: String , require:true},
    stoneRate:{ type: String , require:true},
    insertDate : {type:Date , default:Date.now},
    dateOfShipment:{ type:Date , require:true},
    generatedBy:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type:Date},
    deleteDate:{type:Date , default:null},
    updatedBy:{ type: mongoose.Schema.Types.ObjectId},
    logsStatus:{status:{type:String} , msg:{type:String}},
    logs:[mongoose.Mixed]
  });
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
    completeInvoice:completeInvoiceSchema,
    sharedTo:[{to:{type:mongoose.Schema.Types.ObjectId}  ,deleteDate:{type:Date , default:null}, by:{type:mongoose.Schema.Types.ObjectId} , date:{type:Date}}],
    status:{type:Number , default:0},
    inisialInsert : {type: mongoose.Schema.Types.ObjectId },
    deleteDate:{type:Date , default:null}
});


module.exports = invoice;