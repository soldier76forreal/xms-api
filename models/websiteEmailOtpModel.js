const mongoose = require('mongoose');

// Website-visitor email OTP — kept separate from customerModel.js on purpose
// (website-visitor auth mechanics shouldn't couple into CRM's core schema; a
// customer record can exist with no email-auth history at all, e.g. one
// entered by staff). Same shape/thresholds as userModel.js's `auth` block
// (5 failed verifies -> 2h lock), just keyed by email instead of phone and
// with its own send-throttle (mirrors the sms.ir throttle in authApi).
const websiteEmailOtpSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },

  otpHash:           { type: String, default: null },
  otpExpiresAt:      { type: Date,   default: null },
  otpLastSentAt:     { type: Date,   default: null },
  otpSendCount:      { type: Number, default: 0 },
  otpWindowStart:    { type: Date,   default: null },
  failedAttempts:    { type: Number, default: 0 },
  lockedUntil:       { type: Date,   default: null },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null },
});

module.exports = websiteEmailOtpSchema;
