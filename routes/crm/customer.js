const express = require('express');
const dbConnection = require("../../connections/xmsPr");
const customerModel = require("../../models/customerModel");


const customers = dbConnection.model('customer' , customerModel);
const router = express.Router()


router.post("/getTheBlogForMain"  , async (req , res , next)=>{
    var phoneNumbers  = [];
    for(var i = 0 ; req.body.phoneNumberInformation.length > i ; i++){
        phoneNumbers.push(
            {
                countryCode:req.body.phoneNumberInformation[i].countryCode,
                personTitle:req.body.phoneNumberInformation[i].title,
                number:req.body.phoneNumberInformation[i].number,
                logsStatus:{status:'created' , msg:'customer phone number document created!'}
            }
        )
    }

    var emails = [];
    for(var j = 0 ; req.body.email.length > j ; j++){
        emails.push(
            {
                email:req.body.email[j].email,
                logsStatus:{status:'created' , msg:'customer email document created!'}
            }
        )
    }


    var address = [];
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
                logsStatus:{status:'created' , msg:'customer address document created!'}
            }
        )
    }
    const newCustomer = new customers({
        
            logsStatus:{status:'created' , msg:'customer document created!'},
            personalInformation:{
                country:req.body.personalInformation.country,
                personTitle:req.body.personalInformation.personTitle,
                customerType:req.body.personalInformation.customerType,
                attractedBy:req.body.personalInformation.customerOrigin,
                dateOfBrith:req.body.personalInformation.dateOfBrith,
                firstName:req.body.personalInformation.firstName,
                lastName:req.body.personalInformation.lastName,
                logsStatus:{status:'created' , msg:'customer personal information document created!'},
            },
            contactInfo:{
                phoneNumbers:phoneNumbers,
                emails:emails
            },
            address:address
    })

    try{
        const result = await newCustomer.save();
        console.log(result);
        res.status(201).send(result);
    }catch(error){
        console.log(error)
         res.status(400).send({error:error , msg:"error!!there is a problem"});
    }
});


router.get("/getAllCustomer"  , async (req , res , next)=>{
    try{
        const getAllCustomerData = await customers.find({deleteDate:null});
        res.status(200).send(getAllCustomerData);
    }catch(error){
        res.status(400).send({error:error , msg:"error!!there is a problem"});
        console.log(error)
    }

});




module.exports = router;    
