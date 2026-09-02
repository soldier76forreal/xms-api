const express              = require('express');
const mongoose             = require('mongoose');
const jwt_decode           = require('jwt-decode');
const notficationModel     = require('../../models/notficationsModel');
const notificationModel    = require('../../models/notificationModel');
const userModel            = require('../../models/userModel');
const invoiceModel         = require('../../models/invoiceModel');
const verify               = require('../users/verifyToken');
const pwaSubscriptionModel = require('../../models/pwaSubscriptionModel');
const dotenv               = require('dotenv');
dotenv.config();

const multer = require('multer');
const { blockExecutableFiles, uploadLimits } = require('../../utils/uploadGuards');
const dbConnection = require('../../connections/xmsPr');
const crashLogger = require('../../utils/crashLogger');

const userM           = dbConnection.model('user',            userModel);
const invoice         = dbConnection.model('invoice',         invoiceModel);
const notfication     = dbConnection.model('notfication',     notficationModel);
const Notification    = dbConnection.model('notification',    notificationModel);
const pwaSubscription = dbConnection.model('pwaSubscription', pwaSubscriptionModel);

const webpush = require('web-push');
webpush.setVapidDetails('mailto:test@test.com', process.env.PublicVapidKey, process.env.PrivateVapidKey);
const { sendTelegramMessage } = require('../../utils/telegramBot');
const { createShortLink } = require('../../utils/shortLink');
const { renderNotificationText } = require('../../utils/notificationText');

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage, limits: uploadLimits, fileFilter: blockExecutableFiles });

const router = express.Router();

// ── Per-userId socket ref count ───────────────────────────────────────────────
// Map<userId:string, Set<socketId:string>>
// Multi-tab: user only goes offline when their LAST socket disconnects.
const socketRefCount = new Map();

function addSocketForUser(userId, socketId) {
  if (!socketRefCount.has(userId)) socketRefCount.set(userId, new Set());
  socketRefCount.get(userId).add(socketId);
  return socketRefCount.get(userId).size;
}

function removeSocketForUser(userId, socketId) {
  const sockets = socketRefCount.get(userId);
  if (!sockets) return 0;
  sockets.delete(socketId);
  if (sockets.size === 0) socketRefCount.delete(userId);
  return sockets.size;
}

// ── Legacy per-socket user list (kept for sendRequest / getUser) ──────────────
let onlineUsers = [];

const addNewUser = (username, socketId) => {
  if (!onlineUsers.some(u => u.username === username)) {
    onlineUsers.push({ username, socketId });
  }
};
const removeUser = (socketId) => {
  onlineUsers = onlineUsers.filter(u => u.socketId !== socketId);
};
const getUser = (username) => onlineUsers.find(u => u.username === username);

// ── io reference for use by other routes ─────────────────────────────────────
let _io = null;

// Maps a notification `type` to the per-user push preference category. Types
// not listed here (info/system/request/unlock) are always pushed — they are
// account/system messages with no user-facing opt-out.
const PREF_BY_TYPE = {
  task: 'tasks', taskClaimed: 'tasks', taskDone: 'tasks',
  assignment: 'assignments',
  invoice: 'invoices',
  dmChat: 'dmChat',
  readyToUpload: 'readyToUpload',
  tutorial: 'tutorials',
  jobReport: 'jobReports',
};

// Deep-link path for a push notification click — kept in sync with the frontend
// notifPath() in tools/pushNotifications.js. The service worker opens this URL.
function notifPath(entityType, entityId) {
  const id = entityId ? String(entityId) : '';
  switch (entityType) {
    case 'invoice':       return id ? `/mis?open=${id}` : '/mis';
    case 'rawContent':    return id ? `/digitalMarketing?dm=raw&open=${id}`   : '/digitalMarketing?dm=raw';
    case 'readyToUpload': return id ? `/digitalMarketing?dm=ready&open=${id}` : '/digitalMarketing?dm=ready';
    case 'task':          return '/crm';
    case 'customer':      return id ? `/crm?open=${id}` : '/crm';
    case 'user':          return '/users';
    case 'tutorial':      return id ? `/tutorials?open=${id}` : '/tutorials';
    case 'jobReport':     return id ? `/jobReports?open=${id}` : '/jobReports';
    default:              return '/';
  }
}

