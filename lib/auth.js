'use strict';

// Local-account auth primitives (no dependencies — Node's crypto only).
// - Passwords: scrypt with a per-user random salt, stored as "salt:hash" hex. Hashing is
//   async on purpose: scryptSync blocks the single-threaded server for ~100ms per call,
//   which is both a throughput ceiling and a free denial-of-service.
// - Sessions: a stateless signed cookie (HMAC-SHA256 over a JSON payload). No session
//   table; the signature + expiry are the trust. SESSION_SECRET must be set.

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const COOKIE_NAME = 'frt_session';
const MIN_SECRET_LENGTH = 16;
const MIN_PASSWORD_LENGTH = 8;

// Admin-issued temporary password. Generated, never chosen: an administrator asked for a
// password to read out loud, and left to themselves people pick one they will reuse for
// every reset. Returned exactly once, in the response to the reset call — it is never
// logged and never stored in the clear.
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function generateTemporaryPassword(length = 12) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  // Rejection-free modulo is fine here: the alphabet (56) does not divide 256 evenly, but
  // the resulting bias is a fraction of a bit per character on a 12-character secret that
  // exists to be changed. Uniformity would matter for a long-lived key.
  for (const byte of bytes) out += TEMP_PASSWORD_ALPHABET[byte % TEMP_PASSWORD_ALPHABET.length];
  return out;
}

// Read per call rather than once at module load, because this module is also required by
// db/createUser.js, which needs the password helpers and has no session to sign.
//
// There is deliberately no fallback value. A hardcoded default is not a convenience, it
// is a published signing key: anyone who can read this file could mint an admin cookie
// for any deployment that forgot to set the real one, and nothing would look wrong.
function sessionSecret() {
  const value = process.env.SESSION_SECRET || '';
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters. `
      + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return value;
}

// Call at startup so a misconfigured deployment dies on the launch pad rather than
// silently serving forgeable sessions.
function assertSessionSecret() { sessionSecret(); }

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, 32);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

// Even-length hex only. Buffer.from(x, 'hex') truncates at the first character it
// cannot decode instead of failing, so a corrupted row ("zz:zz", an odd-length hash)
// would decode to a zero-length buffer — and timingSafeEqual of two empty buffers is
// true, i.e. that account would accept every password. Reject the shape up front.
const HEX = /^(?:[0-9a-fA-F]{2})+$/;

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!HEX.test(saltHex || '') || !HEX.test(hashHex || '')) return false;
  const hash = Buffer.from(hashHex, 'hex');
  let test;
  try { test = await scrypt(String(password), Buffer.from(saltHex, 'hex'), hash.length); }
  catch (e) { return false; }
  return hash.length === test.length && crypto.timingSafeEqual(hash, test);
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifySession(token) {
  if (!token) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i < 1) return;
    const name = p.slice(0, i).trim();
    if (name) out[name] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

module.exports = {
  hashPassword, verifyPassword, signSession, verifySession, parseCookies,
  assertSessionSecret, generateTemporaryPassword,
  SESSION_TTL_MS, COOKIE_NAME, MIN_PASSWORD_LENGTH,
};
