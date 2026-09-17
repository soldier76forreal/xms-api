// Backfill for videos uploaded BEFORE the playback fix.
//
// Two separate historical gaps, both of which leave a video that simply does
// not play in the app:
//
//  1. Only Inventory ever called transcodeVideoAsync — a video uploaded through
//     Digital Marketing, Tutorials, CRM, the File Manager or a user note never
//     got a web-playable copy at all, whatever its format.
//  2. Inventory's own check was codec-only: `{videoCodec:'h264'}` counted as
//     web-compatible even inside an .mkv/.avi/.wmv/.flv, so those were marked
//     transcodeStatus:'none' and skipped. The container matters as much as the
//     codec (see utils/mediaConvert.js) and is now part of the test.
//
// Also regenerates missing video POSTER FRAMES: every route outside Inventory
// asked ffmpeg for a '10%' timestamp, which needs ffprobe to resolve, and this
// app has no ffprobe (BUG-07) — so those calls threw and the thumbnail was
// silently left null. The shared helper uses fixed timestamps instead.
//
// Re-running is safe: anything already carrying a videoPreview file on disk is
// skipped, and a file missing from disk is skipped rather than failed.
//
//   node scripts/backfillVideoTranscodes.js            # dry run — reports only
//   node scripts/backfillVideoTranscodes.js --yes      # actually converts
//   node scripts/backfillVideoTranscodes.js --yes --limit 20
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const dbConnection = require('../connections/xmsPr');
const fileSchema = require('../models/fileModel');
const {
  extractVideoThumbnail, probeVideoCodecs, isAlreadyWebCompatible,
} = require('../utils/mediaConvert');

const File = dbConnection.models.file || dbConnection.model('file', fileSchema);

const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

const APPLY = process.argv.includes('--yes');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? Number(process.argv[limitArg + 1]) || 0 : 0;

// Matches utils/mediaConvert.js's own view of "this is a video" — mimetype is
// the reliable signal, extension is the fallback for the octet-stream uploads
// (which are disproportionately the odd containers this script exists for).
const VIDEO_EXT = /\.(mp4|webm|ogv|mov|mkv|avi|m4v|wmv|flv|3gp|3g2|mpg|mpeg|ts|m2ts|mts|f4v|asf|divx|vob)$/i;

function isVideoDoc(doc) {
  const mime = String(doc.metaData?.mimetype || '').toLowerCase();
  if (mime.startsWith('video/')) return true;
  const original = doc.metaData?.originalname || doc.name || '';
  if (VIDEO_EXT.test(original)) return true;
  return VIDEO_EXT.test(`.${String(doc.format || '').toLowerCase()}`);
}

// Deliberately a SEQUENTIAL, awaited transcode — unlike the fire-and-forget
// path used on upload. This can run over hundreds of files and spawning them
// all at once would bury the server; one at a time is slower and safe to leave
// running.
function transcodeOne(inputPath, outputPath) {
  const ffmpeg = require('fluent-ffmpeg');
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-preset veryfast', '-movflags +faststart'])
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

(async () => {
  try {
    await dbConnection.asPromise();
    console.log('Connected to', dbConnection.name);
    console.log(APPLY ? 'MODE: apply' : 'MODE: dry run (pass --yes to apply)');

    const docs = await File.find({ deleteDate: null }).select('name format metaData thumbnail videoPreview transcodeStatus scope').lean();
    const videos = docs.filter(isVideoDoc);
    console.log(`file docs: ${docs.length} · videos: ${videos.length}`);

    const stats = {
      missingOnDisk: 0, alreadyHasCopy: 0, alreadyPlayable: 0,
      needsTranscode: 0, transcoded: 0, transcodeFailed: 0,
      thumbsMissing: 0, thumbsMade: 0,
    };
    let processed = 0;

    for (const doc of videos) {
      if (LIMIT && processed >= LIMIT) break;

      const diskName = doc.metaData?.filename;
      const inputPath = diskName ? path.join(UPLOADS_DIR, diskName) : null;
      if (!inputPath || !fs.existsSync(inputPath)) { stats.missingOnDisk += 1; continue; }

      // ── poster frame ──────────────────────────────────────────────────────
      const thumbOnDisk = doc.thumbnail && fs.existsSync(path.join(UPLOADS_DIR, doc.thumbnail));
      if (!thumbOnDisk) {
        stats.thumbsMissing += 1;
        if (APPLY) {
          const thumb = await extractVideoThumbnail(inputPath, `thumb-${diskName}.png`);
          if (thumb) {
            await File.updateOne({ _id: doc._id }, { $set: { thumbnail: thumb } });
            stats.thumbsMade += 1;
          }
        }
      }

      // ── web-playable copy ─────────────────────────────────────────────────
      if (doc.videoPreview && fs.existsSync(path.join(UPLOADS_DIR, doc.videoPreview))) {
        stats.alreadyHasCopy += 1;
        if (APPLY && doc.transcodeStatus !== 'ready') {
          await File.updateOne({ _id: doc._id }, { $set: { transcodeStatus: 'ready' } });
        }
        processed += 1;
        continue;
      }

      const codecs = await probeVideoCodecs(inputPath);
      const nameForContainer = doc.metaData?.originalname || doc.name || diskName;
      if (isAlreadyWebCompatible(codecs, nameForContainer)) {
        stats.alreadyPlayable += 1;
        processed += 1;
        continue;
      }

      stats.needsTranscode += 1;
      console.log(`  ${APPLY ? 'converting' : 'would convert'}: ${nameForContainer} `
        + `[${codecs.videoCodec || '?'}/${codecs.audioCodec || '-'}] (scope: ${doc.scope || '-'})`);

      if (APPLY) {
        const outputFilename = `webvideo-${diskName}.mp4`;
        try {
          await File.updateOne({ _id: doc._id }, { $set: { transcodeStatus: 'pending' } });
          await transcodeOne(inputPath, path.join(UPLOADS_DIR, outputFilename));
          await File.updateOne({ _id: doc._id }, { $set: { videoPreview: outputFilename, transcodeStatus: 'ready' } });
          stats.transcoded += 1;
        } catch (err) {
          await File.updateOne({ _id: doc._id }, { $set: { transcodeStatus: 'failed' } });
          stats.transcodeFailed += 1;
          console.log(`    FAILED: ${err.message}`);
        }
      }
      processed += 1;
    }

    console.log('\n── summary ─────────────────────────────');
    console.log(stats);
    if (!APPLY) console.log('\nNothing was written. Re-run with --yes to apply.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
