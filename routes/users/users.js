const express    = require('express');
const jwt_decode = require('jwt-decode');
const mongoose   = require('mongoose');
const path       = require('path');
const crypto     = require('crypto');
const multer     = require('multer');
const { blockExecutableFiles, imagesOnly, imageUploadLimits, uploadLimits, MAX_BATCH_FILES } = require('../../utils/uploadGuards');
const sharp      = require('sharp');
const ffmpeg     = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

const userModel              = require('../../models/userModel');
const notficationModel       = require('../../models/notficationsModel');
const invoiceModel           = require('../../models/invoiceModel');
const fileModel              = require('../../models/fileModel');
const userNoteModel            = require('../../models/userNoteModel');
const inventoryChangeLogSchema = require('../../models/inventoryChangeLogModel');
const inventoryProductSchema   = require('../../models/inventoryProductModel');
const customerActivitySchema   = require('../../models/customerActivityModel');
const customerSchema           = require('../../models/customerModel');
const invoiceActivitySchema    = require('../../models/invoiceActivityModel');
const misInvoiceSchema         = require('../../models/misInvoiceModel');
const dmActivitySchema         = require('../../models/dmActivityModel');
const rawContentSchema         = require('../../models/rawContentModel');
const readyToUploadSchema      = require('../../models/readyToUploadModel');
const userJobReportModel       = require('../../models/userJobReportModel');
const dbConnection        = require('../../connections/xmsPr');
const verify              = require('./verifyToken');
const { requirePermission, getEffectivePermissions, getEffectiveScopes, clearPermissionCache, isSuperAdmin, assertBranchAccess, UserAccess, Role, Group } = require('../../utils/rbac');
const { sendNotificationToUser } = require('../socket/xmsNotifications');

const dotenv = require('dotenv');
dotenv.config();

ffmpeg.setFfmpegPath(ffmpegPath);

const userM        = dbConnection.model('user',       userModel);
const notfication  = dbConnection.model('notfication', notficationModel);
const invoice      = dbConnection.model('invoice',     invoiceModel);
const File         = dbConnection.model('file',        fileModel);
const UserNote     = dbConnection.models.userNote || dbConnection.model('userNote', userNoteModel);
const InvChangeLog = dbConnection.models.inventoryChangeLog || dbConnection.model('inventoryChangeLog', inventoryChangeLogSchema);
const InvProduct   = dbConnection.models.inventoryProduct   || dbConnection.model('inventoryProduct',   inventoryProductSchema);
const CustomerActivity = dbConnection.models.customerActivity || dbConnection.model('customerActivity', customerActivitySchema);
const Customer         = dbConnection.models.customer         || dbConnection.model('customer',         customerSchema);
const InvoiceActivity  = dbConnection.models.invoiceActivity   || dbConnection.model('invoiceActivity',  invoiceActivitySchema);
const MisInvoice       = dbConnection.models.misInvoice        || dbConnection.model('misInvoice',       misInvoiceSchema);
const DmActivity       = dbConnection.models.dmActivity        || dbConnection.model('dmActivity',       dmActivitySchema);
const RawContent       = dbConnection.models.rawContent        || dbConnection.model('rawContent',       rawContentSchema);
const ReadyToUpload    = dbConnection.models.readyToUpload     || dbConnection.model('readyToUpload',    readyToUploadSchema);
const UserJobReport    = dbConnection.models.userJobReport     || dbConnection.model('userJobReport',    userJobReportModel);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename:    (req, file, cb) => cb(null, `avatar-${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: imageUploadLimits, fileFilter: imagesOnly });

// Personal notes attachments — voice/video/photo/document, up to 5 per note.
const notesStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename:    (req, file, cb) => {
    const ext = file.originalname.match(/\..*$/)?.[0] || '';
    cb(null, `note-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const notesUpload = multer({ storage: notesStorage, limits: uploadLimits, fileFilter: blockExecutableFiles });

// Extracts a single preview frame from a video (10% in) — mirrors the
// Inventory variant-media-batch / CRM communication-tab convention exactly.
function extractNoteVideoThumbnail(videoPath, thumbFilename) {
  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .on('end', () => resolve(thumbFilename))
      .on('error', () => resolve(null))
      .screenshots({ count: 1, timestamps: ['10%'], filename: thumbFilename, folder: 'public/uploads', size: '300x?' });
  });
}

const router = express.Router();

