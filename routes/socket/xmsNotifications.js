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
const dbConnection = require('../../connections/xmsPr');

const userM           = dbConnection.model('user',            userModel);
const invoice         = dbConnection.model('invoice',         invoiceModel);
const notfication     = dbConnection.model('notfication',     notficationModel);
const Notification    = dbConnection.model('notification',    notificationModel);
const pwaSubscription = dbConnection.model('pwaSubscription', pwaSubscriptionModel);

const webpush = require('web-push');
webpush.setVapidDetails('mailto:test@test.com', process.env.PublicVapidKey, process.env.PrivateVapidKey);

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

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

// Send a notification to a specific user via socket AND persist to DB.
// Other route files import this to push real-time notifications.
const sendNotificationToUser = async (userId, { fromId = null, fromName = '', type = 'info', title, body = '', entityType = null, entityId = null } = {}) => {
  if (!userId || !title) return;
  let saved;
  try {
    saved = await Notification.create({ userId, fromId, fromName, type, title, body, entityType, entityId });
  } catch (_) {}
  if (_io) {
    _io.to(`user:${String(userId)}`).emit('notification:new', {
      _id: saved?._id, userId, fromId, fromName, type, title, body, entityType, entityId, isRead: false, insertDate: new Date(),
    });
  }
  return saved;
};

// Broadcast a new raw content chat message to everyone currently in that
// record's room (Phase 8). Other route files import this the same way
// customer.js imports sendNotificationToUser.
const emitRawContentMessage = (rawContentId, message) => {
  if (!_io || !rawContentId) return;
  _io.to(`rawContent:${String(rawContentId)}`).emit('dm:chat:new', message);
};

// ── Socket.io setup (receives io from server.js) ──────────────────────────────
const returnRouter = function (io) {
  _io = io;

  io.on('connection', (socket) => {

    // ── 'newUser' — emitted by frontend after login (auth.js) ──────────────
    // Payload: userId string (from decoded JWT)
    socket.on('newUser', async (userId) => {
      if (!userId) return;
      const uid = String(userId);

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
          document: `${document.preInvoice.productName}-${document.preInvoice.meterage} متر`,
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
      res.status(500).json({ message: 'خطای سرور' });
    }
  });

  router.get('/switchStatus', verify, async (req, res) => {
    try {
      const id          = mongoose.Types.ObjectId(req.query.id.trim());
      const switchStatus = await notfication.findOne({ _id: id });
      await notfication.findOneAndUpdate({ _id: id }, { status: switchStatus.status === 0 ? 1 : 0 });
      res.status(200).send('switched!');
    } catch (err) {
      res.status(500).json({ message: 'خطای سرور' });
    }
  });

  router.get('/deleteSubs', verify, async (req, res) => {
    try {
      const id           = mongoose.Types.ObjectId(req.query.id.trim());
      const switchStatus = await notfication.findOne({ _id: id });
      await notfication.findOneAndUpdate({ _id: id }, { status: switchStatus.status === 0 ? 1 : 0 });
      res.status(200).send('switched!');
    } catch (err) {
      res.status(500).json({ message: 'خطای سرور' });
    }
  });

  return router;
};

module.exports = returnRouter;
module.exports.sendNotificationToUser = sendNotificationToUser;
module.exports.emitRawContentMessage = emitRawContentMessage;
