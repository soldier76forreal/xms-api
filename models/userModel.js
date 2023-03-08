const mongoose = require('mongoose');
// var moment = require('jalali-moment');

const userSchema = new mongoose.Schema ({
    firstName : {type : String ,require:true, min:1 , max:50 },
    lastName : {type : String , require:true , min:1 , max:50 },
    phoneNumber : {type : String , require:true , unique:true  },
    password : {type : String , require:true , min:8 , max:1024  },
    validation : {type : Boolean ,  require:true},
    access : [],
    recivedRequests:[{from:{type:mongoose.Schema.Types.ObjectId}  , deleteDate:{type:Date , default:null},date:{type:Date},document:{type:mongoose.Schema.Types.ObjectId}}],
    profileImage : {type:Object},
    city :{type:String},
    State :{type:String},
    postalCode:{type:String},
    address:{type:String},
    products:{type:Array},
    oldPasswords:{type:Array},
    passwordReset:{type:Array},
    savedPost:{type:Array},
    insertDate : {type:Date , default:Date.now},
    updateDate : {type:Date , default:null},
    deleteDate : {type:Date , default:null}
});
module.exports = userSchema;