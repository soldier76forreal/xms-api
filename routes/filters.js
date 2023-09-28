const express = require('express');
const dbConnection = require("../connections/xmsPr");
const customerModel = require("../models/customerModel");
const customers = dbConnection.model('customer' , customerModel);
const router = express.Router()
const invoiceModel = require("../models/invoiceModel");
const invoice = dbConnection.model('invoice' , invoiceModel);
const jwt_decode = require('jwt-decode');
const userModel = require("../models/userModel");
const user = dbConnection.model('user' , userModel);
            
const verify = require('./users/verifyToken');


// ---------------------------CRM---------------------------
router.post("/changeCrmSort"  , async (req , res , next)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const updateSort = await user.updateOne({_id:decoded.id},{'filterMemory.crm.sort':req.body.newSort});
        
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});

router.post("/filterByCountry"  , async (req , res , next)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const updateFilter = await user.updateOne({_id:decoded.id},{'filterMemory.crm.filter.country':req.body.country});
    
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});


router.post("/filterByAttraction"  , async (req , res , next)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const updateFilter = await user.updateOne({_id:decoded.id},{'filterMemory.crm.filter.attractedBy':req.body.attraction});
    
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});


router.post("/filterWhatsAppStatus"  , async (req , res , next)=>{
    try{
        console.log(req.body.filterWhatsApp)
        var decoded = jwt_decode(req.headers.authorization);
        const updateFilter = await user.updateOne({_id:decoded.id},{'filterMemory.crm.filter.whatsApp':req.body.filterWhatsApp});
    
        res.status(200).send('updated!');

    }catch(error){
        res.status(400).send('error');
    }

});

router.post("/filterHavingAddress"  , async (req , res , next)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const updateFilter = await user.updateOne({_id:decoded.id},{'filterMemory.crm.filter.havingAdderss':req.body.havingAdderss});
    
        res.status(200).send('updated!');

    }catch(error){
        res.status(400).send('error');
    }

});



router.post("/resetAllCrmFilter"  , async (req , res , next)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const updateFilter = await user.updateOne({_id:decoded.id},{'filterMemory.crm.filter.havingAdderss':false , 'filterMemory.crm.filter.whatsApp':false ,'filterMemory.crm.filter.attractedBy':null , 'filterMemory.crm.filter.country':null , 'filterMemory.crm.sort':null});
    
        res.status(200).send('updated!');

    }catch(error){
        res.status(400).send('error');
    }

});


// ---------------------------MIS---------------------------
router.post("/changeMisSort"  , async (req , res , next)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const updateSort = await user.updateOne({_id:decoded.id},{'filterMemory.mis.sort':req.body.newSort});
        
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});

router.post("/requestTypeMis"  , async (req , res , next)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const updateFilter = await user.updateOne({_id:decoded.id},{'filterMemory.mis.filter.requestType':req.body.requestType});
    
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});


router.post("/sentToMis"  , async (req , res , next)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const updateFilter = await user.updateOne({_id:decoded.id},{'filterMemory.mis.filter.sentTo':req.body.sentTo});
    
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});
router.post("/sentByMis"  , async (req , res , next)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const updateFilter = await user.updateOne({_id:decoded.id},{'filterMemory.mis.filter.sentBy':req.body.sentBy});
    
        res.status(200).send('updated!');
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});




router.post("/resetAllMisFilter"  , async (req , res , next)=>{
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const updateFilter = await user.updateOne({_id:decoded.id},{ 'filterMemory.mis.filter.sentBy':null ,'filterMemory.mis.filter.sentTo':null , 'filterMemory.mis.filter.requestType':null , 'filterMemory.mis.sort':null});
    
        res.status(200).send('updated!');

    }catch(error){
        res.status(400).send('error');
    }

});
module.exports = router;    
