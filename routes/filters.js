const express = require('express');
const dbConnection = require("../connections/xmsPr");
const customerModel = require("../models/customerModel");
const customers = dbConnection.models.customer || dbConnection.model('customer', customerModel);
const router = express.Router()
const invoiceModel = require("../models/invoiceModel");
const invoice = dbConnection.model('invoice' , invoiceModel);
const userModel = require("../models/userModel");
const user = dbConnection.model('user' , userModel);
            

// SECURITY: every route below writes to the CALLER'S OWN user document, so it
// must run behind verify and take the id from the VERIFIED token (req.user.id).
// These routes previously had NO auth middleware at all and read identity via
// jwt_decode(req.headers.authorization) — jwt-decode does not check the
// signature, so an unauthenticated caller could forge a payload carrying any
// user _id and write to that user saved filters. Never reintroduce jwt_decode
// anywhere identity is being established.
const verify = require('./users/verifyToken');


// ---------------------------CRM---------------------------
router.post("/changeCrmSort", verify, async (req , res , next)=>{
    try{
        const updateSort = await user.updateOne({_id:req.user.id},{'filterMemory.crm.sort':req.body.newSort});
        
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});

router.post("/filterByCountry", verify, async (req , res , next)=>{
    try{
        const updateFilter = await user.updateOne({_id:req.user.id},{'filterMemory.crm.filter.country':req.body.country});
    
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});


router.post("/filterByAttraction", verify, async (req , res , next)=>{
    try{
        const updateFilter = await user.updateOne({_id:req.user.id},{'filterMemory.crm.filter.attractedBy':req.body.attraction});
    
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});


router.post("/filterWhatsAppStatus", verify, async (req , res , next)=>{
    try{
        console.log(req.body.filterWhatsApp)
        const updateFilter = await user.updateOne({_id:req.user.id},{'filterMemory.crm.filter.whatsApp':req.body.filterWhatsApp});
    
        res.status(200).send('updated!');

    }catch(error){
        res.status(400).send('error');
    }

});

router.post("/filterHavingAddress", verify, async (req , res , next)=>{
    try{
        const updateFilter = await user.updateOne({_id:req.user.id},{'filterMemory.crm.filter.havingAdderss':req.body.havingAdderss});
    
        res.status(200).send('updated!');

    }catch(error){
        res.status(400).send('error');
    }

});



router.post("/resetAllCrmFilter", verify, async (req , res , next)=>{
    try{
        const updateFilter = await user.updateOne({_id:req.user.id},{'filterMemory.crm.filter.havingAdderss':false , 'filterMemory.crm.filter.whatsApp':false ,'filterMemory.crm.filter.attractedBy':null , 'filterMemory.crm.filter.country':null , 'filterMemory.crm.sort':null});
    
        res.status(200).send('updated!');

    }catch(error){
        res.status(400).send('error');
    }

});


// ---------------------------MIS---------------------------
router.post("/changeMisSort", verify, async (req , res , next)=>{
    try{
        const updateSort = await user.updateOne({_id:req.user.id},{'filterMemory.mis.sort':req.body.newSort});
        
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});

router.post("/requestTypeMis", verify, async (req , res , next)=>{
    try{
        const updateFilter = await user.updateOne({_id:req.user.id},{'filterMemory.mis.filter.requestType':req.body.requestType});
    
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});


router.post("/sentToMis", verify, async (req , res , next)=>{
    try{
        const updateFilter = await user.updateOne({_id:req.user.id},{'filterMemory.mis.filter.sentTo':req.body.sentTo});
    
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});
router.post("/sentByMis", verify, async (req , res , next)=>{
    try{
        const updateFilter = await user.updateOne({_id:req.user.id},{'filterMemory.mis.filter.sentBy':req.body.sentBy});
    
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});




router.post("/resetAllMisFilter", verify, async (req , res , next)=>{
    try{
        const updateFilter = await user.updateOne({_id:req.user.id},{ 'filterMemory.mis.filter.sentBy':null ,'filterMemory.mis.filter.sentTo':null , 'filterMemory.mis.filter.requestType':null , 'filterMemory.mis.sort':null});
    
        res.status(200).send('updated!');

    }catch(error){
        res.status(400).send('error');
    }

});
module.exports = router;    
