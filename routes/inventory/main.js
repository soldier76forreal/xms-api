const express = require('express');
const mongoose = require('mongoose');
const jwt_decode = require('jwt-decode');
const notficationModel = require("../../models/notficationsModel");
const userModel = require("../../models/userModel");
const invoiceModel = require("../../models/invoiceModel");
const productModel = require("../../models/productModel");

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
const Product = dbConnection.model('Products' , productModel);

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
const { generateApiKey } = require('generate-api-key');
const jwt = require("jsonwebtoken");
const sizeOf = require('image-size')
var AdmZip = require("adm-zip");
var randomstring = require("randomstring");



const router = express.Router()


router.post("/products/root", verify, async (req, res) => {
    try {
        const { code, name, description } = req.body;
        console.log(name)
        // 1. Validate input
        if (!code || !name) {
            return res.status(400).json({
                message: "Product code and name are required"
            });
        }

        // 2. Check for duplicate product code
        const existing = await Product.findOne({ code: code.toUpperCase() });
        if (existing) {
            return res.status(409).json({
                message: "Product code already exists"
            });
        }

        // 3. Create root product
        const rootProduct = await Product.create({
            code: code.toUpperCase(),
            names:name,
            description,
            isRoot: true,
            parent: null,
            quantity: 0
        });

        // 4. Response
        return res.status(201).json({
            message: "Root product created successfully",
            data: rootProduct
        });

    } catch (error) {
        console.error("Create Root Product Error:", error);
        return res.status(500).json({
            message: "Failed to create root product"
        });
    }
});


router.post("/products/sub", verify, async (req, res) => {
  try {
    const {
      parentId,
      quality,
      dimensions,
      quantityAndPrice
    } = req.body;

    // ---------------- VALIDATION ----------------
    if (!parentId || !quality || !dimensions) {
      return res.status(400).json({
        message: "Parent product, quality and dimensions are required"
      });
    }

    if (!dimensions.width || !dimensions.height || !dimensions.thickness) {
      return res.status(400).json({
        message: "Width, height and thickness are required"
      });
    }

    if (!Array.isArray(quantityAndPrice) || quantityAndPrice.length === 0) {
      return res.status(400).json({
        message: "Quantity and price list is required"
      });
    }

    // ---------------- FIND ROOT ----------------
    const parentProduct = await Product.findById(parentId);

    if (!parentProduct || !parentProduct.isRoot) {
      return res.status(404).json({
        message: "Root product not found"
      });
    }

    // ---------------- CODE GENERATION ----------------
    const width = String(dimensions.width).padStart(3, "0");
    const height = String(dimensions.height).padStart(3, "0");
    const thickness = String(dimensions.thickness).padStart(2, "0");

    const subCode = `${parentProduct.code}${quality}${width}${height}${thickness}`;

    // ---------------- DUPLICATE CHECK ----------------
    const exists = await Product.findOne({ code: subCode });
    if (exists) {
      return res.status(409).json({
        message: "Sub product already exists"
      });
    }

    // ---------------- CREATE SUB PRODUCT ----------------
    const subProduct = await Product.create({
      code: subCode,
      parent: parentProduct._id,
      isRoot: false,
      quality,
      dimensions,
      quantityAndPrice,
      quantity: quantityAndPrice.reduce(
        (sum, q) => sum + Number(q.quantity || 0),
        0
      )
    });

    // ---------------- RESPONSE ----------------
    return res.status(201).json({
      message: "Sub product created successfully",
      data: subProduct
    });

  } catch (error) {
    console.error("Create Sub Product Error:", error);
    return res.status(500).json({
      message: "Failed to create sub product"
    });
  }
});


router.get("/products/root", verify, async (req, res) => {
    try {
        const roots = await Product.find({ isRoot: true, active: true })
            .sort({ createdAt: -1 });

        return res.status(200).json({
            data: roots
        });

    } catch (error) {
        console.error("Get Root Products Error:", error);
        return res.status(500).json({
            message: "Failed to retrieve root products"
        });
    }
});




router.get("/products/:rootId/sub", verify, async (req, res) => {
    try {
        const { rootId } = req.params;

        // 1. Validate root product
        const rootProduct = await Product.findById(rootId);
        if (!rootProduct || !rootProduct.isRoot) {
            return res.status(400).json({
                message: "Invalid root product"
            });
        }

        // 2. Get sub-products
        const subProducts = await Product.find({
            parent: rootId,
            active: true
        }).sort({
            quality: 1,
            "dimensions.width": 1,
            "dimensions.height": 1,
            "dimensions.thickness": 1
        });

        return res.status(200).json({
            root: rootProduct,
            data: subProducts
        });

    } catch (error) {
        console.error("Get Sub Products Error:", error);
        return res.status(500).json({
            message: "Failed to retrieve sub-products"
        });
    }
});




router.get("/products/code/:code", verify, async (req, res) => {
    try {
        const code = req.params.code.toUpperCase();

        const product = await Product.findOne({ code, active: true })
            .populate("parent", "code name");

        if (!product) {
            return res.status(404).json({
                message: "Product not found"
            });
        }

        return res.status(200).json({
            data: product
        });

    } catch (error) {
        console.error("Get Product By Code Error:", error);
        return res.status(500).json({
            message: "Failed to retrieve product"
        });
    }
});



router.get("/products/tree", verify, async (req, res) => {
  try {
    const products = await Product.aggregate([
      // 1️⃣ Get root products
      {
        $match: {
          isRoot: true,
          active: true
        }
      },

      // 2️⃣ Attach sub-products
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "parent",
          as: "children"
        }
      },

      // 3️⃣ Sort sub-products (optional)
      {
        $addFields: {
          children: {
            $sortArray: {
              input: "$children",
              sortBy: { code: 1 }
            }
          }
        }
      },

      // 4️⃣ Sort root products
      {
        $sort: { code: 1 }
      }
    ]);

    res.status(200).json({
      data: products
    });

  } catch (error) {
    console.error("Get Product Tree Error:", error);
    res.status(500).json({
      message: "Failed to retrieve products"
    });
  }
});




module.exports = router;