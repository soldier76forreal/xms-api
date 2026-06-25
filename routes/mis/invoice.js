const express = require('express');
const mongoose = require('mongoose');
const jwt_decode = require('jwt-decode');
const dbConnection = require("../../connections/xmsPr");
const userModel = require("../../models/userModel");
const invoiceModel = require("../../models/invoiceModel");
const verify = require('../users/verifyToken');
const user = dbConnection.model('user' , userModel);
const invoice = dbConnection.model('invoice' , invoiceModel);
const router = express.Router()
const customerModel = require("../../models/customerModel");
const customers = dbConnection.model('customer' , customerModel);
router.post('/newPreInvoice' , verify , async(req , res)=>{
    var newPreInvoice;

    if(req.body.insertFactor === true){
         newPreInvoice = new invoice ({
            preInvoice:{
                productName:req.body.productName,
                meterage:req.body.meterage,
                destination:req.body.destination,
                dimentions:{width:req.body.dimentions.width , height:req.body.dimentions.height , diameter:req.body.dimentions.diameter},
                companyName:req.body.companyName,   
                logsStatus:{status:'created' , msg:'new pre invoice created!'},
                generatedBy:req.body.generatedBy
            },
            inisialInsert:req.body.generatedBy,
        })
    }else if(req.body.insertFactor === false){
         newPreInvoice = new invoice ({
            preInvoice:{
                productName:req.body.productName,
                meterage:req.body.meterage,
                destination:req.body.destination,
                dimentions:{width:req.body.dimentions.width , height:req.body.dimentions.height , diameter:req.body.dimentions.diameter},
                companyName:req.body.companyName,
                logsStatus:{status:'created' , msg:'new pre invoice created!'},
                generatedBy:req.body.generatedBy
            },
            completeInvoice:{
                invoiceDate:req.body.invoiceDate,
                costCnf:req.body.costCnf,
                costFob:req.body.costFob,
                factoryPrice:req.body.factoryPrice,
                stoneThickness:req.body.stoneThickness,
                stoneRate:req.body.stoneRate,
                dateOfShipment:req.body.dateOfShipment,
                logsStatus:{status:'created' , msg:'new invoice created!'},
                generatedBy:req.body.generatedBy
            },
            inisialInsert:req.body.generatedBy,
            status:2
        })
    }

    try{
        const response =await newPreInvoice.save();
        res.status(200).send(response);
    }catch(err){
        console.log(err)
        res.status(401).send('error!');
   
    }
})

router.post('/completeInvoice' , verify , async(req , res)=>{


    try{
        const updateInvoice = await invoice.findOneAndUpdate({_id:req.body.id},{
            $set:
            {'completeInvoice':{
                invoiceDate:req.body.invoiceDate,
                costCnf:req.body.costCnf,
                costFob:req.body.costFob,
                factoryPrice:req.body.factoryPrice,
                stoneThickness:req.body.stoneThickness,
                stoneRate:req.body.stoneRate,
                dateOfShipment:req.body.dateOfShipment,
                logsStatus:{status:'created' , msg:'new invoice created!'},
                generatedBy:req.body.generatedBy
            },
            'status':2}
        })

        res.status(200).send(updateInvoice);
    }catch(err){
        console.log(err)
        res.status(401).send('error!');
    }
})


