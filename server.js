const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require('cookie-parser');
const cors = require('cors')
const mongoose = require("mongoose");
const multer  = require('multer')
const upload = multer({ dest: 'public/files' })
const dotenv = require("dotenv");

//express middlewear
const app = express();

// app.use(cors());
app.use(cors({credentials: true, origin:['http://localhost:3000' , 'http://127.0.0.1:5500']}));
//dotenv middlewear
dotenv.config();
//bodyParser middlewear
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(cookieParser());



//routes
// app.use('/tagAndCategory' , require("./routes/controlPanel/categoryAndTags"));
// app.use('/upload' , require("./routes/controlPanel/uploadCenter"));
// // app.use('/oprators' , require("./routes/controlPanel/oprators"));
// // app.use('/newProduct' , require("./routes/controlPanel/newProduct"));
// app.use('/tests' , require("./routes/controlPanel/tests"));
// app.use('/users' , require("./routes/controlPanel/users"));
// app.use('/blog' , require("./routes/controlPanel/blogPost"));
app.use('/crm' , require("./routes/crm/customer"));
app.use('/mis' , require('./routes/mis/invoice') )


// app.use('/comment' , require("./routes/controlPanel/comment"));
// app.use('/findCourse' , require("./routes/controlPanel/findCourse"));
app.use('/auth' , require("./routes/users/auth"));



app.listen(3001 , connect =>{
    console.log("server running on port 3001.");
})