const mongoose = require('mongoose');

// var moment = require('jalali-moment');

var personalInformationSchema = new mongoose.Schema({
    country:{ type: String},
    personTitle:{ type: String , require:true },
    firstName:{ type: String , require:true },
    lastName:{ type: String , require:true },
    dateOfBirth:{type:Date },
    lastUpdater:{ type: mongoose.Schema.Types.ObjectId , require:true },
    customerType:{type: String },
    updateDate:{type: Date  },
    attractedBy:{ type: String , require:true },
    updatedBy:{ type: mongoose.Schema.Types.ObjectId},
    favoriteProducts : [{ type: mongoose.Schema.Types.ObjectId }],
    gender:{ type: String},
    logsStatus:{status:{type:String} , msg:{type:String}},
    logs:mongoose.Mixed
  });

  var phoneNumberSchema = new mongoose.Schema({
    countryCode:{ type: String , require:true},
    personTitle:{ type: String , require:true},
    number:{ type: Number , require:true },
    deleteDate : {type:Date , default:null },
    logsStatus:{status:{type:String} , msg:{type:String}},
    insertDate : {type:Date , default:Date.now},
    logs:mongoose.Mixed,
    lastUpdater:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type: Date , require:true },
    deleteDate:{type:Date},
    updatedBy:{ type: mongoose.Schema.Types.ObjectId  }
  });

  var emailSchema = new mongoose.Schema({
    email:{ type: String , require:true},
    deleteDate : {type:Date , default:null},
    insertDate : {type:Date , default:Date.now},
    logsStatus:{status:{type:String} , msg:{type:String}},
    logs:mongoose.Mixed,
    lastUpdater:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type: Date , require:true},
    deleteDate:{type:Date},
    updatedBy:{ type: mongoose.Schema.Types.ObjectId  }
  });
  
  var addressSchema = new mongoose.Schema({
    country:{ type: String , require:true },
    city:{ type: String , require:true },
    province:{ type: String , require:true },
    street:{ type: String , require:true },
    plate : {type: String , require:true },
    postalCode : {type: String , require:true },
    explanations : {type: String , require:true },
    mapLink : {type: String , require:true },
    deleteDate:{type:Date},
    logsStatus:{status:{type:String} , msg:{type:String}},
    insertDate : {type:Date , default:Date.now},
    logs:mongoose.Mixed,
    lastUpdater:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type: Date , require:true },
    updatedBy:{ type: mongoose.Schema.Types.ObjectId }
  })
const customer = new mongoose.Schema ({
    inisialInsert : {type: mongoose.Schema.Types.ObjectId },
    deleteDate:{type:Date},
    logsStatus:{status:{type:String} , msg:{type:String}},
    insertDate : {type:Date , default:Date.now},
    logs:mongoose.Mixed,
    lastUpdater:{ type: mongoose.Schema.Types.ObjectId , require:true },
    updateDate:{type: Date , require:true },
    updatedBy:{ type: mongoose.Schema.Types.ObjectId , require:true },
    personalInformation:{personalInformationSchema},
    contactInfo:{phoneNumbers:[phoneNumberSchema] , emails:[emailSchema]},
    address:[addressSchema],
});


module.exports = customer;