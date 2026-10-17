const express  = require('express');
const mongoose = require('mongoose');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs/promises');
const crypto   = require('crypto');
const sharp    = require('sharp');

const dbConnection        = require('../../connections/xmsPr');
const feedbackTicketSchema = require('../../models/feedbackTicketModel');
const fileSchema           = require('../../models/fileModel');
const userSchema           = require('../../models/userModel');

const verify = require('../users/verifyToken');
const { requirePermission } = require('../../utils/rbac');
const { blockExecutableFiles, uploadLimits } = require('../../utils/uploadGuards');
const { isVideoUpload, convertHeicIfNeeded, extractVideoThumbnail, transcodeVideoAsync } = require('../../utils/mediaConvert');
const { nextSequence, formatCode } = require('../../utils/sequence');
const { ticketScopeFor, ticketScopeFilter, canAccessTicket } = require('../../utils/feedbackScope');
const { TYPES, STATUSES, DEFAULT_STATUS, AREAS, LIMITS } = require('../../utils/feedbackConstants');
const { version: API_VERSION } = require('../../package.json');

// Report & Info — bug reports and suggestions. The user-facing half only: a
// person files a ticket (text, voice, files), sees its status, and reads the
// ones their data scope allows. Changing a status, replying and deleting belong
// to the admin panel that follows and will arrive with their own permission keys.
//
//   info:view              the section itself (app version, sections, changes)
//   feedback:view          read tickets — limited by the `feedback` data scope
//   feedback:ticket:create submit one
//
// Scope default is 'mine' (see utils/feedbackScope.js).
const Ticket = dbConnection.models.feedbackTicket || dbConnection.model('feedbackTicket', feedbackTicketSchema);
const File   = dbConnection.models.file           || dbConnection.model('file',           fileSchema);
const User   = dbConnection.models.user           || dbConnection.model('user',           userSchema);

const router = express.Router();

// ── uploads ───────────────────────────────────────────────────────────────────
// The random part is 96 bits, not Math.random(): /uploads is served statically
// without a login (the same as every other section's files), and a bug report
// is where people paste screenshots of real customer data. An unguessable name
// is the only protection that file URL has.
const upload = multer({
  limits: uploadLimits,
  fileFilter: blockExecutableFiles,           // the ONE upload policy, shared with every other route
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads'),
    filename: (req, file, cb) => {
      const ext = (file.originalname.match(/\..*$/)?.[0] || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32);
      cb(null, `feedback-${crypto.randomBytes(12).toString('hex')}${ext}`);
    },
  }),
});

const UPLOADS_DIR = 'public/uploads';

function classifyFile(file = {}) {
  const mimetype = String(file.mimetype || '').toLowerCase();
  if (mimetype.startsWith('image/')) return 'image';
  if (isVideoUpload(file)) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype === 'application/pdf') return 'pdf';
  return 'other';
}

// multer has already written these by the time a handler can refuse the
// request, so a refusal (or a failure) has to remove them or they sit on disk
// attached to nothing.
async function discardUploads(files) {
  for (const f of files || []) {
    const base = f.filename;
    for (const name of [base, `thumb-${base}`, `thumb-${base}.png`, `webpreview-${base}.jpg`]) {
      await fs.rm(path.join(UPLOADS_DIR, name), { force: true }).catch(() => {});
    }
  }
}

async function makeAttachment(file, userId, ticketId, isVoice) {
  const kind = isVoice ? 'audio' : classifyFile(file);
  let thumbnail = null;
  let previewDiskName = null;

  if (kind === 'image') {
    // A phone's HEIC photo is a real screenshot-substitute for a bug report and
    // no desktop browser draws it, so a JPEG copy is made alongside (the
    // original stays the download).
    previewDiskName = await convertHeicIfNeeded(file);
    const source = previewDiskName ? path.join(UPLOADS_DIR, previewDiskName) : file.path;
    try {
      const thumbName = `thumb-${file.filename}`;
      await sharp(source).resize(300).jpeg({ quality: 80 }).toFile(path.join(UPLOADS_DIR, thumbName));
      thumbnail = thumbName;
    } catch (_) { /* non-fatal — the grid falls back to the image itself */ }
  } else if (kind === 'video') {
    thumbnail = await extractVideoThumbnail(file.path, `thumb-${file.filename}.png`);
  }

  const fileDoc = await File.create({
    name: path.basename(file.originalname).split('.')[0],
    supFolder: null,
    metaData: file,
    format: file.originalname.slice(file.originalname.lastIndexOf('.') + 1),
    generatedBy: userId,
    thumbnail,
    webPreview: previewDiskName,
    scope: 'feedback',
    attachedTo: { type: 'feedbackTicket', id: ticketId },
  });

  // Fire-and-forget: a browser-playable copy of a screen recording that isn't
  // one already. Players reach it through /media/video/<diskName>.
  if (kind === 'video') transcodeVideoAsync(File, fileDoc, file.path);

  return {
    fileId: fileDoc._id,
    kind,
    isVoice,
    diskName: file.filename,
    previewDiskName,
    name: path.basename(file.originalname),
    mimetype: file.mimetype,
    size: file.size,
    thumbnail,
  };
}

