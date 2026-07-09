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
  var instagramSchema = new mongoose.Schema({
    instagram:{type: String}
  });
  var linkedInSchema = new mongoose.Schema({
    linkedIn:{type: String}
  });
  var websiteSchema = new mongoose.Schema({
    website:{type: String}
  });
  var botimSchema = new mongoose.Schema({
    botim:{type: String}
  });
  var facebookSchema = new mongoose.Schema({
    facebook:{type: String}
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
  
  var communicationSchema = new mongoose.Schema({
    platform:{ type: String},
    channel:{type:String},
    communicationDate:{type:Date},
    communicationReason:{ type: String},
    targetRequests:{ type: [{ type: mongoose.Schema.Types.ObjectId }]},
    communicationStatus:{ type: Boolean},
    description : {type: String}
  })
  const customer = new mongoose.Schema ({
      inisialInsert : {type: mongoose.Schema.Types.ObjectId },
      deleteDate:{type:Date},
       Status:{status:{type:String} , msg:{type:String}},
      insertDate : {type:Date , default:Date.now},
      logs:mongoose.Mixed,
      explanations:{ type: String},
      updateDate:{type: Date},
      frequentBtnClick:{type:Array},
      communication : [communicationSchema],
      updatedBy:{ type: mongoose.Schema.Types.ObjectId },
      personalInformation:{
        country:{ type: String},
        personTitle:{ type: String },
        firstName:{ type: String},
        lastName:{ type: String},
        companyName:{ type: String},
        contactPerson:{ type: String },
        dateOfBirth:{dateType:{type:String} , date:{type:Date}},
        customerType:{type: String },
        personOrCompany:{type: String },
        attractedBy:{ type: String},
        favoriteProducts : [{ type: mongoose.Schema.Types.ObjectId }],
        gender:{ type: String}
      },
      contactInfo:{phoneNumbers:[phoneNumberSchema] , emails:[emailSchema] , instagrams:[instagramSchema] , linkedIns:[linkedInSchema] , websites:[websiteSchema] ,  botims:[botimSchema] , facebooks:[facebookSchema]},
      address:[addressSchema],
      // Phase 5 — additive fields (do NOT remove existing fields above)
      phoneNumber: { type: String },      // natural key for duplicate guard
      phoneCountryCode: { type: String }, // ISO2 code (e.g. 'AE', 'IR') — drives flag display
      commChannels: [{ type: String }],
      commHandles: { type: mongoose.Schema.Types.Mixed, default: {} },
      status: { type: String, enum: ['new','active','follow_up','won','lost'], default: 'new' },
      tags: [{ type: String }],
      lastCallAt: { type: Date },
      nextFollowUpAt: { type: Date },
      owner: { type: mongoose.Schema.Types.ObjectId },
      assignedTo: [{ type: mongoose.Schema.Types.ObjectId }],
      interestedProducts: [{
        productId: { type: mongoose.Schema.Types.ObjectId },
        variantId: { type: mongoose.Schema.Types.ObjectId },
        note: { type: String },
      }],
      createdBy: { type: mongoose.Schema.Types.ObjectId },
      // Phase 6 — additive: customer VAT number (ب.ضـ) for the MIS tax-invoice
      // customer block; snapshotted into invoice.customerSnapshot at issue-time.
      trn: { type: String },
  });


module.exports = customer;