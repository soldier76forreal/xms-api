const express = require('express');
const mongoose = require('mongoose');
const jwt_decode = require('jwt-decode');
const notficationModel = require("../../models/notficationsModel");
const userModel = require("../../models/userModel");
const invoiceModel = require("../../models/invoiceModel");
const verify = require('../users/verifyToken');
const verifyLink = require('../users/verifyLinks');
const path = require('path');
const pwaSubscriptionModel = require('../../models/pwaSubscriptionModel');
const dotenv = require("dotenv");
dotenv.config();
const { v4: uuidv4 } = require('uuid'); // Safer than randomstring
const multer = require('multer');
const archiver = require('archiver');
const dbConnection = require("../../connections/xmsPr");
const user = dbConnection.model('user' , userModel);
const invoice = dbConnection.model('invoice' , invoiceModel);
const notfication = dbConnection.model('notfication' , notficationModel);
const pwaSubscription = dbConnection.model('pwaSubscription' , pwaSubscriptionModel);
const webpush = require('web-push');
const { query } = require('express');
const fs = require("fs");
const { id } = require('@hapi/joi/lib/base');
//webpush
webpush.setVapidDetails('mailto:test@test.com' , process.env.PublicVapidKey , process.env.PrivateVapidKey);

const folderModel = require("../../models/folderModel");
const fileModal = require("../../models/fileModel");
const filesFoldersTagsModel = require("../../models/filesFoldersTagsModel");
const linkModel = require("../../models/linkModel");
const sharp = require('sharp'); 
const folder = dbConnection.model('folder' , folderModel);
const file = dbConnection.model('file' , fileModal);
const filesFoldersTags = dbConnection.model('fileFoldersTag' , filesFoldersTagsModel);
const link = dbConnection.model('link' , linkModel);
const crypto = require('crypto');
// per-link JWT secret — random hex via built-in crypto (replaced the vulnerable
// 'generate-api-key' package; existing links are unaffected, their secret is stored on the doc)
const generateApiKey = () => crypto.randomBytes(32).toString('hex');
const jwt = require("jsonwebtoken");
const sizeOf = require('image-size')
var AdmZip = require("adm-zip");
var randomstring = require("randomstring");
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null,"public/uploads");
    },
    filename: function (req, file, cb) {
        const filen = file.fieldname + '-' + Date.now() + file.originalname.match(/\..*$/)[0]
        cb(null, filen)
        req.on('aborted', () => {
          const fullFilePath = `public/uploads/${filen}`
          file.stream.on('end', () => {
            fs.unlink(fullFilePath, (err) => {
              if (err) {
                console.error("Failed to remove aborted upload:", err);
              }
            });
          });
          file.stream.emit('end');
        })
    }
  })
  
  const upload = multer({ storage: storage })

  var zip = new AdmZip();

// ── Phase 9: File Manager activity feed + per-user pins ───────────────────────
const fileActivitySchema = require('../../models/fileActivityModel');
const FileActivity = dbConnection.models.fileActivity || dbConnection.model('fileActivity', fileActivitySchema);

// Every fileManager mutation writes an activity row in the same operation
// (mirror of inventoryChangeLogs). Non-fatal by design.
async function logFileActivity(req, fields) {
  try {
    const decoded = jwt_decode(req.headers.authorization);
    const actor = await user.findById(decoded.id).select('firstName lastName').lean();
    await FileActivity.create({
      ...fields,
      actorId: decoded.id,
      actorName: actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '',
      date: new Date(),
    });
  } catch (_) { /* activity is best-effort — never fail the mutation */ }
}

const router = express.Router()

