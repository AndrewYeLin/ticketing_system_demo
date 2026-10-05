'use strict';

// CSV storage backend. Implements the async repository interface used by store.js.
// Behaviour matches the original file-based store: read-all / write-all with a
// temp-file rename, append-only log. reimbursement_items / attachments are plain
// JSON-string columns here (the SQL backend splits them into child tables).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const csv = require('./csv');
const { CURRENT_COLUMNS, LOG_COLUMNS, SUPPLIER_COLUMNS, USER_COLUMNS, PERSON_COLUMNS } = require('./constants');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CURRENT_FILE = path.join(DATA_DIR, 'requests_current.csv');
const LOG_FILE = path.join(DATA_DIR, 'request_status_log.csv');
const COST_CODES_FILE = path.join(DATA_DIR, 'cost_codes.csv');
const ACTIVITY_CODES_FILE = path.join(DATA_DIR, 'activity_codes.csv');
const PEOPLE_FILE = path.join(DATA_DIR, 'people.csv');
const SUPPLIERS_FILE = path.join(DATA_DIR, 'suppliers.csv');
const USERS_FILE = path.join(DATA_DIR, 'users.csv');

// Bootstrap reference data for a fresh dev/test data directory. It mirrors
// data/*.csv and the SQL seed in db/schema.sqlserver.sql so all three backends
// start from the same controlled lists.
const DEFAULT_COST_CODES = [
  { cost_code: '2391', description: 'COMP6708 Demo Cost Centre' },
];
const DEFAULT_ACTIVITY_CODES = [
  { cost_code: '2391', activity_code: '3203', description: 'Customer Service Chatbot Project' },
  { cost_code: '2391', activity_code: '3206', description: 'RAG Knowledge Base Prototype' },
  { cost_code: '2391', activity_code: '3234', description: 'MCP Integration Prototype' },
  { cost_code: '2391', activity_code: '3270', description: 'General Teaching Demo' },
];
const DEFAULT_PEOPLE = [
  ['PER-001', 'Demo Administrator', '', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes'],
  ['PER-002', 'Demo Requester One', 'requester1@connect.polyu.hk', 'Yes', 'Yes', 'Yes', 'No', 'No'],
  ['PER-014', 'Demo Approver One', 'approver1@polyu.edu.hk', 'Yes', 'Yes', 'Yes', 'Yes', 'No'],
  ['PER-015', 'Demo Requester Two', 'requester2@connect.polyu.hk', 'Yes', 'Yes', 'Yes', 'No', 'No'],
  ['PER-016', 'Demo Finance Officer', 'finance1@polyu.edu.hk', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes'],
].map(([person_id, display_name, email, active, can_request, can_travel, can_approve, can_process]) => ({
  person_id, display_name, email, active, can_request, can_travel, can_approve, can_process,
}));

// Serialize every CSV mutation inside one Node process. CSV remains a development /
// single-instance backend; production replicas must use SQL Server.
let writeTail = Promise.resolve();
let contractReady = false;
function withWriteLock(fn) {
  const operation = writeTail.then(fn, fn);
  writeTail = operation.catch(() => {});
  return operation;
}

function nextPrefixedId(rows, key, prefix) {
  let max = 0;
  for (const row of rows) {
    const value = String(row[key] || '');
    if (!value.startsWith(prefix)) continue;
    const n = Number.parseInt(value.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

function conflict(message) {
  const err = new Error(message || 'The record was changed by another user. Refresh and try again.');
  err.code = 'FRT_CONFLICT';
  return err;
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CURRENT_FILE)) fs.writeFileSync(CURRENT_FILE, csv.stringify([], CURRENT_COLUMNS), 'utf8');
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, csv.stringify([], LOG_COLUMNS), 'utf8');
  if (!fs.existsSync(COST_CODES_FILE)) fs.writeFileSync(COST_CODES_FILE, csv.stringify(DEFAULT_COST_CODES, ['cost_code', 'description']), 'utf8');
  if (!fs.existsSync(ACTIVITY_CODES_FILE)) fs.writeFileSync(ACTIVITY_CODES_FILE, csv.stringify(DEFAULT_ACTIVITY_CODES, ['cost_code', 'activity_code', 'description']), 'utf8');
  if (!fs.existsSync(PEOPLE_FILE)) fs.writeFileSync(PEOPLE_FILE, csv.stringify(DEFAULT_PEOPLE, PERSON_COLUMNS), 'utf8');
  if (!fs.existsSync(SUPPLIERS_FILE)) fs.writeFileSync(SUPPLIERS_FILE, csv.stringify([], SUPPLIER_COLUMNS), 'utf8');
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, csv.stringify([], USER_COLUMNS), 'utf8');
  if (!contractReady) {
    upgradeCsvContract();
    contractReady = true;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function stableUuid(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return UUID_RE.test(candidate) ? candidate : crypto.randomUUID();
}

function jsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '').trim() || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

function upgradeRequestCollections(row) {
  const reimbursement = jsonArray(row.reimbursement_items).map((item) => {
    const line = { ...(item || {}) };
    delete line.supplier;
    line.item_id = stableUuid(item && item.item_id);
    return line;
  });
  const invoices = jsonArray(row.invoice_items).map((item) => ({
    ...(item || {}), item_id: stableUuid(item && item.item_id),
  }));
  const attachments = jsonArray(row.attachments).map((item) => {
    const attachment = { ...(item || {}), attachment_id: stableUuid(item && item.attachment_id) };
    const purpose = String(attachment.purpose || '');
    let match = /^receipt:([1-9]\d{0,2})$/.exec(purpose);
    if (match && reimbursement[Number(match[1]) - 1]) attachment.purpose = `receipt:${reimbursement[Number(match[1]) - 1].item_id}`;
    match = /^invoice:([1-9]\d{0,2})$/.exec(purpose);
    if (match && invoices[Number(match[1]) - 1]) attachment.purpose = `invoice:${invoices[Number(match[1]) - 1].item_id}`;
    if (purpose === 'invoice' && invoices[0]) attachment.purpose = `invoice:${invoices[0].item_id}`;
    match = /^invoice_other:([1-9]\d{0,2}):[1-9]\d{0,2}$/.exec(purpose);
    if (match && invoices[Number(match[1]) - 1]) attachment.purpose = `invoice_other:${invoices[Number(match[1]) - 1].item_id}:${attachment.attachment_id}`;
    if (/^invoice_approval_other:[1-9]\d{0,2}$/.test(purpose)) attachment.purpose = `invoice_approval_other:${attachment.attachment_id}`;
    if (purpose === 'other_document' || /^other_document:[1-9]\d{0,2}$/.test(purpose)) attachment.purpose = `other_document:${attachment.attachment_id}`;
    return attachment;
  });
  row.reimbursement_items = reimbursement.length ? JSON.stringify(reimbursement) : '';
  row.invoice_items = invoices.length ? JSON.stringify(invoices) : '';
  row.attachments = attachments.length ? JSON.stringify(attachments) : '';
  return row;
}

function upgradeCsvContract() {
  const requestRows = csv.parse(fs.readFileSync(CURRENT_FILE, 'utf8'));
  const logRows = csv.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  const users = csv.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  const usersByName = new Map(users.map((user) => [String(user.username || '').toLowerCase(), user]));
  const createdAt = new Map();
  for (const event of logRows) {
    event.event_id = stableUuid(event.event_id);
    const account = usersByName.get(String(event.changed_by_username || event.changed_by || '').toLowerCase());
    event.changed_by_username = event.changed_by_username || event.changed_by || '';
    event.changed_by_person_id = event.changed_by_person_id || account && account.person_id || '';
    event.changed_by_role = event.changed_by_role || account && account.role || '';
    if (event.event_type === 'Created' && !createdAt.has(event.request_id)) createdAt.set(event.request_id, event.event_time || '');
  }
  for (const row of requestRows) {
    row.created_at = row.created_at || createdAt.get(row.request_id) || '';
    upgradeRequestCollections(row);
  }
  const requestHeader = fs.readFileSync(CURRENT_FILE, 'utf8').split(/\r?\n/, 1)[0];
  const logHeader = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/, 1)[0];
  const requestOutput = csv.stringify(requestRows, CURRENT_COLUMNS);
  const logOutput = csv.stringify(logRows, LOG_COLUMNS);
  const requestChanged = requestHeader !== CURRENT_COLUMNS.join(',') || requestOutput !== fs.readFileSync(CURRENT_FILE, 'utf8');
  const logChanged = logHeader !== LOG_COLUMNS.join(',') || logOutput !== fs.readFileSync(LOG_FILE, 'utf8');
  if (requestChanged || logChanged) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (requestChanged) {
      fs.copyFileSync(CURRENT_FILE, `${CURRENT_FILE}.bak-relational-v2-${stamp}`);
      replaceFileSync(CURRENT_FILE, requestOutput);
    }
    if (logChanged) {
      fs.copyFileSync(LOG_FILE, `${LOG_FILE}.bak-relational-v2-${stamp}`);
      replaceFileSync(LOG_FILE, logOutput);
    }
  }
}

