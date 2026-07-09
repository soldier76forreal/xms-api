const express  = require('express');
const mongoose = require('mongoose');
const multer   = require('multer');
const sharp    = require('sharp');
const ffmpeg   = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

const dbConnection        = require('../../connections/xmsPr');
const rawContentSchema     = require('../../models/rawContentModel');
const rawContentChatSchema = require('../../models/rawContentChatModel');
const readyToUploadSchema  = require('../../models/readyToUploadModel');
const userSchema           = require('../../models/userModel');
const fileSchema           = require('../../models/fileModel');

const verify = require('../users/verifyToken');
const { requirePermission, getEffectiveScopes, Group } = require('../../utils/rbac');
const { emitRawContentMessage } = require('../socket/xmsNotifications');

ffmpeg.setFfmpegPath(ffmpegPath);

// Phase 8 — Digital Marketing. Raw Contents (batch upload + status pipeline +
// real-time chat) and Ready to Upload (created only via the status toggle).
// NOT branch-scoped (confirmed 2026-07-09) — one shared pool across the org.
// Row-level scoping uses the same dataScope (mine/group/all) mechanism as
// CRM/Inventory/MIS — no new access-control system.

const RawContent     = dbConnection.models.rawContent     || dbConnection.model('rawContent',     rawContentSchema);
const RawContentChat = dbConnection.models.rawContentChat || dbConnection.model('rawContentChat', rawContentChatSchema);
const ReadyToUpload  = dbConnection.models.readyToUpload  || dbConnection.model('readyToUpload',  readyToUploadSchema);
const User           = dbConnection.models.user           || dbConnection.model('user',           userSchema);
const File           = dbConnection.models.file           || dbConnection.model('file',           fileSchema);

