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
            
const verify = require('../users/verifyToken');

router.post("/newCustomer" , verify  , async (req , res , next)=>{
    var phoneNumbers  = [];
    for(var i = 0 ; req.body.phoneNumberInformation.length > i ; i++){
        phoneNumbers.push(
            {
                countryCode:req.body.phoneNumberInformation[i].countryCode,
                number:req.body.phoneNumberInformation[i].number,
                whatsApp:req.body.phoneNumberInformation[i].whatsApp,
                logsStatus:{status:'created' , msg:'customer phone number document created!'}
            }
        )
    }

    var emails = [];
    if( req.body.email !== null){
        for(var j = 0 ; req.body.email.length > j ; j++){
            emails.push(
                {
                    email:req.body.email[j].email,
                    logsStatus:{status:'created' , msg:'customer email document created!'}
                }
            )
        }
    }

    var instagrams = [];
    if( req.body.instagram !== null){
        for(var w = 0 ; req.body.instagram.length > w ; w++){
            instagrams.push(
                {
                    instagram:req.body.instagram[w].instagram,
                    logsStatus:{status:'created' , msg:'customer instagram document created!'}
                }
            )
        }
    }
    var websites = [];
    if( req.body.website !== null){
        for(var t = 0 ; req.body.website.length > t; t++){
            websites.push(
                {
                    website:req.body.website[t].website,
                    logsStatus:{status:'created' , msg:'customer website document created!'}
                }
            )
        }
    }
    var linkedIns = [];
    if( req.body.linkedIn !== null){
        for(var j = 0 ; req.body.linkedIn.length > j ; j++){
            linkedIns.push(
                {
                    linkedIn:req.body.linkedIn[j].linkedIn,
                    logsStatus:{status:'created' , msg:'customer linkedIn document created!'}
                }
            )
        }
    }
    var address = [];
    if( req.body.address !== null){
        for(var y = 0 ; req.body.address.length > y ; y++){
            address.push(
                {
                    country:req.body.address[y].country,
                    province:req.body.address[y].province,
                    city:req.body.address[y].city,
                    neighbourhood:req.body.address[y].neighbourhood,
                    street:req.body.address[y].street,
                    plate:req.body.address[y].plate,
                    postalCode:req.body.address[y].postalCode,
                    mapLink:req.body.address[y].mapLink,
                    explanations:req.body.address[y].addressExplanations,
                }
            )
        }
    }

    const newCustomer = new customers({
            inisialInsert:req.body.generatedBy,
            logsStatus:{status:'created' , msg:'customer document created!'},
            personalInformation:{
                country:req.body.personalInformation.country,
                personTitle:req.body.personalInformation.personTitle,
                customerType:req.body.personalInformation.customerType,
                attractedBy:req.body.personalInformation.customerOrigin,
                dateOfBirth:{dateType:req.body.personalInformation.calenderType , date:req.body.personalInformation.dateOfBrith},
                firstName:req.body.personalInformation.firstName,
                lastName:req.body.personalInformation.lastName,
            },
            contactInfo:{
                phoneNumbers:phoneNumbers.length === 0 ? null : phoneNumbers,
                emails:emails.length === 0 ? null :emails,
                instagrams:instagrams.length === 0 ? null :instagrams,
                websites:websites.length === 0 ? null :websites,
                linkedIns:linkedIns.length === 0 ? null :linkedIns

            },
            address:address.length === 0 ? null : address,
            explanations:req.body.explanations
    })

    try{
        const result = await newCustomer.save();
        res.status(201).send(result);
    }catch(error){
        console.log(error)
         res.status(400).send({error:error , msg:"error!!there is a problem"});
    }
});



