const express  = require('express');
const mongoose = require('mongoose');

const verify = require('../users/verifyToken');
const { requirePermission } = require('../../utils/rbac');
const { nextSequence, formatCode } = require('../../utils/sequence');
const { ticketScopeFor, ticketScopeFilter, canAccessTicket } = require('../../utils/feedbackScope');
const { TYPES, STATUSES, DEFAULT_STATUS, EDITABLE_STATUSES, LIMITS } = require('../../utils/feedbackConstants');
const {
  Ticket, File, receiveFiles, discardUploads, makeAttachment, removeAttachmentFiles,
  parseTicketInput, toListItem, escapeRegex, actorNameOf,
  notifyDevelopersOfNewTicket, API_VERSION,
} = require('../../utils/feedbackTickets');

// Report & Info — bug reports and suggestions: what a PERSON does with their own.
// They file a ticket (text, voice, files), read the ones their data scope
// allows, and edit or delete THEIR OWN. What the developers do with them — the
// dashboard, changing a status — is routes/feedback/admin.js, behind a
// different gate (utils/developers.js).
//
//   info:view              the section itself (app version, sections, changes)
//   feedback:view          read tickets — limited by the `feedback` data scope
//   feedback:ticket:create submit one
//   feedback:ticket:edit   change YOUR OWN ticket, while it is still Open
//   feedback:ticket:delete delete YOUR OWN ticket (soft: developers can still see it)
//
// Scope default is 'mine' (see utils/feedbackScope.js). Edit and delete are about
// ownership, not scope: a wide read scope never lets anyone change a ticket that
// is not theirs.
const router = express.Router();

// ── routes ────────────────────────────────────────────────────────────────────

// What is running on the server. The page shows it next to the app's own
// version, so a mismatched deploy is visible instead of a mystery.
router.get('/app-info', verify, requirePermission('info:view'), (req, res) => {
  res.json({ data: { apiVersion: API_VERSION } });
});

// The developers' dashboard lives under /admin.
router.use('/admin', require('./admin'));

// The person's own tickets — or more, if their data scope allows. `mine=true`
// narrows a wider scope back to their own.
router.get('/tickets', verify, requirePermission('feedback:view'), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const scope = await ticketScopeFor(userId);
    const scopeFilter = await ticketScopeFilter(userId, scope);

    const base = { deleteDate: null, ...scopeFilter };
    if (String(req.query.mine) === 'true') base.owner = new mongoose.Types.ObjectId(String(userId));

    const filter = { ...base };
    if (TYPES.includes(req.query.type)) filter.type = req.query.type;
    if (STATUSES.includes(req.query.status)) filter.status = req.query.status;
    const search = String(req.query.search || '').trim().slice(0, 80);
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ title: rx }, { description: rx }, { code: rx }];
    }

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const [items, total, byStatus] = await Promise.all([
      Ticket.find(filter).sort({ insertDate: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Ticket.countDocuments(filter),
      // Counts for the status chips: the SAME scope, but ignoring the status
      // filter itself, otherwise picking a chip would zero all the others.
      Ticket.aggregate([
        { $match: { ...base, ...(filter.type ? { type: filter.type } : {}), ...(filter.$or ? { $or: filter.$or } : {}) } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
    ]);

    const statusCounts = {};
    byStatus.forEach((r) => { statusCounts[r._id] = r.n; });

    res.json({
      data: items.map(toListItem),
      total, page, pages: Math.max(1, Math.ceil(total / limit)),
      scope,
      statusCounts,
    });
  } catch (err) { next(err); }
});

// One ticket. Out of scope answers exactly like a ticket that doesn't exist —
// an id is not something to confirm the existence of.
router.get('/tickets/:id', verify, requirePermission('feedback:view'), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Ticket not found' });
    const doc = await Ticket.findOne({ _id: req.params.id, deleteDate: null }).lean();
    if (!doc) return res.status(404).json({ message: 'Ticket not found' });

    const scope = await ticketScopeFor(req.user.id);
    if (!(await canAccessTicket(req.user.id, scope, doc))) {
      return res.status(404).json({ message: 'Ticket not found' });
    }
    res.json({ data: { ...doc, scope } });
  } catch (err) { next(err); }
});

