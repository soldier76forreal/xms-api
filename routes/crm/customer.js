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

router.post("/getTheBlogForMain" , verify  , async (req , res , next)=>{
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
                    addressExplanations:req.body.address[y].addressExplanations,
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
                emails:emails.length === 0 ? null :emails 
            },
            address:address.length === 0 ? null : address
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
                    addressExplanations:req.body.address[y].addressExplanations,
                }
            )
        }
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
                    emails:emails.length === 0 ? null :emails 
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

router.get("/getAllCustomerForSelect"  , async (req , res , next)=>{
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
    
    try{
        var decoded = jwt_decode(req.headers.authorization);
        const getAllCustomerData = await customers.find({deleteDate:null});
        for(var i = 0 ; getAllCustomerData.length > i ; i++){
            customer.push({customer:getAllCustomerData[i] , generatedBy:await user.findOne({_id:getAllCustomerData[i].inisialInsert}), invoice:await invoice.find({deleteDate:null , 'preInvoice.companyName' : getAllCustomerData[i]._id})})
        }
        
        res.status(200).send(customer);
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});

router.post("/deletePerson"  , async (req , res , next)=>{
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


module.exports = router;    