router.post("/editCustomer"  , verify , async (req , res , next)=>{
    var phoneNumbers  = [];
    for(var i = 0 ; req.body.phoneNumberInformation.length > i ; i++){
        phoneNumbers.push(
            {
                countryCode:req.body.phoneNumberInformation[i].countryCode,
                number:req.body.phoneNumberInformation[i].number,
                whatsApp:req.body.phoneNumberInformation[i].whatsApp,
                logsStatus:{status:'created' , msg:'customer phone number document created!'}
            }
        )
    }

    var emails = [];
    if( req.body.email !== null){
        for(var j = 0 ; req.body.email.length > j ; j++){
            emails.push(
                {
                    email:req.body.email[j].email,
                    logsStatus:{status:'created' , msg:'customer email document created!'}
                }
            )
        }
    }

    var instagrams = [];
    if( req.body.instagram !== null){
        for(var w = 0 ; req.body.instagram.length > w ; w++){
            instagrams.push(
                {
                    instagram:req.body.instagram[w].instagram,
                    logsStatus:{status:'created' , msg:'customer instagram document created!'}
                }
            )
        }
    }
    var websites = [];
    if( req.body.website !== null){
        for(var t = 0 ; req.body.website.length > t; t++){
            websites.push(
                {
                    website:req.body.website[t].website,
                    logsStatus:{status:'created' , msg:'customer website document created!'}
                }
            )
        }
    }
    var linkedIns = [];
    if( req.body.linkedIn !== null){
        for(var j = 0 ; req.body.linkedIn.length > j ; j++){
            linkedIns.push(
                {
                    linkedIn:req.body.linkedIn[j].linkedIn,
                    logsStatus:{status:'created' , msg:'customer linkedIn document created!'}
                }
            )
        }
    }

    // var linkedIns = [];
    // if( req.body.linkedIn !== null){
    //     for(var p = 0 ; req.body.email.length > p ; p++){
    //         linkedIns.push(
    //             {
    //                 linkedIn:req.body.linkedIn[p].linkedIn,
    //                 logsStatus:{status:'created' , msg:'customer linked in document created!'}
    //             }
    //         )
    //     }
    // }

    // var instagram = [];
    // if( req.body.instagram !== null){
    //     for(var f = 0 ; req.body.email.length > f ; f++){
    //         instagram.push(
    //             {
    //                 email:req.body.instagram[f].instagram,
    //                 logsStatus:{status:'created' , msg:'customer instagram document created!'}
    //             }
    //         )
    //     }
    // }

    var address = [];
    if( req.body.address !== null){
        for(var y = 0 ; req.body.address.length > y ; y++){
            address.push(
                {
                    country:req.body.address[y].country,
                    province:req.body.address[y].province,
                    city:req.body.address[y].city,
                    neighbourhood:req.body.address[y].neighbourhood,
                    street:req.body.address[y].street,
                    plate:req.body.address[y].plate,
                    postalCode:req.body.address[y].postalCode,
                    mapLink:req.body.address[y].mapLink,
                    explanations:req.body.address[y].addressExplanations,
                }
            )
        }
    }



    try{
        var lastVersion = await customers.findOne({_id:req.body.id});
        var decoded = jwt_decode(req.headers.authorization);

        const editCustomer = await customers.updateOne({_id:req.body.id},{
            updateDate:Date.now(),
            explanations:req.body.explanations,
            updatedBy:decoded.id ,
            logsStatus:{status:'updated' , msg:'customer document updated!'},
            logs:lastVersion,
            $set:
            {
                'personalInformation':{
                    country:req.body.personalInformation.country,
                    personTitle:req.body.personalInformation.personTitle,
                    customerType:req.body.personalInformation.customerType,
                    attractedBy:req.body.personalInformation.customerOrigin,
                    dateOfBirth:{dateType:req.body.personalInformation.calenderType , date:req.body.personalInformation.dateOfBrith},
                    firstName:req.body.personalInformation.firstName,
                    lastName:req.body.personalInformation.lastName,
                },
                'contactInfo':{
                    phoneNumbers:phoneNumbers.length === 0 ? null : phoneNumbers,
                    emails:emails.length === 0 ? null :emails ,
                    instagrams:instagrams.length === 0 ? null :instagrams,
                    websites:websites.length === 0 ? null :websites,
                    linkedIns:linkedIns.length === 0 ? null :linkedIns
                },
                'address':address.length === 0 ? null : address
            }
        })
        res.status(201).send(editCustomer);
    }catch(error){
        console.log(error)
         res.status(400).send({error:error , msg:"error!!there is a problem"});
    }
});