// ── POST /files/togglePin — pin/unpin a file or folder for the CURRENT user ──
router.post('/togglePin', verify, async (req, res) => {
  try {
    const decoded = jwt_decode(req.headers.authorization);
    const { itemId, kind } = req.body;   // kind: 'file' | 'folder'
    if (!itemId || !['file', 'folder'].includes(kind)) {
      return res.status(400).json({ message: 'itemId and kind (file|folder) are required' });
    }
    const Model = kind === 'file' ? file : folder;
    const doc = await Model.findOne({ _id: itemId, deleteDate: null });
    if (!doc) return res.status(404).json({ message: 'Item not found' });

    const uid = String(decoded.id);
    const pinned = (doc.pinnedBy || []).map(String).includes(uid);
    await Model.updateOne(
      { _id: itemId },
      pinned ? { $pull: { pinnedBy: decoded.id } } : { $addToSet: { pinnedBy: decoded.id } }
    );
    return res.status(200).json({ pinned: !pinned });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /files/activity — the Activity feed (File Manager scope only) ────────
router.get('/activity', verify, async (req, res) => {
  try {
    const { itemId = '', limit = 40 } = req.query;
    const query = itemId ? { itemId } : {};
    const rows = await FileActivity.find(query)
      .sort('-date')
      .limit(Math.min(Number(limit) || 40, 100))
      .lean();
    return res.status(200).json(rows);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

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

            await logFileActivity(req, { type: 'new_folder', itemKind: 'folder',
                itemId: newCustomer._id, itemName: newCustomer.name, path: req.body.supFolder });
            res.status(200).send("new folder created!");
        }catch(err){
        console.log(err)
        }
    })



    router.post('/deleteFolderFile' , verify  , async(req , res)=>{
        const data = req.body
        try{
            for(var i = 0 ; data.length > i ; i++){
                if(data[i].type === 'folder'){
                    const theDoc = await folder.findOne({_id:data[i].id});
                    var decoded = jwt_decode(req.headers.authorization);
                    const deleteFolder = await folder.updateOne({_id:data[i].id},{
                        deleteDate:Date.now(),
                        "$push": { 'logs' : [theDoc] } ,
                        updatedBy:decoded.id,
                        updateDate:Date.now(),
                        logsStatus:{status:'delete' , msg:'folder deleted!'}
                    })
                    await logFileActivity(req, { type: 'delete', itemKind: 'folder',
                        itemId: data[i].id, itemName: theDoc?.name, path: theDoc?.supFolder });
                }else if(data[i].type==='file'){
                    const theDoc = await file.findOne({_id:data[i].id});
                    var decoded = jwt_decode(req.headers.authorization);
                    const deleteFile = await file.updateOne({_id:data[i].id},{
                        deleteDate:Date.now(),
                        "$push": { 'logs' : [theDoc] } ,
                        updatedBy:decoded.id,
                        updateDate:Date.now(),
                        logsStatus:{status:'delete' , msg:'file deleted!'}
                    })
                    await logFileActivity(req, { type: 'delete', itemKind: 'file',
                        itemId: data[i].id, itemName: theDoc?.name, path: theDoc?.supFolder });
                }
            }
            res.status(200).send('deleted!');
        }catch(err){
            res.status(402).send(err);
            console.log(err)
        }

    })


    router.post('/folderRename' , verify  , async(req , res)=>{
        if(req.body.typeId.type === 'folder'){
            try{
                const theDoc = await folder.findOne({_id:req.body.typeId.id});
                var decoded = jwt_decode(req.headers.authorization);
                const renameFolder = await folder.findOneAndUpdate({_id:req.body.typeId.id},{
                    name:req.body.newName,
                    updatedBy:decoded.id,
                    updateDate:Date.now(),
                    "$push": { 'logs' : [theDoc] } ,
                    logsStatus:{status:'rename' , msg:'folder renamed!'}

                })
                await logFileActivity(req, { type: 'rename', itemKind: 'folder',
                    itemId: req.body.typeId.id, itemName: req.body.newName,
                    oldValue: theDoc?.name, newValue: req.body.newName, path: theDoc?.supFolder });
                res.status(200).send('renamed!');
            }catch(err){
                res.status(402).send(err);
                console.log(err)
            }
        }else if(req.body.typeId.type === 'file'){
            try{
                const theDoc = await file.findOne({_id:req.body.typeId.id});
                var decoded = jwt_decode(req.headers.authorization);
                const renameFolder = await file.findOneAndUpdate({_id:req.body.typeId.id},{
                    name:req.body.newName,
                    'metaData.originalname':`${req.body.newName}.${getFileExtension(theDoc.metaData)}`,
                    updatedBy:decoded.id,
                    updateDate:Date.now(),
                    "$push": { 'logs' : [theDoc] }, 
                    logsStatus:{status:'rename' , msg:'file renamed!'}

                })
                await logFileActivity(req, { type: 'rename', itemKind: 'file',
                    itemId: req.body.typeId.id, itemName: req.body.newName,
                    oldValue: theDoc?.name, newValue: req.body.newName, path: theDoc?.supFolder });
                res.status(200).send('renamed!');
            }catch(err){
                res.status(402).send(err);
                console.log(err)
            }
        }
    })


    const checkIfTheNameisNotAvailableFolder = async(newSupFolder, theFolder) =>{

            const theFolderDoc = await folder.findOne({_id:theFolder});

            

            var check = true;
            var number = 0;
            var tempName
            var tempNum = 0
            while(true){
                if(number === 0){
                    tempName = `${theFolderDoc.name}`

                }else if(number >0){
                    tempName = `${theFolderDoc.name}${number}`
                }
                if(newSupFolder === 'root'){
                    const fine = await folder.findOne({name:tempName , supFolder:'root'})
                    if(fine === null){
                        if(number === 0) return null
                        else if(number>0) return `${theFolderDoc.name}${number}`
    
                    }if(fine !==null){
                        check=true
                        number = number + 1;
                        tempName=''
                    }
                }else{
                    const theSupFolder = await folder.findOne({_id:newSupFolder});

                    tempNum = number;
                    for(var i = 0 ; theSupFolder.subFolders.length > i ; i++){
                        var tempDoc = await folder.findOne({_id:theSupFolder.subFolders[i] , name:tempName})
                        if(tempDoc !==null){
                            number = number + 1;
                        }
                    }

                    if(number > tempNum){
                        tempName = ''
                        check = true
                        tempNum=0

                    }else if(number === tempNum && number !==0){
                        return `${theFolderDoc.name}${number}` 

                    }else if(number === tempNum && number ===0) return null
                }
                    
                }



    
    }


    router.post('/folderMove' , verify  , async(req , res)=>{
        try{
            var decoded = jwt_decode(req.headers.authorization);
            for(var i = 0 ; req.body.dataArr.length>i ; i++){
                if(req.body.dataArr[i].type === 'folder'){
                    const theDoc = await folder.findOne({_id:req.body.dataArr[i].id});
                    if(theDoc.supFolder !== req.body.dataArr[i].supFolder){

                        var nameValidation = await checkIfTheNameisNotAvailableFolder(req.body.dataArr[i].supFolder, req.body.dataArr[i].id)
                        const supFolderUplade = folder.findOneAndUpdate({ subFolders: { $in: [req.body.dataArr[i].id] } } , {"$pull": { 'subFolders' : [req.body.dataArr[i].id] },})
                        if(nameValidation !== null){
                            const folderMove = await folder.findOneAndUpdate({_id:req.body.dataArr[i].id},{
                                supFolder:req.body.dataArr[i].supFolder,
                                name:nameValidation,
                                "$push": { 'logs' : [theDoc] },
                                logsStatus:{status:'move' , msg:'folder moved!'},
                                updatedBy:decoded.id,
                                updateDate:Date.now()
                            })
                        }else if(nameValidation === null){
                            const folderMove = await folder.findOneAndUpdate({_id:req.body.dataArr[i].id},{
                                supFolder:req.body.dataArr[i].supFolder,
                                "$push": { 'logs' : [theDoc] },
                                logsStatus:{status:'move' , msg:'folder moved!'},
                                updatedBy:decoded.id,
                                updateDate:Date.now()
                            })
                        }
                        const newSupFolderUplade = folder.findOneAndUpdate({ _id:req.body.dataArr[i].supFolder} , {"$push": { 'subFolders' : [req.body.dataArr[i].id] },})
                    }else if(theDoc.supFolder === req.body.dataArr[i].supFolder){ throw new TypeError("folder is already here!");}

                }else if(req.body.dataArr[i].type === 'file'){
                    const theDoc = await file.findOne({_id:req.body.dataArr[i].id});
                    if(theDoc.supFolder !== req.body.dataArr[i].supFolder){
                        if(req.body.dataArr[i].supFolder === 'root'){
                            const updatedArrayOfSupFiles =await folder.findOne({ _id:theDoc.supFolder })
                            const supFolderUpdate =await folder.findOneAndUpdate({ _id:theDoc.supFolder } , {subFiles:updatedArrayOfSupFiles.subFiles.filter(e=>{return JSON.stringify(e) !== JSON.stringify(req.body.dataArr[i].id) })})
                            const folderMove = await file.findOneAndUpdate({_id:req.body.dataArr[i].id},{
                                supFolder:req.body.dataArr[i].supFolder,
                                "$push": { 'logs' : [theDoc] },
                                logsStatus:{status:'move' , msg:'folder moved!'},
                                updatedBy:decoded.id,
                                updateDate:Date.now()
                            })
                        }else{
                            if(theDoc.supFolder ==='root'){
                                const folderMove = await file.findOneAndUpdate({_id:req.body.dataArr[i].id},{
                                    supFolder:req.body.dataArr[i].supFolder,
                                    "$push": { 'logs' : [theDoc] },
                                    logsStatus:{status:'move' , msg:'folder moved!'},
                                    updatedBy:decoded.id,
                                    updateDate:Date.now()
                                })
                                const newSupFolderUplade = await folder.findOneAndUpdate({ _id:req.body.dataArr[i].supFolder} , {"$push": { 'subFiles' : [req.body.dataArr[i].id] }})
                            }else{
                                const updatedArrayOfSupFiles =await folder.findOne({ _id:theDoc.supFolder })
                                const supFolderUpdate =await folder.findOneAndUpdate({ _id:theDoc.supFolder } , {subFiles:updatedArrayOfSupFiles.subFiles.filter(e=>{return JSON.stringify(e) !== JSON.stringify(req.body.dataArr[i].id) })})
                                const folderMove = await file.findOneAndUpdate({_id:req.body.dataArr[i].id},{
                                    supFolder:req.body.dataArr[i].supFolder,
                                    "$push": { 'logs' : [theDoc] },
                                    logsStatus:{status:'move' , msg:'folder moved!'},
                                    updatedBy:decoded.id,
                                    updateDate:Date.now()
                                })
                                const newSupFolderUplade = await folder.findOneAndUpdate({ _id:req.body.dataArr[i].supFolder} , {"$push": { 'subFiles' : [req.body.dataArr[i].id] }})
                            }
                        }
                    }else if(theDoc.supFolder === req.body.dataArr[i].supFolder){throw new TypeError("folder is already here!");}

                }
 
            }

            for (const d of (req.body.dataArr || [])) {
                await logFileActivity(req, { type: 'move', itemKind: d.type, itemId: d.id,
                    newValue: req.body.newSupFolder });
            }
            res.status(200).send('moved!');

        }catch(err){
            res.status(400).send(err);
            console.log(err)
        }
    })





    const newFile = async(id , sup , decoded) =>{
        const oldFileInit = await file.findOne({_id:id , deleteDate:null});
        if(oldFileInit!==null){
            var newDocumentFileInit = oldFileInit.toObject();
            delete newDocumentFileInit._id;
            newDocumentFileInit.updateDate = Date.now();
            newDocumentFileInit.updatedBy = decoded.id;
            newDocumentFileInit.supFolder = sup;
            newDocumentFileInit.logsStatus = {status:'copy' , msg:'file copied!'};
            const savedDocument = await new file(newDocumentFileInit).save();
            return savedDocument._id;
        }else return null
    }
    
    
    router.post('/folderCopy' , verify  , async(req , res)=>{
        try{
            var decoded = jwt_decode(req.headers.authorization);
                
            for(var i = 0 ; req.body.dataArr.length>i ; i++){
                if(req.body.dataArr[i].type==='folder'){
                        const doc = await folder.findOne({_id:req.body.dataArr[i].id , deleteDate:null});
                        var stack = [{supFolder:doc.supFolder, newId:null , id:doc._id , subFolders:doc.subFolders , subFiles:doc.subFiles}]
                        for(var g = 0 ; stack.length>g ; g++){
                            for(var y = 0 ; stack[g].subFolders.length>y ; y++){
                                const docForStack = await folder.findOne({_id:stack[g].subFolders[y] , deleteDate:null});
                                stack.push({supFolder:docForStack.supFolder, newId:null , id:docForStack._id , subFolders:docForStack.subFolders , subFiles:docForStack.subFiles})
                            }
                        }
                        for(var r = 0 ; stack.length>r ; r++){
                            const oldFolderInit = await folder.findOne({_id:stack[r].id , deleteDate:null});
                            // var name = null
                            // var checkName
                            // if(stack[0]){
                            //     console.log(req.body.dataArr[i])
                            // }
                            // checkName = await checkIfTheNameisNotAvailableFolder(req.body.dataArr[i].supFolder,stack[0].id)
                            // console.log(await checkIfTheNameisNotAvailableFolder(req.body.dataArr[i].supFolder,stack[0].id))

                            // if(checkName!==null){
                            //     name = checkName
                            // }else if(checkName!==null){
                            //     name = null
                            // }
                            
                            var newDocumentFileInit = oldFolderInit.toObject();
                            delete newDocumentFileInit._id;
                            newDocumentFileInit.updateDate = Date.now();
                            newDocumentFileInit.name !== null ? newDocumentFileInit.name:oldFolderInit.name;
                            newDocumentFileInit.updatedBy = decoded.id;
                            newDocumentFileInit.logsStatus = {status:'copy' , msg:'folder copied!'};
                            const savedDocument = await new folder(newDocumentFileInit).save();
                            stack[r].newId = savedDocument._id
                            
                        }
                        for(var n = 0 ; stack.length>n ; n++){
                            var newSubFolders = []
                            for(var a = 0 ; stack[n].subFolders.length > a ; a++){
                                const searchIndex = stack.find((doc) => JSON.stringify(doc.id) === JSON.stringify(stack[n].subFolders[a]));
                                newSubFolders.push(searchIndex.newId)
                                await folder.findOneAndUpdate({_id:stack[n].newId, deleteDate:null},{subFolders:newSubFolders})
                            }
                             var newSubFiles = [];
                            for(var x = 0 ; stack[n].subFiles.length > x ; x++){
                                const theFile= await newFile(stack[n].subFiles[x] , stack[n].newId , decoded)
                                newSubFiles.push(theFile)
                            }
                             const res = await folder.updateOne({_id:stack[n].newId , deleteDate:null} , {subFiles:newSubFiles});

                            var newSupFolder

                            if(stack[n].supFolder !== 'root'){
                                stack.forEach(element => {
                                    if(JSON.stringify(element.id) === JSON.stringify(stack[n].supFolder)){
                                        newSupFolder = element
                                    }
                                    
                                });
                                if( newSupFolder !== undefined){
                                    await folder.findOneAndUpdate({_id:stack[n].newId, deleteDate:null},{supFolder:newSupFolder.newId})
                                }
                            }


 

                        }
                        if(req.body.dataArr[i].supFolder ==='root'){
                            await folder.findOneAndUpdate({_id:stack[0].newId, deleteDate:null},{supFolder:'root'})
                        }else if(req.body.dataArr[i].supFolder !=='root'){
                            await folder.findOneAndUpdate({_id:stack[0].newId, deleteDate:null},{supFolder:req.body.dataArr[i].supFolder})
                            await folder.findOneAndUpdate({_id:req.body.dataArr[i].supFolder, deleteDate:null},{"$push": { 'subFolders' : [stack[0].newId] }})
                        }


                }else if(req.body.dataArr[i].type==='file'){
                    const file = await newFile(req.body.dataArr[i].id , req.body.dataArr[i].supFolder , decoded)
                    const folderMove = await folder.updateOne({_id:req.body.dataArr[i].supFolder},{
                        "$push": { 'subFiles' : [file] },
                        logsStatus:{status:'copy' , msg:'file copied in!'},
                        updatedBy:decoded.id,
                        updateDate:Date.now()
                    })
                }
            }
            for (const d of (req.body.dataArr || [])) {
                await logFileActivity(req, { type: 'copy', itemKind: d.type, itemId: d.id,
                    newValue: req.body.newSupFolder });
            }
            res.status(200).send('copied!');

        }catch(err){
            res.status(400).send(err);
            console.log(err)
        }
    })





    


    router.get('/getAllFileAndFolders', verify   , async(req , res)=>{
        try{
            const findFolders = await folder.find({deleteDate:null});
            // Only show files that belong to the file manager (not inventory/crm/etc. media)
            const findFiles = await file.find({deleteDate:null, hidden:{$in:[false,undefined,null]}, $or:[{scope:'file_manager'},{scope:{$exists:false}}]});
            var mixedRes = [];
            var tempFiles = []
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
                        for(var d = 0 ; findFiles.length > d ; d++){
                            if(JSON.stringify(findFiles[d]._id) === JSON.stringify(findFolders[i].subFiles[q])){
                                if(findFiles[d].format === 'jpg' || findFiles[d].format === 'JPG' || findFiles[d].format === 'png' ||findFiles[d].format === 'svg' || findFiles[d].format === 'jpeg' || findFiles[d].format === 'JPGE'|| findFiles[d].format === 'PNG' || findFiles[d].format === 'SVG'){
                                    temp.push({file:findFiles[d] , dim:sizeOf(`./public/uploads/${findFiles[d].metaData.filename}`)})
                                }else{
                                    temp.push({file:findFiles[d]})
                                }
                                
                            }
                        }
                    }
                }

                mixedRes.push({
                    doc:findFolders[i],
                    subs:temp
                })
                temp = [];
            }
            const filesOfRoot = findFiles.filter(e=>{return e.supFolder === 'root'}).map(e=>{
                if(e.format === 'jpg' || e.format === 'JPG' || e.format === 'png' ||e.format === 'svg' || e.format === 'jpeg' || e.format === 'JPGE'|| e.format === 'PNG' || e.format === 'SVG'){
                    return {file:e , dim:sizeOf(`./public/uploads/${e.metaData.filename}`)}
                }else{
                    return {file:e}
                }
            })

            mixedRes.push({
                doc:'root',
                subs:filesOfRoot
            })
            res.status(200).send(mixedRes);
        }catch(err){
            res.status(402).send(err);
            console.log(err)
        }
    })


    function getFileExtension(fileName) {
        return fileName.originalname.slice((fileName.originalname.lastIndexOf(".") - 1 >>> 0) + 2);
      }
