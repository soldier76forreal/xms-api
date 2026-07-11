const express  = require('express');
const mongoose = require('mongoose');
const multer   = require('multer');
const sharp    = require('sharp');
const ffmpeg   = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

const dbConnection           = require('../../connections/xmsPr');
const customerSchema         = require('../../models/customerModel');
const customerActivitySchema = require('../../models/customerActivityModel');
const userSchema             = require('../../models/userModel');
const inventoryProductSchema = require('../../models/inventoryProductModel');
const inventoryVariantSchema = require('../../models/inventoryVariantModel');
const taskSchema             = require('../../models/taskModel');
const fileSchema             = require('../../models/fileModel');

const verify = require('../users/verifyToken');
const { requirePermission, getEffectivePermissions, getEffectiveScopes, Group } = require('../../utils/rbac');
const { sendNotificationToUser } = require('../socket/xmsNotifications');

ffmpeg.setFfmpegPath(ffmpegPath);

const Customer         = dbConnection.models.customer         || dbConnection.model('customer',         customerSchema);
const CustomerActivity = dbConnection.models.customerActivity || dbConnection.model('customerActivity', customerActivitySchema);
const User             = dbConnection.models.user             || dbConnection.model('user',             userSchema);
const InvProduct       = dbConnection.models.inventoryProduct || dbConnection.model('inventoryProduct', inventoryProductSchema);
const InvVariant       = dbConnection.models.inventoryVariant || dbConnection.model('inventoryVariant', inventoryVariantSchema);
const Task             = dbConnection.models.task             || dbConnection.model('task',             taskSchema);
const File             = dbConnection.models.file             || dbConnection.model('file',             fileSchema);

