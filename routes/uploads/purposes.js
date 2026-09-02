const path = require('path');
const sharp = require('sharp');

const dbConnection = require('../../connections/xmsPr');
const fileSchema = require('../../models/fileModel');
const folderSchema = require('../../models/folderModel');
const inventoryVariantSchema = require('../../models/inventoryVariantModel');
const inventoryProductSchema = require('../../models/inventoryProductModel');
const inventoryChangeLogSchema = require('../../models/inventoryChangeLogModel');
const customerActivitySchema = require('../../models/customerActivityModel');
const userNoteSchema = require('../../models/userNoteModel');
const fileActivitySchema = require('../../models/fileActivityModel');
const userSchema = require('../../models/userModel');

const { assertBranchAccess } = require('../../utils/rbac');
const { convertHeicIfNeeded, extractVideoThumbnail, transcodeVideoAsync } = require('../../utils/mediaConvert');

const File            = dbConnection.models.file || dbConnection.model('file', fileSchema);
const Folder          = dbConnection.models.folder || dbConnection.model('folder', folderSchema);
const InvVariant      = dbConnection.models.inventoryVariant || dbConnection.model('inventoryVariant', inventoryVariantSchema);
const InvProduct      = dbConnection.models.inventoryProduct || dbConnection.model('inventoryProduct', inventoryProductSchema);
const InvChangeLog    = dbConnection.models.inventoryChangeLog || dbConnection.model('inventoryChangeLog', inventoryChangeLogSchema);
const CustomerActivity = dbConnection.models.customerActivity || dbConnection.model('customerActivity', customerActivitySchema);
const UserNote        = dbConnection.models.userNote || dbConnection.model('userNote', userNoteSchema);
const FileActivity    = dbConnection.models.fileActivity || dbConnection.model('fileActivity', fileActivitySchema);
const UserM           = dbConnection.models.user || dbConnection.model('user', userSchema);

// ── Upload Center — per-purpose completion ───────────────────────────────────
//
// utils/resumableUpload.js solves the generic problem (get bytes onto disk,
// resumably) and hands back a MULTER-SHAPED file object. This table is the
// other half: what each kind of upload means once the bytes have landed.
//
// Each entry declares:
//   permission  — the key required to start this kind of upload (null = the
//                 upload only ever touches the caller's OWN data, which this
//                 app has never gated: avatars, personal notes, own job
//                 reports — same precedent as those modules' classic routes).
//   prefix      — the on-disk filename prefix, matching what that module's
//                 multer storage already produces, so old and new uploads are
//                 indistinguishable on disk.
//   complete()  — runs the module's real post-upload work.
//
// Where a module already had a reusable helper (tutorials/DM makeFileDoc,
// users' makeJobReportFileEntry) it is imported and called, NOT reimplemented.
// The modules whose logic was inline in a route handler have it mirrored here;
// those are marked, and the two paths must be kept in step.
//
// Requires are done lazily inside complete() for the modules that import this
// project's route files, to avoid a require cycle at boot.

function extOf(name = '') {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i);
}

async function makeThumbnail(file) {
  if (!String(file.mimetype || '').startsWith('image/')) return null;
  try {
    const thumbFilename = `thumb-${file.filename}`;
    await sharp(file.path).resize(300).jpeg({ quality: 80 })
      .toFile(path.join(file.destination || 'public/uploads', thumbFilename));
    return thumbFilename;
  } catch (_) {
    return null;   // thumbnails are non-fatal everywhere else in this app too
  }
}