// The cap is checked BEFORE multer so a person over it writes nothing to disk.
async function createRateLimit(req, res, next) {
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const sent = await Ticket.countDocuments({ owner: req.user.id, insertDate: { $gte: since } });
    if (sent >= LIMITS.maxPerHour) {
      return res.status(429).json({
        message: `You have sent ${sent} reports in the last hour. Please wait a little before sending another.`,
        code: 'FEEDBACK_RATE_LIMIT',
      });
    }
    return next();
  } catch (err) { return next(err); }
}

router.post('/tickets', verify, requirePermission('feedback:ticket:create'), createRateLimit,
  receiveFiles,
  async (req, res, next) => {
    const attached = (req.files && req.files.attachments) || [];
    const voice    = (req.files && req.files.voice) || [];
    const everyUpload = [...attached, ...voice];
    const ticketId = new mongoose.Types.ObjectId();
    const refuse = async (message) => {
      await discardUploads(everyUpload);
      return res.status(400).json({ message });
    };

    try {
      const input = parseTicketInput(req.body || {});
      if (input.error) return refuse(input.error);

      // The `voice` field is for recordings. Anything else in it would be a
      // file smuggled past the "attached files" count.
      if (voice.some((f) => !String(f.mimetype || '').toLowerCase().startsWith('audio/'))) {
        return refuse('A voice note must be an audio recording.');
      }
      if (!input.description && !voice.length && !attached.length) {
        return refuse('Describe it in writing, record a voice note, or attach a file.');
      }

      const userId = req.user.id;
      const actorName = await actorNameOf(userId);

      const ticketNumber = await nextSequence('feedbackTicket');
      const attachments = [];
      for (const f of attached) attachments.push(await makeAttachment(f, userId, ticketId, false));
      for (const f of voice)    attachments.push(await makeAttachment(f, userId, ticketId, true));

      const doc = await Ticket.create({
        _id: ticketId,
        ticketNumber,
        code: formatCode('TK', ticketNumber),
        type: input.type,
        status: DEFAULT_STATUS,
        statusHistory: [{ status: DEFAULT_STATUS, at: new Date(), byId: userId, byName: actorName, note: '' }],
        title: input.title,
        description: input.description,
        area: input.area,
        attachments,
        context: input.context,
        owner: userId,
        createdByName: actorName,
      });

      notifyDevelopersOfNewTicket(doc, userId, actorName);
      return res.status(201).json({ data: doc.toObject() });
    } catch (err) {
      // Nothing half-made is left behind: the files on disk and their File docs.
      await discardUploads(everyUpload);
      await File.deleteMany({ 'attachedTo.type': 'feedbackTicket', 'attachedTo.id': ticketId }).catch(() => {});
      return next(err);
    }
  });

// ── editing and deleting your OWN ticket ──────────────────────────────────────

// Loads the ticket for an owner action and refuses BEFORE multer has written a
// byte. "Not yours" and "does not exist" are the same answer, as everywhere here.
const loadOwnTicket = ({ mustBeEditable }) => async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Ticket not found' });
    const doc = await Ticket.findOne({ _id: req.params.id, deleteDate: null }).lean();
    if (!doc || String(doc.owner) !== String(req.user.id)) return res.status(404).json({ message: 'Ticket not found' });
    if (mustBeEditable && !EDITABLE_STATUSES.includes(doc.status)) {
      return res.status(409).json({
        message: 'This report is already being handled, so it can no longer be edited.',
        code: 'FEEDBACK_LOCKED',
      });
    }
    req.ticket = doc;
    return next();
  } catch (err) { return next(err); }
};

