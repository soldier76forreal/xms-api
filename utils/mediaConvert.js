const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const convertHeic = require('heic-convert');
const crashLogger = require('./crashLogger');

ffmpeg.setFfmpegPath(ffmpegPath);

const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

// Neither `sharp` nor `ffmpeg-static` can decode a real iPhone HEIC/HEIF file in
// this environment (sharp's HEIF decoder here only understands AVIF;
// ffmpeg-static has no HEIF demuxer at all — confirmed by directly probing
// both). heic-convert (WASM libheif, no native build step) fills that gap.
function isHeic(file) {
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.originalname || '').toLowerCase();
  return mime === 'image/heic' || mime === 'image/heif' || /\.(heic|heif)$/.test(name);
}

// Converts a HEIC/HEIF upload to a JPEG "web preview" copy saved ALONGSIDE the
// original — the original is never modified or discarded, it stays the
// "download original" target. Returns the new filename, or null on any
// failure (non-fatal, same try/catch-and-continue convention as the sharp
// thumbnail blocks already in routes/inventory/main.js).
async function convertHeicIfNeeded(file) {
  if (!isHeic(file)) return null;
  try {
    const inputBuffer = fs.readFileSync(file.path);
    const outputBuffer = await convertHeic({ buffer: inputBuffer, format: 'JPEG', quality: 0.9 });
    const webPreviewFilename = `webpreview-${file.filename}.jpg`;
    fs.writeFileSync(path.join(UPLOADS_DIR, webPreviewFilename), outputBuffer);
    return webPreviewFilename;
  } catch (err) {
    crashLogger.logError(err, { type: 'heicConvertFailed', file: file.filename });
    return null;
  }
}

// Every container the app realistically receives. Used as a FALLBACK signal to
// the mimetype: phones, cameras and some browsers hand up
// `application/octet-stream` for the less common containers — which is exactly
// the set that needs converting, so classifying on mimetype alone would skip
// the files this whole pipeline exists for.
const VIDEO_EXT_RE = /\.(mp4|webm|ogv|mov|mkv|avi|m4v|wmv|flv|3gp|3g2|mpg|mpeg|ts|m2ts|mts|f4v|asf|divx|vob)$/i;

// `file` is a multer file object (or anything carrying originalname/mimetype).
function isVideoUpload(file = {}) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime.startsWith('video/')) return true;
  return VIDEO_EXT_RE.test(String(file.originalname || file.name || ''));
}

// Takes one screenshot attempt at a given timestamp; resolves true only if a
// file actually landed on disk — fluent-ffmpeg's 'end' event fires whenever
// the ffmpeg process exits cleanly, even if the requested timestamp was past
// the last frame and nothing was actually written (confirmed directly: a
// screenshot requested at 00:00:01 from a clip <=1s long "succeeds" with no
// file produced), so the JS-level event alone isn't a reliable success signal.
function attemptScreenshot(videoPath, thumbFilename, timestamp) {
  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .on('end', () => resolve(fs.existsSync(path.join(UPLOADS_DIR, thumbFilename))))
      .on('error', () => resolve(false))
      .screenshots({ count: 1, timestamps: [timestamp], filename: thumbFilename, folder: UPLOADS_DIR, size: '300x?' });
  });
}

// Extracts a single preview frame from a video for its thumbnail. Uses a
// FIXED absolute timestamp (NOT a percentage) so fluent-ffmpeg never needs to
// probe the file's duration first — this app doesn't have ffprobe installed
// (BUG-07 in CLAUDE.md), and a percentage timestamp is the only case that
// actually needs one. This is the real BUG-07 fix, at zero new-dependency cost.
// Tries 1 second in first (avoids a pure-black opening frame on most clips);
// if the clip is too short for that to land a real frame, falls back to
// 00:00:00 (the first frame), which exists for any video with >=1 frame.
async function extractVideoThumbnail(videoPath, thumbFilename) {
  if (await attemptScreenshot(videoPath, thumbFilename, '00:00:01')) return thumbFilename;
  if (await attemptScreenshot(videoPath, thumbFilename, '00:00:00')) return thumbFilename;
  return null;   // non-fatal — falls back to the play-icon placeholder
}

