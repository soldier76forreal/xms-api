const express  = require('express');
const mongoose = require('mongoose');
const multer   = require('multer');
const sharp    = require('sharp');
const { blockExecutableFiles, uploadLimits } = require('../../utils/uploadGuards');

const dbConnection   = require('../../connections/xmsPr');
const blogPostSchema = require('../../models/blogPostModel');
const userSchema     = require('../../models/userModel');
const fileSchema     = require('../../models/fileModel');
const verify = require('../users/verifyToken');
const { requirePermission } = require('../../utils/rbac');
const { sanitizeHtml } = require('../../utils/sanitizeHtml');

const BlogPost = dbConnection.models.blogPost || dbConnection.model('blogPost', blogPostSchema);
const User     = dbConnection.models.user     || dbConnection.model('user',     userSchema);
const File     = dbConnection.models.file     || dbConnection.model('file',     fileSchema);

async function getActorName(userId) {
  const actor = await User.findById(userId).select('firstName lastName').lean();
  return actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '';
}

// Same disk destination + naming convention as routes/digitalMarketing/main.js's
// dmUpload (public/uploads, served by server.js's static mount at /uploads/...)
// — duplicated here rather than importing from main.js so this file stays
// self-contained; it's ~15 lines, not worth coupling the two route modules.
const blogUpload = multer({ limits: uploadLimits, fileFilter: blockExecutableFiles, storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename:    (req, file, cb) => {
    const ext = file.originalname.match(/\..*$/)?.[0] || '';
    cb(null, `blog-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
}) });

async function makeImageFileDoc(file, userId, attachedToId) {
  let thumbnail = null;
  try {
    const thumbFilename = `thumb-${file.filename}`;
    await sharp(file.path).resize(600).jpeg({ quality: 82 }).toFile(`public/uploads/${thumbFilename}`);
    thumbnail = thumbFilename;
  } catch (_) { /* non-fatal */ }

  const fileDoc = await File.create({
    name: file.originalname.split('.')[0],
    supFolder: null,
    metaData: file,
    format: file.originalname.slice(file.originalname.lastIndexOf('.') + 1),
    generatedBy: userId,
    thumbnail,
    scope: 'digitalMarketing',
    attachedTo: { type: 'blogPost', id: attachedToId },
  });

  return { fileId: fileDoc._id, diskName: file.filename };
}

const router = express.Router();

// Digital Marketing — Blog CMS (Phase C). Staff-facing CRUD, gated by
// digitalMarketing:view (read) / digitalMarketing:blog:create|edit|delete
// (write) — same permission mechanism as the rest of DM, no new access
// system. Mounted separately from routes/digitalMarketing/main.js (which was
// already 1400+ lines) at the same /digitalMarketing base path in server.js.
// Public read (published only) lives in routes/public/website.js.

function toListItem(p) {
  return {
    _id: p._id, title: p.title, slug: p.slug, status: p.status,
    coverImage: p.coverImage, publishedAt: p.publishedAt,
    updateDate: p.updateDate, createdByName: p.createdByName,
  };
}

// GET /digitalMarketing/blog — list all posts (draft + published), newest first.
router.get('/', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    const posts = await BlogPost.find({ deleteDate: null }).sort({ insertDate: -1 }).lean();
    return res.status(200).json({ data: posts.map(toListItem) });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /digitalMarketing/blog/upload-image — a single inline image for the
// TipTap editor body (NOT the cover image — that travels with create/update
// below). Returns a servable URL immediately so the editor can insert it
// mid-edit, before the post itself is saved. attachedTo.id is intentionally
// null (the post may not exist yet) — same "attach later if useful" gap as
// linkPage's create-before-record-exists cover upload.
router.post('/upload-image', verify, requirePermission('digitalMarketing:blog:create'),
  blogUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No image provided' });
    const { diskName } = await makeImageFileDoc(req.file, req.user.id, null);
    return res.status(201).json({ diskName, url: `/uploads/${diskName}` });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /digitalMarketing/blog/:id — full record (all 3 languages) for the editor.
router.get('/:id', verify, requirePermission('digitalMarketing:view'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const post = await BlogPost.findOne({ _id: req.params.id, deleteDate: null }).lean();
    if (!post) return res.status(404).json({ message: 'Post not found' });
    return res.status(200).json(post);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

function buildFields(body) {
  const fields = {};
  ['title', 'titleAr', 'titleFa', 'excerpt', 'excerptAr', 'excerptFa', 'slug'].forEach((k) => {
    if (body[k] !== undefined) fields[k] = String(body[k] || '').trim();
  });
  ['body', 'bodyAr', 'bodyFa'].forEach((k) => {
    if (body[k] !== undefined) fields[k] = sanitizeHtml(String(body[k] || ''));
  });
  if (body.seo) {
    try {
      const seoIn = JSON.parse(body.seo);
      fields.seo = {};
      ['metaTitle', 'metaDescription', 'metaTitleAr', 'metaDescriptionAr', 'metaTitleFa', 'metaDescriptionFa']
        .forEach((k) => { fields.seo[k] = String(seoIn[k] || '').trim(); });
    } catch (_) { /* malformed seo JSON — ignore, keep existing */ }
  }
  return fields;
}

// POST /digitalMarketing/blog — create (starts as draft unless status is sent).
// Multipart: cover (file, optional) + title/titleAr/.../body/.../seo(JSON)/slug/status.
router.post('/', verify, requirePermission('digitalMarketing:blog:create'),
  blogUpload.single('cover'), async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ message: 'Title is required' });

    const fields = buildFields(req.body);
    const slug = fields.slug || undefined;
    delete fields.slug;
    const status = req.body.status === 'published' ? 'published' : 'draft';

    if (slug) {
      const clash = await BlogPost.findOne({ slug, deleteDate: null }).select('_id').lean();
      if (clash) return res.status(409).json({ message: 'This slug is already in use' });
    }
    if (status === 'published' && !slug) return res.status(400).json({ message: 'A slug is required to publish' });

    const createdByName = await getActorName(req.user.id);
    const post = await BlogPost.create({
      ...fields, title, status, slug,
      publishedAt: status === 'published' ? new Date() : null,
      createdBy: req.user.id, createdByName,
      insertDate: new Date(), updateDate: new Date(),
    });

    if (req.file) {
      const { fileId, diskName } = await makeImageFileDoc(req.file, req.user.id, post._id);
      post.coverImage = { fileId, diskName };
      await post.save();
    }

    return res.status(201).json(post);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /digitalMarketing/blog/:id — edit fields and/or toggle draft<->published.
router.put('/:id', verify, requirePermission('digitalMarketing:blog:edit'),
  blogUpload.single('cover'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const post = await BlogPost.findOne({ _id: req.params.id, deleteDate: null });
    if (!post) return res.status(404).json({ message: 'Post not found' });

    const fields = buildFields(req.body);
    const unset = {};

    if (fields.slug !== undefined) {
      const slug = fields.slug;
      delete fields.slug;
      if (slug) {
        const clash = await BlogPost.findOne({ slug, _id: { $ne: post._id }, deleteDate: null }).select('_id').lean();
        if (clash) return res.status(409).json({ message: 'This slug is already in use' });
        fields.slug = slug;
      } else {
        unset.slug = '';
      }
    }

    let nextStatus = post.status;
    if (req.body.status && ['draft', 'published'].includes(req.body.status)) nextStatus = req.body.status;
    const nextSlug = fields.slug !== undefined ? fields.slug : (unset.slug !== undefined ? null : post.slug);
    if (nextStatus === 'published' && !nextSlug) return res.status(400).json({ message: 'A slug is required to publish' });
    fields.status = nextStatus;
    if (nextStatus === 'published' && post.status !== 'published') fields.publishedAt = new Date();
    if (nextStatus === 'draft') fields.publishedAt = null;

    if (req.file) {
      const { fileId, diskName } = await makeImageFileDoc(req.file, req.user.id, post._id);
      fields.coverImage = { fileId, diskName };
    }

    fields.updateDate = new Date();

    const update = { $set: fields };
    if (Object.keys(unset).length) update.$unset = unset;
    const updated = await BlogPost.findByIdAndUpdate(post._id, update, { new: true });
    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /digitalMarketing/blog/:id — soft delete. Also $unsets the slug: the
// field is unique+sparse, and a sparse index only skips a TRULY ABSENT key,
// not a present-but-soft-deleted one — leaving it set would permanently block
// any future post from reusing that URL (the same trap as the inventory
// website.slug fix; see PUT /:id below and CLAUDE.md's MongoDB gotcha notes).
router.delete('/:id', verify, requirePermission('digitalMarketing:blog:delete'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const post = await BlogPost.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: { deleteDate: new Date() }, $unset: { slug: '' } },
      { new: true }
    );
    if (!post) return res.status(404).json({ message: 'Post not found' });
    return res.status(200).json({ message: 'Deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
