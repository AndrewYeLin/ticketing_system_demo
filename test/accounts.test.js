'use strict';

// Self-registration, passwords and roles at the domain layer.
//
// Registration is the first path in this app that lets an anonymous caller write rows, so
// most of what is asserted here is what it refuses to do: overwrite an existing account,
// accept an outside address, hand out an admin role, or revive a person somebody
// deliberately deactivated. The HTTP surface (throttling, cookies, 403s) is covered in
// api.test.js — this file is about the rules themselves.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frt-accounts-'));
process.env.DATA_DIR = TMP;
delete process.env.STORAGE; // CSV backend for tests
process.env.REGISTRATION_ALLOWED_DOMAINS = 'polyu.edu.hk';

const store = require('../lib/store');
const auth = require('../lib/auth');

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const PASSWORD = 'a-long-enough-password';
let seq = 0;
const address = (name) => `${name}.${++seq}@polyu.edu.hk`;

async function person(id) {
  return (await store.readPeople()).find((candidate) => candidate.person_id === id);
}

// An administrator account, created the way db/createUser.js creates one.
async function admin(name) {
  const created = await store.createPerson({ display_name: name, email: address(name) });
  await store.createUser({
    username: name, password_hash: await auth.hashPassword(PASSWORD), role: 'admin',
    person_id: created.person_id, display_name: created.display_name, active: 'Yes',
  });
  return { username: name, person_id: created.person_id };
}

test('registering creates a linked person and an account that can sign in', async () => {
  const email = address('new.starter');
  const account = await store.registerUser({ display_name: 'New Starter', email: email.toUpperCase(), password: PASSWORD });

  assert.strictEqual(account.username, email.toLowerCase(), 'the address is the username, lowercased');
  assert.strictEqual(account.role, 'requester');
  assert.ok(account.person_id, 'an account with no person cannot see its own requests');

  const linked = await person(account.person_id);
  assert.strictEqual(linked.email, email.toUpperCase().trim());
  // Requester and traveller only. Everything else is granted by an administrator.
  assert.deepStrictEqual(
    { can_request: linked.can_request, can_travel: linked.can_travel, can_approve: linked.can_approve, can_process: linked.can_process },
    { can_request: 'Yes', can_travel: 'Yes', can_approve: 'No', can_process: 'No' }
  );

  const stored = await store.getUserByUsername(account.username);
  assert.strictEqual(stored.active, 'Yes', 'accounts are usable immediately');
  assert.ok(await auth.verifyPassword(PASSWORD, stored.password_hash));
});

test('the role is never taken from the caller', async () => {
  const account = await store.registerUser({
    display_name: 'Would Be Admin', email: address('would.be.admin'), password: PASSWORD, role: 'admin',
  });
  assert.strictEqual(account.role, 'requester');
});

test('an address outside the allowed domains is refused', async () => {
  for (const email of ['someone@gmail.com', 'someone@notpolyu.edu.hk', 'someone@polyu.edu.hk.attacker.com']) {
    await assert.rejects(
      store.registerUser({ display_name: 'Outsider', email, password: PASSWORD }),
      (err) => err.status === 400 && /polyu\.edu\.hk/.test(err.fields.email),
      `${email} was accepted`
    );
  }
});

test('a short password is refused', async () => {
  await assert.rejects(
    store.registerUser({ display_name: 'Short', email: address('short'), password: 'seven77' }),
    (err) => err.status === 400 && /at least 8/.test(err.fields.password)
  );
});

// The reason registration cannot reuse the repository's ordinary createUser: that one is
// an upsert (db/createUser.js resets passwords with it), so this request would silently
// overwrite the credentials of the account it collides with.
test('registering an address that already has an account never overwrites it', async () => {
  const email = address('taken');
  await store.registerUser({ display_name: 'First Person', email, password: PASSWORD });

  await assert.rejects(
    store.registerUser({ display_name: 'Impostor', email, password: 'a-completely-different-one' }),
    (err) => err.status === 409 && /already exists/.test(err.message)
  );

  const stored = await store.getUserByUsername(email.toLowerCase());
  assert.ok(await auth.verifyPassword(PASSWORD, stored.password_hash), 'the original password was replaced');
  assert.strictEqual(stored.display_name, 'First Person');
});

test('an address already in the directory binds to that person and adopts the registration name', async () => {
  const email = address('already.known');
  const existing = await store.createPerson({ display_name: 'Already Known', email, can_approve: 'Yes' });

  const account = await store.registerUser({ display_name: 'Typed A Different Name', email, password: PASSWORD });
  assert.strictEqual(account.person_id, existing.person_id);
  assert.strictEqual(account.display_name, 'Typed A Different Name');

  const matches = (await store.readPeople()).filter((candidate) => String(candidate.email).toLowerCase() === email.toLowerCase());
  assert.strictEqual(matches.length, 1, 'a second directory entry was created for the same person');
  assert.strictEqual(matches[0].display_name, 'Typed A Different Name');
  assert.strictEqual((await person(existing.person_id)).can_approve, 'Yes', 'registration must not reset existing capabilities');

  const stored = await store.getUserByUsername(email.toLowerCase());
  assert.strictEqual(stored.display_name, 'Typed A Different Name');
});

