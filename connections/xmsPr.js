const mongoose = require("mongoose");
const dotenv = require('dotenv')
const dbConnection = mongoose.createConnection(process.env.DB_CONNECT, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false 
});


module.exports = dbConnection;