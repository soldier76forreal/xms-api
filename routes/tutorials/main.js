const express  = require('express');
const multer   = require('multer');
const { blockExecutableFiles, uploadLimits, MAX_BATCH_FILES } = require('../../utils/uploadGuards');
const sharp    = require('sharp');
const ffmpeg   = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

const dbConnection      = require('../../connections/xmsPr');
const tutorialSchema    = require('../../models/tutorialModel');
const tutorialActivitySchema = require('../../models/tutorialActivityModel');
const permissionSchema  = require('../../models/permissionModel');
const userSchema        = require('../../models/userModel');
const fileSchema        = require('../../models/fileModel');

const verify = require('../users/verifyToken');
const { requirePermission, getUsersWithPermission } = require('../../utils/rbac');
const { sendNotificationToUser } = require('../socket/xmsNotifications');

ffmpeg.setFfmpegPath(ffmpegPath);

// Tutorial Center — in-app help material (video/image/document) for every
// section of the app. See models/tutorialModel.js for the section/tags design.
// No row-level dataScope — everyone with tutorials:view sees every tutorial.

const Tutorial   = dbConnection.models.tutorial   || dbConnection.model('tutorial',   tutorialSchema);
const TutorialActivity = dbConnection.models.tutorialActivity || dbConnection.model('tutorialActivity', tutorialActivitySchema);
const Permission = dbConnection.models.permission || dbConnection.model('permission', permissionSchema);
const User       = dbConnection.models.user       || dbConnection.model('user',       userSchema);
const File       = dbConnection.models.file       || dbConnection.model('file',       fileSchema);

const tutorialUpload = multer({ limits: uploadLimits, fileFilter: blockExecutableFiles, storage: multer.diskStorage({
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

// Best-effort audit row — never blocks the actual request (same convention as
// digitalMarketing/main.js's logDmActivity and CRM's writeActivity).
async function writeActivity(tutorialId, type, userId, actorName, meta = {}) {
  try {
    await TutorialActivity.create({
      tutorialId, type, actorId: userId, actorName,
      field: meta.field, oldValue: meta.oldValue ?? null, newValue: meta.newValue ?? null,
      body: meta.body,
      date: new Date(),
    });
  } catch (_) { /* audit trail is non-critical */ }
}

// Announce a newly-published tutorial to everyone who can see tutorials, minus
// the uploader. Fire-and-forget, mirroring broadcastToDmViewers in
// digitalMarketing/main.js — text is translated per RECIPIENT inside
// sendNotificationToUser, so this never builds English strings itself.
function broadcastNewTutorial(actorId, actorName, tutorial) {
  (async () => {
    try {
      const userIds = await getUsersWithPermission('tutorials:view');
      const recipients = userIds.filter((id) => String(id) !== String(actorId));
      await Promise.all(recipients.map((id) =>
        sendNotificationToUser(id, {
          fromId: actorId, fromName: actorName, type: 'tutorial',
          textKey: 'tutorialCreated',
          textParams: { actorName, tutorialTitle: tutorial.title },
          entityType: 'tutorial', entityId: tutorial._id,
        })
      ));
    } catch (_) { /* best-effort */ }
  })();
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

// GET /tutorials/:id/views — the "who watched this" roster + raw view log.
// MUST stay above GET /:id? No — '/:id/views' can't be captured by '/:id'
// (different segment count), but it is kept adjacent for readability.
// Returns one row PER VIEWER (de-duplicated, most-recent first) carrying that
// person's watch count and last-watched time, plus the total raw view count.
router.get('/:id/views', verify, requirePermission('tutorials:view'), async (req, res) => {
  try {
    const tutorial = await Tutorial.findOne({ _id: req.params.id, deleteDate: null }).select('_id').lean();
    if (!tutorial) return res.status(404).json({ message: 'Tutorial not found' });

    const rows = await TutorialActivity.find({ tutorialId: req.params.id, type: 'viewed' })
      .sort({ date: -1 }).limit(1000).lean();

    // De-duplicate to one entry per viewer, keeping their most recent watch
    // (rows are already newest-first, so the first hit per actor wins).
    const byViewer = new Map();
    rows.forEach((r) => {
      const key = String(r.actorId || r.actorName || 'unknown');
      const seen = byViewer.get(key);
      if (seen) { seen.count += 1; return; }
      byViewer.set(key, {
        actorId: r.actorId || null,
        actorName: r.actorName || '',
        lastViewedAt: r.date,
        count: 1,
      });
    });

    const viewers = Array.from(byViewer.values());
    return res.status(200).json({
      viewers,
      totalViews: rows.length,
      uniqueViewers: viewers.length,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /tutorials/:id/activity — full audit trail for one tutorial
// (created/updated/file changes/views), newest first.
router.get('/:id/activity', verify, requirePermission('tutorials:view'), async (req, res) => {
  try {
    const rows = await TutorialActivity.find({ tutorialId: req.params.id })
      .sort({ date: -1 }).limit(200).lean();
    return res.status(200).json(rows);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /tutorials/:id — detail. Opening the detail IS the "watch" event, so it
// writes a 'viewed' activity row (same pattern as CRM's GET /customers/:id and
// digitalMarketing's GET /raw-contents/:id). Unlike CRM it does NOT skip the
// owner: the uploader re-watching their own tutorial is still a real view, and
// the roster is about who has seen the material, not about lead ownership.
router.get('/:id', verify, requirePermission('tutorials:view'), async (req, res) => {
  try {
    const doc = await Tutorial.findOne({ _id: req.params.id, deleteDate: null }).lean();
    if (!doc) return res.status(404).json({ message: 'Tutorial not found' });

    // Fire-and-forget — a failed audit write must never break the read.
    getActorName(req.user.id)
      .then((name) => writeActivity(doc._id, 'viewed', req.user.id, name))
      .catch(() => {});

    return res.status(200).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /tutorials — create. Multipart: title, description, language, section,
// tags (JSON array string), files[] (image/video/document, multiple).
router.post('/', verify, requirePermission('tutorials:upload'),
  tutorialUpload.fields([{ name: 'files', maxCount: MAX_BATCH_FILES }]),
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

    await writeActivity(doc._id, 'created', userId, actorName, { newValue: { title: doc.title, section: doc.section } });
    broadcastNewTutorial(userId, actorName, doc);

    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /tutorials/:id — edit metadata + add/remove files
router.put('/:id', verify, requirePermission('tutorials:edit'),
  tutorialUpload.fields([{ name: 'files', maxCount: MAX_BATCH_FILES }]),
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

    const actorName = await getActorName(userId);
    await writeActivity(doc._id, 'updated', userId, actorName, { newValue: { title: doc.title, section: doc.section } });
    if (removeFileIds.length) {
      await writeActivity(doc._id, 'file_removed', userId, actorName, { newValue: { count: removeFileIds.length } });
    }
    if (uploadedFiles.length) {
      await writeActivity(doc._id, 'file_added', userId, actorName, { newValue: { count: uploadedFiles.length } });
    }

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

    const actorName = await getActorName(req.user.id);
    await writeActivity(doc._id, 'deleted', req.user.id, actorName, { oldValue: { title: doc.title } });

    return res.status(200).json({ message: 'Tutorial deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
// Reused by routes/uploads/purposes.js so a resumable upload finishes through
// the SAME file-processing path a classic multipart upload does.
module.exports.makeFileDoc = makeFileDoc;
module.exports.Tutorial = Tutorial;
