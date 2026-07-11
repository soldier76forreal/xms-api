

const jwt = require("jsonwebtoken");

module.exports =function  (req , res , next){
    var token = req.headers.authorization;

    if(!token){
       return res.status(401).send('Not available');
    }else{
        
        token = token.split(" ")[1];
        try{
            const verified = jwt.verify(token , process.env.TOKEN_SECRET);
            req.user = verified;
            next();
        }catch(err){
          return  res.status(400).send("Invalid token");
        }
    }
}