const https = require('https');
const crashLogger = require('./crashLogger');

// Telegram Bot API client — plain https.request (same style already used for
// the sms.ir integration in authApi/routes/users/auth.js), no new npm package.
// Fully independent of the SMS/OTP auth system: a separate, opt-in delivery
// channel that mirrors the app's existing in-app notification events (see
// sendNotificationToUser in routes/socket/xmsNotifications.js).

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

function telegramRequest(method, body) {
  return new Promise((resolve, reject) => {
    if (!API_BASE) return reject(new Error('TELEGRAM_BOT_TOKEN is not configured'));
    const payload = JSON.stringify(body || {});
    const req = https.request(
      `${API_BASE}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve(parsed.result);
            else reject(new Error(parsed.description || `Telegram API error (${method})`));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Best-effort send — never throws into the caller (mirrors sendWebPush's
// error-swallowing convention in xmsNotifications.js). Returns true/false.
async function sendTelegramMessage(chatId, text) {
  if (!chatId || !text) return false;
  try {
    await telegramRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
    return true;
  } catch (err) {
    crashLogger.logError(err, { type: 'telegramSendFailed', chatId });
    return false;
  }
}

// ── Long-polling — no public webhook URL needed, works in any environment.
// A 30s server-side timeout per call keeps this to ~1 open request at a time
// instead of hammering the API; every failure is caught so a bad response or
// network blip never kills the loop (same BUG-02 lesson as the rest of the
// app: one bad async call must not take the whole process down).
let polling = false;
let pollOffset = 0;

async function pollOnce(onMessage) {
  const updates = await telegramRequest('getUpdates', { offset: pollOffset, timeout: 30 });
  for (const update of updates) {
    pollOffset = update.update_id + 1;
    if (update.message) {
      try {
        await onMessage(update.message);
      } catch (err) {
        crashLogger.logError(err, { type: 'telegramMessageHandlerFailed' });
      }
    }
  }
}

async function startPolling(onMessage) {
  if (!API_BASE) {
    console.log('Telegram bot: TELEGRAM_BOT_TOKEN not set — polling not started.');
    return;
  }
  if (polling) return;
  polling = true;
  console.log('Telegram bot: long-polling started.');

  while (polling) {
    try {
      await pollOnce(onMessage);
    } catch (err) {
      crashLogger.logError(err, { type: 'telegramPollFailed' });
      await new Promise((r) => setTimeout(r, 3000));   // back off before retrying
    }
  }
}

function stopPolling() { polling = false; }

module.exports = { sendTelegramMessage, startPolling, stopPolling };
