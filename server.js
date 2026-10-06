'use strict';

// Load .env before anything reads process.env. This used to happen only as a side effect
// of db/dbConfig being pulled in by the SQL backend, so the CSV backend never saw .env at
// all and SESSION_SECRET silently went missing.
require('./lib/env');
const runtimeConfig = require('./lib/runtimeConfig');
try {
  runtimeConfig.assertApplicationTarget();
} catch (err) {
  console.error('Refusing to start:', err.message);
  process.exit(1);
}

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const { StagingQueue } = require('./lib/stagingQueue');
const auth = require('./lib/auth');
const { searchFinanceKnowledge } = require('./lib/knowledgeBase');
const { decideTurn } = require('./lib/turnTaking');
const openaiAssistant = require('./lib/openaiAssistant');
const { createDemoMcpHttpServer } = require('./mcp/httpServer');
const demoMcpHttp = createDemoMcpHttpServer();
const {
  REQUEST_TYPES,
  STATUSES,
  STATUSES_BY_TYPE,
  ALLOWED_TRANSITIONS_BY_TYPE,
  SUBTYPES_BY_TYPE,
  REQUESTER_SUBTYPES,
  REQUIRED_BY_SUBTYPE, ACTIVITY_CODE_REQUIRED_SUPPLIER_TYPES,
  WAITING_ON,
  WAITING_ON_BY_STATUS,
  REIMBURSEMENT_CATEGORIES,
  MAX_REIMBURSEMENT_ITEMS,
  MAX_INVOICE_ITEMS,
  REQUIRED_ATTACHMENTS_BY_SUBTYPE,
  ALLOWED_ATTACHMENTS_BY_SUBTYPE,
  ATTACHMENT_LABELS,
  ADMIN_ONLY_ATTACHMENT_PURPOSES,
  STAGE_COLLECTED_ATTACHMENT_PURPOSES,
  PROCUREMENT_TYPE,
  SUPPLIER_SETUP_TYPE,
  TRAVEL_TYPE,
  PROCUREMENT_SUBMIT_TO_ADMIN,
  PROCUREMENT_RETURN_TO_REQUESTOR,
  PROCUREMENT_PO_ISSUED,
  PROCUREMENT_INVOICE_RECEIVED,
  PROCUREMENT_CLOSED,
  UPDATED_AND_RESUBMITTED,
} = require('./lib/constants');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml; charset=utf-8',
};

const MAX_BODY_BYTES = 1e6; // 1 MB (JSON)
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB per attachment
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
// Allow-list, not a deny-list: attachments are quotes, invoices, receipts, approval
// emails and supporting documents, so the set of legitimate types is small and closed.
// A deny-list is always one extension behind (.xhtml, .shtml, .mhtml, .jar all slipped
// through the old one).
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic',
  '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.msg', '.eml',
]);
// Uploaded file bytes live on the filesystem (both backends); metadata lives on the
// request's attachments field. Path is fixed and server-generated (no traversal).
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const STAGING_DIR = process.env.STAGING_DIR
  ? path.resolve(process.env.STAGING_DIR)
  : process.env.DATA_DIR ? path.join(path.resolve(process.env.DATA_DIR), 'staging') : path.join(__dirname, 'staging');
const stagingQueue = new StagingQueue(STAGING_DIR);

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

let storageReady = store.backend !== 'sql';
let storageInitError = '';
let stagingWorkerBusy = false;

// Baseline security headers applied to every response. The app is fully same-origin
// (no CDNs), so a strict CSP costs nothing and blocks injected external/inline scripts.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// Secure by default in production; COOKIE_SECURE overrides either way for the odd
// deployment that terminates TLS somewhere this process cannot see. Defaulting to
// "off unless someone remembered to switch it on" put session cookies on the wire.
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';

// ---- login throttling ----
// In-memory and per-process. Behind several SQL-backed containers an attacker gets one
// bucket per container, which still cuts the achievable guess rate by orders of
// magnitude; a shared store is the next step if this ever has to be a hard guarantee.
//
// Counted per username *and* per source address: per-username alone is bypassed by
// spraying one password across many accounts, per-address alone would let one person's
// typos lock out everybody behind the same corporate NAT. Both windows self-heal, so a
// failed login can slow an account down but never locks it out permanently.
// Well-formed but unmatchable: lets an unknown username cost exactly as much scrypt time
// as a known one, so response timing stops being a user-enumeration oracle.
const DUMMY_PASSWORD_HASH = crypto.randomBytes(16).toString('hex') + ':' + crypto.randomBytes(32).toString('hex');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = { user: 10, addr: 50 };
const loginFailures = new Map(); // key -> { count, expiresAt }

function loginKeys(req, username) {
  const addr = req.socket.remoteAddress || 'unknown';
  return [['user', `user:${String(username).toLowerCase()}`], ['addr', `addr:${addr}`]];
}

// An attacker rotating usernames would otherwise grow this map without bound.
function pruneLoginFailures(now) {
  for (const [key, entry] of loginFailures) if (now >= entry.expiresAt) loginFailures.delete(key);
}

// Milliseconds until the caller may try again, or 0 if they may try now.
function loginRetryAfterMs(req, username, now) {
  let wait = 0;
  for (const [kind, key] of loginKeys(req, username)) {
    const entry = loginFailures.get(key);
    if (!entry || now >= entry.expiresAt) continue;
    if (entry.count >= LOGIN_MAX_FAILURES[kind]) wait = Math.max(wait, entry.expiresAt - now);
  }
  return wait;
}

function recordLoginFailure(req, username, now) {
  if (loginFailures.size > 1000) pruneLoginFailures(now);
  for (const [, key] of loginKeys(req, username)) {
    const entry = loginFailures.get(key);
    if (!entry || now >= entry.expiresAt) loginFailures.set(key, { count: 1, expiresAt: now + LOGIN_WINDOW_MS });
    else entry.count += 1;
  }
}

// Only the username bucket. A successful sign-in proves that one credential is good, not
// that the source address is benign — clearing the address bucket too would let an
// attacker holding any single valid account reset the spray counter at will.
function clearLoginFailures(req, username) {
  loginFailures.delete(`user:${String(username).toLowerCase()}`);
}

// ---- registration throttling ----
// Registration is open to anyone with an address in the allowed domain, so this endpoint
// is the one place an anonymous caller can create rows — a person, an account, and with
// it a fresh draft quota and attachment budget. Counted per source address on every
// attempt, not just failures: the successful ones are the expensive ones.
// Deliberately loose. Everyone at PolyU may leave the network through one address, so a
// tight per-address cap would turn "a team signed up this morning" into an outage. It is
// sized to stop a script, not to ration a rollout.
const REGISTER_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_MAX_PER_ADDR = 20;
const registerAttempts = new Map(); // addr -> { count, expiresAt }

function registerRetryAfterMs(req, now) {
  const entry = registerAttempts.get(req.socket.remoteAddress || 'unknown');
  if (!entry || now >= entry.expiresAt || entry.count < REGISTER_MAX_PER_ADDR) return 0;
  return entry.expiresAt - now;
}

function recordRegisterAttempt(req, now) {
  const key = req.socket.remoteAddress || 'unknown';
  if (registerAttempts.size > 1000) {
    for (const [addr, entry] of registerAttempts) if (now >= entry.expiresAt) registerAttempts.delete(addr);
  }
  const entry = registerAttempts.get(key);
  if (!entry || now >= entry.expiresAt) registerAttempts.set(key, { count: 1, expiresAt: now + REGISTER_WINDOW_MS });
  else entry.count += 1;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function requesterSafeRequest(row) {
  if (!row || row.request_type !== SUPPLIER_SETUP_TYPE) return row;
  // Owners must be able to resume every field of their own unfinished draft.
  if (row.current_status === 'Draft') return row;
  const safe = { ...row };
  let data = {};
  try { data = JSON.parse(String(row.supplier_form_data || '{}')); } catch (e) { data = {}; }
  const account = String(data.account_number || '');
  const hidden = ['bank_branch_address', 'bsb', 'account_number', 'swift_sort_bank_code', 'iban', 'bank_details_source_request_id'];
  for (const field of hidden) delete data[field];
  if (account) data.account_number_masked = `•••• ${account.slice(-4)}`;
  if (account) data.bank_details_action = 'Unchanged';
  safe.supplier_form_data = JSON.stringify(data);
  return safe;
}

function requestResponse(req, row) {
  return isAdmin(req) ? row : requesterSafeRequest(row);
}

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    // Buffers, not string concatenation: `data += chunk` decodes each chunk on its own,
    // so a multi-byte character split across a chunk boundary is destroyed, and the cap
    // would count UTF-16 code units rather than the bytes it claims to count.
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Respond 413 immediately, then stop reading and tear the request down once
        // the response has flushed (destroying earlier races the 413 to the client).
        aborted = true;
        sendJson(res, 413, { error: 'Payload too large' });
        res.on('finish', () => req.destroy());
        reject(new store.StoreError('Payload too large', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new store.StoreError('Invalid JSON body', 400));
      }
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

// Read a raw binary body (file upload), capped at maxBytes.
function readRawBody(req, res, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        sendJson(res, 413, { error: 'Upload too large' });
        res.on('finish', () => req.destroy());
        reject(new store.StoreError('Upload too large', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!aborted) reject(err); });
  });
}

