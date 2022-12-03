const express = require('express');
const mongoose = require("mongoose");
const multer = require('multer');
const bcrypt = require("bcryptjs");
const nodemailer = require('nodemailer');
const userModel = require('../../models/userModel');
const jwt = require('jsonwebtoken'); 
const dbConnection = require('../../connections/xmsPr');
const smtpTransport = require('nodemailer-smtp-transport');
const router = express.Router();
const transporter = nodemailer.createTransport(smtpTransport({
  host:'mail.lazulitemarble.com',
  secureConnection: false,
  tls: {
    rejectUnauthorized: false
  },
  port: 465,
  auth: {
      user: process.env.EMAIL_SEND_SESSION,
      pass: process.env.EMAIL_SEND_PASSWORD,
}
}));

let refreshTokens = [];
let refreshTokensForMain = [];
const url = 'http://localhost:3000'
const userM = dbConnection.model("user" ,userModel);

//VALIDATION

const joi = require("joi");
const schema =joi.object({
    firstName : joi.string().min(1).required(),
    lastName : joi.string().min(1).required(),
    // phoneNumber : joi.string().min(6).required().email().error(errors => {
    //     errors.forEach(err => {
    //       switch (err.code) {
    //         case "any.empty":
    //           err.message = "شماره تلفن را وارد کنید";
    //           break;
    //         default:"شماره تلفن معتبر نیست"
    //           break;
    //       }
    //     });
    //     return errors;
    //   }),
    password : joi.string().regex(/(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).*/).min(8).required().error(errors => {
        errors.forEach(err => {
          switch (err.code) {
            case "any.empty":
                err.message = "کلمه عبور معتبر نیست";
                break;
            case "string.pattern.base":
                err.message = "کلمه عبور باید دارای حروف بزرگ و عدد باشد";
                break;
            case "string.min":
                err.message = `رمز عبور باید حداقل ${err.local.limit} کاراکتر باشد`; 
            default:"ایمیل معتبر نیست"
              break;
          }
        });
        return errors;
      })
})


//password checker
const passwordChecker =joi.object({
  password : joi.string().regex(/(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).*/).min(8).required().error(errors => {
      errors.forEach(err => {
        switch (err.code) {
          case "any.empty":
              err.message = "کلمه عبور معتبر نیست";
              break;
          case "string.pattern.base":
              err.message = "کلمه عبور باید دارای حروف بزرگ و عدد باشد";
              break;
          case "string.min":
              err.message = `رمز عبور باید حداقل ${err.local.limit} کاراکتر باشد`; 
          default:"کلمه عبور معتبر نیست"
            break;
        }
      });
      return errors;
    })

})


const loginSchema = joi.object({
  email : joi.string().min(6).required().email().error(errors => {
    errors.forEach(err => {
      switch (err.code) {
        case "any.empty":
          err.message = "ایمیل معتبر نیست";
          break;
        case "string.min":
          err.message = `ایمیل معتبر نیست`;
          break;
        case "string.email":
          err.message = `ایمیل معتبر نیست`;
          break;
        default:"ایمیل معتبر نیست"
          break;
      }
    });
    return errors;
  })
})




//auth routes
router.post("/register" , async(req,res)=>{
    // validate infor before sending to data base
          // const error =  schema.validate(req.body);
          // if(error.error){
          //   res.status(400).send(error.error.details[0].message);
          // }else{
            const existingPhoneNumber = await userM.findOne({phoneNumber:req.body.phoneNumber});
            if(existingPhoneNumber){
                res.status(400).send("شماره تلفن تکراری است");
            }else{
                  
                
                //hash password
                const salt = await bcrypt.genSalt(10);
                const hashPassword = await bcrypt.hash(req.body.password , salt);
                const newUser = new userM({
                    firstName : req.body.firstName,
                    lastName : req.body.lastName,
                    phoneNumber : req.body.phoneNumber,
                    password : hashPassword,
                    validation : false,
                    access: req.body.access
                })
                try{
                    const saveUser = await newUser.save();
                    res.send(200);
                }catch(err){
                    res.status(400).send(err);
                }
          }
        // }
    
})

