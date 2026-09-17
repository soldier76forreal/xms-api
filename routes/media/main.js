const path = require('path');
const fs = require('fs');
const express = require('express');

const dbConnection = require('../../connections/xmsPr');
const fileSchema = require('../../models/fileModel');

const File = dbConnection.models.file || dbConnection.model('file', fileSchema);

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');

// ── Playable-video resolver ───────────────────────────────────────────────────
// Every video-rendering component in the app builds its URL the same way:
// `${apiBase}/uploads/<diskName>`. That serves the ORIGINAL upload, which is
// exactly the problem — an .mkv/.avi/.wmv/.flv (or an HEVC .mp4, or an h264
// .mov in Firefox) is a file the browser simply refuses to decode, so the
// player showed a black box with controls and nothing else.
//
// utils/mediaConvert.js already writes a universally-playable H.264/AAC MP4
// copy next to the original (`videoPreview` on the File doc) for exactly those
// uploads. The missing piece was reaching it: most surfaces embed a snapshot
// of the file (`diskName`/`mimetype`/`thumbnail`) taken at upload time, which
// is BEFORE the transcode finishes, so the field can never be in the snapshot.
//
// Rather than denormalizing `videoPreview` into every embedded shape (DM raw
// content, DM chat, ready-to-upload, CRM activity media, tutorials…) and then
// having to back-fill each one when a transcode lands, this resolves it at
// request time off the one field every shape DOES carry — the disk name. One
// stable URL per video, correct the moment the transcode finishes, no schema
// change anywhere.
//
// Access level matches the /uploads static mount it fronts (unauthenticated):
// it only ever redirects to a file that mount already serves, so it grants
// nothing new. basename() strips any path so `..%2f` can't escape the folder.
router.get('/video/:diskName', async (req, res) => {
  const safe = path.basename(String(req.params.diskName || ''));
  if (!safe) return res.status(404).json({ message: 'File not found' });

  // A transcode that is still running (or has yet to start) must fall through
  // to the original rather than 404 — the original is what the app served
  // before this route existed, so the worst case is exactly today's behavior.
  // no-store matters: the redirect target CHANGES when a transcode completes,
  // and a cached 302 would pin the player to the unplayable original forever.
  res.setHeader('Cache-Control', 'no-store');

  let target = safe;
  try {
    const doc = await File.findOne({ 'metaData.filename': safe })
      .select('videoPreview transcodeStatus')
      .lean();
    if (doc?.videoPreview && fs.existsSync(path.join(UPLOADS_DIR, doc.videoPreview))) {
      target = doc.videoPreview;
    }
  } catch (_) {
    /* non-fatal — fall back to the original, same as no web copy existing */
  }

  return res.redirect(302, `/uploads/${encodeURIComponent(target)}`);
});

// Lets a player tell "this video is still being prepared" apart from "this
// video is the original and that's all there will ever be" — the embedded
// file snapshots have no transcodeStatus of their own (see above), so this is
// how a DM/CRM surface gets at it. Deliberately tiny and cheap; players call
// it only for the file they are actually about to show.
router.get('/video-status/:diskName', async (req, res) => {
  const safe = path.basename(String(req.params.diskName || ''));
  if (!safe) return res.status(404).json({ message: 'File not found' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const doc = await File.findOne({ 'metaData.filename': safe })
      .select('videoPreview transcodeStatus')
      .lean();
    if (!doc) return res.json({ transcodeStatus: 'none', hasWebCopy: false });
    return res.json({
      transcodeStatus: doc.transcodeStatus || 'none',
      hasWebCopy: Boolean(doc.videoPreview),
    });
  } catch (_) {
    return res.json({ transcodeStatus: 'none', hasWebCopy: false });
  }
});

module.exports = router;
