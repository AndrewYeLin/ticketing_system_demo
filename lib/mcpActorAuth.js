'use strict';

const crypto = require('crypto');

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') return null;
  const username = String(actor.username || '').trim();
  if (!username) return null;
  const role = String(actor.role || 'requester').trim().toLowerCase() === 'admin' ? 'admin' : 'requester';
  return {
    username,
    role,
    person_id: String(actor.person_id || '').trim(),
    display_name: String(actor.display_name || username).trim() || username,
  };
}

function signatureFor(token, payload) {
  return crypto.createHmac('sha256', String(token || '')).update(String(payload || '')).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function createActorHeaders(token, actor) {
  const normalized = normalizeActor(actor);
  if (!normalized || !String(token || '')) return {};
  const payload = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
  return {
    'X-Demo-Actor': payload,
    'X-Demo-Actor-Signature': signatureFor(token, payload),
  };
}

function headerValue(headers, name) {
  if (!headers) return '';
  const wanted = String(name || '').toLowerCase();
  const key = Object.keys(headers).find((candidate) => String(candidate).toLowerCase() === wanted);
  const direct = key ? headers[key] : undefined;
  if (Array.isArray(direct)) return String(direct[0] || '');
  return String(direct || '');
}
function verifyActorHeaders(headers, token) {
  const payload = headerValue(headers, 'x-demo-actor');
  const supplied = headerValue(headers, 'x-demo-actor-signature');
  if (!payload || !supplied || !String(token || '')) return null;
  const expected = signatureFor(token, payload);
  if (!safeEqual(supplied, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return normalizeActor(parsed);
  } catch (_) {
    return null;
  }
}

module.exports = {
  normalizeActor,
  createActorHeaders,
  verifyActorHeaders,
  safeEqual,
};
