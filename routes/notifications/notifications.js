const express          = require('express');
const notificationModel = require('../../models/notificationModel');
const verify           = require('../users/verifyToken');
const { requirePermission } = require('../../utils/rbac');
const dbConnection     = require('../../connections/xmsPr');

const Notification = dbConnection.model('notification', notificationModel);

const router = express.Router();

// GET /notifications — list for current user (paginated, optional filter)
// filter=unread|tasks|all  page=1  limit=20
router.get('/', verify, async (req, res) => {
  const { filter = 'all', page = 1, limit = 20 } = req.query;
  const userId = req.user.id;

  const query = { userId, deleteDate: null };
  if (filter === 'unread') query.isRead = false;
  if (filter === 'tasks')  query.type   = { $in: ['task', 'taskClaimed', 'taskDone'] };

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(query)
      .sort({ insertDate: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean(),
    Notification.countDocuments(query),
    Notification.countDocuments({ userId, isRead: false, deleteDate: null }),
  ]);

  res.json({ data: items, total, unreadCount, page: Number(page) });
});

// PUT /notifications/read-all — mark all as read (must be before /:id to avoid clash)
router.put('/read-all', verify, async (req, res) => {
  await Notification.updateMany({ userId: req.user.id, isRead: false }, { $set: { isRead: true } });
  res.json({ success: true });
});

// PUT /notifications/:id/read — mark one as read
router.put('/:id/read', verify, async (req, res) => {
  await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { $set: { isRead: true } }
  );
  res.json({ success: true });
});

// DELETE /notifications/:id — soft-delete
router.delete('/:id', verify, async (req, res) => {
  await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { $set: { deleteDate: new Date() } }
  );
  res.json({ success: true });
});

module.exports = router;
