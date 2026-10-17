const express  = require('express');
const mongoose = require('mongoose');

const verify = require('../users/verifyToken');
const { requireDeveloper, isDeveloper } = require('../../utils/developers');
const { TYPES, STATUSES, AREAS } = require('../../utils/feedbackConstants');
const {
  Ticket, toListItem, escapeRegex, clip, actorNameOf, notifyReporterOfStatus,
} = require('../../utils/feedbackTickets');

// The developers' dashboard for bug reports and suggestions. Mounted at
// /feedback/admin by routes/feedback/main.js.
//
// The gate is utils/developers.js — an allowlist of phone numbers — and not a
// permission key or a role: this is for the people who build the app, and a role
// can be handed out. It deliberately ignores the `feedback` data scope too: a
// developer reads EVERY ticket, including ones their owner deleted.
const router = express.Router();

// "Am I a developer?" — the one route a non-developer may call. It decides
// whether the screen offers the Dashboard tab, and says nothing about anyone else.
router.get('/me', verify, async (req, res, next) => {
  try { res.json({ data: { developer: await isDeveloper(req.user.id) } }); } catch (err) { next(err); }
});

// Everything below is developers only.
router.use(verify, requireDeveloper());

const DAY = 24 * 60 * 60 * 1000;
const dayKey = (d) => d.toISOString().slice(0, 10);

// ── overview ──────────────────────────────────────────────────────────────────
router.get('/overview', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));
    const now = new Date();
    const since = new Date(now.getTime() - (days - 1) * DAY);
    since.setUTCHours(0, 0, 0, 0);
    const live = { deleteDate: null };
    const group = (field) => [{ $match: live }, { $group: { _id: field, n: { $sum: 1 } } }];
    const perDay = (dateField) => ({ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: dateField } }, n: { $sum: 1 } } });

    const [byStatus, byType, byArea, created, done, total, deleted, stale, newLast7] = await Promise.all([
      Ticket.aggregate(group('$status')),
      Ticket.aggregate(group('$type')),
      Ticket.aggregate(group('$area')),
      Ticket.aggregate([{ $match: { ...live, insertDate: { $gte: since } } }, perDay('$insertDate')]),
      // A ticket marked done more than once counts each time it was marked.
      Ticket.aggregate([
        { $match: live },
        { $unwind: '$statusHistory' },
        { $match: { 'statusHistory.status': 'done', 'statusHistory.at': { $gte: since } } },
        perDay('$statusHistory.at'),
      ]),
      Ticket.countDocuments(live),
      Ticket.countDocuments({ deleteDate: { $ne: null } }),
      // Open for more than a week: the ones nobody has looked at.
      Ticket.countDocuments({ ...live, status: 'open', insertDate: { $lt: new Date(now.getTime() - 7 * DAY) } }),
      Ticket.countDocuments({ ...live, insertDate: { $gte: new Date(now.getTime() - 7 * DAY) } }),
    ]);

    const toMap = (rows) => rows.reduce((m, r) => ({ ...m, [r._id]: r.n }), {});
    const createdBy = toMap(created); const doneBy = toMap(done);
    const daily = [];
    for (let i = 0; i < days; i += 1) {
      const key = dayKey(new Date(since.getTime() + i * DAY));
      daily.push({ date: key, created: createdBy[key] || 0, done: doneBy[key] || 0 });
    }

    res.json({
      data: {
        total, deleted, stale, newLast7, days,
        byStatus: toMap(byStatus),
        byType: toMap(byType),
        byArea: byArea.map((r) => ({ key: r._id, count: r.n })).sort((a, b) => b.count - a.count),
        daily,
      },
    });
  } catch (err) { next(err); }
});

