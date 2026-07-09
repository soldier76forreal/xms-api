const mongoose = require("mongoose");
const dotenv = require('dotenv')
// useNewUrlParser/useUnifiedTopology/useFindAndModify are gone in Mongoose 6+
// (the driver always behaves as if they were true / findOneAndUpdate is native).
// strictQuery pinned explicitly to 'false' — that was Mongoose 5's actual
// default (queries may reference fields not in the schema); Mongoose 6.0.10+
// changed the default to 'true' (Mongoose 7 reverted it back to 'false'), so
// this line exists purely to keep behavior identical across that in-between window.
mongoose.set('strictQuery', false);
const dbConnection = mongoose.createConnection(process.env.DB_CONNECT);


module.exports = dbConnection;