function readSuppliersSync() {
  ensureDataFiles();
  return csv.parse(fs.readFileSync(SUPPLIERS_FILE, 'utf8'));
}
function readUsersSync() {
  ensureDataFiles();
  return csv.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}
function writeUsersSync(rows) {
  replaceFileSync(USERS_FILE, csv.stringify(rows, USER_COLUMNS));
}
function writeSuppliersSync(rows) {
  replaceFileSync(SUPPLIERS_FILE, csv.stringify(rows, SUPPLIER_COLUMNS));
}

function replaceFileSync(target, contents) {
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    // Some Windows file scanners briefly lock an existing destination. CSV is a
    // single-instance development backend, so a copy fallback is safe under writeTail.
    if (!['EPERM', 'EACCES', 'EEXIST'].includes(err.code)) throw err;
    fs.copyFileSync(tmp, target);
    fs.unlinkSync(tmp);
  }
}

function readCurrentSync() {
  ensureDataFiles();
  return csv.parse(fs.readFileSync(CURRENT_FILE, 'utf8'));
}
function writeCurrentSync(rows) {
  const sorted = [...rows].sort((a, b) => String(b.last_updated_at).localeCompare(String(a.last_updated_at)));
  replaceFileSync(CURRENT_FILE, csv.stringify(sorted, CURRENT_COLUMNS));
}
function appendLogSync(row) {
  ensureDataFiles();
  const cells = LOG_COLUMNS.map((c) => csv.escapeField(row[c])).join(',');
  fs.appendFileSync(LOG_FILE, cells + '\r\n', 'utf8');
}
function readLogSync() {
  ensureDataFiles();
  return csv.parse(fs.readFileSync(LOG_FILE, 'utf8'));
}
function writeLogSync(rows) { replaceFileSync(LOG_FILE, csv.stringify(rows, LOG_COLUMNS)); }

