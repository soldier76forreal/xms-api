const express = require('express');
const verify  = require('../users/verifyToken');
const { requireSuperAdmin, clearPermissionCache, Role } = require('../../utils/rbac');
const { isKnownTemplate, DEFAULT_TEMPLATE } = require('../../utils/jobReportTemplates');

const router = express.Router();

// Roles management is superAdmin-ONLY — a separate axis from permissions.
// Holding users:role:edit does nothing here anymore; only role.isSuperAdmin does.

// GET /roles
router.get('/', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const roles = await Role.find({ deleteDate: null }).sort('name').lean();
    return res.status(200).json(roles);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
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
      // An unknown key would still fall back at render time, but refusing it
      // here keeps a typo out of the database in the first place.
      jobReportTemplate: isKnownTemplate(req.body.jobReportTemplate) ? req.body.jobReportTemplate : DEFAULT_TEMPLATE,
      isSystem:    false,
    });
    return res.status(201).json(role);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'A role with this name already exists' });
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /roles/:id
router.put('/:id', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const role = await Role.findOne({ _id: req.params.id, deleteDate: null });
    if (!role) return res.status(404).json({ message: 'Role not found' });
    if (role.isSystem && req.body.name && req.body.name !== role.name) {
      return res.status(400).json({ message: 'A system role cannot be renamed' });
    }
    const update = { description: req.body.description, permissions: req.body.permissions, dataScopes: req.body.dataScopes || {}, updateDate: new Date() };
    // Name is editable for non-system roles (system roles are blocked above).
    // It was previously omitted here, so renaming a role silently did nothing.
    if (!role.isSystem && req.body.name !== undefined) update.name = String(req.body.name).trim();
    if (req.body.isSuperAdmin !== undefined) update.isSuperAdmin = !!req.body.isSuperAdmin;
    // Only touched when the caller actually sends it, so a plain
    // name/permission edit can never silently move a role's form.
    if (req.body.jobReportTemplate !== undefined) {
      update.jobReportTemplate = isKnownTemplate(req.body.jobReportTemplate)
        ? req.body.jobReportTemplate : DEFAULT_TEMPLATE;
    }
    const updated = await Role.findOneAndUpdate(
      { _id: req.params.id },
      { $set: update },
      { new: true }
    );
    clearPermissionCache();  // role change affects all holders — clear all
    return res.status(200).json(updated);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'A role with this name already exists' });
    console.error('[PUT /roles/:id] Error:', err.message);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// DELETE /roles/:id
router.delete('/:id', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const role = await Role.findOne({ _id: req.params.id });
    if (!role) return res.status(404).json({ message: 'Role not found' });
    if (role.isSystem) return res.status(400).json({ message: 'A system role cannot be deleted' });
    await Role.findOneAndUpdate({ _id: req.params.id }, { $set: { deleteDate: new Date() } });
    clearPermissionCache();
    return res.status(200).json({ message: 'Role deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