router.post("/registerMainPage" , async(req,res , next)=>{
  // validate infor before sending to data base
  const error =  schema.validate(req.body);
  if(error.error){
     res.status(400).send(error.error.details[0].message);
     next()
  }else{
              const existEmail = await userM.findOne({email:req.body.email});
            if(existEmail){
                res.status(400).send("ایمیل تکراری است");
                res.end();
                next()
            }else{
              //hash password
              const salt = await bcrypt.genSalt(10);
              const hashPassword = await bcrypt.hash(req.body.password , salt);
              const newUser = new userM({
                  firstName : req.body.firstName,
                  lastName : req.body.lastName,
                  email : req.body.email,
                  password : hashPassword,
                  validation : true,
                  role: "user"
              })
          
              try{
                  const saveUser = await newUser.save();
                  const user = await userM.findOne({email:req.body.email});
                  //check if password is correct
                  const validPassword = await bcrypt.compare(req.body.password , user.password);
                  //creat and assign a token
                  if(user.role === 'user' && user.validation === true){
                    if(req.body.email !== '' && req.body.password !== ''){
                      const user = await userM.findOne({email:req.body.email});
                      if(!user){
                          res.status(400).send("ایمیل یا کلمه عبور اشتباه است");
                          res.end();
                          next()
                      }else{
                              //check if password is correct
                          const validPassword = await bcrypt.compare(req.body.password , user.password);
                          if(!validPassword) {
                              res.status(400).send("ایمیل یا کلمه عبور اشتباه است");
                              res.end();
                              next()
                          }else{
                            if(user.role === 'user' || user.role === 'admin' || user.role === 'superAdmin' && user.validation === true){
                              //creat and assign a token
                              let accessToken = jwt.sign({id:user._id , firstName:user.firstName , profileImage:user.profileImage , lastName:user.lastName , role:user.role} , process.env.TOKEN_SECRETFORMAIN , {expiresIn : '3m'} );
                              let refreshToken = jwt.sign({id:user._id , firstName:user.firstName , profileImage:user.profileImage , lastName:user.lastName , role:user.role} , process.env.TOKEN_SECRET_REFFORMAIN , {expiresIn : '6h'});
                              refreshTokensForMain.push(refreshToken);
                              return res.status(200).cookie('refreshToken' , refreshToken , {
                                sameSite:'strict',
                                path:'/',
                                secure:true,
                                expires:new Date(new Date().getTime() + process.env.EXPIRE_TOKEN),
                                httpOnly:true
                              }).send({
                                accessToken
                              })
                              res.end();

                              next()

                              // const token = jwt.sign({id:user._id , firstName:user.firstName , profileImage:user.profileImage , lastName:user.lastName , role:user.role} , process.env.TOKEN_SECRET);
                              // res.header("auth_token" , token ).send(token);
                              }else{
                                res.status(401).send("خطا!");
                                res.end();

                                next()

                              }
                          }
                      }
                  }else{
                    res.status(400).send("ایمیل یا کلمه عبورو وارد نکردید");
                    next()
                  }
                }else{
                  res.status(401).send("عدم دسترسی");
                    next()
                }
              }catch(err){
                  res.status(400).send(err);
                  console.log(err)
                  
              }
          }
  }
})

router.post("/login" , async(req,res)=>{
    //check if email is correct
  if(req.body.phoneNumber !== '' && req.body.password !== ''){
      const user = await userM.findOne({phoneNumber:req.body.phoneNumber});
      
      if(!user){
          res.status(400).send("شماره تلفن یا کلمه عبور اشتباه است");
      }else{
              //check if password is correct
          const validPassword = await bcrypt.compare(req.body.password , user.password);
          if(!validPassword) {
              res.status(400).send("شماره تلفن یا کلمه عبور اشتباه است");
          }else{
            if(user.validation === true){
              //creat and assign a token
              let accessToken = jwt.sign({id:user._id , firstName:user.firstName , profileImage:user.profileImage , lastName:user.lastName , access:user.access} , process.env.TOKEN_SECRET , {expiresIn : '3m'} );
              let refreshToken = jwt.sign({id:user._id , firstName:user.firstName , profileImage:user.profileImage , lastName:user.lastName , access:user.access} , process.env.TOKEN_SECRET_REF , {expiresIn : '180d'});
              refreshTokens.push(refreshToken);
              return res.status(200).cookie('refreshToken' , refreshToken , {
                sameSite:'strict',
                path:'/',
                secure:true,
                expires:new Date(new Date().getTime() + 4320*60*60*1000),
                httpOnly:true
              }).send({
                accessToken
              })
              // const token = jwt.sign({id:user._id , firstName:user.firstName , profileImage:user.profileImage , lastName:user.lastName , role:user.role} , process.env.TOKEN_SECRET);
              // res.header("auth_token" , token ).send(token);
              }else{
                res.status(401).send("عدم دسترسی");
              }
          }
      }


  }else{
    res.status(400).send("شماره تلفن یا کلمه عبورو وارد نکردید");

  }
})

