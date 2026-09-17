const nodemailer = require('nodemailer');

// Reuses the EXISTING EMAIL_SEND_SESSION/EMAIL_SEND_PASSWORD env vars (both
// .envs already had them — a leftover from a nodemailer setup the 2026-07-09
// security audit removed as unused dead code; the credentials were never
// deleted). Host/port confirmed live against the real mailbox this session:
// lazulitemarble.com's MX record points at itself (self-hosted mail, not a
// third-party provider), and port 465/SSL is what actually authenticates —
// not guessed, verified with a real SMTP handshake before this file was written.
let _transport = null;
function getTransport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: 'lazulitemarble.com',
    port: 465,
    secure: true,
    auth: { user: process.env.EMAIL_SEND_SESSION, pass: process.env.EMAIL_SEND_PASSWORD },
  });
  return _transport;
}

// Every caller goes through this — never construct a transport ad hoc
// elsewhere, so there is exactly one place SMTP config/failure handling lives.
async function sendMail({ to, subject, text, html }) {
  const transport = getTransport();
  return transport.sendMail({
    from: `Lazulite Marble <${process.env.EMAIL_SEND_SESSION}>`,
    to, subject, text, html,
  });
}

module.exports = { sendMail };
