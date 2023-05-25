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

  var onlineUsers=[];

  var returnRouter = function(io) {


    return router;
  }
  
  module.exports = returnRouter;