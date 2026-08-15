const express        = require('express');
const taskModel      = require('../../models/taskModel');
const userModel      = require('../../models/userModel');
const groupModel     = require('../../models/groupModel');
const verify         = require('../users/verifyToken');
const { requirePermission, getEffectivePermissions, getEffectiveScopes } = require('../../utils/rbac');
const { sendNotificationToUser } = require('../socket/xmsNotifications');
const dbConnection   = require('../../connections/xmsPr');

const Task  = dbConnection.models.task  || dbConnection.model('task',  taskModel);
const userM = dbConnection.models.user  || dbConnection.model('user',  userModel);
const Group = dbConnection.models.group || dbConnection.model('group', groupModel);

const router = express.Router();

// GET /tasks
// Supports standard scope (mine|group|all) for generic tasks, AND
// module-specific scopes: ?module=crm&scope=personal|assigned (My Desk)
router.get('/', verify, requirePermission('tasks:view'), async (req, res) => {
  const uid    = String(req.user.id);
  const { status, module: moduleFilter } = req.query;

  // ── forUser mode: view tasks assigned to a specific user (for user detail panel) ──
  if (req.query.forUser) {
    const targetId = String(req.query.forUser);
    if (targetId !== uid) {
      const perms = await getEffectivePermissions(uid);
      if (!perms.has('crm:task:assign') && !perms.has('users:view')) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }
    const q = { deleteDate: null, assigneeType: 'user', assignedUser: targetId };
    if (moduleFilter) q.module = moduleFilter;
    if (status)       q.status = status;
    const tasks = await Task.find(q).sort({ insertDate: -1 }).lean();
    return res.json({ data: await populateTasks(tasks) });
  }

  // ── My Desk mode: module + personal/assigned scope ─────────────────────────
  if (moduleFilter && (req.query.scope === 'personal' || req.query.scope === 'assigned')) {
    const userGroups = await Group.find({ members: uid, deleteDate: null }).select('_id').lean();
    const groupIds   = userGroups.map(g => String(g._id));

    const query = { deleteDate: null, module: moduleFilter };
    if (status) query.status = status;

    if (req.query.scope === 'personal') {
      // Tasks the user created and assigned to themselves (their own working set)
      query.assigneeType = 'user';
      query.assignedUser = uid;
      query.createdBy    = uid;
    } else {
      // Tasks assigned to the user (or their groups) by someone else
      query.$or = [
        { assigneeType: 'user',  assignedUser:  uid,                         createdBy: { $ne: uid } },
        { assigneeType: 'group', assignedGroup: { $in: groupIds } },
      ];
    }

    const tasks = await Task.find(query).sort({ insertDate: -1 }).lean();
    const populated = await populateTasks(tasks);
    return res.json({ data: populated });
  }

  // ── Standard scope (mine|group|all) ────────────────────────────────────────
  const SCOPE_RANK = { mine: 1, group: 2, all: 3 };
  const effScopes  = await getEffectiveScopes(uid);
  const maxScope   = effScopes.tasks || 'all';
  const requested  = req.query.scope || 'all';
  const scope = (SCOPE_RANK[requested] || 3) <= (SCOPE_RANK[maxScope] || 3)
    ? requested : maxScope;

  const userGroups = await Group.find({ members: uid, deleteDate: null }).select('_id admins').lean();
  const groupIds   = userGroups.map(g => String(g._id));
  const isGroupAdmin = userGroups.some(g => (g.admins || []).map(String).includes(uid));

  let orClauses;
  if (scope === 'mine') {
    orClauses = [{ assigneeType: 'user', assignedUser: uid }, { createdBy: uid }];
  } else if (scope === 'group') {
    if (isGroupAdmin) {
      const memberIds = [...new Set(userGroups.flatMap(g => (g.members || []).map(String)))];
      orClauses = [
        { assigneeType: 'group', assignedGroup: { $in: groupIds } },
        { createdBy: { $in: memberIds } },
      ];
    } else {
      orClauses = [{ assigneeType: 'group', assignedGroup: { $in: groupIds } }];
    }
  } else {
    orClauses = [
      { assigneeType: 'user',  assignedUser:  uid },
      { assigneeType: 'group', assignedGroup: { $in: groupIds } },
      { createdBy: uid },
    ];
  }

  const query = { deleteDate: null, $or: orClauses };
  if (status)       query.status = status;
  if (moduleFilter) query.module = moduleFilter;

  const tasks    = await Task.find(query).sort({ insertDate: -1 }).lean();
  const populated = await populateTasks(tasks);
  res.json({ data: populated });
});

async function populateTasks(tasks) {
  return Promise.all(tasks.map(async (t) => {
    let assignedUserName = null, assignedGroupName = null;
    if (t.assigneeType === 'user' && t.assignedUser) {
      const u = await userM.findById(t.assignedUser).select('firstName lastName').lean();
      if (u) assignedUserName = `${u.firstName} ${u.lastName}`.trim();
    } else if (t.assigneeType === 'group' && t.assignedGroup) {
      const g = await Group.findById(t.assignedGroup).select('name').lean();
      if (g) assignedGroupName = g.name;
    }
    return { ...t, assignedUserName, assignedGroupName };
  }));
}

