const express = require('express');
const verify  = require('../users/verifyToken');
const { requireSuperAdmin, clearPermissionCache, Group } = require('../../utils/rbac');

const router = express.Router();

// GET /groups
router.get('/', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const groups = await Group.find({ deleteDate: null }).sort('name').lean();
    return res.status(200).json(groups);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /groups
router.post('/', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const group = await Group.create({
      name:        req.body.name,
      description: req.body.description || '',
      members:     req.body.members     || [],
      admins:      req.body.admins      || [],
      permissions: req.body.permissions || [],
      dataScopes:  req.body.dataScopes  || {},
    });
    return res.status(201).json(group);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'A group with this name already exists' });
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /groups/:id
router.put('/:id', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const updated = await Group.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      {
        $set: {
          name:        req.body.name,
          description: req.body.description,
          members:     req.body.members,
          admins:      req.body.admins      !== undefined ? req.body.admins      : [],
          permissions: req.body.permissions !== undefined ? req.body.permissions : [],
          dataScopes:  req.body.dataScopes  !== undefined ? req.body.dataScopes  : {},
          updateDate:  new Date(),
        },
      },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'Group not found' });
    clearPermissionCache();  // membership/permission change — clear all
    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /groups/:id
router.delete('/:id', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const updated = await Group.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: { deleteDate: new Date() } }
    );
    if (!updated) return res.status(404).json({ message: 'Group not found' });
    clearPermissionCache();
    return res.status(200).json({ message: 'Group deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