const dmUpload = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename:    (req, file, cb) => {
    const ext = file.originalname.match(/\..*$/)?.[0] || '';
    cb(null, `dm-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
}) });

const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────────────

function classifyFile(mimetype = '') {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype === 'application/pdf') return 'pdf';
  return 'other';
}

// Extracts a single preview frame from a video (10% in) — mirrors the
// Inventory variant-media-batch / CRM communication convention exactly.
function extractVideoThumbnail(videoPath, thumbFilename) {
  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .on('end', () => resolve(thumbFilename))
      .on('error', () => resolve(null))
      .screenshots({ count: 1, timestamps: ['10%'], filename: thumbFilename, folder: 'public/uploads', size: '300x?' });
  });
}

// Creates the File Manager doc AND returns a ready-to-embed subdocument shape
// (fileId + diskName + name + mimetype + thumbnail) — same convention as CRM's
// customerActivity.media[]: the parent doc snapshots the servable disk filename
// directly so the frontend never needs a second lookup (there is no generic
// GET /files/:id route — static files are served from /uploads/<diskName>).
async function makeFileDoc(file, userId, attachedToType, attachedToId) {
  const kind = classifyFile(file.mimetype);
  let thumbnail = null;
  if (kind === 'image') {
    try {
      const thumbFilename = `thumb-${file.filename}`;
      await sharp(file.path).resize(300).jpeg({ quality: 80 }).toFile(`public/uploads/${thumbFilename}`);
      thumbnail = thumbFilename;
    } catch (_) { /* non-fatal */ }
  } else if (kind === 'video') {
    thumbnail = await extractVideoThumbnail(file.path, `thumb-${file.filename}.png`);
  }

  const fileDoc = await File.create({
    name: file.originalname.split('.')[0],
    supFolder: null,
    metaData: file,
    format: file.originalname.slice(file.originalname.lastIndexOf('.') + 1),
    generatedBy: userId,
    thumbnail,
    scope: 'digitalMarketing',
    attachedTo: { type: attachedToType, id: attachedToId },
  });

  return {
    fileId: fileDoc._id,
    diskName: file.filename,
    name: file.originalname,
    mimetype: file.mimetype,
    thumbnail,
  };
}

async function getActorName(userId) {
  const actor = await User.findById(userId).select('firstName lastName').lean();
  return actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '';
}

function parseJsonArray(raw, fallback = []) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

// Row-level scope filter (mine/group/all) — same shape as CRM's buildScopeFilter.
async function buildScopeFilter(userId, dmScope) {
  if (!dmScope || dmScope === 'all') return null;
  if (dmScope === 'mine') return { owner: new mongoose.Types.ObjectId(userId) };
  const userGroups = await Group.find({ members: userId, deleteDate: null }).select('members').lean();
  const memberIds  = [...new Set(userGroups.flatMap((g) => (g.members || []).map(String)))];
  if (!memberIds.length) return { owner: new mongoose.Types.ObjectId(userId) };
  return { owner: { $in: memberIds.map((id) => new mongoose.Types.ObjectId(id)) } };
}

async function canAccessRecord(userId, dmScope, doc) {
  if (!dmScope || dmScope === 'all') return true;
  const uid = String(userId);
  if (dmScope === 'mine') return String(doc.owner) === uid;
  const userGroups = await Group.find({ members: new mongoose.Types.ObjectId(userId), deleteDate: null }).select('members').lean();
  const memberIds  = new Set(userGroups.flatMap((g) => (g.members || []).map(String)));
  memberIds.add(uid);
  return memberIds.has(String(doc.owner));
}

// Single chokepoint for every /raw-contents/:id route — loads the doc, 404s if
// missing/soft-deleted, and enforces row-level scope before the handler runs.
async function loadRawContent(req, res, next) {
  try {
    const doc = await RawContent.findOne({ _id: req.params.id, deleteDate: null });
    if (!doc) return res.status(404).json({ message: 'Raw content not found' });

    const scopes  = await getEffectiveScopes(req.user.id);
    const dmScope = scopes.digitalMarketing;
    if (!(await canAccessRecord(req.user.id, dmScope, doc))) {
      return res.status(403).json({ message: 'Not allowed to access this record' });
    }

    req.rawContent = doc;
    return next();
  } catch (err) {
    return next(err);
  }
}

async function loadReadyToUpload(req, res, next) {
  try {
    const doc = await ReadyToUpload.findOne({ _id: req.params.id, deleteDate: null });
    if (!doc) return res.status(404).json({ message: 'Ready-to-upload content not found' });

    const scopes  = await getEffectiveScopes(req.user.id);
    const dmScope = scopes.digitalMarketing;
    if (!(await canAccessRecord(req.user.id, dmScope, doc))) {
      return res.status(403).json({ message: 'Not allowed to access this record' });
    }

    req.readyToUpload = doc;
    return next();
  } catch (err) {
    return next(err);
  }
}

// ── Raw Contents ────────────────────────────────────────────────────────────

// GET /raw-contents — timeline list (newest first by default), scope-filtered
router.get('/raw-contents', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const userId = req.user.id;
    const scopes  = await getEffectiveScopes(userId);
    const dmScope = scopes.digitalMarketing;

    const { status = '', sort = 'insertDate', order = 'desc', page = 1, limit = 40 } = req.query;

    const query = { deleteDate: null };
    if (status) query.status = status;

    const scopeFilter = await buildScopeFilter(userId, dmScope);
    if (scopeFilter) Object.assign(query, scopeFilter);

    const sortField = ['insertDate', 'updateDate'].includes(sort) ? sort : 'insertDate';
    const sortDir   = order === 'asc' ? 1 : -1;
    const lim  = Math.min(Math.max(Number(limit) || 40, 1), 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [data, total] = await Promise.all([
      RawContent.find(query).sort({ [sortField]: sortDir, _id: -1 }).skip(skip).limit(lim).lean(),
      RawContent.countDocuments(query),
    ]);

    return res.status(200).json({ data, total, page: Number(page) || 1, limit: lim });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /raw-contents/:id — detail (+ scope check via loadRawContent)
router.get('/raw-contents/:id', verify, requirePermission('digitalMarketing:view'), loadRawContent, async (req, res) => {
  return res.status(200).json(req.rawContent);
});

// POST /raw-contents — batch upload. Multipart:
//   files[]              — the content files (image/video/voice/pdf/other)
//   descriptions          — JSON array of text descriptions, index-aligned with files
//   voiceDescriptionFlags — JSON array of booleans, index-aligned with files
//   voiceDescriptions[]   — voice recordings, IN ORDER, one per `true` flag above
//   language, useCase, platform — batch-level fields (useCase/platform default 'Anything')
router.post('/raw-contents', verify, requirePermission('digitalMarketing:rawContent:create'),
  dmUpload.fields([{ name: 'files', maxCount: 30 }, { name: 'voiceDescriptions', maxCount: 30 }]),
  async (req, res) => {
  try {
    const userId = req.user.id;
    const contentFiles = (req.files && req.files.files) || [];
    if (!contentFiles.length) {
      return res.status(400).json({ message: 'At least one file is required' });
    }

    const descriptions = parseJsonArray(req.body.descriptions, []);
    const voiceFlags    = parseJsonArray(req.body.voiceDescriptionFlags, []);
    const voiceFiles     = (req.files && req.files.voiceDescriptions) || [];

    const actorName = await getActorName(userId);

    const doc = await RawContent.create({
      language: req.body.language || '',
      useCase:  req.body.useCase  || 'Anything',
      platform: req.body.platform || 'Anything',
      status: 'working_on_it',
      files: [],
      owner: userId,
      createdBy: userId,
      createdByName: actorName,
      insertDate: new Date(),
    });

    let voiceCursor = 0;
    const fileEntries = [];
    for (let i = 0; i < contentFiles.length; i++) {
      const f = await makeFileDoc(contentFiles[i], userId, 'rawContent', doc._id);

      let voiceDescriptionFileId = null, voiceDescriptionDiskName = null;
      if (voiceFlags[i] && voiceCursor < voiceFiles.length) {
        const v = await makeFileDoc(voiceFiles[voiceCursor], userId, 'rawContent', doc._id);
        voiceDescriptionFileId   = v.fileId;
        voiceDescriptionDiskName = v.diskName;
        voiceCursor++;
      }

      fileEntries.push({
        fileId: f.fileId, diskName: f.diskName, name: f.name, mimetype: f.mimetype, thumbnail: f.thumbnail,
        description: descriptions[i] || '',
        voiceDescriptionFileId, voiceDescriptionDiskName,
        addedAt: new Date(),
      });
    }

    doc.files = fileEntries;
    await doc.save();

    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /raw-contents/:id — edit descriptive fields + add/remove files.
// Status changes to rejected/canceled/working_on_it go through this route too
// (status='ready_to_upload' is REJECTED here — that transition only happens
// atomically via POST /:id/ready-to-upload, see below).
router.put('/raw-contents/:id', verify, requirePermission('digitalMarketing:rawContent:edit'), loadRawContent,
  dmUpload.fields([{ name: 'files', maxCount: 30 }, { name: 'voiceDescriptions', maxCount: 30 }]),
  async (req, res) => {
  try {
    const userId = req.user.id;
    const doc    = req.rawContent;

    if (req.body.status !== undefined) {
      const nextStatus = req.body.status;
      if (nextStatus === 'ready_to_upload') {
        return res.status(400).json({ message: 'Use POST /raw-contents/:id/ready-to-upload to transition to ready_to_upload' });
      }
      if (!['working_on_it', 'rejected', 'canceled'].includes(nextStatus)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      doc.status = nextStatus;
    }

    if (req.body.language !== undefined) doc.language = req.body.language;
    if (req.body.useCase  !== undefined) doc.useCase  = req.body.useCase;
    if (req.body.platform !== undefined) doc.platform = req.body.platform;

    // Remove files by fileId (replace = remove + add in the same request)
    const removeFileIds = parseJsonArray(req.body.removeFileIds, []).map(String);
    if (removeFileIds.length) {
      doc.files = doc.files.filter((f) => !removeFileIds.includes(String(f.fileId)));
    }

    // Update a single file's text description in place (no file re-upload)
    if (req.body.updateDescriptionFileId && req.body.updateDescriptionText !== undefined) {
      const entry = doc.files.find((f) => String(f.fileId) === String(req.body.updateDescriptionFileId));
      if (entry) entry.description = req.body.updateDescriptionText;
    }

    // Add / replace files (same multipart shape as create)
    const newFiles = (req.files && req.files.files) || [];
    if (newFiles.length) {
      const descriptions = parseJsonArray(req.body.descriptions, []);
      const voiceFlags    = parseJsonArray(req.body.voiceDescriptionFlags, []);
      const voiceFiles     = (req.files && req.files.voiceDescriptions) || [];

      let voiceCursor = 0;
      for (let i = 0; i < newFiles.length; i++) {
        const f = await makeFileDoc(newFiles[i], userId, 'rawContent', doc._id);
        let voiceDescriptionFileId = null, voiceDescriptionDiskName = null;
        if (voiceFlags[i] && voiceCursor < voiceFiles.length) {
          const v = await makeFileDoc(voiceFiles[voiceCursor], userId, 'rawContent', doc._id);
          voiceDescriptionFileId   = v.fileId;
          voiceDescriptionDiskName = v.diskName;
          voiceCursor++;
        }
        doc.files.push({
          fileId: f.fileId, diskName: f.diskName, name: f.name, mimetype: f.mimetype, thumbnail: f.thumbnail,
          description: descriptions[i] || '',
          voiceDescriptionFileId, voiceDescriptionDiskName,
          addedAt: new Date(),
        });
      }
    }

    doc.updateDate = new Date();
    doc.updatedBy  = userId;
    await doc.save();

    return res.status(200).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /raw-contents/:id — soft delete
router.delete('/raw-contents/:id', verify, requirePermission('digitalMarketing:rawContent:delete'), loadRawContent, async (req, res) => {
  try {
    await RawContent.updateOne({ _id: req.rawContent._id }, { $set: { deleteDate: new Date() } });
    return res.status(200).json({ message: 'Deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /raw-contents/:id/ready-to-upload — the ONLY way a readyToUpload record
// is created. Atomically creates it AND flips the raw content's status.
router.post('/raw-contents/:id/ready-to-upload', verify, requirePermission('digitalMarketing:rawContent:edit'), loadRawContent,
  dmUpload.fields([{ name: 'files', maxCount: 30 }]),
  async (req, res) => {
  try {
    const userId = req.user.id;
    const doc    = req.rawContent;

    if (doc.status === 'ready_to_upload' && doc.readyToUploadId) {
      return res.status(409).json({ message: 'This raw content already has a ready-to-upload record' });
    }

    const files = (req.files && req.files.files) || [];
    if (!files.length) {
      return res.status(400).json({ message: 'At least one edited file is required' });
    }

    const actorName = await getActorName(userId);

    const ready = await ReadyToUpload.create({
      rawContentId: doc._id,
      files: [],
      language: req.body.language || '',
      platform: req.body.platform || '',
      caption:  req.body.caption  || '',
      owner: userId,
      createdBy: userId,
      createdByName: actorName,
      insertDate: new Date(),
    });

    const fileEntries = [];
    for (const file of files) {
      const f = await makeFileDoc(file, userId, 'readyToUpload', ready._id);
      fileEntries.push({ fileId: f.fileId, diskName: f.diskName, name: f.name, mimetype: f.mimetype, thumbnail: f.thumbnail, addedAt: new Date() });
    }
    ready.files = fileEntries;
    await ready.save();

    doc.status = 'ready_to_upload';
    doc.readyToUploadId = ready._id;
    doc.updateDate = new Date();
    doc.updatedBy  = userId;
    await doc.save();

    return res.status(201).json({ rawContent: doc, readyToUpload: ready });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Raw content chat (real-time, one Socket.io room per rawContentId) ────────

// GET /raw-contents/:id/chat — message history, oldest first, paginated
router.get('/raw-contents/:id/chat', verify, requirePermission('digitalMarketing:rawContent:chat'), loadRawContent, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const lim  = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [data, total] = await Promise.all([
      RawContentChat.find({ rawContentId: req.rawContent._id })
        .sort({ date: -1 }).skip(skip).limit(lim).lean(),
      RawContentChat.countDocuments({ rawContentId: req.rawContent._id }),
    ]);

    // return oldest-first within the page (client renders top-to-bottom)
    return res.status(200).json({ data: data.reverse(), total, page: Number(page) || 1, limit: lim });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /raw-contents/:id/chat — send a text, voice, or file message
router.post('/raw-contents/:id/chat', verify, requirePermission('digitalMarketing:rawContent:chat'), loadRawContent,
  dmUpload.single('file'),
  async (req, res) => {
  try {
    const userId    = req.user.id;
    const actorName = await getActorName(userId);
    const body      = req.body.body || '';

    if (!body.trim() && !req.file) {
      return res.status(400).json({ message: 'Message must have text or an attachment' });
    }

    let type = 'text';
    let fileId = null, fileName = '', fileMime = '';

    let fileDiskName = '';
    if (req.file) {
      const f = await makeFileDoc(req.file, userId, 'rawContentChat', req.rawContent._id);
      const kind = classifyFile(req.file.mimetype);
      type = kind === 'audio' ? 'voice' : 'file';
      fileId       = f.fileId;
      fileDiskName = f.diskName;
      fileName     = f.name;
      fileMime     = f.mimetype;
    }

    const message = await RawContentChat.create({
      rawContentId: req.rawContent._id,
      senderId: userId,
      senderName: actorName,
      type, body, fileId, fileDiskName, fileName, fileMime,
      date: new Date(),
    });

    emitRawContentMessage(req.rawContent._id, message);

    return res.status(201).json(message);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Ready to Upload ───────────────────────────────────────────────────────────

// GET /ready-to-upload — timeline list, scope-filtered
router.get('/ready-to-upload', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const userId  = req.user.id;
    const scopes  = await getEffectiveScopes(userId);
    const dmScope = scopes.digitalMarketing;

    const { sort = 'insertDate', order = 'desc', page = 1, limit = 40 } = req.query;

    const query = { deleteDate: null };
    const scopeFilter = await buildScopeFilter(userId, dmScope);
    if (scopeFilter) Object.assign(query, scopeFilter);

    const sortField = ['insertDate', 'updateDate'].includes(sort) ? sort : 'insertDate';
    const sortDir   = order === 'asc' ? 1 : -1;
    const lim  = Math.min(Math.max(Number(limit) || 40, 1), 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [data, total] = await Promise.all([
      ReadyToUpload.find(query).sort({ [sortField]: sortDir, _id: -1 }).skip(skip).limit(lim).lean(),
      ReadyToUpload.countDocuments(query),
    ]);

    return res.status(200).json({ data, total, page: Number(page) || 1, limit: lim });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /ready-to-upload/:id — detail (+ scope check), includes the source raw content
router.get('/ready-to-upload/:id', verify, requirePermission('digitalMarketing:view'), loadReadyToUpload, async (req, res) => {
  try {
    const source = await RawContent.findOne({ _id: req.readyToUpload.rawContentId, deleteDate: null })
      .select('language useCase platform status insertDate createdByName').lean();
    return res.status(200).json({ ...req.readyToUpload.toObject(), rawContent: source });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /ready-to-upload/:id — edit files/language/platform/caption
router.put('/ready-to-upload/:id', verify, requirePermission('digitalMarketing:readyToUpload:edit'), loadReadyToUpload,
  dmUpload.fields([{ name: 'files', maxCount: 30 }]),
  async (req, res) => {
  try {
    const userId = req.user.id;
    const doc    = req.readyToUpload;

    if (req.body.language !== undefined) doc.language = req.body.language;
    if (req.body.platform !== undefined) doc.platform = req.body.platform;
    if (req.body.caption  !== undefined) doc.caption  = req.body.caption;

    const removeFileIds = parseJsonArray(req.body.removeFileIds, []).map(String);
    if (removeFileIds.length) {
      doc.files = doc.files.filter((f) => !removeFileIds.includes(String(f.fileId)));
    }

    const newFiles = (req.files && req.files.files) || [];
    for (const file of newFiles) {
      const f = await makeFileDoc(file, userId, 'readyToUpload', doc._id);
      doc.files.push({ fileId: f.fileId, diskName: f.diskName, name: f.name, mimetype: f.mimetype, thumbnail: f.thumbnail, addedAt: new Date() });
    }

    doc.updateDate = new Date();
    doc.updatedBy  = userId;
    await doc.save();

    return res.status(200).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /ready-to-upload/:id — soft delete
router.delete('/ready-to-upload/:id', verify, requirePermission('digitalMarketing:readyToUpload:delete'), loadReadyToUpload, async (req, res) => {
  try {
    await ReadyToUpload.updateOne({ _id: req.readyToUpload._id }, { $set: { deleteDate: new Date() } });
    return res.status(200).json({ message: 'Deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
