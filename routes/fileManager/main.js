const express = require('express');
const mongoose = require('mongoose');
const jwt_decode = require('jwt-decode');
const notficationModel = require("../../models/notficationsModel");
const userModel = require("../../models/userModel");
const invoiceModel = require("../../models/invoiceModel");
const verify = require('../users/verifyToken');
const pwaSubscriptionModel = require('../../models/pwaSubscriptionModel');
const dotenv = require("dotenv");
dotenv.config();
; 
const multer = require('multer');

const dbConnection = require("../../connections/xmsPr");
const user = dbConnection.model('user' , userModel);
const invoice = dbConnection.model('invoice' , invoiceModel);
const notfication = dbConnection.model('notfication' , notficationModel);
const pwaSubscription = dbConnection.model('pwaSubscription' , pwaSubscriptionModel);
const webpush = require('web-push');
const { query } = require('express');
const { id } = require('@hapi/joi/lib/base');
//webpush
webpush.setVapidDetails('mailto:test@test.com' , process.env.PublicVapidKey , process.env.PrivateVapidKey);

const folderModel = require("../../models/folderModel");
const fileModal = require("../../models/fileModel");

const folder = dbConnection.model('folder' , folderModel);
const file = dbConnection.model('file' , fileModal);
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null,"public/uploads");
    },
    filename: function (req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + file.originalname.match(/\..*$/)[0])
    }
  })
  
  const upload = multer({ storage: storage })



const router = express.Router()

    router.post('/newFolder' , verify  , async(req , res)=>{
        var newCustomer;
        var decoded = jwt_decode(req.headers.authorization);
        try{
            var check = true;
            var number = 0;
            var tempName
            while(true){
                if(number === 0){
                    tempName = `${req.body.name}`

                }else if(number >0){
                    tempName = `${req.body.name}${number}`
                }
                const fine = await folder.findOne({name:tempName , supFolder:req.body.supFolder})
                if(fine === null){
                    newCustomer = new folder({
                        name:tempName,
                        generatedBy:decoded.id,
                        supFolder:req.body.supFolder,
                        insertDate:Date.now(),
                        logsStatus:{status:'created' , msg:'folder created!'}
                    })
                    const result = await newCustomer.save();
                    if(req.body.supFolder !== 'root'){
                        const updateSupFolder = await folder.updateOne(
                            {_id:req.body.supFolder},
                            { "$push": { 'subFolders' : result._id } }
                        )
                    }
                    check=false
                    number = '';
                    break;

                }if(fine !==null){
                    check=true
                    number = number + 1;
                    tempName=''
                }
            }

            res.status(200).send("new folder created!");
        }catch(err){
        console.log(err)
        }
    })



    router.post('/deleteFolder' , verify  , async(req , res)=>{
        try{
            const theDoc = await folder.findOne({_id:req.body.id});
            var temp = theDoc.logs;
            temp.push(theDoc);
            var decoded = jwt_decode(req.headers.authorization);
            const deleteFolder = await folder.findOneAndUpdate({_id:req.body.id},{
                deleteDate:Date.now(),
                $set: { 
                    logs:temp,
                },
                updatedBy:decoded.id,
                updateDate:Date.now(),
                logsStatus:{status:'delete' , msg:'folder deleted!'}

            })
            res.status(200).send('deleted!');
        }catch(err){
            res.status(402).send(err);

            console.log(err)
        }
    })


    router.post('/folderRename' , verify  , async(req , res)=>{
        try{
            const theDoc = await folder.findOne({_id:req.body.id});
            var decoded = jwt_decode(req.headers.authorization);
            const renameFolder = await folder.findOneAndUpdate({_id:req.body.id},{
                name:req.body.newName,
                updatedBy:decoded.id,
                updateDate:Date.now(),
                "$push": { 'logs' : [theDoc] } 

            })
            res.status(200).send('renamed!');
        }catch(err){
            res.status(402).send(err);
            console.log(err)
        }
    })


    
    router.post('/folderMove' , verify  , async(req , res)=>{
        try{
            const theDoc = await folder.findOne({_id:req.body.id});
            var temp = theDoc.logs;
            temp.push(theDoc);
            var decoded = jwt_decode(req.headers.authorization);
            const folderMove = await folder.findOneAndUpdate({_id:req.body.id},{
                $set: { 
                    supFolders:req.body.newSupFolder,
                    logs:temp,
                },
                updatedBy:decoded.id,
                updateDate:Date.now()
            })
            res.status(200).send('renamed!');
        }catch(err){
            res.status(402).send(err);
            console.log(err)
        }
    })
    router.post('/folderCopy' , verify  , async(req , res)=>{
        try{
            const theDoc = await folder.findOne({_id:req.body.id});
            var temp = theDoc.logs;
            temp.push(theDoc);
            var decoded = jwt_decode(req.headers.authorization);
            const folderMove = await folder.findOneAndUpdate({_id:req.body.id},{
                $set: { 
                    supFolders: req.body.newSupFolder,
                    logs:temp,
                },
                updatedBy:decoded.id,
                updateDate:Date.now()
            })
            res.status(200).send('renamed!');
        }catch(err){
            res.status(402).send(err);
            console.log(err)
        }
    })



    router.get('/getAllFileAndFolders'   , async(req , res)=>{
        try{
            const findFolders = await folder.find({deleteDate:null});
            const findFiles = await file.find({deleteDate:null});
            var mixedRes = [];
            for(var i = 0 ; findFolders.length > i ; i++){
                var temp = []
                if(findFolders[i].subFolders.length !== 0){
                    for(var j = 0 ; findFolders[i].subFolders.length > j ; j++){
                        for(var m = 0 ; findFolders.length > m ; m++){
                            if(JSON.stringify(findFolders[m]._id) === JSON.stringify(findFolders[i].subFolders[j])){
                                temp.push(findFolders[m])
                            }
                        }
                    }
                }
                if(findFolders[i].subFiles.length !== 0){
                    for(var q = 0 ; findFolders[i].subFiles.length > q ; q++){
                        temp.push(findFiles.filter(document => JSON.stringify(document._id)=== JSON.stringify(findFolders[i].subFiles[j])[0]))
                    }
                }
                mixedRes.push({
                    doc:findFolders[i],
                    subs:temp
                })
                temp = [];
            }
            res.status(200).send(mixedRes);
        }catch(err){
            res.status(402).send(err);
            console.log(err)
        }
    })


    function getFileExtension(fileName) {
        return fileName.originalname.slice((fileName.originalname.lastIndexOf(".") - 1 >>> 0) + 2);
      }
    router.post("/uploadFile"  , verify , upload.single("images"), async (req , res , next)=>{
          var decoded = jwt_decode(req.headers.authorization);
          var newFile = new file({
              name:req.file.originalname.split("." ,1).pop(),
              supFolder:req.body.supFolder,
              metaData:req.file,
              format:getFileExtension(req.file),
              insertDate:Date.now(),
              logsStatus:{status:'created' , msg:'file created!'},
              generatedBy:decoded.id
          })
          try{
              const result = await newFile.save();            
              res.status(200).send(result);
          }catch(error){
              res.status(500).send("مشکلی رخ داده است");
          }
      });
module.exports = router;