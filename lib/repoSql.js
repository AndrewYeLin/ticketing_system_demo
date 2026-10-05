'use strict';

// SQL Server storage backend. Implements the same async repository interface as
// repoCsv, but persists to SQL Server (see db/schema.sqlserver.sql).
//
// The domain layer works with "CSV-shaped" rows: every value is a string, dates are
// 'YYYY-MM-DD', Yes/No are 'Yes'/'No' (deleted uses 'Yes'/''), and reimbursement_items /
// attachments are inline JSON strings. This module converts between that shape and the
// typed SQL columns (BIT / DATE / DECIMAL / DATETIME2) and splits/rebuilds the child
// tables, so the domain layer never sees a difference between backends.

const sql = require('mssql');
const crypto = require('crypto');
const { config } = require('../db/dbConfig');
const {
  CURRENT_COLUMNS, SUPPLIER_COLUMNS, SUPPLIER_PROFILE_FIELDS, SUPPLIER_BANK_FIELDS,
} = require('./constants');
const { assertSchema } = require('../db/schemaContract');

// Collection/object fields remain JSON at the API/CSV boundary but are normalized in SQL.
const BASE_REQUEST_COLUMNS = CURRENT_COLUMNS.filter((c) => ![
  'reimbursement_items', 'invoice_items', 'attachments', 'supplier_form_data',
].includes(c));
const BASE_SUPPLIER_COLUMNS = SUPPLIER_COLUMNS.filter((c) => c !== 'supplier_form_data');
function requestColumns() { return BASE_REQUEST_COLUMNS; }
function supplierColumns() { return BASE_SUPPLIER_COLUMNS; }

const BIT_YESNO = new Set([
  'has_attachments', 'evidence_provided', 'chk_po_included', 'chk_desc_matches_po',
  'chk_service_completed', 'chk_forwarded_to_approver', 'chk_forwarded_with_approval',
]);
// Blank means unanswered, and these columns keep it that way rather than collapsing it
// into "No" — a 0 here would claim Finance had answered the invoice checklist on requests
// that never reach it. has_attachments is excluded: the domain always sets it.
const BIT_NULLABLE = new Set([
  'evidence_provided', 'chk_po_included', 'chk_desc_matches_po',
  'chk_service_completed', 'chk_forwarded_to_approver', 'chk_forwarded_with_approval',
]);
const DATE_COLS = new Set([
  'received_date', 'travel_start_date', 'travel_end_date',
  'acknowledged_date', 'completed_date', 'due_date',
]);
const TIMESTAMP_COLS = new Set([
  'created_at', 'last_updated_at', 'po_issued_at', 'invoice_received_at',
  'submitted_at', 'accepted_at', 'returned_for_info_at', 'completed_at',
]);
const DECIMAL_COLS = new Set([
  'amount', 'amount_ex_gst', 'gst_amount', 'amount_inc_gst',
  'invoice_amount_ex_gst', 'invoice_gst_amount', 'invoice_amount',
]);

let poolPromise = null;
function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config).connect().catch((err) => {
      // Do not cache a rejected promise forever. A short SQL outage must be able to
      // recover without requiring a Docker restart.
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

function resetPool() {
  const old = poolPromise;
  poolPromise = null;
  if (old) old.then((pool) => pool.close()).catch(() => {});
}

function isUnavailableError(err) {
  const code = String(err && err.code || '').toUpperCase();
  // Authentication/schema errors must still stop deployment. Only transport/pool
  // failures are safe to queue and replay later; otherwise a bad password could make
  // the UI appear to save indefinitely while nothing can ever be synchronised.
  const unavailable = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ETIMEOUT', 'ESOCKET', 'ENOTOPEN', 'EPIPE'].includes(code)
    || /not connected|not open|connection|socket|timed out|server .*not accessible|pool.*closed/i
      .test(String(err && err.message || ''));
  if (unavailable) resetPool();
  return unavailable;
}

function conflict(message) {
  const err = new Error(message || 'The record was changed by another user. Refresh and try again.');
  err.code = 'FRT_CONFLICT';
  return err;
}

// SQL Server error 1205: this transaction was picked as the deadlock victim and rolled
// back. A deadlock is not a bug to be designed away — with concurrent writers taking the
// same range locks it is expected, and the server's own message says to rerun. Nothing
// was committed, so the whole operation is safe to replay; the alternative is what the
// multi-user run showed, an opaque 500 and a requester losing an upload roughly once per
// seventy writes. The CSV backend never sees this because it serialises every write in
// one process, so only a SQL run can expose it.
const DEADLOCK = 1205;
const MAX_ATTEMPTS = 4;

function sqlErrorNumber(err) {
  if (!err) return null;
  if (typeof err.number === 'number') return err.number;
  const info = err.originalError && (err.originalError.info || err.originalError);
  return info && typeof info.number === 'number' ? info.number : null;
}

// mssql wraps the driver error and does not always carry the number through, so the
// server's own wording is the fallback. Missing a deadlock means a 500 reaches the user.
function isDeadlock(err) {
  if (sqlErrorNumber(err) === DEADLOCK) return true;
  return /was deadlocked on lock resources/i.test((err && err.message) || '');
}

async function withDeadlockRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isDeadlock(err) || attempt >= MAX_ATTEMPTS) throw err;
      // Back off a little further each time, with jitter so two victims of the same
      // deadlock do not line up and collide again on the retry.
      await new Promise((r) => setTimeout(r, attempt * 25 + Math.floor(Math.random() * 25)));
    }
  }
}

// A transaction aborted by the server is already rolled back, and calling rollback again
// throws — which would replace the real error with a confusing one about no transaction
// being begun. Keep the original.
async function abort(tx) {
  try { await tx.rollback(); } catch (_) { /* already rolled back by the server */ }
}

// ---- value conversion ----

// Domain string -> DB value for a requests column.
function toDb(col, v) {
  const s = v == null ? '' : String(v);
  if (col === 'deleted') return s === 'Yes' ? 1 : 0;
  if (BIT_YESNO.has(col)) {
    if (BIT_NULLABLE.has(col) && s === '') return null;
    return s === 'Yes' ? 1 : 0;
  }
  if (DATE_COLS.has(col)) return s.trim() === '' ? null : s.trim();
  if (DECIMAL_COLS.has(col)) return s.trim() === '' ? null : Number(s);
  // Lifecycle timestamps are facts, not defaults. A blank submitted/accepted/etc.
  // value must stay NULL until that transition actually occurs; otherwise every SQL
  // write makes an untouched request appear to have passed all workflow milestones.
  // Store supplies created_at and last_updated_at explicitly for normal writes.
  if (TIMESTAMP_COLS.has(col)) return s.trim() === '' ? null : s;
  if (col === 'currency') return s.trim() === '' ? 'AUD' : s;
  return s === '' ? null : s;
}

