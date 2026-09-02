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
const { rateLimit } = require("./utils/rateLimit");

patchExpressRouter(express);

//express middlewear
const app = express();
var server = require('http').createServer(app);
// Production origins (launched 2026-07-12) + localhost for development.
const ALLOWED_ORIGINS = [
  'https://xms.lazulitemarble.com',
  'https://auth.lazulitemarble.com',
  'http://localhost:3000',            // local dev only
];
var io = require('socket.io')(server , {
    cors: {
      origin: ALLOWED_ORIGINS,
      credentials: true,
    },
  });
app.use(cors({exposedHeaders: ['Content-Disposition', 'X-Total-Size'], credentials: true, origin: ALLOWED_ORIGINS}));

//dotenv middlewear
dotenv.config();
//bodyParser middlewear
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Baseline security headers ────────────────────────────────────────────────
// Hand-rolled rather than pulling in `helmet`, matching the convention already
// used for authApi's OTP throttle/lockout (no new dependency for something this
// small). This API only ever returns JSON and static files — it serves no HTML
// UI of its own — so a very strict default is safe here and would NOT be
// appropriate on the frontend host.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');       // no MIME sniffing
  res.setHeader('X-Frame-Options', 'DENY');                 // no framing/clickjacking
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // HSTS only matters over TLS, and is set by the reverse proxy in production;
  // setting it here too is harmless and covers a direct-to-node deployment.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ── Static files — served, but never executable ──────────────────────────────
// public/ holds every module's uploads (public/uploads, plus public/files and
// public/zip) and is served from THIS origin, so an uploaded document that a
// browser will execute would be stored XSS on api.lazulitemarble.com.
// utils/uploadGuards.js blocks those at upload time; this is the second half of
// that defence, covering files uploaded BEFORE the filter existed and anything
// the filter misses. Applied to the single existing mount rather than adding a
// second one, so no file can be reached through an unhardened path.
//
// `default-src 'none'` + `sandbox` neuters active content without affecting how
// <img>/<video>/<audio> load the file, which is how the app actually consumes
// these. Anything that is not plain media (or a PDF, which the in-app viewer
// opens inline) is additionally forced to download rather than render.
// Keyed off the file EXTENSION, not res.getHeader('Content-Type') — inside
// express.static's setHeaders the Content-Type has not been applied yet, so
// reading it back returns '' and every file (images included) would be forced
// to download, breaking every <img> in the app.
const INLINE_SAFE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.mp4', '.webm', '.ogv', '.mov', '.m4v',
  '.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac',
  '.pdf',
]);
app.use(express.static('public', {
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
    const dot = String(filePath).lastIndexOf('.');
    const ext = dot < 0 ? '' : String(filePath).slice(dot).toLowerCase();
    if (!INLINE_SAFE_EXT.has(ext)) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  },
}));
app.use(cookieParser());

// ── Rate limiting ────────────────────────────────────────────────────────────
// Deliberately placed AFTER the static mount, so loading an inventory grid full
// of images never eats the API budget.
//
// The global cap is generous on purpose: a whole office typically shares one
// NAT'd IP, and this API is used with infinite-scroll lists and batch uploads.
// It is sized to stop a runaway client or a flood, NOT to be a per-user quota —
// setting it tight enough to be that would break normal use.
app.use(rateLimit({ name: 'global', windowMs: 60_000, max: 1000 }));

// The public, unauthenticated link-page resolver is the one route reachable
// with no credentials at all, so it gets its own much tighter budget — this is
// what stops someone brute-forcing page codes.
app.use('/digitalMarketing/public', rateLimit({ name: 'public', windowMs: 60_000, max: 60 }));

