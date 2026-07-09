const express = require('express');
const verify  = require('../users/verifyToken');
const { requireSuperAdmin, clearPermissionCache, Role } = require('../../utils/rbac');

const router = express.Router();

// Roles management is superAdmin-ONLY — a separate axis from permissions.
// Holding users:role:edit does nothing here anymore; only role.isSuperAdmin does.

// GET /roles
router.get('/', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const roles = await Role.find({ deleteDate: null }).sort('name').lean();
    return res.status(200).json(roles);
  } catch (err) {
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

// POST /roles
router.post('/', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const role = await Role.create({
      name:        req.body.name,
      description: req.body.description || '',
      permissions: req.body.permissions || [],
      dataScopes:  req.body.dataScopes  || {},
      isSuperAdmin: !!req.body.isSuperAdmin,
      isSystem:    false,
    });
    return res.status(201).json(role);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'نقش با این نام وجود دارد' });
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

// PUT /roles/:id
router.put('/:id', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const role = await Role.findOne({ _id: req.params.id, deleteDate: null });
    if (!role) return res.status(404).json({ message: 'نقش یافت نشد' });
    if (role.isSystem && req.body.name && req.body.name !== role.name) {
      return res.status(400).json({ message: 'نام نقش سیستمی قابل تغییر نیست' });
    }
    const update = { description: req.body.description, permissions: req.body.permissions, dataScopes: req.body.dataScopes || {}, updateDate: new Date() };
    if (req.body.isSuperAdmin !== undefined) update.isSuperAdmin = !!req.body.isSuperAdmin;
    const updated = await Role.findOneAndUpdate(
      { _id: req.params.id },
      { $set: update },
      { new: true }
    );
    clearPermissionCache();  // role change affects all holders — clear all
    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

// DELETE /roles/:id
router.delete('/:id', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const role = await Role.findOne({ _id: req.params.id });
    if (!role) return res.status(404).json({ message: 'نقش یافت نشد' });
    if (role.isSystem) return res.status(400).json({ message: 'نقش سیستمی قابل حذف نیست' });
    await Role.findOneAndUpdate({ _id: req.params.id }, { $set: { deleteDate: new Date() } });
    clearPermissionCache();
    return res.status(200).json({ message: 'نقش حذف شد' });
  } catch (err) {
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

module.exports = router;