const commUpload = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename:    (req, file, cb) => {
    const ext = file.originalname.match(/\..*$/)?.[0] || '';
    cb(null, `crm-comm-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
}) });

// Extracts a single preview frame from a video (10% in) for the timeline
// thumbnail — mirrors the Inventory variant-media-batch convention exactly.
function extractVideoThumbnail(videoPath, thumbFilename) {
  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .on('end', () => resolve(thumbFilename))
      .on('error', () => resolve(null))
      .screenshots({ count: 1, timestamps: ['10%'], filename: thumbFilename, folder: 'public/uploads', size: '300x?' });
  });
}

const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function buildScopeFilter(userId, crmScope) {
  if (!crmScope || crmScope === 'all') return null;

  if (crmScope === 'mine') {
    return { $or: [{ owner: userId }, { assignedTo: userId }] };
  }

  // group scope: every member of every group the user belongs to
  const userGroups = await Group.find({ members: userId, deleteDate: null }).lean();
  const memberIds  = [...new Set(userGroups.flatMap(g => (g.members || []).map(m => String(m))))];
  if (!memberIds.length) {
    return { $or: [{ owner: userId }, { assignedTo: userId }] };
  }
  return { $or: [{ owner: { $in: memberIds } }, { assignedTo: { $in: memberIds } }] };
}

async function writeActivity(customerId, type, fields, userId, userName) {
  try {
    await CustomerActivity.create({
      customerId,
      type,
      ...fields,
      actorId:   userId,
      actorName: userName,
      date:      new Date(),
      createdAt: new Date(),
    });
  } catch (_) {}
}

async function getActorName(userId) {
  const actor = await User.findById(userId).select('firstName lastName').lean();
  return actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '';
}

// ── GET /crm/products-lookup — inventory products for the multi-select ────────
// BEFORE /:id to avoid capture
router.get('/products-lookup', verify, requirePermission('crm:view'), async (req, res) => {
  try {
    const { search = '' } = req.query;
    const query = { deleteDate: null, status: 'active' };
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      query.$or = [{ name: re }, { code: re }];
    }
    const products = await InvProduct.find(query)
      .select('_id code name stoneType quarryCode totalsByUnit')
      .sort('name')
      .limit(50)
      .lean();

    // Include each product's active variants so the interested-products picker
    // can target a specific variety (grade/dims/finish SKU), not just the root
    // stone type — mirrors the pattern already used by /mis/products-lookup.
    const productIds = products.map((p) => p._id);
    const variants = await InvVariant.find({
      productId: { $in: productIds }, deleteDate: null, status: 'active',
    })
      .select('_id productId code unit quantity price')
      .lean();
    const byProduct = {};
    for (const v of variants) {
      (byProduct[String(v.productId)] = byProduct[String(v.productId)] || []).push(v);
    }
    const data = products.map((p) => ({ ...p, variants: byProduct[String(p._id)] || [] }));

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /crm/filter-memory — persist user's active CRM filter/sort state ──────
// BEFORE /:id to avoid capture
router.put('/filter-memory', verify, async (req, res) => {
  try {
    const { sort, order, filter } = req.body;
    const update = {};
    if (sort   !== undefined) update['filterMemory.crm.sort']   = sort;
    if (order  !== undefined) update['filterMemory.crm.order']  = order;
    if (filter !== undefined) update['filterMemory.crm.filter'] = filter;
    if (Object.keys(update).length) {
      await User.updateOne({ _id: req.user.id }, { $set: update });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /crm/customers/creators — distinct list of users who created a customer
// BEFORE /:id to avoid capture. Powers the "created by" filter (gated by
// crm:view, not users:view, so any CRM user can populate the picker).
router.get('/customers/creators', verify, requirePermission('crm:view'), async (req, res) => {
  try {
    const ids = await Customer.distinct('createdBy', { deleteDate: null, createdBy: { $ne: null } });
    const users = await User.find({ _id: { $in: ids } }).select('firstName lastName').lean();
    const data = users.map(u => ({ _id: u._id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Unknown' }));
    return res.status(200).json({ data });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /crm/customers — list (server-side filter / sort / scope / pagination) ─
router.get('/customers', verify, requirePermission('crm:view'), async (req, res) => {
  try {
    const userId   = req.user.id;
    const scopes   = await getEffectiveScopes(userId);
    const crmScope = scopes.crm; // 'mine' | 'group' | undefined → all

    const {
      search = '', type = '', country = '',
      channels = '', channelMode = 'any',
      status = '', tags = '',
      dateFrom = '', dateTo = '',
      sort = 'insertDate', order = 'desc',
      interestedIn = '',
      page = 1, limit = 30,
    } = req.query;

    const filters = [];

    // batch by IDs — used by My Desk to expand task subjects
    if (req.query.ids) {
      const idList = req.query.ids.split(',')
        .map(s => s.trim())
        .filter(s => mongoose.Types.ObjectId.isValid(s))
        .map(s => new mongoose.Types.ObjectId(s));
      if (idList.length) filters.push({ _id: { $in: idList } });
    }

    // full-text search across name / company / phone
    // NOTE: contactInfo.phoneNumbers.number is a legacy Number-typed field —
    // matching a RegExp against it always throws a Mongoose CastError (regexes
    // only apply to strings), which was silently turning into a 500 on every
    // text search. phoneNumber (the Phase 5 flat string natural key) already
    // covers phone search, so the legacy clause is simply dropped, not replaced.
    if (search.trim()) {
      const re = new RegExp(escapeRegex(search.trim()), 'i');
      filters.push({ $or: [
        { 'personalInformation.firstName':   re },
        { 'personalInformation.lastName':    re },
        { 'personalInformation.companyName': re },
        { phoneNumber:                       re },
      ]});
    }

    // customerType / personOrCompany (both old and new fields)
    if (type) {
      filters.push({ $or: [
        { 'personalInformation.personOrCompany': type },
        { 'personalInformation.customerType':    type },
      ]});
    }

    // country — across personalInformation and address sub-docs
    if (country) {
      const re = new RegExp(escapeRegex(country), 'i');
      filters.push({ $or: [
        { 'personalInformation.country': re },
        { 'address.country':             re },
      ]});
    }

    // communication channels — $in (any) or $all (all)
    if (channels) {
      const chArr = channels.split(',').map(c => c.trim()).filter(Boolean);
      if (chArr.length) {
        filters.push(channelMode === 'all'
          ? { commChannels: { $all: chArr } }
          : { commChannels: { $in: chArr } });
      }
    }

    // status
    if (status) filters.push({ status });

    // tags
    if (tags) {
      const tagArr = tags.split(',').map(t => t.trim()).filter(Boolean);
      if (tagArr.length) filters.push({ tags: { $in: tagArr } });
    }

    // date range → lastCallAt
    if (dateFrom || dateTo) {
      const df = {};
      if (dateFrom) df.$gte = new Date(dateFrom);
      if (dateTo)   df.$lte = new Date(dateTo);
      filters.push({ lastCallAt: df });
    }

    // reverse lookup — who wants this product
    if (interestedIn && mongoose.Types.ObjectId.isValid(interestedIn)) {
      filters.push({ 'interestedProducts.productId': new mongoose.Types.ObjectId(interestedIn) });
    }

    // "created by" filter — meaningless (and disabled client-side) when
    // crmScope === 'mine', since the scope filter below already pins results
    // to the current user's own/assigned records
    if (req.query.createdBy && mongoose.Types.ObjectId.isValid(req.query.createdBy) && crmScope !== 'mine') {
      filters.push({ createdBy: new mongoose.Types.ObjectId(req.query.createdBy) });
    }

    // row-level scope (server-side — never trust ?scope from the client)
    const scopeFilter = await buildScopeFilter(userId, crmScope);
    if (scopeFilter) filters.push(scopeFilter);

    const query = { deleteDate: null };
    if (filters.length) query.$and = filters;

    const validSort = { insertDate: 'insertDate', lastCallAt: 'lastCallAt' };
    const sortField = validSort[sort] || 'insertDate';
    const sortDir   = order === 'asc' ? 1 : -1;
    const lim       = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const skip      = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [data, total] = await Promise.all([
      Customer.find(query)
        .select('-communication -logs -frequentBtnClick')
        .sort({ [sortField]: sortDir, _id: -1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      Customer.countDocuments(query),
    ]);

    return res.status(200).json({ data, total, page: Number(page) || 1, limit: lim });
  } catch (err) {
    console.error('GET /crm/customers failed:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── POST /crm/customers — create ──────────────────────────────────────────────
router.post('/customers', verify, requirePermission('crm:customer:create'), async (req, res) => {
  try {
    const userId = req.user.id;

    // duplicate phone guard
    if (req.body.phoneNumber) {
      const dup = await Customer.findOne({ phoneNumber: req.body.phoneNumber, deleteDate: null });
      if (dup) {
        return res.status(409).json({ message: 'A customer with this phone number already exists', existingId: dup._id });
      }
    }

    const doc = await Customer.create({
      ...req.body,
      owner:      userId,
      createdBy:  userId,
      insertDate: new Date(),
    });

    const actorName = await getActorName(userId);
    await writeActivity(doc._id, 'created', {}, userId, actorName);

    return res.status(201).json(doc);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /crm/customers/:id — detail ──────────────────────────────────────────
router.get('/customers/:id', verify, requirePermission('crm:view'), async (req, res) => {
  try {
    const userId   = req.user.id;
    const scopes   = await getEffectiveScopes(userId);
    const crmScope = scopes.crm;

    const customer = await Customer.findOne({ _id: req.params.id, deleteDate: null }).lean();
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    // row-level check for 'mine' scope
    if (crmScope === 'mine') {
      const isOwner    = String(customer.owner) === String(userId);
      const isAssigned = (customer.assignedTo || []).map(String).includes(String(userId));
      if (!isOwner && !isAssigned) return res.status(403).json({ message: 'Access denied' });
    }

    return res.status(200).json(customer);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /crm/customers/bulk — bulk assign / add-tag ──────────────────────────
// MUST be defined before PUT /customers/:id to avoid 'bulk' being captured as :id
router.put('/customers/bulk', verify, requirePermission('crm:customer:edit'), async (req, res) => {
  try {
    const userId = req.user.id;
    const { ids = [], action, tag, assigneeType, assignedUser, assignedGroup, title } = req.body;

    if (!ids.length) return res.status(400).json({ message: 'ids array is required' });
    if (!action)     return res.status(400).json({ message: 'action is required' });

    const actorName = await getActorName(userId);

    if (action === 'addTag') {
      if (!tag) return res.status(400).json({ message: 'tag is required' });
      await Customer.updateMany(
        { _id: { $in: ids }, deleteDate: null },
        { $addToSet: { tags: tag }, $set: { updateDate: new Date(), updatedBy: userId } }
      );
      return res.status(200).json({ ok: true, updated: ids.length });
    }

    if (action === 'assign') {
      if (!assigneeType) return res.status(400).json({ message: 'assigneeType required' });
      if (assigneeType === 'user'  && !assignedUser)  return res.status(400).json({ message: 'assignedUser required' });
      if (assigneeType === 'group' && !assignedGroup) return res.status(400).json({ message: 'assignedGroup required' });

      // Assigning to someone else requires crm:task:assign
      const isSelf = assigneeType === 'user' && String(assignedUser) === String(userId);
      if (!isSelf) {
        const perms = await getEffectivePermissions(userId);
        if (!perms.has('crm:task:assign')) {
          return res.status(403).json({ message: 'Access denied', requiredPermission: 'crm:task:assign' });
        }
      }

      const subjects = ids.map(id => ({ subjectType: 'customer', subjectId: id }));
      const taskTitle = title || `CRM — ${ids.length} customer${ids.length !== 1 ? 's' : ''}`;

      const me = await User.findById(userId).select('firstName lastName').lean();
      const createdByName = me ? `${me.firstName} ${me.lastName}`.trim() : '';

      const task = await Task.create({
        title: taskTitle, assigneeType, module: 'crm', subjects,
        assignedUser:  assigneeType === 'user'  ? assignedUser  : null,
        assignedGroup: assigneeType === 'group' ? assignedGroup : null,
        createdBy: userId, createdByName,
      });

      // Update assignedTo on each customer
      await Customer.updateMany(
        { _id: { $in: ids }, deleteDate: null },
        { $addToSet: { assignedTo: assigneeType === 'user' ? assignedUser : [] },
          $set: { updateDate: new Date(), updatedBy: userId } }
      );

      // Write activity on each customer
      await Promise.allSettled(ids.map(id =>
        writeActivity(id, 'assigned', {
          newValue: assigneeType === 'user' ? assignedUser : assignedGroup,
        }, userId, actorName)
      ));

      // Notify assignee(s) — skip self
      if (!isSelf) {
        if (assigneeType === 'user') {
          await sendNotificationToUser(assignedUser, {
            fromId: userId, fromName: createdByName,
            type: 'task', title: `New CRM task: ${taskTitle}`,
            body: `${ids.length} customer${ids.length !== 1 ? 's' : ''} assigned to you`,
            entityType: 'task', entityId: task._id,
          });
        } else {
          const group = await Group.findById(assignedGroup).select('members name').lean();
          if (group?.members?.length) {
            await Promise.allSettled(
              group.members
                .filter(uid => String(uid) !== String(userId))
                .map(memberId =>
                  sendNotificationToUser(memberId, {
                    fromId: userId, fromName: createdByName,
                    type: 'task', title: `New group CRM task: ${taskTitle}`,
                    body: `${ids.length} customer${ids.length !== 1 ? 's' : ''} assigned [${group.name || ''}]`,
                    entityType: 'task', entityId: task._id,
                  })
                )
            );
          }
        }
      }

      return res.status(201).json({ ok: true, task });
    }

    if (action === 'delete') {
      const perms = await getEffectivePermissions(userId);
      if (!perms.has('crm:customer:delete')) {
        return res.status(403).json({ message: 'Access denied', requiredPermission: 'crm:customer:delete' });
      }
      const now = new Date();
      await Customer.updateMany(
        { _id: { $in: ids }, deleteDate: null },
        { $set: { deleteDate: now, updatedBy: userId, updateDate: now } }
      );
      await Promise.allSettled(ids.map(id =>
        writeActivity(id, 'updated', { field: 'status', newValue: 'deleted' }, userId, actorName)
      ));
      return res.status(200).json({ ok: true, deleted: ids.length });
    }

    return res.status(400).json({ message: 'Unknown action. Use addTag, assign, or delete.' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /crm/customers/:id — update ──────────────────────────────────────────
router.put('/customers/:id', verify, requirePermission('crm:customer:edit'), async (req, res) => {
  try {
    const userId   = req.user.id;
    const existing = await Customer.findOne({ _id: req.params.id, deleteDate: null });
    if (!existing) return res.status(404).json({ message: 'Customer not found' });

    const actorName = await getActorName(userId);

    // track meaningful changes for the activity log
    if (req.body.status && req.body.status !== existing.status) {
      await writeActivity(existing._id, 'status_changed', {
        field: 'status', oldValue: existing.status, newValue: req.body.status,
      }, userId, actorName);
    }

    if (req.body.assignedTo !== undefined) {
      const oldIds = (existing.assignedTo || []).map(String).sort().join(',');
      const newIds = (req.body.assignedTo  || []).map(String).sort().join(',');
      if (oldIds !== newIds) {
        await writeActivity(existing._id, 'assigned', {
          oldValue: existing.assignedTo, newValue: req.body.assignedTo,
        }, userId, actorName);
      }
    }

    if (req.body.interestedProducts !== undefined) {
      await writeActivity(existing._id, 'interest', {
        newValue: req.body.interestedProducts,
      }, userId, actorName);
    }

    const updated = await Customer.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { ...req.body, updatedBy: userId, updateDate: new Date() } },
      { new: true }
    );

    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── DELETE /crm/customers/:id — soft-delete ───────────────────────────────────
router.delete('/customers/:id', verify, requirePermission('crm:customer:delete'), async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, deleteDate: null });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    await Customer.findOneAndUpdate({ _id: req.params.id }, { $set: { deleteDate: new Date() } });
    return res.status(200).json({ message: 'Customer deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /crm/customers/:id/communication — activity log ───────────────────────
router.get('/customers/:id/communication', verify, requirePermission('crm:communication:view'), async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const lim  = Math.min(Number(limit) || 30, 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;

    const [activities, total] = await Promise.all([
      CustomerActivity.find({ customerId: req.params.id })
        .sort({ date: -1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      CustomerActivity.countDocuments({ customerId: req.params.id }),
    ]);

    return res.status(200).json({ data: activities, total, page: Number(page) || 1, limit: lim });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── POST /crm/customers/:id/communication — log call / note (+ voice/image/video) ──
// Sets lastCallAt on the customer + writes a customerActivity row. Accepts up
// to 5 attached files (multipart) — voice recordings, images, or video clips —
// stored via the shared File Manager (scope:'crm', attachedTo:'customerActivity').
router.post('/customers/:id/communication', verify, requirePermission('crm:communication:create'),
  commUpload.array('files', 5), async (req, res) => {
  try {
    const userId = req.user.id;
    const { type = 'call_logged', body = '', channel } = req.body;

    const validTypes = ['call_logged', 'note'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ message: `type must be one of: ${validTypes.join(', ')}` });
    }

    const customer = await Customer.findOne({ _id: req.params.id, deleteDate: null });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    const actorName = await getActorName(userId);
    const now       = new Date();

    // Always stamp lastCallAt when logging a call or note
    await Customer.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { lastCallAt: now, updateDate: now, updatedBy: userId } }
    );

    const activity = await CustomerActivity.create({
      customerId: req.params.id,
      type,
      body,
      ...(channel ? { field: 'channel', newValue: channel } : {}),
      actorId:   userId,
      actorName,
      date:      now,
      createdAt: now,
    });

    const files = req.files || [];
    if (files.length) {
      const media = [];
      for (const file of files) {
        const mime = file.mimetype || '';
        const kind = mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'image';

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
          scope: 'crm',
          attachedTo: { type: 'customerActivity', id: activity._id },
        });

        media.push({ fileId: fileDoc._id, kind, diskName: file.filename, name: file.originalname, thumbnail });
      }
      activity.media = media;
      await activity.save();
    }

    return res.status(201).json(activity);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── PUT /crm/customers/:id/follow-up — set nextFollowUpAt ─────────────────────
router.put('/customers/:id/follow-up', verify, requirePermission('crm:customer:edit'), async (req, res) => {
  try {
    const userId = req.user.id;
    const { nextFollowUpAt } = req.body;

    if (!nextFollowUpAt) return res.status(400).json({ message: 'nextFollowUpAt is required' });

    const customer = await Customer.findOne({ _id: req.params.id, deleteDate: null });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    const actorName = await getActorName(userId);
    const date      = new Date(nextFollowUpAt);

    await Customer.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { nextFollowUpAt: date, updateDate: new Date(), updatedBy: userId } }
    );

    await writeActivity(req.params.id, 'follow_up_set', {
      oldValue: customer.nextFollowUpAt,
      newValue: date,
    }, userId, actorName);

    return res.status(200).json({ ok: true, nextFollowUpAt: date });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /crm/customers/:id/requests — this customer's MIS invoices ────────────
// Phase 6 (Session 42): wired to the new misInvoice collection — the customer's
// invoices + pre-invoices, newest first (reverse lookup by customerId).
router.get('/customers/:id/requests', verify, requirePermission('crm:view'), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }
    const misInvoiceSchema = require('../../models/misInvoiceModel');
    const MisInvoice = dbConnection.models.misInvoice || dbConnection.model('misInvoice', misInvoiceSchema);

    const { docType = 'all', order = 'desc' } = req.query;
    const query = { customerId: req.params.id, deleteDate: null };
    if (docType === 'invoice' || docType === 'pre_invoice') query.docType = docType;
    const sortDir = order === 'asc' ? 1 : -1;

    const [rows, total] = await Promise.all([
      MisInvoice.find(query)
        .select('docType docNumber status issueDate grandTotal currency customerSnapshot.name lineItems.code')
        .sort({ issueDate: sortDir, _id: sortDir })
        .limit(100)
        .lean(),
      MisInvoice.countDocuments(query),
    ]);

    // Expose just the line codes (what was on this doc) — not the full lineItems payload.
    const data = rows.map((doc) => {
      const codes = (doc.lineItems || []).map((li) => li.code).filter(Boolean);
      const { lineItems, ...rest } = doc;
      return { ...rest, codes };
    });

    return res.status(200).json({ data, total });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
