const mongoose = require('mongoose');

// var moment = require('jalali-moment');

var personalInformationSchema = new mongoose.Schema({
    country:{ type: String},
    personTitle:{ type: String },
    firstName:{ type: String , require:true },
    lastName:{ type: String , require:true },
    dateOfBirth:{type:Date },
    customerType:{type: String },
    attractedBy:{ type: String},
    favoriteProducts : [{ type: mongoose.Schema.Types.ObjectId }],
    gender:{ type: String}
  });

  var phoneNumberSchema = new mongoose.Schema({
    countryCode:{ type: String , require:true},
    number:{ type: Number , require:true },
    whatsApp:{ type: Boolean}
  });

  var emailSchema = new mongoose.Schema({
    email:{type: String}
  });

  var addressSchema = new mongoose.Schema({
    country:{ type: String  },
    city:{ type: String },
    province:{ type: String},
    street:{ type: String },
    plate : {type: String },
    neighbourhood : {type: String},
    postalCode : {type: String },
    explanations : {type: String },
    mapLink : {type: String }
  })
  var phoneCallsSchema = new mongoose.Schema({
    countryCode:{ type: String},
    phoneNumber:{type:String},
    callDate:{type:Date},
    callReason:{ type: String},
    targetRequests:{ type: [{ type: mongoose.Schema.Types.ObjectId }]},
    callStatus:{ type: Boolean},
    description : {type: String}
  })
  const customer = new mongoose.Schema ({
      inisialInsert : {type: mongoose.Schema.Types.ObjectId },
      deleteDate:{type:Date},
       Status:{status:{type:String} , msg:{type:String}},
      insertDate : {type:Date , default:Date.now},
      logs:mongoose.Mixed,
      updateDate:{type: Date},
      phoneCalls : [phoneCallsSchema],
      updatedBy:{ type: mongoose.Schema.Types.ObjectId },
      personalInformation:{
        country:{ type: String},
        personTitle:{ type: String },
        firstName:{ type: String , require:true },
        lastName:{ type: String , require:true },
        dateOfBirth:{dateType:{type:String} , date:{type:Date}},
        customerType:{type: String },
        attractedBy:{ type: String},
        favoriteProducts : [{ type: mongoose.Schema.Types.ObjectId }],
        gender:{ type: String}
      },
      contactInfo:{phoneNumbers:[phoneNumberSchema] , emails:[emailSchema]},
      address:[addressSchema],
  });


module.exports = customer;