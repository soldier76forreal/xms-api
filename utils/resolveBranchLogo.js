// Session 72 (Phase 3) — companyProfile.logoFileId has existed on the schema
// since before this project but nothing has ever resolved it; the invoice
// template always fell back to the single static LMC logo PNG. This is the
// first real wiring of it, scoped to the new packing-list/label templates
// (the invoice template is untouched — out of scope, avoids regressing
// already-shipped/tested PDFs). Defensive on every failure path: a missing
// file, unreadable path, or DB error all just resolve null, and the caller
// falls back to the static logo exactly like before.
const fs = require('fs');
const path = require('path');
const dbConnection = require('../connections/xmsPr');
const fileSchema = require('../models/fileModel');

const File = dbConnection.models.file || dbConnection.model('file', fileSchema);

async function resolveBranchLogoDataUri(logoFileId) {
  if (!logoFileId) return null;
  try {
    const fileDoc = await File.findOne({ _id: logoFileId, deleteDate: null }).lean();
    if (!fileDoc) return null;
    const diskName = fileDoc.metaData && (fileDoc.metaData.filename || fileDoc.metaData.diskName);
    if (!diskName) return null;
    const filePath = path.join(__dirname, '..', 'public', 'uploads', diskName);
    if (!fs.existsSync(filePath)) return null;
    const ext = (diskName.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch (_) {
    return null;
  }
}

module.exports = { resolveBranchLogoDataUri };
