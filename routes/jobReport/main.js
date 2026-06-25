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
const fileModal = require("../../models/fileModel");
var mongoose = require('mongoose');
const sizeOf = require('image-size')

const file = dbConnection.model('file' , fileModal);


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



router.post('/addNewTitlePreset' , verify  , async(req , res)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const newPreset = await user.findOneAndUpdate({_id:decoded.id},{

            "$push": { 'jobReportPresets' : {
                title:req.body.title,
                logsStatus:{status:'new preset' , msg:'new preset added'}
            } } ,

        })
        res.status(200).send('title preset added!');
    }catch(err){
        res.status(402).send(err);
        console.log(err)
    }
})


router.post('/addNewPreset' , verify  , async(req , res)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const newPreset = await user.findOneAndUpdate({_id:decoded.id},{

            "$push": { 'jobReportPresets' : {
                title:req.body.data.title,
                explanation:req.body.data.explanation,
                logsStatus:{status:'new preset' , msg:'new preset added'}
            } } ,

        })
        res.status(200).send('preset added!');
    }catch(err){
        res.status(402).send(err);
        console.log(err)
    }
})

router.post('/addExplToPreset' , verify  , async(req , res)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const users = await user.findOne({_id:decoded.id}).lean()
        var preSets = users.jobReportPresets
        const index = preSets.findIndex(x => JSON.stringify(x._id) === JSON.stringify(req.body.data._id));
        
        // preSets[index].logs =preSets[index].logs.push(preSets[index])
        preSets[index].logsStatus = {status:'update' , msg:'added explanation'}
        preSets[index].title = req.body.data.title
        preSets[index].explanation = req.body.data.explanation
        preSets[index].updateDate = Date.now()
        const updatePreset = await user.findOneAndUpdate({_id:decoded.id},{
            jobReportPresets:preSets
        })
        res.status(200).send('preset updated!');
    }catch(err){
        res.status(402).send(err);
        console.log(err)
    }
})



router.post('/addJobReport' , verify  , async(req , res)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const users = await user.findOne({_id:decoded.id})
        const isDateExist = users.jobReport.filter(e=>{return(moment(e.calenderDate).format('l') === moment(req.body.date).format('l')) })
        const contentBox = req.body.contentBox.map(e=>{
            return {title:e.title,explanation:e.explanation}
        })

        if(isDateExist.length > 0){
            const index = users.jobReport.findIndex(x => moment(x.calenderDate).format('l') === moment(req.body.date).format('l'));
            var temp = users.jobReport
 
            temp[index].reportContent=contentBox
            temp[index].files=req.body.files
            temp[index].logsStatus = {status:'updated' , msg:'job report updated'}
            const jobReportUpdated = await user.findOneAndUpdate({_id:decoded.id},{

                jobReport:temp
    
            })
        }else if(isDateExist.length === 0){
            const jobReport = await user.findOneAndUpdate({_id:decoded.id},{

                "$push": { 'jobReport' : {
                    calenderDate:req.body.date,
                    reportContent:contentBox,
                    files:req.body.files,
                    logsStatus:{status:'added' , msg:'new job report added'}
                } } ,
    
            })
        }
        res.status(200).send('job updated!');
    }catch(err){
        res.status(402).send(err);
        console.log(err)
    }
})

router.get('/getJobReportForCurrentUser' , verify  , async(req , res)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const users = await user.findOne({_id:decoded.id}).lean()
        var jobReports = users.jobReport
        for(var i=0 ; jobReports.length>i ; i++){
             var objectIds = jobReports[i].files.map(e=>{
                return mongoose.Types.ObjectId(e)
             })
            var temp = []
            const findFiles = await file.find({
                '_id': { $in:objectIds},

            deleteDate:null,hidden:true });


            for(var d = 0 ; findFiles.length > d ; d++){
                if(findFiles[d].format === 'jpg' || findFiles[d].format === 'JPG' || findFiles[d].format === 'png' ||findFiles[d].format === 'svg' || findFiles[d].format === 'jpeg' || findFiles[d].format === 'JPGE'|| findFiles[d].format === 'PNG' || findFiles[d].format === 'SVG'){
                    temp.push({file:findFiles[d] , dim:sizeOf(`./public/uploads/${findFiles[d].metaData.filename}`)})
                }else{
                    temp.push({file:findFiles[d]})
                }
            }
            jobReports[i].filesToShow = temp
            temp = []

            
        }
        res.status(200).send(jobReports);
    }catch(err){
        res.status(402).send(err);
        console.log(err)
    }
})

module.exports = router;    