// ── GET /users/me/permissions — effective permission set for the caller ────────
// Must be defined BEFORE /:id to avoid "me" being captured as an ObjectId.
// Any authenticated user can call this (no permission guard — it's their own data).
router.get('/me/permissions', verify, async (req, res) => {
  try {
    const [perms, scopes, superAdmin] = await Promise.all([
      getEffectivePermissions(req.user.id),
      getEffectiveScopes(req.user.id),
      isSuperAdmin(req.user.id),
    ]);
    return res.status(200).json({ permissions: Array.from(perms), dataScopes: scopes, isSuperAdmin: superAdmin });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /users/me/profile — self-service: edit your OWN name ──────────────────
// Any authenticated user, no permission key — it's their own record. Only
// firstName/lastName are writable here (roles/branches/validation stay
// admin-controlled through PUT /users/:id). Defined before /:id routes so
// 'me' is never captured as an ObjectId.
router.put('/me/profile', verify, async (req, res) => {
  try {
    const setFields = { updateDate: new Date() };
    if (typeof req.body.firstName === 'string' && req.body.firstName.trim()) setFields.firstName = req.body.firstName.trim();
    if (typeof req.body.lastName  === 'string' && req.body.lastName.trim())  setFields.lastName  = req.body.lastName.trim();

    const updated = await userM.findOneAndUpdate(
      { _id: req.user.id, deleteDate: null },
      { $set: setFields },
      { new: true }
    ).select('firstName lastName phoneNumber profileImage');
    if (!updated) return res.status(404).json({ message: 'User not found' });
    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /users/me/language — self-service: persist your OWN UI language ───────
// Fired on every switcher change (see languageContext.js) so the value is
// visible to others (Users list/detail indicator), not just this browser's
// localStorage. No permission key — it's the caller's own preference.
const VALID_LANGUAGES = ['en', 'fa', 'ar'];
// ── GET /users/me/ui-prefs — this user's saved sidebar widths ────────────────
// Server-side rather than localStorage so a resized sidebar follows the person
// to another machine, same reasoning as filterMemory. No permission key — it
// is the caller's own preference, like /me/language above.
router.get('/me/ui-prefs', verify, async (req, res) => {
  try {
    const doc = await userM.findById(req.user.id).select('uiPrefs').lean();
    return res.status(200).json({ sidebarWidths: (doc && doc.uiPrefs && doc.uiPrefs.sidebarWidths) || {} });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /users/me/ui-prefs — save sidebar widths ────────────────────────────
// Merges rather than replaces, so two sections saving concurrently can't wipe
// each other's entry. Values are clamped server-side too — a width is a UI
// preference, but it still shouldn't be possible to store nonsense.
router.put('/me/ui-prefs', verify, async (req, res) => {
  try {
    const incoming = req.body && req.body.sidebarWidths;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ message: 'sidebarWidths object is required' });
    }

    const doc = await userM.findById(req.user.id).select('uiPrefs').lean();
    const current = (doc && doc.uiPrefs && doc.uiPrefs.sidebarWidths) || {};

    const merged = { ...current };
    for (const [key, value] of Object.entries(incoming)) {
      const px = Number(value);
      if (!Number.isFinite(px)) continue;
      merged[String(key).slice(0, 64)] = Math.min(900, Math.max(40, Math.round(px)));
    }

    await userM.updateOne(
      { _id: req.user.id },
      { $set: { 'uiPrefs.sidebarWidths': merged, updateDate: new Date() } }
    );
    return res.status(200).json({ sidebarWidths: merged });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /users/me/last-seen — this user's per-list "seen up to" timestamps ──
// Powers the unread-record indicator (a dot + tinted row) on every record
// list — a record inserted by someone ELSE after the stored value for that
// section is "unread". No permission key — the caller's own read-state.
router.get('/me/last-seen', verify, async (req, res) => {
  try {
    const doc = await userM.findById(req.user.id).select('recordsLastSeenAt').lean();
    return res.status(200).json({ recordsLastSeenAt: (doc && doc.recordsLastSeenAt) || {} });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /users/me/last-seen — mark one section "seen up to now" ────────────
// Called once a list finishes loading (see tools/hooks/useUnreadRecords.js).
// Always stamps the SERVER's current time — never a client-supplied one, so a
// skewed device clock can't make later inserts wrongly look already-seen.
router.put('/me/last-seen', verify, async (req, res) => {
  try {
    const { section } = req.body;
    if (!section || typeof section !== 'string') {
      return res.status(400).json({ message: 'section is required' });
    }
    const key = section.slice(0, 64);
    const now = new Date();
    await userM.updateOne(
      { _id: req.user.id },
      { $set: { [`recordsLastSeenAt.${key}`]: now } }
    );
    return res.status(200).json({ section: key, lastSeenAt: now });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/me/language', verify, async (req, res) => {
  try {
    const { language } = req.body;
    if (!VALID_LANGUAGES.includes(language)) {
      return res.status(400).json({ message: `language must be one of: ${VALID_LANGUAGES.join(', ')}` });
    }
    const updated = await userM.findOneAndUpdate(
      { _id: req.user.id, deleteDate: null },
      { $set: { language, updateDate: new Date() } },
      { new: true }
    ).select('language');
    if (!updated) return res.status(404).json({ message: 'User not found' });
    return res.status(200).json({ language: updated.language });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /users/me/notification-prefs — read your OWN push preferences ─────────
const NOTIF_PREF_KEYS = ['tasks', 'assignments', 'invoices', 'dmChat', 'readyToUpload'];
const DEFAULT_NOTIF_PREFS = { tasks: true, assignments: true, invoices: true, dmChat: true, readyToUpload: true };

router.get('/me/notification-prefs', verify, async (req, res) => {
  try {
    const u = await userM.findById(req.user.id).select('notificationPrefs pushEnabled telegram.enabled').lean();
    return res.status(200).json({
      ...DEFAULT_NOTIF_PREFS, ...(u?.notificationPrefs || {}),
      pushEnabled: u?.pushEnabled !== false,
      telegramEnabled: u?.telegram?.enabled !== false,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /users/me/notification-prefs — set your OWN push preferences ──────────
// Also carries the two channel-level toggles (pushEnabled / telegramEnabled) —
// ON/OFF for the whole channel, independent of both the per-category prefs
// above AND (for Telegram) whether the account is linked at all.
router.put('/me/notification-prefs', verify, async (req, res) => {
  try {
    const setFields = { updateDate: new Date() };
    for (const k of NOTIF_PREF_KEYS) {
      if (req.body[k] !== undefined) setFields[`notificationPrefs.${k}`] = !!req.body[k];
    }
    if (req.body.pushEnabled !== undefined) setFields.pushEnabled = !!req.body.pushEnabled;
    if (req.body.telegramEnabled !== undefined) setFields['telegram.enabled'] = !!req.body.telegramEnabled;

    const updated = await userM.findOneAndUpdate(
      { _id: req.user.id, deleteDate: null },
      { $set: setFields },
      { new: true }
    ).select('notificationPrefs pushEnabled telegram.enabled');
    if (!updated) return res.status(404).json({ message: 'User not found' });
    return res.status(200).json({
      ...DEFAULT_NOTIF_PREFS, ...(updated.notificationPrefs || {}),
      pushEnabled: updated.pushEnabled !== false,
      telegramEnabled: updated.telegram?.enabled !== false,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── POST /users/me/avatar — self-service profile picture ─────────────────────
router.post('/me/avatar', verify, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    let thumbnailFilename = null;
    if (req.file.mimetype.startsWith('image/')) {
      try {
        thumbnailFilename = `thumb-${req.file.filename}`;
        await sharp(req.file.path)
          .resize(200, 200, { fit: 'cover' })
          .jpeg({ quality: 80 })
          .toFile(path.join('public/uploads', thumbnailFilename));
      } catch (_) { thumbnailFilename = null; }
    }

    const fileDoc = await File.create({
      name:        req.file.originalname,
      metaData:    req.file,
      format:      path.extname(req.file.originalname).slice(1),
      generatedBy: req.user.id,
      thumbnail:   thumbnailFilename,
      scope:       'users',
      attachedTo:  { type: 'user', id: req.user.id },
    });

    const profileImage = {
      fileId:    fileDoc._id,
      url:       `/uploads/${req.file.filename}`,
      thumbnail: thumbnailFilename ? `/uploads/${thumbnailFilename}` : null,
      filename:  req.file.filename,
    };

    await userM.findOneAndUpdate(
      { _id: req.user.id, deleteDate: null },
      { $set: { profileImage } }
    );

    return res.status(200).json({ profileImage });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Personal Notes — strictly private, no admin override ──────────────────────
// Every route below is scoped to req.user.id and ONLY req.user.id. There is no
// list/read route for another user's notes anywhere in the app, not even for
// superAdmin — that is deliberate, not an oversight. No permission key either:
// this isn't a capability that varies by role, every user manages their own.

// GET /users/me/notes — paginated list of the caller's own notes.
router.get('/me/notes', verify, async (req, res) => {
  try {
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Number(req.query.limit) || 20);

    const filter = { userId: req.user.id, deleteDate: null };
    const [data, total] = await Promise.all([
      UserNote.find(filter).sort({ insertDate: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      UserNote.countDocuments(filter),
    ]);
    return res.status(200).json({ data, total });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /users/me/notes — create a note (text + up to 5 voice/video/photo/document attachments).
router.post('/me/notes', verify, notesUpload.array('files', MAX_BATCH_FILES), async (req, res) => {
  try {
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    const uploadedFiles = req.files || [];
    if (!body && uploadedFiles.length === 0) {
      return res.status(400).json({ message: 'A note needs text or at least one attachment' });
    }

    const note = await UserNote.create({ userId: req.user.id, body, insertDate: new Date() });

    if (uploadedFiles.length) {
      const files = [];
      for (const file of uploadedFiles) {
        const mime = file.mimetype || '';
        const kind = mime.startsWith('audio/') ? 'audio'
          : mime.startsWith('video/') ? 'video'
          : mime.startsWith('image/') ? 'image'
          : 'document';

        let thumbnail = null;
        if (kind === 'image') {
          try {
            const thumbFilename = `thumb-${file.filename}`;
            await sharp(file.path).resize(300).jpeg({ quality: 80 }).toFile(`public/uploads/${thumbFilename}`);
            thumbnail = thumbFilename;
          } catch (_) { /* non-fatal */ }
        } else if (kind === 'video') {
          thumbnail = await extractNoteVideoThumbnail(file.path, `thumb-${file.filename}.png`);
        }

        const fileDoc = await File.create({
          name: file.originalname.split('.')[0],
          supFolder: null,
          metaData: file,
          format: file.originalname.slice(file.originalname.lastIndexOf('.') + 1),
          generatedBy: req.user.id,
          thumbnail,
          scope: 'users',
          attachedTo: { type: 'userNote', id: note._id },
        });

        files.push({ fileId: fileDoc._id, kind, diskName: file.filename, name: file.originalname, thumbnail });
      }
      note.files = files;
      await note.save();
    }

    return res.status(201).json(note);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /users/me/notes/:noteId — soft-delete your OWN note.
router.delete('/me/notes/:noteId', verify, async (req, res) => {
  try {
    const note = await UserNote.findOneAndUpdate(
      { _id: req.params.noteId, userId: req.user.id, deleteDate: null },
      { $set: { deleteDate: new Date(), updateDate: new Date() } },
      { new: true }
    );
    if (!note) return res.status(404).json({ message: 'Note not found' });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Job Reports ────────────────────────────────────────────────────────────
// Now a standalone top-level section (nav item just before Tutorials) with
// two modes, not just a Users-profile sub-tab:
//   USER mode  — every authenticated user files/edits their OWN reports and
//                can add a follow-up to their own record. Unconditional, no
//                permission key — same precedent as personal notes / activity.
//   ADMIN mode — jobReports:viewAll (see + filter every user's reports by
//                user/date) and jobReports:reply (reply on any report, which
//                notifies that report's owner). Two separate keys so a role
//                can hold view without reply, matching the Inventory
//                price/quantity split precedent.
// Self-authored, but VISIBLE to anyone who can view this user's profile
// (users:view) — unlike Notes above, these are not private. reportDate is
// what the list is organized/filtered by — distinct from insertDate (when the
// entry was typed up) and lastActivityAt (latest reply/follow-up/edit, what
// the ADMIN list actually sorts by).

// Recomputes lastActivityAt from every date on the doc — called after any
// write that can move it (create, edit, reply, follow-up), in the same
// operation, mirroring the inventoryChangeLogs/customerActivity convention of
// never letting a derived field drift from what it's derived from.
function touchLastActivity(report) {
  const dates = [report.reportDate, report.updateDate, report.insertDate,
    ...(report.replies || []).map((r) => r.date),
    ...(report.followUps || []).map((f) => f.date)].filter(Boolean).map((d) => new Date(d).getTime());
  report.lastActivityAt = new Date(Math.max(...dates));
}

// Every member's group(s) -> that group's admins, minus the actor themselves
// (no self-notify) and de-duplicated (one user in two groups only gets one
// notification). A user in no group notifies nobody — there is no fallback
// "global admin" list here on purpose, since that would defeat the point of
// routing through each group's OWN admins.
async function groupAdminsFor(userId, excludeUserId) {
  const groups = await Group.find({ members: userId, deleteDate: null }).select('admins').lean();
  const ids = new Set();
  groups.forEach((g) => (g.admins || []).forEach((a) => {
    const s = String(a);
    if (s !== String(excludeUserId)) ids.add(s);
  }));
  return Array.from(ids);
}

async function notifyGroupAdminsOfJobReport(actorId, actorName, report, textKey) {
  try {
    const adminIds = await groupAdminsFor(report.userId, actorId);
    await Promise.all(adminIds.map((adminId) => sendNotificationToUser(adminId, {
      fromId: actorId, fromName: actorName, type: 'jobReport',
      textKey, textParams: { actorName, reportTitle: report.title || '' },
      entityType: 'jobReport', entityId: report._id,
    })));
  } catch (_) { /* best-effort — a notification failure must never affect the save that triggered it */ }
}

// GET /users/jobReports — ADMIN MODE: every user's reports, filterable by
// user + date range. MUST be registered before GET /:id/jobReports so
// 'jobReports' is never captured as an :id (same lesson as CRM's
// /customers/bulk vs /customers/:id).
// ?userId=&dateFrom=&dateTo=&page=&limit=
router.get('/jobReports', verify, requirePermission('jobReports:viewAll'), async (req, res) => {
  try {
    const { userId, dateFrom, dateTo, page = 1, limit = 30 } = req.query;
    const filter = { deleteDate: null };
    if (userId) filter.userId = userId;
    if (dateFrom || dateTo) {
      filter.reportDate = {};
      if (dateFrom) filter.reportDate.$gte = new Date(dateFrom);
      if (dateTo)   filter.reportDate.$lte = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
    }

    const lim = Math.min(100, Number(limit) || 30);
    const pg  = Math.max(1, Number(page) || 1);
    const [data, total] = await Promise.all([
      UserJobReport.find(filter).sort({ lastActivityAt: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
      UserJobReport.countDocuments(filter),
    ]);

    // The admin list's whole point is "who filed this and when" — join the
    // author's name onto each row rather than making the frontend resolve N
    // separate user lookups (same batched-join pattern as
    // crm/customer.js's createdByName resolution).
    const authorIds = [...new Set(data.map((r) => String(r.userId)))];
    const authors = await userM.find({ _id: { $in: authorIds } }).select('firstName lastName').lean();
    const nameById = new Map(authors.map((u) => [String(u._id), `${u.firstName || ''} ${u.lastName || ''}`.trim()]));
    data.forEach((r) => { r.authorName = nameById.get(String(r.userId)) || ''; });

    return res.status(200).json({ data, total, page: pg, limit: lim });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /users/jobReports/:reportId — single report, mode-agnostic. Exists for
// notification deep-links (a create/edit notification goes to a group admin
// who needs jobReports:viewAll to open it; a reply notification goes to the
// report's own owner, who always can) — the click target doesn't know in
// advance which mode the viewer should be in, so it needs one fetch that
// works either way. Same access rule as the list route below: owner always,
// otherwise users:view or jobReports:viewAll.
router.get('/jobReports/:reportId', verify, async (req, res) => {
  try {
    const report = await UserJobReport.findOne({ _id: req.params.reportId, deleteDate: null }).lean();
    if (!report) return res.status(404).json({ message: 'Report not found' });

    if (String(report.userId) !== String(req.user.id)) {
      const perms = await getEffectivePermissions(req.user.id);
      if (!perms.has('users:view') && !perms.has('jobReports:viewAll')) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    const author = await userM.findById(report.userId).select('firstName lastName').lean();
    report.authorName = author ? `${author.firstName || ''} ${author.lastName || ''}`.trim() : '';

    return res.status(200).json(report);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /users/:id/jobReports — the OWNER can always see their own; anyone else
// needs users:view (same gate as GET /:id and GET /:id/logs).
// ?dateFrom=&dateTo=&page=&limit=
router.get('/:id/jobReports', verify, async (req, res) => {
  try {
    const targetId = req.params.id;
    if (String(targetId) !== String(req.user.id)) {
      const perms = await getEffectivePermissions(req.user.id);
      if (!perms.has('users:view')) return res.status(403).json({ message: 'Access denied' });
    }

    const { dateFrom, dateTo, page = 1, limit = 20 } = req.query;
    const filter = { userId: targetId, deleteDate: null };
    if (dateFrom || dateTo) {
      filter.reportDate = {};
      if (dateFrom) filter.reportDate.$gte = new Date(dateFrom);
      if (dateTo)   filter.reportDate.$lte = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
    }

    const lim = Math.min(50, Number(limit) || 20);
    const pg  = Math.max(1, Number(page) || 1);
    const [data, total] = await Promise.all([
      UserJobReport.find(filter).sort({ reportDate: -1, insertDate: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
      UserJobReport.countDocuments(filter),
    ]);
    return res.status(200).json({ data, total });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

async function makeJobReportFileEntry(file, userId, reportId) {
  const mime = file.mimetype || '';
  const kind = mime.startsWith('audio/') ? 'audio'
    : mime.startsWith('video/') ? 'video'
    : mime.startsWith('image/') ? 'image'
    : 'document';

  let thumbnail = null;
  if (kind === 'image') {
    try {
      const thumbFilename = `thumb-${file.filename}`;
      await sharp(file.path).resize(300).jpeg({ quality: 80 }).toFile(`public/uploads/${thumbFilename}`);
      thumbnail = thumbFilename;
    } catch (_) { /* non-fatal */ }
  } else if (kind === 'video') {
    thumbnail = await extractNoteVideoThumbnail(file.path, `thumb-${file.filename}.png`);
  }

  const fileDoc = await File.create({
    name: file.originalname.split('.')[0],
    supFolder: null,
    metaData: file,
    format: file.originalname.slice(file.originalname.lastIndexOf('.') + 1),
    generatedBy: userId,
    thumbnail,
    scope: 'users',
    attachedTo: { type: 'userJobReport', id: reportId },
  });

  return { fileId: fileDoc._id, kind, diskName: file.filename, name: file.originalname, thumbnail };
}

async function getJobReportActorName(userId) {
  const actor = await userM.findById(userId).select('firstName lastName').lean();
  return actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '';
}

// POST /users/me/jobReports — create your OWN report (text + up to 5 voice/video/photo/document attachments).
router.post('/me/jobReports', verify, notesUpload.array('files', MAX_BATCH_FILES), async (req, res) => {
  try {
    const reportDate = req.body.reportDate ? new Date(req.body.reportDate) : new Date();
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const body  = typeof req.body.body  === 'string' ? req.body.body.trim()  : '';
    const uploadedFiles = req.files || [];

    const report = await UserJobReport.create({ userId: req.user.id, reportDate, title, body, insertDate: new Date() });

    if (uploadedFiles.length) {
      const files = [];
      for (const file of uploadedFiles) files.push(await makeJobReportFileEntry(file, req.user.id, report._id));
      report.files = files;
    }
    touchLastActivity(report);
    await report.save();

    const actorName = await getJobReportActorName(req.user.id);
    notifyGroupAdminsOfJobReport(req.user.id, actorName, report, 'jobReportGroupCreated');

    return res.status(201).json(report);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /users/me/jobReports/:reportId — edit your OWN report (real edit — date/text + add/remove files).
router.put('/me/jobReports/:reportId', verify, notesUpload.array('files', MAX_BATCH_FILES), async (req, res) => {
  try {
    const report = await UserJobReport.findOne({ _id: req.params.reportId, userId: req.user.id, deleteDate: null });
    if (!report) return res.status(404).json({ message: 'Report not found' });

    if (req.body.reportDate !== undefined) report.reportDate = new Date(req.body.reportDate);
    if (req.body.title      !== undefined) report.title      = req.body.title.trim();
    if (req.body.body       !== undefined) report.body       = req.body.body.trim();

    let removeFileIds = [];
    try { removeFileIds = JSON.parse(req.body.removeFileIds || '[]').map(String); } catch (_) { /* ignore */ }
    if (removeFileIds.length) {
      report.files = report.files.filter((f) => !removeFileIds.includes(String(f.fileId)));
    }

    const uploadedFiles = req.files || [];
    for (const file of uploadedFiles) {
      report.files.push(await makeJobReportFileEntry(file, req.user.id, report._id));
    }

    report.updateDate = new Date();
    touchLastActivity(report);
    await report.save();

    const actorName = await getJobReportActorName(req.user.id);
    notifyGroupAdminsOfJobReport(req.user.id, actorName, report, 'jobReportGroupUpdated');

    return res.status(200).json(report);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /users/me/jobReports/:reportId/followUp — append a dated update to
// YOUR OWN report, without overwriting the original entry the way PUT does.
router.post('/me/jobReports/:reportId/followUp', verify, async (req, res) => {
  try {
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ message: 'body is required' });

    const report = await UserJobReport.findOne({ _id: req.params.reportId, userId: req.user.id, deleteDate: null });
    if (!report) return res.status(404).json({ message: 'Report not found' });

    const actorName = await getJobReportActorName(req.user.id);
    report.followUps.push({ body, authorId: req.user.id, authorName: actorName, date: new Date() });
    touchLastActivity(report);
    await report.save();

    notifyGroupAdminsOfJobReport(req.user.id, actorName, report, 'jobReportFollowUp');

    return res.status(201).json(report);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /users/jobReports/:reportId/reply — ADMIN MODE: reply on ANY user's
// report. Notifies that report's owner (never the group admins — a reply is
// already an admin-to-user conversation, not something the group needs
// re-notified about).
router.post('/jobReports/:reportId/reply', verify, requirePermission('jobReports:reply'), async (req, res) => {
  try {
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ message: 'body is required' });

    const report = await UserJobReport.findOne({ _id: req.params.reportId, deleteDate: null });
    if (!report) return res.status(404).json({ message: 'Report not found' });

    const actorName = await getJobReportActorName(req.user.id);
    report.replies.push({ body, authorId: req.user.id, authorName: actorName, date: new Date() });
    touchLastActivity(report);
    await report.save();

    if (String(report.userId) !== String(req.user.id)) {
      sendNotificationToUser(report.userId, {
        fromId: req.user.id, fromName: actorName, type: 'jobReport',
        textKey: 'jobReportReplied', textParams: { actorName, reportTitle: report.title || '' },
        entityType: 'jobReport', entityId: report._id,
      }).catch(() => {});
    }

    return res.status(201).json(report);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /users/me/jobReports/:reportId — soft-delete your OWN report.
router.delete('/me/jobReports/:reportId', verify, async (req, res) => {
  try {
    const report = await UserJobReport.findOneAndUpdate(
      { _id: req.params.reportId, userId: req.user.id, deleteDate: null },
      { $set: { deleteDate: new Date(), updateDate: new Date() } },
      { new: true }
    );
    if (!report) return res.status(404).json({ message: 'Report not found' });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Telegram — self-service link, mirrors existing notification events ────────
// Independent of the SMS/OTP auth system. verify-only, self only (no
// permission key — it's the caller's own data, same rationale as Notes/My
// Profile). The actual /start <code> handling lives in server.js, next to
// where the long-polling loop is started (needs the User model + a way to
// send the confirmation message — not an HTTP route, so it doesn't belong
// in this router).

router.get('/me/telegram/status', verify, async (req, res) => {
  try {
    const u = await userM.findById(req.user.id).select('telegram').lean();
    const tg = (u && u.telegram) || {};
    const pendingStillValid = !tg.chatId && tg.pendingCode && tg.pendingCodeExpiresAt && new Date(tg.pendingCodeExpiresAt) > new Date();
    return res.status(200).json({
      linked: !!tg.chatId,
      username: tg.username || null,
      linkedAt: tg.linkedAt || null,
      pendingCode: pendingStillValid ? tg.pendingCode : null,
      botUsername: process.env.TELEGRAM_BOT_USERNAME || 'xms_lazulite_bot',
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/me/telegram/link-code', verify, async (req, res) => {
  try {
    const code = crypto.randomBytes(6).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await userM.findOneAndUpdate(
      { _id: req.user.id, deleteDate: null },
      { $set: { 'telegram.pendingCode': code, 'telegram.pendingCodeExpiresAt': expiresAt } }
    );
    return res.status(200).json({
      code,
      expiresAt,
      botUsername: process.env.TELEGRAM_BOT_USERNAME || 'xms_lazulite_bot',
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/me/telegram/unlink', verify, async (req, res) => {
  try {
    await userM.findOneAndUpdate(
      { _id: req.user.id },
      { $set: {
        'telegram.chatId': null, 'telegram.username': null, 'telegram.linkedAt': null,
        'telegram.pendingCode': null, 'telegram.pendingCodeExpiresAt': null,
      } }
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /users/directory — lightweight id→{name, profileImage} lookup ─────────
// Powers avatar rendering anywhere a user's identity is shown by id (chat
// bubbles, task assignee, activity actor, "shared by", etc.) without forcing
// every module's own actor-name-building route to carry profileImage too.
// verify-only, no permission key: colleague names are already shown app-wide
// with no gate (activity actorName / assignedByName / senderName etc. — see
// getActorName()-style helpers across crm/mis/digitalMarketing) — this adds a
// photo to that same, already-ungated information, nothing more sensitive.
// Defined before /:id so 'directory' is never captured as an ObjectId.
router.get('/directory', verify, async (req, res) => {
  try {
    const users = await userM.find({ deleteDate: null })
      .select('firstName lastName profileImage')
      .lean();
    return res.status(200).json({ data: users });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /users/getFilter — unchanged (user's own filter memory) ───────────────
router.get('/getFilter', verify, async (req, res) => {
  const decoded = jwt_decode(req.headers.authorization);
  try {
    const theUser = await userM.findOne({ _id: decoded.id }).select('filterMemory');
    return res.status(200).json(theUser);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /users/userProfileData — unchanged (caller's own profile) ─────────────
router.get('/userProfileData', verify, async (req, res) => {
  const decoded = jwt_decode(req.headers.authorization);
  try {
    const theUser = await userM.findOne({ _id: decoded.id }).select(
      'jobReport jobReportPresets firstName lastName phoneNumber filterMemory insertDate updateDate access isOnline lastSeen profileImage'
    );
    return res.status(200).json(theUser);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /users — list (search / filter / sort) ────────────────────────────────
router.get('/', verify, requirePermission('users:view'), async (req, res) => {
  try {
    const { search = '', sort = '-insertDate', limit = 50, skip = 0, branchId = '' } = req.query;
    const query = { deleteDate: null };
    if (search) {
      const re = new RegExp(search, 'i');
      query.$or = [{ firstName: re }, { lastName: re }, { phoneNumber: re }];
    }

    // Optional branch filter (e.g. the invoice "Send to" picker) — only users
    // assigned to this branch. Caller must hold the branch themselves.
    if (branchId) {
      if (!(await assertBranchAccess(req.user.id, branchId))) {
        return res.status(403).json({ message: 'You do not have access to this branch' });
      }
      const branchAccess = await UserAccess.find({ branches: branchId }).select('userId').lean();
      query._id = { $in: branchAccess.map(a => a.userId) };
    }
    const [users, total] = await Promise.all([
      userM.find(query)
        .select('firstName lastName phoneNumber profileImage validation access isOnline lastSeen insertDate auth.lockedUntil language')
        .sort(sort)
        .skip(Number(skip))
        .limit(Number(limit))
        .lean(),
      userM.countDocuments(query),
    ]);

    // Enrich each user with their role names from the RBAC system
    const userIds = users.map(u => u._id);
    const [accessDocs, allRoles] = await Promise.all([
      UserAccess.find({ userId: { $in: userIds } }).lean(),
      Role.find({ deleteDate: null }).select('name').lean(),
    ]);
    const roleNameMap = {};
    allRoles.forEach(r => { roleNameMap[String(r._id)] = r.name; });
    const accessMap = {};
    accessDocs.forEach(a => {
      accessMap[String(a.userId)] = (a.roles || []).map(rid => roleNameMap[String(rid)]).filter(Boolean);
    });
    const enriched = users.map(u => ({ ...u, roleNames: accessMap[String(u._id)] || [] }));

    return res.status(200).json({ data: enriched, total });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /users/:id — detail ───────────────────────────────────────────────────
router.get('/:id', verify, requirePermission('users:view'), async (req, res) => {
  try {
    const theUser = await userM.findOne({ _id: req.params.id, deleteDate: null })
      .select('-auth.otpHash -auth.otpExpiresAt -password -oldPasswords -passwordReset')
      .lean();
    if (!theUser) return res.status(404).json({ message: 'User not found' });

    // Attach effective permissions + scopes summary
    const [perms, scopes] = await Promise.all([
      getEffectivePermissions(req.params.id),
      getEffectiveScopes(req.params.id),
    ]);
    const access = await UserAccess.findOne({ userId: req.params.id }).lean();

    return res.status(200).json({ user: theUser, effectivePermissions: Array.from(perms), dataScopes: scopes, userAccess: access });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /users/:id/logs — activity timeline ───────────────────────────────────
// The OWNER can always see their own (powers the self-service "My Activity"
// page, reachable from the profile popup regardless of users:view — see
// myActivityPage.js); anyone else needs users:view. Same pattern as
// GET /:id/jobReports below.
// ?section=all|inventory|crm|mis|digitalMarketing   (default: all)
// ?page=1&limit=30
router.get('/:id/logs', verify, async (req, res) => {
  try {
    const uid     = req.params.id;
    if (String(uid) !== String(req.user.id)) {
      const perms = await getEffectivePermissions(req.user.id);
      if (!perms.has('users:view')) return res.status(403).json({ message: 'Access denied' });
    }
    const section = req.query.section || 'all';
    const page    = Math.max(1, parseInt(req.query.page)  || 1);
    const limit   = Math.min(50, parseInt(req.query.limit) || 30);
    const skip    = (page - 1) * limit;

    let entries = [];

    // ── Inventory logs ───────────────────────────────────────────────────────
    if (section === 'all' || section === 'inventory') {
      const invLogs = await InvChangeLog.find({ changedBy: uid })
        .sort({ createdAt: -1 })
        .lean();

      // Enrich with product name
      const productIds = [...new Set(invLogs.map(l => String(l.productId)))];
      const products   = await InvProduct.find({ _id: { $in: productIds } }).select('name code').lean();
      const prodMap    = {};
      products.forEach(p => { prodMap[String(p._id)] = p; });

      invLogs.forEach(log => {
        const prod = prodMap[String(log.productId)];
        entries.push({
          _id:         String(log._id),
          section:     'inventory',
          changeType:  log.changeType,
          subjectType: log.subjectType,
          subjectCode: log.subjectId,       // variant code stored as ObjectId ref
          productName: prod?.name  || '',
          productCode: prod?.code  || '',
          field:       log.field,
          oldValue:    log.oldValue,
          newValue:    log.newValue,
          delta:       log.delta,
          unit:        log.unit,
          currency:    log.currency,
          mediaRef:    log.mediaRef,
          reason:      log.reason,
          source:      log.source,
          date:        log.createdAt || log.date,
        });
      });
    }

    // ── CRM logs (customerActivity, keyed by actorId) ────────────────────────
    if (section === 'all' || section === 'crm') {
      const crmLogs = await CustomerActivity.find({ actorId: uid })
        .sort({ date: -1 })
        .lean();

      const customerIds = [...new Set(crmLogs.map(l => String(l.customerId)))];
      const customers    = await Customer.find({ _id: { $in: customerIds } })
        .select('personalInformation.firstName personalInformation.lastName personalInformation.companyName phoneNumber')
        .lean();
      const custMap = {};
      customers.forEach(c => { custMap[String(c._id)] = c; });

      crmLogs.forEach(log => {
        const cust = custMap[String(log.customerId)];
        const pi   = cust?.personalInformation || {};
        const custName = pi.companyName || `${pi.firstName || ''} ${pi.lastName || ''}`.trim() || cust?.phoneNumber || '';
        entries.push({
          _id:         String(log._id),
          section:     'crm',
          changeType:  log.type,
          productName: custName,   // reused generic field — the customer's display name
          field:       log.field,
          oldValue:    log.oldValue,
          newValue:    log.newValue,
          body:        log.body,
          date:        log.date || log.createdAt,
        });
      });
    }

    // ── MIS / Invoices logs (invoiceActivity, keyed by actorId) ──────────────
    if (section === 'all' || section === 'mis') {
      const misLogs = await InvoiceActivity.find({ actorId: uid })
        .sort({ date: -1 })
        .lean();

      const invoiceIds = [...new Set(misLogs.map(l => String(l.invoiceId)))];
      const invoices    = await MisInvoice.find({ _id: { $in: invoiceIds } })
        .select('docNumber docType customerSnapshot.name')
        .lean();
      const invMap = {};
      invoices.forEach(d => { invMap[String(d._id)] = d; });

      misLogs.forEach(log => {
        const doc = invMap[String(log.invoiceId)];
        entries.push({
          _id:         String(log._id),
          section:     'mis',
          changeType:  log.type,
          docType:     log.docType || doc?.docType,
          docNumber:   doc?.docNumber,
          productName: doc?.customerSnapshot?.name || '',
          field:       log.field,
          oldValue:    log.oldValue,
          newValue:    log.newValue,
          body:        log.body,
          date:        log.date || log.createdAt,
        });
      });
    }

    // ── Digital Marketing logs (dmActivity, keyed by actorId) ────────────────
    // Only 'created'/'status_changed' — 'viewed'/'downloaded' are near-empty
    // for the record's own creator (self-views are deliberately never logged,
    // see routes/digitalMarketing/main.js) and aren't useful "my work" signal.
    if (section === 'all' || section === 'digitalMarketing') {
      const dmLogs = await DmActivity.find({ actorId: uid, action: { $in: ['created', 'status_changed'] } })
        .sort({ date: -1 })
        .lean();

      const rawIds   = dmLogs.filter(l => l.subjectType === 'rawContent').map(l => l.subjectId);
      const readyIds = dmLogs.filter(l => l.subjectType === 'readyToUpload').map(l => l.subjectId);
      const [rawDocs, readyDocs] = await Promise.all([
        rawIds.length   ? RawContent.find({ _id: { $in: rawIds } }).select('title files').lean()      : [],
        readyIds.length ? ReadyToUpload.find({ _id: { $in: readyIds } }).select('title files').lean() : [],
      ]);
      const rawMap   = {}; rawDocs.forEach(d   => { rawMap[String(d._id)]   = d; });
      const readyMap = {}; readyDocs.forEach(d => { readyMap[String(d._id)] = d; });

      dmLogs.forEach(log => {
        const subj = log.subjectType === 'rawContent' ? rawMap[String(log.subjectId)] : readyMap[String(log.subjectId)];
        const subjName = subj?.title?.trim() || (subj ? `${subj.files?.length || 0} file(s)` : '');
        entries.push({
          _id:         String(log._id),
          section:     'digitalMarketing',
          changeType:  log.action,
          subjectType: log.subjectType,
          productName: subjName,
          oldValue:    log.oldValue,
          newValue:    log.newValue,
          date:        log.date,
        });
      });
    }

    // ── Sort all entries newest-first ────────────────────────────────────────
    entries.sort((a, b) => new Date(b.date) - new Date(a.date));
    const total  = entries.length;
    const paged  = entries.slice(skip, skip + limit);

    return res.status(200).json({ data: paged, total, page, limit });
  } catch (err) {
    console.error('[GET /users/:id/logs]', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── POST /users — create ──────────────────────────────────────────────────────
router.post('/', verify, requirePermission('users:create'), async (req, res) => {
  try {
    const existing = await userM.findOne({ phoneNumber: req.body.phoneNumber });
    if (existing) return res.status(400).json({ message: 'Phone number already exists' });

    const newUser = new userM({
      firstName:   req.body.firstName,
      lastName:    req.body.lastName,
      phoneNumber: req.body.phoneNumber,
      validation:  req.body.validation !== undefined ? req.body.validation : true,
      access:      [],
      ...(req.body.countryCode ? { countryCode: req.body.countryCode } : {}),
    });
    const saved = await newUser.save();

    // Branch assignment is superAdmin-only (branches gate Inventory/MIS isolation);
    // a non-superAdmin creating a user can never set branches.
    const superAdmin = await isSuperAdmin(req.user.id);

    // Always upsert a userAccess doc (handles retries / empty arrays safely)
    await UserAccess.findOneAndUpdate(
      { userId: saved._id },
      { $set: {
        userId: saved._id,
        roles:  req.body.roles  || [],
        groups: req.body.groups || [],
        grants: req.body.grants || [],
        denies: req.body.denies || [],
        ...(superAdmin && Array.isArray(req.body.branches) ? { branches: req.body.branches } : {}),
      }},
      { upsert: true, new: true }
    );

    return res.status(201).json(saved);
  } catch (err) {
    console.error('[POST /users] Error:', err.message, err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ── PUT /users/:id — update profile / validation ──────────────────────────────
router.put('/:id', verify, requirePermission('users:edit'), async (req, res) => {
  try {
    const setFields = {
      firstName:  req.body.firstName,
      lastName:   req.body.lastName,
      validation: req.body.validation,
      updateDate: new Date(),
    };
    if (req.body.countryCode !== undefined) setFields.countryCode = req.body.countryCode;

    // Admin-editable notification preferences (same per-type keys as the
    // self-service /me/notification-prefs route).
    if (req.body.notificationPrefs && typeof req.body.notificationPrefs === 'object') {
      for (const k of NOTIF_PREF_KEYS) {
        if (req.body.notificationPrefs[k] !== undefined) {
          setFields[`notificationPrefs.${k}`] = !!req.body.notificationPrefs[k];
        }
      }
    }

    const updated = await userM.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: setFields },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'User not found' });

    // Branch assignment is superAdmin-only (branches gate Inventory/MIS isolation) —
    // a non-superAdmin with users:edit can never write branches (would bypass isolation).
    const superAdmin = await isSuperAdmin(req.user.id);
    const wantsBranchUpdate = superAdmin && req.body.branches !== undefined;

    // Update RBAC assignment if provided
    if (req.body.roles !== undefined || req.body.groups !== undefined || wantsBranchUpdate) {
      const rbacUpdate = {};
      if (req.body.roles  !== undefined) rbacUpdate.roles  = req.body.roles;
      if (req.body.groups !== undefined) rbacUpdate.groups = req.body.groups;
      if (req.body.grants !== undefined) rbacUpdate.grants = req.body.grants;
      if (req.body.denies !== undefined) rbacUpdate.denies = req.body.denies;
      if (wantsBranchUpdate)             rbacUpdate.branches = req.body.branches;
      rbacUpdate.updateDate = new Date();
      await UserAccess.findOneAndUpdate(
        { userId: req.params.id },
        { $set: rbacUpdate },
        { upsert: true }
      );
      clearPermissionCache(req.params.id);
    }

    return res.status(200).json(updated);
  } catch (err) {
    console.error('[PUT /users/:id] Error:', err.message, err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ── DELETE /users/:id — soft-delete ──────────────────────────────────────────
router.delete('/:id', verify, requirePermission('users:delete'), async (req, res) => {
  try {
    await userM.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { deleteDate: new Date() } }
    );
    clearPermissionCache(req.params.id);
    return res.status(200).json({ message: 'User deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── POST /users/:id/unlock — clear OTP lockout ────────────────────────────────
// Clears lockedUntil + failedOtpAttempts so user can attempt OTP login again.
router.post('/:id/unlock', verify, requirePermission('users:unlock'), async (req, res) => {
  try {
    const updated = await userM.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      {
        $set: {
          'auth.lockedUntil':            null,
          'auth.failedOtpAttempts':      0,
          'auth.failedPasswordAttempts': 0,
        },
      },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'User not found' });
    return res.status(200).json({ message: 'Account unlocked' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── POST /users/:id/avatar — upload + set profile picture ────────────────────
// Stores file in public/uploads, creates a File doc (scope='users'), and saves
// the resulting URL to user.profileImage.
router.post('/:id/avatar', verify, requirePermission('users:edit'), upload.single('file'), async (req, res) => {
  try {
    const decoded = jwt_decode(req.headers.authorization);
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    let thumbnailFilename = null;
    if (req.file.mimetype.startsWith('image/')) {
      try {
        thumbnailFilename = `thumb-${req.file.filename}`;
        await sharp(req.file.path)
          .resize(200, 200, { fit: 'cover' })
          .jpeg({ quality: 80 })
          .toFile(path.join('public/uploads', thumbnailFilename));
      } catch (_) { thumbnailFilename = null; }
    }

    const fileDoc = await File.create({
      name:        req.file.originalname,
      metaData:    req.file,
      format:      path.extname(req.file.originalname).slice(1),
      generatedBy: decoded.id,
      thumbnail:   thumbnailFilename,
      scope:       'users',
      attachedTo:  { type: 'user', id: req.params.id },
    });

    const profileImage = {
      fileId:    fileDoc._id,
      url:       `/uploads/${req.file.filename}`,
      thumbnail: thumbnailFilename ? `/uploads/${thumbnailFilename}` : null,
    };

    await userM.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: { profileImage } }
    );

    return res.status(200).json({ profileImage });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── Legacy routes (kept during RBAC migration) ────────────────────────────────

router.get('/getAllUsers', verify, async (req, res) => {
  try {
    const decoded   = jwt_decode(req.headers.authorization);
    const length    = await userM.countDocuments({ deleteDate: null });
    const result    = await userM.find({ deleteDate: null, validation: true });
    const all       = await userM.find({ deleteDate: null });
    const employees = result.filter(w => String(w._id) !== String(decoded.id));
    const grouped   = { sa: [], inv: [], req: [], all: employees, allAll: all.reverse(), length };
    employees.forEach(u => {
      (u.access || []).forEach(a => {
        if (grouped[a]) grouped[a].push(u);
      });
    });
    return res.status(200).json({ ln: length, rs: grouped });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/updateAccess', verify, async (req, res) => {
  try {
    await userM.findOneAndUpdate({ _id: req.body.userId }, { $set: { access: req.body.newAccessList } });
    return res.status(200).json({ message: 'Access updated' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/changeValidation', verify, async (req, res) => {
  try {
    const found = await userM.findOne({ _id: req.body.userId });
    if (!found) return res.status(404).json({ message: 'User not found' });
    await userM.findOneAndUpdate({ _id: req.body.userId }, { validation: !found.validation });
    return res.status(200).json({ message: 'Status changed' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/deleteUser', verify, async (req, res) => {
  try {
    await userM.findOneAndUpdate({ _id: req.body.userId }, { $set: { deleteDate: Date.now() } });
    return res.status(200).json({ message: 'User deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
