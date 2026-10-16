const fs = require("fs");
const path = require("path");

// ── Crash log ────────────────────────────────────────────────────────────────
// One JSON object per line in logs/crashes.log, each with an ISO `time`, so a
// question like "what broke in the last three hours" is a filter rather than a
// guess. PM2's own logs are not timestamped unless it was started with --time,
// which is why this file exists.
//
// Two things kept it from being usable, both fixed here:
//
//   1. EVERYTHING was written at full volume. A refused CORS origin and a
//      Telegram poll losing a race are expected operational outcomes, not
//      crashes, but each one wrote a ten-line stack. On one real log that was
//      116,154 copies of a single Telegram conflict and 92,707 empty
//      AggregateErrors — a genuine fault would be invisible in there.
//      Repeats now collapse: the first is written in full, the rest are
//      counted and reported as ONE rollup line per window.
//
//   2. It grew forever — 108 MB and climbing on a development machine alone.
//      It now rotates at a size cap and keeps a fixed number of old files, so
//      the disk cost is bounded no matter how long the process runs.
//
// Tunable, none of it required:
//   CRASH_LOG_MAX_MB          size at which the file rotates   (default 10)
//   CRASH_LOG_KEEP            how many rotated files to keep   (default 3)
//   CRASH_LOG_DEDUPE_SECONDS  rollup window for repeats        (default 60)

const logsDir = path.join(__dirname, "..", "logs");
const crashLogPath = path.join(logsDir, "crashes.log");

const MAX_BYTES = (Number(process.env.CRASH_LOG_MAX_MB) || 10) * 1024 * 1024;
const KEEP_FILES = Number(process.env.CRASH_LOG_KEEP) || 3;
const DEDUPE_MS = (Number(process.env.CRASH_LOG_DEDUPE_SECONDS) || 60) * 1000;

