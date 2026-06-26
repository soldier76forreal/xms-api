const express = require("express");
const bodyParser = require("body-parser");
const cookieParser = require('cookie-parser');
const cors = require('cors')
const mongoose = require("mongoose");
const multer  = require('multer')
const upload = multer({ dest: 'public/files' })
const webpush = require('web-push');
const dotenv = require("dotenv");
const crashLogger = require("./utils/crashLogger");
const { patchExpressRouter } = require("./utils/asyncRouteErrors");

patchExpressRouter(express);

//express middlewear
const app = express();
var server = require('http').createServer(app);
var io = require('socket.io')(server , {
    cors: {
      origin: ['https://lazulitemarble.com'],
      credentials: true,
    },
  });
// app.use(cors());
app.use(cors({exposedHeaders: ['Content-Disposition', 'X-Total-Size'],credentials: true, origin:['http://localhost:3000' , 'https://localhost:3002']}));

//dotenv middlewear
dotenv.config();
//bodyParser middlewear
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(cookieParser());

//webpush
// webpush.setVapidDetails("mailto:test@test.com" , JSON.stringify(process.env.PublicVapidKey) , JSON.stringify(process.env.PrivateVapidKey));

//routes
// app.use('/tagAndCategory' , require("./routes/controlPanel/categoryAndTags"));
// app.use('/upload' , require("./routes/controlPanel/uploadCenter"));
// // app.use('/oprators' , require("./routes/controlPanel/oprators"));
// // app.use('/newProduct' , require("./routes/controlPanel/newProduct"));
// app.use('/tests' , require("./routes/controlPanel/tests"));
// app.use('/users' , require("./routes/controlPanel/users"));
// app.use('/blog' , require("./routes/controlPanel/blogPost"));
app.use('/crm' , require("./routes/crm/customer"));
app.use('/filter' , require("./routes/filters"));

app.use('/mis' , require('./routes/mis/invoice') )
app.use('/notfication' , require('./routes/socket/xmsNotifications')(io))
app.use('/users' , require('./routes/users/users') )

app.use('/files' , require('./routes/fileManager/main') )
app.use('/uploadFiles' , require('./routes/fileManager/uploadFile') )

app.use('/jobReport' , require("./routes/jobReport/main"));
// app.use('/findCourse' , require("./routes/controlPanel/findCourse"));

app.use((err, req, res, next) => {
    const crashId = crashLogger.logError(err, {
        type: "requestError",
        request: crashLogger.getRequestContext(req)
    });

    console.error(`Request error logged: ${crashId}`, err);

    if (res.headersSent) {
        return next(err);
    }

    return res.status(err.status || 500).json({
        message: "Internal server error",
        crashId
    });
});

process.on("unhandledRejection", (reason) => {
    const crashId = crashLogger.logError(reason, {
        type: "unhandledRejection"
    });

    console.error(`Unhandled rejection logged: ${crashId}`, reason);
});

process.on("uncaughtException", (error) => {
    const crashId = crashLogger.logError(error, {
        type: "uncaughtException"
    });

    console.error(`Uncaught exception logged: ${crashId}`, error);
});



server.listen(3003 , connect =>{
    console.log("server running on port 3001.");
})