// ── input ─────────────────────────────────────────────────────────────────────
const stripControl = (s) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const clip = (s, n) => stripControl(s).trim().slice(0, n);

// The context the browser sends is a convenience for whoever reads the ticket,
// not something to trust: every field is a short clipped string, anything else
// is dropped, and the server version is stamped here.
function parseContext(body) {
  if (String(body.includeContext) === 'false') return undefined;
  let raw = {};
  try { raw = JSON.parse(body.context || '{}') || {}; } catch (_) { raw = {}; }
  return {
    appVersion: clip(raw.appVersion, 32),
    apiVersion: API_VERSION,
    // The path only — a query string can carry ids and search terms.
    path:       clip(String(raw.path || '').split('?')[0], 160),
    language:   clip(raw.language, 8),
    viewport:   clip(raw.viewport, 20),
    userAgent:  clip(raw.userAgent, LIMITS.contextFieldMax),
  };
}

function parseTicketInput(body) {
  const type = String(body.type || '').trim();
  if (!TYPES.includes(type)) return { error: 'Choose whether this is a bug report or a suggestion.' };

  const title = clip(body.title, LIMITS.titleMax + 1);
  if (!title) return { error: 'A short title is required.' };
  if (title.length > LIMITS.titleMax) return { error: `The title is too long (max ${LIMITS.titleMax} characters).` };

  const description = stripControl(body.description).trim();
  if (description.length > LIMITS.descriptionMax) {
    return { error: `The description is too long (max ${LIMITS.descriptionMax} characters).` };
  }

  const area = String(body.area || 'other').trim() || 'other';
  if (!AREAS.includes(area)) return { error: 'Unknown section.' };

  return { type, title, description, area, context: parseContext(body) };
}

// ── list shape ────────────────────────────────────────────────────────────────
const excerpt = (s) => {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
};

const toListItem = (d) => ({
  _id: d._id,
  code: d.code,
  type: d.type,
  status: d.status,
  title: d.title,
  excerpt: excerpt(d.description),
  area: d.area,
  owner: d.owner,
  createdByName: d.createdByName,
  insertDate: d.insertDate,
  fileCount: (d.attachments || []).filter((a) => !a.isVoice).length,
  voiceCount: (d.attachments || []).filter((a) => a.isVoice).length,
});

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── routes ────────────────────────────────────────────────────────────────────

// What is running on the server. The page shows it next to the app's own
// version, so a mismatched deploy is visible instead of a mystery.
router.get('/app-info', verify, requirePermission('info:view'), (req, res) => {
  res.json({ data: { apiVersion: API_VERSION } });
});

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

// multer reports "one file too many" as LIMIT_UNEXPECTED_FILE with no status, which the
// global handler would answer as a 500. That is the person's mistake, so say so.
const receiveFiles = (req, res, next) => upload.fields([
  { name: 'attachments', maxCount: LIMITS.maxFiles },
  { name: 'voice',       maxCount: LIMITS.maxVoice },
])(req, res, (err) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      message: `Too many files — at most ${LIMITS.maxFiles} attachments and ${LIMITS.maxVoice} voice notes.`,
    });
  }
  return next(err);
});

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
      const actor = await User.findById(userId).select('firstName lastName').lean();
      const actorName = actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '';

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

      return res.status(201).json({ data: doc.toObject() });
    } catch (err) {
      // Nothing half-made is left behind: the files on disk and their File docs.
      await discardUploads(everyUpload);
      await File.deleteMany({ 'attachedTo.type': 'feedbackTicket', 'attachedTo.id': ticketId }).catch(() => {});
      return next(err);
    }
  });

module.exports = router;