router.get('/getInvoices' , verify , async(req , res)=>{
    var temp =[];
    var finalArr =[];
    var reserved = '';
    var length;
    var response;
    var recived;
    var removedDeletedRecords;
    var filteredArr;
    var tempArr= [];
    try{
        var decoded = jwt_decode(req.headers.authorization);
        
        //check if the user is super admin or not
        if(decoded.access.includes('sa')){
            length = await invoice.countDocuments({deleteDate:null}); 
            response = await invoice.find({deleteDate:null});
            recived = await user.find({deleteDate:null});
            var exrtactedRecived =[];
            for(var s = 0 ; recived.length>s ; s++){
                
                exrtactedRecived= exrtactedRecived.concat(recived[s].recivedRequests)
            }
            
            removedDeletedRecords = exrtactedRecived.filter(item => item.deleteDate === null);
            if(exrtactedRecived !== null){
                filteredArr = removedDeletedRecords.reduce((acc, current) => {
                    const x = acc.find(item => JSON.stringify(item.document) === JSON.stringify(current.document));
                    if (!x) {
                      return acc.concat([current]);
                    } else {
                      return acc;
                    }
                  }, []);
            }
        }else{
            length = await invoice.countDocuments({deleteDate:null}); 
            response = await invoice.find({deleteDate:null , "preInvoice.generatedBy":decoded.id});
            recived = await user.findOne({deleteDate:null , _id:decoded.id});
            removedDeletedRecords = recived.recivedRequests.filter(item => item.deleteDate === null);
            if(recived.recivedRequests !== null){
                filteredArr = removedDeletedRecords.reduce((acc, current) => {
                    const x = acc.find(item => JSON.stringify(item.document) === JSON.stringify(current.document));
                    if (!x) {
                      return acc.concat([current]);
                    } else {
                      return acc;
                    }
                  }, []);
            }
        }

        
        filteredArr.forEach(async el => {
            reserved=el.document;
            removedDeletedRecords.forEach(async el1 => {
                if(JSON.stringify(reserved) === JSON.stringify(el1.document)){
                    tempArr.push(el1);
                }
            });
                tempArr.sort((a,b)=>{
                    return new Date(a.date) - new Date(b.date);
                })
                temp.push(tempArr[tempArr.length-1]);
            tempArr = [];
        });
        for(var j = 0 ; temp.length > j ; j++){
            finalArr.push({
                date:temp[j].date,
                doc: await invoice.findOne({deleteDate:null  , _id:temp[j].document}),
                user:await user.findOne({deleteDate:null  , _id:temp[j].from})
            })
        }
        // for(var b = 0 ; response.length > b ; b++){
        //     finalArr.push({
        //         date:response[b].preInvoice.insertDate,
        //         doc: response[b],
        //         user:null,
        //         customer:await customers.findOne({_id:response[b].preInvoice.companyName})
        //     })
        // }
        for(var b = 0 ; response.length > b ; b++){
            finalArr.push({
                date:response[b].preInvoice.insertDate,
                doc: response[b],
                user:null
            })
        }
        finalArr.sort((a,b)=>{
            return new Date(b.date) - new Date(a.date);
        })
        res.status(200).send(JSON.stringify({ln:length , rs:finalArr}));
    }catch(err){
        console.log(err)
        res.status(401).send('error!');
    }
    
})


router.post('/sendPreInvoices' , verify , async(req , res)=>{
    // recivedRequests:[{from:{type:mongoose.Schema.Types.ObjectId} , date:{type:Date},document:{type:mongoose.Schema.Types.ObjectId}}],
    // sharedTo:[{to:{type:mongoose.Schema.Types.ObjectId} , by:{type:mongoose.Schema.Types.ObjectId} , date:{type:Date}}],
    var arr =[];
    try{
   
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
         const theDocument = await invoice.findOne({_id:req.body.document});
         if(theDocument.status === 2){
            const updateDocuments = await invoice.updateMany(
                { _id:req.body.document  },
                { "$push": { 'sharedTo' : arr } ,  status:2},
                { "new": true, "upsert": true }
             )
         }else if(theDocument.status === 1 || theDocument.status === 0){
            const updateDocuments = await invoice.updateMany(
                { _id:req.body.document  },
                { "$push": { 'sharedTo' : arr } ,  status:1},
                { "new": true, "upsert": true }
             )
         }

         res.status(200).send(updateUsers);
    }catch(err){
        console.log(err)
        res.status(401).send('error!');

    }
})



