const express = require('express');
const dbConnection = require('../../connections/xmsPr');
const categorySchema = require('../../models/categoryModel');
const verify = require('../users/verifyToken');

const Category = dbConnection.model('inventoryCategory', categorySchema);
const router = express.Router();

// GET all active categories
router.get('/', verify, async (req, res) => {
  try {
    const cats = await Category.find({ deleteDate: null }).sort({ name: 1 }).lean();
    res.json({ data: cats });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST create category
router.post('/', verify, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Name is required' });
    const existing = await Category.findOne({ name: name.trim(), deleteDate: null });
    if (existing) return res.status(409).json({ message: `Category "${name}" already exists` });
    const cat = await Category.create({ name: name.trim(), description: description?.trim() || '' });
    res.status(201).json({ data: cat });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT update category
router.put('/:id', verify, async (req, res) => {
  try {
    const { name, description } = req.body;
    const updates = {};
    if (name?.trim()) updates.name = name.trim();
    if (description !== undefined) updates.description = description.trim();
    const cat = await Category.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: updates },
      { new: true }
    );
    if (!cat) return res.status(404).json({ message: 'Category not found' });
    res.json({ data: cat });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE soft-delete category
router.delete('/:id', verify, async (req, res) => {
  try {
    const cat = await Category.findOneAndUpdate(
      { _id: req.params.id, deleteDate: null },
      { $set: { deleteDate: new Date() } },
      { new: true }
    );
    if (!cat) return res.status(404).json({ message: 'Category not found' });
    res.json({ message: 'Category deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
