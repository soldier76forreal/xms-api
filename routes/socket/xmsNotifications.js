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

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage });

const router = express.Router()

  var onlineUsers=[];

  var returnRouter = function(io) {
        const addNewUser = (username, socketId) => {
          !onlineUsers.some((user) => user.username === username) &&
           onlineUsers.push({ username, socketId });
        };
        
        const removeUser = (socketId) => {
          onlineUsers = onlineUsers.filter((user) => user.socketId !== socketId);
        };
        
        const getUser = (username) => {
          return onlineUsers.find((user) => user.username === username);
        };
        
        io.on("connection", (socket) => {
        socket.on("newUser", (username) => {
        addNewUser(username, socket.id);
        
        });

          socket.on("sendRequest", async({ to ,from, document, type}) => {
            to.forEach(async element => {
                var receiver = getUser(element);
                if(receiver !== undefined){
                  try{
                    await io.to(receiver.socketId).emit("newPing", {
                      ping:Math.random()
                    });   
                  }catch(err){
                    console.log(err);
                  }
                } 
            });
          });
        
          socket.on("disconnect", () => {
            removeUser(socket.id);
          });
        
        });
        
        router.post('/saveNotif' , verify , async(req , res  , next)=>{
          const document = await invoice.findOne({_id:req.body.document})
          const from = await user.findOne({_id:req.body.from})
        
          try{
            for(var i=0 ; req.body.to.length>i ; i++){
              newPreInvoice = new notfication ({
                  from:req.body.from,
                  document:req.body.document,
                  to:req.body.to[i],
                  type:req.body.type
              })
                const response =await newPreInvoice.save();
                const payload = JSON.stringify({sendFrom:`${from.firstName} ${from.lastName}` , document:`${document.preInvoice.productName}-${document.preInvoice.meterage} متر` , status:document.status , type:req.body.type})
                const subscriptions = await pwaSubscription.findOne({userId:req.body.to[i]});
                if(subscriptions !== null){
                  for(var j=0 ; subscriptions.subscription.length>j ; j++){
                    try{
                      await webpush.sendNotification(JSON.parse(subscriptions.subscription[j]),payload);
                      res.status(200).send('notif sent!')
                    }catch(err){
                      res.status(403).send(err)
                    }
                  }
                }
            }
            }catch{
              
            }
        })
        router.post('/saveSubsToDb' , verify  , async(req , res)=>{
          var arr = [];

          try{
            const check = await pwaSubscription.findOne({userId:req.body.userId});
            
            if(check !== null){
              const filterd = check.subscription.filter(e=>{return e === req.body.subs})
       
              if(filterd.length === 0){
                var temp = [...check.subscription];
                temp.push(req.body.subs)
                const userr = await pwaSubscription.findOneAndUpdate({userId:req.body.userId} , {'$set':{'subscription':temp}});
                res.status(200).send('subscription updated!')
              }
            }else if(check === null){
              arr.push(req.body.subs)
              const newPwaSubscription = new pwaSubscription ({
                userId:req.body.userId,
                subscription:arr
              })
              const response =await newPwaSubscription.save();
              res.status(200).send('user subscribed!')
            } 
          }catch (err){
            res.status(403).send('error!')
            console.log(err)
          }

        })

        router.get('/getNotficationBasedOnUser' , verify  , async(req , res)=>{
         
          try{
            const recived = await notfication.find({to:req.query.id});
            var notifs = [];
            for(var j = 0 ; recived.length > j ; j++){
              notifs.push({
                id:recived[j]._id,
                status:recived[j].status,
                from: await user.findOne({_id:recived[j].from}),
                document: await invoice.findOne({_id:recived[j].document}),
                to: await user.findOne({_id:recived[j].to}),
                type:recived[j].type,
                insertDate:recived[j].insertDate
              })
            }
            res.status(200).send(notifs);
          }catch(err){
            console.log(err)
          }
        })

        router.get('/switchStatus' , verify  , async(req , res)=>{
          try{
            const id = mongoose.Types.ObjectId(req.query.id.trim());
            const switchStatus = await notfication.findOne({_id:id});
            if(switchStatus.status === 0){
              const switchStt = await notfication.findOneAndUpdate({_id:id} , {status:1});
            }else if(switchStatus.status === 1){
              const switchStt = await notfication.findOneAndUpdate({_id:id} , {status:0});
            }
            res.status(200).send("switched!");
          }catch(err){
            console.log(err)
          }
        })


        router.get('/deleteSubs' , verify  , async(req , res)=>{
          var userSubs =[];
          try{
            const getSub = await pwaSubscription.findOne({userId:req.body.userId});
            var userSubs =[...getSub.userSubs];
            var finalArr = userSubs.filter(e=>{return e !== req.body.subs});
            const id = mongoose.Types.ObjectId(req.query.id.trim());
            const switchStatus = await notfication.findOne({_id:id});
            if(switchStatus.status === 0){
              const switchStt = await notfication.findOneAndUpdate({_id:id} , {status:1});
            }else if(switchStatus.status === 1){
              const switchStt = await notfication.findOneAndUpdate({_id:id} , {status:0});
            }
            res.status(200).send("switched!");
          }catch(err){
            console.log(err)
          }
        })
    return router;
  }
  
  module.exports = returnRouter;