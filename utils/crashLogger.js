const fs = require("fs");
const path = require("path");

const logsDir = path.join(__dirname, "..", "logs");
const crashLogPath = path.join(logsDir, "crashes.log");

function ensureLogsDir() {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
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
    params: req.params,
    query: req.query,
    body: sanitizeBody(req.body)
  };
}

function logError(error, context = {}) {
  ensureLogsDir();

  const crashId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const entry = {
    crashId,
    time: new Date().toISOString(),
    pid: process.pid,
    context,
    error: serializeError(error)
  };

  fs.appendFileSync(crashLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  return crashId;
}

module.exports = {
  crashLogPath,
  getRequestContext,
  logError
};
