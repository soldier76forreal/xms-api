const express = require('express');
const mongoose = require('mongoose');
const jwt_decode = require('jwt-decode');
const notficationModel = require("../../models/notficationsModel");
const userModel = require("../../models/userModel");
const invoiceModel = require("../../models/invoiceModel");
const verify = require('../users/verifyToken');
const pwaSubscriptionModel = require('../../models/pwaSubscriptionModel');
const dbConnection = require("../../connections/xmsPr");
const user = dbConnection.model('user' , userModel);
const invoice = dbConnection.model('invoice' , invoiceModel);
const notfication = dbConnection.model('notfication' , notficationModel);
const dotenv = require("dotenv");
dotenv.config();

const router = express.Router()
//get all users
    router.get("/getAllUsers" , verify ,async(req , res)=>{
    
        try{
            const length = await user.countDocuments({deleteDate:null});
            // const result = await userM.find({deleteDate:null}).select('firstName , lastName , validation , role , insertDate , profileImage' , );        
            var result = await user.find({deleteDate:null ,  validation:true});   
            var all = await user.find({deleteDate:null});
    
    
        
            var employees = result.filter(function (worker) {
                // return true for salary greater than equals to 25000
                return JSON.stringify(worker._id) !== JSON.stringify(jwt_decode(req.headers.authorization).id);
            });
    
    
            var userDataParted ={sa:[],inv:[],req:[] , all:employees , allAll:all.reverse() , length:length}
    
            employees.forEach(element => {
            element.access.forEach(el2 => {
                if(JSON.stringify(el2) === JSON.stringify('sa')){
                    userDataParted.sa.push(element);
                }else if(JSON.stringify(el2) === JSON.stringify('inv')){
                    userDataParted.inv.push(element);
                }else if(JSON.stringify(el2) === JSON.stringify('req')){
                    userDataParted.req.push(element);
                }
                
            });
            
        });
            res.status(200).send(JSON.stringify({ln:length , rs:userDataParted})); 
        }catch(err){
            res.status(500).send("مشکلی رخ داده است");
        }
        
    });
    router.post('/updateAccess' , verify , async(req , res)=>{
        try{
            const accessUpdate = await user.findOneAndUpdate({_id:req.body.userId}, 
                {$set:{'access':req.body.newAccessList}});
            res.status(200).send('user access has been updated...')
        }catch(err){
            console.log(err)
        }
  })


  router.post('/changeValidation' , verify , async(req , res)=>{
    const check = await user.findOne({_id:req.body.userId});
    
    try{
        if(check.validation === true){
            const validationUpdate = await user.findOneAndUpdate({_id:req.body.userId}, 
                {'validation':false});
            res.status(200).send('validation has been updated...')
        }else if(check.validation === false){
            const validationUpdate = await user.findOneAndUpdate({_id:req.body.userId}, 
                {'validation':true});
            res.status(200).send('validation has been updated...')
        }
      }catch(err){
          console.log(err)
      }
  })

  router.post('/deleteUser' , verify , async(req , res)=>{
    
    try{
        
        const deleteUser = await user.findOneAndUpdate({_id:req.body.userId}, 
            {$set:{'deleteDate':Date.now()}});
        res.status(200).send('user has been deleted...')
       
      }catch(err){
          console.log(err)
      }
  })


module.exports = router;

