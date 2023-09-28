

const jwt = require("jsonwebtoken");
const linkModel = require("../../models/linkModel");
const dbConnection = require("../../connections/xmsPr");

const link = dbConnection.model('link' , linkModel);
const getSecret = async(token) =>{
    return await link.findOne({token:token.split(" ")[1]})
}
module.exports = async (req , res , next)=>{
    var token = req.headers.authorization;
    var secret = await getSecret(token)
    if(!token){
       return res.status(401).send('not accessible!');
    }else{
        token = token.split(" ")[1];
        try{
            const verified = jwt.verify(token , secret.secret);
            req.user = verified;
            next();
        }catch(err){
          return  res.status(400).send("not valid!");
        }
    }
}