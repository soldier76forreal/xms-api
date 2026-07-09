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
// LAN IPs added for phone/device testing (Ethernet 192.168.1.135, Wi-Fi 192.168.1.132) —
// the old 10.185.103.82 entry was a VPN adapter address, unreachable from other devices.
var io = require('socket.io')(server , {
    cors: {
      origin: ['https://lazulitemarble.com', 'http://localhost:3000', 'https://xms.lazulitemarble.com', 'http://192.168.1.135:3000', 'http://192.168.1.132:3000'],
      credentials: true,
    },
  });
// app.use(cors());
app.use(cors({exposedHeaders: ['Content-Disposition', 'X-Total-Size'],credentials: true, origin:['http://localhost:3000' , 'https://localhost:3002', 'http://192.168.1.135:3000', 'http://192.168.1.132:3000']}));

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

// Legacy MIS invoice routes (/mis/newPreInvoice, /mis/getInvoices) — still used by
// the Project Manager module (newProject.js) until it is rebuilt in Phase 6 / Session 50.
// Retire this line once Project Manager migrates to the new invoice system.
app.use('/mis' , require('./routes/mis/invoice') )
// New MIS / Invoices routes (Phase 6 rebuild — built out in Sessions 41–43).
app.use('/mis' , require('./routes/mis/invoices') )
app.use('/notfication' , require('./routes/socket/xmsNotifications')(io))
app.use('/users'         , require('./routes/users/users') )
app.use('/roles'         , require('./routes/rbac/roles') )
app.use('/groups'        , require('./routes/rbac/groups') )
app.use('/permissions'   , require('./routes/rbac/permissions') )
app.use('/branches'      , require('./routes/rbac/branches') )
app.use('/notifications' , require('./routes/notifications/notifications') )
app.use('/tasks'         , require('./routes/tasks/tasks') )

app.use('/files' , require('./routes/fileManager/main') )
app.use('/inventory' , require('./routes/inventory/main') )
app.use('/inventory/categories' , require('./routes/inventory/categories') )

app.use('/uploadFiles' , require('./routes/fileManager/uploadFile') )

app.use('/jobReport' , require("./routes/jobReport/main"));
app.use('/digitalMarketing' , require('./routes/digitalMarketing/main') )
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



server.listen(3003, async () => {
    console.log('server running on port 3003.');
    // On restart all socket connections are gone → mark everyone offline
    try {
        const userSchema   = require('./models/userModel');
        const dbConnection = require('./connections/xmsPr');
        const userM        = dbConnection.model('user', userSchema);
        await userM.updateMany({ isOnline: true }, { $set: { isOnline: false, lastSeen: new Date() } });
    } catch (_) {}
});

