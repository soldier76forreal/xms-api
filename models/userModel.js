const mongoose = require('mongoose');

var jobReportSchema = new mongoose.Schema({
  status:        { type: String },
  calenderDate:  { type: Date, unique: true, sparse: true },
  reportContent: [{ title: '', explanation: '' }],
  files:         { type: Array },
  lock:          { type: Boolean },
  updateDate:    { type: Date },
  insertDate:    { type: Date, default: Date.now },
  logsStatus:    { status: { type: String }, msg: { type: String } },
  logs:          [mongoose.Mixed],
});

var jobReportPresets = new mongoose.Schema({
  title:       { type: String },
  explanation: { type: String },
  updateDate:  { type: Date },
  insertDate:  { type: Date, default: Date.now },
  logsStatus:  { status: { type: String }, msg: { type: String } },
  logs:        [mongoose.Mixed],
});

const userSchema = new mongoose.Schema({
  // ── Identity ──────────────────────────────────────────────────────────────
  firstName:   { type: String, require: true, min: 1,  max: 50   },
  lastName:    { type: String, require: true, min: 1,  max: 50   },
  phoneNumber: { type: String, require: true, unique: true       },

  // ── Deprecated auth fields (kept for migration) ───────────────────────────
  password:     { type: String, min: 8, max: 1024 },  // deprecated — OTP replaces this
  oldPasswords: { type: Array },                        // deprecated
  passwordReset:{ type: Array },                        // deprecated

  // ── OTP / login security (Phase 4) ────────────────────────────────────────
  auth: {
    otpHash:           { type: String, default: null },  // bcrypt(otp)
    otpExpiresAt:      { type: Date,   default: null },  // now + 3 min
    otpLastSentAt:     { type: Date,   default: null },  // last SMS send time
    otpSendCount:      { type: Number, default: 0    },  // sends in current window
    otpWindowStart:    { type: Date,   default: null },  // start of send-throttle window
    failedOtpAttempts: { type: Number, default: 0    },  // wrong-code counter
    lockedUntil:       { type: Date,   default: null },  // 5 fails → now + 2h
  },

  // ── Presence (Phase 4 — updated by Socket.io) ─────────────────────────────
  isOnline: { type: Boolean, default: false },
  lastSeen: { type: Date,    default: null  },

  // ── Web-push notification preferences (per type; all default ON) ──────────
  // Gates ONLY the browser push; the in-app notification + socket event always
  // fire. Missing/undefined categories are treated as enabled (opt-out model).
  notificationPrefs: {
    tasks:         { type: Boolean, default: true },
    assignments:   { type: Boolean, default: true },
    invoices:      { type: Boolean, default: true },
    dmChat:        { type: Boolean, default: true },
    readyToUpload: { type: Boolean, default: true },
  },

  // ── Access (deprecated — replaced by userAccess RBAC collection) ──────────
  validation: { type: Boolean, require: true },
  access:     [],

  // ── Profile ───────────────────────────────────────────────────────────────
  profileImage:  { type: Object },
  // Persisted UI language — mirrors the frontend's LANGUAGES codes
  // (xms/src/i18n/index.js). Written from the language switcher so it's
  // visible to others (Users section indicator), not just this browser's
  // localStorage. Defaulted so pre-existing users read as 'en' (the app's
  // own default) rather than null.
  language:      { type: String, enum: ['en', 'fa', 'ar'], default: 'en' },
  countryCode:   { type: String, default: null },  // e.g. '+98', '+971'
  city:          { type: String },
  State:        { type: String },
  postalCode:   { type: String },
  address:      { type: String },

  // ── Telegram notification delivery (self-service link via /start <code>) ──
  // Independent of the SMS/OTP auth system — a separate delivery channel that
  // mirrors the existing in-app notification events (see sendNotificationToUser
  // in routes/socket/xmsNotifications.js).
  telegram: {
    chatId:               { type: String, default: null },  // set once /start <code> is received
    username:             { type: String, default: null },  // their Telegram @username, informational only
    linkedAt:             { type: Date,   default: null },
    pendingCode:          { type: String, default: null },  // one-time code shown in the "Connect Telegram" UI
    pendingCodeExpiresAt: { type: Date,   default: null },  // 10 min from generation
    // ON/OFF for delivery WITHOUT unlinking the account — separate from being
    // linked at all (chatId set). Checked by sendTelegramNotification.
    enabled:              { type: Boolean, default: true },
  },
  // ON/OFF for web-push delivery, independent of browser permission — that's
  // whether the BROWSER allows it (Notification.permission); this is whether
  // the backend should even try. Checked by sendWebPush.
  pushEnabled: { type: Boolean, default: true },

  // ── WhatsApp Business Cloud API — per-user connected number ────────────────
  // Admin-provisioned, NOT self-service like Telegram: a phone_number_id only
  // exists once that number is registered under the company's WABA in Meta
  // Business Manager (an admin-only action outside this app) — an admin
  // pastes the resulting id here to associate it with this XMS user. Read by
  // the separate whatsappApi/ service to route incoming messages to the
  // right user's CRM view.
  whatsapp: {
    phoneNumberId: { type: String, default: null },   // Meta's phone_number_id for this user's connected number
    displayNumber: { type: String, default: null },   // the actual WhatsApp number, for display only
    connectedAt:   { type: Date,   default: null },
    connectedBy:   { type: mongoose.Schema.Types.ObjectId, default: null },  // which admin set this up
  },
  // Governs how much autonomy the WhatsApp CRM agent has for THIS user's
  // conversations: 'review' = the agent still writes communication-log
  // entries automatically (low-risk audit trail), but a proposed new customer
  // or a customer detail change waits for this user to approve it; 'automatic'
  // = the agent applies both directly. Defaults to the safer option — a user
  // opts INTO full autonomy, not the other way around.
  crmAgentMode: { type: String, enum: ['review', 'automatic'], default: 'review' },

  // ── Job Report (xmsApi-specific embedded data) ────────────────────────────
  jobReport:        [jobReportSchema],
  jobReportPresets: [jobReportPresets],

  // ── Misc ──────────────────────────────────────────────────────────────────
  recivedRequests: [{
    from:       { type: mongoose.Schema.Types.ObjectId },
    deleteDate: { type: Date, default: null },
    date:       { type: Date },
    document:   { type: mongoose.Schema.Types.ObjectId },
  }],
  products:  { type: Array },
  savedPost: { type: Array },
  filterMemory: {
    crm: {
      sort:   { type: String, default: null },
      order:  { type: String, default: null },    // Phase 5: 'asc' | 'desc'
      filter: { type: mongoose.Schema.Types.Mixed, default: {} },  // Phase 5: flexible shape
    },
    mis: {
      sort:   { type: String, default: null },
      order:  { type: String, default: null },    // Phase 6: 'asc' | 'desc'
      // Phase 6: flexible shape { docType, status, customerId, dateRange } —
      // same Mixed pattern as filterMemory.crm (Session 33); old stored keys
      // (requestType/sentTo/sentBy) still read fine through Mixed.
      filter: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
  },

  insertDate: { type: Date, default: Date.now },
  updateDate: { type: Date, default: null     },
  deleteDate: { type: Date, default: null     },
});

module.exports = userSchema;
