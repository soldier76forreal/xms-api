const express = require('express');
const dbConnection = require("../../connections/xmsPr");
const customerModel = require("../../models/customerModel");
const customers = dbConnection.model('customer' , customerModel);
const router = express.Router()
const invoiceModel = require("../../models/invoiceModel");
const invoice = dbConnection.model('invoice' , invoiceModel);
const jwt_decode = require('jwt-decode');
const userModel = require("../../models/userModel");
const user = dbConnection.model('user' , userModel);
var moment = require('moment');
const verify = require('../users/verifyToken');


var getDaysOfMonth = function(year, month) {
// Create a Moment.js object for the first day of the specified month
const firstDayOfMonth = moment({ year, month });

// Get the number of days in the month
const daysInMonth = firstDayOfMonth.daysInMonth();

// Initialize an array to store the dates
const datesArray = [];

// Generate the dates for the entire month
for (let day = 1; day <= daysInMonth; day++) {
  const date = firstDayOfMonth.date(day);
  datesArray.push(date.format('YYYY-MM-DD'));
}
    return datesArray;
};
router.get("/changeCrmSort"  , async (req , res , next)=>{
    try{
        const month = moment.months()

        var generalArray = [
            {year:2023}
        ]
        for(var j = 0 ; generalArray.length>j ; j++){
            if(generalArray[j].year < moment().year()){
                generalArray.push({year:generalArray[j].year+1})
            }
            var months=[]
            for(var s = 0 ; month.length > s ; s++){
                var theMonth = []
                var days = []
                var mo =moment().month(month[s]).format("M")
                var daysOfTheMonth = getDaysOfMonth(generalArray[j].year , mo-1)
                for(var g = 0 ; daysOfTheMonth.length > g ; g++){
                    days.push({date:daysOfTheMonth[g]})
                }
                theMonth.push({month:month[s],days:days})
                months.push(theMonth)
            }
            generalArray[j].months = months
        }
        res.status(200).send(generalArray)
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});






module.exports = router;    