// PUT /tickets/:id — multipart, like create. Plus `removeFileIds` (JSON array of
// the ids of attachments to drop); new files go in `attachments` / `voice`.
router.put('/tickets/:id', verify, requirePermission('feedback:ticket:edit'),
  loadOwnTicket({ mustBeEditable: true }), receiveFiles,
  async (req, res, next) => {
    const attached = (req.files && req.files.attachments) || [];
    const voice    = (req.files && req.files.voice) || [];
    const everyUpload = [...attached, ...voice];
    const ticket = req.ticket;
    const refuse = async (message, status = 400, code) => {
      await discardUploads(everyUpload);
      return res.status(status).json({ message, ...(code ? { code } : {}) });
    };

    try {
      const input = parseTicketInput(req.body || {});
      if (input.error) return refuse(input.error);
      if (voice.some((f) => !String(f.mimetype || '').toLowerCase().startsWith('audio/'))) {
        return refuse('A voice note must be an audio recording.');
      }

      let removeIds = [];
      try { removeIds = JSON.parse(req.body.removeFileIds || '[]'); } catch (_) { removeIds = []; }
      const remove = new Set((Array.isArray(removeIds) ? removeIds : []).map(String));

      const kept = ticket.attachments.filter((a) => !remove.has(String(a.fileId)));
      const removed = ticket.attachments.filter((a) => remove.has(String(a.fileId)));

      // The limits apply to what the ticket will HOLD, not to what this one
      // request carries.
      const filesAfter = kept.filter((a) => !a.isVoice).length + attached.length;
      const voiceAfter = kept.filter((a) => a.isVoice).length + voice.length;
      if (filesAfter > LIMITS.maxFiles) return refuse(`A report holds at most ${LIMITS.maxFiles} files.`);
      if (voiceAfter > LIMITS.maxVoice) return refuse(`A report holds at most ${LIMITS.maxVoice} voice notes.`);
      if (!input.description && !kept.length && !attached.length && !voice.length) {
        return refuse('Describe it in writing, record a voice note, or attach a file.');
      }

      const added = [];
      for (const f of attached) added.push(await makeAttachment(f, req.user.id, ticket._id, false));
      for (const f of voice)    added.push(await makeAttachment(f, req.user.id, ticket._id, true));

      // Conditional on STILL being open and still theirs: a developer who picked
      // the ticket up while this person was typing wins, and nothing is
      // overwritten.
      const now = new Date();
      const updated = await Ticket.findOneAndUpdate(
        { _id: ticket._id, owner: req.user.id, deleteDate: null, status: { $in: EDITABLE_STATUSES } },
        { $set: {
          type: input.type, title: input.title, description: input.description, area: input.area,
          attachments: [...kept, ...added], editedAt: now, updateDate: now,
        } },
        { new: true },
      ).lean();

      if (!updated) {
        // Lost the race: undo what this request made.
        await removeAttachmentFiles(added);
        await discardUploads(everyUpload);
        return res.status(409).json({
          message: 'This report was picked up while you were editing it, so your changes were not saved.',
          code: 'FEEDBACK_LOCKED',
        });
      }

      // Only now is it safe to delete what the person removed.
      await removeAttachmentFiles(removed);
      return res.json({ data: updated });
    } catch (err) {
      await discardUploads(everyUpload);
      return next(err);
    }
  });

// DELETE /tickets/:id — soft, at any status. The ticket leaves the person's list;
// developers can still find it (and restore it) from the dashboard.
router.delete('/tickets/:id', verify, requirePermission('feedback:ticket:delete'),
  loadOwnTicket({ mustBeEditable: false }),
  async (req, res, next) => {
    try {
      const actorName = await actorNameOf(req.user.id);
      await Ticket.updateOne(
        { _id: req.ticket._id, owner: req.user.id, deleteDate: null },
        { $set: { deleteDate: new Date(), deletedBy: req.user.id, deletedByName: actorName } },
      );
      return res.json({ data: { deleted: true } });
    } catch (err) { return next(err); }
  });

module.exports = router;