// ── every ticket ──────────────────────────────────────────────────────────────
router.get('/tickets', async (req, res, next) => {
  try {
    const base = { deleteDate: String(req.query.deleted) === 'true' ? { $ne: null } : null };
    if (TYPES.includes(req.query.type)) base.type = req.query.type;
    if (AREAS.includes(req.query.area)) base.area = req.query.area;
    if (mongoose.isValidObjectId(req.query.owner)) base.owner = new mongoose.Types.ObjectId(String(req.query.owner));

    const from = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
    const to = req.query.dateTo ? new Date(req.query.dateTo) : null;
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
      base.insertDate = {};
      if (from && !Number.isNaN(from.getTime())) base.insertDate.$gte = from;
      if (to && !Number.isNaN(to.getTime())) { to.setUTCHours(23, 59, 59, 999); base.insertDate.$lte = to; }
    }

    const search = String(req.query.search || '').trim().slice(0, 80);
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      base.$or = [{ title: rx }, { description: rx }, { code: rx }, { createdByName: rx }];
    }

    const filter = { ...base };
    if (STATUSES.includes(req.query.status)) filter.status = req.query.status;

    const sort = req.query.sort === 'oldest' ? { insertDate: 1 }
      : req.query.sort === 'updated' ? { updateDate: -1, insertDate: -1 }
        : { insertDate: -1 };
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const [items, total, byStatus] = await Promise.all([
      Ticket.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      Ticket.countDocuments(filter),
      Ticket.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    const statusCounts = {};
    byStatus.forEach((r) => { statusCounts[r._id] = r.n; });

    res.json({
      data: items.map(toListItem),
      total, page, pages: Math.max(1, Math.ceil(total / limit)),
      scope: 'developer',
      statusCounts,
    });
  } catch (err) { next(err); }
});

router.get('/tickets/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Ticket not found' });
    const doc = await Ticket.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ message: 'Ticket not found' });
    res.json({ data: { ...doc, scope: 'developer', deleted: !!doc.deleteDate } });
  } catch (err) { next(err); }
});

// ── what a developer does with one ────────────────────────────────────────────

// Change the status, with an optional note the REPORTER reads in their own view
// of the ticket. A note on an unchanged status is allowed too: it is how a
// developer replies without moving it.
router.put('/tickets/:id/status', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Ticket not found' });
    const status = String(req.body.status || '').trim();
    const note = clip(req.body.note, 1000);
    if (!STATUSES.includes(status)) return res.status(400).json({ message: 'Unknown status.' });

    const ticket = await Ticket.findById(req.params.id).lean();
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (ticket.deleteDate) return res.status(409).json({ message: 'Restore this report before changing it.' });
    if (status === ticket.status && !note) {
      return res.status(400).json({ message: 'Nothing to change — pick a different status or write a note.' });
    }

    const actorName = await actorNameOf(req.user.id);
    const now = new Date();
    const updated = await Ticket.findOneAndUpdate(
      { _id: ticket._id, deleteDate: null },
      {
        $set: { status, updateDate: now },
        $push: { statusHistory: { status, at: now, byId: req.user.id, byName: actorName, note } },
      },
      { new: true },
    ).lean();
    if (!updated) return res.status(409).json({ message: 'This report changed while you were looking at it. Reload and try again.' });

    notifyReporterOfStatus(updated, req.user.id, actorName, status, note);
    res.json({ data: updated });
  } catch (err) { next(err); }
});

router.delete('/tickets/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Ticket not found' });
    const actorName = await actorNameOf(req.user.id);
    const r = await Ticket.updateOne(
      { _id: req.params.id, deleteDate: null },
      { $set: { deleteDate: new Date(), deletedBy: req.user.id, deletedByName: actorName } },
    );
    if (!r.matchedCount) return res.status(404).json({ message: 'Ticket not found' });
    res.json({ data: { deleted: true } });
  } catch (err) { next(err); }
});

router.post('/tickets/:id/restore', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Ticket not found' });
    const r = await Ticket.updateOne(
      { _id: req.params.id, deleteDate: { $ne: null } },
      { $set: { deleteDate: null, updateDate: new Date() }, $unset: { deletedBy: '', deletedByName: '' } },
    );
    if (!r.matchedCount) return res.status(404).json({ message: 'Ticket not found' });
    res.json({ data: { restored: true } });
  } catch (err) { next(err); }
});

module.exports = router;
