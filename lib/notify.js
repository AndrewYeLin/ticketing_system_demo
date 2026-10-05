'use strict';

// Email notifications. Today there is exactly one: a request changed status.
//
// Two rules shape everything here.
//
// 1. Mail is a new output channel for data the app already redacts per role, and it
//    arrives somewhere the app cannot police. So the body carries only what identifies
//    the request and what moved: no amounts, no supplier bank details, no internal notes.
//    The last one matters most — internal notes are hidden from requesters in both the
//    history API and the UI, and mailing them would be a way around that.
// 2. Delivery never affects the workflow. Notifications are fired after the change is
//    committed, are not awaited, and swallow their own failures (see lib/mailer.js).

const mailer = require('./mailer');

function userFacingLabel(value) {
  return String(value == null ? '' : value)
    .replace(/\bRequester\b/g, 'User')
    .replace(/\bRequestor\b/g, 'User')
    .replace(/\brequester\b/g, 'user')
    .replace(/\brequestor\b/g, 'user');
}

function statusLabel(value) {
  return userFacingLabel(value).replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

// The recipient is the requester attached to the request's People record. Keeping the
// lookup outside this module means the notification layer never needs a second storage
// implementation or a privileged read of the users table.
function recipientsFor({ requesterEmail } = {}) {
  const address = String(requesterEmail || '').trim();
  return address ? [address] : [];
}

function requestLink(requestId) {
  const base = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}/?request=${encodeURIComponent(requestId)}` : '';
}

// Pure: the message a status change produces. Separated from sending so the redaction
// rules above are directly testable.
function buildStatusChangeMessage({ row, oldStatus, newStatus, changedBy, note }) {
  const type = `${row.request_type}${row.sub_type ? ` · ${row.sub_type}` : ''}`;
  const subject = `[${row.request_id}] ${statusLabel(oldStatus || 'New')} → ${statusLabel(newStatus)}`;
  const lines = [
    `Request:    ${row.request_id}`,
    `Type:       ${type}`,
    `User:       ${row.requester_name || '—'}`,
    `Status:     ${statusLabel(oldStatus || '—')} → ${statusLabel(newStatus)}`,
    `Changed by: ${changedBy || 'unknown'}`,
  ];
  const message = String(note == null ? '' : note).trim();
  if (message) lines.push('', 'Note:', message);
  const link = requestLink(row.request_id);
  if (link) lines.push('', `Open the request: ${link}`);
  lines.push('', 'You are receiving this because you are the user for this Finance Request.');
  return { subject, text: lines.join('\n') };
}

// Fire-and-forget. Returns the pending sends so tests (and only tests) can await them.
function requestStatusChanged(event) {
  const recipients = recipientsFor(event);
  if (!recipients.length) return Promise.resolve([]);
  const { subject, text } = buildStatusChangeMessage(event);
  return Promise.all(recipients.map((to) => mailer.send({ to, subject, text })));
}

module.exports = { requestStatusChanged, buildStatusChangeMessage, recipientsFor };
