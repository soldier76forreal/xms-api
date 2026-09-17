const express = require('express');
const dbConnection = require('../../connections/xmsPr');
const tagSchema = require('../../models/inventoryTagModel');
const verify = require('../users/verifyToken');
const { requirePermission } = require('../../utils/rbac');

const Tag = dbConnection.models.inventoryTag || dbConnection.model('inventoryTag', tagSchema);
const router = express.Router();

// Byte-for-byte the same shape as categories.js — see inventoryTagModel.js
// for why tags are a separate collection from categories.

router.get('/', verify, requirePermission('inventory:view'), async (req, res) => {
  try {
    const tags = await Tag.find({ deleteDate: null }).sort({ name: 1 }).lean();
    res.json({ data: tags });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', verify, requirePermission('inventory:website:manage'), async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Name is required' });
    const existing = await Tag.findOne({ name: name.trim(), deleteDate: null });
    if (existing) return res.status(409).json({ message: `Tag "${name}" already exists` });
    const tag = await Tag.create({ name: name.trim(), description: description?.trim() || '' });
    res.status(201).json({ data: tag });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', verify, requirePermission('inventory:website:manage'), async (req, res) => {
  try {
    const { name, description } = req.body;
    const updates = {};
    if (name?.trim()) updates.name = name.trim();
    if (description !== undefined) updates.description = description.trim();
    const tag = await Tag.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: updates },
      { new: true }
    );
    if (!tag) return res.status(404).json({ message: 'Tag not found' });
    res.json({ data: tag });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', verify, requirePermission('inventory:website:manage'), async (req, res) => {
  try {
    const tag = await Tag.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: { deleteDate: new Date() } },
      { new: true }
    );
    if (!tag) return res.status(404).json({ message: 'Tag not found' });
    res.json({ message: 'Tag deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