router.post("/loginForMain" , async(req,res)=>{
  //check if email is correct
if(req.body.email !== '' && req.body.password !== ''){
    const user = await userM.findOne({email:req.body.email});
    if(!user){
        res.status(400).send("ایمیل یا کلمه عبور اشتباه است");
    }else{
            //check if password is correct
        const validPassword = await bcrypt.compare(req.body.password , user.password);
        if(!validPassword) {
            res.status(400).send("ایمیل یا کلمه عبور اشتباه است");
        }else{
          if(user.role === 'user' , user.role === 'admin' || user.role === 'superAdmin' && user.validation === true){
            //creat and assign a token
            let accessToken = jwt.sign({id:user._id , firstName:user.firstName , profileImage:user.profileImage , lastName:user.lastName , role:user.role} , process.env.TOKEN_SECRETFORMAIN , {expiresIn : '10s'} );
            let refreshToken = jwt.sign({id:user._id , firstName:user.firstName , profileImage:user.profileImage , lastName:user.lastName , role:user.role} , process.env.TOKEN_SECRET_REFFORMAIN , {expiresIn : '6h'});
            refreshTokensForMain.push(refreshToken);
            return res.status(200).cookie('refreshToken' , refreshToken , {
              sameSite:'strict',
              path:'/',
              secure:true,
              expires:new Date(new Date().getTime() + process.env.EXPIRE_TOKEN),
              httpOnly:true
            }).send({
              accessToken
            })
            // const token = jwt.sign({id:user._id , firstName:user.firstName , profileImage:user.profileImage , lastName:user.lastName , role:user.role} , process.env.TOKEN_SECRET);
            // res.header("auth_token" , token ).send(token);
            }else{
              res.status(401).send("عدم دسترسی");
            }
        }
    }
}else{
  res.status(400).send("ایمیل یا کلمه عبورو وارد نکردید");
}
})


router.post('/refreshToken' , (req , res)=>{
  if(!req.cookies.refreshToken || !refreshTokens.includes(req.cookies.refreshToken)){
    return res.status(401).send('در دسترس نیست');
 }else{ 
        jwt.verify(req.cookies.refreshToken , process.env.TOKEN_SECRET_REF , (error ,user) =>{
          if(!error){ 
            const accessToken = jwt.sign({id:user.id , firstName:user.firstName , profileImage:user.profileImage , lastName:user.lastName , role:user.role} ,process.env.TOKEN_SECRET ,{expiresIn:'3m'});
            return res.status(200).send({accessToken:accessToken});
          }else{
            return res.status(401).send('در دسترس نیست');
          }
        });     
 }

});

router.post('/refreshTokenForMain' , (req , res)=>{
  if(!req.cookies.refreshToken || !refreshTokensForMain.includes(req.cookies.refreshToken)){
    return res.status(401).send('در دسترس نیست');
 }else{ 
        jwt.verify(req.cookies.refreshToken , process.env.TOKEN_SECRET_REFFORMAIN , (error ,user) =>{
          if(!error){ 
            const accessToken = jwt.sign({id:user.id , firstName:user.firstName , profileImage:user.profileImage , lastName:user.lastName , role:user.role} ,process.env.TOKEN_SECRETFORMAIN ,{expiresIn:'3m'});
            return res.status(200).send({accessToken:accessToken});
          }else{
            return res.status(401).send('در دسترس نیست');
          }
        });     
 }

});


router.post('/deleteRefreshToken' , (req , res)=>{
  res.status(200).clearCookie('refreshToken').send("refresh cookie cleared!");

});


