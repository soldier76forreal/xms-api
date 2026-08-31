const express = require('express');
const dbConnection = require("../../connections/xmsPr");
const customerModel = require("../../models/customerModel");
const customers = dbConnection.model('customer' , customerModel);
const router = express.Router()
const invoiceModel = require("../../models/invoiceModel");
const invoice = dbConnection.model('invoice' , invoiceModel);
const userModel = require("../../models/userModel");
const user = dbConnection.model('user' , userModel);
            
const verify = require('../users/verifyToken');



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




module.exports = router;    
