// Shared multer hardening — size caps + a block on browser-executable file
// types. Deliberately ONE shared module rather than the per-module duplication
// this codebase usually prefers: an upload policy that drifts between modules
// is the same as not having one, and every route below feeds the SAME
// public/uploads directory that server.js serves statically.
//
// Why a blocklist and not an allowlist: File Manager is a general-purpose
// file store and Digital Marketing / Tutorials explicitly classify uploads as
// 'other', so an allowlist would break real, legitimate use (.docx, .zip,
// .dwg, ...). What actually matters here is narrower — public/uploads is
// served by express.static from the API's own origin, so the only genuinely
// dangerous uploads are the ones a BROWSER will execute in that origin when
// the file URL is opened. Those are blocked; everything else is allowed and
// additionally neutered at serve time (see the uploads hardening in
// server.js: nosniff + a locked-down CSP + forced download).
//
// SVG is blocked rather than allowed-and-forced-to-download: an <svg> can
// carry <script>, and allowing it would mean every consumer that renders an
// uploaded image inline has to remember to special-case it. PNG/JPG/WebP
// cover the legitimate logo/image cases.

const BLOCKED_EXTENSIONS = [
  '.html', '.htm', '.xhtml', '.shtml', '.shtm',
  '.svg', '.svgz',
  '.js', '.mjs', '.cjs',
  '.xml', '.xsl', '.xslt',
  '.swf', '.htc', '.hta',
];

// Mimetypes a browser will render as an active document regardless of the
// filename — checked as well as the extension, since the extension is fully
// attacker-controlled and so is the declared mimetype (neither alone is
// trustworthy, so both are screened).
const BLOCKED_MIMETYPES = [
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/xml',
  'text/xml',
  'application/xslt+xml',
  'application/x-shockwave-flash',
];

// Raw marketing video is the driving case, so the per-file cap is deliberately
// large. multer's diskStorage STREAMS straight to disk, so a big file costs
// disk space and time, not RAM — the cap exists to bound runaway/abusive
// uploads, not because the process can't handle the size.
//
// Override with MAX_UPLOAD_MB in .env if the server's disk needs a tighter
// bound. Avatars keep their own much smaller image-only cap.
//
// ⚠️ A cap here is only ever the SECOND limit an upload hits. In production the
// reverse proxy in front of this API enforces its own body-size limit first
// (nginx `client_max_body_size`, default 1MB) and will reject the request with
// 413 before Node sees a byte. That must be raised to match, or this setting
// does nothing in production.
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 5120) * 1024 * 1024;   // default 5GB
const MAX_IMAGE_BYTES  = 10 * 1024 * 1024;

// Per-request file count for the batch endpoints. Uploading a whole shoot in
// one session is the point, so this is high; multer still enforces the
// per-file size cap on each one individually.
const MAX_BATCH_FILES = Number(process.env.MAX_BATCH_FILES) || 200;

function extensionOf(filename = '') {
  const i = String(filename).lastIndexOf('.');
  return i < 0 ? '' : String(filename).slice(i).toLowerCase();
}

// multer fileFilter — rejects browser-executable uploads. Rejecting with an
// Error (rather than cb(null, false)) means the route fails loudly instead of
// silently dropping the file and reporting success.
function blockExecutableFiles(req, file, cb) {
  const ext  = extensionOf(file.originalname);
  const mime = String(file.mimetype || '').toLowerCase();

  if (BLOCKED_EXTENSIONS.includes(ext) || BLOCKED_MIMETYPES.includes(mime)) {
    const err = new Error(`File type not allowed: ${ext || mime || 'unknown'}`);
    err.status = 400;
    err.code   = 'BLOCKED_FILE_TYPE';
    return cb(err);
  }
  return cb(null, true);
}

// Images only — for avatars/profile pictures, where nothing else is ever valid.
function imagesOnly(req, file, cb) {
  if (!String(file.mimetype || '').startsWith('image/')) {
    const err = new Error('Only image files are allowed');
    err.status = 400;
    err.code   = 'BLOCKED_FILE_TYPE';
    return cb(err);
  }
  return blockExecutableFiles(req, file, cb);   // still screens SVG
}

const uploadLimits      = { fileSize: MAX_UPLOAD_BYTES };
const imageUploadLimits = { fileSize: MAX_IMAGE_BYTES };

module.exports = {
  BLOCKED_EXTENSIONS,
  BLOCKED_MIMETYPES,
  MAX_UPLOAD_BYTES,
  MAX_IMAGE_BYTES,
  MAX_BATCH_FILES,
  blockExecutableFiles,
  imagesOnly,
  uploadLimits,
  imageUploadLimits,
};
