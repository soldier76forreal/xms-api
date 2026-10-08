const express  = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const crypto = require('crypto');
const { mkdir, writeFile } = require('fs/promises');
const verify   = require('../users/verifyToken');
const { requireSuperAdmin, isSuperAdmin, getUserBranches, assertBranchAccess, Branch, UserAccess } = require('../../utils/rbac');
const { websiteBranchSlug, validWebsiteBranchSlug } = require('../../utils/websiteBranchSlug');

const dbConnection = require('../../connections/xmsPr');
const inventoryProductSchema = require('../../models/inventoryProductModel');
const inventoryVariantSchema = require('../../models/inventoryVariantModel');
const misInvoiceSchema       = require('../../models/misInvoiceModel');
const misPackingListSchema   = require('../../models/misPackingListModel');
const supplyRecordSchema     = require('../../models/supplyRecordModel');
const userSchema             = require('../../models/userModel');

const InvProduct     = dbConnection.models.inventoryProduct || dbConnection.model('inventoryProduct', inventoryProductSchema);
const InvVariant     = dbConnection.models.inventoryVariant || dbConnection.model('inventoryVariant', inventoryVariantSchema);
const MisInvoice     = dbConnection.models.misInvoice       || dbConnection.model('misInvoice',       misInvoiceSchema);
const MisPackingList = dbConnection.models.misPackingList   || dbConnection.model('misPackingList',   misPackingListSchema);
const SupplyRecord   = dbConnection.models.supplyRecord     || dbConnection.model('supplyRecord',     supplyRecordSchema);
const User           = dbConnection.models.user             || dbConnection.model('user',             userSchema);

const router = express.Router();
const flagUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)),
}).single('flag');

async function slugConflict(slug, currentId) {
  const branches = await Branch.find({ deleteDate: null }).select('_id name websiteSlug').lean();
  return branches.some((branch) => String(branch._id) !== String(currentId || '') && websiteBranchSlug(branch) === slug);
}