function readCostCodesSync() {
  ensureDataFiles();
  return csv.parse(fs.readFileSync(COST_CODES_FILE, 'utf8'))
    .filter((r) => r.cost_code && r.cost_code.trim() !== '')
    .map((r) => ({ cost_code: r.cost_code.trim(), description: (r.description || '').trim() }));
}
function readActivityCodesSync() {
  ensureDataFiles();
  return csv.parse(fs.readFileSync(ACTIVITY_CODES_FILE, 'utf8'))
    .filter((r) => r.activity_code && r.activity_code.trim() !== '')
    .map((r) => ({ cost_code: (r.cost_code || '').trim(), activity_code: r.activity_code.trim(), description: (r.description || '').trim() }));
}
function readPeopleSync() {
  ensureDataFiles();
  return csv.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'))
    .filter((person) => person.person_id && person.display_name)
    .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }));
}
function writePeopleSync(rows) { replaceFileSync(PEOPLE_FILE, csv.stringify(rows, PERSON_COLUMNS)); }

function normalisedEmail(value) { return String(value || '').trim().toLowerCase(); }

function assertUniquePersonEmail(rows, row) {
  const email = normalisedEmail(row.email);
  if (!email) return;
  const duplicate = rows.find((person) => person.person_id !== row.person_id && normalisedEmail(person.email) === email);
  if (duplicate) throw conflict(`That email address is already assigned to ${duplicate.display_name}.`);
}

