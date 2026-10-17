// Everything the ticket routes share — the owner's routes (routes/feedback/main.js)
// and the developers' dashboard (routes/feedback/admin.js) — in ONE place, so a
// rule about uploads, validation or notifications cannot drift between them.
const mongoose = require('mongoose');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs/promises');
const crypto   = require('crypto');
const sharp    = require('sharp');

const dbConnection         = require('../connections/xmsPr');
const feedbackTicketSchema = require('../models/feedbackTicketModel');
const fileSchema           = require('../models/fileModel');
const userSchema           = require('../models/userModel');

const { blockExecutableFiles, uploadLimits } = require('./uploadGuards');
const { isVideoUpload, convertHeicIfNeeded, extractVideoThumbnail, transcodeVideoAsync } = require('./mediaConvert');
const { TYPES, AREAS, LIMITS } = require('./feedbackConstants');
const { developerUserIds } = require('./developers');
const { version: API_VERSION } = require('../package.json');

const Ticket = dbConnection.models.feedbackTicket || dbConnection.model('feedbackTicket', feedbackTicketSchema);
const File   = dbConnection.models.file           || dbConnection.model('file',           fileSchema);
const User   = dbConnection.models.user           || dbConnection.model('user',           userSchema);

const UPLOADS_DIR = 'public/uploads';

// ── uploads ───────────────────────────────────────────────────────────────────
// The random part is 96 bits, not Math.random(): /uploads is served statically
// without a login (the same as every other section's files), and a bug report
// is where people paste screenshots of real customer data. An unguessable name
// is the only protection that file URL has.
const upload = multer({
  limits: uploadLimits,
  fileFilter: blockExecutableFiles,           // the ONE upload policy, shared with every other route
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = (file.originalname.match(/\..*$/)?.[0] || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32);
      cb(null, `feedback-${crypto.randomBytes(12).toString('hex')}${ext}`);
    },
  }),
});

// multer reports "one file too many" as LIMIT_UNEXPECTED_FILE with no status,
// which the global handler would answer as a 500. That is the person's mistake,
// so say so.
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

function classifyFile(file = {}) {
  const mimetype = String(file.mimetype || '').toLowerCase();
  if (mimetype.startsWith('image/')) return 'image';
  if (isVideoUpload(file)) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype === 'application/pdf') return 'pdf';
  return 'other';
}

// The disk names a stored file may have made: the original, its thumbnail (an
// image's is a jpg, a video's a png) and a browser-displayable copy.
const diskNamesFor = (base) => (base ? [base, `thumb-${base}`, `thumb-${base}.png`, `webpreview-${base}.jpg`] : []);

// multer has already written these by the time a handler can refuse the
// request, so a refusal (or a failure) has to remove them or they sit on disk
// attached to nothing.
async function discardUploads(files) {
  for (const f of files || []) {
    for (const name of diskNamesFor(f.filename)) {
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

// Delete the File Manager docs and the bytes behind attachments a ticket no
// longer has (the owner removed them while editing). The ticket is the only
// thing that ever referenced them.
async function removeAttachmentFiles(attachments) {
  const ids = (attachments || []).map((a) => a.fileId).filter(Boolean);
  const docs = ids.length ? await File.find({ _id: { $in: ids } }).lean() : [];
  const names = new Set();
  for (const a of attachments || []) {
    diskNamesFor(a.diskName).forEach((n) => names.add(n));
    if (a.previewDiskName) names.add(a.previewDiskName);
    if (a.thumbnail) names.add(a.thumbnail);
  }
  for (const d of docs) {
    [d.thumbnail, d.webPreview, d.videoPreview].filter(Boolean).forEach((n) => names.add(String(n)));
  }
  for (const n of names) await fs.rm(path.join(UPLOADS_DIR, n), { force: true }).catch(() => {});
  if (ids.length) await File.deleteMany({ _id: { $in: ids } });
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

const toListItem = (d) => {
  const history = d.statusHistory || [];
  return {
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
    editedAt: d.editedAt || null,
    lastStatusAt: history.length ? history[history.length - 1].at : d.insertDate,
    deleted: !!d.deleteDate,
    fileCount: (d.attachments || []).filter((a) => !a.isVoice).length,
    voiceCount: (d.attachments || []).filter((a) => a.isVoice).length,
  };
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const actorNameOf = async (userId) => {
  const u = await User.findById(userId).select('firstName lastName').lean();
  return u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '';
};

// ── notifications ────────────────────────────────────────────────────────────
// Best-effort and never awaited by a route: a failed push must not fail a
// ticket. The notification `type` ('feedback') has to be in notificationModel's
// enum or the row is silently dropped (see the note in xmsNotifications.js).
const notifier = () => require('../routes/socket/xmsNotifications').sendNotificationToUser;

function notifyDevelopersOfNewTicket(ticket, actorId, actorName) {
  (async () => {
    try {
      const send = notifier();
      const ids = (await developerUserIds()).filter((id) => id !== String(actorId));
      await Promise.all(ids.map((id) => send(id, {
        fromId: actorId, fromName: actorName, type: 'feedback',
        textKey: 'feedbackNew',
        textParams: { code: ticket.code, title: ticket.title, kind: ticket.type, name: actorName || '—' },
        entityType: 'feedbackTicketDev', entityId: ticket._id,
      })));
    } catch (_) { /* best-effort */ }
  })();
}

function notifyReporterOfStatus(ticket, actorId, actorName, status, note) {
  (async () => {
    try {
      if (String(ticket.owner) === String(actorId)) return;     // not about their own action
      await notifier()(String(ticket.owner), {
        fromId: actorId, fromName: actorName, type: 'feedback',
        textKey: 'feedbackStatus',
        textParams: { code: ticket.code, title: ticket.title, status, note: note || '' },
        entityType: 'feedbackTicket', entityId: ticket._id,
      });
    } catch (_) { /* best-effort */ }
  })();
}

module.exports = {
  Ticket, File, User, UPLOADS_DIR,
  receiveFiles, discardUploads, makeAttachment, removeAttachmentFiles,
  stripControl, clip, parseTicketInput,
  toListItem, escapeRegex, actorNameOf,
  notifyDevelopersOfNewTicket, notifyReporterOfStatus,
  API_VERSION,
};