router.post("/editCustomerContactSection"  , verify , async (req , res , next)=>{
    var phoneNumbers  = [];
    
    for(var i = 0 ; req.body.phoneNumberInformation.length > i ; i++){
        phoneNumbers.push(
            {
                countryCode:req.body.phoneNumberInformation[i].countryCode,
                number:req.body.phoneNumberInformation[i].number,
                whatsApp:req.body.phoneNumberInformation[i].whatsApp,
                logsStatus:{status:'created' , msg:'customer phone number document created!'}
            }
        )
    }

    var emails = [];
    if( req.body.email !== null){
        for(var j = 0 ; req.body.email.length > j ; j++){
            emails.push(
                {
                    email:req.body.email[j].email,
                    logsStatus:{status:'created' , msg:'customer email document created!'}
                }
            )
        }
    }

    var instagrams = [];
    if( req.body.instagram !== null){
        for(var w = 0 ; req.body.instagram.length > w ; w++){
            instagrams.push(
                {
                    instagram:req.body.instagram[w].instagram,
                    logsStatus:{status:'created' , msg:'customer instagram document created!'}
                }
            )
        }
    }
    var websites = [];
    if( req.body.website !== null){
        for(var t = 0 ; req.body.website.length > t; t++){
            websites.push(
                {
                    website:req.body.website[t].website,
                    logsStatus:{status:'created' , msg:'customer website document created!'}
                }
            )
        }
    }
    var linkedIns = [];
    if( req.body.linkedIn !== null){
        for(var j = 0 ; req.body.linkedIn.length > j ; j++){
            linkedIns.push(
                {
                    linkedIn:req.body.linkedIn[j].linkedIn,
                    logsStatus:{status:'created' , msg:'customer linkedIn document created!'}
                }
            )
        }
    }


    console.log(instagrams.length)
    const lengthCheck = (item)=>{
        if(item.length === 0){
            return null
        }else return item
    }
    try{
        var lastVersion = await customers.findOne({_id:req.body.id});
        var decoded = jwt_decode(req.headers.authorization);

        const editCustomer = await customers.updateOne({_id:req.body.id},{
            updateDate:Date.now(),
            updatedBy:decoded.id ,
            logsStatus:{status:'updated' , msg:'customer document updated!'},
            logs:lastVersion,
            $set:
            {
                'contactInfo':{
                    phoneNumbers:phoneNumbers.length === 0 ? null : phoneNumbers,
                    emails:lengthCheck(emails) ,
                    instagrams:lengthCheck(instagrams),
                    websites:lengthCheck(websites),
                    linkedIns:lengthCheck(linkedIns)
                }
            }
        })
        res.status(201).send(editCustomer);
    }catch(error){
        console.log(error)
         res.status(400).send({error:error , msg:"error!!there is a problem"});
    }
});
router.post("/editPersonalInformationSection"  , verify , async (req , res , next)=>{


    try{
        var lastVersion = await customers.findOne({_id:req.body.id});
        var decoded = jwt_decode(req.headers.authorization);

        const editCustomer = await customers.updateOne({_id:req.body.id},{
            updateDate:Date.now(),
            updatedBy:decoded.id ,
            logsStatus:{status:'updated' , msg:'customer document updated!'},
            logs:lastVersion,
            $set:
            {
                'personalInformation':{
                    country:req.body.personalInformation.country,
                    personTitle:req.body.personalInformation.personTitle,
                    customerType:req.body.personalInformation.customerType,
                    attractedBy:req.body.personalInformation.customerOrigin,
                    dateOfBirth:{dateType:req.body.personalInformation.calenderType , date:req.body.personalInformation.dateOfBrith},
                    firstName:req.body.personalInformation.firstName,
                    lastName:req.body.personalInformation.lastName,
                }
            }
        })
        res.status(201).send(editCustomer);
    }catch(error){
        console.log(error)
         res.status(400).send({error:error , msg:"error!!there is a problem"});
    }
});