router.post("/uploadFile", verify, upload.single("files"), async (req, res, next) => {
    var decoded = jwt_decode(req.headers.authorization);

    // 1. Prepare to generate thumbnail
    let thumbnailPath = null;
    
    // Check if the file exists and is an image
    if (req.file && req.file.mimetype.startsWith('image/')) {
        try {
            // Create a unique filename for the thumbnail (e.g., thumb-12345.jpg)
            const thumbFilename = `thumb-${req.file.filename}`;
            
            // Define where to save it. (Assuming req.file.destination is your upload folder)
            // If req.file.destination is undefined, use path.dirname(req.file.path)
            const uploadDir = req.file.destination || path.dirname(req.file.path);
            const thumbOutputPath = path.join(uploadDir, thumbFilename);

            // 2. Generate the thumbnail using Sharp
            await sharp(req.file.path)
                .resize(300) // Resize to 300px width (height auto-scales)
                .jpeg({ quality: 80 }) // Compress to make it light
                .toFile(thumbOutputPath);

            // Set the path relative to your server root so the frontend can access it
            // Adjust this string based on how you serve static files
            thumbnailPath = thumbFilename; 

        } catch (err) {
            console.error("Thumbnail generation failed:", err);
            // We don't stop the upload if thumb fails, just leave thumbnailPath as null
        }
    }

    const fileScope = req.body.scope || 'file_manager';
    const attachedTo = req.body.attachedToType && req.body.attachedToId
      ? { type: req.body.attachedToType, id: req.body.attachedToId }
      : undefined;

    var newFile = new file({
        name: req.file.originalname.split(".", 1).pop(),
        supFolder: req.body.supFolder,
        metaData: req.file,
        format: getFileExtension(req.file),
        insertDate: Date.now(),
        logsStatus: { status: 'created', msg: 'file created!' },
        generatedBy: decoded.id,
        thumbnail: thumbnailPath,
        scope: fileScope,
        attachedTo,
    });

    try {
        const result = await newFile.save();
        if (req.body.supFolder !== 'root') {
            const updateSupFolder = await folder.updateOne(
                { _id: req.body.supFolder },
                { "$push": { 'subFiles': result._id } }
            );
        }
        await logFileActivity(req, { type: 'upload', itemKind: 'file',
            itemId: result._id, itemName: result.name, path: req.body.supFolder });
        res.status(200).send(result);
    } catch (error) {
        console.log(error); // Helpful for debugging
        res.status(500).send("Something went wrong");
    }
});

      router.get('/getAllFileAndFoldersTags', verify  , async(req , res)=>{
        try{
            const findFolders = await filesFoldersTags.find({deleteDate:null});
            res.status(200).send(findFolders);
        }catch(err){
            res.status(402).send(err);
            console.log(err)
        }
    })



    router.post('/addTag', verify   , async(req , res)=>{
        try{
            const theTag = req.body.tag
            const selected = req.body.selected;


            var decoded = jwt_decode(req.headers.authorization);
            if(theTag.id !== undefined){
                var theDoc = await filesFoldersTags.findOne({_id:theTag.id , tag:theTag.label , deleteDate:null})
                for(var i = 0 ; selected.length > i ; i++){
                    if(selected[i].type === 'file'){
                        const tagLog = await filesFoldersTags.findOne({_id:theTag.id , deleteDate:null})
                        const fileLog = await file.findOne({_id:selected[i].id , deleteDate:null})
                        if(theDoc.files.includes(selected[i].id)=== false){
                            await filesFoldersTags.updateOne({_id:theTag.id , deleteDate:null},{"$push": { 'files' : [selected[i].id]  , 'logs' : [tagLog]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'file added!'}})
                            await file.updateOne({_id:selected[i].id , deleteDate:null},{"$push": { 'tags' : [theTag.id]  , 'logs' : [fileLog]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'tag added!'}})
                        }
                    }else if(selected[i].type === 'folder'){
                        const tagLog = await filesFoldersTags.findOne({_id:theTag.id , deleteDate:null})
                        const fileLog = await folder.findOne({_id:selected[i].id  , deleteDate:null})
                        if(theDoc.folders.includes(selected[i].id)=== false){
                            await filesFoldersTags.updateOne({_id:theTag.id , deleteDate:null},{"$push": { 'folders' : [selected[i].id] , 'logs' : [tagLog]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'folder added!'}})
                            await folder.updateOne({_id:selected[i].id , deleteDate:null},{"$push": { 'tags' : [theTag.id] , 'logs' : [fileLog]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'tag added!'}})
                        }
                    }
                }
            }else if(theTag.id === undefined){
                
                var theDoc = await filesFoldersTags.findOne({tag:theTag.label , deleteDate:null})

                if(theDoc === null){
                    var newTag = new filesFoldersTags({
                        tag:theTag.label,
                        generatedBy:decoded.id,
                        insertDate:Date.now(),
                        logsStatus:{status:'created' , msg:'tag created!'},
    
                    })
                    const result = await newTag.save();  
                    for(var i = 0 ; selected.length > i ; i++){
                        if(selected[i].type === 'file'){
                            if(result.files.includes(selected[i].id) === false){
                                const tagLog = await filesFoldersTags.findOne({_id:result._id , deleteDate:null})
                                const fileLog = await file.findOne({_id:selected[i].id , deleteDate:null})
                                await filesFoldersTags.updateOne({_id:result._id , deleteDate:null},{"$push": { 'files' : [selected[i].id] , 'logs' : [tagLog]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'file added!'}})
                                await file.updateOne({_id:selected[i].id , deleteDate:null},{"$push": { 'tags' : [result._id] , 'logs' : [fileLog]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'tag added!'}})
                            }
                        }else if(selected[i].type === 'folder' ){
                            if(result.folders.includes(selected[i].id) === false){
                                const tagLog = await filesFoldersTags.findOne({_id:result._id , deleteDate:null})
                                const fileLog = await folder.findOne({_id:selected[i].id  , deleteDate:null})
                                await filesFoldersTags.updateOne({_id:result._id , deleteDate:null},{"$push": { 'folders' : [selected[i].id] , 'logs' : [tagLog]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'folder added!'}})
                                await folder.updateOne({_id:selected[i].id , deleteDate:null},{"$push": { 'tags' : [result._id] , 'logs' : [fileLog]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'tag added!'}})
                            }
                        }
                    }

                }else if(theDoc !== null){
                    for(var i = 0 ; selected.length > i ; i++){
                        if(selected[i].type === 'file'){
                            if(theDoc.files.includes(selected[i].id )=== false){
                                const fileLog = await file.findOne({_id:selected[i].id  , deleteDate:null})
                                await filesFoldersTags.updateOne({_id:theDoc._id , deleteDate:null},{"$push": { 'files' : [selected[i].id] , 'logs' : [theDoc]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'file added!'}})
                                await file.updateOne({_id:selected[i].id , deleteDate:null},{"$push": { 'tags' : [theDoc._id] , 'logs' : [fileLog]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'tag added!'}})
                            }
                        }else if(selected[i].type === 'folder'){
                            if(theDoc.folders.includes(selected[i].id )=== false){
                                const fileLog = await folder.findOne({_id:selected[i].id , deleteDate:null})
                                await filesFoldersTags.updateOne({_id:theDoc._id , deleteDate:null},{"$push": { 'folders' : [selected[i].id], 'logs' : [theDoc]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'folder added!'}})
                                await folder.updateOne({_id:selected[i].id , deleteDate:null},{"$push": { 'tags' : [theDoc._id] , 'logs' : [fileLog]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'added' , msg:'tag added!'}})
                            }
                        }
                    }
                }
            }
            for (const sel of (selected || [])) {
                await logFileActivity(req, { type: 'tag_added', itemKind: sel.type,
                    itemId: sel.id, newValue: theTag.label });
            }
            res.status(200).send('tag added');
        }catch(err){
            res.status(402).send(err);
            console.log(err)
        }
    })



    router.post('/downloadFile', verify  , async(req , res)=>{
        try{
            
            const findFolders = await filesFoldersTags.find({deleteDate:null});
            res.status(200).send(findFolders);
        }catch(err){
            res.status(402).send(err);
            console.log(err)
        }
    })


    router.post('/deleteTagFromFileFolder', verify  , async(req , res)=>{
        
        try{
            var decoded = jwt_decode(req.headers.authorization);
            const theTag = await filesFoldersTags.findOne({_id:req.body.tagId})
            if(req.body.selected.type === 'file'){
                const theFile = await file.findOne({_id:req.body.selected.id})
                await filesFoldersTags.updateOne({_id:req.body.tagId , deleteDate:null},{"$pull": { 'files': { "$in": [req.body.selected.id] } } , "$push": { 'logs' : [theTag]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'deleted!' , msg:'file deleted from tag!'}})
                await file.updateOne({_id:req.body.selected.id , deleteDate:null},{"$pull": { 'tags': { "$in": [req.body.tagId] } }, "$push": {'logs' : [theFile]},updateDate:Date.now() , updatedBy:decoded.id ,logsStatus:{status:'deleted!' , msg:'tag deleted from file!'}})
            }else if(req.body.selected.type === 'folder'){
                const theFolder = await folder.findOne({_id:req.body.selected.id})
                await filesFoldersTags.updateOne({_id:req.body.tagId , deleteDate:null},{ "$pull": { 'folders': { "$in": [req.body.selected.id] } }, "$push": { 'logs' : [theTag]},updateDate:Date.now() , updatedBy:decoded.id, logsStatus:{status:'deleted!' , msg:'folder deleted from tag!'}})
                await folder.updateOne({_id:req.body.selected.id , deleteDate:null},{"$pull": { 'tags': { "$in": [req.body.tagId] } }, "$push": {'logs' : [theFolder]},updateDate:Date.now() , updatedBy:decoded.id ,logsStatus:{status:'deleted!' , msg:'tag deleted from folder!'}})
            }
            await logFileActivity(req, { type: 'tag_removed', itemKind: req.body.selected.type,
                itemId: req.body.selected.id, oldValue: theTag?.tag });
            res.status(200).send('removed!');
        }catch(err){
            res.status(403).send(err);
            console.log(err)
        }
    })


    
    router.post('/createNewLink', verify  , async(req , res)=>{
        try{
            var decoded = jwt_decode(req.headers.authorization);
            const accessKey = generateApiKey()
            const token = jwt.sign({} , accessKey , {expiresIn : `${req.body.timer}m`} );
            newLink = new link({
                document:req.body.document,
                token:token,
                msg:req.body.msg === ''?null:req.body.msg,
                showName:req.body.displayName,
                secret:accessKey,
                generatedBy:decoded.id,
                insertDate:Date.now(),
                logsStatus:{status:'created' , msg:'link created!'}
            })
            const result = await newLink.save();

            for (const d of (req.body.document || [])) {
                await logFileActivity(req, { type: 'share_link', itemKind: d.type, itemId: d.id,
                    newValue: req.body.displayName || null });
            }
            res.status(200).send(token);
        }catch(err){
            res.status(402).send(err);
            console.log(err)
        }
    })
       


    router.get('/getFileForLink', verifyLink  , async(req , res)=>{
        try{
            var token = req.headers.authorization;
            const linkDoc = await link.findOne({token:token.split(" ")[1] , deleteDate:null}).select('_id document msg showName generatedBy insertDate')
            
            var finalArr = []
            var folders = []

            for(var i = 0 ; linkDoc.document.length>i ; i++){
                if(linkDoc.document[i].type === 'folder'){
                    folders.push(linkDoc.document[i].id)
                }else if(linkDoc.document[i].type === 'file'){
                    const tempDoc = await file.findOne({_id:linkDoc.document[i].id}).lean()
                    tempDoc.dim = sizeOf(`./public/uploads/${tempDoc.metaData.filename}`)
                    if(tempDoc.format === 'jpg' || tempDoc.format === 'JPG' || tempDoc.format === 'png' ||tempDoc.format === 'svg' || tempDoc.format === 'jpeg' || tempDoc.format === 'JPGE'|| tempDoc.format === 'PNG' || tempDoc.format === 'SVG'){
                        finalArr.push({type:'file',doc:tempDoc})
                    }else{
                        finalArr.push({type:'file',doc:tempDoc })
                    }
                    
                }
            }
            if(folders.length>0){
                for(var p = 0 ; folders.length>p ; p++){
                    var doc = await folder.findOne({_id:folders[p]});
                    var tempFi = await file.find({_id: { $in: doc.subFiles}}).lean();
                    var tempFo = await folder.find({_id: { $in: doc.subFolders}} );
                    var finalFi = []
                    for(var o = 0 ; tempFi.length>o ; o++){
                        if(tempFi[o].format === 'jpg' || tempFi[o].format === 'JPG' || tempFi[o].format === 'png' ||tempFi[o].format === 'svg' || tempFi[o].format === 'jpeg' || tempFi[o].format === 'JPGE'|| tempFi[o].format === 'PNG' || tempFi[o].format === 'SVG'){
                            var temp = tempFi[o];
                            temp.dim=sizeOf(`./public/uploads/${tempFi[o].metaData.filename}`)
                            finalFi.push(temp)
                        }else{
                            finalFi.push(tempFi[o])
                        }
                    }
                    
                    folders = folders.concat(doc.subFolders);
                    finalArr.push({type:'folder',doc:doc , 
                        subFiles: finalFi,
                        subFolders:tempFo
                    })
                }
            }
            var userDoc = await user.findOne({_id:linkDoc.generatedBy}).select('firstName lastName')

            res.status(200).send({finalArr:finalArr , linkDoc:linkDoc , user:userDoc});
        }catch(err){
            res.status(402).send(err);
            console.log(err)
        }
    })
    