// Deactivating somebody is a deliberate act. If registering the same address handed back a
// working account, the Active switch would be a formality.
test('a deactivated person cannot be re-registered', async () => {
  const email = address('gone');
  const existing = await store.createPerson({ display_name: 'Gone Away', email });
  await store.updatePerson(existing.person_id, { active: 'No' });

  await assert.rejects(
    store.registerUser({ display_name: 'Gone Away', email, password: PASSWORD }),
    (err) => err.status === 409 && /deactivated/.test(err.message)
  );
});

test('names are not matched — a namesake gets their own directory entry', async () => {
  const first = await store.createPerson({ display_name: 'Sam Namesake', email: address('sam.one') });
  const account = await store.registerUser({ display_name: 'Sam Namesake', email: address('sam.two'), password: PASSWORD });
  assert.notStrictEqual(account.person_id, first.person_id);
});

// ---------------------------------------------------------------- passwords

test('changing a password requires the current one and invalidates old sessions', async () => {
  const email = address('changes.password');
  const account = await store.registerUser({ display_name: 'Changes Password', email, password: PASSWORD });
  const before = await store.getUserByUsername(account.username);

  await assert.rejects(
    store.changePassword(account.username, 'not-the-password', 'another-good-password'),
    (err) => err.status === 400 && err.fields.current_password === 'is incorrect'
  );
  await assert.rejects(
    store.changePassword(account.username, PASSWORD, 'short'),
    (err) => err.status === 400 && /at least 8/.test(err.fields.new_password)
  );
  await assert.rejects(
    store.changePassword(account.username, PASSWORD, PASSWORD),
    (err) => err.status === 400 && /different/.test(err.fields.new_password)
  );

  const result = await store.changePassword(account.username, PASSWORD, 'another-good-password');
  const after = await store.getUserByUsername(account.username);
  assert.ok(await auth.verifyPassword('another-good-password', after.password_hash));
  assert.ok(!await auth.verifyPassword(PASSWORD, after.password_hash));
  // The whole session-revocation mechanism: sessions carry this number and are checked
  // against it on every request, so cookies signed before the change stop working.
  assert.notStrictEqual(String(after.password_version), String(before.password_version || '0'));
  assert.strictEqual(String(after.password_version), result.password_version);
});

test('an administrator reset issues a working single-use password and voids the old one', async () => {
  const email = address('forgot');
  const account = await store.registerUser({ display_name: 'Forgot It', email, password: PASSWORD });
  const before = await store.getUserByUsername(account.username);

  const result = await store.resetPassword(account.username);
  assert.ok(result.temporary_password.length >= 12);

  const after = await store.getUserByUsername(account.username);
  assert.ok(await auth.verifyPassword(result.temporary_password, after.password_hash));
  assert.ok(!await auth.verifyPassword(PASSWORD, after.password_hash));
  assert.notStrictEqual(String(after.password_version), String(before.password_version || '0'));

  // Generated, not fixed: a shared reset password would be a single guess away from every
  // account that has ever been reset.
  const second = await store.resetPassword(account.username);
  assert.notStrictEqual(second.temporary_password, result.temporary_password);
});

test('resetting an unknown account is a 404, not a silent create', async () => {
  await assert.rejects(store.resetPassword('nobody@polyu.edu.hk'), (err) => err.status === 404);
  await assert.rejects(store.changePassword('nobody@polyu.edu.hk', PASSWORD, 'another-one'), (err) => err.status === 404);
});

// ---------------------------------------------------------------- roles

test('an account can be promoted and demoted', async () => {
  const account = await store.registerUser({ display_name: 'Promotable', email: address('promotable'), password: PASSWORD });
  await admin('keeps-admin-alive');

  assert.strictEqual((await store.setUserRole(account.username, 'admin')).role, 'admin');
  assert.strictEqual((await store.getUserByUsername(account.username)).role, 'admin');
  assert.strictEqual((await store.setUserRole(account.username, 'requester')).role, 'requester');

  await assert.rejects(store.setUserRole(account.username, 'superuser'), (err) => err.status === 400);
  await assert.rejects(store.setUserRole('nobody@polyu.edu.hk', 'admin'), (err) => err.status === 404);
});

// Losing every administrator puts the supplier master, the queue and this screen behind a
// server-side data edit. Both routes out of the role are blocked, not just the obvious one.
test('the last administrator can be neither demoted nor deactivated', async () => {
  // Get down to one administrator — whichever earlier tests left behind, plus a fresh one
  // if they left none. Demoting them all is exactly what must not be possible.
  const existing = (await store.listUsers()).filter((user) => user.role === 'admin');
  for (const user of existing.slice(1)) await store.setUserRole(user.username, 'requester');
  const only = existing.length ? existing[0] : await admin('sole-admin');

  await assert.rejects(store.setUserRole(only.username, 'requester'), (err) => err.status === 409 && /last administrator/.test(err.message));
  await assert.rejects(store.updatePerson(only.person_id, { active: 'No' }), (err) => err.status === 409 && /last administrator/.test(err.message));

  // With a second administrator in place, both become ordinary operations again.
  const second = await admin('second-admin');
  assert.strictEqual((await store.setUserRole(only.username, 'requester')).role, 'requester');
  await assert.rejects(store.updatePerson(second.person_id, { active: 'No' }), (err) => err.status === 409);
});

test('listUsers never exposes password material', async () => {
  const users = await store.listUsers();
  assert.ok(users.length > 0);
  for (const user of users) {
    assert.ok(!('password_hash' in user), `${user.username} carried its hash into the API layer`);
    assert.ok(!('password_version' in user));
  }
});
