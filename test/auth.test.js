'use strict';

// Session + password primitives. These are the whole of the trust model: there is no
// session table, so a forged or tampered cookie is the only way in, and `changed_by`
// in the audit log is only trustworthy because verifySession rejects them.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// There is no fallback signing key any more, so the secret has to exist before anything
// signs or verifies a session. Set it before requiring the module under test.
const SESSION_SECRET = 'test-secret-not-the-default';
process.env.SESSION_SECRET = SESSION_SECRET;
const auth = require('../lib/auth');

const SESSION = { username: 'alice', role: 'requester', person_id: 'PER-011', display_name: 'Alice' };
const valid = (over) => auth.signSession({ ...SESSION, exp: Date.now() + 60000, ...(over || {}) });

// --- passwords ---

test('a password verifies against its own hash and nothing else', async () => {
  const stored = await auth.hashPassword('correct horse battery staple');
  assert.ok(await auth.verifyPassword('correct horse battery staple', stored));
  assert.ok(!await auth.verifyPassword('Correct horse battery staple', stored));
  assert.ok(!await auth.verifyPassword('', stored));
});

test('hashing the same password twice produces different salts', async () => {
  const a = await auth.hashPassword('same-password');
  const b = await auth.hashPassword('same-password');
  assert.notStrictEqual(a, b, 'a shared salt would make the hashes rainbow-table-able');
  assert.ok(await auth.verifyPassword('same-password', a));
  assert.ok(await auth.verifyPassword('same-password', b));
});

test('a malformed stored hash never verifies and never throws', async () => {
  for (const stored of ['', null, undefined, 'nosalt', 'salt:', ':hash', 'zz:zz', 'a:b:c']) {
    assert.strictEqual(await auth.verifyPassword('anything', stored), false, `stored=${stored}`);
  }
});

// --- sessions ---

test('a freshly signed session round-trips its identity', () => {
  const payload = auth.verifySession(valid());
  assert.strictEqual(payload.username, 'alice');
  assert.strictEqual(payload.role, 'requester');
  assert.strictEqual(payload.person_id, 'PER-011');
});

test('a session whose payload was edited is rejected', () => {
  const [body, sig] = valid().split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  claims.role = 'admin';
  const forged = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + sig;
  assert.strictEqual(auth.verifySession(forged), null, 'privilege escalation by editing the cookie');
});

test('a session with a swapped signature is rejected', () => {
  const [body] = valid().split('.');
  const otherSig = crypto.createHmac('sha256', 'some-other-secret').update(body).digest('base64url');
  assert.strictEqual(auth.verifySession(body + '.' + otherSig), null);
});

test('an expired session is rejected', () => {
  assert.strictEqual(auth.verifySession(valid({ exp: Date.now() - 1 })), null);
});

test('a session without an expiry is rejected', () => {
  const body = Buffer.from(JSON.stringify(SESSION)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  assert.strictEqual(auth.verifySession(body + '.' + sig), null, 'a session with no exp would never expire');
});

test('structurally broken tokens are rejected without throwing', () => {
  for (const token of ['', null, undefined, 'nodot', '.', 'a.', '.b', 'a.b.c', '{}.{}', 'a'.repeat(5000)]) {
    assert.strictEqual(auth.verifySession(token), null, `token=${String(token).slice(0, 20)}`);
  }
});

test('a signature of a different length is rejected rather than crashing timingSafeEqual', () => {
  const [body] = valid().split('.');
  assert.strictEqual(auth.verifySession(body + '.short'), null);
});

// --- the signing key itself ---
//
// There used to be a hardcoded fallback secret here, and lib/env was only loaded as a
// side effect of the SQL backend — so the CSV backend signed every session with a value
// published in this repository. Anyone could mint an admin cookie for such a deployment.

test('signing and verifying refuse to work without a secret', () => {
  const saved = process.env.SESSION_SECRET;
  try {
    delete process.env.SESSION_SECRET;
    assert.throws(() => auth.signSession({ username: 'x', exp: Date.now() + 1000 }), /SESSION_SECRET/);
    assert.throws(() => auth.assertSessionSecret(), /SESSION_SECRET/);
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

test('a too-short secret is rejected, so a placeholder cannot pass for a key', () => {
  const saved = process.env.SESSION_SECRET;
  try {
    process.env.SESSION_SECRET = 'short';
    assert.throws(() => auth.assertSessionSecret(), /at least 16 characters/);
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

test('assertSessionSecret passes once a real secret is set', () => {
  assert.doesNotThrow(() => auth.assertSessionSecret());
});

// --- cookie parsing ---

test('cookies parse into a map and survive url-encoded values', () => {
  const jar = auth.parseCookies('a=1; b=hello%20world; frt_session=tok.en');
  assert.strictEqual(jar.a, '1');
  assert.strictEqual(jar.b, 'hello world');
  assert.strictEqual(jar[auth.COOKIE_NAME], 'tok.en');
});

test('a missing or junk cookie header yields an empty jar', () => {
  assert.deepStrictEqual(auth.parseCookies(undefined), {});
  assert.deepStrictEqual(auth.parseCookies(''), {});
  assert.deepStrictEqual(auth.parseCookies('novalue; =orphan'), {});
});