router.post("/editCustomerAddress"  , verify , async (req , res , next)=>{

    var address = [];
    if( req.body.address !== null){
        for(var y = 0 ; req.body.address.length > y ; y++){
            address.push(
                {
                    country:req.body.address[y].country,
                    province:req.body.address[y].province,
                    city:req.body.address[y].city,
                    neighbourhood:req.body.address[y].neighbourhood,
                    street:req.body.address[y].street,
                    plate:req.body.address[y].plate,
                    postalCode:req.body.address[y].postalCode,
                    mapLink:req.body.address[y].mapLink,
                    explanations:req.body.address[y].addressExplanations,
                }
            )
        }
    }



    try{
        var lastVersion = await customers.findOne({_id:req.body.id});
        var decoded = jwt_decode(req.headers.authorization);

        const editCustomer = await customers.updateOne({_id:req.body.id},{
            updateDate:Date.now(),
            explanations:req.body.explanations,
            updatedBy:decoded.id ,
            logsStatus:{status:'updated' , msg:'customer document updated!'},
            logs:lastVersion,
            $set:
            {
                'address':address.length === 0 ? null : address
            }
        })
        res.status(201).send(editCustomer);
    }catch(error){
        console.log(error)
         res.status(400).send({error:error , msg:"error!!there is a problem"});
    }
});
router.get("/getAllCustomerForSelect" , verify   , async (req , res , next)=>{
    try{
        const getAllCustomerData = await customers.find({deleteDate:null});
        res.status(200).send(getAllCustomerData);
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});
router.get("/getAllCustomer"  , verify  , async (req , res , next)=>{
    var customer = [];
    var queryObj = {deleteDate:null}
    var sortQuery = {}
    var finalArr =[];
    
    try{
        var decoded = jwt_decode(req.headers.authorization);
        // const getAllCustomerData = await customers.find({deleteDate:null});
        const theUser = await user.findOne({_id:decoded.id}).select('filterMemory');
        const sortType = theUser.filterMemory.crm.sort;
        const filters = theUser.filterMemory.crm.filter;

        if(sortType === 'newest'){
            sortQuery.insertDate = -1
        }else if(sortType === 'oldest'){
            sortQuery.insertDate = 1

        }else if(sortType === null){
            sortQuery.insertDate = 0
        }
        
        if(filters.country !== null){
            queryObj['personalInformation.country'] = filters.country
        }
        if(filters.attractedBy !== null){
            queryObj['personalInformation.attractedBy'] = filters.attractedBy
        }
        if(filters.whatsApp !== false){
            queryObj['contactInfo.phoneNumbers'] ={ $elemMatch: { whatsApp: true } }
        }
        if(filters.havingAdderss !== false){
            queryObj['address'] !== null 
        }
        var limit =parseInt(req.query.limit)
        var docLength = await customers.find(queryObj).sort(sortQuery).countDocuments()
        var getCustomers = await customers.find(queryObj).sort(sortQuery);

        for(var i = 0 ; getCustomers.length > i ; i++){
            customer.push({customer:getCustomers[i] , generatedBy:await user.findOne({_id:getCustomers[i].inisialInsert}), invoice:await invoice.find({deleteDate:null , 'preInvoice.companyName' : getCustomers[i]._id})})
        }
        if(decoded.access.includes("inv") || decoded.access.includes("sa")){
            finalArr=customer
        }else if(!decoded.access.includes("inv") && !decoded.access.includes("sa") && decoded.access.includes("req")){
            finalArr = customer.filter((e)=>{return JSON.stringify(e.customer.inisialInsert) === JSON.stringify(decoded.id)})
            
        }  
        res.status(200).send(finalArr);
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});

router.post("/deletePerson" , verify   , async (req , res , next)=>{
    try{
        const deletePerson = await customers.findOneAndUpdate({_id:req.body.id},{deleteDate:Date.now()});
        res.status(200).send('person deleted...');

    }catch(error){
        res.status(400).send('error');
    }

});


router.post("/saveNewCall"  , verify , async (req , res , next)=>{
    try{

        const addNewCall = await customers.findOneAndUpdate({_id:req.body.docId},
            {
                $push:
                {'phoneCalls':{
                    phoneNumber:req.body.phoneNumber,
                    countryCode:req.body.countryCode,
                    callDate:req.body.callDate,
                    callReason:req.body.callReason,
                    targetRequests:req.body.targetRequest,
                    callStatus:req.body.callStatus,
                    description:req.body.callDescription
                }
                }
            }
            );
         
        res.status(200).send('new call added...');

    }catch(error){
        console.log(error)
        res.status(400).send('error');
    }

});

router.post("/searchingForCustomer"  , verify , async (req , res , next)=>{
    try{

        const productSearch = await customers.find({
            deleteDate:null,
            "title" :   { "$regex": req.query.searching, "$options":"i"}
        }).select('title , _id').limit(parseInt(10));

    }catch(error){
        console.log(error)
        res.status(400).send('error');
    }

});

module.exports = router;    