router.post('/deleteInvoices' , verify , async(req , res)=>{
    var deletedForDoc =[];
    var deletedForUser =[];
    var cItem = {}
    var cItem2 = {}
    try{
         const deleteRecord = await invoice.findOne({_id:req.body.id});
         const deleteRecordInUser = await user.findOne({_id:req.body.userId});
         console.log(req.body)
         if(JSON.stringify(deleteRecord.preInvoice.generatedBy) ===  JSON.stringify(req.body.userId)){
            const deleteRec = await invoice.findOneAndUpdate({_id:req.body.id} , {deleteDate:Date.now()});
            res.status(200).send('item deleted!');
        }else{
            deleteRecord.sharedTo.forEach(element => {
                if(JSON.stringify(element.to) ===  JSON.stringify(req.body.userId)){
                    cItem = element;
                    cItem.deleteDate = Date.now()
                    deletedForDoc.push(cItem)
                }else if(JSON.stringify(element.to) !==  JSON.stringify(req.body.userId)){
                    deletedForDoc.push(element)
                }
            });
            deleteRecordInUser.recivedRequests.forEach(element => {
                if(JSON.stringify(element.document) ===  JSON.stringify(req.body.id)){
                    cItem2 = element;
                    cItem2.deleteDate = Date.now()
                    deletedForUser.push(cItem2)
                }else if(JSON.stringify(element.document) !==  JSON.stringify(req.body.id)){
                    deletedForUser.push(element)
                }
            });
            const finalDoc = await invoice.findOneAndUpdate({_id:req.body.id} , {sharedTo:deletedForDoc});
            const finalUser = await user.findOneAndUpdate({_id:req.body.userId} , {recivedRequests:deletedForUser});
            res.status(200).send('item deleted!');
         }

    }catch(err){
        console.log(err)
        res.status(401).send('error!');
    }
})
router.post('/editPreInvoice' , verify , async(req , res)=>{
    try{
        const inv = await invoice.findOne({_id:req.body.docId});
        var logsArrPreInvoice = [];
        var decoded = jwt_decode(req.headers.authorization);

        if(inv.preInvoice.logs.length !== 0){
            logsArrPreInvoice.push(...inv.preInvoice.logs);
            logsArrPreInvoice.push(inv.preInvoice);
        }else if(inv.preInvoice.logs.length === 0){
            logsArrPreInvoice.push(inv.preInvoice);
        }
        const updateInvoice = await invoice.updateOne({_id:req.body.docId},{
            $set:
            {'preInvoice':{
                updateDate:Date.now(),
                updatedBy:decoded.id,
                logs:logsArrPreInvoice,
                productName:req.body.productName,
                meterage:req.body.meterage,
                dimentions:{width:req.body.dimentions.width , height:req.body.dimentions.height , diameter:req.body.dimentions.diameter},
                destination:req.body.destination,
                companyName:req.body.companyName,
                generatedBy:inv.preInvoice.generatedBy,
                logsStatus:{status:'updated' , msg:'pre invoice updated!'},
            }
           }
        })

        res.status(200).send(updateInvoice);
    }catch(err){
        console.log(err)
        res.status(401).send('error!');

    }
})