// Fire the browser (web-push) notification for a persisted in-app notification,
// gated by the recipient's notificationPrefs. Best-effort: never throws into the
// caller, and prunes subscriptions the push service reports as gone (404/410).
// `user` is the ALREADY-FETCHED recipient doc (see sendNotificationToUser) —
// avoids a second DB round-trip for the same prefs sendTelegramNotification needs.
async function sendWebPush(user, { type, title, body, entityType, entityId }) {
  try {
    if (user.pushEnabled === false) return;   // channel switched off entirely, independent of category prefs

    const prefCat = PREF_BY_TYPE[type];
    if (prefCat && user.notificationPrefs && user.notificationPrefs[prefCat] === false) return;

    const subDoc = await pwaSubscription.findOne({ userId: String(user._id) });
    if (!subDoc || !Array.isArray(subDoc.subscription) || !subDoc.subscription.length) return;

    const payload = JSON.stringify({ type: 'generic', title, body, entityType, entityId, url: notifPath(entityType, entityId) });
    const stale = [];
    for (const s of subDoc.subscription) {
      try {
        await webpush.sendNotification(JSON.parse(s), payload);
      } catch (err) {
        // 404/410 = the push service says this subscription is dead (browser
        // uninstalled, permission revoked, OS cleared it) — prune it silently,
        // that's expected churn. Anything else (bad VAPID key, payload too
        // large, network error) is a REAL delivery failure and was previously
        // swallowed with zero visibility — log it so it's diagnosable.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          stale.push(s);
        } else {
          console.error('web-push send failed:', err && (err.statusCode || err.message || err));
        }
      }
    }
    if (stale.length) {
      const kept = subDoc.subscription.filter((s) => !stale.includes(s));
      await pwaSubscription.updateOne({ userId }, { $set: { subscription: kept } });
    }
  } catch (err) {
    console.error('sendWebPush failed:', err && err.message);
  }
}

// Maps a notification's entityType to the short-link system's {module,
// entityType} pair (api/utils/shortLink.js) — a different vocabulary, since a
// short link also needs to know which SECTION a record lives in — plus the
// clickable link text shown in the Telegram message, per RECIPIENT language
// (same rationale as utils/notificationText.js). Types with no specific
// detail page (e.g. 'task', which only ever deep-links to the general /crm
// view) are deliberately left unmapped — those messages just don't get a link.
const ENTITY_TO_SHORTLINK = {
  customer: {
    module: 'crm', entityType: 'customer',
    label: { en: 'Show the customer', fa: 'نمایش مشتری', ar: 'عرض العميل' },
  },
  invoice: {
    module: 'mis', entityType: 'invoice',
    label: { en: 'Show the invoice', fa: 'نمایش فاکتور', ar: 'عرض الفاتورة' },
  },
  rawContent: {
    module: 'digitalMarketing', entityType: 'rawContent',
    label: { en: 'Show the raw content', fa: 'نمایش محتوای خام', ar: 'عرض المحتوى الخام' },
  },
  readyToUpload: {
    module: 'digitalMarketing', entityType: 'readyToUpload',
    label: { en: 'Show the ready-to-upload content', fa: 'نمایش محتوای آماده آپلود', ar: 'عرض المحتوى الجاهز للرفع' },
  },
  user: {
    module: 'users', entityType: 'user',
    label: { en: 'Show the profile', fa: 'نمایش پروفایل', ar: 'عرض الملف الشخصي' },
  },
  jobReport: {
    module: 'jobReports', entityType: 'jobReport',
    label: { en: 'Show the job report', fa: 'نمایش گزارش کار', ar: 'عرض تقرير العمل' },
  },
  tutorial: {
    module: 'tutorials', entityType: 'tutorial',
    label: { en: 'Watch the tutorial', fa: 'مشاهده آموزش', ar: 'مشاهدة الشرح' },
  },
};

// Telegram messages are sent with parse_mode:'HTML' (see telegramBot.js) so
// the link can be real clickable text instead of a bare pasted URL — title
// and body may contain user-typed text (customer names, note bodies, etc.),
// so they must be escaped before being wrapped in HTML tags, or a stray
// '<'/'&' would either break the send or accidentally inject formatting.
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PRODUCTION_FRONTEND_URL = 'https://xms.lazulitemarble.com';

