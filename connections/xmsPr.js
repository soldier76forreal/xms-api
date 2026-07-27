const mongoose = require("mongoose");
const dotenv = require('dotenv')
const crashLogger = require('../utils/crashLogger');
// useNewUrlParser/useUnifiedTopology/useFindAndModify are gone in Mongoose 6+
// (the driver always behaves as if they were true / findOneAndUpdate is native).
// strictQuery pinned explicitly to 'false' — that was Mongoose 5's actual
// default (queries may reference fields not in the schema); Mongoose 6.0.10+
// changed the default to 'true' (Mongoose 7 reverted it back to 'false'), so
// this line exists purely to keep behavior identical across that in-between window.
mongoose.set('strictQuery', false);
const dbConnection = mongoose.createConnection(process.env.DB_CONNECT);

// A Mongoose Connection is an EventEmitter — with no 'error' listener, a
// post-connect DB error (network blip, Atlas failover, auth expiry) throws as
// an unhandled exception and can take the whole process down with nothing
// logged. This is the single most important handler in this file: it's what
// stands between "brief DB hiccup" and "silent full outage."
dbConnection.on('error', (err) => {
  const crashId = crashLogger.logError(err, { type: 'mongoConnectionError' });
  console.error(`MongoDB connection error logged: ${crashId}`, err);
});
dbConnection.on('disconnected', () => {
  console.error('MongoDB connection lost — mongoose will keep retrying automatically.');
});
dbConnection.on('reconnected', () => {
  console.log('MongoDB connection restored.');
});

module.exports = dbConnection;