// Approved, non-deleted suppliers from the master, shaped for the dropdown.
function approvedSuppliers() {
  return readSuppliersSync()
    .filter((s) => s.status === 'Approved' && String(s.deleted || '') !== 'Yes')
    .map((s) => ({
      supplier_id: s.supplier_id,
      supplier_name: String(s.legal_entity_name || '').trim(),
      abn: String(s.abn || '').trim(),
      purchase_order_email: String(s.purchase_order_email || '').trim(),
      vendor_id: String(s.vendor_id || '').trim(),
    }))
    .sort((a, b) => a.supplier_name.localeCompare(b.supplier_name, undefined, { sensitivity: 'base' }));
}

// ---- async repository interface ----

module.exports = {
  kind: 'csv',
  supportsSupplierProfiles() { return true; },
  async init() { ensureDataFiles(); },
  async getRequests() { return readCurrentSync(); },
  async getRequestById(id) { return readCurrentSync().find((r) => r.request_id === id) || null; },
  async createRequest(row, logRow, idPrefix) {
    return withWriteLock(() => {
      const rows = readCurrentSync();
      if (row.request_id) {
        const existing = rows.find((current) => current.request_id === row.request_id);
        if (existing) return { existing: true };
      } else row.request_id = nextPrefixedId(rows, 'request_id', idPrefix);
      if (logRow) logRow.request_id = row.request_id;
      rows.push(row);
      writeCurrentSync(rows);
      if (logRow) appendLogSync(logRow);
    });
  },
  async updateRequest(row, logRow, expectedLastUpdatedAt) {
    return withWriteLock(() => {
      const rows = readCurrentSync();
      const i = rows.findIndex((r) => r.request_id === row.request_id);
      if (i === -1) throw conflict('Request no longer exists.');
      if (String(rows[i].last_updated_at || '') !== String(expectedLastUpdatedAt || '')) throw conflict();
      rows[i] = row;
      writeCurrentSync(rows);
      if (logRow) appendLogSync(logRow);
    });
  },
  async hardDeleteRequest(id) {
    return withWriteLock(() => {
      writeCurrentSync(readCurrentSync().filter((row) => row.request_id !== id));
      writeLogSync(readLogSync().filter((event) => event.request_id !== id));
    });
  },
  async getLog() { return readLogSync(); },
  async getCreatedBy(requestId) {
    const event = readLogSync().find((e) => e.request_id === requestId && e.event_type === 'Created');
    return event ? String(event.changed_by || '') : '';
  },
  async findAttachmentByStored(stored) {
    for (const row of readCurrentSync()) {
      let atts = [];
      try { atts = JSON.parse(row.attachments || '[]'); } catch (_) {}
      const att = Array.isArray(atts) ? atts.find((a) => a && a.stored === stored) : null;
      if (att) return { request_id: row.request_id, ...att };
    }
    return null;
  },
  async getCostCodes() { return readCostCodesSync(); },
  async getActivityCodes() { return readActivityCodesSync(); },
  async getPeople() { return readPeopleSync(); },
  async createPerson(row) {
    return withWriteLock(() => {
      const rows = readPeopleSync();
      assertUniquePersonEmail(rows, row);
      row.person_id = nextPrefixedId(rows, 'person_id', 'PER-');
      rows.push(row); writePeopleSync(rows);
    });
  },
  async updatePerson(row) {
    return withWriteLock(() => {
      const rows = readPeopleSync();
      const index = rows.findIndex((person) => person.person_id === row.person_id);
      if (index === -1) throw conflict('Person no longer exists.');
      assertUniquePersonEmail(rows, row);
      rows[index] = row; writePeopleSync(rows);
    });
  },
  async getSuppliers() { return approvedSuppliers(); },
  async getSuppliersAll() { return readSuppliersSync(); },
  async getSupplierById(id) { return readSuppliersSync().find((s) => s.supplier_id === id) || null; },
  async createSupplier(row, idPrefix) {
    return withWriteLock(() => {
      const rows = readSuppliersSync();
      if (String(row.vendor_id || '').trim() && rows.some((s) => String(s.vendor_id || '').trim() === String(row.vendor_id).trim())) {
        throw conflict(`Vendor ID ${row.vendor_id} is already assigned.`);
      }
      row.supplier_id = nextPrefixedId(rows, 'supplier_id', idPrefix);
      rows.push(row);
      writeSuppliersSync(rows);
    });
  },
  async updateSupplier(row, expectedLastUpdatedAt) {
    return withWriteLock(() => {
      const rows = readSuppliersSync();
      const i = rows.findIndex((s) => s.supplier_id === row.supplier_id);
      if (i === -1) throw conflict('Supplier no longer exists.');
      if (String(rows[i].last_updated_at || '') !== String(expectedLastUpdatedAt || '')) throw conflict('The supplier was changed by another user. Refresh and try again.');
      rows[i] = row;
      writeSuppliersSync(rows);
    });
  },
  // person_active travels with the account because both are checked on every request:
  // the People directory's Active switch is what disables a login, so resolving a session
  // must not need a second read of the people file.
  async getUserByUsername(username) {
    const user = readUsersSync().find((u) => u.username === username) || null;
    if (!user) return null;
    const person = user.person_id ? readPeopleSync().find((p) => p.person_id === user.person_id) : null;
    return { ...user, person_active: person ? person.active : '' };
  },
  async getUsers() { return readUsersSync(); },
  async createUser(row) {
    return withWriteLock(() => {
      const rows = readUsersSync();
      const i = rows.findIndex((u) => u.username === row.username);
      if (i === -1) rows.push(row); else rows[i] = row;
      writeUsersSync(rows);
    });
  },
  // Self-registration's create. createUser above is an upsert because db/createUser.js is
  // also how an administrator resets a password — reachable from a public endpoint that
  // would mean anyone could "register" an existing username and take over the account.
  async createUserIfAbsent(row) {
    return withWriteLock(() => {
      const rows = readUsersSync();
      if (rows.some((u) => u.username === row.username)) throw conflict('That account already exists.');
      rows.push(row);
      writeUsersSync(rows);
    });
  },
  async registerUser(row, personInput) {
    return withWriteLock(() => {
      const users = readUsersSync();
      const people = readPeopleSync();
      const peopleBefore = people.map((candidate) => ({ ...candidate }));
      if (users.some((user) => user.username === row.username)) throw conflict('That account already exists.');

      const email = normalisedEmail(personInput.email);
      let person = people.find((candidate) => normalisedEmail(candidate.email) === email) || null;
      const matchedExistingPerson = !!person;
      if (person && person.active === 'No') {
        throw conflict('That email address belongs to a deactivated person. Contact Business Services.');
      }
      if (!person) {
        person = { ...personInput, person_id: nextPrefixedId(people, 'person_id', 'PER-') };
        assertUniquePersonEmail(people, person);
        people.push(person);
      }
      if (users.some((user) => user.person_id && user.person_id === person.person_id)) {
        throw conflict('That person already has an account. Sign in instead.');
      }

      if (matchedExistingPerson) person.display_name = personInput.display_name;
      const account = { ...row, person_id: person.person_id, display_name: person.display_name };
      try {
        writePeopleSync(people);
        users.push(account);
        writeUsersSync(users);
      } catch (error) {
        writePeopleSync(peopleBefore);
        throw error;
      }
      return { account, person };
    });
  },
  async updateUser(row) {
    return withWriteLock(() => {
      const rows = readUsersSync();
      const i = rows.findIndex((u) => u.username === row.username);
      if (i === -1) throw conflict('That account no longer exists.');
      rows[i] = { ...rows[i], ...row };
      writeUsersSync(rows);
    });
  },
  async close() {},
  isUnavailableError() { return false; },
  paths: { DATA_DIR, CURRENT_FILE, LOG_FILE, COST_CODES_FILE, ACTIVITY_CODES_FILE, PEOPLE_FILE, SUPPLIERS_FILE, USERS_FILE },
};
