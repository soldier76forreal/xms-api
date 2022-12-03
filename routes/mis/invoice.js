const express = require('express');
const mongoose = require('mongoose');

const dbConnection = require("../../connections/xmsPr");
const userModel = require("../../models/userModel");
const invoiceModel = require("../../models/invoiceModel");
const user = dbConnection.model('user' , userModel);
const invoice = dbConnection.model('invoice' , invoiceModel);
const router = express.Router()

router.post('/newPreInvoice' , async(req , res)=>{
    const newPreInvoice = new invoice ({
        preInvoice:{
            productName:req.body.productName,
            meterage:req.body.meterage,
            destination:req.body.destination,
            companyName:req.body.companyName,
            logsStatus:{status:'created' , msg:'new pre invoice created!'}
            // generatedBy:req.body.generatedBy
        }
    })
    try{
        const response =await newPreInvoice.save();
        res.status(200).send(response);
    }catch(err){
        res.status(401).send('error!');

    }
})


router.get('/getInvoices' , async(req , res)=>{
    try{
        const length = await invoice.countDocuments({deleteDate:null});
        const response = await invoice.find({deleteDate:null}).limit(req.params.limit);
        res.status(200).send(JSON.stringify({ln:length , rs:response}));
    }catch(err){
        res.status(401).send('error!');
    }
})


router.post('/sendPreInvoices' , async(req , res)=>{
    // recivedRequests:[{from:{type:mongoose.Schema.Types.ObjectId} , date:{type:Date},document:{type:mongoose.Schema.Types.ObjectId}}],
    // sharedTo:[{to:{type:mongoose.Schema.Types.ObjectId} , by:{type:mongoose.Schema.Types.ObjectId} , date:{type:Date}}],
    var arr =[];
    try{
        console.log(req.body);
        const updateUsers = await user.updateMany(
            { _id: { $in: req.body.peopleToSend } },
            { "$push": { 'recivedRequests' : [{from:req.body.from ,date:Date.now(),document:req.body.document}] } },
            { "new": true, "upsert": true }
         )
         for(var i = 0 ; req.body.peopleToSend.length > i ; i++){
            arr.push({
                to:req.body.peopleToSend[i],
                date:Date.now(),
                by:req.body.from
                
            })
         }
         const updateDocuments = await invoice.updateMany(
            { _id:req.body.document  },
            { "$push": { 'sharedTo' : arr } ,  status:1},
            { "new": true, "upsert": true }
         )
         res.status(200).send(updateUsers);
    }catch(err){
        console.log(err)
        res.status(401).send('error!');

    }
})
module.exports = router;    