// POST /tasks — create + assign
// When module='crm' and assignee !== self → requires crm:task:assign in addition to tasks:create
router.post('/', verify, requirePermission('tasks:create'), async (req, res) => {
  const { title, description = '', assigneeType, assignedUser, assignedGroup,
          module: taskModule = 'general', subjects = [] } = req.body;

  if (!title || !assigneeType) return res.status(400).json({ message: 'title and assigneeType are required' });
  if (assigneeType === 'user'  && !assignedUser)  return res.status(400).json({ message: 'assignedUser required' });
  if (assigneeType === 'group' && !assignedGroup) return res.status(400).json({ message: 'assignedGroup required' });

  // CRM assign-to-others requires crm:task:assign
  const isSelfAssign = assigneeType === 'user' && String(assignedUser) === String(req.user.id);
  if (taskModule === 'crm' && !isSelfAssign) {
    const perms = await getEffectivePermissions(req.user.id);
    if (!perms.has('crm:task:assign')) {
      return res.status(403).json({ message: 'Access denied', requiredPermission: 'crm:task:assign' });
    }
  }

  const me = await userM.findById(req.user.id).select('firstName lastName').lean();
  const createdByName = me ? `${me.firstName} ${me.lastName}`.trim() : '';

  const task = await Task.create({
    title, description, assigneeType, module: taskModule, subjects,
    assignedUser:  assigneeType === 'user'  ? assignedUser  : null,
    assignedGroup: assigneeType === 'group' ? assignedGroup : null,
    createdBy: req.user.id, createdByName,
  });

  // No notification for self-assignment (personal working set)
  if (!isSelfAssign) {
    if (assigneeType === 'user') {
      await sendNotificationToUser(assignedUser, {
        fromId: req.user.id, fromName: createdByName,
        type: 'task',
        textKey: 'taskAssignedUser', textParams: { title, description },
        entityType: 'task', entityId: task._id,
      });
    } else {
      const group = await Group.findById(assignedGroup).select('members name').lean();
      if (group?.members?.length) {
        await Promise.allSettled(
          group.members
            .filter(uid => String(uid) !== String(req.user.id))
            .map(memberId =>
              sendNotificationToUser(memberId, {
                fromId: req.user.id, fromName: createdByName,
                type: 'task',
                textKey: 'taskAssignedGroup', textParams: { title, description, groupName: group.name },
                entityType: 'task', entityId: task._id,
              })
            )
        );
      }
    }
  }

  res.status(201).json({ data: task });
});

// PUT /tasks/:id/claim — group member claims a task from the shared queue
router.put('/:id/claim', verify, requirePermission('tasks:respond'), async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, deleteDate: null });
  if (!task)               return res.status(404).json({ message: 'Task not found' });
  if (task.status !== 'open') return res.status(409).json({ message: 'Task is not open' });

  const me = await userM.findById(req.user.id).select('firstName lastName').lean();
  const claimedByName = me ? `${me.firstName} ${me.lastName}`.trim() : '';

  task.status      = 'claimed';
  task.claimedBy   = req.user.id;
  task.claimedByName = claimedByName;
  task.updateDate  = new Date();
  await task.save();

  if (String(task.createdBy) !== String(req.user.id)) {
    await sendNotificationToUser(task.createdBy, {
      fromId: req.user.id, fromName: claimedByName,
      type: 'taskClaimed',
      textKey: 'taskClaimed', textParams: { claimedByName, taskTitle: task.title },
      entityType: 'task', entityId: task._id,
    });
  }

  res.json({ data: task });
});

// PUT /tasks/:id/done — mark task as done
router.put('/:id/done', verify, requirePermission('tasks:respond'), async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, deleteDate: null });
  if (!task) return res.status(404).json({ message: 'Task not found' });

  task.status     = 'done';
  task.updateDate = new Date();
  await task.save();

  if (String(task.createdBy) !== String(req.user.id)) {
    const me = await userM.findById(req.user.id).select('firstName lastName').lean();
    const byName = me ? `${me.firstName} ${me.lastName}`.trim() : '';
    await sendNotificationToUser(task.createdBy, {
      fromId: req.user.id, fromName: byName,
      type: 'taskDone',
      textKey: 'taskDone', textParams: { byName, taskTitle: task.title },
      entityType: 'task', entityId: task._id,
    });
  }

  res.json({ data: task });
});

// DELETE /tasks/:id — soft-delete (creator only)
router.delete('/:id', verify, requirePermission('tasks:create'), async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, deleteDate: null });
  if (!task) return res.status(404).json({ message: 'Task not found' });
  if (String(task.createdBy) !== String(req.user.id)) {
    return res.status(403).json({ message: 'Only the creator can delete this task' });
  }
  task.deleteDate = new Date();
  await task.save();
  res.json({ success: true });
});

module.exports = router;