// GET /branches — list. Any authenticated user can read (needed to render
// their own branch switcher); mutations are superAdmin-only below. A non-
// superAdmin gets back only the branches they're assigned to; superAdmin sees all.
router.get('/', verify, async (req, res) => {
  try {
    const superAdmin = await isSuperAdmin(req.user.id);
    if (superAdmin) {
      const branches = await Branch.find({ deleteDate: null }).sort('name').lean();
      return res.status(200).json(branches);
    }
    const ids = await getUserBranches(req.user.id);
    const branches = await Branch.find({ _id: { $in: ids }, deleteDate: null }).sort('name').lean();
    return res.status(200).json(branches);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /branches/shared-with-me — branches that have shared their Inventory +
// Supply with one of the caller's own branches (Branch.crossBranchAccess).
// Deliberately NOT gated by mis:crossBranch:quote: that key is about raising
// quotations, while this list also drives read-only catalogue browsing in the
// Inventory and Supply sections. Declared before /:id/stats so "shared-with-me"
// is never parsed as a branch id.
// ?branchId= (optional) narrows it to branches that shared with THAT branch —
// the one the user is currently working as. Sharing is an arrangement between
// branches, so this is what keeps "browse it" and "request from it" agreeing
// (a request is always raised from the active branch). It's also what makes the
// list meaningful for a superAdmin, who may hold no assigned branches at all.
router.get('/shared-with-me', verify, async (req, res) => {
  try {
    let own;
    if (req.query.branchId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.branchId)) return res.status(400).json({ message: 'Invalid branch id' });
      if (!(await assertBranchAccess(req.user.id, req.query.branchId))) return res.status(200).json({ data: [] });
      own = [String(req.query.branchId)];
    } else {
      own = (await getUserBranches(req.user.id)).map(String);
    }
    if (!own.length) return res.status(200).json({ data: [] });
    const branches = await Branch.find({
      status: 'active', deleteDate: null,
      crossBranchAccess: { $in: own.map((id) => new mongoose.Types.ObjectId(id)) },
    }).select('_id name country').sort('name').lean();
    return res.status(200).json({ data: branches.filter((b) => !own.includes(String(b._id))) });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /branches/:id/stats — what this branch actually contains, for the branch
// detail panel. Readable by a superAdmin or by someone assigned to the branch;
// counts only, no documents, so it stays cheap.
router.get('/:id/stats', verify, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid branch id' });

    const superAdmin = await isSuperAdmin(req.user.id);
    if (!superAdmin) {
      const mine = (await getUserBranches(req.user.id)).map(String);
      if (!mine.includes(String(id))) {
        return res.status(403).json({ message: 'You do not have access to this branch' });
      }
    }

    const branch = await Branch.findOne({ _id: id, deleteDate: null }).lean();
    if (!branch) return res.status(404).json({ message: 'Branch not found' });

    const branchId = new mongoose.Types.ObjectId(id);
    const [
      products, variants, invoices, quotations, packingLists, supplyRecords, accessDocs,
    ] = await Promise.all([
      InvProduct.countDocuments({ branchId, deleteDate: null }),
      InvVariant.countDocuments({ branchId, deleteDate: null }),
      MisInvoice.countDocuments({ branchId, docType: 'invoice', deleteDate: null }),
      MisInvoice.countDocuments({ branchId, docType: 'pre_invoice', deleteDate: null }),
      MisPackingList.countDocuments({ branchId, deleteDate: null }),
      SupplyRecord.countDocuments({ branchId, deleteDate: null }),
      UserAccess.find({ branches: branchId }).select('userId').lean(),
    ]);

    // Resolve the assigned staff to names so the panel can list them.
    const memberIds = accessDocs.map((a) => a.userId).filter(Boolean);
    const users = memberIds.length
      ? await User.find({ _id: { $in: memberIds } })
          .select('firstName lastName profileImage isOnline')
          .limit(50).lean()
      : [];

    // The branches this one has shared its Inventory + Supply with, resolved to
    // names so the panel doesn't need a second round trip.
    const shareIds = (branch.crossBranchAccess || []).filter(Boolean);
    const sharedWith = shareIds.length
      ? await Branch.find({ _id: { $in: shareIds }, deleteDate: null }).select('_id name').lean()
      : [];

    return res.status(200).json({
      data: {
        counts: { products, variants, invoices, quotations, packingLists, supplyRecords,
                  members: accessDocs.length },
        members: users.map((u) => ({
          _id: u._id,
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
          isOnline: !!u.isOnline,
        })),
        sharedWith,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /branches — create (superAdmin only)
router.post('/', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const websiteSlug = websiteBranchSlug({ websiteSlug: req.body.websiteSlug, name: req.body.name });
    if (!validWebsiteBranchSlug(websiteSlug) || await slugConflict(websiteSlug)) {
      return res.status(400).json({ message: 'Choose a unique website path using lowercase letters, numbers and hyphens.' });
    }
    const branch = await Branch.create({
      name: req.body.name,
      websiteSlug,
      description: req.body.description || '',
      country: req.body.country || null,
      address: req.body.address || '',
      phone: req.body.phone || '',
      instagramHandle: req.body.instagramHandle || '',
      associates: Array.isArray(req.body.associates)
        ? [...new Set(req.body.associates.filter((id) => mongoose.Types.ObjectId.isValid(id)).map(String))]
        : [],
      createdBy: req.user.id,
    });
    return res.status(201).json(branch);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'A branch with this name already exists' });
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /branches/:id — edit (superAdmin only)
router.put('/:id', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const current = await Branch.findOne({ _id: req.params.id, deleteDate: null }).select('name websiteSlug').lean();
    if (!current) return res.status(404).json({ message: 'Branch not found' });
    const websiteSlug = websiteBranchSlug({ websiteSlug: req.body.websiteSlug || current.websiteSlug, name: req.body.name || current.name });
    if (!validWebsiteBranchSlug(websiteSlug) || await slugConflict(websiteSlug, req.params.id)) {
      return res.status(400).json({ message: 'Choose a unique website path using lowercase letters, numbers and hyphens.' });
    }
    const updates = {
      name: req.body.name, description: req.body.description, status: req.body.status,
      websiteSlug,
      country: req.body.country || null,
      address: req.body.address || '', phone: req.body.phone || '', instagramHandle: req.body.instagramHandle || '',
      updateDate: new Date(),
    };
    // Which staff get notified about a public-website price request for this
    // branch (see POST /public/website/price-requests) — optional, only
    // touched when the caller actually sends it, so this route stays usable
    // for a plain name/status edit without accidentally wiping the list.
    if (Array.isArray(req.body.crossBranchAccess)) {
      // Only valid ids, de-duplicated, and never this branch itself.
      updates.crossBranchAccess = [...new Set(req.body.crossBranchAccess
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map(String)
        .filter((id) => id !== String(req.params.id)))];
    }
    if (Array.isArray(req.body.priceRequestNotifyUsers)) {
      updates.priceRequestNotifyUsers = req.body.priceRequestNotifyUsers;
    }
    if (Array.isArray(req.body.associates)) {
      updates.associates = [...new Set(req.body.associates
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map(String))];
    }
    // Session 72 — per-branch MIS PDF template selection. Same conditional-touch
    // pattern as priceRequestNotifyUsers above: only written when the caller
    // actually sends it, so a plain name/status edit never wipes it.
    if (req.body.misTemplates && typeof req.body.misTemplates === 'object') {
      const allowedKeys = ['customerInvoice', 'customerQuotation', 'interBranchInvoice',
        'interBranchQuotation', 'packingList', 'label', 'dealLetter'];
      const mt = {};
      for (const k of allowedKeys) if (req.body.misTemplates[k] !== undefined) mt[k] = req.body.misTemplates[k];
      updates.misTemplates = mt;
    }
    const branch = await Branch.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: updates },
      { new: true }
    );
    if (!branch) return res.status(404).json({ message: 'Branch not found' });
    return res.status(200).json(branch);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/flag', verify, requireSuperAdmin(), (req, res) => {
  flagUpload(req, res, async (uploadError) => {
    if (uploadError) return res.status(400).json({ message: uploadError.message });
    if (!req.file) return res.status(400).json({ message: 'Select a PNG, JPEG or WebP flag under 2 MB.' });
    try {
      const branch = await Branch.findOne({ _id: req.params.id, deleteDate: null });
      if (!branch) return res.status(404).json({ message: 'Branch not found' });
      const directory = path.join(__dirname, '../../public/uploads/branch-flags');
      await mkdir(directory, { recursive: true });
      const filename = crypto.randomUUID() + '.webp';
      const content = await sharp(req.file.buffer).rotate().resize(128, 128, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
      await writeFile(path.join(directory, filename), content);
      branch.flagImage = '/uploads/branch-flags/' + filename;
      branch.updateDate = new Date();
      await branch.save();
      return res.status(200).json({ flagImage: branch.flagImage });
    } catch (error) {
      return res.status(400).json({ message: 'The selected flag image could not be processed.' });
    }
  });
});

// DELETE /branches/:id — soft delete (superAdmin only)
router.delete('/:id', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const branch = await Branch.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: { deleteDate: new Date() } },
    );
    if (!branch) return res.status(404).json({ message: 'Branch not found' });
    return res.status(200).json({ message: 'Branch deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