function ensureLogsDir() {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

// ── Rotation ─────────────────────────────────────────────────────────────────
// The size is tracked in memory and only re-read from disk after a rotation,
// so the common path costs no syscall beyond the append itself.
let bytesOnDisk = null;

function currentSize() {
  if (bytesOnDisk === null) {
    try {
      bytesOnDisk = fs.statSync(crashLogPath).size;
    } catch (error) {
      bytesOnDisk = 0;
    }
  }
  return bytesOnDisk;
}

function rotate() {
  try {
    // crashes.2.log -> crashes.3.log, ... , crashes.log -> crashes.1.log.
    // The oldest falls off the end and is removed.
    const oldest = path.join(logsDir, `crashes.${KEEP_FILES}.log`);
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

    for (let i = KEEP_FILES - 1; i >= 1; i -= 1) {
      const from = path.join(logsDir, `crashes.${i}.log`);
      const to = path.join(logsDir, `crashes.${i + 1}.log`);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }

    if (fs.existsSync(crashLogPath)) {
      fs.renameSync(crashLogPath, path.join(logsDir, "crashes.1.log"));
    }
  } catch (error) {
    // A rotation that fails must never take the process with it — the whole
    // point of this module is to be the thing that still works when something
    // else has gone wrong.
  }
  bytesOnDisk = 0;
}

function append(entry) {
  ensureLogsDir();
  const line = `${JSON.stringify(entry)}\n`;

  if (currentSize() + line.length > MAX_BYTES) rotate();

  try {
    fs.appendFileSync(crashLogPath, line, "utf8");
    bytesOnDisk = currentSize() + line.length;
  } catch (error) {
    bytesOnDisk = null;   // re-stat next time rather than trusting a stale count
  }
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    name: typeof error,
    message: safeStringify(error)
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function sanitizeBody(body) {
  if (!body || typeof body !== "object") {
    return body;
  }

  const hiddenKeys = ["password", "token", "authorization", "secret", "accessKey"];
  const sanitized = Array.isArray(body) ? [] : {};

  Object.keys(body).forEach((key) => {
    if (hiddenKeys.includes(key.toLowerCase())) {
      sanitized[key] = "[hidden]";
      return;
    }

    sanitized[key] = body[key];
  });

  return sanitized;
}

function getRequestContext(req) {
  if (!req) {
    return null;
  }

  return {
    method: req.method,
    originalUrl: req.originalUrl || req.url,
    ip: req.ip,
    // The ORIGIN is the one fact a CORS refusal turns on, and it was the one
    // fact this never recorded — the log said a request was refused without
    // ever saying by whom, which made a flood of them undiagnosable from the
    // log alone.
    origin: (req.headers && req.headers.origin) || null,
    referer: (req.headers && req.headers.referer) || null,
    params: req.params,
    query: req.query,
    body: sanitizeBody(req.body)
  };
}

// ── Deduplication ────────────────────────────────────────────────────────────
// Two errors are "the same" when they come from the same place and say the
// same thing. Numbers are stripped out of the message first, so
// "connect ECONNREFUSED 10.10.34.36:443" and the same against another port or
// host collapse into one signature instead of filling the log with near-twins.
function signatureOf(entry) {
  const kind = (entry.context && entry.context.type) || "unknown";
  const name = entry.error.name || "Error";
  const message = String(entry.error.message || "")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")       // ids, hashes
    .replace(/\d+/g, "#")                      // ports, counts, sizes
    .slice(0, 160);
  const where = (entry.context && entry.context.request && entry.context.request.originalUrl) || "";
  return `${kind}|${name}|${message}|${where.split("?")[0]}`;
}

const seen = new Map();   // signature -> { count, firstSeen, lastSeen, sample }

function flushRollups() {
  const now = Date.now();
  for (const [sig, state] of seen) {
    if (state.count > 0) {
      // One line standing in for everything suppressed since the last flush —
      // no stack, because the first occurrence already carried it.
      append({
        crashId: `${now}-rollup`,
        time: new Date(now).toISOString(),
        pid: process.pid,
        repeatOf: sig,
        repeated: state.count,
        firstSeen: new Date(state.firstSeen).toISOString(),
        lastSeen: new Date(state.lastSeen).toISOString(),
        sample: state.sample
      });
      state.count = 0;
    } else if (now - state.lastSeen > DEDUPE_MS * 10) {
      seen.delete(sig);   // stopped happening — forget it so a later one is "new" again
    }
  }
}

// unref so a quiet process is never held open by the logger alone.
const flushTimer = setInterval(flushRollups, DEDUPE_MS);
if (typeof flushTimer.unref === "function") flushTimer.unref();

// Anything suppressed at the moment the process goes down is still worth
// having — otherwise the final minute before a crash is the one minute missing.
process.on("exit", () => { try { flushRollups(); } catch (error) { /* nothing left to do */ } });

/**
 * Record an error.
 *
 * context.expected — mark an outcome the app ALREADY handles and reports
 * properly to the caller (a refused CORS origin, a lost Telegram poll race).
 * Those are worth counting, never worth a stack trace: the stack would only
 * ever point at the middleware that correctly rejected it.
 */
function logError(error, context = {}) {
  const crashId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const entry = {
    crashId,
    time: new Date().toISOString(),
    pid: process.pid,
    context,
    error: serializeError(error)
  };

  if (context.expected) delete entry.error.stack;

  const sig = signatureOf(entry);
  const state = seen.get(sig);
  const now = Date.now();

  if (state && now - state.firstWritten < DEDUPE_MS) {
    // Already reported inside this window — count it and say nothing.
    state.count += 1;
    state.lastSeen = now;
    return crashId;
  }

  seen.set(sig, {
    count: 0,
    firstSeen: state ? state.firstSeen : now,
    lastSeen: now,
    firstWritten: now,
    sample: {
      message: entry.error.message,
      origin: (context.request && context.request.origin) || undefined,
      url: (context.request && context.request.originalUrl) || undefined
    }
  });

  append(entry);
  return crashId;
}

module.exports = {
  crashLogPath,
  getRequestContext,
  logError,
  // exported for the tests and for anything that wants to force a flush
  flushRollups
};
