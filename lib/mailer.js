'use strict';

// Outbound mail. One `send` function, three transports, chosen by MAIL_TRANSPORT:
//
//   log     (default) write the message to stdout and stop. What development and CI get,
//           so nothing has to be configured — and so `npm test` can never post real mail.
//   smtp    hand it to nodemailer. Production.
//   memory  keep it in an array. Test double: it is the only way a test can assert what
//           the app would have sent without standing up an SMTP server.
//
// Read per call, not cached at module load: tests switch transports between cases, and a
// captured value would quietly serve the first one forever.

const SMTP_DEFAULT_PORT = 587;

function transportKind() {
  return String(process.env.MAIL_TRANSPORT || 'log').trim().toLowerCase();
}

function fromAddress() {
  return String(process.env.MAIL_FROM || 'finance-request-tracker@localhost').trim();
}

// Only populated by the `memory` transport.
const sentMessages = [];

let smtpTransport = null;
function smtp() {
  if (smtpTransport) return smtpTransport;
  const host = String(process.env.SMTP_HOST || '').trim();
  if (!host) throw new Error('MAIL_TRANSPORT=smtp requires SMTP_HOST');
  // Required only on this path, so a deployment that never sends mail — and every test
  // run — does not need the package present at all.
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT || SMTP_DEFAULT_PORT);
  const user = String(process.env.SMTP_USER || '').trim();
  smtpTransport = nodemailer.createTransport({
    host,
    port,
    // Implicit TLS is port 465; 587 upgrades with STARTTLS. Overridable because some
    // relays answer TLS on a port of their own choosing.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    // An open internal relay takes no credentials; passing empty ones makes it fail.
    auth: user ? { user, pass: process.env.SMTP_PASS || '' } : undefined,
  });
  return smtpTransport;
}

// Never throws. Callers are workflow actions that have already been committed — a request
// really did change status — and a mail server being down cannot be allowed to turn that
// into a failed API call or an unwound update.
async function send(message) {
  const envelope = { from: fromAddress(), to: message.to, subject: message.subject, text: message.text };
  try {
    switch (transportKind()) {
      case 'memory':
        sentMessages.push(envelope);
        return { delivered: true, transport: 'memory' };
      case 'smtp':
        await smtp().sendMail(envelope);
        return { delivered: true, transport: 'smtp' };
      default:
        console.log(`[mail:log] to=${envelope.to} subject=${envelope.subject}\n${envelope.text}`);
        return { delivered: false, transport: 'log' };
    }
  } catch (err) {
    console.error(`Could not send mail to ${envelope.to}: ${err.message}`);
    return { delivered: false, transport: transportKind(), error: err.message };
  }
}

// Tests only.
function clearSentMessages() { sentMessages.length = 0; }

module.exports = { send, sentMessages, clearSentMessages, transportKind };