// Reads the video/audio codec names WITHOUT ffprobe (not installed — BUG-07):
// running plain ffmpeg with -i and no output is a well-known trick — it exits
// with an error (no output was requested) but prints the input's stream info
// to stderr first, e.g. "Stream #0:0: Video: h264 (Main)... Stream #0:1:
// Audio: aac...". That's enough to answer "does this already play everywhere"
// without needing the separate ffprobe binary at all.
function probeVideoCodecs(videoPath) {
  return new Promise((resolve) => {
    let stderr = '';
    try {
      const child = spawn(ffmpegPath, ['-i', videoPath]);
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', () => {
        const videoMatch = stderr.match(/Stream #\d+:\d+[^\n]*Video:\s*([a-zA-Z0-9_]+)/);
        const audioMatch = stderr.match(/Stream #\d+:\d+[^\n]*Audio:\s*([a-zA-Z0-9_]+)/);
        resolve({
          videoCodec: videoMatch ? videoMatch[1].toLowerCase() : null,
          audioCodec: audioMatch ? audioMatch[1].toLowerCase() : null,
        });
      });
      child.on('error', () => resolve({ videoCodec: null, audioCodec: null }));
    } catch (_) {
      resolve({ videoCodec: null, audioCodec: null });
    }
  });
}

// Whether a file can be played by a browser <video> as-is. BOTH the container
// and the codecs have to be right — checking only the codec (as this used to)
// silently broke playback for the most common "won't play" case in this app:
// an .mkv/.avi/.wmv/.flv holding a perfectly ordinary h264+aac stream. The
// codec check passed, so no web copy was ever produced, and the browser then
// refused the container. The reverse was also wrong: a normal VP9/Opus .webm
// plays everywhere but was being re-encoded for nothing.
//
// .mov is deliberately NOT treated as safe: Chrome/Safari will play an h264
// .mov but Firefox won't, and the brief here is "works in any player".
const WEB_SAFE_VIDEO_CODECS = { mp4: ['h264', 'avc1'], m4v: ['h264', 'avc1'], webm: ['vp8', 'vp9', 'av1'] };
const WEB_SAFE_AUDIO_CODECS = { mp4: ['aac', 'mp3'], m4v: ['aac', 'mp3'], webm: ['opus', 'vorbis'] };

function containerOf(fileNameOrPath = '') {
  const m = String(fileNameOrPath).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function isAlreadyWebCompatible({ videoCodec, audioCodec }, fileNameOrPath = '') {
  const ext = containerOf(fileNameOrPath);
  const okVideo = WEB_SAFE_VIDEO_CODECS[ext];
  if (!okVideo) return false;                       // container itself isn't web-playable
  if (!videoCodec) return false;                    // couldn't probe — transcode to be safe
  if (!okVideo.includes(videoCodec)) return false;
  const okAudio = WEB_SAFE_AUDIO_CODECS[ext];
  return !audioCodec || okAudio.includes(audioCodec);
}

// Transcodes an uploaded video to a universally-playable H.264/AAC MP4 "web
// preview" copy — but ONLY if it isn't already one (see probeVideoCodecs
// above). Fire-and-forget (same non-blocking IIFE pattern already used by
// broadcastToDmViewers in routes/digitalMarketing/main.js) — never awaited by
// the calling route, so uploads stay fast regardless of file size. Storage
// isn't unlimited: skipping the transcode when it's not needed means no
// duplicate file gets written and no CPU gets spent on it.
function transcodeVideoAsync(FileModel, fileDoc, videoPath) {
  (async () => {
    try {
      const codecs = await probeVideoCodecs(videoPath);
      // Judge the ORIGINAL upload name, not the stored disk name: multer
      // writes extensionless random filenames, so the container can only be
      // read off the original.
      const nameForContainer = fileDoc.metaData?.originalname || fileDoc.name || videoPath;
      if (isAlreadyWebCompatible(codecs, nameForContainer)) {
        await FileModel.findByIdAndUpdate(fileDoc._id, { $set: { transcodeStatus: 'none' } });
        return;
      }

      // Mark in-flight so players can show "preparing…" instead of failing
      // silently while a large file converts.
      await FileModel.findByIdAndUpdate(fileDoc._id, { $set: { transcodeStatus: 'pending' } });

      const outputFilename = `webvideo-${fileDoc.metaData.filename}.mp4`;
      const outputPath = path.join(UPLOADS_DIR, outputFilename);
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions(['-preset veryfast', '-movflags +faststart'])
          .on('end', resolve)
          .on('error', reject)
          .save(outputPath);
      });
      await FileModel.findByIdAndUpdate(fileDoc._id, { $set: { videoPreview: outputFilename, transcodeStatus: 'ready' } });
    } catch (err) {
      crashLogger.logError(err, { type: 'videoTranscodeFailed', fileId: String(fileDoc._id) });
      await FileModel.findByIdAndUpdate(fileDoc._id, { $set: { transcodeStatus: 'failed' } }).catch(() => {});
    }
  })();
}

module.exports = { isHeic, isVideoUpload, convertHeicIfNeeded, extractVideoThumbnail, transcodeVideoAsync, probeVideoCodecs, isAlreadyWebCompatible };