// ── Native file download ──────────────────────────────────────────────────────
// Streams a public/uploads file with `Content-Disposition: attachment` so the
// browser saves it with its OWN download manager (progress bar) instead of the
// frontend blob-fetching the whole file into memory first (no progress, opens a
// tab). Same public access level as the /uploads static mount it mirrors.
// basename() strips any path so `..%2f` traversal can't escape the folder.
const _path = require('path');
const _fs   = require('fs');
app.get('/download/:diskName', (req, res) => {
  const safe = _path.basename(String(req.params.diskName || ''));
  const filePath = _path.join(__dirname, 'public', 'uploads', safe);
  if (!safe || !_fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found' });
  const downloadName = req.query.name ? _path.basename(String(req.query.name)) : safe;
  res.download(filePath, downloadName, (err) => {
    if (err && !res.headersSent) res.status(500).json({ message: 'Download failed' });
  });
});

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

app.use('/digitalMarketing' , require('./routes/digitalMarketing/main') )
app.use('/tutorials' , require('./routes/tutorials/main') )
app.use('/shortlinks' , require('./routes/shortLinks/main') )
app.use('/ghost' , require('./routes/ghost/main') )
app.use('/uploads' , require('./routes/uploads/sessions') )
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



// ── Timeouts for large uploads ───────────────────────────────────────────────
// Node caps a single request at `requestTimeout` (default 5 min in Node 18+).
// A multi-GB raw video on a slow office uplink easily exceeds that and would be
// killed mid-transfer with a confusing socket error rather than a clear message.
// 0 disables the per-request cap; headersTimeout stays finite so a client that
// opens a socket and never sends headers is still reaped (slowloris).
//
// ⚠️ The reverse proxy in front of this API has its own timeouts
// (nginx proxy_read_timeout / proxy_send_timeout / client_body_timeout) — those
// must be raised too, or the proxy will cut the upload off before Node does.
server.requestTimeout = 0;
server.headersTimeout = 120_000;
server.keepAliveTimeout = 75_000;

// Port 7130 (changed from 3003 for the 2026-07-12 launch) — the reverse proxy
// maps https://api.lazulitemarble.com onto this local port.
server.listen(4789, async () => {
    console.log('server running on port 4789.');
    // On restart all socket connections are gone → mark everyone offline
    let userM = null;
    try {
        const userSchema   = require('./models/userModel');
        const dbConnection = require('./connections/xmsPr');
        userM = dbConnection.model('user', userSchema);
        await userM.updateMany({ isOnline: true }, { $set: { isOnline: false, lastSeen: new Date() } });
    } catch (_) {}

    // ── Ghost-session cleanup ────────────────────────────────────────────────
    // A ghost sandbox must never outlive its session. Closing the browser tells
    // the server nothing, and a crash can strand a whole cloned database, so
    // cleanup runs on boot (catching anything left by the previous process) and
    // then on a timer against each session's TTL. The in-app "exit ghost"
    // button is the fast path, not the only one.
    try {
        const { sweepGhostSessions } = require('./utils/ghost');
        const boot = await sweepGhostSessions('startupSweep');
        if (boot.endedCount || boot.orphanCount) {
            console.log(`Ghost cleanup on boot: ${boot.endedCount} expired session(s), ${boot.orphanCount} orphaned database(s) dropped.`);
        }
        const SWEEP_EVERY_MS = 5 * 60 * 1000;
        setInterval(() => {
            sweepGhostSessions('expired').catch(() => {});
        }, SWEEP_EVERY_MS).unref();   // must not hold the process open on shutdown
    } catch (err) {
        console.error('Ghost cleanup scheduler failed to start:', err && err.message);
    }

    // ── Upload Center cleanup ────────────────────────────────────────────────
    // A resumable upload that is never resumed (user closed the browser and
    // never came back, or cancelled while offline) leaves a .part file on
    // disk. Same shape as the ghost sweep above: reclaim on boot, then on a
    // timer, against each session's TTL.
    try {
        const { sweepUploadSessions } = require('./utils/resumableUpload');
        const boot = await sweepUploadSessions();
        if (boot.expired || boot.orphans) {
            console.log(`Upload cleanup on boot: ${boot.expired} expired session(s), ${boot.orphans} orphaned partial file(s) removed.`);
        }
        setInterval(() => {
            sweepUploadSessions().catch(() => {});
        }, 15 * 60 * 1000).unref();
    } catch (err) {
        console.error('Upload cleanup scheduler failed to start:', err && err.message);
    }

    if (!userM) return;   // the Telegram /start handler needs the User model too

    // ── Telegram bot — /start <code> completes the self-service link started
    // from "Connect Telegram" in My Profile (POST /users/me/telegram/link-code).
    // Independent of SMS/OTP auth; see utils/telegramBot.js + routes/users/users.js.
    const { startPolling, sendTelegramMessage } = require('./utils/telegramBot');
    startPolling(async (message) => {
        const text = (message.text || '').trim();
        if (!text.startsWith('/start')) return;

        const code = text.split(' ')[1];
        if (!code) {
            await sendTelegramMessage(message.chat.id,
                'Welcome to XMS! Open "Connect Telegram" in your XMS profile to get a linking code, then tap the link it gives you.');
            return;
        }

        const linkedUser = await userM.findOneAndUpdate(
            { 'telegram.pendingCode': code, 'telegram.pendingCodeExpiresAt': { $gt: new Date() }, deleteDate: null },
            { $set: {
                'telegram.chatId': String(message.chat.id),
                'telegram.username': message.from && message.from.username ? message.from.username : null,
                'telegram.linkedAt': new Date(),
                'telegram.pendingCode': null,
                'telegram.pendingCodeExpiresAt': null,
            } },
            { new: true }
        );

        if (linkedUser) {
            await sendTelegramMessage(message.chat.id,
                `✅ Connected! You'll now receive XMS notifications here${linkedUser.firstName ? ', ' + linkedUser.firstName : ''}.`);
        } else {
            await sendTelegramMessage(message.chat.id,
                'That linking code is invalid or has expired. Generate a new one from your XMS profile and try again.');
        }
    });
});