function parseAttachmentsJson(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return [];
  try { const p = JSON.parse(s); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}

function passwordVersion(account) {
  return String((account && account.password_version) || '0');
}

function setSessionCookie(res, claims) {
  const token = auth.signSession({ ...claims, exp: Date.now() + auth.SESSION_TTL_MS });
  res.setHeader('Set-Cookie', `${auth.COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(auth.SESSION_TTL_MS / 1000)}${COOKIE_SECURE ? '; Secure' : ''}`);
}

// A valid signature is no longer the whole story. The cookie is stateless, so the account
// it names can have been disabled, demoted, or had its password changed since it was
// issued — and none of that can wait out a 12-hour expiry. One read per API call re-checks
// all three against the account itself; the role in particular is taken from the account,
// not from the cookie, so a demotion applies to the very next request.
async function resolveSession(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  const claims = auth.verifySession(cookies[auth.COOKIE_NAME]);
  if (!claims) return null;
  let account;
  try {
    account = await store.getUserByUsername(claims.username);
  } catch (err) {
    // A signed session is enough to place an untrusted item in staging. The worker
    // re-checks the account and ownership once SQL is available; no staged item becomes
    // visible or actionable until that server-side check succeeds.
    if (storageUnavailable(err)) return { ...claims, degraded: true };
    throw err;
  }
  if (!account || String(account.active) === 'No' || account.person_active === 'No') return null;
  if (passwordVersion(account) !== String(claims.pv || '0')) return null;
  return { ...claims, role: account.role };
}

// Authenticated identity from the session (set in the request handler). Audit
// changed_by comes from here — never a client-supplied header — so it can't be forged.
function currentUser(req) {
  return req.user ? req.user.username : 'unknown';
}
function isAdmin(req) { return !!(req.user && req.user.role === 'admin'); }
function actorSnapshot(req) {
  return {
    username: currentUser(req),
    role: req.user && req.user.role || 'requester',
    person_id: req.user && req.user.person_id || '',
    display_name: req.user && req.user.display_name || currentUser(req),
  };
}
function storageUnavailable(err) { return store.backend === 'sql' && store.isStorageUnavailable(err); }
async function owns(req, row) {
  return !!(req.user && await store.isRequestOwner(row, req.user.username, req.user.person_id || '', req.user.display_name));
}

function versionFrom(body) {
  return body && body._version ? String(body._version) : '';
}

function withoutVersion(body) {
  const copy = { ...(body || {}) };
  delete copy._version;
  delete copy._from_status;
  // An internal note may only be written through /internal-note, which sends nothing
  // else. That is what keeps it internal: store.updateRequest labels the audit event
  // 'Internal Note' only when nothing else changed in the same call, and the requester's
  // history view hides events by that label alone. A PATCH carrying an internal note
  // alongside any field change would log it as an ordinary 'Field Updated' event with
  // the note text attached — visible to the requester.
  delete copy.internal_note;
  return copy;
}

// Attachment uploads and removals carry the version in the query string: the request
// body is raw file bytes, so there is nowhere else to put it. Without it these endpoints
// write blind — they would accept a two-hour-old tab's file, hand back a fresh version
// stamp, and let the follow-up field patch sail through the optimistic lock with stale
// values. See the PATCH guard below for the matching status check.
function requiredQueryVersion(req, parsed, res) {
  const value = String((parsed.query && parsed.query.version) || '').trim();
  if (!value) {
    sendJson(res, 400, { error: 'version query param is required' });
    return null;
  }
  return value;
}

function stagedResponse(req, row) {
  return requestResponse(req, { ...row, pending_sync: true });
}

function stagedAttachmentName(filename) {
  return (path.basename(String(filename || 'file')).replace(/[^\w.\- ]+/g, '_').slice(0, 120)) || 'file';
}

function isAllowedUploadFilename(filename) {
  return ALLOWED_UPLOAD_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function stagedActionChanges(action, body, req) {
  const input = body || {};
  if (action === 'save-draft') {
    const changes = requesterCreateBody(req, input);
    for (const field of IMMUTABLE_AFTER_CREATE) delete changes[field];
    return changes;
  }
  if (action === 'save-returned' || action === 'resubmit') {
    const changes = {};
    for (const [key, value] of Object.entries(input)) if (RESUBMIT_EDITABLE_FIELDS.has(key)) changes[key] = value;
    if (action === 'resubmit') {
      changes.current_status = input.request_type === PROCUREMENT_TYPE
        ? PROCUREMENT_SUBMIT_TO_ADMIN : UPDATED_AND_RESUBMITTED;
    }
    if (input.note) changes.note = String(input.note).trim();
    return changes;
  }
  if (action === 'save-invoice-progress') {
    const changes = requesterInvoiceProgressChanges(input);
    changes.current_status = PROCUREMENT_PO_ISSUED;
    if (input.note) changes.note = String(input.note).trim();
    return changes;
  }
  if (action === 'submit') return {
    current_status: input.request_type === PROCUREMENT_TYPE ? PROCUREMENT_SUBMIT_TO_ADMIN : 'Submitted',
    note: input.note || '',
  };
  if (action === 'invoice-received') {
    const changes = { current_status: PROCUREMENT_INVOICE_RECEIVED, note: input.note || '' };
    for (const field of REQUESTER_INVOICE_PROGRESS_FIELDS) if (Object.prototype.hasOwnProperty.call(input, field)) changes[field] = input[field];
    return changes;
  }
  return null;
}

async function requesterMutationOrStage(req, id, operation, changes, expectedVersion) {
  try {
    let row;
    if (operation === 'save-returned') row = await store.saveReturnedRequest(id, changes, currentUser(req), expectedVersion);
    else if (operation === 'save-invoice-progress') row = await store.saveInvoiceProgress(id, changes, currentUser(req), expectedVersion);
    else row = await store.updateRequest(id, changes, currentUser(req), expectedVersion, {
      operation, isAdmin: false,
    });
    return { status: 200, row };
  } catch (err) {
    if (!storageUnavailable(err)) throw err;
    const staged = await stagingQueue.stageOperation(id, {
      type: 'action', operation, changes, expected_version: expectedVersion, is_admin: false,
    }, actorSnapshot(req));
    return { status: 202, row: staged };
  }
}

function stagedValuesEqual(currentValue, wantedValue) {
  if (currentValue == null && wantedValue == null) return true;
  const left = String(currentValue == null ? '' : currentValue);
  if (wantedValue && typeof wantedValue === 'object') {
    try { return JSON.stringify(JSON.parse(left || 'null')) === JSON.stringify(wantedValue); } catch (_) { return false; }
  }
  return left === String(wantedValue == null ? '' : wantedValue);
}

function stagedChangeAlreadyApplied(current, changes) {
  const comparable = Object.entries(changes || {})
    .filter(([key]) => !['_version', '_from_status', 'note'].includes(key))
  // A note is history-only and has no current-row value to compare. Do not silently
  // drop a note-only staged action as an "already applied" empty change.
  if (!comparable.length && String(changes && changes.note || '').trim()) return false;
  return comparable.every(([key, value]) => stagedValuesEqual(current[key], value));
}

async function assertStagedActor(manifest, current, step = {}) {
  const actor = step.actor || manifest.actor || {};
  const adminAction = step.is_admin == null ? !!manifest.is_admin : !!step.is_admin;
  const account = await store.getUserByUsername(actor.username);
  if (!account || String(account.active) === 'No' || account.person_active === 'No') {
    throw new Error('The account that created this staged change is no longer active.');
  }
  if (adminAction && account.role !== 'admin') throw new Error('The staged Finance change is no longer authorised.');
  if (!adminAction && current && !(await store.isRequestOwner(current, actor.username, actor.person_id || '', actor.display_name || ''))) {
    throw new Error('The staged request is no longer owned by this user.');
  }
}

async function moveStagedFile(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fsp.rename(source, target);
  } catch (err) {
    if (err.code !== 'EXDEV') {
      if (err.code === 'EEXIST') return;
      throw err;
    }
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL).catch((copyErr) => {
      if (copyErr.code !== 'EEXIST') throw copyErr;
    });
    await fsp.unlink(source).catch(() => {});
  }
}