// DB value -> domain string for a requests column.
function fromDb(col, v) {
  if (v == null) return col === 'deleted' ? '' : '';
  if (col === 'deleted') return v ? 'Yes' : '';
  if (BIT_YESNO.has(col)) return v ? 'Yes' : 'No';
  if (DATE_COLS.has(col)) return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  if (TIMESTAMP_COLS.has(col)) return v instanceof Date ? v.toISOString() : String(v);
  if (DECIMAL_COLS.has(col)) return String(v);
  return String(v);
}

// Supplier value conversions (domain string <-> typed suppliers columns).
function supplierToDb(col, v) {
  const s = v == null ? '' : String(v);
  if (col === 'deleted') return s === 'Yes' ? 1 : 0;
  if (col === 'created_at' || col === 'last_updated_at') return s.trim() === '' ? new Date().toISOString() : s;
  return s === '' ? null : s;
}
function supplierFromDb(rec, profile, bank) {
  const o = {};
  for (const c of SUPPLIER_COLUMNS) {
    const v = rec[c];
    if (c === 'deleted') o[c] = v ? 'Yes' : '';
    else if (c === 'created_at' || c === 'last_updated_at') o[c] = v instanceof Date ? v.toISOString() : (v == null ? '' : String(v));
    else if (c === 'supplier_form_data') o[c] = supplierFormFromDb(profile, bank);
    else o[c] = v == null ? '' : String(v);
  }
  return o;
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
}

const PROFILE_BIT_FIELDS = new Set(['has_abn', 'nt_enterprise', 'terms_accepted', 'declaration_confirmed']);
const PROFILE_DATE_FIELDS = new Set(['declaration_date']);

function parseObj(value) {
  const source = String(value == null ? '' : value).trim();
  if (!source) return {};
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}

