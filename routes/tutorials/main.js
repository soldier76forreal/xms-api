const express  = require('express');
const multer   = require('multer');
const sharp    = require('sharp');
const ffmpeg   = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

const dbConnection      = require('../../connections/xmsPr');
const tutorialSchema    = require('../../models/tutorialModel');
const permissionSchema  = require('../../models/permissionModel');
const userSchema        = require('../../models/userModel');
const fileSchema        = require('../../models/fileModel');

const verify = require('../users/verifyToken');
const { requirePermission } = require('../../utils/rbac');

ffmpeg.setFfmpegPath(ffmpegPath);

// Tutorial Center — in-app help material (video/image/document) for every
// section of the app. See models/tutorialModel.js for the section/tags design.
// No row-level dataScope — everyone with tutorials:view sees every tutorial.

const Tutorial   = dbConnection.models.tutorial   || dbConnection.model('tutorial',   tutorialSchema);
const Permission = dbConnection.models.permission || dbConnection.model('permission', permissionSchema);
const User       = dbConnection.models.user       || dbConnection.model('user',       userSchema);
const File       = dbConnection.models.file       || dbConnection.model('file',       fileSchema);

const tutorialUpload = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename:    (req, file, cb) => {
    const ext = file.originalname.match(/\..*$/)?.[0] || '';
    cb(null, `tutorial-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
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

// Extracts a single preview frame from a video (10% in) — same convention as
// digitalMarketing/main.js's extractVideoThumbnail.
function extractVideoThumbnail(videoPath, thumbFilename) {
  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .on('end', () => resolve(thumbFilename))
      .on('error', () => resolve(null))
      .screenshots({ count: 1, timestamps: ['10%'], filename: thumbFilename, folder: 'public/uploads', size: '300x?' });
  });
}

// Creates the File Manager doc AND returns a ready-to-embed subdocument shape
// — same convention as digitalMarketing/main.js's makeFileDoc.
async function makeFileDoc(file, userId, tutorialId) {
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
    scope: 'tutorials',
    attachedTo: { type: 'tutorial', id: tutorialId },
  });

  return {
    fileId: fileDoc._id,
    diskName: file.filename,
    name: file.originalname,
    mimetype: file.mimetype,
    kind,
    thumbnail,
  };
}

async function getActorName(userId) {
  const actor = await User.findById(userId).select('firstName lastName').lean();
  return actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '';
}

function parseJsonArray(raw, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

// ── GET /tutorials — list, filters: section, tag, language, search ───────────
router.get('/', verify, requirePermission('tutorials:view'), async (req, res) => {
  try {
    const { section = '', tag = '', language = '', search = '', page = 1, limit = 40 } = req.query;

    const query = { deleteDate: null };
    if (section) query.section = section;
    if (tag)      query.tags = tag;
    if (language) query.language = language;
    if (search)   query.title = { $regex: search, $options: 'i' };

    const lim  = Math.min(Math.max(Number(limit) || 40, 1), 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [data, total] = await Promise.all([
      Tutorial.find(query).sort({ insertDate: -1 }).skip(skip).limit(lim).lean(),
      Tutorial.countDocuments(query),
    ]);

    return res.status(200).json({ data, total, page: Number(page) || 1, limit: lim });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /tutorials/action-tags — the permission catalog grouped by module, used
// to populate the tag picker. MUST be registered before GET /tutorials/:id so
// 'action-tags' is never captured as an :id (same lesson as CRM's
// /customers/bulk vs /customers/:id). Deliberately NOT requireSuperAdmin() like
// routes/rbac/permissions.js's GET /permissions — a plain tutorials:view/upload
// user needs this list too, and it carries no sensitive data (just action
// names/descriptions).
router.get('/action-tags', verify, requirePermission('tutorials:view'), async (req, res) => {
  try {
    const perms = await Permission.find().sort('module key').lean();
    const byModule = {};
    perms.forEach((p) => {
      if (!byModule[p.module]) byModule[p.module] = [];
      byModule[p.module].push({ key: p.key, description: p.description });
    });
    return res.status(200).json({ byModule });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /tutorials/:id — detail
router.get('/:id', verify, requirePermission('tutorials:view'), async (req, res) => {
  try {
    const doc = await Tutorial.findOne({ _id: req.params.id, deleteDate: null }).lean();
    if (!doc) return res.status(404).json({ message: 'Tutorial not found' });
    return res.status(200).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /tutorials — create. Multipart: title, description, language, section,
// tags (JSON array string), files[] (image/video/document, multiple).
router.post('/', verify, requirePermission('tutorials:upload'),
  tutorialUpload.fields([{ name: 'files', maxCount: 20 }]),
  async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, description = '', language, section } = req.body;
    const tags = parseJsonArray(req.body.tags, []);
    const uploadedFiles = (req.files && req.files.files) || [];

    if (!title || !title.trim())            return res.status(400).json({ message: 'title is required' });
    if (!['en', 'fa', 'ar'].includes(language)) return res.status(400).json({ message: 'A valid language is required' });
    if (!['crm', 'mis', 'inventory', 'digitalMarketing', 'users', 'files', 'general'].includes(section)) {
      return res.status(400).json({ message: 'A valid section is required' });
    }
    if (!uploadedFiles.length) return res.status(400).json({ message: 'At least one file is required' });

    const actorName = await getActorName(userId);

    const doc = await Tutorial.create({
      title: title.trim(), description, language, section, tags,
      files: [],
      owner: userId, createdBy: userId, createdByName: actorName,
      insertDate: new Date(),
    });

    const fileEntries = [];
    for (const f of uploadedFiles) {
      fileEntries.push(await makeFileDoc(f, userId, doc._id));
    }
    doc.files = fileEntries;
    await doc.save();

    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /tutorials/:id — edit metadata + add/remove files
router.put('/:id', verify, requirePermission('tutorials:edit'),
  tutorialUpload.fields([{ name: 'files', maxCount: 20 }]),
  async (req, res) => {
  try {
    const userId = req.user.id;
    const doc = await Tutorial.findOne({ _id: req.params.id, deleteDate: null });
    if (!doc) return res.status(404).json({ message: 'Tutorial not found' });

    if (req.body.title !== undefined)       doc.title = req.body.title;
    if (req.body.description !== undefined) doc.description = req.body.description;
    if (req.body.language !== undefined)    doc.language = req.body.language;
    if (req.body.section !== undefined)     doc.section = req.body.section;
    if (req.body.tags !== undefined)        doc.tags = parseJsonArray(req.body.tags, doc.tags);

    const removeFileIds = parseJsonArray(req.body.removeFileIds, []);
    if (removeFileIds.length) {
      doc.files = doc.files.filter((f) => !removeFileIds.map(String).includes(String(f.fileId)));
      await File.updateMany({ _id: { $in: removeFileIds } }, { $set: { deleteDate: new Date() } });
    }

    const uploadedFiles = (req.files && req.files.files) || [];
    for (const f of uploadedFiles) {
      doc.files.push(await makeFileDoc(f, userId, doc._id));
    }

    doc.updatedBy = userId;
    doc.updateDate = new Date();
    await doc.save();

    return res.status(200).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /tutorials/:id — soft-delete
router.delete('/:id', verify, requirePermission('tutorials:delete'), async (req, res) => {
  try {
    const doc = await Tutorial.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: { deleteDate: new Date() } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: 'Tutorial not found' });
    return res.status(200).json({ message: 'Tutorial deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
