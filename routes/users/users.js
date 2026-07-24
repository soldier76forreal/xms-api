const express    = require('express');
const jwt_decode = require('jwt-decode');
const mongoose   = require('mongoose');
const path       = require('path');
const multer     = require('multer');
const sharp      = require('sharp');

const userModel              = require('../../models/userModel');
const notficationModel       = require('../../models/notficationsModel');
const invoiceModel           = require('../../models/invoiceModel');
const fileModel              = require('../../models/fileModel');
const inventoryChangeLogSchema = require('../../models/inventoryChangeLogModel');
const inventoryProductSchema   = require('../../models/inventoryProductModel');
const customerActivitySchema   = require('../../models/customerActivityModel');
const customerSchema           = require('../../models/customerModel');
const invoiceActivitySchema    = require('../../models/invoiceActivityModel');
const misInvoiceSchema         = require('../../models/misInvoiceModel');
const dbConnection        = require('../../connections/xmsPr');
const verify              = require('./verifyToken');
const { requirePermission, getEffectivePermissions, getEffectiveScopes, clearPermissionCache, isSuperAdmin, assertBranchAccess, UserAccess, Role } = require('../../utils/rbac');

const dotenv = require('dotenv');
dotenv.config();

const userM        = dbConnection.model('user',       userModel);
const notfication  = dbConnection.model('notfication', notficationModel);
const invoice      = dbConnection.model('invoice',     invoiceModel);
const File         = dbConnection.model('file',        fileModel);
const InvChangeLog = dbConnection.models.inventoryChangeLog || dbConnection.model('inventoryChangeLog', inventoryChangeLogSchema);
const InvProduct   = dbConnection.models.inventoryProduct   || dbConnection.model('inventoryProduct',   inventoryProductSchema);
const CustomerActivity = dbConnection.models.customerActivity || dbConnection.model('customerActivity', customerActivitySchema);
const Customer         = dbConnection.models.customer         || dbConnection.model('customer',         customerSchema);
const InvoiceActivity  = dbConnection.models.invoiceActivity   || dbConnection.model('invoiceActivity',  invoiceActivitySchema);
const MisInvoice       = dbConnection.models.misInvoice        || dbConnection.model('misInvoice',       misInvoiceSchema);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename:    (req, file, cb) => cb(null, `avatar-${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

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

// ── GET /users/me/notification-prefs — read your OWN push preferences ─────────
const NOTIF_PREF_KEYS = ['tasks', 'assignments', 'invoices', 'dmChat', 'readyToUpload'];
const DEFAULT_NOTIF_PREFS = { tasks: true, assignments: true, invoices: true, dmChat: true, readyToUpload: true };

router.get('/me/notification-prefs', verify, async (req, res) => {
  try {
    const u = await userM.findById(req.user.id).select('notificationPrefs').lean();
    return res.status(200).json({ ...DEFAULT_NOTIF_PREFS, ...(u?.notificationPrefs || {}) });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /users/me/notification-prefs — set your OWN push preferences ──────────
router.put('/me/notification-prefs', verify, async (req, res) => {
  try {
    const setFields = { updateDate: new Date() };
    for (const k of NOTIF_PREF_KEYS) {
      if (req.body[k] !== undefined) setFields[`notificationPrefs.${k}`] = !!req.body[k];
    }
    const updated = await userM.findOneAndUpdate(
      { _id: req.user.id, deleteDate: null },
      { $set: setFields },
      { new: true }
    ).select('notificationPrefs');
    if (!updated) return res.status(404).json({ message: 'User not found' });
    return res.status(200).json({ ...DEFAULT_NOTIF_PREFS, ...(updated.notificationPrefs || {}) });
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
        .select('firstName lastName phoneNumber profileImage validation access isOnline lastSeen insertDate auth.lockedUntil')
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
// ?section=all|inventory|crm|mis   (default: all)
// ?page=1&limit=30
router.get('/:id/logs', verify, requirePermission('users:view'), async (req, res) => {
  try {
    const uid     = req.params.id;
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
