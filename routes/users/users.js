const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt_decode = require('jwt-decode');
const mongoose   = require('mongoose');
const path       = require('path');
const crypto     = require('crypto');
const multer     = require('multer');
const { blockExecutableFiles, imagesOnly, imageUploadLimits, uploadLimits, MAX_BATCH_FILES } = require('../../utils/uploadGuards');
const sharp      = require('sharp');
const ffmpeg     = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { extractVideoThumbnail, transcodeVideoAsync, isVideoUpload } = require('../../utils/mediaConvert');

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
const inventoryVariantSchema   = require('../../models/inventoryVariantModel');
const whatsappShareSchema      = require('../../models/whatsappShareModel');
const externalLinkPageSchema   = require('../../models/externalLinkPageModel');
const dbConnection        = require('../../connections/xmsPr');
const verify              = require('./verifyToken');
const { requirePermission, getEffectivePermissions, getEffectiveScopes, clearPermissionCache, isSuperAdmin, assertBranchAccess, getUserBranches, resolveUserJobReportTemplate, UserAccess, Role, Group, Branch } = require('../../utils/rbac');
const { listJobReportTemplates, resolveJobReportTemplate, isKnownTemplate, DEFAULT_TEMPLATE, SOCIAL_CHANNELS } = require('../../utils/jobReportTemplates');
const { resolveJobReportSections, DM_KINDS, customerLabel, crmScopeFilter, dmScopeFilter, inventoryProductScopeFilter } = require('../../utils/jobReportSections');
const { syncReportInterest } = require('../../utils/customerInterest');
const { renderJobReportHtml } = require('../../utils/jobReportTemplate');
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
const InvVariant       = dbConnection.models.inventoryVariant  || dbConnection.model('inventoryVariant', inventoryVariantSchema);
const WhatsappShare    = dbConnection.models.whatsappShare     || dbConnection.model('whatsappShare',    whatsappShareSchema);
const ExternalLinkPage = dbConnection.models.externalLinkPage  || dbConnection.model('externalLinkPage', externalLinkPageSchema);

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
// Was a local copy asking ffmpeg for a '10%' timestamp, which needs ffprobe to
// resolve it — this app has no ffprobe (BUG-07), so note/job-report video
// thumbnails never actually generated. utils/mediaConvert.js's shared version
// uses fixed timestamps and works without it.
const extractNoteVideoThumbnail = extractVideoThumbnail;

const router = express.Router();

