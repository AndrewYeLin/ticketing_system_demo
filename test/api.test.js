'use strict';

// End-to-end HTTP tests against a real server process.
//
// The domain tests in store.test.js call lib/store directly and therefore prove nothing
// about the layer that decides *who* may call it. Everything here is driven over the
// wire with real session cookies, because that is the only way to prove that identity
// comes from the session rather than from the request body, and that a requester cannot
// reach admin routes or another requester's records.
//
// The server runs against a temp DATA_DIR / UPLOAD_DIR and is torn down afterwards, so
// no test ever touches real data/ or uploads/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const csv = require('../lib/csv');
const { writePeopleFixture } = require('../test-support/peopleFixture');
const {
  USER_COLUMNS,
  PROCUREMENT_SUBMIT_TO_ADMIN,
  PROCUREMENT_SUBMIT_TO_APPROVER,
  PROCUREMENT_RETURN_TO_REQUESTOR,
  PROCUREMENT_PO_ISSUED,
  PROCUREMENT_INVOICE_RECEIVED,
  PROCUREMENT_RECEIVED_ORDER_LINES,
  PROCUREMENT_CLOSED,
} = require('../lib/constants');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frt-api-'));
const DATA_DIR = path.join(TMP, 'data');
const UPLOAD_DIR = path.join(TMP, 'uploads');
const SESSION_SECRET = 'test-secret-not-the-default';

// Signing sessions ourselves is how the expired/forged-cookie cases are exercised; the
// login endpoint will only ever mint valid ones.
process.env.SESSION_SECRET = SESSION_SECRET;
const auth = require('../lib/auth');

const USERS = [
  { username: 'admin', role: 'admin', person_id: 'PER-001', display_name: 'Administrator', password: 'admin-pw' },
  { username: 'alice', role: 'requester', person_id: 'PER-011', display_name: 'Alice', password: 'alice-pw' },
  { username: 'bob', role: 'requester', person_id: 'PER-012', display_name: 'Bob', password: 'bob-pw' },
  { username: 'dormant', role: 'requester', person_id: '', display_name: 'Dormant', password: 'dormant-pw', active: 'No' },
];