async function markStagedMutation(manifest, bundleDir) {
  // Persist this before the worker marks the step done. If the process stops between
  // the SQL commit and that final step write, the next run can use the fresh DB version
  // for the following staged operation instead of replaying the browser's old version.
  manifest.mutation_started = true;
  manifest.updated_at = new Date().toISOString();
  await stagingQueue.writeJsonAtomic(stagingQueue.manifestPath(bundleDir), manifest);
}

async function processStagedStep(manifest, step, bundleDir) {
  const targetId = manifest.target_request_id;
  const actor = step.actor || manifest.actor || {};
  const username = String(actor.username || '');
  if (!username) throw new Error('A staged change has no authenticated owner.');

  if (step.type === 'create') {
    await assertStagedActor(manifest, null, step);
    await store.createRequest(step.input || {}, username, {
      isAdmin: !!step.is_admin,
      requestId: targetId,
    });
    // The create transaction establishes the SQL row and its first version. Later
    // steps must use the row's current version, not the browser's pre-commit shadow.
    await markStagedMutation(manifest, bundleDir);
    return;
  }

  const current = await store.getRequestById(targetId);
  if (!current) throw new Error(`Request ${targetId} was not found while synchronising staged data.`);
  await assertStagedActor(manifest, current, step);
  const adminAction = step.is_admin == null ? !!manifest.is_admin : !!step.is_admin;

  if (step.type === 'attachment') {
    const currentAttachments = parseAttachmentsJson(current.attachments);
    const storedName = step.file_name || `${step.step_id}__${stagedAttachmentName(step.filename)}`;
    if (currentAttachments.some((item) => item && item.purpose === step.purpose && item.stored === storedName)) {
      // The SQL commit may have succeeded just before the worker crashed. Mark the
      // bundle as having started its mutation so following steps use the fresh DB
      // version rather than replaying the browser's stale shadow version.
      await markStagedMutation(manifest, bundleDir);
      return;
    }
    if (!manifest.mutation_started
        && step.expected_version && String(current.last_updated_at) !== String(step.expected_version)) {
      const conflict = new Error('The request changed before the staged attachment could be applied.');
      conflict.code = 'FRT_CONFLICT';
      throw conflict;
    }
    store.assertAttachmentAllowed(current, step.purpose, adminAction);
    const stagedFile = path.join(bundleDir, 'files', step.file_name);
    const targetFile = path.join(UPLOAD_DIR, storedName);
    if (!fs.existsSync(targetFile)) await moveStagedFile(stagedFile, targetFile);
    try {
      const result = await store.upsertAttachment(targetId, {
        attachment_id: step.attachment_id || step.step_id,
        purpose: step.purpose,
        filename: step.filename,
        stored: storedName,
        size: step.size,
        type: step.content_type,
        uploaded_by: username,
        uploaded_at: step.created_at,
      }, username, current.last_updated_at, adminAction);
      const previousPath = result.previous && result.previous.stored ? safeStoredPath(result.previous.stored) : null;
      if (previousPath && previousPath !== targetFile) await fsp.unlink(previousPath).catch(() => {});
      await markStagedMutation(manifest, bundleDir);
    } catch (err) {
      const refreshed = await store.getRequestById(targetId).catch(() => null);
      const refreshedAttachments = refreshed ? parseAttachmentsJson(refreshed.attachments) : [];
      if (refreshedAttachments.some((item) => item && item.purpose === step.purpose && item.stored === storedName)) {
        await markStagedMutation(manifest, bundleDir);
        return;
      }
      throw err;
    }
    return;
  }

  if (step.type === 'remove-attachment') {
    const currentAttachments = parseAttachmentsJson(current.attachments);
    const existing = currentAttachments.find((item) => item && item.purpose === step.purpose);
    if (!existing) {
      await markStagedMutation(manifest, bundleDir);
      return;
    }
    if (!manifest.mutation_started && step.expected_version
        && String(current.last_updated_at) !== String(step.expected_version)) {
      const conflict = new Error('The request changed before the staged document removal could be applied.');
      conflict.code = 'FRT_CONFLICT';
      throw conflict;
    }
    const result = await store.removeAttachment(targetId, step.purpose, username, current.last_updated_at, adminAction);
    const removedPath = result.removed && result.removed.stored ? safeStoredPath(result.removed.stored) : null;
    if (removedPath) await fsp.unlink(removedPath).catch(() => {});
    await markStagedMutation(manifest, bundleDir);
    return;
  }

  const changes = step.changes || {};
  if (stagedChangeAlreadyApplied(current, changes)) {
    await markStagedMutation(manifest, bundleDir);
    return;
  }
  // The first existing-request step was checked against the browser's version above;
  // after that, each following step deliberately uses the version just committed by
  // the previous step in this same durable bundle.
  const expected = current.last_updated_at;
  try {
    if (step.operation === 'save-returned') await store.saveReturnedRequest(targetId, changes, username, expected);
    else if (step.operation === 'save-invoice-progress') await store.saveInvoiceProgress(targetId, changes, username, expected);
    else await store.updateRequest(targetId, changes, username, expected, {
      isAdmin: adminAction,
      operation: step.operation || 'update',
    });
  } catch (err) {
    const refreshed = await store.getRequestById(targetId).catch(() => null);
    if (refreshed && stagedChangeAlreadyApplied(refreshed, changes)) {
      await markStagedMutation(manifest, bundleDir);
      return;
    }
    throw err;
  }
  await markStagedMutation(manifest, bundleDir);
}

async function drainStagingQueue() {
  if (stagingWorkerBusy) return;
  stagingWorkerBusy = true;
  try {
    await stagingQueue.init();
    if (store.backend === 'sql' && !storageReady) {
      try {
        await store.init();
        storageReady = true;
        storageInitError = '';
      } catch (err) {
        storageInitError = String(err && err.message || 'Database unavailable');
        return;
      }
    }
    await stagingQueue.processOne(processStagedStep, { isTransient: storageUnavailable });
  } catch (err) {
    if (storageUnavailable(err)) {
      storageReady = false;
      storageInitError = String(err && err.message || 'Database unavailable');
    } else console.error('Staging worker error:', err);
  } finally {
    stagingWorkerBusy = false;
  }
}

const REQUESTER_CREATE_FIELDS = new Set([
  'request_type', 'sub_type', 'received_date', 'requester_person_id', 'requester_name',
  'beneficiary_person_id', 'beneficiary_name',
  'supplier_id', 'supplier_type', 'supplier_quote_number', 'cost_code', 'cost_code_other',
  'activity_code', 'activity_code_other',
  'short_description', 'amount_ex_gst', 'amount_inc_gst',
  'spending_approver_person_id',
  'spending_approver', 'destination',
  'travel_start_date', 'travel_end_date', 'reimbursement_items', 'notes',
  'supplier_form_data', 'invoice_items',
]);

// Correcting a returned request reuses the create allow-list, minus the fields that
// decide what the request is and who owns it. supplier_form_data is handled separately
// because it is only accepted for Supplier Setup.
// Never editable on resubmit, whatever else the allow-list grows: what the request IS,
// when it arrived, and — critically — who owns it. Ownership keys off requester_person_id
// (store.isRequestOwner), so leaving that editable would let a requester reassign their
// own request to somebody else while correcting it.
// Fixed the moment the request is created: what it is, when it arrived, and who owns it.
// requesterCreateBody stamps the last two on every call because it also serves create, so
// any update path that reuses it has to strip these again — the store rejects them.
const IMMUTABLE_AFTER_CREATE = [
  'request_type', 'sub_type', 'received_date', 'requester_name', 'requester_person_id',
];
const RESUBMIT_LOCKED_FIELDS = [...IMMUTABLE_AFTER_CREATE, 'supplier_form_data'];
const RESUBMIT_EDITABLE_FIELDS = new Set(
  [...REQUESTER_CREATE_FIELDS].filter((field) => !RESUBMIT_LOCKED_FIELDS.includes(field)));
const REQUESTER_INVOICE_PROGRESS_FIELDS = new Set([
  'invoice_items', 'chk_po_included', 'chk_desc_matches_po', 'chk_service_completed',
  'chk_forwarded_to_approver', 'chk_forwarded_with_approval',
]);

// Fields belonging to a workflow step the request had already passed when Finance sent it
// back. A request returned from the invoice stage is usually returned *because* the
// invoice is wrong, so the requester has to be able to correct it; a request returned
// from intake has no business rewriting invoice figures.
const STAGE_EDITABLE_FIELDS = {
  [PROCUREMENT_INVOICE_RECEIVED]: ['invoice_items'],
};
// PO details stay with Finance — the requester never issues a PO.
function stageEditableFields(returnedFrom) {
  return STAGE_EDITABLE_FIELDS[returnedFrom] || [];
}