function formValueFromDb(field, value) {
  if (value == null) return '';
  if (PROFILE_BIT_FIELDS.has(field)) return value ? 'Yes' : 'No';
  if (PROFILE_DATE_FIELDS.has(field) && value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function supplierFormFromDb(profile, bank) {
  if (!profile && !bank) return '';
  const form = {};
  for (const field of SUPPLIER_PROFILE_FIELDS) form[field] = formValueFromDb(field, profile && profile[field]);
  for (const field of SUPPLIER_BANK_FIELDS) form[field] = formValueFromDb(field, bank && bank[field]);
  return JSON.stringify(form);
}

// Build a domain (CSV-shaped) row from a DB requests record + its child rows.
function rowFromDb(rec, itemsBy, invoiceItemsBy, attsBy, profilesBy, banksBy) {
  const row = {};
  for (const c of CURRENT_COLUMNS) row[c] = '';
  for (const c of requestColumns()) row[c] = fromDb(c, rec[c]);
  const items = (itemsBy.get(rec.request_id) || [])
    .sort((a, b) => a.line_no - b.line_no)
    .map((i) => {
      const amount = i.amount == null ? '' : String(i.amount);
      const amountExGst = i.amount_ex_gst == null ? '' : String(i.amount_ex_gst);
      // SQL keeps reimbursement_items.amount NOT NULL. A missing inclusive amount
      // therefore comes back as zero; restore it as blank when the exclusive amount
      // is positive so the domain and UI can apply the same fallback rule.
      const amountForDomain = Number(amount) === 0 && Number(amountExGst) > 0 ? '' : amount;
      // Rebuilt to match what the CSV backend holds, which is whatever the caller sent.
      // Emitting every column unconditionally added empty gst_amount / gst_entry_method
      // keys to lines that never carried them, so the same request read back differently
      // depending on the backend.
      const line = {
        item_id: String(i.item_id).toLowerCase(), category: i.category || '',
        amount: amountForDomain, amount_ex_gst: amountExGst,
      };
      const optional = {
        gst_amount: i.gst_amount == null ? '' : String(i.gst_amount),
        gst_entry_method: i.gst_entry_method || '',
        description: i.description || '', receipt: i.receipt || '',
      };
      for (const [key, value] of Object.entries(optional)) if (value !== '') line[key] = value;
      return line;
    });
  row.reimbursement_items = items.length ? JSON.stringify(items) : '';
  const invoiceItems = (invoiceItemsBy.get(rec.request_id) || [])
    .sort((a, b) => a.line_no - b.line_no)
    .map((item) => {
      const result = { item_id: String(item.invoice_item_id).toLowerCase(), invoice_number: item.invoice_number || '' };
      for (const [field, column] of [
        ['gst_entry_method', 'gst_entry_method'], ['amount_ex_gst', 'amount_ex_gst'],
        ['gst_amount', 'gst_amount'], ['amount_inc_gst', 'amount_inc_gst'],
      ]) if (item[column] != null && String(item[column]) !== '') result[field] = String(item[column]);
      return result;
    });
  row.invoice_items = invoiceItems.length ? JSON.stringify(invoiceItems) : '';
  const atts = (attsBy.get(rec.request_id) || []).map((a) => {
    const o = { attachment_id: String(a.attachment_id).toLowerCase(), purpose: a.purpose, filename: a.filename };
    if (a.stored_path) o.stored = a.stored_path;
    // BIGINT arrives from the driver as a string. The server writes size as a number and
    // the CSV backend stores it verbatim, so coerce back rather than handing the two
    // backends different types for the same byte count.
    if (a.file_size != null) o.size = Number(a.file_size);
    if (a.content_type) o.type = a.content_type;
    if (a.uploaded_by_username || a.uploaded_by) o.uploaded_by = a.uploaded_by_username || a.uploaded_by;
    if (a.created_at || a.uploaded_at) {
      const uploaded = a.created_at || a.uploaded_at;
      o.uploaded_at = uploaded instanceof Date ? uploaded.toISOString() : String(uploaded);
    }
    return o;
  });
  row.attachments = atts.length ? JSON.stringify(atts) : '';
  row.supplier_form_data = supplierFormFromDb(profilesBy.get(rec.request_id), banksBy.get(rec.request_id));
  return row;
}

// Parse an inline-JSON array string safely.
function parseArr(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return [];
  try { const p = JSON.parse(s); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}

// ---- child-table writes (inside a transaction request) ----

async function deleteMissingChildren(tx, table, idColumn, requestId, ids) {
  const request = new sql.Request(tx).input('request_id', requestId);
  if (!ids.length) {
    await request.query(`DELETE FROM dbo.${table} WHERE request_id=@request_id`);
    return;
  }
  ids.forEach((id, index) => request.input(`id_${index}`, id));
  await request.query(`DELETE FROM dbo.${table} WHERE request_id=@request_id AND ${idColumn} NOT IN (${ids.map((_id, index) => `@id_${index}`).join(',')})`);
}

function profileToDb(field, value) {
  const text = String(value == null ? '' : value).trim();
  if (PROFILE_BIT_FIELDS.has(field)) return text === '' ? null : text === 'Yes';
  if (PROFILE_DATE_FIELDS.has(field)) return text || null;
  return text || null;
}

async function writeSupplierForm(tx, owner, ownerId, value) {
  const form = parseObj(value);
  const profileTable = owner === 'request' ? 'request_supplier_profiles' : 'supplier_profiles';
  const bankTable = owner === 'request' ? 'request_supplier_bank_details' : 'supplier_bank_details';
  const key = owner === 'request' ? 'request_id' : 'supplier_id';
  if (!Object.keys(form).length) {
    await new sql.Request(tx).input('id', ownerId).query(`DELETE FROM dbo.${bankTable} WHERE ${key}=@id; DELETE FROM dbo.${profileTable} WHERE ${key}=@id;`);
    return;
  }

  const upsert = async (table, fields) => {
    const request = new sql.Request(tx).input('id', ownerId);
    for (const field of fields) request.input(field, profileToDb(field, form[field]));
    const set = fields.map((field) => `[${field}]=@${field}`).join(',');
    const columns = [key, ...fields].map((field) => `[${field}]`).join(',');
    const values = ['@id', ...fields.map((field) => `@${field}`)].join(',');
    await request.query(`
      UPDATE dbo.${table} SET ${set} WHERE ${key}=@id;
      IF @@ROWCOUNT=0 INSERT INTO dbo.${table} (${columns}) VALUES (${values});`);
  };
  await upsert(profileTable, SUPPLIER_PROFILE_FIELDS);
  await upsert(bankTable, SUPPLIER_BANK_FIELDS);
}

function attachmentRelations(purpose) {
  let match = /^receipt:([0-9a-f-]{36})$/i.exec(purpose);
  if (match) return { role: 'receipt', reimbursementItemId: match[1], invoiceItemId: null };
  match = /^invoice:([0-9a-f-]{36})$/i.exec(purpose);
  if (match) return { role: 'invoice', reimbursementItemId: null, invoiceItemId: match[1] };
  match = /^invoice_other:([0-9a-f-]{36}):[0-9a-f-]{36}$/i.exec(purpose);
  if (match) return { role: 'invoice_other', reimbursementItemId: null, invoiceItemId: match[1] };
  if (/^invoice_approval_other:/i.test(purpose)) return { role: 'invoice_approval_other', reimbursementItemId: null, invoiceItemId: null };
  if (/^other_document:/i.test(purpose)) return { role: 'other_document', reimbursementItemId: null, invoiceItemId: null };
  return { role: purpose, reimbursementItemId: null, invoiceItemId: null };
}

async function writeChildren(tx, row) {
  const id = row.request_id;
  // Temporarily detach relationships so removing a line and reassigning an existing
  // document can happen in the same transaction without violating the child FKs.
  await new sql.Request(tx).input('rid', id)
    .query('UPDATE dbo.attachments SET reimbursement_item_id=NULL, invoice_item_id=NULL WHERE request_id=@rid');
  const items = parseArr(row.reimbursement_items);
  const reimbursementIds = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    reimbursementIds.push(it.item_id);
    const amt = it.amount === '' || it.amount == null ? 0 : Number(it.amount);
    const exGst = it.amount_ex_gst === '' || it.amount_ex_gst == null ? null : Number(it.amount_ex_gst);
    const gst = it.gst_amount === '' || it.gst_amount == null ? null : Number(it.gst_amount);
    await new sql.Request(tx)
      .input('item_id', it.item_id).input('rid', id).input('no', i + 1).input('cat', it.category || '')
      .input('amt', amt).input('exgst', exGst).input('gst', gst)
      .input('gstmode', String(it.gst_entry_method || '').trim() || null)
      .input('desc', it.description || null)
      .input('rec', it.receipt || null)
      .query(`UPDATE dbo.reimbursement_items SET line_no=@no,category=@cat,amount=@amt,amount_ex_gst=@exgst,
                gst_amount=@gst,gst_entry_method=@gstmode,description=@desc,receipt=@rec,updated_at=SYSUTCDATETIME()
              WHERE item_id=@item_id AND request_id=@rid;
              IF @@ROWCOUNT=0 INSERT INTO dbo.reimbursement_items
                (item_id,request_id,line_no,category,amount,amount_ex_gst,gst_amount,gst_entry_method,description,receipt)
                VALUES (@item_id,@rid,@no,@cat,@amt,@exgst,@gst,@gstmode,@desc,@rec);`);
  }
  await deleteMissingChildren(tx, 'reimbursement_items', 'item_id', id, reimbursementIds);

  const invoiceItems = parseArr(row.invoice_items);
  const invoiceIds = [];
  for (let i = 0; i < invoiceItems.length; i++) {
    const item = invoiceItems[i] || {};
    invoiceIds.push(item.item_id);
    await new sql.Request(tx)
      .input('item_id', item.item_id).input('rid', id).input('line_no', i + 1)
      .input('invoice_number', item.invoice_number || '')
      .input('gst_entry_method', item.gst_entry_method || null)
      .input('amount_ex_gst', item.amount_ex_gst === '' || item.amount_ex_gst == null ? null : Number(item.amount_ex_gst))
      .input('gst_amount', item.gst_amount === '' || item.gst_amount == null ? null : Number(item.gst_amount))
      .input('amount_inc_gst', item.amount_inc_gst === '' || item.amount_inc_gst == null ? null : Number(item.amount_inc_gst))
      .query(`UPDATE dbo.invoice_items SET line_no=@line_no,invoice_number=@invoice_number,gst_entry_method=@gst_entry_method,
                amount_ex_gst=@amount_ex_gst,gst_amount=@gst_amount,amount_inc_gst=@amount_inc_gst,updated_at=SYSUTCDATETIME()
              WHERE invoice_item_id=@item_id AND request_id=@rid;
              IF @@ROWCOUNT=0 INSERT INTO dbo.invoice_items
                (invoice_item_id,request_id,line_no,invoice_number,gst_entry_method,amount_ex_gst,gst_amount,amount_inc_gst)
                VALUES (@item_id,@rid,@line_no,@invoice_number,@gst_entry_method,@amount_ex_gst,@gst_amount,@amount_inc_gst);`);
  }
  await deleteMissingChildren(tx, 'invoice_items', 'invoice_item_id', id, invoiceIds);

  const atts = parseArr(row.attachments);
  const attachmentIds = [];
  for (const a of atts) {
    attachmentIds.push(a.attachment_id);
    const relation = attachmentRelations(a.purpose || '');
    await new sql.Request(tx)
      .input('attachment_id', a.attachment_id).input('rid', id).input('pur', a.purpose || '').input('role', relation.role)
      .input('reimbursement_item_id', relation.reimbursementItemId).input('invoice_item_id', relation.invoiceItemId)
      .input('fn', a.filename || '')
      .input('sp', a.stored || null).input('sz', a.size == null ? null : Number(a.size)).input('ct', a.type || null)
      .input('uby', a.uploaded_by || null).input('uat', a.uploaded_at || null)
      .query(`UPDATE dbo.attachments SET purpose=@pur,document_role=@role,reimbursement_item_id=@reimbursement_item_id,
                invoice_item_id=@invoice_item_id,filename=@fn,stored_path=@sp,file_size=@sz,content_type=@ct,
                uploaded_by_username=@uby,uploaded_by_person_id=(SELECT person_id FROM dbo.users WHERE username=@uby),
                uploaded_by_role=(SELECT role FROM dbo.users WHERE username=@uby),updated_at=SYSUTCDATETIME()
              WHERE attachment_id=@attachment_id AND request_id=@rid;
              IF @@ROWCOUNT=0 INSERT INTO dbo.attachments
                (attachment_id,request_id,purpose,document_role,reimbursement_item_id,invoice_item_id,filename,stored_path,
                 file_size,content_type,uploaded_by_username,uploaded_by_person_id,uploaded_by_role,created_at,updated_at)
                VALUES (@attachment_id,@rid,@pur,@role,@reimbursement_item_id,@invoice_item_id,@fn,@sp,@sz,@ct,@uby,
                 (SELECT person_id FROM dbo.users WHERE username=@uby),(SELECT role FROM dbo.users WHERE username=@uby),
                 COALESCE(@uat,SYSUTCDATETIME()),COALESCE(@uat,SYSUTCDATETIME()));`);
  }
  await deleteMissingChildren(tx, 'attachments', 'attachment_id', id, attachmentIds);
  await writeSupplierForm(tx, 'request', id, row.supplier_form_data);
}

function bindRequestColumns(request, row) {
  for (const c of requestColumns()) {
    request.input(c, toDb(c, row[c]));
  }
  return request;
}

async function insertLog(tx, logRow) {
  if (!logRow) return;
  await new sql.Request(tx)
    .input('event_id', logRow.event_id)
    .input('request_id', logRow.request_id)
    .input('event_time', logRow.event_time)
    .input('event_type', logRow.event_type)
    .input('old_status', logRow.old_status || null)
    .input('new_status', logRow.new_status || null)
    .input('changed_by_person_id', logRow.changed_by_person_id || null)
    .input('changed_by_username', logRow.changed_by_username || null)
    .input('changed_by_role', logRow.changed_by_role || null)
    .input('changed_by', logRow.changed_by || null)
    .input('note', logRow.note || null)
    .query(`INSERT INTO dbo.request_status_log
      (event_id,request_id,event_time,event_type,old_status,new_status,changed_by_person_id,changed_by_username,changed_by_role,changed_by,note)
      VALUES (@event_id,@request_id,@event_time,@event_type,@old_status,@new_status,@changed_by_person_id,@changed_by_username,@changed_by_role,@changed_by,@note)`);
  const changes = parseObj(logRow.changed_fields);
  for (const [field, change] of Object.entries(changes)) {
    const oldValue = change && Object.prototype.hasOwnProperty.call(change, 'old') ? change.old : '';
    const newValue = change && Object.prototype.hasOwnProperty.call(change, 'new') ? change.new : '';
    await new sql.Request(tx)
      .input('change_id', crypto.randomUUID()).input('event_id', logRow.event_id).input('request_id', logRow.request_id)
      .input('field_name', field)
      .input('old_value', oldValue == null ? null : typeof oldValue === 'string' ? oldValue : JSON.stringify(oldValue))
      .input('new_value', newValue == null ? null : typeof newValue === 'string' ? newValue : JSON.stringify(newValue))
      .query(`INSERT INTO dbo.request_field_changes
        (change_id,event_id,request_id,field_name,old_value,new_value)
        VALUES (@change_id,@event_id,@request_id,@field_name,@old_value,@new_value)`);
  }
}

// ---- repository interface ----

module.exports = {
  kind: 'sql',
  supportsSupplierProfiles() { return true; },
  paths: null,
  isUnavailableError,

  async init() {
    const pool = await getPool();
    await assertSchema(pool);
  },
  async close() { if (poolPromise) { const p = await poolPromise; await p.close(); poolPromise = null; } },

  // Reads retry too. A plain SELECT holds no locks of its own, but createRequest runs
  // SERIALIZABLE and takes a range lock over the day's request ids, so a reader crossing
  // that range can be picked as the victim — which is how a requester opening their own
  // request got a 500 during the multi-user run.
  async getRequests() {
    return withDeadlockRetry(async () => {
    const pool = await getPool();
    const [reqs, items, invoiceItems, atts, profiles, banks] = await Promise.all([
      pool.request().query('SELECT * FROM dbo.requests'),
      // Attachments are clustered on a NEWID() primary key, so a SELECT without ORDER BY
      // hands them back in GUID order — the documents list shuffled itself between reads,
      // and differently again from the CSV backend's insertion order. Nothing keys off
      // the position (lookups are by purpose), but the list is rendered in array order.
      // reimbursement_items is ordered here too; rowFromDb already sorts by line_no, so
      // this only means the sort is handed a list that is already in order.
      pool.request().query('SELECT * FROM dbo.reimbursement_items ORDER BY request_id, line_no'),
      pool.request().query('SELECT * FROM dbo.invoice_items ORDER BY request_id, line_no'),
      pool.request().query('SELECT * FROM dbo.attachments ORDER BY request_id, created_at, purpose'),
      pool.request().query('SELECT * FROM dbo.request_supplier_profiles'),
      pool.request().query('SELECT * FROM dbo.request_supplier_bank_details'),
    ]);
    const itemsBy = groupBy(items.recordset, 'request_id');
    const invoiceItemsBy = groupBy(invoiceItems.recordset, 'request_id');
    const attsBy = groupBy(atts.recordset, 'request_id');
    const profilesBy = new Map(profiles.recordset.map((record) => [record.request_id, record]));
    const banksBy = new Map(banks.recordset.map((record) => [record.request_id, record]));
    return reqs.recordset.map((r) => rowFromDb(r, itemsBy, invoiceItemsBy, attsBy, profilesBy, banksBy));
    });
  },

  async getRequestById(id) {
    return withDeadlockRetry(async () => {
    const pool = await getPool();
    const [reqs, items, invoiceItems, atts, profiles, banks] = await Promise.all([
      pool.request().input('id', id).query('SELECT * FROM dbo.requests WHERE request_id=@id'),
      pool.request().input('id', id).query('SELECT * FROM dbo.reimbursement_items WHERE request_id=@id ORDER BY line_no'),
      pool.request().input('id', id).query('SELECT * FROM dbo.invoice_items WHERE request_id=@id ORDER BY line_no'),
      pool.request().input('id', id).query('SELECT * FROM dbo.attachments WHERE request_id=@id ORDER BY created_at, purpose'),
      pool.request().input('id', id).query('SELECT * FROM dbo.request_supplier_profiles WHERE request_id=@id'),
      pool.request().input('id', id).query('SELECT * FROM dbo.request_supplier_bank_details WHERE request_id=@id'),
    ]);
    const rec = reqs.recordset[0];
    if (!rec) return null;
    return rowFromDb(
      rec,
      groupBy(items.recordset, 'request_id'),
      groupBy(invoiceItems.recordset, 'request_id'),
      groupBy(atts.recordset, 'request_id'),
      new Map(profiles.recordset.map((record) => [record.request_id, record])),
      new Map(banks.recordset.map((record) => [record.request_id, record])),
    );
    });
  },

  async createRequest(row, logRow, idPrefix) {
    return withDeadlockRetry(async () => {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      if (row.request_id) {
        const existing = await new sql.Request(tx)
          .input('id', row.request_id)
          .query('SELECT TOP (1) request_id FROM dbo.requests WHERE request_id=@id');
        if (existing.recordset.length) {
          await tx.rollback();
          return { existing: true };
        }
      }
      const lock = await new sql.Request(tx)
        .input('resource', `frt-request-id:${idPrefix}`)
        .query("DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=15000; SELECT @r AS result;");
      if (!lock.recordset[0] || lock.recordset[0].result < 0) throw new Error('Could not allocate a request ID');
      const seq = await new sql.Request(tx).input('prefix', idPrefix).query(`
        SELECT ISNULL(MAX(TRY_CONVERT(int, SUBSTRING(request_id, LEN(@prefix) + 1, 20))), 0) + 1 AS next_no
        FROM dbo.requests WITH (UPDLOCK, HOLDLOCK)
        WHERE request_id LIKE @prefix + '%'
      `);
      if (!row.request_id) row.request_id = `${idPrefix}${String(seq.recordset[0].next_no).padStart(3, '0')}`;
      if (logRow) logRow.request_id = row.request_id;
      const cols = requestColumns();
      const req = bindRequestColumns(new sql.Request(tx), row);
      await req.query(`INSERT INTO dbo.requests (${cols.map((c) => `[${c}]`).join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`);
      await writeChildren(tx, row);
      await insertLog(tx, logRow);
      await tx.commit();
    } catch (e) { await abort(tx); throw e; }
    });
  },

  async updateRequest(row, logRow, expectedLastUpdatedAt) {
    return withDeadlockRetry(async () => {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const setCols = requestColumns().filter((c) => c !== 'request_id');
      const req = bindRequestColumns(new sql.Request(tx), row);
      req.input('_expected_last_updated_at', expectedLastUpdatedAt);
      const updated = await req.query(`UPDATE dbo.requests SET ${setCols.map((c) => `[${c}]=@${c}`).join(',')} WHERE request_id=@request_id AND last_updated_at=@_expected_last_updated_at`);
      if (!updated.rowsAffected[0]) throw conflict();
      await writeChildren(tx, row);
      await insertLog(tx, logRow);
      await tx.commit();
    } catch (e) { await abort(tx); throw e; }
    });
  },

  async hardDeleteRequest(id) {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const request = () => new sql.Request(tx).input('id', id);
      await request().query('DELETE FROM dbo.attachments WHERE request_id=@id');
      await request().query('DELETE FROM dbo.invoice_items WHERE request_id=@id');
      await request().query('DELETE FROM dbo.reimbursement_items WHERE request_id=@id');
      await request().query('DELETE FROM dbo.request_supplier_bank_details WHERE request_id=@id');
      await request().query('DELETE FROM dbo.request_supplier_profiles WHERE request_id=@id');
      await request().query('DELETE FROM dbo.request_field_changes WHERE request_id=@id');
      await request().query('DELETE FROM dbo.request_status_log WHERE request_id=@id');
      await request().query('DELETE FROM dbo.requests WHERE request_id=@id');
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
  },

  async getLog() {
    return withDeadlockRetry(async () => {
    const pool = await getPool();
    const [r, changed] = await Promise.all([
      pool.request().query('SELECT * FROM dbo.request_status_log ORDER BY event_time'),
      pool.request().query('SELECT event_id, field_name, old_value, new_value FROM dbo.request_field_changes ORDER BY event_id, field_name'),
    ]);
    const changesByEvent = new Map();
    for (const change of changed.recordset) {
      const key = String(change.event_id);
      if (!changesByEvent.has(key)) changesByEvent.set(key, {});
      changesByEvent.get(key)[change.field_name] = {
        old: change.old_value == null ? '' : String(change.old_value),
        new: change.new_value == null ? '' : String(change.new_value),
      };
    }
    return r.recordset.map((e) => ({
      event_id: String(e.event_id),
      request_id: e.request_id,
      event_time: e.event_time instanceof Date ? e.event_time.toISOString() : String(e.event_time || ''),
      event_type: e.event_type || '',
      old_status: e.old_status || '',
      new_status: e.new_status || '',
      changed_by_person_id: e.changed_by_person_id || '',
      changed_by_username: e.changed_by_username || '',
      changed_by_role: e.changed_by_role || '',
      changed_by: e.changed_by || '',
      note: e.note || '',
      changed_fields: changesByEvent.has(String(e.event_id)) ? JSON.stringify(changesByEvent.get(String(e.event_id))) : '',
    }));
    });
  },

  async getCreatedBy(requestId) {
    const pool = await getPool();
    const r = await pool.request().input('id', requestId).query(`
      SELECT TOP (1) changed_by_username, changed_by FROM dbo.request_status_log
      WHERE request_id=@id AND event_type='Created' ORDER BY event_time, event_id
    `);
    return r.recordset[0] ? String(r.recordset[0].changed_by_username || r.recordset[0].changed_by || '') : '';
  },

  async findAttachmentByStored(stored) {
    const pool = await getPool();
    const r = await pool.request().input('stored', stored).query(`
      SELECT TOP (1) request_id, purpose, filename, stored_path AS stored, file_size AS size, content_type AS type
      FROM dbo.attachments WHERE stored_path=@stored
    `);
    return r.recordset[0] || null;
  },

  async getCostCodes() {
    const pool = await getPool();
    const r = await pool.request().query('SELECT cost_code, description FROM dbo.cost_codes ORDER BY cost_code');
    return r.recordset.map((x) => ({ cost_code: x.cost_code, description: x.description || '' }));
  },
  async getActivityCodes() {
    const pool = await getPool();
    const r = await pool.request().query('SELECT activity_code, cost_code, description FROM dbo.activity_codes ORDER BY activity_code');
    return r.recordset.map((x) => ({ activity_code: x.activity_code, cost_code: x.cost_code || '', description: x.description || '' }));
  },
  async getPeople() {
    const pool = await getPool();
    const r = await pool.request().query('SELECT person_id, display_name, email, active, can_request, can_travel, can_approve, can_process FROM dbo.people ORDER BY display_name');
    return r.recordset.map((person) => ({
      person_id: person.person_id,
      display_name: person.display_name,
      email: person.email || '',
      active: person.active ? 'Yes' : 'No',
      can_request: person.can_request ? 'Yes' : 'No',
      can_travel: person.can_travel ? 'Yes' : 'No',
      can_approve: person.can_approve ? 'Yes' : 'No',
      can_process: person.can_process ? 'Yes' : 'No',
    }));
  },
  async createPerson(row) {
    return withDeadlockRetry(async () => {
    const pool = await getPool();
    const tx = new sql.Transaction(pool); await tx.begin();
    try {
      const seq = await new sql.Request(tx).query("SELECT ISNULL(MAX(TRY_CONVERT(int, SUBSTRING(person_id, 5, 20))),0)+1 AS next_no FROM dbo.people WITH (UPDLOCK,HOLDLOCK) WHERE person_id LIKE 'PER-%'");
      row.person_id = `PER-${String(seq.recordset[0].next_no).padStart(3, '0')}`;
      await new sql.Request(tx)
        .input('id', row.person_id).input('name', row.display_name).input('email', row.email || null)
        .input('email_normalized', row.email ? String(row.email).trim().toLowerCase() : null)
        .input('active', row.active === 'Yes').input('request', row.can_request === 'Yes')
        .input('travel', row.can_travel === 'Yes').input('approve', row.can_approve === 'Yes').input('process', row.can_process === 'Yes')
        .query('INSERT INTO dbo.people (person_id,display_name,email,email_normalized,active,can_request,can_travel,can_approve,can_process) VALUES (@id,@name,@email,@email_normalized,@active,@request,@travel,@approve,@process)');
      await tx.commit();
    } catch (error) {
      await abort(tx);
      if (sqlErrorNumber(error) === 2601 || sqlErrorNumber(error) === 2627) {
        throw conflict('That email address is already assigned to another person.');
      }
      throw error;
    }
    });
  },
  async updatePerson(row) {
    const pool = await getPool();
    let result;
    try { result = await pool.request()
      .input('id', row.person_id).input('name', row.display_name).input('email', row.email || null)
      .input('email_normalized', row.email ? String(row.email).trim().toLowerCase() : null)
      .input('active', row.active === 'Yes').input('request', row.can_request === 'Yes')
      .input('travel', row.can_travel === 'Yes').input('approve', row.can_approve === 'Yes').input('process', row.can_process === 'Yes')
      .query('UPDATE dbo.people SET display_name=@name,email=@email,email_normalized=@email_normalized,active=@active,can_request=@request,can_travel=@travel,can_approve=@approve,can_process=@process WHERE person_id=@id');
    } catch (error) {
      if (sqlErrorNumber(error) === 2601 || sqlErrorNumber(error) === 2627) {
        throw conflict('That email address is already assigned to another person.');
      }
      throw error;
    }
    if (!result.rowsAffected[0]) throw conflict('Person no longer exists.');
  },
  async getSuppliers() {
    const pool = await getPool();
    const r = await pool.request().query("SELECT supplier_id, legal_entity_name, abn, purchase_order_email, vendor_id FROM dbo.suppliers WHERE status = 'Approved' AND deleted = 0 ORDER BY legal_entity_name");
    return r.recordset.map((x) => ({
      supplier_id: x.supplier_id, supplier_name: (x.legal_entity_name || '').trim(),
      abn: (x.abn || '').trim(), purchase_order_email: (x.purchase_order_email || '').trim(),
      vendor_id: (x.vendor_id || '').trim(),
    }));
  },
  async getSuppliersAll() {
    const pool = await getPool();
    const [r, profiles, banks] = await Promise.all([
      pool.request().query('SELECT * FROM dbo.suppliers ORDER BY legal_entity_name'),
      pool.request().query('SELECT * FROM dbo.supplier_profiles'),
      pool.request().query('SELECT * FROM dbo.supplier_bank_details'),
    ]);
    const profilesBy = new Map(profiles.recordset.map((record) => [record.supplier_id, record]));
    const banksBy = new Map(banks.recordset.map((record) => [record.supplier_id, record]));
    return r.recordset.map((record) => supplierFromDb(record, profilesBy.get(record.supplier_id), banksBy.get(record.supplier_id)));
  },
  async getSupplierById(id) {
    const pool = await getPool();
    const [r, profiles, banks] = await Promise.all([
      pool.request().input('id', id).query('SELECT * FROM dbo.suppliers WHERE supplier_id=@id'),
      pool.request().input('id', id).query('SELECT * FROM dbo.supplier_profiles WHERE supplier_id=@id'),
      pool.request().input('id', id).query('SELECT * FROM dbo.supplier_bank_details WHERE supplier_id=@id'),
    ]);
    return r.recordset[0] ? supplierFromDb(r.recordset[0], profiles.recordset[0], banks.recordset[0]) : null;
  },
  async createSupplier(row, idPrefix) {
    return withDeadlockRetry(async () => {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const lock = await new sql.Request(tx)
        .input('resource', `frt-supplier-id:${idPrefix}`)
        .query("DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=15000; SELECT @r AS result;");
      if (!lock.recordset[0] || lock.recordset[0].result < 0) throw new Error('Could not allocate a supplier ID');
      if (String(row.vendor_id || '').trim()) {
        const duplicate = await new sql.Request(tx).input('vendor_id', row.vendor_id).query(`
          SELECT TOP (1) supplier_id FROM dbo.suppliers WITH (UPDLOCK, HOLDLOCK)
          WHERE vendor_id=@vendor_id
        `);
        if (duplicate.recordset.length) throw conflict(`Vendor ID ${row.vendor_id} is already assigned.`);
      }
      const seq = await new sql.Request(tx).input('prefix', idPrefix).query(`
        SELECT ISNULL(MAX(TRY_CONVERT(int, SUBSTRING(supplier_id, LEN(@prefix) + 1, 20))), 0) + 1 AS next_no
        FROM dbo.suppliers WITH (UPDLOCK, HOLDLOCK)
        WHERE supplier_id LIKE @prefix + '%'
      `);
      row.supplier_id = `${idPrefix}${String(seq.recordset[0].next_no).padStart(3, '0')}`;
      const req = new sql.Request(tx);
      for (const c of supplierColumns()) req.input(c, supplierToDb(c, row[c]));
      await req.query(`INSERT INTO dbo.suppliers (${supplierColumns().map((c) => `[${c}]`).join(',')}) VALUES (${supplierColumns().map((c) => '@' + c).join(',')})`);
      await writeSupplierForm(tx, 'supplier', row.supplier_id, row.supplier_form_data);
      await tx.commit();
    } catch (e) { await abort(tx); throw e; }
    });
  },
  // One-time CSV import path: preserve the supplier's existing stable ID while using
  // the same typed profile/bank writer as normal supplier creation.
  async importSupplier(row) {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const request = new sql.Request(tx);
      for (const column of supplierColumns()) request.input(column, supplierToDb(column, row[column]));
      const columns = supplierColumns();
      const updateColumns = columns.filter((column) => column !== 'supplier_id');
      await request.query(`
        UPDATE dbo.suppliers SET ${updateColumns.map((column) => `[${column}]=@${column}`).join(',')}
        WHERE supplier_id=@supplier_id;
        IF @@ROWCOUNT=0 INSERT INTO dbo.suppliers (${columns.map((column) => `[${column}]`).join(',')})
          VALUES (${columns.map((column) => `@${column}`).join(',')});`);
      await writeSupplierForm(tx, 'supplier', row.supplier_id, row.supplier_form_data);
      await tx.commit();
    } catch (error) { await abort(tx); throw error; }
  },
  async updateSupplier(row, expectedLastUpdatedAt) {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const req = new sql.Request(tx);
      for (const c of supplierColumns()) req.input(c, supplierToDb(c, row[c]));
      req.input('_expected_last_updated_at', expectedLastUpdatedAt);
      const setCols = supplierColumns().filter((c) => c !== 'supplier_id');
      const updated = await req.query(`UPDATE dbo.suppliers SET ${setCols.map((c) => `[${c}]=@${c}`).join(',')} WHERE supplier_id=@supplier_id AND last_updated_at=@_expected_last_updated_at`);
      if (!updated.rowsAffected[0]) throw conflict('The supplier was changed by another user. Refresh and try again.');
      await writeSupplierForm(tx, 'supplier', row.supplier_id, row.supplier_form_data);
      await tx.commit();
    } catch (error) { await abort(tx); throw error; }
  },

  // person_active is joined in rather than fetched separately because resolving a session
  // checks both on every API request: the People directory's Active switch disables the
  // login, so it has to be as cheap to read as the account row itself.
  async getUserByUsername(username) {
    const pool = await getPool();
    const r = await pool.request().input('u', username).query(
      `SELECT u.*, p.active AS person_active FROM dbo.users u
       LEFT JOIN dbo.people p ON p.person_id = u.person_id
       WHERE u.username = @u`);
    const rec = r.recordset[0];
    if (!rec) return null;
    return {
      username: rec.username, password_hash: rec.password_hash, role: rec.role,
      person_id: rec.person_id || '', display_name: rec.display_name || '', active: rec.active ? 'Yes' : 'No',
      password_version: String(rec.password_version == null ? 0 : rec.password_version),
      person_active: rec.person_active == null ? '' : (rec.person_active ? 'Yes' : 'No'),
    };
  },
  async getUsers() {
    const pool = await getPool();
    const r = await pool.request().query('SELECT username, role, person_id, display_name, active, password_version FROM dbo.users ORDER BY username');
    return r.recordset.map((rec) => ({
      username: rec.username, role: rec.role, person_id: rec.person_id || '',
      display_name: rec.display_name || '', active: rec.active ? 'Yes' : 'No',
      password_version: String(rec.password_version == null ? 0 : rec.password_version),
    }));
  },
  async createUser(row) {
    const pool = await getPool();
    await pool.request()
      .input('username', row.username)
      .input('password_hash', row.password_hash)
      .input('role', row.role)
      .input('person_id', row.person_id || null)
      .input('display_name', row.display_name || null)
      .input('active', String(row.active) === 'No' ? 0 : 1)
      .input('password_version', Number(row.password_version) || 0)
      .query(`MERGE dbo.users AS t USING (SELECT @username AS username) AS s ON t.username = s.username
              WHEN MATCHED THEN UPDATE SET password_hash=@password_hash, role=@role, person_id=@person_id, display_name=@display_name, active=@active, password_version=@password_version
              WHEN NOT MATCHED THEN INSERT (username, password_hash, role, person_id, display_name, active, password_version) VALUES (@username,@password_hash,@role,@person_id,@display_name,@active,@password_version);`);
  },
  // Self-registration's create. createUser is an upsert (db/createUser.js resets passwords
  // with it); exposing that behaviour on a public endpoint would let anyone "register" an
  // existing username and overwrite that account's password.
  async createUserIfAbsent(row) {
    const pool = await getPool();
    try {
      await pool.request()
        .input('username', row.username)
        .input('password_hash', row.password_hash)
        .input('role', row.role)
        .input('person_id', row.person_id || null)
        .input('display_name', row.display_name || null)
        .input('active', String(row.active) === 'No' ? 0 : 1)
        .input('password_version', Number(row.password_version) || 0)
        .query(`INSERT INTO dbo.users (username, password_hash, role, person_id, display_name, active, password_version)
                VALUES (@username,@password_hash,@role,@person_id,@display_name,@active,@password_version)`);
    } catch (err) {
      // 2627/2601: primary key or unique index violation — someone registered first.
      if (err && (err.number === 2627 || err.number === 2601)) throw conflict('That account already exists.');
      throw err;
    }
  },
  async registerUser(row, personInput) {
    return withDeadlockRetry(async () => {
      const pool = await getPool();
      const tx = new sql.Transaction(pool);
      await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      try {
        const existingUser = await new sql.Request(tx).input('username', row.username)
          .query('SELECT TOP (1) username FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE username=@username');
        if (existingUser.recordset.length) throw conflict('That account already exists.');

        const personResult = await new sql.Request(tx).input('email', personInput.email).query(`
          SELECT TOP (1) person_id, display_name, email, active
          FROM dbo.people WITH (UPDLOCK, HOLDLOCK)
          WHERE email_normalized = LOWER(LTRIM(RTRIM(@email)))`);
        let person = personResult.recordset[0] || null;
        const matchedExistingPerson = !!person;
        if (person && !person.active) {
          throw conflict('That email address belongs to a deactivated person. Contact Business Services.');
        }
        if (!person) {
          const lock = await new sql.Request(tx)
            .input('resource', 'frt-person-id')
            .query("DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=15000; SELECT @r AS result;");
          if (!lock.recordset[0] || lock.recordset[0].result < 0) throw new Error('Could not allocate a person ID');
          const seq = await new sql.Request(tx).query("SELECT ISNULL(MAX(TRY_CONVERT(int, SUBSTRING(person_id, 5, 20))),0)+1 AS next_no FROM dbo.people WITH (UPDLOCK,HOLDLOCK) WHERE person_id LIKE 'PER-%'");
          const personId = `PER-${String(seq.recordset[0].next_no).padStart(3, '0')}`;
          await new sql.Request(tx)
            .input('id', personId).input('name', personInput.display_name).input('email', personInput.email)
            .input('email_normalized', String(personInput.email).trim().toLowerCase())
            .input('active', personInput.active === 'Yes').input('request', personInput.can_request === 'Yes')
            .input('travel', personInput.can_travel === 'Yes').input('approve', personInput.can_approve === 'Yes')
            .input('process', personInput.can_process === 'Yes')
            .query('INSERT INTO dbo.people (person_id,display_name,email,email_normalized,active,can_request,can_travel,can_approve,can_process) VALUES (@id,@name,@email,@email_normalized,@active,@request,@travel,@approve,@process)');
          person = { person_id: personId, display_name: personInput.display_name, email: personInput.email, active: true };
        }

        const linked = await new sql.Request(tx).input('person_id', person.person_id)
          .query('SELECT TOP (1) username FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE person_id=@person_id');
        if (linked.recordset.length) throw conflict('That person already has an account. Sign in instead.');

        if (matchedExistingPerson) {
          await new sql.Request(tx)
            .input('person_id', person.person_id)
            .input('name', personInput.display_name)
            .query('UPDATE dbo.people SET display_name=@name WHERE person_id=@person_id');
          person.display_name = personInput.display_name;
        }
        const account = { ...row, person_id: person.person_id, display_name: person.display_name };
        await new sql.Request(tx)
          .input('username', account.username).input('password_hash', account.password_hash)
          .input('role', account.role).input('person_id', account.person_id)
          .input('display_name', account.display_name).input('active', 1).input('password_version', 0)
          .query(`INSERT INTO dbo.users (username,password_hash,role,person_id,display_name,active,password_version)
                  VALUES (@username,@password_hash,@role,@person_id,@display_name,@active,@password_version)`);
        await tx.commit();
        return { account, person };
      } catch (error) {
        await abort(tx);
        if (sqlErrorNumber(error) === 2601 || sqlErrorNumber(error) === 2627) {
          throw conflict('That email address or account was registered by another user. Sign in instead.');
        }
        throw error;
      }
    });
  },
  async updateUser(row) {
    const pool = await getPool();
    const columns = ['password_hash', 'role', 'active', 'password_version']
      .filter((column) => Object.prototype.hasOwnProperty.call(row, column));
    if (!columns.length) return;
    const request = pool.request().input('username', row.username);
    for (const column of columns) {
      if (column === 'active') request.input(column, String(row[column]) === 'No' ? 0 : 1);
      else if (column === 'password_version') request.input(column, Number(row[column]) || 0);
      else request.input(column, row[column]);
    }
    const updated = await request.query(
      `UPDATE dbo.users SET ${columns.map((c) => `${c}=@${c}`).join(',')} WHERE username=@username`);
    if (!updated.rowsAffected[0]) throw conflict('That account no longer exists.');
  },
};