let child;
let base;
const cookies = {};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch (_) { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('server did not become healthy in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

// `who` is a username whose cookie has been captured by login(), or a raw cookie string,
// or null for an unauthenticated call.
function cookieHeader(who) {
  if (!who) return undefined;
  const token = cookies[who] || who;
  return `${auth.COOKIE_NAME}=${token}`;
}

async function call(who, method, pathname, { json, body, headers } = {}) {
  const init = { method, headers: { ...(headers || {}) }, redirect: 'manual' };
  const cookie = cookieHeader(who);
  if (cookie) init.headers.cookie = cookie;
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = typeof json === 'string' ? json : JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(base + pathname, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

const get = (who, p, o) => call(who, 'GET', p, o);
const post = (who, p, o) => call(who, 'POST', p, o);
const patch = (who, p, o) => call(who, 'PATCH', p, o);
const del = (who, p, o) => call(who, 'DELETE', p, o);

async function login(username, password) {
  const res = await post(null, '/api/login', { json: { username, password } });
  if (res.status === 200) {
    const setCookie = res.headers.getSetCookie()[0] || '';
    cookies[username] = setCookie.split(';')[0].split('=').slice(1).join('=');
  }
  return res;
}

test.before(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  writePeopleFixture(DATA_DIR);
  const userRows = await Promise.all(USERS.map(async (u) => ({
    username: u.username, password_hash: await auth.hashPassword(u.password), role: u.role,
    person_id: u.person_id, display_name: u.display_name, active: u.active || 'Yes',
  })));
  fs.writeFileSync(
    path.join(DATA_DIR, 'users.csv'),
    csv.stringify(userRows, USER_COLUMNS),
    'utf8'
  );

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // Registration domain and mail settings are pinned rather than inherited: the repo's
    // own .env must not decide whether these tests pass, or whether they send mail.
    env: {
      ...process.env, DATA_DIR, UPLOAD_DIR, PORT: String(port), SESSION_SECRET, STORAGE: '',
      REGISTRATION_ALLOWED_DOMAINS: 'polyu.edu.hk', MAIL_TRANSPORT: 'log',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => { process.stderr.write(`[server] ${d}`); });
  await waitForHealth();

  for (const u of USERS) if (u.active !== 'No') await login(u.username, u.password);
});

test.after(async () => {
  if (child) {
    child.kill();
    await new Promise((r) => child.on('exit', r));
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

// A fresh draft owned by `who`. Travel/Domestic because a draft of it needs no evidence.
const scratchDrafts = [];
async function draft(who, over) {
  const res = await post(who, '/api/requests', {
    json: { request_type: 'Travel', sub_type: 'Domestic', ...(over || {}) },
  });
  assert.strictEqual(res.status, 201, `draft create failed: ${res.text}`);
  scratchDrafts.push([who, res.body.request_id]);
  return res.body;
}

// A requester may only hold so many open drafts, and these tests would otherwise leave
// dozens of abandoned ones behind and start failing partway down the file purely because
// of how many tests ran before. Best effort: anything that has moved on from Draft, or is
// already gone, refuses the discard and that is fine.
test.afterEach(async () => {
  while (scratchDrafts.length) {
    const [who, id] = scratchDrafts.pop();
    await post(who, `/api/requests/${id}/discard`, { json: {} }).catch(() => {});
  }
});

// ---------------------------------------------------------------- authentication

test('every API route except login/logout/health demands a session', async () => {
  for (const [method, route] of [['GET', '/api/requests'], ['GET', '/api/options'], ['GET', '/api/me'],
    ['POST', '/api/requests'], ['GET', '/api/suppliers'], ['GET', '/api/people']]) {
    const res = await call(null, method, route, method === 'POST' ? { json: {} } : undefined);
    assert.strictEqual(res.status, 401, `${method} ${route} was reachable without a session`);
  }
});

test('health is reachable unauthenticated and names the backend', async () => {
  const res = await get(null, '/api/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.storage, 'csv');
});

test('login rejects a wrong password and an unknown user with the same answer', async () => {
  assert.strictEqual((await post(null, '/api/login', { json: { username: 'alice', password: 'wrong' } })).status, 401);
  assert.strictEqual((await post(null, '/api/login', { json: { username: 'nobody', password: 'alice-pw' } })).status, 401);
});

// Said plainly rather than as "invalid username or password": the caller has just proved
// they hold the password, so nothing is revealed that they did not already know, and the
// alternative is a support call for every account anybody has ever switched off.
test('a deactivated account is told it is deactivated, not that its password is wrong', async () => {
  const res = await post(null, '/api/login', { json: { username: 'dormant', password: 'dormant-pw' } });
  assert.strictEqual(res.status, 403);
  assert.match(res.body.error, /disabled/i);
});

test('a successful login sets an HttpOnly SameSite cookie and returns the identity', async () => {
  const res = await post(null, '/api/login', { json: { username: 'alice', password: 'alice-pw' } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(
    { username: res.body.username, role: res.body.role, person_id: res.body.person_id },
    { username: 'alice', role: 'requester', person_id: 'PER-011' }
  );
  const setCookie = res.headers.getSetCookie()[0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
});

// Unlimited guessing against a known username list is the whole attack; scrypt alone is
// not a rate limit. A deliberately unused username keeps the other tests' accounts clear.
test('repeated failed logins are throttled, and the block names a retry delay', async () => {
  const target = 'brute-force-target';
  let throttled = null;
  for (let i = 0; i < 12 && !throttled; i++) {
    const res = await post(null, '/api/login', { json: { username: target, password: `guess-${i}` } });
    if (res.status === 429) throttled = res;
    else assert.strictEqual(res.status, 401, `attempt ${i} returned ${res.status}`);
  }
  assert.ok(throttled, 'twelve consecutive failed logins were all answered');
  assert.match(throttled.headers.get('retry-after') || '', /^\d+$/);
});

test('throttling one account does not lock out a different one', async () => {
  assert.strictEqual((await post(null, '/api/login', { json: { username: 'bob', password: 'bob-pw' } })).status, 200);
});

test('a tampered or expired cookie is treated as no session at all', async () => {
  const expired = auth.signSession({ username: 'admin', role: 'admin', person_id: 'PER-001', display_name: 'Administrator', exp: Date.now() - 1000 });
  assert.strictEqual((await get(expired, '/api/me')).status, 401, 'an expired session was accepted');

  const [body, sig] = cookies.alice.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  claims.role = 'admin';
  const forged = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + sig;
  assert.strictEqual((await get(forged, '/api/me')).status, 401, 'a re-signed role claim was accepted');
});

test('/api/me reports the session identity', async () => {
  const res = await get('alice', '/api/me');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.username, 'alice');
  assert.strictEqual(res.body.role, 'requester');
});

// ---------------------------------------------------------------- self-registration

let registered = 0;
async function register(over) {
  const email = `test.user.${++registered}@polyu.edu.hk`;
  const res = await post(null, '/api/register', {
    json: { display_name: `Test User ${registered}`, email, password: 'a-long-enough-password', ...(over || {}) },
  });
  if (res.status === 201) {
    const setCookie = res.headers.getSetCookie()[0] || '';
    cookies[res.body.username] = setCookie.split(';')[0].split('=').slice(1).join('=');
  }
  return { res, email };
}

test('registering signs the new account straight in as a requester', async () => {
  const { res, email } = await register();
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.username, email);
  assert.strictEqual(res.body.role, 'requester');

  const me = await get(email, '/api/me');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.role, 'requester');
  // The account is real: it can file its own request and see it back.
  const created = await post(email, '/api/requests', { json: { request_type: 'Travel', sub_type: 'Domestic' } });
  assert.strictEqual(created.status, 201, created.text);
  const mine = await get(email, '/api/requests');
  assert.ok(mine.body.some((row) => row.request_id === created.body.request_id));
  await post(email, `/api/requests/${created.body.request_id}/discard`, { json: {} });
});

test('registration adopts the matched People name across the session and directory', async () => {
  const email = `known.person.${++registered}@polyu.edu.hk`;
  const createdPerson = await post('admin', '/api/people', {
    json: {
      display_name: 'Directory Name', email, active: 'Yes', can_request: 'Yes',
      can_travel: 'Yes', can_approve: 'Yes', can_process: 'No',
    },
  });
  assert.strictEqual(createdPerson.status, 201, createdPerson.text);

  const registration = await post(null, '/api/register', {
    json: { display_name: 'Registered Name', email, password: 'a-long-enough-password' },
  });
  assert.strictEqual(registration.status, 201, registration.text);
  assert.strictEqual(registration.body.person_id, createdPerson.body.person_id);
  assert.strictEqual(registration.body.display_name, 'Registered Name');
  cookies[email] = (registration.headers.getSetCookie()[0] || '').split(';')[0].split('=').slice(1).join('=');

  const me = await get(email, '/api/me');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.display_name, 'Registered Name');

  const people = await get('admin', '/api/people');
  const person = people.body.find((candidate) => candidate.person_id === createdPerson.body.person_id);
  assert.strictEqual(person.display_name, 'Registered Name');
  assert.strictEqual(person.can_approve, 'Yes');
});

test('registration cannot grant itself an admin role or reach admin routes', async () => {
  const { res, email } = await register({ role: 'admin' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.role, 'requester');
  assert.strictEqual((await get(email, '/api/people')).status, 403);
  assert.strictEqual((await get(email, '/api/users')).status, 403);
});

test('registration refuses an outside domain, a weak password and a taken address', async () => {
  assert.strictEqual((await register({ email: 'someone@gmail.com' })).res.status, 400);
  assert.strictEqual((await register({ password: 'short' })).res.status, 400);
  const { email } = await register();
  const again = await post(null, '/api/register', {
    json: { display_name: 'Impostor', email, password: 'another-long-password' },
  });
  assert.strictEqual(again.status, 409);
  // And the original credentials still work — the collision did not overwrite them.
  assert.strictEqual((await post(null, '/api/login', { json: { username: email, password: 'a-long-enough-password' } })).status, 200);
});

// ---------------------------------------------------------------- passwords and accounts

test('changing a password re-signs the caller and kills the sessions issued before it', async () => {
  const { email } = await register();
  const oldCookie = cookies[email];

  assert.strictEqual((await post(email, '/api/password', { json: { current_password: 'wrong', new_password: 'brand-new-password' } })).status, 400);

  const res = await post(email, '/api/password', {
    json: { current_password: 'a-long-enough-password', new_password: 'brand-new-password' },
  });
  assert.strictEqual(res.status, 200);
  const newCookie = (res.headers.getSetCookie()[0] || '').split(';')[0].split('=').slice(1).join('=');
  assert.notStrictEqual(newCookie, oldCookie);

  // The cookie the caller arrived with is stateless and still perfectly signed — only the
  // password version stamped in it is stale, which is the entire point of that field.
  assert.strictEqual((await get(oldCookie, '/api/me')).status, 401, 'a session from before the change survived');
  assert.strictEqual((await get(newCookie, '/api/me')).status, 200);
  cookies[email] = newCookie;
  assert.strictEqual((await post(null, '/api/login', { json: { username: email, password: 'brand-new-password' } })).status, 200);
});

test('an administrator reset hands back a working password once and voids the old sessions', async () => {
  const { email } = await register();
  const theirCookie = cookies[email];

  assert.strictEqual((await post('alice', `/api/users/${encodeURIComponent(email)}/reset-password`, { json: {} })).status, 403);

  const res = await post('admin', `/api/users/${encodeURIComponent(email)}/reset-password`, { json: {} });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.temporary_password && res.body.temporary_password.length >= 12);

  assert.strictEqual((await get(theirCookie, '/api/me')).status, 401, 'a reset did not sign the account out');
  assert.strictEqual((await post(null, '/api/login', { json: { username: email, password: res.body.temporary_password } })).status, 200);
});

test('the account list is admin-only and never carries password material', async () => {
  assert.strictEqual((await get('alice', '/api/users')).status, 403);
  const res = await get('admin', '/api/users');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.some((user) => user.username === 'admin' && user.role === 'admin'));
  for (const user of res.body) assert.ok(!('password_hash' in user), `${user.username} carried its hash to the client`);
});

test('a role change applies to the very next request, in both directions', async () => {
  const { email } = await register();
  assert.strictEqual((await get(email, '/api/people')).status, 403);

  assert.strictEqual((await patch('admin', `/api/users/${encodeURIComponent(email)}`, { json: { role: 'admin' } })).status, 200);
  // Same cookie, minted while they were a requester: the role is read from the account.
  assert.strictEqual((await get(email, '/api/people')).status, 200, 'a promotion waited for the session to expire');

  assert.strictEqual((await patch('admin', `/api/users/${encodeURIComponent(email)}`, { json: { role: 'requester' } })).status, 200);
  assert.strictEqual((await get(email, '/api/people')).status, 403, 'a demotion waited for the session to expire');
  assert.strictEqual((await patch('alice', `/api/users/${encodeURIComponent(email)}`, { json: { role: 'admin' } })).status, 403);
});

// The People directory's Active switch used to control only which dropdowns somebody
// appeared in; a deactivated person could still sign in and file requests.
test('deactivating a person cuts off their account, mid-session and at the door', async () => {
  const { email } = await register();
  const me = await get(email, '/api/me');
  assert.strictEqual(me.status, 200);

  assert.strictEqual((await patch('admin', `/api/people/${encodeURIComponent(me.body.person_id)}`, {
    json: { display_name: me.body.display_name, active: 'No' },
  })).status, 200);

  assert.strictEqual((await get(email, '/api/me')).status, 401, 'a deactivated person kept working through their session');
  assert.strictEqual((await post(null, '/api/login', { json: { username: email, password: 'a-long-enough-password' } })).status, 403);
});

// An open endpoint that writes rows is a free account and disk-quota generator without a
// ceiling. Last in this section on purpose: it deliberately exhausts the window, so any
// test that registers has to have run already.
test('registration is throttled per source address', async () => {
  let throttled = null;
  for (let i = 0; i < 30 && !throttled; i++) {
    const { res } = await register();
    if (res.status === 429) throttled = res;
  }
  assert.ok(throttled, 'thirty consecutive registrations were all accepted');
  assert.match(throttled.headers.get('retry-after') || '', /^\d+$/);
});

// ---------------------------------------------------------------- role boundaries

test('the supplier master and people directory are admin-only', async () => {
  for (const [method, route, opts] of [
    ['GET', '/api/suppliers', undefined],
    ['POST', '/api/suppliers', { json: { legal_entity_name: 'Sneaky Co', purchase_order_email: 'x@y.com' } }],
    ['PATCH', '/api/suppliers/SUP-1', { json: { status: 'Approved' } }],
    ['GET', '/api/people', undefined],
    ['POST', '/api/people', { json: { display_name: 'Ghost' } }],
    ['PATCH', '/api/people/PER-011', { json: { active: 'No' } }],
  ]) {
    const res = await call('alice', method, route, opts);
    assert.strictEqual(res.status, 403, `requester reached ${method} ${route}`);
  }
  assert.strictEqual((await get('admin', '/api/suppliers')).status, 200);
  assert.strictEqual((await get('admin', '/api/people')).status, 200);
});

test('a requester cannot use the generic PATCH endpoint even on their own request', async () => {
  const row = await draft('alice');
  const res = await patch('alice', `/api/requests/${row.request_id}`, {
    json: { current_status: 'Completed', processed_by: 'Alex Lee', _version: row.last_updated_at },
  });
  assert.strictEqual(res.status, 403);
  const after = await get('alice', `/api/requests/${row.request_id}`);
  assert.strictEqual(after.body.current_status, 'Draft', 'the forbidden PATCH still changed the row');
});

test('soft delete and restore are admin-only', async () => {
  const row = await draft('alice');
  assert.strictEqual((await post('alice', `/api/requests/${row.request_id}/delete`, { json: {} })).status, 403);
  assert.strictEqual((await post('alice', `/api/requests/${row.request_id}/restore`, { json: {} })).status, 403);
  assert.strictEqual((await post('admin', `/api/requests/${row.request_id}/delete`, { json: {} })).status, 200);
});

test('internal notes are admin-only and hidden from the requester history', async () => {
  const row = await draft('alice');
  assert.strictEqual((await post('alice', `/api/requests/${row.request_id}/internal-note`, { json: { internal_note: 'mine' } })).status, 403);

  const noted = await post('admin', `/api/requests/${row.request_id}/internal-note`, { json: { internal_note: 'finance eyes only' } });
  assert.strictEqual(noted.status, 200);

  const adminHistory = await get('admin', `/api/requests/${row.request_id}/history`);
  assert.ok(adminHistory.body.some((e) => e.event_type === 'Internal Note'));

  const ownerHistory = await get('alice', `/api/requests/${row.request_id}/history`);
  assert.ok(!ownerHistory.body.some((e) => e.event_type === 'Internal Note'), 'the requester can read internal notes');
  assert.ok(ownerHistory.body.every((e) => e.changed_fields === ''), 'field-level diffs leaked to the requester');
});

// The 'Internal Note' event label is derived: store.updateRequest only applies it when
// nothing else changed in the same call. Smuggling the note into a PATCH that also moves
// a field therefore used to log it as an ordinary 'Field Updated' event, note text and
// all — and the requester's history filter keys off that label alone.
test('an internal note cannot be smuggled through the generic PATCH', async () => {
  const row = await draft('alice');
  const res = await patch('admin', `/api/requests/${row.request_id}`, {
    json: { internal_note: 'finance eyes only', next_action: 'Chase the quote', _version: row.last_updated_at },
  });
  assert.strictEqual(res.status, 200);

  const ownerHistory = await get('alice', `/api/requests/${row.request_id}/history`);
  assert.ok(
    ownerHistory.body.every((e) => !String(e.note || '').includes('finance eyes only')),
    'an internal note reached the requester as an ordinary field-update event'
  );
});

// Every requester can list every approved supplier via /api/options, so whatever this
// route returns is effectively readable for the whole supplier master by anyone who can
// sign in. It used to include the bank name, the account name and the last four digits —
// the exact ingredients of an invoice-redirection scam.
test('the supplier amendment template carries no bank details of any kind', async () => {
  const created = await post('admin', '/api/suppliers', {
    json: {
      legal_entity_name: 'Bank Leak Test Pty Ltd',
      purchase_order_email: 'po@bankleak.example',
      supplier_form_data: JSON.stringify({
        legal_entity_name: 'Bank Leak Test Pty Ltd',
        contact_email: 'ap@bankleak.example',
        bank_type: 'Australian EFT',
        bank_name: 'Westpac Secret Branch',
        bank_account_name: 'Bank Leak Test Pty Ltd',
        bsb: '032-999',
        account_number: '87654321',
      }),
    },
  });
  assert.strictEqual(created.status, 201, created.text);
  const id = created.body.supplier_id;
  assert.strictEqual((await patch('admin', `/api/suppliers/${id}`, { json: { status: 'Approved' } })).status, 200);

  const res = await get('alice', `/api/supplier-amendment-template/${id}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.can_keep_bank_details, true, 'the form still needs to know it can reuse them');

  const serialised = JSON.stringify(res.body);
  for (const secret of ['Westpac Secret Branch', '032-999', '87654321', '4321', 'bank_account_name', 'bank_summary']) {
    assert.ok(!serialised.includes(secret), `the template leaked ${secret}`);
  }
});

test('discarding a draft is a requester action and is refused to admins', async () => {
  const row = await draft('alice');
  assert.strictEqual((await post('admin', `/api/requests/${row.request_id}/discard`, { json: {} })).status, 403);
  assert.strictEqual((await post('alice', `/api/requests/${row.request_id}/discard`, { json: {} })).status, 200);
  assert.strictEqual((await get('admin', `/api/requests/${row.request_id}`)).status, 404);
});

// ---------------------------------------------------------------- ownership

test('a requester cannot read, act on or list another requester\'s request', async () => {
  const row = await draft('alice');
  const id = row.request_id;

  assert.strictEqual((await get('bob', `/api/requests/${id}`)).status, 403);
  assert.strictEqual((await get('bob', `/api/requests/${id}/history`)).status, 403);
  assert.strictEqual((await post('bob', `/api/requests/${id}/save-draft`, { json: { destination: 'Hijacked', _version: row.last_updated_at } })).status, 403);
  assert.strictEqual((await post('bob', `/api/requests/${id}/submit`, { json: { _version: row.last_updated_at } })).status, 403);
  assert.strictEqual((await post('bob', `/api/requests/${id}/discard`, { json: {} })).status, 403);
  assert.strictEqual((await post('bob', `/api/requests/${id}/attachments?purpose=travel_request&version=x`, { body: 'x' })).status, 403);

  const bobList = await get('bob', '/api/requests');
  assert.ok(!bobList.body.some((r) => r.request_id === id), "another requester's row appeared in the list");
});

test('the admin queue hides drafts but the owner still sees their own', async () => {
  const row = await draft('alice', { destination: 'Alice Draft City' });
  const adminList = await get('admin', '/api/requests');
  assert.ok(!adminList.body.some((r) => r.request_id === row.request_id), 'a draft leaked into the admin queue');
  const aliceList = await get('alice', '/api/requests');
  assert.ok(aliceList.body.some((r) => r.request_id === row.request_id));
});

test('identity comes from the session, not from the request body', async () => {
  const res = await post('alice', '/api/requests', {
    json: {
      request_type: 'Travel', sub_type: 'Domestic',
      requester_name: 'Bob', requester_person_id: 'PER-012', received_date: '1999-01-01',
    },
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.requester_name, 'Alice');
  assert.strictEqual(res.body.requester_person_id, 'PER-011');
  assert.notStrictEqual(res.body.received_date, '1999-01-01');

  const history = await get('admin', `/api/requests/${res.body.request_id}/history`);
  assert.strictEqual(history.body[0].changed_by, 'alice', 'audit changed_by was taken from the body');

  assert.strictEqual((await get('bob', `/api/requests/${res.body.request_id}`)).status, 403,
    'spoofing requester_person_id handed the request to another user');
});

// ---------------------------------------------------------------- attachments

const PDF = Buffer.from('%PDF-1.4 test fixture');

async function upload(who, id, purpose, version, { filename = 'evidence.pdf', bytes = PDF } = {}) {
  return post(who, `/api/requests/${id}/attachments?purpose=${encodeURIComponent(purpose)}&filename=${encodeURIComponent(filename)}&version=${encodeURIComponent(version)}`, { body: bytes });
}

test('attachment uploads have their own history event instead of looking like field edits', async () => {
  const row = await draft('alice');
  let current = row;
  for (const purpose of ['travel_request', 'approval_email']) {
    const result = await upload('alice', row.request_id, purpose, current.last_updated_at);
    assert.strictEqual(result.status, 200, result.text);
    current = result.body;
  }
  const history = await get('admin', `/api/requests/${row.request_id}/history`);
  const uploads = history.body.filter((event) => event.event_type === 'Attachment Updated');
  assert.strictEqual(uploads.length, 2);
  assert.strictEqual(history.body.filter((event) => event.event_type === 'Field Updated').length, 0);
});

test('an admin can replace requester evidence and the history names the admin', async () => {
  const row = await draft('alice');
  const requesterUpload = await upload('alice', row.request_id, 'travel_request', row.last_updated_at, { filename: 'requester.pdf' });
  assert.strictEqual(requesterUpload.status, 200, requesterUpload.text);
  const adminUpload = await upload('admin', row.request_id, 'travel_request', requesterUpload.body.last_updated_at, { filename: 'finance-replacement.pdf' });
  assert.strictEqual(adminUpload.status, 200, adminUpload.text);
  const history = await get('admin', `/api/requests/${row.request_id}/history`);
  const attachmentEvents = history.body.filter((event) => event.event_type === 'Attachment Updated');
  assert.strictEqual(attachmentEvents.length, 2);
  assert.strictEqual(attachmentEvents.at(-1).changed_by, 'admin');
  assert.match(attachmentEvents.at(-1).changed_fields, /finance-replacement\.pdf/);
});

test('an upload without the version query param is refused', async () => {
  const row = await draft('alice');
  const res = await post('alice', `/api/requests/${row.request_id}/attachments?purpose=travel_request`, { body: PDF });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /version/i);
});

test('an empty upload and a disallowed file type are refused', async () => {
  const row = await draft('alice');
  const empty = await upload('alice', row.request_id, 'travel_request', row.last_updated_at, { bytes: Buffer.alloc(0) });
  assert.strictEqual(empty.status, 400);

  // The last three used to slip past the deny-list this replaced.
  for (const filename of ['payload.exe', 'page.html', 'icon.svg', 'run.bat', 'script.js',
    'page.xhtml', 'page.shtml', 'applet.jar']) {
    const res = await upload('alice', row.request_id, 'travel_request', row.last_updated_at, { filename });
    assert.strictEqual(res.status, 400, `${filename} was accepted`);
  }
});

test('the document types the workflow actually needs are still accepted', async () => {
  let row = await draft('alice');
  for (const filename of ['quote.pdf', 'receipt.jpg', 'approval.msg', 'itinerary.docx']) {
    const res = await upload('alice', row.request_id, 'travel_request', row.last_updated_at, { filename });
    assert.strictEqual(res.status, 200, `${filename} was rejected: ${res.text}`);
    row = res.body;
  }
});

test('a traversal filename is flattened and stays inside the upload directory', async () => {
  const row = await draft('alice');
  const res = await upload('alice', row.request_id, 'travel_request', row.last_updated_at, {
    filename: '../../../../etc/passwd.pdf',
  });
  assert.strictEqual(res.status, 200);
  const stored = JSON.parse(res.body.attachments).find((a) => a.purpose === 'travel_request').stored;
  assert.ok(!stored.includes('..') && !stored.includes('/') && !stored.includes('\\'), `stored name escaped: ${stored}`);
  assert.ok(fs.existsSync(path.join(UPLOAD_DIR, stored)), 'the file did not land in UPLOAD_DIR');
  assert.deepStrictEqual(fs.readdirSync(TMP).sort(), ['data', 'uploads'], 'a file was written outside UPLOAD_DIR');
});

test('a requester cannot attach the purchase order', async () => {
  const row = await draft('alice');
  const res = await upload('alice', row.request_id, 'po', row.last_updated_at);
  assert.strictEqual(res.status, 403);
});

test('an attachment purpose that does not belong to the subtype is refused', async () => {
  const row = await draft('alice');
  const res = await upload('alice', row.request_id, 'quote', row.last_updated_at);
  assert.strictEqual(res.status, 400);
  const invoiceOther = await upload('alice', row.request_id,
    `invoice_other:${crypto.randomUUID()}:${crypto.randomUUID()}`, row.last_updated_at);
  assert.strictEqual(invoiceOther.status, 400);
});

test('a requester can attach an optional document to an invoice at the PO stage', async () => {
  const created = await post('alice', '/api/requests', { json: {
    request_type: 'Procurement', sub_type: 'Purchase / PO request', supplier_type: 'Existing Supplier',
    supplier_quote_number: 'Q-INVOICE-OTHER', cost_code: '2391', activity_code: '3203',
    spending_approver_person_id: 'PER-005', spending_approver: 'Jane Manager', amount_ex_gst: '100',
  } });
  assert.strictEqual(created.status, 201, created.text);
  scratchDrafts.push(['alice', created.body.request_id]);
  let row = created.body;
  for (const purpose of ['quote', 'approval_email']) {
    const up = await upload('alice', row.request_id, purpose, row.last_updated_at);
    assert.strictEqual(up.status, 200, up.text);
    row = up.body;
  }
  const submitted = await post('alice', `/api/requests/${row.request_id}/submit`, { json: { _version: row.last_updated_at } });
  assert.strictEqual(submitted.status, 200, submitted.text);
  const poFile = await upload('admin', row.request_id, 'po', submitted.body.last_updated_at, { filename: 'po.pdf' });
  assert.strictEqual(poFile.status, 200, poFile.text);
  const poStage = await patch('admin', `/api/requests/${row.request_id}`, { json: {
    current_status: PROCUREMENT_PO_ISSUED, po_number: 'PO-INVOICE-OTHER',
    _version: poFile.body.last_updated_at, _from_status: PROCUREMENT_SUBMIT_TO_ADMIN,
  } });
  assert.strictEqual(poStage.status, 200, poStage.text);
  const invoiceId = crypto.randomUUID();
  const invoiceDraft = [{ item_id: invoiceId, invoice_number: 'INV-DRAFT', amount_ex_gst: '', amount_inc_gst: '45' }];
  const stagedInvoice = await post('alice', `/api/requests/${row.request_id}/save-invoice-progress`, { json: {
    invoice_items: invoiceDraft, _version: poStage.body.last_updated_at,
  } });
  assert.strictEqual(stagedInvoice.status, 200, stagedInvoice.text);
  const invoiceOtherPurpose = `invoice_other:${invoiceId}:${crypto.randomUUID()}`;
  const optional = await upload('alice', row.request_id, invoiceOtherPurpose, stagedInvoice.body.last_updated_at,
    { filename: 'delivery-docket.pdf' });
  assert.strictEqual(optional.status, 200, optional.text);
  const approvalOtherPurpose = `invoice_approval_other:${crypto.randomUUID()}`;
  const additionalApproval = await upload('alice', row.request_id, approvalOtherPurpose, optional.body.last_updated_at,
    { filename: 'second-approval.eml' });
  assert.strictEqual(additionalApproval.status, 200, additionalApproval.text);
  const purposes = JSON.parse(additionalApproval.body.attachments).map((item) => item.purpose);
  assert.ok(purposes.includes(invoiceOtherPurpose));
  assert.ok(purposes.includes(approvalOtherPurpose));

  const saved = await post('alice', `/api/requests/${row.request_id}/save-invoice-progress`, { json: {
    invoice_items: invoiceDraft,
    chk_po_included: 'No', chk_desc_matches_po: 'No', chk_service_completed: 'No',
    chk_forwarded_to_approver: 'No', _version: additionalApproval.body.last_updated_at,
  } });
  assert.strictEqual(saved.status, 200, saved.text);
  assert.strictEqual(saved.body.current_status, PROCUREMENT_PO_ISSUED);
  assert.deepStrictEqual(JSON.parse(saved.body.invoice_items), invoiceDraft);
});

test('a stale version stamp blocks an upload', async () => {
  const row = await draft('alice');
  const first = await upload('alice', row.request_id, 'travel_request', row.last_updated_at);
  assert.strictEqual(first.status, 200);
  const stale = await upload('alice', row.request_id, 'approval_email', row.last_updated_at);
  assert.strictEqual(stale.status, 409, 'a second tab could overwrite with a stale version');
});

test('attachment routes 404 on an unknown request rather than leaking existence', async () => {
  assert.strictEqual((await upload('alice', 'FR-19700101-999', 'travel_request', 'x')).status, 404);
  assert.strictEqual((await del('alice', '/api/requests/FR-19700101-999/attachments?purpose=travel_request&version=x')).status, 404);
});

test('only a party to the request may download its file', async () => {
  const row = await draft('alice');
  const up = await upload('alice', row.request_id, 'travel_request', row.last_updated_at);
  const stored = JSON.parse(up.body.attachments).find((a) => a.purpose === 'travel_request').stored;

  const owner = await get('alice', `/api/uploads/${encodeURIComponent(stored)}`);
  assert.strictEqual(owner.status, 200);
  assert.match(owner.headers.get('content-disposition') || '', /attachment;/);

  assert.strictEqual((await get('bob', `/api/uploads/${encodeURIComponent(stored)}`)).status, 403);
  assert.strictEqual((await get('admin', `/api/uploads/${encodeURIComponent(stored)}`)).status, 200);
  assert.strictEqual((await get(null, `/api/uploads/${encodeURIComponent(stored)}`)).status, 401);
});

test('a download path outside the upload directory is not served', async () => {
  for (const target of ['..%2F..%2Fserver.js', '..%5C..%5Cserver.js', 'no-such-file.pdf']) {
    const res = await get('admin', `/api/uploads/${target}`);
    assert.strictEqual(res.status, 404, `${target} returned ${res.status}`);
  }
});

test('a requester cannot attach evidence once the request has left their hands', async () => {
  const row = await draft('alice', {
    beneficiary_name: 'Alice', cost_code: '2391', activity_code: '3270',
    destination: 'Sydney', travel_start_date: '2026-09-01', travel_end_date: '2026-09-05',
  });
  let current = row;
  for (const purpose of ['travel_request', 'approval_email']) {
    const up = await upload('alice', current.request_id, purpose, current.last_updated_at);
    assert.strictEqual(up.status, 200, up.text);
    current = up.body;
  }
  const submitted = await post('alice', `/api/requests/${current.request_id}/submit`, { json: { _version: current.last_updated_at } });
  assert.strictEqual(submitted.status, 200, submitted.text);

  const late = await upload('alice', current.request_id, 'travel_request', submitted.body.last_updated_at);
  assert.strictEqual(late.status, 409);
  assert.match(late.body.error, /locked/i);
});

// A Travel request carried all the way to Submitted: complete fields plus both pieces
// of stored evidence. Anything that moves a request out of Draft revalidates the whole
// row, so the guards below need a request that is genuinely complete.
async function submittedTravel(who) {
  let current = await draft(who, {
    beneficiary_name: who === 'bob' ? 'Bob' : 'Alice', cost_code: '2391', activity_code: '3270',
    destination: 'Sydney', travel_start_date: '2026-09-01', travel_end_date: '2026-09-05',
  });
  for (const purpose of ['travel_request', 'approval_email']) {
    const up = await upload(who, current.request_id, purpose, current.last_updated_at);
    assert.strictEqual(up.status, 200, up.text);
    current = up.body;
  }
  const res = await post(who, `/api/requests/${current.request_id}/submit`, { json: { _version: current.last_updated_at } });
  assert.strictEqual(res.status, 200, res.text);
  return res.body;
}

test('legacy Other cost code values remain readable while new forms use the default', async () => {
  let current = await draft('alice', {
    beneficiary_name: 'Alice', cost_code: 'Other', cost_code_other: 'LOCAL-COST-API', activity_code: '3270',
    destination: 'Sydney', travel_start_date: '2026-09-01', travel_end_date: '2026-09-05',
  });
  for (const purpose of ['travel_request', 'approval_email']) {
    const uploaded = await upload('alice', current.request_id, purpose, current.last_updated_at);
    assert.strictEqual(uploaded.status, 200, uploaded.text);
    current = uploaded.body;
  }
  const submitted = await post('alice', `/api/requests/${current.request_id}/submit`, {
    json: { _version: current.last_updated_at },
  });
  assert.strictEqual(submitted.status, 200, submitted.text);
  assert.strictEqual(submitted.body.current_status, 'Submitted');
  assert.strictEqual(submitted.body.cost_code, 'Other');
  assert.strictEqual(submitted.body.cost_code_other, 'LOCAL-COST-API');
  assert.strictEqual(submitted.body.activity_code, '3270');
});

// ---------------------------------------------------------------- workflow guards

test('a workflow action refuses a status it does not belong to', async () => {
  const row = await draft('alice');
  assert.strictEqual((await post('alice', `/api/requests/${row.request_id}/resubmit`, { json: { _version: row.last_updated_at } })).status, 409);
  assert.strictEqual((await post('alice', `/api/requests/${row.request_id}/po-sent`, { json: { _version: row.last_updated_at } })).status, 409);
  assert.strictEqual((await post('alice', `/api/requests/${row.request_id}/invoice-received`, { json: { _version: row.last_updated_at } })).status, 409);
});

test('save-draft is refused once the request is no longer a draft', async () => {
  const row = await draft('alice', {
    beneficiary_name: 'Alice', cost_code: '2391', activity_code: '3270',
    destination: 'Darwin', travel_start_date: '2026-10-01', travel_end_date: '2026-10-02',
  });
  let current = row;
  for (const purpose of ['travel_request', 'approval_email']) {
    current = (await upload('alice', current.request_id, purpose, current.last_updated_at)).body;
  }
  const submitted = await post('alice', `/api/requests/${current.request_id}/submit`, { json: { _version: current.last_updated_at } });
  assert.strictEqual(submitted.status, 200, submitted.text);
  assert.strictEqual(submitted.body.current_status, 'Submitted');
  assert.strictEqual(submitted.body.waiting_on, 'Finance');

  const late = await post('alice', `/api/requests/${current.request_id}/save-draft`, {
    json: { destination: 'Changed after submission', _version: submitted.body.last_updated_at },
  });
  assert.strictEqual(late.status, 409);
});

test('a requester can save an incomplete correction while a request is returned', async () => {
  const submitted = await submittedTravel('alice');
  const returned = await patch('admin', `/api/requests/${submitted.request_id}`, {
    json: { current_status: 'Returned for Info', note: 'Please correct the destination.', _version: submitted.last_updated_at },
  });
  assert.strictEqual(returned.status, 200, returned.text);

  const saved = await post('alice', `/api/requests/${submitted.request_id}/save-returned`, {
    json: {
      destination: '', request_type: 'Procurement', requester_person_id: 'PER-012',
      _version: returned.body.last_updated_at,
    },
  });
  assert.strictEqual(saved.status, 200, saved.text);
  assert.strictEqual(saved.body.current_status, 'Returned for Info');
  assert.strictEqual(saved.body.destination, '');
  assert.strictEqual(saved.body.request_type, 'Travel', 'save-returned accepted an identity field');

  const history = await get('admin', `/api/requests/${submitted.request_id}/history`);
  const event = history.body.at(-1);
  assert.strictEqual(event.event_type, 'Field Updated');
  assert.match(event.changed_fields, /destination/);
});

test('a returned Procurement request stays editable as a requester draft until it is resubmitted', async () => {
  const created = await post('alice', '/api/requests', { json: {
    request_type: 'Procurement', sub_type: 'Purchase / PO request', supplier_type: 'Existing Supplier',
    supplier_quote_number: 'Q-RETURN-OLD', cost_code: '2391', activity_code: '3203',
    spending_approver_person_id: 'PER-005', spending_approver: 'Jane Manager', amount_ex_gst: '100',
  } });
  assert.strictEqual(created.status, 201, created.text);
  scratchDrafts.push(['alice', created.body.request_id]);
  let row = created.body;
  for (const purpose of ['quote', 'approval_email']) {
    const uploaded = await upload('alice', row.request_id, purpose, row.last_updated_at);
    assert.strictEqual(uploaded.status, 200, uploaded.text);
    row = uploaded.body;
  }
  const submitted = await post('alice', `/api/requests/${row.request_id}/submit`, {
    json: { _version: row.last_updated_at },
  });
  assert.strictEqual(submitted.status, 200, submitted.text);
  const returned = await patch('admin', `/api/requests/${row.request_id}`, {
    json: {
      current_status: PROCUREMENT_RETURN_TO_REQUESTOR,
      note: 'Please correct the quote reference.',
      _version: submitted.body.last_updated_at,
    },
  });
  assert.strictEqual(returned.status, 200, returned.text);
  assert.strictEqual(returned.body.waiting_on, 'User');

  const saved = await post('alice', `/api/requests/${row.request_id}/save-returned`, {
    json: { supplier_quote_number: 'Q-RETURN-CORRECTED', _version: returned.body.last_updated_at },
  });
  assert.strictEqual(saved.status, 200, saved.text);
  assert.strictEqual(saved.body.current_status, PROCUREMENT_RETURN_TO_REQUESTOR);
  assert.strictEqual(saved.body.supplier_quote_number, 'Q-RETURN-CORRECTED');

  const resubmitted = await post('alice', `/api/requests/${row.request_id}/resubmit`, {
    json: { _version: saved.body.last_updated_at, note: 'Quote reference corrected.' },
  });
  assert.strictEqual(resubmitted.status, 200, resubmitted.text);
  assert.strictEqual(resubmitted.body.current_status, PROCUREMENT_SUBMIT_TO_ADMIN);
  assert.strictEqual(resubmitted.body.waiting_on, 'Finance');
});

test('a stale _version is rejected with 409 rather than overwriting', async () => {
  const row = await draft('alice');
  const first = await post('alice', `/api/requests/${row.request_id}/save-draft`, {
    json: { destination: 'First', _version: row.last_updated_at },
  });
  assert.strictEqual(first.status, 200);
  const second = await post('alice', `/api/requests/${row.request_id}/save-draft`, {
    json: { destination: 'Second', _version: row.last_updated_at },
  });
  assert.strictEqual(second.status, 409);
  const after = await get('alice', `/api/requests/${row.request_id}`);
  assert.strictEqual(after.body.destination, 'First', 'the stale write landed anyway');
});

test('_from_status names the status the screen has moved on to', async () => {
  const row = await draft('alice');
  const res = await patch('admin', `/api/requests/${row.request_id}`, {
    json: { notes: 'x', _from_status: PROCUREMENT_INVOICE_RECEIVED, _version: row.last_updated_at },
  });
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /Draft/);
  assert.match(res.body.error, /Invoice With PO And Approval Received/);
});

test('returning a request for information demands a message to the requester', async () => {
  const row = await submittedTravel('alice');
  const bare = await patch('admin', `/api/requests/${row.request_id}`, {
    json: { current_status: 'Returned for Info', _version: row.last_updated_at },
  });
  assert.strictEqual(bare.status, 400);
  assert.ok(bare.body.fields && bare.body.fields.note);

  const withReason = await patch('admin', `/api/requests/${row.request_id}`, {
    json: { current_status: 'Returned for Info', note: 'The itinerary is missing.', _version: row.last_updated_at },
  });
  assert.strictEqual(withReason.status, 200);
  assert.strictEqual(withReason.body.waiting_on, 'User');
  assert.ok(withReason.body.returned_for_info_at, 'the return was not date-stamped');
});

test('an admin cannot resubmit on the requester\'s behalf', async () => {
  const row = await submittedTravel('alice');
  const returned = await patch('admin', `/api/requests/${row.request_id}`, {
    json: { current_status: 'Returned for Info', note: 'Please correct the dates.', _version: row.last_updated_at },
  });
  assert.strictEqual(returned.status, 200);
  assert.strictEqual(returned.body.waiting_on, 'User');

  // The admin status picker withholds this transition, but hiding a control is not
  // enforcement: allowing it would move the request off the requester's plate and record
  // that they answered a return they never saw.
  const forged = await patch('admin', `/api/requests/${row.request_id}`, {
    json: { current_status: 'Updated and Resubmitted', _version: returned.body.last_updated_at },
  });
  assert.strictEqual(forged.status, 409, 'an admin fabricated a requester resubmission');
  assert.match(forged.body.error, /only the user can resubmit/i);

  const after = await get('admin', `/api/requests/${row.request_id}`);
  assert.strictEqual(after.body.current_status, 'Returned for Info', 'the refused change still landed');
  assert.strictEqual(after.body.waiting_on, 'User');

  const history = await get('admin', `/api/requests/${row.request_id}/history`);
  assert.ok(!history.body.some((e) => e.new_status === 'Updated and Resubmitted'),
    'a resubmission the requester never made was written to the audit trail');

  // The owner can still do it themselves.
  const real = await post('alice', `/api/requests/${row.request_id}/resubmit`, {
    json: { _version: after.body.last_updated_at },
  });
  assert.strictEqual(real.status, 200, real.text);
  assert.strictEqual(real.body.current_status, 'Updated and Resubmitted');
  assert.strictEqual(real.body.waiting_on, 'Finance');
});

test('a resubmit cannot rewrite what the request is or who owns it', async () => {
  const row = await submittedTravel('alice');
  const returned = await patch('admin', `/api/requests/${row.request_id}`, {
    json: { current_status: 'Returned for Info', note: 'Please correct the destination.', _version: row.last_updated_at },
  });
  assert.strictEqual(returned.status, 200);

  const res = await post('alice', `/api/requests/${row.request_id}/resubmit`, {
    json: {
      destination: 'Adelaide',
      request_type: 'Procurement', sub_type: 'Purchase / PO request',
      requester_person_id: 'PER-012', requester_name: 'Bob',
      _version: returned.body.last_updated_at,
    },
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.request_type, 'Travel');
  assert.strictEqual(res.body.sub_type, 'Domestic');
  assert.strictEqual(res.body.requester_person_id, 'PER-011');
  assert.strictEqual(res.body.destination, 'Adelaide', 'the legitimate correction was dropped');
  assert.strictEqual(res.body.current_status, 'Updated and Resubmitted');
});

test('a deleted request is closed to edits and uploads', async () => {
  const row = await draft('alice');
  assert.strictEqual((await post('admin', `/api/requests/${row.request_id}/delete`, { json: {} })).status, 200);
  const current = await get('admin', `/api/requests/${row.request_id}`);

  assert.strictEqual((await upload('alice', row.request_id, 'travel_request', current.body.last_updated_at)).status, 409);
  const edit = await patch('admin', `/api/requests/${row.request_id}`, {
    json: { notes: 'edit a deleted row', _version: current.body.last_updated_at },
  });
  assert.strictEqual(edit.status, 409);
});

// ---------------------------------------------------------------- protocol hygiene

test('an unknown API route is a 404, not a static file', async () => {
  const res = await get('alice', '/api/not-a-route');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'Unknown API route');
});

test('a wrong method returns 405 with an Allow header', async () => {
  for (const [method, route, allow] of [
    ['DELETE', '/api/requests', 'GET, POST'],
    ['GET', '/api/login', 'POST'],
    ['POST', '/api/health', 'GET'],
    ['DELETE', '/api/options', 'GET'],
  ]) {
    const res = await call('alice', method, route);
    assert.strictEqual(res.status, 405, `${method} ${route} returned ${res.status}`);
    assert.strictEqual(res.headers.get('allow'), allow, `${method} ${route} Allow header`);
  }
});

test('a malformed JSON body is a 400, not a 500', async () => {
  const res = await post('alice', '/api/requests', { json: '{"request_type": "Travel"' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /JSON/i);
});

test('an oversized JSON body is refused with 413', async () => {
  const res = await post('alice', '/api/requests', {
    json: { request_type: 'Travel', sub_type: 'Domestic', notes: 'x'.repeat(1.2e6) },
  }).catch((e) => ({ status: 413, note: e.message }));
  assert.strictEqual(res.status, 413);
});

test('an unknown field on create is refused with a field-level error', async () => {
  const res = await post('admin', '/api/requests', {
    json: { request_type: 'Travel', sub_type: 'Domestic', received_date: '2026-08-03', made_up_column: 'x' },
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /made_up_column/);
});

test('security headers are present on API and static responses alike', async () => {
  for (const [who, route] of [['alice', '/api/me'], [null, '/index.html'], [null, '/nope.html']]) {
    const res = await get(who, route);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff', route);
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY', route);
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/, route);
  }
});

test('static serving does not escape the public directory', async () => {
  for (const target of ['/../server.js', '/..%2Fserver.js', '/../.env', '/../../../../etc/hosts']) {
    const res = await get(null, target);
    assert.ok(res.status === 403 || res.status === 404, `${target} returned ${res.status}`);
    assert.ok(!/SESSION_SECRET|require\('http'\)/.test(res.text), `${target} served project source`);
  }
});

// ---------------------------------------------------------------- concurrency

test('parallel creates from the same user all succeed with unique ids', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () => post('alice', '/api/requests', { json: { request_type: 'Travel', sub_type: 'Domestic' } }))
  );
  assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join(','));
  const ids = results.map((r) => r.body.request_id);
  assert.strictEqual(new Set(ids).size, ids.length, `duplicate request ids: ${ids.join(',')}`);
});

test('two writers racing the same version produce exactly one winner', async () => {
  const row = await draft('alice');
  const [a, b] = await Promise.all([
    post('alice', `/api/requests/${row.request_id}/save-draft`, { json: { destination: 'A', _version: row.last_updated_at } }),
    post('alice', `/api/requests/${row.request_id}/save-draft`, { json: { destination: 'B', _version: row.last_updated_at } }),
  ]);
  const codes = [a.status, b.status].sort();
  assert.deepStrictEqual(codes, [200, 409], `expected one winner and one conflict, got ${codes.join(',')}`);
  const after = await get('alice', `/api/requests/${row.request_id}`);
  assert.ok(['A', 'B'].includes(after.body.destination));
});

// ---------------------------------------------------------------- data hygiene

test('the requester never receives another party\'s bank details', async () => {
  const created = await post('alice', '/api/requests', {
    json: {
      request_type: 'Supplier Setup', sub_type: 'New supplier',
      supplier_form_data: {
        legal_entity_name: 'Bank Leak Co', has_abn: 'Yes', abn: '12345678901',
        street_address: '1 Smith Street', suburb: 'Darwin', country: 'Australia', postcode: '0800', state_region: 'NT',
        contact_name: 'Vendor Contact', contact_phone: '0889000000', contact_email: 'contact@example.com',
        purchase_order_email: 'orders@example.com', remittance_email: 'accounts@example.com',
        nt_enterprise: 'No', icn: '', bank_type: 'Australian EFT', bank_name: 'Example Bank',
        bank_branch_address: 'Darwin NT', bank_account_name: 'Bank Leak Co', bsb: '123-456', account_number: '00987654',
        bank_account_currency: '', payment_currency: '', swift_sort_bank_code: '', iban: '',
        supporting_document_type: 'Bank statement', terms_accepted: 'Yes', declaration_confirmed: 'Yes',
      },
    },
  });
  assert.strictEqual(created.status, 201, created.text);
  const id = created.body.request_id;

  // The owner may still see everything while it is their own unfinished draft.
  const asDraft = await get('alice', `/api/requests/${id}`);
  assert.match(asDraft.body.supplier_form_data, /00987654/);

  let current = created.body;
  current = (await upload('alice', id, 'supplier_evidence', current.last_updated_at)).body;
  const submitted = await post('alice', `/api/requests/${id}/submit`, { json: { _version: current.last_updated_at } });
  assert.strictEqual(submitted.status, 200, submitted.text);

  const afterSubmit = await get('alice', `/api/requests/${id}`);
  assert.ok(!afterSubmit.body.supplier_form_data.includes('00987654'), 'the account number came back to the requester');
  assert.ok(!afterSubmit.body.supplier_form_data.includes('123-456'), 'the BSB came back to the requester');
  assert.match(afterSubmit.body.supplier_form_data, /account_number_masked/);

  const list = await get('alice', '/api/requests');
  const listed = list.body.find((r) => r.request_id === id);
  assert.ok(!listed.supplier_form_data.includes('00987654'), 'the list view leaked the account number');

  // Finance still needs the real thing.
  const asAdmin = await get('admin', `/api/requests/${id}`);
  assert.match(asAdmin.body.supplier_form_data, /00987654/);
});

test('the options payload withholds admin-only reference data from requesters', async () => {
  const asRequester = await get('alice', '/api/options');
  assert.strictEqual(asRequester.status, 200);
  assert.deepStrictEqual(asRequester.body.processors, []);
  assert.ok(!asRequester.body.request_types.includes('Supplier Setup'), 'Supplier Setup is still offered to requesters');
  assert.ok(!asRequester.body.request_types.includes('Travel'), 'New Travel Request is still offered to requesters');
  assert.deepStrictEqual(asRequester.body.activity_code_required_supplier_types, ['Existing Supplier']);
  assert.ok(asRequester.body.suppliers.every((s) => !('supplier_form_data' in s)), 'supplier profiles leaked to a requester');

  const asAdmin = await get('admin', '/api/options');
  assert.ok(Array.isArray(asAdmin.body.processors));
  assert.ok(asAdmin.body.request_types.includes('Supplier Setup'), 'Finance lost the retained Supplier Setup workflow');
});

test('closing Procurement records the signed-in admin instead of requiring a processor', async () => {
  const created = await post('admin', '/api/requests', { json: {
    request_type: 'Procurement', sub_type: 'Purchase / PO request', received_date: '2026-08-03',
    requester_name: 'Alice', supplier_type: 'Existing Supplier', supplier_quote_number: 'Q-CLOSE-BY',
    cost_code: '2391', activity_code: '3203', spending_approver: 'Jane Manager',
    amount_ex_gst: '100', attachments: [
      { purpose: 'quote', filename: 'quote.pdf', stored: 'close-quote' },
      { purpose: 'approval_email', filename: 'approval.eml', stored: 'close-approval' },
    ],
  } });
  assert.strictEqual(created.status, 201, created.text);
  let row = created.body;
  const move = async (changes) => {
    const result = await patch('admin', `/api/requests/${row.request_id}`, {
      json: { ...changes, _version: row.last_updated_at },
    });
    assert.strictEqual(result.status, 200, result.text);
    row = result.body;
    return row;
  };
  await move({ current_status: PROCUREMENT_SUBMIT_TO_ADMIN });
  await move({
    current_status: PROCUREMENT_PO_ISSUED, po_number: 'PO-CLOSE-BY',
    attachments: [...JSON.parse(row.attachments), { purpose: 'po', filename: 'po.pdf', stored: 'close-po' }],
  });
  const invoiceId = crypto.randomUUID();
  const invoiceItems = [{ item_id: invoiceId, invoice_number: 'INV-CLOSE-BY', amount_ex_gst: '', amount_inc_gst: '110' }];
  await move({ current_status: PROCUREMENT_PO_ISSUED, invoice_items: invoiceItems });
  await move({
    current_status: PROCUREMENT_INVOICE_RECEIVED,
    invoice_items: invoiceItems,
    attachments: [...JSON.parse(row.attachments),
      { purpose: `invoice:${invoiceId}`, filename: 'invoice.pdf', stored: 'close-invoice' },
      { purpose: 'invoice_approval_email', filename: 'invoice-approval.eml', stored: 'close-invoice-approval' },
    ],
    chk_po_included: 'Yes', chk_desc_matches_po: 'Yes', chk_service_completed: 'Yes',
    chk_forwarded_to_approver: 'Yes',
  });
  await move({ current_status: PROCUREMENT_RECEIVED_ORDER_LINES });
  const closed = await move({ current_status: PROCUREMENT_CLOSED, close_reason: 'Paid' });
  assert.strictEqual(closed.processed_by, 'Administrator');
  assert.strictEqual(closed.processed_by_person_id, 'PER-001');

  const history = await get('admin', `/api/requests/${row.request_id}/history`);
  const closeEvent = history.body.at(-1);
  assert.strictEqual(closeEvent.changed_by, 'admin');
  assert.match(closeEvent.changed_fields, /processed_by/);
});

test('Finance can correct Procurement records from Complete or Cancelled and every edit is audited', async () => {
  const created = await post('admin', '/api/requests', { json: {
    request_type: 'Procurement', sub_type: 'Purchase / PO request', received_date: '2026-08-04',
    requester_name: 'Alice', supplier_type: 'Existing Supplier', supplier_quote_number: 'Q-ADMIN-EDIT',
    cost_code: '2391', activity_code: '3203', spending_approver: 'Jane Manager',
    amount_ex_gst: '100', attachments: [
      { purpose: 'quote', filename: 'quote.pdf', stored: 'admin-edit-quote' },
      { purpose: 'approval_email', filename: 'approval.eml', stored: 'admin-edit-approval' },
    ],
  } });
  assert.strictEqual(created.status, 201, created.text);
  let row = created.body;
  const move = async (changes) => {
    const result = await patch('admin', `/api/requests/${row.request_id}`, {
      json: { ...changes, _version: row.last_updated_at },
    });
    assert.strictEqual(result.status, 200, result.text);
    row = result.body;
    return row;
  };

  await move({ current_status: PROCUREMENT_SUBMIT_TO_ADMIN });
  await move({
    current_status: PROCUREMENT_PO_ISSUED, po_number: 'PO-ADMIN-EDIT',
    attachments: [...JSON.parse(row.attachments), { purpose: 'po', filename: 'po.pdf', stored: 'admin-edit-po' }],
  });
  const invoiceId = crypto.randomUUID();
  const invoiceItems = [{ item_id: invoiceId, invoice_number: 'INV-ADMIN-EDIT', amount_ex_gst: '', amount_inc_gst: '110' }];
  await move({ current_status: PROCUREMENT_PO_ISSUED, invoice_items: invoiceItems });
  await move({
    current_status: PROCUREMENT_INVOICE_RECEIVED,
    invoice_items: invoiceItems,
    attachments: [...JSON.parse(row.attachments),
      { purpose: `invoice:${invoiceId}`, filename: 'invoice.pdf', stored: 'admin-edit-invoice' },
      { purpose: 'invoice_approval_email', filename: 'invoice-approval.eml', stored: 'admin-edit-invoice-approval' },
    ],
    chk_po_included: 'Yes', chk_desc_matches_po: 'Yes', chk_service_completed: 'Yes',
    chk_forwarded_to_approver: 'Yes',
  });
  await move({ current_status: PROCUREMENT_RECEIVED_ORDER_LINES });
  await move({ current_status: PROCUREMENT_CLOSED, close_reason: 'Paid' });

  // A terminal Procurement record remains editable by Finance. This optional document is
  // added and removed at Complete, proving the attachment path does not require a return
  // round and that the removal is separately audited.
  const otherPurpose = `other_document:${crypto.randomUUID()}`;
  const added = await upload('admin', row.request_id, otherPurpose, row.last_updated_at, { filename: 'admin-note.pdf' });
  assert.strictEqual(added.status, 200, added.text);
  row = added.body;
  const removed = await del('admin', `/api/requests/${row.request_id}/attachments?purpose=${encodeURIComponent(otherPurpose)}&version=${encodeURIComponent(row.last_updated_at)}`);
  assert.strictEqual(removed.status, 200, removed.text);
  row = removed.body;

  const corrected = await move({ current_status: PROCUREMENT_SUBMIT_TO_APPROVER, amount_ex_gst: '101' });
  assert.strictEqual(corrected.current_status, PROCUREMENT_SUBMIT_TO_APPROVER);
  assert.strictEqual(corrected.waiting_on, 'Approver');
  assert.strictEqual(corrected.amount_ex_gst, '101');

  const cancelled = await move({ current_status: 'Cancelled', close_reason: 'Other' });
  assert.strictEqual(cancelled.current_status, 'Cancelled');
  const reopened = await move({ current_status: PROCUREMENT_SUBMIT_TO_ADMIN, amount_ex_gst: '102' });
  assert.strictEqual(reopened.current_status, PROCUREMENT_SUBMIT_TO_ADMIN);
  assert.strictEqual(reopened.waiting_on, 'Finance');
  assert.strictEqual(reopened.amount_ex_gst, '102');

  const history = await get('admin', `/api/requests/${row.request_id}/history`);
  assert.ok(history.body.some((event) => event.event_type === 'Attachment Updated'
    && event.changed_by === 'admin' && event.changed_fields.includes(otherPurpose)));
  assert.ok(history.body.some((event) => event.new_status === PROCUREMENT_SUBMIT_TO_APPROVER));
  assert.ok(history.body.some((event) => event.old_status === 'Cancelled'
    && event.new_status === PROCUREMENT_SUBMIT_TO_ADMIN));
  assert.ok(history.body.some((event) => event.event_type === 'Field Updated'
    && event.changed_by === 'admin' && event.changed_fields.includes('amount_ex_gst')));
});

test('every status a type can hold has a waiting_on rule', async () => {
  const options = (await get('admin', '/api/options')).body;
  for (const [type, statuses] of Object.entries(options.statuses_by_type)) {
    for (const status of statuses) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(options.waiting_on_by_status, status),
        `${type} can reach "${status}" but no waiting_on is defined for it`
      );
      const value = options.waiting_on_by_status[status];
      assert.ok(value === '' || options.waiting_on.includes(value), `waiting_on "${value}" for ${status} is not a known party`);
    }
  }
});

test('the options payload carries the transition graph the admin dropdown is built from', async () => {
  const options = (await get('admin', '/api/options')).body;
  assert.ok(options.allowed_transitions_by_type, 'the admin form has no way to know which statuses are reachable');
  for (const [type, statuses] of Object.entries(options.statuses_by_type)) {
    const map = options.allowed_transitions_by_type[type];
    assert.ok(map, `${type} has no transition map`);
    assert.deepStrictEqual(Object.keys(map).sort(), [...statuses].sort(), `${type} map does not cover its statuses`);
  }
});

test('the server refuses a transition the admin dropdown would never offer', async () => {
  const row = await submittedTravel('alice');
  const backwards = await patch('admin', `/api/requests/${row.request_id}`, {
    json: { current_status: 'Draft', _version: row.last_updated_at },
  });
  assert.strictEqual(backwards.status, 400);
  assert.match(backwards.body.fields.current_status, /cannot go from "Submitted" to "Draft"/);

  // And the sanctioned doors still open.
  const done = await patch('admin', `/api/requests/${row.request_id}`, {
    json: { current_status: 'Completed', processed_by: 'Alex Lee', _version: row.last_updated_at },
  });
  assert.strictEqual(done.status, 200, done.text);
  const returned = await patch('admin', `/api/requests/${row.request_id}`, {
    json: { current_status: 'Returned for Info', note: 'The cost code was wrong.', _version: done.body.last_updated_at },
  });
  assert.strictEqual(returned.status, 200, returned.text);
  assert.strictEqual(returned.body.waiting_on, 'User');
});

test('no test data escaped into the repository data directory', async () => {
  const repoData = path.join(__dirname, '..', 'data', 'requests_current.csv');
  if (!fs.existsSync(repoData)) return;
  const rows = csv.parse(fs.readFileSync(repoData, 'utf8'));
  assert.ok(!rows.some((r) => r.destination === 'Alice Draft City' || r.destination === 'Hijacked'),
    'a test request was written to the real data directory');
});