router.post('/editInvoices' , verify , async(req , res)=>{

    if(req.body.insertFactor === false){

        try{
      
            const inv = await invoice.findOne({_id:req.body.docId});
            var logsArrPreInvoice = [];
            var logsArrCompleteInvoice = [];
            var decoded = jwt_decode(req.headers.authorization);

            var generatedBy = ''
                if(inv.preInvoice.logs.length !== 0){
                    logsArrPreInvoice.push(...inv.preInvoice.logs);
                    logsArrPreInvoice.push(inv.preInvoice);
                }else if(inv.preInvoice.logs.length === 0){
                    logsArrPreInvoice.push(inv.preInvoice);
                }
                
                if(inv.completeInvoice !== undefined){
                    generatedBy = inv.completeInvoice.generatedBy
                    if(inv.completeInvoice.logs.length !== 0){
                        logsArrCompleteInvoice.push(...inv.completeInvoice.logs);
                        logsArrCompleteInvoice.push(inv.completeInvoice);
                    }else if(inv.completeInvoice.logs.length === 0){
                        logsArrCompleteInvoice.push(inv.completeInvoice);
                    }
                }else{
                    generatedBy = decoded.id
                }

                    const updateInvoice = await invoice.updateOne({_id:req.body.docId},{
                        $set:
                        {'preInvoice':{
                            updateDate:Date.now(),
                            updatedBy:decoded.id,
                            logs:logsArrPreInvoice,
                            productName:req.body.productName,
                            dimentions:{width:req.body.dimentions.width , height:req.body.dimentions.height , diameter:req.body.dimentions.diameter},
                            meterage:req.body.meterage,
                            destination:req.body.destination,
                            companyName:req.body.companyName,
                            generatedBy:inv.preInvoice.generatedBy,
                            logsStatus:{status:'updated' , msg:'pre invoice updated!'},
                        }
                    },
                    'completeInvoice':{
                        
                        updateDate:Date.now(),
                        deleteDate:Date.now(),
                        updatedBy:decoded.id,
                        logs:logsArrCompleteInvoice,
                        logsStatus:{status:'deleted' , msg:'invoice deleted!'},
                    },
                    status:1
                    
                    }
                )
        
                res.status(200).send(updateInvoice);
    
            
        }catch(err){
            console.log(err)
            res.status(401).send('error!');
    
        }
    }else if(req.body.insertFactor === true){
        try{
      
            const inv = await invoice.findOne({_id:req.body.docId});
            var logsArrPreInvoice = [];
            var logsArrPreInvoice = [];
            var generatedBy = ''
            var logsArrCompleteInvoice = [];
            var decoded = jwt_decode(req.headers.authorization);
            
                if(inv.preInvoice.logs.length !== 0){
                    logsArrPreInvoice.push(...inv.preInvoice.logs);
                    logsArrPreInvoice.push(inv.preInvoice);
                }else if(inv.preInvoice.logs.length === 0){
                    logsArrPreInvoice.push(inv.preInvoice);
                }
                
                if(inv.completeInvoice !== undefined){
                    generatedBy = inv.completeInvoice.generatedBy
                    if(inv.completeInvoice.logs.length !== 0){
                        logsArrCompleteInvoice.push(...inv.completeInvoice.logs);
                        logsArrCompleteInvoice.push(inv.completeInvoice);
                    }else if(inv.completeInvoice.logs.length === 0){
                        logsArrCompleteInvoice.push(inv.completeInvoice);
                    }
                }else{
                    generatedBy = decoded.id
                }

    
                const updateInvoice = await invoice.updateOne({_id:req.body.docId},{
                    $set:
                    {'preInvoice':{
                        updateDate:Date.now(),
                        updatedBy:decoded.id,
                        logs:logsArrPreInvoice,
                        productName:req.body.productName,
                        meterage:req.body.meterage,
                        dimentions:{width:req.body.dimentions.width , height:req.body.dimentions.height , diameter:req.body.dimentions.diameter},
                        destination:req.body.destination,
                        companyName:req.body.companyName,
                        logsStatus:{status:'updated' , msg:'pre invoice updated!'},
                        generatedBy:inv.preInvoice.generatedBy
                    },
                    'completeInvoice':{
                        updateDate:Date.now(),
                        updatedBy:decoded.id,
                        logs:logsArrCompleteInvoice,
                        invoiceDate:req.body.invoiceDate,
                        costCnf:req.body.costCnf,
                        costFob:req.body.costFob,
                        factoryPrice:req.body.factoryPrice,
                        stoneThickness:req.body.stoneThickness,
                        stoneRate:req.body.stoneRate,
                        dateOfShipment:req.body.dateOfShipment,
                        generatedBy:generatedBy,
                        logsStatus:{status:'updated' , msg:'invoice updated!'},
                    },
                    status:2
                   }
                })
                res.status(200).send(updateInvoice);
            
        }catch(err){
            console.log(err)
            res.status(401).send('error!');
    
        }

    }

})


router.get('/getAllInvoicesForSelect' , verify , async(req , res)=>{
    try{
        const invoices = await invoice.find({deleteDate:null , 'preInvoice.companyName':req.query.id})
        res.status(200).send(invoices);
    }catch(err){
       
        res.status(403).send('error!')
    }
})

module.exports = router;    