// The status the request held when Finance returned it. Already recorded as the old_status
// of the return event, so this needs no new column.
async function returnedFromStatus(id) {
  const history = await store.getRequestHistory(id);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].new_status === PROCUREMENT_RETURN_TO_REQUESTOR
        || history[i].new_status === 'Return to Requestor'
        || history[i].new_status === 'Returned for Info') return String(history[i].old_status || '');
  }
  return '';
}

function countItems(value) {
  if (Array.isArray(value)) return value.length;
  try {
    const parsed = JSON.parse(String(value == null ? '' : value).trim() || '[]');
    return Array.isArray(parsed) ? parsed.length : -1;
  } catch (e) { return -1; }
}

function requesterCreateBody(req, body) {
  const clean = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (REQUESTER_CREATE_FIELDS.has(key)) clean[key] = value;
  }
  // The authenticated identity is authoritative. Traveller can remain a different
  // person, but the creator always remains able to see and act on the request.
  clean.requester_name = req.user.display_name;
  clean.requester_person_id = req.user.person_id || '';
  clean.received_date = store.localDate();
  return clean;
}

async function requesterReturnedChanges(id, target, body) {
  const changes = {};
  const stageFields = new Set(stageEditableFields(await returnedFromStatus(id)));
  for (const [key, value] of Object.entries(body || {})) {
    if (RESUBMIT_EDITABLE_FIELDS.has(key) || stageFields.has(key)) changes[key] = value;
  }
  if (target.request_type === SUPPLIER_SETUP_TYPE && Object.prototype.hasOwnProperty.call(body || {}, 'supplier_form_data')) {
    changes.supplier_form_data = body.supplier_form_data;
  }
  return changes;
}

function requesterInvoiceProgressChanges(body) {
  const changes = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (REQUESTER_INVOICE_PROGRESS_FIELDS.has(key)) changes[key] = value;
  }
  return changes;
}

function safeStoredPath(stored) {
  const candidate = path.resolve(UPLOAD_DIR, path.basename(stored));
  return candidate.startsWith(UPLOAD_DIR + path.sep) ? candidate : null;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // Prevent path traversal.
  const safe = path
    .normalize(rel)
    .replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  // The separator matters: a bare startsWith would also accept a sibling directory whose
  // name merely begins with "public".
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
    });
    res.end(content);
  });
}