const PURPOSES = {
  // ── File Manager ─────────────────────────────────────────────────────────
  // Mirrors POST /files/uploadFile in routes/fileManager/main.js.
  fileManager: {
    permission: 'files:upload',
    prefix: 'files',
    async complete({ file, session, userId }) {
      const supFolder = (session.extra && session.extra.supFolder) || 'root';
      const thumbnail = await makeThumbnail(file);

      const created = await File.create({
        name: session.filename.split('.', 1).pop(),
        supFolder,
        metaData: file,
        format: extOf(session.filename).replace('.', ''),
        insertDate: Date.now(),
        logsStatus: { status: 'created', msg: 'file created!' },
        generatedBy: userId,
        thumbnail,
        scope: (session.extra && session.extra.scope) || 'file_manager',
        attachedTo: session.extra && session.extra.attachedToType && session.extra.attachedToId
          ? { type: session.extra.attachedToType, id: session.extra.attachedToId }
          : undefined,
      });

      if (supFolder && supFolder !== 'root') {
        await Folder.updateOne({ _id: supFolder }, { $push: { subFiles: created._id } });
      }

      // Same activity row the classic route writes.
      try {
        const actor = await UserM.findById(userId).select('firstName lastName').lean();
        await FileActivity.create({
          type: 'upload', itemKind: 'file', itemId: created._id, itemName: created.name,
          path: supFolder, actorId: userId,
          actorName: actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '',
          date: new Date(),
        });
      } catch (_) { /* activity is best-effort, as everywhere else */ }

      return { fileId: created._id, file: created };
    },
  },

  // ── Tutorials ────────────────────────────────────────────────────────────
  tutorial: {
    permission: 'tutorials:edit',   // adding a file to an EXISTING tutorial
    prefix: 'tutorial',
    async complete({ file, session, userId }) {
      const tutorials = require('../tutorials/main');
      const entry = await tutorials.makeFileDoc(file, userId, session.targetId);
      await tutorials.Tutorial.updateOne({ _id: session.targetId }, { $push: { files: entry } });
      return { fileId: entry.fileId, entry };
    },
  },

  // ── Digital Marketing ────────────────────────────────────────────────────
  dmRawContent: {
    permission: 'digitalMarketing:rawContent:edit',
    prefix: 'dm',
    async complete({ file, session, userId }) {
      const dm = require('../digitalMarketing/main');
      const entry = await dm.makeFileDoc(file, userId, 'rawContent', session.targetId);
      await dm.RawContent.updateOne(
        { _id: session.targetId },
        { $push: { files: { ...entry, description: (session.extra && session.extra.description) || '', addedAt: new Date() } } }
      );
      return { fileId: entry.fileId, entry };
    },
  },

  dmReadyToUpload: {
    permission: 'digitalMarketing:readyToUpload:edit',
    prefix: 'dm',
    async complete({ file, session, userId }) {
      const dm = require('../digitalMarketing/main');
      const entry = await dm.makeFileDoc(file, userId, 'readyToUpload', session.targetId);
      await dm.ReadyToUpload.updateOne(
        { _id: session.targetId },
        { $push: { files: { ...entry, addedAt: new Date() } } }
      );
      return { fileId: entry.fileId, entry };
    },
  },

  // Attaches a voice-description recording to an ALREADY-uploaded raw content
  // file, matched by extra.mainFileId. Sequenced client-side (the voice
  // recording only enqueues once the main file's upload has completed and its
  // real fileId is known), so this never races the entry it is attaching to —
  // no placeholder/correlation bookkeeping needed.
  dmRawContentVoice: {
    permission: 'digitalMarketing:rawContent:edit',
    prefix: 'dm',
    async complete({ file, session, userId }) {
      const dm = require('../digitalMarketing/main');
      const mainFileId = session.extra && session.extra.mainFileId;
      if (!mainFileId) { const e = new Error('mainFileId is required'); e.status = 400; throw e; }

      const entry = await dm.makeFileDoc(file, userId, 'rawContent', session.targetId);
      const result = await dm.RawContent.updateOne(
        { _id: session.targetId, 'files.fileId': mainFileId },
        { $set: { 'files.$.voiceDescriptionFileId': entry.fileId, 'files.$.voiceDescriptionDiskName': entry.diskName } }
      );
      if (result.matchedCount === 0) { const e = new Error('Target file entry not found'); e.status = 404; throw e; }
      return { fileId: entry.fileId, entry };
    },
  },

  // In-place file swap on an existing raw content entry (the "replace" action
  // in rawContentDetail.js) — keeps the entry's name/description, only the
  // underlying file/thumbnail/mimetype change. Matched by extra.editFileId.
  dmRawContentReplace: {
    permission: 'digitalMarketing:rawContent:edit',
    prefix: 'dm',
    async complete({ file, session, userId }) {
      const dm = require('../digitalMarketing/main');
      const editFileId = session.extra && session.extra.editFileId;
      if (!editFileId) { const e = new Error('editFileId is required'); e.status = 400; throw e; }

      const entry = await dm.makeFileDoc(file, userId, 'rawContent', session.targetId);
      const result = await dm.RawContent.updateOne(
        { _id: session.targetId, 'files.fileId': editFileId },
        { $set: {
          'files.$.fileId': entry.fileId, 'files.$.diskName': entry.diskName,
          'files.$.mimetype': entry.mimetype, 'files.$.thumbnail': entry.thumbnail,
        } }
      );
      if (result.matchedCount === 0) { const e = new Error('Target file entry not found'); e.status = 404; throw e; }
      return { fileId: entry.fileId, entry };
    },
  },

  // Same in-place swap, for a ready-to-upload entry (mirrors dmRawContentReplace).
  dmReadyToUploadReplace: {
    permission: 'digitalMarketing:readyToUpload:edit',
    prefix: 'dm',
    async complete({ file, session, userId }) {
      const dm = require('../digitalMarketing/main');
      const editFileId = session.extra && session.extra.editFileId;
      if (!editFileId) { const e = new Error('editFileId is required'); e.status = 400; throw e; }

      const entry = await dm.makeFileDoc(file, userId, 'readyToUpload', session.targetId);
      const result = await dm.ReadyToUpload.updateOne(
        { _id: session.targetId, 'files.fileId': editFileId },
        { $set: {
          'files.$.fileId': entry.fileId, 'files.$.diskName': entry.diskName,
          'files.$.mimetype': entry.mimetype, 'files.$.thumbnail': entry.thumbnail,
        } }
      );
      if (result.matchedCount === 0) { const e = new Error('Target file entry not found'); e.status = 404; throw e; }
      return { fileId: entry.fileId, entry };
    },
  },

  // Sets (never appends — a page has exactly one) the cover image on an
  // external link page. Works identically whether called right after
  // creation (page created with no cover, then this attaches one) or as a
  // later edit — by the time this runs the page already exists either way,
  // so both cases are gated by :edit.
  dmLinkPageCover: {
    permission: 'digitalMarketing:linkPage:edit',
    prefix: 'dm',
    imagesOnly: true,
    async complete({ file, session, userId }) {
      const dm = require('../digitalMarketing/main');
      const entry = await dm.makeFileDoc(file, userId, 'linkPage', session.targetId);
      const coverImage = { fileId: entry.fileId, diskName: entry.diskName, name: entry.name, mimetype: entry.mimetype };
      await dm.ExternalLinkPage.updateOne({ _id: session.targetId }, { $set: { coverImage } });
      return { fileId: entry.fileId, coverImage };
    },
  },

  // ── Inventory media ──────────────────────────────────────────────────────
  // Mirrors POST /inventory/variants/:id/media, including the change-log row
  // that every media mutation in that module is required to write, and the
  // auto-set-cover step that route has but this purpose was missing until now.
  inventoryMedia: {
    permission: 'inventory:media:edit',
    prefix: 'files',
    async complete({ file, session, userId }) {
      const variant = await InvVariant.findOne({ _id: session.targetId, deleteDate: null });
      if (!variant) { const e = new Error('Variant not found'); e.status = 404; throw e; }
      if (!(await assertBranchAccess(userId, variant.branchId))) {
        const e = new Error('You do not have access to this branch'); e.status = 403; throw e;
      }

      const isVideo = String(file.mimetype || '').startsWith('video/');
      const isImage = String(file.mimetype || '').startsWith('image/');
      let thumbnail = null;
      let webPreview = null;
      if (isImage) {
        thumbnail = await makeThumbnail(file);
        webPreview = await convertHeicIfNeeded(file);
      } else if (isVideo) {
        thumbnail = await extractVideoThumbnail(file.path, `thumb-${file.filename}.jpg`);
      }

      const created = await File.create({
        name: session.filename.split('.')[0],
        supFolder: null,
        metaData: file,
        format: extOf(session.filename).replace('.', ''),
        generatedBy: userId,
        thumbnail,
        webPreview,
        transcodeStatus: isVideo ? 'pending' : 'none',
        scope: 'inventory',
        attachedTo: { type: 'inventoryVariant', id: variant._id },
      });

      if (isVideo) transcodeVideoAsync(File, created, file.path);

      await InvChangeLog.create({
        subjectType: 'variant', subjectId: variant._id, productId: variant.productId,
        changeType: 'media',
        mediaRef: { fileId: created._id, action: 'added', name: created.name },
        source: 'manual', changedBy: userId,
      });

      // Atomic guard (matches on coverMediaId:null) so two images completing
      // close together can't both win the race to become the cover.
      if (isImage) {
        await InvProduct.updateOne(
          { _id: variant.productId, coverMediaId: null },
          { $set: { coverMediaId: created._id, coverThumbnail: thumbnail || null } }
        );
      }

      return { fileId: created._id, file: created };
    },
  },

  // ── Inventory product media (accumulating gallery, not a batch/replace) ──
  // Mirrors POST /inventory/products/:id/media-batch's PER-FILE logic exactly,
  // just running once per background upload instead of once per multipart
  // request — purely additive, unlike the variant batch below.
  inventoryProductMedia: {
    permission: 'inventory:media:edit',
    prefix: 'files',
    async complete({ file, session, userId }) {
      const product = await InvProduct.findOne({ _id: session.targetId, deleteDate: null });
      if (!product) { const e = new Error('Product not found'); e.status = 404; throw e; }
      if (!(await assertBranchAccess(userId, product.branchId))) {
        const e = new Error('You do not have access to this branch'); e.status = 403; throw e;
      }

      const isVideo = String(file.mimetype || '').startsWith('video/');
      const isImage = String(file.mimetype || '').startsWith('image/');
      let thumbnail = null;
      let webPreview = null;
      if (isImage) {
        thumbnail = await makeThumbnail(file);
        webPreview = await convertHeicIfNeeded(file);
      } else if (isVideo) {
        thumbnail = await extractVideoThumbnail(file.path, `thumb-${file.filename}.jpg`);
      }

      const actor = await UserM.findById(userId).select('firstName lastName').lean();
      const uploaderName = actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '';

      const created = await File.create({
        name: session.filename.split('.')[0],
        supFolder: null,
        metaData: file,
        format: extOf(session.filename).replace('.', ''),
        generatedBy: userId,
        uploadedByName: uploaderName,
        thumbnail,
        webPreview,
        transcodeStatus: isVideo ? 'pending' : 'none',
        scope: 'inventory',
        attachedTo: { type: 'inventoryProduct', id: product._id },
      });

      if (isVideo) transcodeVideoAsync(File, created, file.path);

      await InvChangeLog.create({
        subjectType: 'product', subjectId: product._id, productId: product._id,
        changeType: 'media',
        mediaRef: { fileId: created._id, action: 'added', name: created.name },
        source: 'manual', changedBy: userId, changedByName: uploaderName,
      });

      if (isImage) {
        await InvProduct.updateOne(
          { _id: product._id, coverMediaId: null },
          { $set: { coverMediaId: created._id, coverThumbnail: thumbnail || null } }
        );
      }

      return { fileId: created._id, file: created };
    },
  },

  // ── Inventory VARIANT media batch (delete + replace, shared batch fields) ─
  // Unlike every other purpose in this file, this one can't stand alone: the
  // "delete the variant's current batch" step must run exactly ONCE per
  // batch submission, not once per file, so it happens in a dedicated
  // POST /inventory/variants/:id/media-batch/start call BEFORE any file's
  // Upload Center session begins — that call returns the batchId/uploadDate/
  // expirationDate this purpose expects on session.extra and stamps onto
  // every file in the batch, mirroring POST /variants/:id/media-batch.
  inventoryVariantMediaBatch: {
    permission: 'inventory:media:edit',
    prefix: 'files',
    async complete({ file, session, userId }) {
      const variant = await InvVariant.findOne({ _id: session.targetId, deleteDate: null });
      if (!variant) { const e = new Error('Variant not found'); e.status = 404; throw e; }
      if (!(await assertBranchAccess(userId, variant.branchId))) {
        const e = new Error('You do not have access to this branch'); e.status = 403; throw e;
      }
      const { batchId } = session.extra || {};
      if (!batchId) { const e = new Error('batchId is required — call media-batch/start first'); e.status = 400; throw e; }
      const uploadDate = session.extra.uploadDate ? new Date(session.extra.uploadDate) : new Date();
      const expirationDate = session.extra.expirationDate ? new Date(session.extra.expirationDate) : null;

      const isVideo = String(file.mimetype || '').startsWith('video/');
      const isImage = String(file.mimetype || '').startsWith('image/');
      let thumbnail = null;
      let webPreview = null;
      if (isImage) {
        thumbnail = await makeThumbnail(file);
        webPreview = await convertHeicIfNeeded(file);
      } else if (isVideo) {
        thumbnail = await extractVideoThumbnail(file.path, `thumb-${file.filename}.jpg`);
      }

      const actor = await UserM.findById(userId).select('firstName lastName').lean();
      const uploaderName = actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '';

      const created = await File.create({
        name: session.filename.split('.')[0],
        supFolder: null,
        metaData: file,
        format: extOf(session.filename).replace('.', ''),
        generatedBy: userId,
        uploadedByName: uploaderName,
        thumbnail,
        webPreview,
        transcodeStatus: isVideo ? 'pending' : 'none',
        scope: 'inventory',
        attachedTo: { type: 'inventoryVariant', id: variant._id },
        batchId, uploadDate, expirationDate,
      });

      if (isVideo) transcodeVideoAsync(File, created, file.path);

      await InvChangeLog.create({
        subjectType: 'variant', subjectId: variant._id, productId: variant.productId,
        changeType: 'media',
        mediaRef: { fileId: created._id, action: 'added', name: created.name },
        source: 'manual', changedBy: userId, changedByName: uploaderName,
      });

      if (isImage) {
        await InvProduct.updateOne(
          { _id: variant.productId, coverMediaId: null },
          { $set: { coverMediaId: created._id, coverThumbnail: thumbnail || null } }
        );
      }

      return { fileId: created._id, file: created };
    },
  },

  // ── CRM communication attachment ─────────────────────────────────────────
  crmCommunication: {
    permission: 'crm:communication:create',
    prefix: 'crm-comm',
    async complete({ file, session, userId }) {
      const mime = String(file.mimetype || '');
      const kind = mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'image';
      const thumbnail = kind === 'image' ? await makeThumbnail(file)
        : kind === 'video' ? await extractVideoThumbnail(file.path, `thumb-${file.filename}.jpg`) : null;

      const created = await File.create({
        name: session.filename.split('.')[0],
        supFolder: null, metaData: file,
        format: extOf(session.filename).replace('.', ''),
        generatedBy: userId, thumbnail,
        scope: 'crm',
        attachedTo: { type: 'customerActivity', id: session.targetId },
      });

      // Attach onto the activity row's media[] — the shape customerActivity
      // already uses (see models/customerActivityModel.js).
      await CustomerActivity.updateOne(
        { _id: session.targetId },
        { $push: { media: { fileId: created._id, kind, diskName: file.filename, name: session.filename, thumbnail } } }
      );

      return { fileId: created._id, file: created };
    },
  },

  // ── Job report attachment (own record only — no permission key) ──────────
  jobReport: {
    permission: null,
    prefix: 'note',
    async complete({ file, session, userId }) {
      const users = require('../users/users');
      const report = await users.UserJobReport.findOne({ _id: session.targetId, userId, deleteDate: null });
      if (!report) { const e = new Error('Report not found'); e.status = 404; throw e; }

      const entry = await users.makeJobReportFileEntry(file, userId, report._id);
      report.files.push(entry);
      report.updateDate = new Date();
      await report.save();
      return { fileId: entry.fileId, entry };
    },
  },

  // ── Personal note attachment (own record only) ───────────────────────────
  personalNote: {
    permission: null,
    prefix: 'note',
    async complete({ file, session, userId }) {
      const note = await UserNote.findOne({ _id: session.targetId, userId, deleteDate: null });
      if (!note) { const e = new Error('Note not found'); e.status = 404; throw e; }

      const mime = String(file.mimetype || '');
      const kind = mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video'
        : mime.startsWith('image/') ? 'image' : 'document';
      const thumbnail = kind === 'image' ? await makeThumbnail(file)
        : kind === 'video' ? await extractVideoThumbnail(file.path, `thumb-${file.filename}.png`) : null;

      const created = await File.create({
        name: session.filename.split('.')[0],
        supFolder: null, metaData: file,
        format: extOf(session.filename).replace('.', ''),
        generatedBy: userId, thumbnail,
        scope: 'users',
        attachedTo: { type: 'userNote', id: note._id },
      });

      note.files.push({ fileId: created._id, kind, diskName: file.filename, name: session.filename, thumbnail });
      note.updateDate = new Date();
      await note.save();
      return { fileId: created._id, file: created };
    },
  },

  // ── Avatar (own profile) ─────────────────────────────────────────────────
  // Mirrors POST /users/me/avatar in routes/users/users.js exactly — same
  // File doc + thumbnail + {fileId,url,thumbnail,filename} shape, since every
  // avatar consumer app-wide (userAvatar.js, users.js, myProfileModal.js, …)
  // reads .url/.thumbnail/.filename off profileImage.
  avatar: {
    permission: null,
    prefix: 'avatar',
    imagesOnly: true,
    async complete({ file, session, userId }) {
      const thumbnail = await makeThumbnail(file);

      const fileDoc = await File.create({
        name: session.filename,
        metaData: file,
        format: extOf(session.filename).replace('.', ''),
        generatedBy: userId,
        thumbnail,
        scope: 'users',
        attachedTo: { type: 'user', id: userId },
      });

      const profileImage = {
        fileId: fileDoc._id,
        url: `/uploads/${file.filename}`,
        thumbnail: thumbnail ? `/uploads/${thumbnail}` : null,
        filename: file.filename,
      };
      await UserM.updateOne({ _id: userId }, { $set: { profileImage, updateDate: new Date() } });
      return { profileImage };
    },
  },
};

module.exports = { PURPOSES };
