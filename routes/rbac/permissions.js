const express = require('express');
const verify  = require('../users/verifyToken');
const { requireSuperAdmin, Permission } = require('../../utils/rbac');

const router = express.Router();

// GET /permissions — full catalog (for permission matrix UI, itself superAdmin-only now)
router.get('/', verify, requireSuperAdmin(), async (req, res) => {
  try {
    const perms = await Permission.find().sort('module key').lean();
    // Group by module for the matrix UI
    const byModule = {};
    perms.forEach(p => {
      if (!byModule[p.module]) byModule[p.module] = [];
      byModule[p.module].push(p);
    });
    return res.status(200).json({ flat: perms, byModule });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