router.post('/forgetPassword' , async(req , res , next)=>{
  if(req.body.email !== ''){
    const user = await userM.findOne({email:req.body.email });
    if(!user){
        res.status(400).send("ایمیل معتبر نیست");
    }else{
      const oneTimeSecret = process.env.TOKEN_SECRET_RESETPASSWORD + user.password;
      const payload = {
        email: req.body.email,
        id:user._id
      }
      const token = jwt.sign(payload , oneTimeSecret , {expiresIn:'15m'});
      const link = `${url}/resetPassword/${user._id}/${token}`;
      transporter.sendMail(
        {
          from:"noreply@lazulitemarble.com",
          to:req.body.email,
          subject:'بازیابی کلمه عبور',
          text:link,
          html:
          `
            <div style="max-width: 800px;">
              <div style="text-align: center;">
                  <img style="max-width: 190px; text-align: center;" src="../../public/files/logoSam.png">
              </div>
              <div style="text-align: center; font-size: 24px;">
                  <h5 style="margin: 20px 0px 30px 0px; padding: 0px; color:rgb(61, 61, 61);">بازیابی کلمه عبور</h5>
              </div>
              <hr style="opacity: 0.5;">
              <div dir="rtl" style="padding: 0px 20px 0px 20px; text-align: right;">
                  <h5 style="font-size: 15px; color:rgb(61, 61, 61);">
                      کاربر گرامی: ${req.body.email}
                  </h5>
                  <h5 style="font-size: 15px; color:rgb(61, 61, 61);">
                      سلام
                  </h5>
                  <h5 style="font-size: 15px; color:rgb(61, 61, 61);">
                      این ایمیل به درخواست شما برای بازیابی کلمه عبور در لازولیت ماربل برای شما ارسال شده است.
                  </h5>
                  <h5 style="font-size: 15px; color:rgb(61, 61, 61);">
                      برای تغییر کلمه عبور لینک زیر را باز کنید:        
                  </h5>
                  <h5 style="font-size: 15px; color:rgb(61, 61, 61);">
                      لطفاً توجه داشته باشید، این لینک پس از 15 دقیقه منقضی خواهد شد.        
                  </h5>
              </div>
              <div style="width: 100%; margin: 30px 0px 0px 0px; text-align: center;">
                  <a href=${link} style="color:rgb(226, 226, 226); background-color: #354063; padding: 10px 8px 10px 8px; border-radius: 8px; font-weight: 700;">
                      بازیابی کلمه عبور 
                  </a>
              </div>
          </div>
          `
        },
        (err , info)=>{
          if(err){
            console.log(err);
            return
          }
          console.log("send" + info.response);
        }
      )
      res.status(200).send(link);
    }
  }else{
    res.status(400).send("ایمیل را وارد کنید");
  }

})
router.get("/resetPassword" , async(req , res)=>{
  const {id , token} = req.query
      const user = await userM.findOne({_id:id});
      if(!user){
          res.status(400).send("کاربر موجود نیست");
      }else{
        try{
          const oneTimeSecret = process.env.TOKEN_SECRET_RESETPASSWORD + user.password;
          const payload = jwt.verify(token , oneTimeSecret);
          res.status(200).send('success');
        }catch{
          res.status(403).send('لینک باطل شده است');
        }

      }
    
})
router.post("/updatePassword" , async(req , res)=>{
  const {id , token , password} = req.body;
  const pass= {password:req.body.password};
  const error =  passwordChecker.validate(pass);
  if(error.error){
    console.log(error.error);
     res.status(400).send(error.error.details[0].message);
  }else{
    const user = await userM.findOne({_id:id});
    const hashedPassword  = user.password;
    if(!user){
        res.status(400).send("خطا");
    }else{
      try{
        const oneTimeSecret = process.env.TOKEN_SECRET_RESETPASSWORD + user.password;
        const payload = jwt.verify(token , oneTimeSecret);
  
        const validPassword = await bcrypt.compare(password , user.password);
        if(validPassword === true){
          res.status(403).send('کلمه عبور تکراری است');
        }else if(validPassword === false){
          const salt = await bcrypt.genSalt(10);
          const hashPassword = await bcrypt.hash(password , salt);
          const response =await userM.updateOne({_id:id} , {password:hashPassword ,$push: { oldPasswords: hashedPassword}});
          res.status(200).send("کلمه عبور بروز شد");
        }
      }catch(err){
        res.status(403).send('لینک باطل شده است');
      }
  
    }
  } 

})


//get all users
router.get("/getAllUsers" ,async(req , res)=>{
  try{
      const length = await userM.countDocuments({deleteDate:null});
      // const result = await userM.find({deleteDate:null}).select('firstName , lastName , validation , role , insertDate , profileImage' , );        
       const result = await userM.find({deleteDate:null});        

      res.status(200).send(JSON.stringify({ln:length , rs:result})); 
  }catch(err){
      res.status(500).send("مشکلی رخ داده است");
  }
  
});



module.exports = router;