async function handleApi(req, res, parsed) {
  const { pathname } = parsed;
  const method = req.method;

  // Known API routes and the methods they accept — drives 405 responses.
  function methodNotAllowed(allow) {
    res.writeHead(405, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      Allow: allow.join(', '),
    });
    res.end(JSON.stringify({ error: `Method ${method} not allowed`, allow }));
  }

  if (pathname === '/api/health') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    if (store.backend === 'sql' && storageReady) {
      try { await store.init(); }
      catch (err) {
        if (storageUnavailable(err)) {
          storageReady = false;
          storageInitError = String(err && err.message || 'Database unavailable');
        }
      }
    }
    return sendJson(res, 200, {
      ok: true,
      storage: store.backend,
      storage_ready: store.backend !== 'sql' || storageReady,
      storage_error: storageReady ? '' : storageInitError,
    });
  }

  // ---- auth: login and registration are the only APIs reachable without a session ----
  if (pathname === '/api/login') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const body = await readBody(req, res);
    const username = String(body.username || '').trim().toLowerCase();
    const now = Date.now();
    const retryAfterMs = loginRetryAfterMs(req, username, now);
    if (retryAfterMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return sendJson(res, 429, { error: 'Too many failed sign-in attempts. Wait a few minutes and try again.' });
    }
    const u = await store.getUserByUsername(username);
    // Hash unconditionally. Short-circuiting on an unknown user skips scrypt entirely, and
    // the response-time difference tells an attacker which usernames exist.
    const passwordOk = await auth.verifyPassword(body.password || '', u ? u.password_hash : DUMMY_PASSWORD_HASH);
    if (!u || !passwordOk) {
      recordLoginFailure(req, username, now);
      return sendJson(res, 401, { error: 'Invalid username or password' });
    }
    // Said plainly, and only to someone who has just proved they hold the password: they
    // cannot enumerate anything with it, and "invalid username or password" for an account
    // that was deliberately switched off is a support call every time.
    if (String(u.active) === 'No' || u.person_active === 'No') {
      clearLoginFailures(req, username);
      return sendJson(res, 403, { error: 'This account is disabled. Contact Business Services.' });
    }
    clearLoginFailures(req, username);
    const people = await store.readPeople();
    const linkedPerson = u.person_id
      ? people.find((person) => person.person_id === u.person_id)
      : people.find((person) => person.display_name === (u.display_name || u.username));
    const person_id = linkedPerson ? linkedPerson.person_id : '';
    const display_name = linkedPerson ? linkedPerson.display_name : (u.display_name || u.username);
    setSessionCookie(res, { username: u.username, role: u.role, person_id, display_name, pv: passwordVersion(u) });
    return sendJson(res, 200, { username: u.username, role: u.role, person_id, display_name });
  }

  // POST /api/register — self-service account creation. Public by design; store.registerUser
  // owns the rules (allowed email domain, requester role only, one account per address).
  if (pathname === '/api/register') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const now = Date.now();
    const retryAfterMs = registerRetryAfterMs(req, now);
    if (retryAfterMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return sendJson(res, 429, { error: 'Too many registration attempts. Wait a few minutes and try again.' });
    }
    recordRegisterAttempt(req, now);
    const body = await readBody(req, res);
    const account = await store.registerUser({
      display_name: body.display_name, email: body.email, password: body.password,
    });
    // Signed in immediately: a new account with nothing to confirm has nowhere else to go,
    // and bouncing them back to the sign-in form just asks for the password twice.
    setSessionCookie(res, { ...account, pv: '0' });
    return sendJson(res, 201, account);
  }
  if (pathname === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', `${auth.COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`);
    return sendJson(res, 200, { ok: true });
  }

  // Every other API route requires authentication.
  if (!req.user) return sendJson(res, 401, { error: 'Not authenticated' });

  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, { username: req.user.username, role: req.user.role, person_id: req.user.person_id || '', display_name: req.user.display_name });
  }

  // ---- COMP6708 conversational assistant: heuristic baseline + OpenAI semantic layer ----
  if (pathname === '/api/assistant/config') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return sendJson(res, 200, {
      provider: openaiAssistant.configured() ? 'openai' : 'heuristic',
      api_mode: process.env.OPENAI_API_MODE || 'responses',
      turn_model: process.env.OPENAI_TURN_MODEL || openaiAssistant.DEFAULT_TURN_MODEL,
      chat_model: process.env.OPENAI_CHAT_MODEL || openaiAssistant.DEFAULT_CHAT_MODEL,
      mcp_enabled: !!(String(process.env.APP_BASE_URL || '').trim() && String(process.env.MCP_SERVER_TOKEN || '').trim()),
    });
  }

  if (pathname === '/api/assistant/knowledge') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    const query = String((parsed.query && parsed.query.q) || '').trim();
    if (query.length < 2) return sendJson(res, 400, { error: 'q must contain at least 2 characters' });
    return sendJson(res, 200, {
      disclaimer: 'Synthetic academic demo content; not official PolyU policy.',
      results: searchFinanceKnowledge(query, { limit: 4 }),
    });
  }

  if (pathname === '/api/assistant/turn') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const body = await readBody(req, res);
    const heuristic = decideTurn(body);
    const decision = await openaiAssistant.classifyTurn(body, heuristic);
    return sendJson(res, 200, decision);
  }

  if (pathname === '/api/assistant/respond') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const body = await readBody(req, res);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userTexts = messages
      .filter((message) => !message || message.role !== 'assistant')
      .map((message) => String(message && (message.text || message.content) || '').trim())
      .filter(Boolean);
    const query = userTexts.join(' ').trim();
    if (!query) return sendJson(res, 400, { error: 'At least one user message is required' });

    const hits = searchFinanceKnowledge(query, { limit: 4 });
    if (openaiAssistant.configured()) {
      try {
        const generated = await openaiAssistant.generateGroundedAnswer({ messages, evidence: hits, actor: actorSnapshot(req) });
        if (generated) {
          return sendJson(res, 200, {
            ...generated,
            sources: hits.slice(0, 3).map((hit) => ({
              file: hit.file,
              title: hit.title,
              section: hit.section,
              score: hit.score,
            })),
          });
        }
      } catch (err) {
        // The course demo remains usable when an API quota/network/model issue occurs.
        // Never include the API error itself in the client response because it may contain
        // provider metadata that is irrelevant to the user.
        console.warn('OpenAI assistant unavailable; using deterministic fallback:', err && err.message || 'unknown error');
      }
    }

    // Deterministic fallback and Assignment 2 baseline.
    const requestIdMatch = query.match(/\bFR-\d{8}-\d{3}\b/i);
    if (requestIdMatch) {
      const requestId = requestIdMatch[0].toUpperCase();
      const row = await store.getRequestById(requestId);
      if (!row || String(row.deleted || '') === 'Yes' || (!isAdmin(req) && !(await owns(req, row)))) {
        return sendJson(res, 200, {
          mode: 'deterministic-demo',
          text: `I could not find ${requestId} among the requests this signed-in account can access.`,
          sources: [],
        });
      }
      const details = [
        `Request ${requestId}`,
        row.request_type ? `type: ${row.request_type}` : '',
        row.sub_type ? `subtype: ${row.sub_type}` : '',
        row.current_status ? `status: ${statusLabel(row.current_status)}` : '',
        row.waiting_on ? `waiting on: ${userFacingLabel(row.waiting_on)}` : '',
        row.next_action ? `next action: ${userFacingLabel(row.next_action)}` : '',
      ].filter(Boolean);

      if (/\bhistory\b|\bchanged\b|\bupdate\b/i.test(query)) {
        const history = await store.getRequestHistory(requestId);
        const latest = history.slice(-3).map((event) => {
          const when = event.changed_at || event.timestamp || '';
          const what = event.event_type || event.event || event.status || 'Update';
          return `${when ? `${when}: ` : ''}${what}`;
        });
        if (latest.length) details.push(`recent history: ${latest.join(' | ')}`);
      }

      return sendJson(res, 200, {
        mode: 'deterministic-demo',
        text: `${details.join('; ')}. This status comes from the live synthetic tracker, not from policy text.`,
        sources: [],
      });
    }

    if (!hits.length || hits[0].score < 2) {
      return sendJson(res, 200, {
        mode: 'deterministic-demo',
        text: 'I do not have enough evidence in the synthetic course-demo knowledge base to answer that safely. Try asking about reimbursement, procurement, travel allowance, supporting documents, request workflow, or an FR request ID.',
        sources: [],
      });
    }

    const selected = hits.slice(0, 2);
    const evidenceText = selected.map((hit) => `${hit.section}: ${hit.text}`).join('\n\n');
    return sendJson(res, 200, {
      mode: 'deterministic-demo',
      text: `Based only on the synthetic COMP6708 knowledge base:\n\n${evidenceText}\n\nThis is academic demo guidance, not official PolyU policy.`,
      sources: selected.map((hit) => ({ file: hit.file, title: hit.title, section: hit.section, score: hit.score })),
    });
  }


  if (pathname === '/api/staging' && method === 'GET') {
    return sendJson(res, 200, { items: await stagingQueue.statusesForActor(actorSnapshot(req)) });
  }
  const stagingRetry = pathname.match(/^\/api\/staging\/([^/]+)\/retry$/);
  if (stagingRetry) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const retried = await stagingQueue.retryFailed(decodeURIComponent(stagingRetry[1]), actorSnapshot(req));
    return sendJson(res, retried ? 200 : 404, retried ? { ok: true } : { error: 'Staged item not found' });
  }

  // POST /api/password — change your own password. The new password_version invalidates
  // every session issued under the old one, so the caller needs a re-signed cookie or the
  // very next request logs them out.
  if (pathname === '/api/password') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const body = await readBody(req, res);
    const result = await store.changePassword(req.user.username, body.current_password, body.new_password);
    const { username, role, person_id, display_name } = req.user;
    setSessionCookie(res, { username, role, person_id, display_name, pv: result.password_version });
    return sendJson(res, 200, { ok: true });
  }

  // ---- accounts (admin) ----
  // Paired with the People directory rather than given a screen of their own: an account
  // and the person behind it are one thing, and splitting them across two screens is how
  // "deactivated in one place, still able to sign in from the other" happens.
  if (/^\/api\/users(\/|$)/.test(pathname) && !isAdmin(req)) return sendJson(res, 403, { error: 'Admin only' });
  if (pathname === '/api/users') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return sendJson(res, 200, await store.listUsers());
  }
  const userMatch = pathname.match(/^\/api\/users\/([^/]+)(\/reset-password)?$/);
  if (userMatch) {
    const username = decodeURIComponent(userMatch[1]);
    if (userMatch[2]) {
      if (method !== 'POST') return methodNotAllowed(['POST']);
      // The generated password is in this response and nowhere else — not logged, not
      // stored in the clear, not recoverable. Read it out now or reset again.
      return sendJson(res, 200, await store.resetPassword(username));
    }
    if (method !== 'PATCH') return methodNotAllowed(['PATCH']);
    const body = await readBody(req, res);
    return sendJson(res, 200, await store.setUserRole(username, String(body.role || '')));
  }

  const amendmentTemplateMatch = pathname.match(/^\/api\/supplier-amendment-template\/([^/]+)$/);
  if (amendmentTemplateMatch) {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return sendJson(res, 200, await store.getSupplierAmendmentTemplate(decodeURIComponent(amendmentTemplateMatch[1])));
  }

  // The supplier master is admin-only.
  if (/^\/api\/suppliers(\/|$)/.test(pathname) && !isAdmin(req)) {
    return sendJson(res, 403, { error: 'Admin only' });
  }
  if (/^\/api\/people(\/|$)/.test(pathname) && !isAdmin(req)) return sendJson(res, 403, { error: 'Admin only' });

  if (pathname === '/api/people') {
    if (method === 'GET') return sendJson(res, 200, await store.readPeople());
    if (method === 'POST') return sendJson(res, 201, await store.createPerson(await readBody(req, res)));
    return methodNotAllowed(['GET', 'POST']);
  }
  const personMatch = pathname.match(/^\/api\/people\/([^/]+)$/);
  if (personMatch) {
    if (method !== 'PATCH') return methodNotAllowed(['PATCH']);
    return sendJson(res, 200, await store.updatePerson(decodeURIComponent(personMatch[1]), await readBody(req, res)));
  }

  if (pathname === '/api/options') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
  }
  if (pathname === '/api/requests') {
    if (method !== 'GET' && method !== 'POST') return methodNotAllowed(['GET', 'POST']);
  }

  // GET /api/options
  if (method === 'GET' && pathname === '/api/options') {
    const [cost_codes, activity_codes, people, suppliers] = await Promise.all([
      store.readCostCodes(), store.readActivityCodes(), store.readPeople(), store.readSuppliers(),
    ]);
    const activePeople = people.filter((person) => person.active === 'Yes');
    const personOption = (person) => ({ person_id: person.person_id, display_name: person.display_name });
    return sendJson(res, 200, {
      // Supplier Setup remains available to Finance for existing/future controlled
      // processing, but it is not offered as a new requester request type.
      request_types: isAdmin(req) ? REQUEST_TYPES : REQUEST_TYPES.filter((type) => ![SUPPLIER_SETUP_TYPE, TRAVEL_TYPE].includes(type)),
      subtypes_by_type: SUBTYPES_BY_TYPE,
      requester_subtypes: REQUESTER_SUBTYPES,
      statuses: STATUSES,
      statuses_by_type: STATUSES_BY_TYPE,
      allowed_transitions_by_type: ALLOWED_TRANSITIONS_BY_TYPE,
      required_by_subtype: REQUIRED_BY_SUBTYPE,
      activity_code_required_supplier_types: ACTIVITY_CODE_REQUIRED_SUPPLIER_TYPES,
      waiting_on: WAITING_ON,
      waiting_on_by_status: WAITING_ON_BY_STATUS,
      reimbursement_categories: REIMBURSEMENT_CATEGORIES,
      max_reimbursement_items: MAX_REIMBURSEMENT_ITEMS,
      max_invoice_items: MAX_INVOICE_ITEMS,
      required_attachments_by_subtype: REQUIRED_ATTACHMENTS_BY_SUBTYPE,
      allowed_attachments_by_subtype: ALLOWED_ATTACHMENTS_BY_SUBTYPE,
      attachment_labels: ATTACHMENT_LABELS,
      admin_only_attachment_purposes: ADMIN_ONLY_ATTACHMENT_PURPOSES,
      stage_collected_attachment_purposes: STAGE_COLLECTED_ATTACHMENT_PURPOSES,
      cost_codes, activity_codes,
      travellers: activePeople.filter((person) => person.can_travel === 'Yes').map(personOption),
      approvers: activePeople.filter((person) => person.can_approve === 'Yes').map(personOption),
      processors: isAdmin(req) ? activePeople.filter((person) => person.can_process === 'Yes').map(personOption) : [],
      suppliers: isAdmin(req) ? suppliers : suppliers.map((s) => ({
        supplier_id: s.supplier_id, supplier_name: s.supplier_name, abn: s.abn, vendor_id: s.vendor_id,
      })),
      // App-local date/timezone so the frontend's default dates match server IDs
      // regardless of the browser's timezone.
      app_timezone: store.APP_TZ,
      local_date: store.localDate(),
      supplier_master_profiles_persistent: isAdmin(req) && store.supplierProfilesPersistent(),
    });
  }

  // ---- suppliers master ----
  if (pathname === '/api/suppliers') {
    if (method === 'GET') return sendJson(res, 200, await store.readSuppliersAll());
    if (method === 'POST') {
      const body = await readBody(req, res);
      return sendJson(res, 201, await store.createSupplier(body, currentUser(req)));
    }
    return methodNotAllowed(['GET', 'POST']);
  }
  const sm = pathname.match(/^\/api\/suppliers\/([^/]+)(\/delete|\/restore)?$/);
  if (sm) {
    const sid = decodeURIComponent(sm[1]);
    const ssub = sm[2];
    if (method === 'POST' && ssub === '/delete') return sendJson(res, 200, await store.setSupplierDeleted(sid, true, currentUser(req)));
    if (method === 'POST' && ssub === '/restore') return sendJson(res, 200, await store.setSupplierDeleted(sid, false, currentUser(req)));
    if ((method === 'PATCH' || method === 'PUT') && !ssub) {
      const body = await readBody(req, res);
      return sendJson(res, 200, await store.updateSupplier(sid, body, currentUser(req)));
    }
    if (ssub === '/delete' || ssub === '/restore') return methodNotAllowed(['POST']);
    return methodNotAllowed(['PATCH', 'PUT']);
  }

  // GET /api/requests — admins see all; requesters see only their own.
  if (method === 'GET' && pathname === '/api/requests') {
    const rows = isAdmin(req)
      ? (await store.readCurrent()).filter((row) => row.current_status !== 'Draft')
      : await store.readOwnedRequests(req.user.username, req.user.person_id || '', req.user.display_name);
    return sendJson(res, 200, isAdmin(req) ? rows : rows.map(requesterSafeRequest));
  }

  // POST /api/requests
  if (method === 'POST' && pathname === '/api/requests') {
    const body = await readBody(req, res);
    const input = isAdmin(req) ? body : requesterCreateBody(req, body);
    try {
      const row = await store.createRequest(input, currentUser(req), { isAdmin: isAdmin(req) });
      return sendJson(res, 201, requestResponse(req, row));
    } catch (err) {
      if (!storageUnavailable(err)) throw err;
      const staged = await stagingQueue.createBundle({ input, actor: actorSnapshot(req), isAdmin: isAdmin(req) });
      return sendJson(res, 202, stagedResponse(req, staged));
    }
  }

  // POST /api/requests/:id/attachments?purpose=&filename=  — upload raw file bytes.
  const am = pathname.match(/^\/api\/requests\/([^/]+)\/attachments$/);
  if (am && method === 'DELETE') {
    const id = decodeURIComponent(am[1]);
    const purpose = String((parsed.query && parsed.query.purpose) || '').trim();
    if (!purpose) return sendJson(res, 400, { error: 'purpose query param is required' });
    const clientVersion = requiredQueryVersion(req, parsed, res);
    if (!clientVersion) return;
    if (stagingQueue.isPendingRequestId(id) || await stagingQueue.getBundleByRequestId(id, actorSnapshot(req))) {
      const staged = await stagingQueue.stageOperation(id, {
        type: 'remove-attachment', purpose, expected_version: clientVersion, is_admin: isAdmin(req),
      }, actorSnapshot(req));
      return sendJson(res, 202, stagedResponse(req, staged));
    }
    let existing;
    try { existing = await store.getRequestById(id); }
    catch (err) {
      if (!storageUnavailable(err)) throw err;
      const staged = await stagingQueue.stageOperation(id, {
        type: 'remove-attachment', purpose, expected_version: clientVersion, is_admin: isAdmin(req),
      }, actorSnapshot(req));
      return sendJson(res, 202, stagedResponse(req, staged));
    }
    if (!existing) return sendJson(res, 404, { error: 'Request not found' });
    if (String(existing.deleted || '') === 'Yes') return sendJson(res, 409, { error: 'Request is deleted' });
    if (!isAdmin(req) && !(await owns(req, existing))) return sendJson(res, 403, { error: 'Forbidden' });
    try {
      const result = await store.removeAttachment(id, purpose, currentUser(req), clientVersion, isAdmin(req));
      const removedPath = result.removed && result.removed.stored ? safeStoredPath(result.removed.stored) : null;
      if (removedPath) await fsp.unlink(removedPath).catch(() => {});
      return sendJson(res, 200, requestResponse(req, result.row));
    } catch (err) {
      if (!storageUnavailable(err)) throw err;
      const staged = await stagingQueue.stageOperation(id, {
        type: 'remove-attachment', purpose, expected_version: clientVersion, is_admin: isAdmin(req),
      }, actorSnapshot(req));
      return sendJson(res, 202, stagedResponse(req, staged));
    }
  }
  if (am && method === 'POST') {
    const id = decodeURIComponent(am[1]);
    const purpose = String((parsed.query && parsed.query.purpose) || '').trim();
    const filename = String((parsed.query && parsed.query.filename) || 'file').trim();
    if (!purpose) return sendJson(res, 400, { error: 'purpose query param is required' });
    const clientVersion = requiredQueryVersion(req, parsed, res);
    if (!clientVersion) return;
    const stagedBundle = stagingQueue.isPendingRequestId(id)
      ? true : !!(await stagingQueue.getBundleByRequestId(id, actorSnapshot(req)));
    let existing = null;
    if (!stagedBundle) {
      try { existing = await store.getRequestById(id); }
      catch (err) {
        if (!storageUnavailable(err)) throw err;
        const safe = stagedAttachmentName(filename);
        if (!isAllowedUploadFilename(safe)) return sendJson(res, 400, { error: 'This file type is not allowed' });
        const buf = await readRawBody(req, res, MAX_UPLOAD_BYTES);
        if (!buf.length) return sendJson(res, 400, { error: 'The uploaded file is empty' });
        const staged = await stagingQueue.appendAttachment(id, {
          purpose, filename: safe, content_type: req.headers['content-type'] || '',
          expected_version: clientVersion, is_admin: isAdmin(req),
        }, buf, actorSnapshot(req));
        return sendJson(res, 202, stagedResponse(req, staged));
      }
    }
    if (stagedBundle) {
      const safe = stagedAttachmentName(filename);
      if (!isAllowedUploadFilename(safe)) return sendJson(res, 400, { error: 'This file type is not allowed' });
      const buf = await readRawBody(req, res, MAX_UPLOAD_BYTES);
      if (!buf.length) return sendJson(res, 400, { error: 'The uploaded file is empty' });
      const staged = await stagingQueue.appendAttachment(id, {
        purpose, filename: safe, content_type: req.headers['content-type'] || '',
        expected_version: clientVersion, is_admin: isAdmin(req),
      }, buf, actorSnapshot(req));
      return sendJson(res, 202, stagedResponse(req, staged));
    }
    if (!existing) return sendJson(res, 404, { error: 'Request not found' });
    if (String(existing.deleted || '') === 'Yes') return sendJson(res, 409, { error: 'Request is deleted' });
    if (!isAdmin(req) && !(await owns(req, existing))) return sendJson(res, 403, { error: 'Forbidden' });
    if (!isAdmin(req)) {
      const requesterUploadAllowed = existing.current_status === 'Draft'
        || existing.current_status === PROCUREMENT_RETURN_TO_REQUESTOR
        || (existing.request_type === 'Procurement'
          && existing.current_status === PROCUREMENT_PO_ISSUED
          && (purpose === 'invoice_approval_email'
            || new RegExp(`^invoice:${UUID_SOURCE}$`, 'i').test(purpose)
            || new RegExp(`^invoice_other:${UUID_SOURCE}:${UUID_SOURCE}$`, 'i').test(purpose)
            || new RegExp(`^invoice_approval_other:${UUID_SOURCE}$`, 'i').test(purpose)));
      if (!requesterUploadAllowed) {
        return sendJson(res, 409, { error: 'Attachments are locked at this stage of the request' });
      }
    }
    store.assertAttachmentAllowed(existing, purpose, isAdmin(req));
    const buf = await readRawBody(req, res, MAX_UPLOAD_BYTES);
    if (!buf.length) return sendJson(res, 400, { error: 'The uploaded file is empty' });
    const safe = stagedAttachmentName(filename);
    if (!isAllowedUploadFilename(safe)) {
      return sendJson(res, 400, { error: 'This file type is not allowed' });
    }
    const stored = crypto.randomUUID() + '__' + safe;
    const target = safeStoredPath(stored);
    const item = {
      purpose, filename: safe, stored, size: buf.length,
      type: req.headers['content-type'] || '', uploaded_by: currentUser(req), uploaded_at: new Date().toISOString(),
    };
    await fsp.writeFile(target, buf, { flag: 'wx' });
    try {
      const result = await store.upsertAttachment(id, item, currentUser(req), clientVersion, isAdmin(req));
      const oldPath = result.previous && result.previous.stored ? safeStoredPath(result.previous.stored) : null;
      if (oldPath && oldPath !== target) await fsp.unlink(oldPath).catch(() => {});
      return sendJson(res, 200, requestResponse(req, result.row));
    } catch (err) {
      await fsp.unlink(target).catch(() => {});
      if (!storageUnavailable(err)) throw err;
      const staged = await stagingQueue.appendAttachment(id, {
        purpose, filename: safe, content_type: req.headers['content-type'] || '',
        expected_version: clientVersion, is_admin: isAdmin(req),
      }, buf, actorSnapshot(req));
      return sendJson(res, 202, stagedResponse(req, staged));
    }
  }
  if (am) return methodNotAllowed(['POST', 'DELETE']);

  // GET /api/uploads/:stored  — download a file by its server-generated name.
  const dm = pathname.match(/^\/api\/uploads\/([^/]+)$/);
  if (dm && method === 'GET') {
    const stored = path.basename(decodeURIComponent(dm[1]));
    const fp = safeStoredPath(stored);
    const attachment = await store.findAttachmentByStored(stored);
    if (!fp || !attachment || !fs.existsSync(fp)) return sendJson(res, 404, { error: 'Not found' });
    const requestRow = await store.getRequestById(attachment.request_id);
    if (!requestRow || (!isAdmin(req) && !(await owns(req, requestRow)))) return sendJson(res, 403, { error: 'Forbidden' });
    const stat = await fsp.stat(fp);
    const origName = String(attachment.filename || stored).replace(/["\r\n]/g, '');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': attachment.type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${origName}"`,
      'Content-Length': stat.size,
    });
    const stream = fs.createReadStream(fp);
    stream.on('error', () => { if (!res.headersSent) sendJson(res, 500, { error: 'Could not read file' }); else res.destroy(); });
    stream.pipe(res);
    return;
  }

  // Requester workflow actions are intentionally narrow. Requesters cannot use the
  // generic PATCH endpoint to alter finance-only fields or jump to arbitrary statuses.
  const actionMatch = pathname.match(/^\/api\/requests\/([^/]+)\/(save-draft|save-returned|save-invoice-progress|submit|resubmit|po-sent|invoice-received|discard|internal-note)$/);
  if (actionMatch) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    const id = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    const body = await readBody(req, res);
    const version = versionFrom(body);
    const note = body.note == null ? '' : String(body.note).trim();
    const stagedAlready = stagingQueue.isPendingRequestId(id)
      ? true : !!(await stagingQueue.getBundleByRequestId(id, actorSnapshot(req)));
    let target = null;
    let targetLookupUnavailable = false;
    if (!stagedAlready) {
      try { target = await store.getRequestById(id); }
      catch (err) {
        if (!storageUnavailable(err)) throw err;
        targetLookupUnavailable = true;
      }
    }

    // A signed session may still place a requester change into the durable queue while
    // SQL is unavailable. Status mutations from the admin PATCH route are intentionally
    // excluded below because replaying a stale Finance decision is unsafe.
    if (stagedAlready || targetLookupUnavailable) {
      if (action === 'discard') return sendJson(res, 503, { error: 'Database temporarily unavailable. Discard is not queued; try again after it recovers.' });
      if (action === 'internal-note' || action === 'po-sent') return sendJson(res, 503, { error: 'This action is not queued while the database is unavailable.' });
      if (isAdmin(req)) return sendJson(res, 403, { error: 'User action only' });
      const changes = stagedActionChanges(action, body, req);
      if (!changes) return sendJson(res, 503, { error: 'This action is not available while the database is unavailable.' });
      const staged = await stagingQueue.stageOperation(id, {
        type: 'action', operation: action, changes, expected_version: version, is_admin: false,
      }, actorSnapshot(req));
      return sendJson(res, 202, stagedResponse(req, staged));
    }
    if (!target) return sendJson(res, 404, { error: 'Request not found' });
    if (!isAdmin(req) && !(await owns(req, target))) return sendJson(res, 403, { error: 'Forbidden' });

    if (action === 'discard') {
      if (isAdmin(req)) return sendJson(res, 403, { error: 'User action only' });
      const discarded = await store.hardDeleteDraft(id);
      for (const attachment of parseAttachmentsJson(discarded.attachments)) {
        const filePath = attachment && attachment.stored ? safeStoredPath(attachment.stored) : null;
        if (filePath) await fsp.unlink(filePath).catch(() => {});
      }
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'internal-note') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Admin only' });
      const internalNote = String(body.internal_note || '').trim();
      if (!internalNote) return sendJson(res, 400, { error: 'Internal note is required' });
      return sendJson(res, 200, await store.updateRequest(id, { internal_note: internalNote }, currentUser(req), version, {
        isAdmin: true,
      }));
    }

    if (action === 'save-draft') {
      if (isAdmin(req)) return sendJson(res, 403, { error: 'User action only' });
      if (target.current_status !== 'Draft') return sendJson(res, 409, { error: 'Only a Draft request can be edited' });
      // supplier_form_data is deliberately NOT stripped here: a Supplier Setup draft has
      // to be able to save its form. Only the create-time identity fields go.
      const clean = requesterCreateBody(req, body);
      for (const field of IMMUTABLE_AFTER_CREATE) delete clean[field];
      const result = await requesterMutationOrStage(req, id, 'save-draft', clean, version);
      return sendJson(res, result.status, requestResponse(req, result.row));
    }

    if (action === 'save-returned') {
      if (isAdmin(req)) return sendJson(res, 403, { error: 'User action only' });
      const returnStatus = target.request_type === PROCUREMENT_TYPE
        ? PROCUREMENT_RETURN_TO_REQUESTOR : 'Returned for Info';
      if (target.current_status !== returnStatus) {
        return sendJson(res, 409, { error: 'Only a request returned for information can save corrections' });
      }
      const changes = await requesterReturnedChanges(id, target, body);
      if (note) changes.note = note;
      const result = await requesterMutationOrStage(req, id, 'save-returned', changes, version);
      return sendJson(res, result.status, requestResponse(req, result.row));
    }

    if (action === 'save-invoice-progress') {
      if (isAdmin(req)) return sendJson(res, 403, { error: 'User action only' });
      if (target.request_type !== 'Procurement' || target.current_status !== PROCUREMENT_PO_ISSUED) {
        return sendJson(res, 409, { error: 'Only a procurement request waiting for invoice details can save progress' });
      }
      const changes = requesterInvoiceProgressChanges(body);
      if (note) changes.note = note;
      changes.current_status = PROCUREMENT_PO_ISSUED;
      const result = await requesterMutationOrStage(req, id, 'save-invoice-progress', changes, version);
      return sendJson(res, result.status, requestResponse(req, result.row));
    }

    if (action === 'submit') {
      if (target.current_status !== 'Draft') return sendJson(res, 409, { error: 'Only a Draft request can be submitted' });
      const targetStatus = target.request_type === PROCUREMENT_TYPE ? PROCUREMENT_SUBMIT_TO_ADMIN : 'Submitted';
      const result = await requesterMutationOrStage(req, id, 'submit', {
        current_status: targetStatus, note,
      }, version);
      return sendJson(res, result.status, requestResponse(req, result.row));
    }
    if (action === 'resubmit') {
      const returnStatus = target.request_type === PROCUREMENT_TYPE
        ? PROCUREMENT_RETURN_TO_REQUESTOR : 'Returned for Info';
      if (target.current_status !== returnStatus) return sendJson(res, 409, { error: 'This request is not waiting for more information' });
      const changes = {
        current_status: target.request_type === PROCUREMENT_TYPE
          ? PROCUREMENT_SUBMIT_TO_ADMIN : UPDATED_AND_RESUBMITTED,
        note: note || 'Updated and resubmitted',
      };
      // Finance returns a request because something in it is wrong, so the requester has
      // to be able to correct it. Identity and routing fields stay server-owned, exactly
      // as they are on create.
      Object.assign(changes, await requesterReturnedChanges(id, target, body));
      // Line receipts use stable item IDs. Keep the line count fixed during this
      // correction flow because changing the claim's shape requires Finance to reopen it.
      if (Object.prototype.hasOwnProperty.call(changes, 'reimbursement_items')) {
        if (countItems(changes.reimbursement_items) !== countItems(target.reimbursement_items)) {
          return sendJson(res, 400, {
            error: 'Expense lines cannot be added or removed when resubmitting. Ask Finance to reopen the request as a draft if a line must be added or removed.',
          });
        }
      }
      const result = await requesterMutationOrStage(req, id, 'resubmit', changes, version);
      return sendJson(res, result.status, requestResponse(req, result.row));
    }
    if (action === 'invoice-received') {
      if (target.request_type !== 'Procurement' || target.current_status !== PROCUREMENT_PO_ISSUED) {
        return sendJson(res, 409, { error: 'This request is not ready to receive invoice details' });
      }
      const allowed = ['invoice_items',
        'chk_po_included', 'chk_desc_matches_po', 'chk_service_completed', 'chk_forwarded_to_approver', 'chk_forwarded_with_approval'];
      const changes = { current_status: PROCUREMENT_INVOICE_RECEIVED, note };
      for (const field of allowed) if (Object.prototype.hasOwnProperty.call(body, field)) changes[field] = body[field];
      const result = await requesterMutationOrStage(req, id, 'invoice-received', changes, version);
      return sendJson(res, result.status, requestResponse(req, result.row));
    }
    if (action === 'po-sent') return sendJson(res, 409, { error: 'PO confirmation is no longer a separate status; submit invoice details from the PO stage' });
  }

  // /api/requests/:id  and  /api/requests/:id/(history|delete|restore)
  const m = pathname.match(/^\/api\/requests\/([^/]+)(\/history|\/delete|\/restore)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const sub = m[2];

    // Non-admins may only touch their own requests.
    if (!isAdmin(req)) {
      const target = await store.getRequestById(id);
      if (target && !(await owns(req, target))) return sendJson(res, 403, { error: 'Forbidden' });
    }

    if (method === 'GET' && sub === '/history') {
      const history = await store.getRequestHistory(id);
      return sendJson(res, 200, isAdmin(req)
        ? history
        : history.filter((event) => event.event_type !== 'Internal Note').map((event) => ({ ...event, changed_fields: '' })));
    }
    // Soft delete / restore — keeps the row, flips the `deleted` flag.
    if (method === 'POST' && sub === '/delete') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Admin only' });
      const row = await store.setDeleted(id, true, currentUser(req));
      return sendJson(res, 200, requestResponse(req, row));
    }
    if (method === 'POST' && sub === '/restore') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Admin only' });
      const row = await store.setDeleted(id, false, currentUser(req));
      return sendJson(res, 200, row);
    }
    if (method === 'GET') {
      const row = await store.getRequestById(id);
      if (!row) return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, 200, requestResponse(req, row));
    }
    if (method === 'PATCH' || method === 'PUT') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Admin only. Use the available request action instead.' });
      const body = await readBody(req, res);
      // Second line of defence, and the one that can say what actually happened: the
      // client states the status it was looking at, so a save built on a screen someone
      // else has moved on from is refused by name rather than as a generic conflict.
      const fromStatus = body && body._from_status ? String(body._from_status) : '';
      const current = await store.getRequestById(id);
      if (!current) return sendJson(res, 404, { error: 'Request not found' });
      if (fromStatus) {
        if (String(current.current_status) !== fromStatus) {
          return sendJson(res, 409, {
            error: `This request has moved on since you opened it — it is now "${statusLabel(current.current_status)}", not "${statusLabel(fromStatus)}". Your screen has been refreshed; check it and apply your change again.`,
          });
        }
      }
      const changes = withoutVersion(body);
      // `Updated and Resubmitted` is a requester action for the legacy non-Procurement
      // workflows. Procurement now resubmits to `Submit to Admin`, while Finance may set
      // any Procurement milestone directly, so keep this guard scoped to the other types.
      if (current.request_type !== PROCUREMENT_TYPE
          && changes.current_status === UPDATED_AND_RESUBMITTED) {
        return sendJson(res, 409, { error: 'Only the user can resubmit this request' });
      }
      // Closing a Procurement request is an action by the signed-in Finance account, not
      // a request to select an unrelated processor. Keep both identity columns aligned so
      // the detail view can say who closed it and the audit event still names the account.
      if (current.request_type === PROCUREMENT_TYPE
          && changes.current_status === PROCUREMENT_CLOSED
          && current.current_status !== PROCUREMENT_CLOSED) {
        changes.processed_by_person_id = req.user.person_id || '';
        changes.processed_by = req.user.display_name || req.user.username;
      }
      const row = await store.updateRequest(id, changes, currentUser(req), versionFrom(body), {
        isAdmin: true,
      });
      return sendJson(res, 200, row);
    }

    // Path matched but method didn't — return 405 with the correct Allow header.
    if (sub === '/history') return methodNotAllowed(['GET']);
    if (sub === '/delete' || sub === '/restore') return methodNotAllowed(['POST']);
    return methodNotAllowed(['GET', 'PATCH', 'PUT']);
  }

  return sendJson(res, 404, { error: 'Unknown API route' });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const parsed = { pathname: requestUrl.pathname, query: Object.fromEntries(requestUrl.searchParams) };
  try {
    if (parsed.pathname === '/mcp') {
      const body = req.method === 'POST' ? await readBody(req, res) : undefined;
      if (!res.writableEnded) await demoMcpHttp.handle(req, res, body);
    } else if (parsed.pathname.startsWith('/api/')) {
      // Only the API needs an identity, and resolving one now costs a storage read —
      // no reason to pay it for every stylesheet.
      req.user = await resolveSession(req);
      await handleApi(req, res, parsed);
    } else {
      serveStatic(req, res, parsed.pathname);
    }
  } catch (err) {
    // The response may already be partly sent (e.g. aborted large uploads).
    if (res.headersSent) {
      try { res.end(); } catch (_) { /* ignore */ }
      return;
    }
    if (err instanceof store.StoreError) {
      // Known, client-facing validation/business errors → 4xx with details.
      const payload = { error: err.message || 'Request failed' };
      if (err.fields) payload.fields = err.fields;
      sendJson(res, err.status || 400, payload);
    } else if (storageUnavailable(err)) {
      storageReady = false;
      storageInitError = String(err && err.message || 'Database temporarily unavailable');
      res.setHeader('Retry-After', '10');
      sendJson(res, 503, { error: 'Database temporarily unavailable. Your browser draft remains available; please try again shortly.' });
    } else {
      // Unknown failure (disk, bug, etc.) → 500, logged server-side, no internals leaked.
      console.error('Unhandled server error:', err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }
});

// Refuse to start rather than serve forgeable sessions. This is checked before the
// storage backend so the failure is unambiguous even when the database is also down.
try {
  auth.assertSessionSecret();
} catch (err) {
  console.error('Refusing to start:', err.message);
  process.exit(1);
}

// A warning, not a refusal: development and CI have nowhere to send mail and no business
// being stopped over it. Said out loud because silence is indistinguishable from working.
const mailTransport = String(process.env.MAIL_TRANSPORT || 'log').trim().toLowerCase();
if (mailTransport !== 'smtp') {
  console.warn(`MAIL_TRANSPORT is "${process.env.MAIL_TRANSPORT || 'log'}" — notifications are written to the log, not emailed.`);
} else if (!String(process.env.SMTP_HOST || '').trim()) {
  console.warn('MAIL_TRANSPORT is "smtp" but SMTP_HOST is not set — status-change notifications cannot be delivered.');
}

async function startServer() {
  await stagingQueue.init();
  try {
    await store.init();
    storageReady = true;
  } catch (err) {
    storageInitError = String(err && err.message || 'Database unavailable');
    if (store.backend !== 'sql') {
      console.error('Failed to initialise storage backend:', storageInitError);
      process.exit(1);
      return;
    }
    if (!storageUnavailable(err)) {
      console.error('Failed to initialise SQL storage:', storageInitError);
      process.exit(1);
      return;
    }
    // Keep the web process alive so signed-in browsers can place work in staging while
    // SQL Server is down. The worker retries store.init and drains the queue later.
    storageReady = false;
    console.error('SQL Server is unavailable; starting in staging-only mode:', storageInitError);
  }
  server.listen(PORT, () => {
    console.log(`Finance Request Tracker running at http://localhost:${PORT}`);
    console.log(`Storage backend: ${store.backend}` + (store.paths ? ` (${store.paths.DATA_DIR})` : ''));
    console.log(`Staging directory: ${STAGING_DIR}`);
  });
  const worker = setInterval(() => { drainStagingQueue().catch((err) => console.error('Staging worker tick failed:', err)); }, 5000);
  worker.unref();
  drainStagingQueue().catch((err) => console.error('Initial staging drain failed:', err));
}

startServer().catch((err) => {
  console.error('Failed to initialise application:', err.message);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close(async () => {
    try { await store.close(); } finally { process.exit(0); }
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