// ── GET /users/me/permissions — effective permission set for the caller ────────
// Must be defined BEFORE /:id to avoid "me" being captured as an ObjectId.
// Any authenticated user can call this (no permission guard — it's their own data).
router.get('/me/permissions', verify, async (req, res) => {
  try {
    const [perms, scopes, superAdmin, jobReportTemplate] = await Promise.all([
      getEffectivePermissions(req.user.id),
      getEffectiveScopes(req.user.id),
      isSuperAdmin(req.user.id),
      // Which job report form this user files on - resolved from their roles,
      // same trip the permission set already makes, so the form knows which
      // template to draw without a second request.
      resolveUserJobReportTemplate(req.user.id),
    ]);
    return res.status(200).json({ permissions: Array.from(perms), dataScopes: scopes, isSuperAdmin: superAdmin, jobReportTemplate });
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

// ── password management ──────────────────────────────────────────────────────
// Added when SMS/OTP login was retired: password is now the ONLY way in, so
// there has to be a way to set one. Before this there was none anywhere in the
// app — /auth/register never set a password and /auth/updateUser ignored it —
// which meant every newly created account would have been unable to log in.
//
// The password lives on authApi's userModel; xmsApi shares the same database
// (see the connection notes in CLAUDE.md), so it writes the same field authApi
// reads at login. Hashing matches /auth/loginPassword: bcrypt, 10 salt rounds.
const MIN_PASSWORD_LENGTH = 8;

function passwordProblem(pw) {
  if (typeof pw !== 'string' || !pw) return 'A password is required';
  if (pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain both letters and numbers';
  return null;
}

// PUT /users/me/password — change your OWN password.
// The current password is required only when one is already set: an account
// migrated off OTP has none, and would otherwise have no way to create one.
router.put('/me/password', verify, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const problem = passwordProblem(newPassword);
    if (problem) return res.status(400).json({ message: problem });

    const user = await userM.findOne({ _id: req.user.id, deleteDate: null }).select('password oldPasswords');
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.password) {
      if (!currentPassword) return res.status(400).json({ message: 'Your current password is required' });
      const ok = await bcrypt.compare(currentPassword, user.password);
      if (!ok) return res.status(401).json({ message: 'Current password is incorrect' });
      // Refuse silent re-use of the password already on the account.
      if (await bcrypt.compare(newPassword, user.password)) {
        return res.status(400).json({ message: 'That is already your current password' });
      }
    }

    const hash = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
    await userM.updateOne({ _id: user._id }, {
      $set: { password: hash, updateDate: new Date() },
      // Clear any standing lockout — the person just proved who they are.
      $unset: { 'auth.lockedUntil': '', 'auth.failedPasswordAttempts': '' },
      ...(user.password ? { $push: { oldPasswords: user.password } } : {}),
    });

    return res.status(200).json({ message: 'Password updated' });
  } catch (err) {
    console.error('PUT /users/me/password failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /users/:id/password — an admin sets or resets someone else's password.
// Gated by users:edit, the same key that already allows changing every other
// field on a user record. No current-password check: this is the recovery path
// for someone who can't sign in, which is exactly when they don't have it.
router.post('/:id/password', verify, requirePermission('users:edit'), async (req, res) => {
  try {
    const { newPassword } = req.body;
    const problem = passwordProblem(newPassword);
    if (problem) return res.status(400).json({ message: problem });

    const user = await userM.findOne({ _id: req.params.id, deleteDate: null }).select('password');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const hash = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
    await userM.updateOne({ _id: user._id }, {
      $set: { password: hash, updateDate: new Date() },
      // An admin reset also lifts a lockout — otherwise the person still can't
      // get in until the 2h timer expires.
      $unset: { 'auth.lockedUntil': '', 'auth.failedPasswordAttempts': '', 'auth.failedOtpAttempts': '' },
      ...(user.password ? { $push: { oldPasswords: user.password } } : {}),
    });

    return res.status(200).json({ message: 'Password set' });
  } catch (err) {
    console.error('POST /users/:id/password failed:', err);
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
          : isVideoUpload(file) ? 'video'
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

        // Non-blocking web-playable copy (H.264/AAC MP4) for anything the
        // browser can't decode as uploaded; served via GET /media/video/<diskName>.
        if (kind === 'video') transcodeVideoAsync(File, fileDoc, file.path);

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

// ── The form catalog + the three pickers it draws ───────────────────────────
// All registered BEFORE /jobReports/:reportId so 'templates' and 'lookup' are
// never captured as an id (the same lesson as CRM's /customers/bulk).

// GET /users/jobReports/templates — every form in the registry, plus the one
// THIS caller files on. Unconditional: filing your own report needs no
// permission key (same precedent as personal notes), so neither does knowing
// which form to draw. The role form's selector reads the same list.
router.get('/jobReports/templates', verify, async (req, res) => {
  try {
    const mine = await resolveUserJobReportTemplate(req.user.id);
    return res.status(200).json({
      templates: listJobReportTemplates(),
      // The full spec for the caller's own form — sections, fields, labels in
      // all three languages. The browser renders from this rather than from a
      // hard-coded copy, which is what keeps the form and the printed sheet
      // from drifting apart.
      mine, spec: resolveJobReportTemplate(mine),
      // The channels a `recipient` field offers — sent with the spec for the
      // same reason the labels are: the printed sheet names them too.
      channels: SOCIAL_CHANNELS,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /users/jobReports/templates/:key — one spec by key, for reading a report
// filed on a template other than the viewer's own (an admin on the classic
// form opening a salesperson's sheet).
router.get('/jobReports/templates/:key', verify, async (req, res) => {
  try {
    return res.status(200).json({ spec: resolveJobReportTemplate(req.params.key), channels: SOCIAL_CHANNELS });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// The pickers. Each one carries the permission of the section it reads from,
// not a new key — a job report may not become a side door into CRM, Inventory
// or Digital Marketing for someone who cannot open them directly.
const escapeJrRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /users/jobReports/lookup/customers?search=
router.get('/jobReports/lookup/customers', verify, requirePermission('crm:view'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    if (search.length < 2) return res.status(200).json({ data: [] });
    const re = new RegExp(escapeJrRegex(search), 'i');

    const query = {
      deleteDate: null,
      $or: [
        { phoneNumber: re },
        { 'personalInformation.companyName': re },
        { 'personalInformation.firstName': re },
        { 'personalInformation.lastName': re },
      ],
    };
    // Row-level scoping is re-derived server-side, exactly as the CRM list
    // does it — a rep on a 'mine' scope only finds their own customers here.
    const scope = await crmScopeFilter(req.user.id);
    const finalQuery = scope ? { $and: [query, scope] } : query;

    const rows = await Customer.find(finalQuery)
      .select('_id personalInformation phoneNumber').limit(25).lean();
    return res.status(200).json({
      data: rows.map((c) => ({ customerId: c._id, name: customerLabel(c), phone: c.phoneNumber || '' })),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /users/jobReports/lookup/varieties?search= — by stone code or product
// name, across every branch the caller holds (same cross-branch scoping as
// Digital Marketing's own variety picker: a report is not branch-filed, and
// the person writing it may well work across two).
router.get('/jobReports/lookup/varieties', verify, requirePermission('inventory:view'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    if (search.length < 2) return res.status(200).json({ data: [] });
    const re = new RegExp(escapeJrRegex(search), 'i');

    const superAdmin = await isSuperAdmin(req.user.id);
    const branchIds = superAdmin ? null : await getUserBranches(req.user.id);

    // Inventory's own row-level scope, applied through the one definition the
    // save path also uses — a picker that offers what the save would reject is
    // worse than no picker.
    const invScope = superAdmin ? null : await inventoryProductScopeFilter(req.user.id);

    const productQuery = { deleteDate: null, $or: [{ name: re }, { nameAr: re }, { code: re }] };
    if (branchIds) productQuery.branchId = { $in: branchIds };
    if (invScope) Object.assign(productQuery, invScope);
    const byName = await InvProduct.find(productQuery).select('_id').limit(15).lean();

    const variantQuery = {
      deleteDate: null, status: 'active',
      $or: [{ code: re }, { productId: { $in: byName.map((p) => p._id) } }],
    };
    if (branchIds) variantQuery.branchId = { $in: branchIds };

    const variants = await InvVariant.find(variantQuery)
      .select('_id productId branchId code unit quantity').sort('code').limit(60).lean();

    const scopedProductQuery = { _id: { $in: variants.map((v) => v.productId) } };
    if (invScope) Object.assign(scopedProductQuery, invScope);
    const [products, branches] = await Promise.all([
      InvProduct.find(scopedProductQuery).select('_id name nameAr').lean(),
      Branch.find({ _id: { $in: variants.map((v) => v.branchId) } }).select('_id name').lean(),
    ]);
    const productById = new Map(products.map((p) => [String(p._id), p]));
    const branchById = new Map(branches.map((b) => [String(b._id), b]));

    return res.status(200).json({
      // A code match whose product is out of scope is dropped here, not shown
      // and then refused on save.
      data: variants.filter((v) => productById.has(String(v.productId))).slice(0, 25).map((v) => {
        const p = productById.get(String(v.productId)) || {};
        return {
          variantId: v._id, productId: v.productId, branchId: v.branchId,
          code: v.code, productName: p.name || '', productNameAr: p.nameAr || '',
          unit: v.unit, quantity: v.quantity,
          branchName: (branchById.get(String(v.branchId)) || {}).name || '',
        };
      }),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /users/jobReports/lookup/content?search= — one search across the four
// Digital Marketing record kinds a rep can point at, flattened into a single
// picker list (the person remembers "the Carrara reel", not which sub-section
// it lives in). Digital Marketing is not branch-scoped, so neither is this.
router.get('/jobReports/lookup/content', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    if (search.length < 2) return res.status(200).json({ data: [] });
    const re = new RegExp(escapeJrRegex(search), 'i');

    // Digital Marketing is not branch-scoped but it IS row-level scoped: on a
    // 'mine' scope a creator only sees their own batches, here as anywhere.
    // whatsappShare and linkPage carry no owner and are deliberately shared
    // records, so the scope does not apply to them.
    const dmScope = (await isSuperAdmin(req.user.id)) ? null : await dmScopeFilter(req.user.id);
    const scoped = (q) => (dmScope ? { ...q, ...dmScope } : q);

    const [raw, ready, shares, pages] = await Promise.all([
      RawContent.find(scoped({ deleteDate: null, title: re })).select('_id title insertDate').limit(10).lean(),
      ReadyToUpload.find(scoped({ deleteDate: null, $or: [{ title: re }, { caption: re }] }))
        .select('_id title caption insertDate').limit(10).lean(),
      WhatsappShare.find({ deleteDate: null, $or: [{ productName: re }, { variantCode: re }] })
        .select('_id productName variantCode insertDate').limit(10).lean(),
      ExternalLinkPage.find({ deleteDate: null, $or: [{ title: re }, { code: re }] })
        .select('_id title code insertDate').limit(10).lean(),
    ]);

    const data = [
      ...raw.map((d) => ({ kind: 'rawContent', id: d._id, title: DM_KINDS.rawContent.title(d), date: d.insertDate })),
      ...ready.map((d) => ({ kind: 'readyToUpload', id: d._id, title: DM_KINDS.readyToUpload.title(d), date: d.insertDate })),
      ...shares.map((d) => ({ kind: 'whatsappShare', id: d._id, title: DM_KINDS.whatsappShare.title(d), date: d.insertDate })),
      ...pages.map((d) => ({ kind: 'linkPage', id: d._id, title: DM_KINDS.linkPage.title(d), date: d.insertDate })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.status(200).json({ data });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /users/jobReports — ADMIN MODE: every user's reports, filterable by
// user + date range. MUST be registered before GET /:id/jobReports so
// 'jobReports' is never captured as an :id (same lesson as CRM's
// /customers/bulk vs /customers/:id).
// ?userId=&dateFrom=&dateTo=&page=&limit=
router.get('/jobReports', verify, requirePermission('jobReports:viewAll'), async (req, res) => {
  try {
    const { userId, dateFrom, dateTo, page = 1, limit = 30 } = req.query;
    // A draft is the author's own working copy — it is not filed yet, so it
    // has no business in the admin list. $ne (rather than status:'submitted')
    // also matches every report filed before `status` existed.
    const filter = { deleteDate: null, status: { $ne: 'draft' } };
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
      if (report.status === 'draft') return res.status(403).json({ message: 'Access denied' });
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
    // You see your own drafts (that is how an unfinished sheet is picked back
    // up); nobody else does.
    if (String(targetId) !== String(req.user.id)) filter.status = { $ne: 'draft' };
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
    : isVideoUpload(file) ? 'video'
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

  if (kind === 'video') transcodeVideoAsync(File, fileDoc, file.path);

  return { fileId: fileDoc._id, kind, diskName: file.filename, name: file.originalname, thumbnail };
}

async function getJobReportActorName(userId) {
  const actor = await userM.findById(userId).select('firstName lastName').lean();
  return actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '';
}

// ── Dynamic form: autosave draft, submit, printable sheet ───────────────────
// The form writes a draft on every pause, so a rep who gets a phone call
// half-way through loses nothing. A draft is the author's own working copy —
// it stays out of the admin list and notifies nobody until it is submitted.

// Applies a template payload onto a report document. `sections` arrives either
// as an object (JSON body) or a string (multipart form), is rebuilt entirely
// server-side from the template spec, and the fields a template marked `bind`
// are copied onto the real top-level columns so the admin list, notifications
// and every report filed before templates existed keep reading the same way.
// markModified is not optional here: `sections` is a Mixed path, and without
// it Mongoose saves the document while silently dropping the change.
async function applyJobReportTemplate(report, body, userId) {
  if (body.templateKey !== undefined && isKnownTemplate(body.templateKey)) {
    report.templateKey = body.templateKey;
  }
  if (body.sections === undefined) return;

  let raw = body.sections;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (_) { raw = {}; }
  }

  const { sections, links, bound } = await resolveJobReportSections(
    userId, report.templateKey || DEFAULT_TEMPLATE, raw,
  );
  report.sections = sections;
  report.markModified('sections');
  report.links = links;

  if (bound.reportDate) report.reportDate = bound.reportDate;
  if (bound.title !== undefined) report.title = String(bound.title || '').trim();
  if (bound.body !== undefined) report.body = String(bound.body || '').trim();
}

// A salesperson sheet has no title field — without this every row in the list
// and every notification would read as a blank. Derived, never stored by the
// client, and only when the template did not bind one.
function ensureJobReportTitle(report) {
  if (report.title && report.title.trim()) return;
  const tpl = resolveJobReportTemplate(report.templateKey);
  const d = report.reportDate ? new Date(report.reportDate) : new Date();
  const stamp = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  report.title = `${tpl.label.en} — ${stamp}`;
}

// GET /users/me/jobReports/draft?templateKey=&reportDate= — resume where the
// last session stopped. One draft per author per template per day, which is
// what makes a reopened form pick the record back up instead of starting a
// second one beside it.
router.get('/me/jobReports/draft', verify, async (req, res) => {
  try {
    const templateKey = isKnownTemplate(req.query.templateKey)
      ? req.query.templateKey
      : await resolveUserJobReportTemplate(req.user.id);

    const filter = { userId: req.user.id, status: 'draft', templateKey, deleteDate: null };
    if (req.query.reportDate) {
      const day = new Date(req.query.reportDate);
      if (!Number.isNaN(day.getTime())) {
        filter.reportDate = {
          $gte: new Date(day.setHours(0, 0, 0, 0)),
          $lte: new Date(new Date(req.query.reportDate).setHours(23, 59, 59, 999)),
        };
      }
    }

    const draft = await UserJobReport.findOne(filter).sort({ autoSavedAt: -1 }).lean();
    return res.status(200).json({ draft: draft || null });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /users/me/jobReports/draft — THE AUTOSAVE TARGET. Called on every pause
// while typing, so it stays deliberately small: JSON only (attachments go
// through the multipart edit route), no notification, and a response carrying
// just enough for the form to show "saved at HH:MM".
router.put('/me/jobReports/draft', verify, async (req, res) => {
  try {
    const templateKey = isKnownTemplate(req.body.templateKey)
      ? req.body.templateKey
      : await resolveUserJobReportTemplate(req.user.id);

    let report = null;
    if (req.body.reportId) {
      // An explicit id only ever resolves to the caller's OWN draft — this is
      // never a way to edit a submitted report, let alone somebody else's.
      report = await UserJobReport.findOne({
        _id: req.body.reportId, userId: req.user.id, status: 'draft', deleteDate: null,
      });
    }

    const reportDate = req.body.reportDate ? new Date(req.body.reportDate) : new Date();
    if (Number.isNaN(reportDate.getTime())) return res.status(400).json({ message: 'Invalid report date' });

    if (!report) {
      const dayStart = new Date(new Date(reportDate).setHours(0, 0, 0, 0));
      const dayEnd = new Date(new Date(reportDate).setHours(23, 59, 59, 999));
      report = await UserJobReport.findOne({
        userId: req.user.id, status: 'draft', templateKey, deleteDate: null,
        reportDate: { $gte: dayStart, $lte: dayEnd },
      });
    }

    if (!report) {
      report = new UserJobReport({
        userId: req.user.id, reportDate, templateKey, status: 'draft', insertDate: new Date(),
      });
    }

    report.templateKey = templateKey;
    report.reportDate = reportDate;
    await applyJobReportTemplate(report, req.body, req.user.id);
    report.autoSavedAt = new Date();
    report.updateDate = new Date();
    touchLastActivity(report);
    await report.save();

    return res.status(200).json({
      _id: report._id, status: report.status,
      autoSavedAt: report.autoSavedAt, sections: report.sections,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /users/me/jobReports/:reportId/submit — a draft becomes a filed report.
// This is the moment the group's admins hear about it; an autosave never does.
router.post('/me/jobReports/:reportId/submit', verify, async (req, res) => {
  try {
    const report = await UserJobReport.findOne({
      _id: req.params.reportId, userId: req.user.id, deleteDate: null,
    });
    if (!report) return res.status(404).json({ message: 'Report not found' });
    if (report.status !== 'draft') return res.status(409).json({ message: 'This report has already been submitted' });

    // Last write wins: whatever the form holds at the moment Submit is pressed
    // is what gets filed, even if the final keystroke never triggered an
    // autosave.
    if (req.body && (req.body.sections !== undefined || req.body.reportDate)) {
      if (req.body.reportDate) {
        const d = new Date(req.body.reportDate);
        if (!Number.isNaN(d.getTime())) report.reportDate = d;
      }
      await applyJobReportTemplate(report, req.body, req.user.id);
    }

    ensureJobReportTitle(report);
    report.status = 'submitted';
    report.submittedAt = new Date();
    report.updateDate = new Date();
    touchLastActivity(report);
    await report.save();

    const actorName = await getJobReportActorName(req.user.id);
    notifyGroupAdminsOfJobReport(req.user.id, actorName, report, 'jobReportGroupCreated');
    // the stones tied to customers in the report become those customers' interests (CRM)
    await syncReportInterest(report, req.user.id, actorName);

    return res.status(200).json(report);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /users/me/jobReports/draft/:reportId — discard a draft outright.
// Separate from the ordinary delete so "throw this half-filled sheet away"
// cannot be confused with deleting a report that was actually filed.
router.delete('/me/jobReports/draft/:reportId', verify, async (req, res) => {
  try {
    const report = await UserJobReport.findOneAndUpdate(
      { _id: req.params.reportId, userId: req.user.id, status: 'draft', deleteDate: null },
      { $set: { deleteDate: new Date() } }, { new: true },
    );
    if (!report) return res.status(404).json({ message: 'Draft not found' });
    return res.status(200).json({ message: 'Draft discarded' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /users/jobReports/:reportId/html?lang=en|ar|fa — the printable sheet.
// HTML, not PDF, because documents in this app are printed by the BROWSER
// (the production server cannot run headless Chrome) — the frontend drops this
// into a hidden iframe and calls print(), exactly as invoices and packing
// lists do. Same access rule as reading the report itself.
router.get('/jobReports/:reportId/html', verify, async (req, res) => {
  try {
    const report = await UserJobReport.findOne({ _id: req.params.reportId, deleteDate: null }).lean();
    if (!report) return res.status(404).json({ message: 'Report not found' });

    if (String(report.userId) !== String(req.user.id)) {
      if (report.status === 'draft') return res.status(403).json({ message: 'Access denied' });
      const perms = await getEffectivePermissions(req.user.id);
      if (!perms.has('users:view') && !perms.has('jobReports:viewAll')) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    const author = await userM.findById(report.userId).select('firstName lastName').lean();
    report.authorName = author ? `${author.firstName || ''} ${author.lastName || ''}`.trim() : '';

    const html = renderJobReportHtml(report, { lang: req.query.lang });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /users/me/jobReports — create your OWN report (text + up to 5 voice/video/photo/document attachments).
router.post('/me/jobReports', verify, notesUpload.array('files', MAX_BATCH_FILES), async (req, res) => {
  try {
    const reportDate = req.body.reportDate ? new Date(req.body.reportDate) : new Date();
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const body  = typeof req.body.body  === 'string' ? req.body.body.trim()  : '';
    const uploadedFiles = req.files || [];

    const report = await UserJobReport.create({ userId: req.user.id, reportDate, title, body, insertDate: new Date() });

    // A report filed in one go, without ever having been autosaved as a draft.
    // Writes nothing when the caller sends no sections, so the classic
    // title+body path is byte-for-byte what it always was.
    await applyJobReportTemplate(report, req.body, req.user.id);
    ensureJobReportTitle(report);
    report.status = 'submitted';
    report.submittedAt = new Date();

    if (uploadedFiles.length) {
      const files = [];
      for (const file of uploadedFiles) files.push(await makeJobReportFileEntry(file, req.user.id, report._id));
      report.files = files;
    }
    touchLastActivity(report);
    await report.save();

    const actorName = await getJobReportActorName(req.user.id);
    notifyGroupAdminsOfJobReport(req.user.id, actorName, report, 'jobReportGroupCreated');
    await syncReportInterest(report, req.user.id, actorName);

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
    // Applied after the plain fields so a template's bound values win — they
    // are the same values, resolved and clamped.
    await applyJobReportTemplate(report, req.body, req.user.id);

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

    // A draft has not been filed yet, so there is nothing for a group admin to
    // be told about — attaching a photo mid-form must not page anyone.
    if (report.status !== 'draft') {
      const actorName = await getJobReportActorName(req.user.id);
      notifyGroupAdminsOfJobReport(req.user.id, actorName, report, 'jobReportGroupUpdated');
      await syncReportInterest(report, req.user.id, actorName);
    }

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
