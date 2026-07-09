const express = require('express');
const verify  = require('../users/verifyToken');
const { requireSuperAdmin, isSuperAdmin, getUserBranches, Branch } = require('../../utils/rbac');

const router = express.Router();

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
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

// POST /branches — create (superAdmin only)
router.post('/', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const branch = await Branch.create({
      name: req.body.name,
      description: req.body.description || '',
      createdBy: req.user.id,
    });
    return res.status(201).json(branch);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'شعبه‌ای با این نام وجود دارد' });
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

// PUT /branches/:id — edit (superAdmin only)
router.put('/:id', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const branch = await Branch.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: { name: req.body.name, description: req.body.description, status: req.body.status, updateDate: new Date() } },
      { new: true }
    );
    if (!branch) return res.status(404).json({ message: 'شعبه یافت نشد' });
    return res.status(200).json(branch);
  } catch (err) {
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

// DELETE /branches/:id — soft delete (superAdmin only)
router.delete('/:id', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const branch = await Branch.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: { deleteDate: new Date() } },
    );
    if (!branch) return res.status(404).json({ message: 'شعبه یافت نشد' });
    return res.status(200).json({ message: 'شعبه حذف شد' });
  } catch (err) {
    return res.status(500).json({ message: 'خطای سرور' });
  }
});

module.exports = router;