// A Telegram (or web-push) link is opened on someone ELSE'S device, outside
// this network — so a localhost / private-LAN / protocol-less FRONTEND_URL is
// never a usable link target there, even when the server itself is running in
// development. Telegram simply refuses to linkify such a host, which is
// exactly how this surfaced: messages arrived with the label text present but
// completely unclickable, on every environment whose .env still carried the
// dev default (FRONTEND_URL=http://localhost:3000).
//
// So: use FRONTEND_URL only when it is a publicly-resolvable http(s) origin,
// and otherwise fall back to the real production domain rather than emitting a
// link that cannot possibly work.
function publicFrontendBase() {
  const raw = (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return PRODUCTION_FRONTEND_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return PRODUCTION_FRONTEND_URL;          // no protocol / unparseable
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return PRODUCTION_FRONTEND_URL;
  const host = parsed.hostname.toLowerCase();
  const isLocal =
    host === 'localhost' || host.endsWith('.localhost') ||
    host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    !host.includes('.');                      // bare hostname, not a public FQDN
  return isLocal ? PRODUCTION_FRONTEND_URL : raw;
}

// Telegram delivery for a persisted notification — mirrors sendWebPush's gating
// (same per-type opt-out via notificationPrefs) but NOT its linking: a push
// notification's url is a plain in-app relative path (notifPath()) because the
// click happens inside the already-logged-in browser/PWA — no session exists
// in Telegram, so a message needs a REAL clickable URL, and since it may sit
// unread for days or get forwarded, the permission-checked short-link system
// (same one the in-app "copy link" buttons use) is the right fit here, not a
// raw deep path. No-op if the user never linked their account.
async function sendTelegramNotification(user, { type, title, body, entityType, entityId, lang }) {
  try {
    if (!user.telegram || !user.telegram.chatId) return;
    if (user.telegram.enabled === false) return;   // channel switched off, independent of being linked
    const prefCat = PREF_BY_TYPE[type];
    if (prefCat && user.notificationPrefs && user.notificationPrefs[prefCat] === false) return;

    let text = body ? `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}` : `<b>${escapeHtml(title)}</b>`;

    const mapping = entityType && ENTITY_TO_SHORTLINK[entityType];
    if (mapping && entityId) {
      try {
        const code = await createShortLink({
          module: mapping.module, entityType: mapping.entityType, entityId,
          expiresAt: null, createdBy: String(user._id),
        });
        const url  = `${publicFrontendBase()}/l/${code}`;
        const label = mapping.label[lang] || mapping.label.en;
        text += `\n\n<a href="${url}">${escapeHtml(label)}</a>`;
      } catch (_) { /* link creation is best-effort — message still sends without it */ }
    }

    await sendTelegramMessage(user.telegram.chatId, text);
  } catch (err) {
    console.error('sendTelegramNotification failed:', err && err.message);
  }
}

// Send a notification to a specific user via socket AND persist to DB AND, if
// they have a push subscription + haven't opted out, a browser push — AND, if
// they've linked Telegram, a Telegram message. Text is translated into the
// RECIPIENT's own language (userModel.language) whenever a textKey is given —
// pass { textKey, textParams } instead of literal title/body wherever a
// translation exists in utils/notificationText.js; literal title/body is
// still supported as a fallback (untranslated) for anything not migrated yet.
// Other route files import this to push real-time notifications.
const sendNotificationToUser = async (userId, { fromId = null, fromName = '', type = 'info', textKey = null, textParams = {}, title: rawTitle = null, body: rawBody = '', entityType = null, entityId = null } = {}) => {
  if (!userId) return;
  const user = await userM.findById(userId).select('language notificationPrefs pushEnabled telegram').lean();
  if (!user) return;
  const lang = ['en', 'fa', 'ar'].includes(user.language) ? user.language : 'en';

  let title = rawTitle, body = rawBody;
  if (textKey) {
    const rendered = renderNotificationText(textKey, lang, textParams);
    if (rendered) { title = rendered.title; body = rendered.body; }
  }
  if (!title) return;

  let saved;
  try {
    saved = await Notification.create({ userId, fromId, fromName, type, title, body, entityType, entityId });
  } catch (err) {
    // Caught a real instance of this: a new `type` value used by a caller
    // before being added to notificationModel.js's enum throws a validation
    // error here, which — swallowed silently — looked exactly like "the
    // notification system just isn't firing" with zero diagnostic trail.
    // Logged now so the next missing-enum-value mistake is findable.
    crashLogger.logError(err, { type: 'notificationCreateFailed', notifType: type, userId: String(userId) });
  }
  if (_io) {
    _io.to(`user:${String(userId)}`).emit('notification:new', {
      _id: saved?._id, userId, fromId, fromName, type, title, body, entityType, entityId, isRead: false, insertDate: new Date(),
    });
  }
  // Browser push + Telegram (both best-effort, both respect per-user prefs)
  sendWebPush(user, { type, title, body, entityType, entityId });
  sendTelegramNotification(user, { type, title, body, entityType, entityId, lang });
  return saved;
};

// Broadcast a new raw content chat message to everyone currently in that
// record's room (Phase 8). Other route files import this the same way
// customer.js imports sendNotificationToUser.
const emitRawContentMessage = (rawContentId, message) => {
  if (!_io || !rawContentId) return;
  _io.to(`rawContent:${String(rawContentId)}`).emit('dm:chat:new', message);
};

// Same idea, for a STANDALONE ready-to-upload record's own chat thread (one
// with no source raw content to attach to — see rawContentChatModel.js).
// Separate room namespace (readyToUpload:<id> vs rawContent:<id>) so the two
// never collide even if a rawContentId and a readyToUploadId ever happened to
// share the same ObjectId value (astronomically unlikely, but free to avoid).
const emitReadyToUploadMessage = (readyToUploadId, message) => {
  if (!_io || !readyToUploadId) return;
  _io.to(`readyToUpload:${String(readyToUploadId)}`).emit('dm:chat:new', message);
};

// ── Socket.io setup (receives io from server.js) ──────────────────────────────
const returnRouter = function (io) {
  _io = io;

  io.on('connection', (socket) => {

    // ── 'newUser' — emitted by frontend after login (auth.js) ──────────────
    // Payload: { userId, ghostSessionId } (ghostSessionId is null for a real
    // session). Accepts a bare string too, for any client still on the old
    // shape.
    //
    // Ghost sessions are handled here, not through connections/xmsPr.js's
    // AsyncLocalStorage routing: a socket connection is long-lived and has no
    // single call chain to wrap the way an HTTP request does (that machinery
    // only wraps the Express request/response cycle in verifyToken.js). A
    // ghost socket carries the TARGET user's real id (by design — see
    // routes/ghost/main.js), so without this check it would silently mark the
    // impersonated person online, overwrite their real lastSeen on disconnect,
    // and — worse — corrupt the shared per-user ref-count map: if that person
    // ALSO has a real session open, the ghost tab closing would decrement
    // their count and wrongly flip them offline. None of that is acceptable
    // for a feature whose entire point is "must not touch the target's data."
    socket.on('newUser', async (payload) => {
      const { userId, ghostSessionId } = (payload && typeof payload === 'object')
        ? payload : { userId: payload, ghostSessionId: null };
      if (!userId) return;
      const uid = String(userId);

      if (ghostSessionId) {
        // Still join the room so a ghost sees real-time notifications the way
        // the impersonated user would (read-only — nothing written here) —
        // just never touch presence or the ref-count map.
        socket.data.userId = null;
        socket.data.isGhost = true;
        socket.join(`user:${uid}`);
        return;
      }

      // Legacy presence (for sendRequest compatibility)
      addNewUser(uid, socket.id);

      // Tag socket so disconnect handler knows which user this was
      socket.data.userId = uid;

      // Join user-specific room for targeted notifications
      socket.join(`user:${uid}`);

      const count = addSocketForUser(uid, socket.id);

      // First socket for this user → mark online in DB + broadcast
      if (count === 1) {
        try {
          await userM.updateOne({ _id: uid }, { $set: { isOnline: true } });
        } catch (_) {}

        io.emit('presence:update', { userId: uid, isOnline: true, lastSeen: null });
      }
    });

    // ── Digital Marketing — raw content chat rooms (Phase 8) ────────────────
    // One room per rawContentId; frontend joins on opening the chat panel and
    // leaves on closing it. Real-time delivery only — history is fetched via
    // GET /digitalMarketing/raw-contents/:id/chat.
    socket.on('dm:joinRawContent', (rawContentId) => {
      if (rawContentId) socket.join(`rawContent:${rawContentId}`);
    });
    socket.on('dm:leaveRawContent', (rawContentId) => {
      if (rawContentId) socket.leave(`rawContent:${rawContentId}`);
    });

    // Same pattern, for a standalone ready-to-upload record's own chat thread.
    socket.on('dm:joinReadyToUpload', (readyToUploadId) => {
      if (readyToUploadId) socket.join(`readyToUpload:${readyToUploadId}`);
    });
    socket.on('dm:leaveReadyToUpload', (readyToUploadId) => {
      if (readyToUploadId) socket.leave(`readyToUpload:${readyToUploadId}`);
    });

    // ── 'sendRequest' — existing notification relay ─────────────────────────
    socket.on('sendRequest', async ({ to, from, document, type }) => {
      (to || []).forEach(async (element) => {
        const receiver = getUser(element);
        if (receiver) {
          try {
            io.to(receiver.socketId).emit('newPing', { ping: Math.random() });
          } catch (_) {}
        }
      });
    });

    // ── disconnect — ref-count; mark offline on last socket close ───────────
    socket.on('disconnect', async () => {
      removeUser(socket.id);

      const uid = socket.data.userId;
      if (!uid) return;

      const remaining = removeSocketForUser(uid, socket.id);

      // Last socket closed → mark offline + record lastSeen
      if (remaining === 0) {
        const lastSeen = new Date();
        try {
          await userM.updateOne({ _id: uid }, { $set: { isOnline: false, lastSeen } });
        } catch (_) {}

        io.emit('presence:update', { userId: uid, isOnline: false, lastSeen });
      }
    });

  });

  // ── REST routes (notification + PWA subscription) ─────────────────────────

  router.post('/saveNotif', verify, async (req, res) => {
    const document = await invoice.findOne({ _id: req.body.document });
    const from     = await userM.findOne({ _id: req.body.from });
    try {
      for (let i = 0; i < req.body.to.length; i++) {
        const newNotif = new notfication({
          from: req.body.from, document: req.body.document,
          to: req.body.to[i], type: req.body.type,
        });
        const response = await newNotif.save();
        const payload  = JSON.stringify({
          sendFrom: `${from.firstName} ${from.lastName}`,
          document: `${document.preInvoice.productName}-${document.preInvoice.meterage} meters`,
          status: document.status, type: req.body.type,
        });
        const subscriptions = await pwaSubscription.findOne({ userId: req.body.to[i] });
        if (subscriptions) {
          for (let j = 0; j < subscriptions.subscription.length; j++) {
            try {
              await webpush.sendNotification(JSON.parse(subscriptions.subscription[j]), payload);
              res.status(200).send('notif sent!');
            } catch (err) {
              res.status(403).send(err);
            }
          }
        }
      }
    } catch (_) {}
  });

  router.post('/saveSubsToDb', verify, async (req, res) => {
    try {
      const check = await pwaSubscription.findOne({ userId: req.body.userId });
      if (check) {
        const filtered = check.subscription.filter(e => e === req.body.subs);
        if (filtered.length === 0) {
          const temp = [...check.subscription, req.body.subs];
          await pwaSubscription.findOneAndUpdate({ userId: req.body.userId }, { $set: { subscription: temp } });
          res.status(200).send('subscription updated!');
        }
      } else {
        const newSub = new pwaSubscription({ userId: req.body.userId, subscription: [req.body.subs] });
        await newSub.save();
        res.status(200).send('user subscribed!');
      }
    } catch (err) {
      res.status(403).send('error!');
    }
  });

  router.get('/getNotficationBasedOnUser', verify, async (req, res) => {
    try {
      const received = await notfication.find({ to: req.query.id });
      const notifs   = await Promise.all(received.map(async (n) => ({
        id:         n._id,
        status:     n.status,
        from:       await userM.findOne({ _id: n.from }),
        document:   await invoice.findOne({ _id: n.document }),
        to:         await userM.findOne({ _id: n.to }),
        type:       n.type,
        insertDate: n.insertDate,
      })));
      res.status(200).json(notifs);
    } catch (err) {
      res.status(500).json({ message: 'Server error' });
    }
  });

  router.get('/switchStatus', verify, async (req, res) => {
    try {
      const id          = mongoose.Types.ObjectId(req.query.id.trim());
      const switchStatus = await notfication.findOne({ _id: id });
      await notfication.findOneAndUpdate({ _id: id }, { status: switchStatus.status === 0 ? 1 : 0 });
      res.status(200).send('switched!');
    } catch (err) {
      res.status(500).json({ message: 'Server error' });
    }
  });

  router.get('/deleteSubs', verify, async (req, res) => {
    try {
      const id           = mongoose.Types.ObjectId(req.query.id.trim());
      const switchStatus = await notfication.findOne({ _id: id });
      await notfication.findOneAndUpdate({ _id: id }, { status: switchStatus.status === 0 ? 1 : 0 });
      res.status(200).send('switched!');
    } catch (err) {
      res.status(500).json({ message: 'Server error' });
    }
  });

  return router;
};

module.exports = returnRouter;
module.exports.sendNotificationToUser = sendNotificationToUser;
module.exports.emitRawContentMessage = emitRawContentMessage;
module.exports.emitReadyToUploadMessage = emitReadyToUploadMessage;