router.get("/downloadFileFolders", verify, async (req, res) => {
    try {
        const selected = Array.isArray(req.query.selected) ? req.query.selected : [req.query.selected];
        
        // 1. Setup Archiver
        const archive = archiver('zip', { zlib: { level: 5 } }); // Level 5 is a good balance of speed/size
        const downloadName = `download-${uuidv4().substring(0, 8)}.zip`;

        // 2. Prepare headers
        res.attachment(downloadName);
        res.setHeader('Content-Type', 'application/zip');
        // Note: Content-Length is omitted because the zip size is unknown until finished.
        // We use a custom header for the total UNCOMPRESSED size to help the progress bar.
        let estimatedTotalSize = 0;

        // 3. Helper to gather all file/folder data recursively
        const getAllItems = async (items) => {
            let results = [];
            for (const item of items) {
                if (item.type === 'folder') {
                    const doc = await folder.findOne({ _id: item.id }).lean();
                    if (doc) {
                        results.push({ ...doc, type: 'folder' });
                        // Get children
                        const subItems = [
                            ...doc.subFolders.map(id => ({ id, type: 'folder' })),
                            ...doc.subFiles.map(id => ({ id, type: 'file' }))
                        ];
                        const children = await getAllItems(subItems);
                        results = results.concat(children);
                    }
                } else {
                    const doc = await file.findOne({ _id: item.id }).lean();
                    if (doc) {
                        results.push({ ...doc, type: 'file' });
                        estimatedTotalSize += (doc.metaData?.size || 0);
                    }
                }
            }
            return results;
        };

        // 4. Fetch the full structure
        const flatList = await getAllItems(selected);
        
        // Send the estimated size to the frontend for the progress bar
        res.setHeader('Access-Control-Expose-Headers', 'X-Total-Size');
        res.setHeader('X-Total-Size', estimatedTotalSize);

        // 5. Pipe the archive to the response
        archive.pipe(res);

        // 6. Build the Zip structure
        // We use a Map to keep track of folder paths to reconstruct the tree
        const folderPaths = new Map();

        for (const item of flatList) {
            if (item.type === 'folder') {
                // Determine the path within the zip
                let folderPath = item.name;
                if (item.supFolder && folderPaths.has(item.supFolder.toString())) {
                    folderPath = path.join(folderPaths.get(item.supFolder.toString()), item.name);
                }
                folderPaths.set(item._id.toString(), folderPath);
                
                // Add empty directory entry
                archive.append(null, { name: folderPath + '/' });
            } else {
                // It's a file
                let filePathInZip = item.metaData.filename;
                if (item.supFolder && folderPaths.has(item.supFolder.toString())) {
                    filePathInZip = path.join(folderPaths.get(item.supFolder.toString()), item.metaData.filename);
                }
                
                const fullSystemPath = path.join(__dirname, '../public/uploads/', item.metaData.filename);
                archive.file(fullSystemPath, { name: filePathInZip });
            }
        }

        // 7. Finalize
        archive.on('error', (err) => {
            console.error("Archive stream error:", err);
            if (!res.headersSent) {
                res.status(500).json({ message: "Failed to generate download" });
            } else {
                res.destroy(err);
            }
        });
        await archive.finalize();

    } catch (error) {
        console.error("Zip Stream Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ message: "Failed to generate download" });
        }
    }
});

      


    router.get('/files/download/:id', verify, async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid file id' });
            }

            const fileDoc = await file.findById(id);
            if (!fileDoc) {
            return res.status(404).json({ message: 'File not found' });
            }
           var metaData = 
           {
            originalname :fileDoc.metaData.originalname,
            mimetype:fileDoc.metaData.mimetype,
            path: fileDoc.metaData.path
           }

            // Normalize path for Windows/Linux
            const absolutePath = path.resolve(metaData.path);

            if (!fs.existsSync(absolutePath)) {
            return res.status(404).json({ message: 'File missing on disk' });
            }

            // 🔑 Critical headers
            res.setHeader('Content-Type',metaData.mimetype);
            res.setHeader(
            'Content-Disposition',
            `attachment; filename="${metaData.originalname}"`
            );

            // Stream file (memory safe)
            fs.createReadStream(absolutePath).pipe(res);
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: 'Download failed' });
        }
    });
    
module.exports = router;
