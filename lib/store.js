'use strict';

// Business/domain layer. Storage is delegated to a pluggable async repository
// (CSV or SQL Server), chosen by the STORAGE env var. All public methods are async.
// The domain rules (validation, status side effects, derived fields, IDs) live here so
// both backends behave identically.

const crypto = require('crypto');
const validate = require('./validate');
const auth = require('./auth');
const notify = require('./notify');
const {
  CURRENT_COLUMNS,
  REQUEST_TYPES,
  STATUSES,
  STATUSES_BY_TYPE,
  TERMINAL_STATUSES,
  ALLOWED_TRANSITIONS_BY_TYPE,
  SUBTYPES_BY_TYPE,
  requiredFieldsFor, DEFAULT_COST_CODE,
  WAITING_ON_BY_STATUS,
  REIMBURSEMENT_CATEGORIES,
  REIMBURSEMENT_DESCRIPTION_REQUIRED,
  REQUIRED_ATTACHMENTS_BY_SUBTYPE,
  ALLOWED_ATTACHMENTS_BY_SUBTYPE,
  ATTACHMENT_PURPOSES,
  ADMIN_ONLY_ATTACHMENT_PURPOSES,
  MAX_REIMBURSEMENT_ITEMS,
  MAX_INVOICE_ITEMS,
  MAX_ATTACHMENTS_PER_REQUEST,
  MAX_ATTACHMENT_BYTES_PER_REQUEST,
  MAX_OPEN_DRAFTS_PER_REQUESTER,
  PROCUREMENT_SUBMIT_TO_ADMIN,
  PROCUREMENT_SUBMIT_TO_APPROVER,
  PROCUREMENT_RETURN_TO_REQUESTOR,
  PROCUREMENT_REQUISITION_SUBMITTED,
  PROCUREMENT_PO_ISSUED,
  PROCUREMENT_INVOICE_RECEIVED,
  PROCUREMENT_RECEIVED_ORDER_LINES,
  PROCUREMENT_AP_INVOICES_SENT,
  PROCUREMENT_POSTED_INVOICE,
  PROCUREMENT_CLOSED,
  UPDATED_AND_RESUBMITTED,
  SUPPLIER_COLUMNS,
  SUPPLIER_STATUSES,
  PROCUREMENT_TYPE,
  TRAVEL_TYPE,
  TRAVEL_ALLOWANCE_TYPE,
  REIMBURSEMENT_TYPE,
  SUPPLIER_SETUP_TYPE,
  SUPPLIER_NEW,
  SUPPLIER_AMEND,
  TRAVEL_REIMBURSEMENT,
  ROLES,
  SUPPLIER_PROFILE_FIELDS,
  SUPPLIER_BANK_FIELDS,
} = require('./constants');

// Pick the storage backend. repoSql is only required when actually selected.
const repo = String(process.env.STORAGE || '').trim().toLowerCase() === 'sql'
  ? require('./repoSql') : require('./repoCsv');

// Fields stored as inline JSON (arrays) at the domain boundary.
const JSON_FIELDS = new Set(['reimbursement_items', 'attachments', 'supplier_form_data', 'invoice_items']);

// Fields a user (requester or admin) may set/change on update.
const UPDATABLE_FIELDS = [
  'current_status', 'waiting_on', 'next_action', 'external_ref', 'invoice_number',
  'purchase_order', 'evidence_provided', 'amount', 'amount_ex_gst', 'currency',
  'cost_code', 'cost_code_other', 'activity_code', 'activity_code_other', 'spending_approver', 'due_date', 'sub_type',
  'beneficiary_person_id', 'beneficiary_name', 'legal_entity_name', 'abn', 'purchase_order_email', 'vendor_id',
  'supplier_id', 'supplier_quote_number', 'short_description', 'gst_entry_method',
  'supplier_type', 'close_reason', 'invoice_items',
  'spending_approver_person_id', 'processed_by_person_id',
  'gst_amount', 'amount_inc_gst', 'travel_start_date',
  'travel_end_date', 'destination', 'has_attachments', 'processed_by', 'notes',
  'reimbursement_items', 'attachments', 'supplier_form_data',
  'po_number', 'po_issued_at', 'invoice_received_at', 'invoice_gst_entry_method',
  'invoice_amount_ex_gst', 'invoice_gst_amount', 'invoice_amount',
  'chk_po_included', 'chk_desc_matches_po', 'chk_service_completed',
  'chk_forwarded_to_approver', 'chk_forwarded_with_approval',
];
const UPDATE_META_FIELDS = ['note', 'internal_note'];
// Create writes straight into the row, so its allow-list is the column set itself.
const CREATE_ALLOWED_FIELDS = new Set([...CURRENT_COLUMNS, ...UPDATE_META_FIELDS]);
const YES_NO_FIELDS = [
  'evidence_provided', 'has_attachments', 'chk_po_included', 'chk_desc_matches_po',
  'chk_service_completed', 'chk_forwarded_to_approver', 'chk_forwarded_with_approval',
];
const OPTIONAL_DATE_FIELDS = ['due_date', 'travel_start_date', 'travel_end_date'];
const SUPPLIER_EVIDENCE_TYPES = [
  'Signed supplier letter', 'Quote or tax invoice', 'Financial institution letter', 'Bank statement',
];
const AUSTRALIAN_STATE_CODES = new Set(['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA']);
// ---- timezone helpers ----
const APP_TZ = process.env.TZ || 'Australia/Sydney';
const _tzFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function tzParts(d = new Date()) {
  const out = {};
  for (const p of _tzFmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}
function pad(n, width) { return String(n).padStart(width, '0'); }
function dateStamp(d = new Date()) { const p = tzParts(d); return `${p.year}${p.month}${p.day}`; }
function localDate(d = new Date()) { const p = tzParts(d); return `${p.year}-${p.month}-${p.day}`; }
function nowIso() { return new Date().toISOString(); }

function nextEventId() { return crypto.randomUUID(); }

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, 'i');

function stableId(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return UUID_RE.test(candidate) ? candidate : crypto.randomUUID();
}

function withStableItemIds(value, previousValue) {
  const items = parseJsonArray(value);
  if (!Array.isArray(items)) return value;
  const previous = parseJsonArray(previousValue);
  return items.map((item, index) => ({
    ...(item && typeof item === 'object' ? item : {}),
    item_id: stableId(item && item.item_id || (Array.isArray(previous) && previous[index] && previous[index].item_id)),
  }));
}

function withoutReimbursementSupplier(items) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    const clean = { ...(item && typeof item === 'object' ? item : {}) };
    delete clean.supplier;
    return clean;
  });
}

function withStableAttachmentIds(value, previousValue) {
  const attachments = parseJsonArray(value);
  if (!Array.isArray(attachments)) return value;
  const previous = parseJsonArray(previousValue);
  return attachments.map((attachment) => {
    const current = attachment && typeof attachment === 'object' ? attachment : {};
    const match = Array.isArray(previous)
      ? previous.find((candidate) => candidate && candidate.purpose === current.purpose)
      : null;
    return { ...current, attachment_id: stableId(current.attachment_id || (match && match.attachment_id)) };
  });
}

// The API and CSV backend keep collection fields as JSON, while SQL stores the same
// records in child tables. IDs are assigned at the domain boundary so both backends
// expose the same stable keys and an edit updates a child row instead of replacing it.
function assignStableCollectionIds(row, previousRow = {}) {
  const reimbursementItems = withoutReimbursementSupplier(
    withStableItemIds(row.reimbursement_items, previousRow.reimbursement_items),
  );
  const invoiceItems = withStableItemIds(row.invoice_items, previousRow.invoice_items);
  const attachments = withStableAttachmentIds(row.attachments, previousRow.attachments);
  if (Array.isArray(reimbursementItems)) row.reimbursement_items = reimbursementItems.length ? JSON.stringify(reimbursementItems) : '';
  if (Array.isArray(invoiceItems)) row.invoice_items = invoiceItems.length ? JSON.stringify(invoiceItems) : '';
  if (Array.isArray(attachments)) row.attachments = attachments.length ? JSON.stringify(attachments) : '';
}

async function actorSnapshot(username) {
  const value = String(username || '').trim();
  let account = null;
  if (value) {
    try { account = await repo.getUserByUsername(value); } catch (_) { /* audit keeps the supplied username */ }
  }
  return {
    changed_by_person_id: account && account.person_id || '',
    changed_by_username: account && account.username || value,
    changed_by_role: account && account.role || '',
    // Kept as the display-compatible audit label and CSV ownership fallback.
    changed_by: value,
  };
}

function nextVersionIso(previous) {
  const prevMs = Date.parse(previous || '');
  return new Date(Math.max(Date.now(), Number.isFinite(prevMs) ? prevMs + 1 : 0)).toISOString();
}

function mapRepoError(err) {
  if (err && err.code === 'FRT_CONFLICT') return new StoreError(err.message, 409);
  return err;
}

function emptyRow() {
  const row = {};
  for (const c of CURRENT_COLUMNS) row[c] = '';
  return row;
}

// Status-driven side effects: derive waiting_on and stamp lifecycle dates.
function applyStatusSideEffects(row, oldStatus, newStatus) {
  if (Object.prototype.hasOwnProperty.call(WAITING_ON_BY_STATUS, newStatus)) {
    row.waiting_on = WAITING_ON_BY_STATUS[newStatus];
  }
  if (newStatus === oldStatus) return;
  const stampIfEmpty = (f) => { if (!String(row[f] || '').trim()) row[f] = nowIso(); };
  switch (newStatus) {
    case PROCUREMENT_SUBMIT_TO_ADMIN:
    case 'Submitted': stampIfEmpty('submitted_at'); break;
    case 'Accepted by Finance': stampIfEmpty('accepted_at'); break;
    case PROCUREMENT_RETURN_TO_REQUESTOR:
    case 'Returned for Info': row.returned_for_info_at = nowIso(); break;
    case PROCUREMENT_PO_ISSUED: stampIfEmpty('po_issued_at'); break;
    case PROCUREMENT_INVOICE_RECEIVED: stampIfEmpty('invoice_received_at'); break;
    case PROCUREMENT_CLOSED:
    case 'Completed': stampIfEmpty('completed_at'); if (!row.completed_date) row.completed_date = localDate(); break;
    default: break;
  }
}

// ---- reimbursement lines + attachments (inline JSON) ----
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  const s = String(value == null ? '' : value).trim();
  if (s === '') return [];
  try { const p = JSON.parse(s); return Array.isArray(p) ? p : []; } catch (e) { return null; }
}
const parseItems = parseJsonArray;
const parseAttachments = parseJsonArray;

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  const s = String(value == null ? '' : value).trim();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) { return null; }
}

function latestApprovedSupplierSetup(rows, supplierId) {
  return rows
    .filter((r) => r.request_type === SUPPLIER_SETUP_TYPE && r.current_status === 'Approved' &&
      String(r.deleted || '') !== 'Yes' && String(r.supplier_id || '') === String(supplierId || ''))
    .sort((a, b) => String(b.completed_at || b.last_updated_at || '').localeCompare(String(a.completed_at || a.last_updated_at || '')))[0] || null;
}

function copyBankDetails(target, source) {
  for (const field of SUPPLIER_BANK_FIELDS) target[field] = String(source[field] == null ? '' : source[field]);
}

async function hydrateUnchangedSupplierBank(row, previousRow) {
  if (row.request_type !== SUPPLIER_SETUP_TYPE) return;
  const data = parseJsonObject(row.supplier_form_data);
  if (!data || data.bank_details_action !== 'Unchanged') return;

  let sourceRow = null;
  let source = null;
  if (previousRow && previousRow.request_id === row.request_id) {
    const previousData = parseJsonObject(previousRow.supplier_form_data) || {};
    if (String(previousData.account_number || '').trim()) { sourceRow = previousRow; source = previousData; }
  }
  if (!sourceRow && row.sub_type === SUPPLIER_AMEND && row.supplier_id) {
    sourceRow = latestApprovedSupplierSetup(await repo.getRequests(), row.supplier_id);
    if (sourceRow) source = parseJsonObject(sourceRow.supplier_form_data) || {};
  }
  if ((!source || !String(source.account_number || '').trim()) && row.sub_type === SUPPLIER_AMEND && row.supplier_id) {
    const master = (await repo.getSuppliersAll()).find((s) => s.supplier_id === row.supplier_id);
    const masterData = master ? (parseJsonObject(master.supplier_form_data) || {}) : {};
    if (String(masterData.account_number || '').trim()) {
      sourceRow = { request_id: `supplier-master:${row.supplier_id}` };
      source = masterData;
    }
  }
  if (!sourceRow) {
    throw new StoreError('Validation failed', 400, {
      supplier_form_data: 'Existing bank details are unavailable; choose Change bank details and enter them again',
    });
  }

  if (!String(source.account_number || '').trim()) {
    throw new StoreError('Validation failed', 400, {
      supplier_form_data: 'Existing bank details are unavailable; choose Change bank details and enter them again',
    });
  }
  copyBankDetails(data, source);
  data.bank_details_action = 'Unchanged';
  data.bank_details_source_request_id = sourceRow.request_id;
  row.supplier_form_data = JSON.stringify(data);
}

function validateSupplierSetupForm(row, add, partial = false) {
  const data = parseJsonObject(row.supplier_form_data);
  if (data === null) { add('supplier_form_data', 'is not valid JSON'); return; }
  if (row.sub_type === SUPPLIER_AMEND && !data.bank_details_action && String(data.account_number || '').trim()) {
    data.bank_details_action = 'Change';
  }
  if (row.sub_type === SUPPLIER_AMEND && data.bank_details_action && !['Unchanged', 'Change'].includes(data.bank_details_action)) {
    add('supplier_form_data', 'bank details selection must be Unchanged or Change');
  }
  if (row.sub_type === SUPPLIER_NEW) data.bank_details_action = 'Change';
  const required = [
    'legal_entity_name', 'street_address', 'suburb', 'country', 'postcode',
    'contact_name', 'contact_phone', 'contact_email', 'purchase_order_email',
    'nt_enterprise', 'bank_type', 'bank_name', 'bank_branch_address', 'bank_account_name',
    'account_number', 'terms_accepted', 'declaration_confirmed', 'has_abn',
  ];
  if (data.bank_details_action !== 'Unchanged') required.push('supporting_document_type');
  if (String(data.country || '').trim().toLowerCase() === 'australia') required.push('state_region');
  if (data.has_abn === 'Yes') required.push('abn'); else if (data.has_abn === 'No') required.push('no_abn_reason');
  else if (!partial || data.has_abn) add('supplier_form_data', 'ABN selection must be Yes or No');
  if (data.bank_type === 'Australian EFT') required.push('bsb');
  else if (data.bank_type === 'International TT') required.push('bank_account_currency', 'payment_currency', 'swift_sort_bank_code');
  else if (!partial || data.bank_type) add('supplier_form_data', 'bank type must be Australian EFT or International TT');
  if (!partial) for (const field of required) {
    if (String(data[field] == null ? '' : data[field]).trim() === '') add('supplier_form_data', `${field.replace(/_/g, ' ')} is required`);
  }
  for (const field of ['contact_email', 'purchase_order_email', 'remittance_email']) {
    const value = String(data[field] || '').trim();
    if (value) { const err = validate.validateEmail(value); if (err) add('supplier_form_data', `${field.replace(/_/g, ' ')} ${err}`); }
  }
  if (data.has_abn === 'Yes' && data.abn) {
    const { value, error } = validate.normalizeAbn(data.abn);
    data.abn = value;
    if (error) add('supplier_form_data', `ABN ${error}`);
  } else if (data.has_abn === 'No') data.abn = '';
  if (data.bank_type === 'Australian EFT' && data.bsb && !/^\d{6}$/.test(String(data.bsb).replace(/[-\s]/g, ''))) {
    add('supplier_form_data', 'BSB must contain exactly 6 digits');
  } else if (data.bsb) data.bsb = String(data.bsb).replace(/[-\s]/g, '');
  if (data.declaration_date) {
    const err = validate.validateDate(data.declaration_date);
    if (err) add('supplier_form_data', `declaration date ${err}`);
  }
  if (!partial && data.terms_accepted !== 'Yes') add('supplier_form_data', 'purchase order terms must be accepted');
  if (!partial && data.declaration_confirmed !== 'Yes') add('supplier_form_data', 'authorised representative declaration must be confirmed');
  if (data.nt_enterprise && !['Yes', 'No'].includes(data.nt_enterprise)) add('supplier_form_data', 'NT enterprise must be Yes or No');
  if (data.supporting_document_type && !SUPPLIER_EVIDENCE_TYPES.includes(data.supporting_document_type)) {
    add('supplier_form_data', 'supporting document type is not recognised');
  }
  if (String(data.country || '').trim().toLowerCase() === 'australia'
      && data.state_region && !AUSTRALIAN_STATE_CODES.has(String(data.state_region).trim())) {
    add('supplier_form_data', 'state/region must be an Australian state or territory');
  }
  row.supplier_form_data = JSON.stringify(data);
  row.legal_entity_name = String(data.legal_entity_name || '').trim();
  row.abn = String(data.abn || '').trim();
  row.purchase_order_email = String(data.purchase_order_email || '').trim();
}

function reimbursementTotal(items) {
  let total = 0;
  for (const it of items) {
    const inclusive = String(it && it.amount || '').trim();
    const exclusive = String(it && it.amount_ex_gst || '').trim();
    const n = Number(inclusive || exclusive);
    if (Number.isFinite(n)) total += n;
  }
  return String(Math.round(total * 100) / 100);
}

const money = (value) => Math.round(Number(value) * 100) / 100;

function normaliseGstAmounts(target, fields, add, required, label = '') {
  const prefix = label ? `${label}: ` : '';
  // Legacy payloads are accepted at the domain boundary so old drafts can still be
  // opened and corrected; the current UI never emits this selector or GST amount field.
  if (fields.mode && String(target[fields.mode] || '').trim()) {
    const mode = String(target[fields.mode]).trim();
    if (mode === 'Total includes GST') {
      if (!String(target[fields.total] || '').trim()) { if (required) add(fields.total, `${prefix}total including GST is required`); return; }
      const total = money(target[fields.total]);
      const gstText = String(target[fields.gst] || '').trim();
      const gst = gstText ? money(gstText) : 0;
      target[fields.total] = String(total); target[fields.ex] = gstText ? String(money(total - gst)) : '';
      if (gstText) target[fields.gst] = String(gst);
      return;
    }
    if (mode === 'Enter GST separately') {
      if (!String(target[fields.ex] || '').trim() || !String(target[fields.gst] || '').trim()) { if (required) add(fields.ex, `${prefix}amounts are required`); return; }
      target[fields.ex] = String(money(target[fields.ex])); target[fields.gst] = String(money(target[fields.gst]));
      target[fields.total] = String(money(Number(target[fields.ex]) + Number(target[fields.gst]))); return;
    }
  }
  const needed = [fields.ex, fields.total];
  const present = needed.filter((field) => String(target[field] || '').trim() !== '');
  if (!present.length) {
    if (required) add(fields.ex, `${prefix}enter either total excluding GST or total including GST`);
    return;
  }
  for (const field of present) {
    const error = validate.validateAmount(target[field]);
    if (error) add(field, `${prefix}${error}`);
  }
  if (present.some((field) => validate.validateAmount(target[field]))) return;
  if (String(target[fields.ex] || '').trim() !== '') target[fields.ex] = String(money(target[fields.ex]));
  if (String(target[fields.total] || '').trim() !== '') target[fields.total] = String(money(target[fields.total]));
  if (target[fields.ex] && target[fields.total] && money(target[fields.total]) < money(target[fields.ex])) {
    add(fields.total, `${prefix}total including GST cannot be less than total excluding GST`);
  }
}

function validateReimbursementItems(row, add) {
  const items = parseItems(row.reimbursement_items);
  if (items === null) { add('reimbursement_items', 'is not valid JSON'); return; }
  if (items.length === 0) { add('reimbursement_items', 'at least one expense line is required'); return; }
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const label = `line ${i + 1}`;
    const category = String(it.category || '').trim();
    if (!category) add('reimbursement_items', `${label}: category is required`);
    else if (!REIMBURSEMENT_CATEGORIES.includes(category)) add('reimbursement_items', `${label}: "${category}" is not a valid category`);
    normaliseGstAmounts(it, { mode: 'gst_entry_method', ex: 'amount_ex_gst', gst: 'gst_amount', total: 'amount' },
      (_field, message) => add('reimbursement_items', message), true, label);
    if (REIMBURSEMENT_DESCRIPTION_REQUIRED.includes(category) && String(it.description || '').trim() === '') add('reimbursement_items', `${label}: description is required for ${category}`);
    if (String(it.receipt || '').trim() === '') add('reimbursement_items', `${label}: receipt is required`);
  }
  row.reimbursement_items = JSON.stringify(withoutReimbursementSupplier(items));
}

const asMb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

function validateAttachments(row, requiredPurposes, add, requireStored) {
  if (!requiredPurposes.length && String(row.attachments || '').trim() === '') return;
  const atts = parseAttachments(row.attachments);
  if (atts === null) { add('attachments', 'is not valid JSON'); return; }
  // Volume limits. The per-file cap lives in the server (it has the bytes in hand); these
  // two bound what one request can accumulate across uploads. `size` is set by the server
  // from the received buffer, never by the client.
  if (atts.length > MAX_ATTACHMENTS_PER_REQUEST) {
    add('attachments', `a request cannot hold more than ${MAX_ATTACHMENTS_PER_REQUEST} attachments (this one has ${atts.length})`);
  }
  const totalBytes = atts.reduce((sum, a) => sum + (Number(a && a.size) || 0), 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES_PER_REQUEST) {
    add('attachments', `attachments total ${asMb(totalBytes)} MB, over the ${asMb(MAX_ATTACHMENT_BYTES_PER_REQUEST)} MB a single request may hold; remove or compress a document`);
  }
  const present = new Set(atts.filter((a) => a && String(a.filename || '').trim() !== '' &&
    (!requireStored || String(a.stored || '').trim() !== '')).map((a) => a.purpose));
  for (const p of requiredPurposes) if (!present.has(p)) add('attachments', `${p} attachment is required`);
}

class StoreError extends Error {
  constructor(message, status = 400, fields = null) {
    super(message);
    this.status = status;
    if (fields && Object.keys(fields).length) this.fields = fields;
  }
}

function validateControlled(input) {
  if (input.request_type && !REQUEST_TYPES.includes(input.request_type)) throw new StoreError(`Invalid request_type: ${input.request_type}`);
  if (input.current_status && !STATUSES.includes(input.current_status)) throw new StoreError(`Invalid status: ${input.current_status}`);
}

// Reference lists as lookup structures (fetched once per operation and passed to the
// validator so it stays synchronous).
async function referenceData() {
  const [costRows, activityRows, people, supplierRows] = await Promise.all([
    repo.getCostCodes(), repo.getActivityCodes(), repo.getPeople(), repo.getSuppliersAll(),
  ]);
  const costCodes = new Set(costRows.map((c) => c.cost_code));
  // Activity codes are a separate selectable reference list. The cost_code stored on
  // each reference row remains useful for reporting, but it is not a request-level
  // parent/child relationship: users may select any listed activity with any listed
  // cost, or use Other for either field independently.
  const activityCodes = new Set(activityRows.map((a) => a.activity_code));
  const peopleById = new Map();
  const peopleByName = new Map();
  for (const person of people) {
    peopleById.set(person.person_id, person);
    const key = String(person.display_name || '').trim().toLowerCase();
    if (!peopleByName.has(key)) peopleByName.set(key, []);
    peopleByName.get(key).push(person);
  }
  const suppliersById = new Map();
  for (const s of supplierRows) suppliersById.set(s.supplier_id, s);
  return { costCodes, activityCodes, peopleById, peopleByName, suppliersById };
}

// Requester identity is normally keyed by requester_person_id. The name fallback is only
// for legacy rows created before that link was populated, and is deliberately limited to a
// unique name so an ambiguous directory cannot send a private status update to the wrong
// person. Invalid or missing directory email means the workflow still proceeds, but no
// notification is attempted.
function requesterEmailFor(row, ref) {
  const id = String(row.requester_person_id || '').trim();
  let person = id ? ref.peopleById.get(id) : null;
  if (!person) {
    const name = String(row.requester_name || '').trim().toLowerCase();
    const matches = name ? (ref.peopleByName.get(name) || []) : [];
    if (matches.length === 1) person = matches[0];
  }
  const email = String(person && person.email || '').trim();
  return email && !validate.validateEmail(email) ? email : '';
}

function resolvePerson(row, ref, idField, nameField, capability, add, required) {
  const id = String(row[idField] || '').trim();
  const name = String(row[nameField] || '').trim();
  let person = id ? ref.peopleById.get(id) : null;
  if (!person && !id && name) {
    const matches = ref.peopleByName.get(name.toLowerCase()) || [];
    if (matches.length === 1) person = matches[0];
    else if (matches.length > 1) { add(idField, `${name} matches more than one person`); return; }
  }
  if (!person) {
    if (required || id) add(idField, `${name || id || 'Person'} is not in the people directory`);
    return;
  }
  if (person.active !== 'Yes') { add(idField, `${person.display_name} is inactive`); return; }
  if (capability && person[capability] !== 'Yes') { add(idField, `${person.display_name} is not authorised for this role`); return; }
  row[idField] = person.person_id;
  row[nameField] = person.display_name;
}

// The single source of truth for business rules (shared by create and update).
function validateBusinessRules(row, allRows, { operation, previousRow, changedFields, isAdmin = true }, ref) {
  const fields = {};
  const add = (f, msg) => { if (!fields[f]) fields[f] = msg; };
  const type = row.request_type;
  const subType = String(row.sub_type || '').trim();
  const changed = (f) => changedFields.has(f);
  const isDraft = row.current_status === 'Draft';
  // A returned request is still a live workflow item, but the requester needs a
  // draft-like edit mode so they can save an incomplete correction before sending it
  // back to Finance. The dedicated store operation is the only path that gets this
  // relaxed validation; ordinary updates and resubmits keep the full gates.
  const returnStatus = type === PROCUREMENT_TYPE ? PROCUREMENT_RETURN_TO_REQUESTOR : 'Returned for Info';
  const isReturnedEdit = operation === 'save-returned'
    && previousRow && previousRow.current_status === returnStatus
    && row.current_status === returnStatus;
  const isInvoiceProgressEdit = operation === 'save-invoice-progress'
    && previousRow && previousRow.current_status === PROCUREMENT_PO_ISSUED
    && row.current_status === PROCUREMENT_PO_ISSUED;
  const isDraftLike = isDraft || isReturnedEdit || isInvoiceProgressEdit;

  // The cost code is no longer collected anywhere; every request carries the one code the
  // organisation uses, so the reporting column and its foreign key stay populated.
  if (!String(row.cost_code || '').trim()) row.cost_code = DEFAULT_COST_CODE;

  if (changed('beneficiary_name') && !row.beneficiary_name) row.beneficiary_person_id = '';
  if (changed('spending_approver') && !row.spending_approver) row.spending_approver_person_id = '';
  if (changed('processed_by') && !row.processed_by) row.processed_by_person_id = '';

  if (row.requester_person_id) resolvePerson(row, ref, 'requester_person_id', 'requester_name', 'can_request', add, true);
  if (row.beneficiary_person_id || (!isDraftLike && row.beneficiary_name)) {
    resolvePerson(row, ref, 'beneficiary_person_id', 'beneficiary_name', 'can_travel', add, !isDraftLike);
  }
  if (row.spending_approver_person_id || row.spending_approver) {
    resolvePerson(row, ref, 'spending_approver_person_id', 'spending_approver', 'can_approve', add, !isDraftLike);
  }
  if (row.processed_by_person_id || row.processed_by) {
    resolvePerson(row, ref, 'processed_by_person_id', 'processed_by', 'can_process', add, false);
  }

  if (!REQUEST_TYPES.includes(type)) add('request_type', `Invalid request_type: ${type}`);
  const validSubs = SUBTYPES_BY_TYPE[type] || [];
  if (validSubs.length) {
    if (!subType) add('sub_type', 'is required');
    else if (!validSubs.includes(subType)) add('sub_type', `"${subType}" is not a valid sub-type for ${type}`);
  }
  if (row.current_status) {
    const allowed = STATUSES_BY_TYPE[type] || [];
    if (!allowed.includes(row.current_status)) add('current_status', `Status "${row.current_status}" is not valid for ${type}`);
  }

  // Admin owns the Finance-side workflow and may correct a Procurement record directly,
  // including moving it backwards from Complete or Cancelled. Requester actions use the
  // dedicated operations below and never gain this freedom from a crafted payload.
  if (previousRow) {
    const from = String(previousRow.current_status || '');
    const to = String(row.current_status || '');
    const successors = (ALLOWED_TRANSITIONS_BY_TYPE[type] || {})[from];
    const procurementAdminEdit = isAdmin && type === PROCUREMENT_TYPE;
    const requesterTarget = type === PROCUREMENT_TYPE
      ? {
        submit: PROCUREMENT_SUBMIT_TO_ADMIN,
        resubmit: PROCUREMENT_SUBMIT_TO_ADMIN,
        'invoice-received': PROCUREMENT_INVOICE_RECEIVED,
      }[operation]
      : {
        submit: 'Submitted',
        resubmit: UPDATED_AND_RESUBMITTED,
      }[operation];
    if (!isAdmin && from !== to && (!requesterTarget || to !== requesterTarget)) {
      add('current_status', 'User must use the workflow action provided for this status change');
    } else if (!procurementAdminEdit && from !== to && successors && !successors.includes(to)) {
      add('current_status', successors.length
        ? `cannot go from "${from}" to "${to}". From here a request can only move to: ${successors.join(', ')}.`
        : `is "${from}" and cannot be changed.`);
    } else if (!procurementAdminEdit && from === to && TERMINAL_STATUSES.includes(from) && changedFields.size) {
      // Non-Procurement terminal records retain their existing lock. Procurement Admin
      // edits are intentionally exempt: the Admin is the custodian of the Finance record.
      const reopen = (successors || [])[0];
      add('current_status', `This request is ${from} and its details are locked.`
        + (reopen ? ` Move it to "${reopen}" first if it has to be corrected.` : ''));
    }
  }

  const reqKey = validSubs.length ? subType : '';
  const configuredRequiredFields = requiredFieldsFor(type, reqKey, row.supplier_type);
  const requiredFields = ['request_type', 'received_date', ...(isDraftLike ? [] : configuredRequiredFields)];
  for (const f of requiredFields) if (!row[f] || String(row[f]).trim() === '') add(f, 'is required');

  // A selected "Other" code is a deliberate escape hatch from the controlled
  // reference lists, so keep the selected value and its user-entered backup in
  // separate columns. Drafts may remain incomplete, just like other required
  // request fields; submission and all non-draft workflow changes require the
  // matching free-text value.
  for (const [selectedField, otherField, label] of [
    ['cost_code', 'cost_code_other', 'cost code'],
    ['activity_code', 'activity_code_other', 'activity code'],
  ]) {
    if (String(row[selectedField] || '').trim() === 'Other'
        && !isDraftLike && !String(row[otherField] || '').trim()) {
      add(otherField, `is required when Other is selected for ${label}`);
    }
  }

  if (type === SUPPLIER_SETUP_TYPE) validateSupplierSetupForm(row, add, isDraftLike);

  if (row.received_date) { const e = validate.validateDate(row.received_date); if (e) add('received_date', e); }
  for (const f of OPTIONAL_DATE_FIELDS) if (row[f]) { const e = validate.validateDate(row[f]); if (e) add(f, e); }
  if (row.travel_start_date && row.travel_end_date &&
      !validate.validateDate(row.travel_start_date) && !validate.validateDate(row.travel_end_date) &&
      row.travel_end_date < row.travel_start_date) {
    add('travel_end_date', 'must be on or after the departure date');
  }
  if (type === PROCUREMENT_TYPE) {
    normaliseGstAmounts(row, { mode: 'gst_entry_method', ex: 'amount_ex_gst', gst: 'gst_amount', total: 'amount_inc_gst' }, add, !isDraftLike);
    if (row.amount_inc_gst || row.amount_ex_gst) row.amount = row.amount_inc_gst || row.amount_ex_gst;
    const invoices = parseItems(row.invoice_items);
    if (invoices && invoices.length > MAX_INVOICE_ITEMS) add('invoice_items', `a request cannot have more than ${MAX_INVOICE_ITEMS} invoices`);
  }
  for (const f of ['amount', 'amount_ex_gst', 'gst_amount', 'amount_inc_gst', 'invoice_amount_ex_gst', 'invoice_gst_amount', 'invoice_amount']) if (String(row[f] || '').trim() !== '') { const e = validate.validateAmount(row[f]); if (e) add(f, e); }
  if (String(row.purchase_order_email || '').trim() !== '') { const e = validate.validateEmail(row.purchase_order_email); if (e) add('purchase_order_email', e); }
  if (String(row.abn || '').trim() !== '') { const { value, error } = validate.normalizeAbn(row.abn); row.abn = value; if (error) add('abn', error); }
  for (const f of YES_NO_FIELDS) if (String(row[f] || '').trim() !== '') { const e = validate.validateYesNo(row[f]); if (e) add(f, e); }

  if (type === REIMBURSEMENT_TYPE) {
    const items = parseItems(row.reimbursement_items);
    if (items === null) add('reimbursement_items', 'is not valid JSON');
    // The line cap applies to drafts as well, unlike the content rules below. Each line
    // entitles the request to its own receipt attachment, and a draft can hold
    // attachments and never has to be submitted — exempting drafts would leave exactly
    // the path that matters wide open. Checked before the per-line loop so an absurd
    // array reports one clear error rather than thousands.
    else if (items.length > MAX_REIMBURSEMENT_ITEMS) {
      add('reimbursement_items', `a request cannot have more than ${MAX_REIMBURSEMENT_ITEMS} expense lines (this one has ${items.length}); split it across several requests`);
    } else if (!isDraftLike) validateReimbursementItems(row, add);
  }
  let requiredAtt = (REQUIRED_ATTACHMENTS_BY_SUBTYPE[type] || {})[reqKey] || [];
  if (type === PROCUREMENT_TYPE && String(row.supplier_type || '').trim() === 'New Supplier'
      && !requiredAtt.includes('new_supplier_form')) {
    requiredAtt = [...requiredAtt, 'new_supplier_form'];
  }
  if (type === SUPPLIER_SETUP_TYPE && subType === SUPPLIER_AMEND) {
    const supplierData = parseJsonObject(row.supplier_form_data) || {};
    if (supplierData.bank_details_action === 'Unchanged') requiredAtt = requiredAtt.filter((p) => p !== 'supplier_evidence');
  }
  // Saving invoice details is relaxed only for the new invoice content; the PO-stage
  // request must still retain its already-issued evidence. A returned request, by
  // contrast, is intentionally allowed to hold missing replacement evidence until the
  // requester is ready to resubmit.
  const requireStored = !isDraftLike || isInvoiceProgressEdit;
  validateAttachments(row, requireStored ? requiredAtt : [], add, requireStored);

  if (requireStored && type === REIMBURSEMENT_TYPE) {
    const atts = parseAttachments(row.attachments) || [];
    const storedPurposes = new Set(atts.filter((a) => a && a.stored).map((a) => a.purpose));
    const items = parseItems(row.reimbursement_items) || [];
    for (let i = 0; i < items.length; i++) {
      if (!storedPurposes.has(`receipt:${items[i].item_id}`)) add('attachments', `receipt for expense line ${i + 1} is required`);
    }
  }

  // Procurement gates mirror the finance sample workflow. A status cannot claim a
  // later step is complete while the evidence for the earlier requester step is absent.
  if (type === PROCUREMENT_TYPE && String(row.close_reason || '').trim()
      && !['Paid', 'Other'].includes(String(row.close_reason || '').trim())) {
    add('close_reason', 'select Paid or Other');
  }
  if (type === PROCUREMENT_TYPE && row.current_status !== 'Cancelled') {
    const order = STATUSES_BY_TYPE[PROCUREMENT_TYPE];
    const atOrAfter = (status) => order.indexOf(row.current_status) >= order.indexOf(status);
    const atts = parseAttachments(row.attachments) || [];
    const hasDocument = (purpose) => atts.some((a) => a && a.purpose === purpose && (!requireStored || a.stored));
    if (atOrAfter(PROCUREMENT_PO_ISSUED)) {
      if (!String(row.po_number || '').trim()) add('po_number', 'is required once a PO is issued');
      if (!hasDocument('po')) add('attachments', 'the purchase order document is required once a PO is issued');
    }
    if (atOrAfter(PROCUREMENT_INVOICE_RECEIVED)) {
      // The invoiced total is what Finance pays; it is not the quoted ex-GST amount, so it
      // is captured separately rather than derived from amount_ex_gst.
      let invoices = parseItems(row.invoice_items) || [];
      if (!invoices.length && String(row.invoice_number || '').trim()) {
        invoices = [{ item_id: stableId(), invoice_number: row.invoice_number, amount_ex_gst: row.invoice_amount_ex_gst,
          gst_amount: row.invoice_gst_amount, amount_inc_gst: row.invoice_amount,
          gst_entry_method: row.invoice_gst_entry_method }];
        row.invoice_items = JSON.stringify(invoices);
      }
      if (!invoices.length) add('invoice_items', 'at least one invoice is required');
      for (let i = 0; i < invoices.length; i++) {
        const item = invoices[i] || {};
        if (!String(item.invoice_number || '').trim()) add('invoice_items', `invoice ${i + 1}: invoice number is required`);
        normaliseGstAmounts(item, { mode: 'gst_entry_method', ex: 'amount_ex_gst', gst: 'gst_amount', total: 'amount_inc_gst' }, add, true, `invoice ${i + 1}`);
        if (!hasDocument(`invoice:${item.item_id}`)) add('attachments', `invoice ${i + 1} attachment is required`);
      }
      // Evidence, not self-attestation: the email approving payment of *this* invoice is
      // a separate document from the approval to spend collected at intake.
      if (!hasDocument('invoice_approval_email')) add('attachments', 'the invoice approval email is required');
      // chk_forwarded_with_approval is deliberately absent: sending this panel to Finance
      // is the forwarding, so it can no longer be a precondition of doing so. The column
      // still exists and older rows keep their recorded value.
      for (const f of ['chk_po_included', 'chk_desc_matches_po', 'chk_service_completed', 'chk_forwarded_to_approver']) {
        if (row[f] !== 'Yes') add(f, 'must be confirmed before the invoice is sent to Finance');
      }
    }
    if (row.current_status === PROCUREMENT_CLOSED) {
      if (!['Paid', 'Other'].includes(String(row.close_reason || '').trim())) add('close_reason', 'select Paid or Other before closing');
    }
  }
  // Travel still records the external-system hand-off. Allowance and Reimbursement now
  // finish directly at Completed, so their processor requirement applies only there.
  const processedStatus = row.current_status === 'Completed'
    || (type === TRAVEL_TYPE && row.current_status === 'Processed in External System');
  if ([TRAVEL_TYPE, TRAVEL_ALLOWANCE_TYPE, REIMBURSEMENT_TYPE].includes(type)
      && processedStatus && !String(row.processed_by || '').trim()) {
    add('processed_by', 'is required when the travel request is processed');
  }
  if (type === SUPPLIER_SETUP_TYPE && row.current_status === 'Approved' && !String(row.vendor_id || '').trim()) {
    add('vendor_id', 'is required before a supplier setup request can be Approved');
  }

  if ((!isDraft || changed('cost_code')) && row.cost_code && row.cost_code !== 'Other' && !ref.costCodes.has(row.cost_code)) add('cost_code', `${row.cost_code} is not a known cost code`);
  if ((!isDraft || changed('activity_code')) && row.activity_code && row.activity_code !== 'Other') {
    if (!ref.activityCodes.has(row.activity_code)) add('activity_code', `${row.activity_code} is not a known activity code`);
  }

  if (type === PROCUREMENT_TYPE && !isDraft && !['New Supplier', 'Existing Supplier'].includes(String(row.supplier_type || '').trim())
      && !String(row.supplier_id || '').trim()) {
    add('supplier_type', 'select New Supplier or Existing Supplier');
  }
  if (type === SUPPLIER_SETUP_TYPE && subType === SUPPLIER_AMEND && (!isDraft || row.supplier_id)) {
    const sup = ref.suppliersById.get(row.supplier_id);
    if (!sup || String(sup.deleted || '') === 'Yes' || sup.status !== 'Approved') {
      add('supplier_id', 'Select an existing Approved supplier to amend');
    }
  }

  if (Object.keys(fields).length) throw new StoreError('Validation failed', 400, fields);
}

// Derived fields written from validated inputs.
function applyDerivedFields(row, ref) {
  // Do not retain a hidden backup value after a user switches back to a known
  // dropdown value. This also cleans up legacy rows that may have received a
  // stale backup value from an earlier edit.
  if (String(row.cost_code || '').trim() === 'Other') row.cost_code_other = String(row.cost_code_other || '').trim();
  else row.cost_code_other = '';
  if (String(row.activity_code || '').trim() === 'Other') row.activity_code_other = String(row.activity_code_other || '').trim();
  else row.activity_code_other = '';
  if (row.request_type === PROCUREMENT_TYPE && String(row.supplier_id || '').trim() !== '') {
    const sup = ref && ref.suppliersById ? ref.suppliersById.get(row.supplier_id) : null;
    if (sup) row.supplier_name = String(sup.legal_entity_name || '').trim();
  }
  if (row.request_type === REIMBURSEMENT_TYPE) {
    const items = parseItems(row.reimbursement_items);
    if (Array.isArray(items)) row.amount = reimbursementTotal(items);
  }
  if (row.request_type === SUPPLIER_SETUP_TYPE) {
    const data = parseJsonObject(row.supplier_form_data) || {};
    row.legal_entity_name = String(data.legal_entity_name || '').trim();
    row.abn = String(data.abn || '').trim();
    row.purchase_order_email = String(data.purchase_order_email || '').trim();
    row.supplier_name = row.legal_entity_name;
  }
  const atts = parseAttachments(row.attachments);
  if (Array.isArray(atts) && atts.some((a) => a && String(a.filename || '').trim() !== '')) row.has_attachments = 'Yes';
}

function assignCell(row, col, value) {
  if (value == null || value === '') return;
  row[col] = JSON_FIELDS.has(col) && typeof value !== 'string' ? JSON.stringify(value) : String(value).trim();
}

// A requester may keep only so many unsubmitted drafts at once. Every request is born a
// Draft, and a draft is the one thing a requester can create freely, attach files to, and
// never have to finish — so without this the per-request limits above bound nothing in
// aggregate. Counted through readOwnedRequests so "your drafts" means exactly what the My
// Requests list shows, whichever of the three ownership keys applies.
//
// Finance is exempt: this exists to stop one ordinary account hoarding, not to throttle
// intake that an admin is recording on somebody else's behalf.
async function assertDraftQuota(row, user, isAdmin) {
  if (isAdmin) return;
  const owned = await readOwnedRequests(user, row.requester_person_id, row.requester_name);
  const open = owned.filter((r) => r.current_status === 'Draft' && String(r.deleted || '') !== 'Yes');
  if (open.length >= MAX_OPEN_DRAFTS_PER_REQUESTER) {
    throw new StoreError(
      `You already have ${open.length} unsubmitted drafts and the limit is ${MAX_OPEN_DRAFTS_PER_REQUESTER}. `
      + 'Submit or discard one before starting another.', 409);
  }
}

async function createRequest(input, user, { isAdmin = false, requestId = '' } = {}) {
  validateControlled(input);
  // Update rejects a field it does not recognise; create used to copy the columns it
  // knew and drop the rest, so a misspelt field came back 201 with the value missing
  // and nothing to show for it. Both paths now fail the same way on the same typo.
  const unknown = Object.keys(input || {}).filter((k) => !CREATE_ALLOWED_FIELDS.has(k));
  if (unknown.length) {
    throw new StoreError(`Unknown field(s): ${unknown.join(', ')}`, 400,
      Object.fromEntries(unknown.map((k) => [k, 'is not a field of a request'])));
  }

  const row = emptyRow();
  for (const c of CURRENT_COLUMNS) assignCell(row, c, input[c]);
  assignStableCollectionIds(row);
  const changedFields = new Set(Object.keys(input).filter((k) => input[k] != null && String(input[k]).trim() !== ''));

  row.request_id = String(requestId || '').trim();
  row.current_status = (STATUSES_BY_TYPE[row.request_type] || [])[0] || '';
  if (!row.currency) row.currency = 'AUD';
  if (!row.has_attachments) row.has_attachments = 'No';

  await hydrateUnchangedSupplierBank(row, null);
  const ref = await referenceData();
  validateBusinessRules(row, [], { operation: 'create', changedFields }, ref);
  applyDerivedFields(row, ref);
  // After validation, so a malformed request still reports its field errors rather than
  // being turned away for a quota it was never going to reach.
  await assertDraftQuota(row, user, isAdmin);
  applyStatusSideEffects(row, '', row.current_status);
  row.created_at = nowIso();
  row.last_updated_at = nowIso();

  const actor = await actorSnapshot(user);
  const logRow = {
    event_id: nextEventId(), request_id: row.request_id, event_time: row.last_updated_at,
    event_type: 'Created', old_status: '', new_status: row.current_status,
    ...actor, note: row.notes || '', changed_fields: '',
  };
  try {
    const result = await repo.createRequest(row, logRow, `FR-${dateStamp()}-`);
    if (result && result.existing) {
      const existing = await repo.getRequestById(row.request_id);
      if (existing) return existing;
    }
  } catch (err) { throw mapRepoError(err); }
  return row;
}

async function syncApprovedSupplierRequest(row) {
  const data = parseJsonObject(row.supplier_form_data) || {};
  const suppliers = await repo.getSuppliersAll();
  let previous = null;
  if (row.sub_type === SUPPLIER_AMEND) previous = suppliers.find((s) => s.supplier_id === row.supplier_id) || null;
  else previous = suppliers.find((s) => row.vendor_id && String(s.vendor_id || '') === row.vendor_id) || null;

  if (previous && row.sub_type === SUPPLIER_NEW &&
      String(previous.legal_entity_name || '').trim().toLowerCase() !== String(row.legal_entity_name || '').trim().toLowerCase()) {
    throw new StoreError('Validation failed', 400, { vendor_id: `is already assigned to ${previous.legal_entity_name}` });
  }

  if (previous) {
    const next = {
      ...previous,
      legal_entity_name: row.legal_entity_name,
      abn: row.abn,
      purchase_order_email: row.purchase_order_email,
      vendor_id: row.vendor_id || previous.vendor_id,
      supplier_form_data: JSON.stringify(data),
      status: 'Approved',
      deleted: '',
      last_updated_at: nextVersionIso(previous.last_updated_at),
    };
    validateSupplier(next);
    try { await repo.updateSupplier(next, previous.last_updated_at); } catch (err) { throw mapRepoError(err); }
    return next.supplier_id;
  }

  const master = {};
  for (const c of SUPPLIER_COLUMNS) master[c] = '';
  master.legal_entity_name = row.legal_entity_name || String(data.legal_entity_name || '').trim();
  master.abn = row.abn || String(data.abn || '').trim();
  master.purchase_order_email = row.purchase_order_email || String(data.purchase_order_email || '').trim();
  master.vendor_id = row.vendor_id;
  master.supplier_form_data = JSON.stringify(data);
  master.status = 'Approved';
  master.created_at = nowIso();
  master.last_updated_at = master.created_at;
  validateSupplier(master);
  try {
    await repo.createSupplier(master, `SUP-${dateStamp()}-`);
  } catch (err) {
    // A concurrent approval may have created the same University vendor while this
    // request waited on the repository lock. Re-read and link only an exact-name match.
    const current = (await repo.getSuppliersAll()).find((s) => row.vendor_id && String(s.vendor_id || '') === row.vendor_id);
    if (current && String(current.legal_entity_name || '').trim().toLowerCase() === String(row.legal_entity_name || '').trim().toLowerCase()) {
      return current.supplier_id;
    }
    throw mapRepoError(err);
  }
  return master.supplier_id;
}

async function updateRequest(id, changes, user, expectedVersion, options = {}) {
  const current = await repo.getRequestById(id);
  if (!current) throw new StoreError(`Request not found: ${id}`, 404);
  const previousRow = { ...current };
  if (expectedVersion && String(previousRow.last_updated_at) !== String(expectedVersion)) {
    throw new StoreError('The request was changed by another user. Refresh and try again.', 409);
  }

  if (String(previousRow.deleted || '') === 'Yes') throw new StoreError(`Request ${id} is deleted and cannot be edited. Restore it first.`, 409);
  validateControlled(changes);

  const allowed = new Set([...UPDATABLE_FIELDS, ...UPDATE_META_FIELDS]);
  const unknown = Object.keys(changes).filter((k) => !allowed.has(k));
  if (unknown.length) throw new StoreError(`Unknown or non-updatable field(s): ${unknown.join(', ')}`, 400, Object.fromEntries(unknown.map((k) => [k, 'is not an updatable field'])));

  const row = { ...previousRow };
  const normalizedChanges = { ...(changes || {}) };
  const collections = { ...previousRow, ...normalizedChanges };
  assignStableCollectionIds(collections, previousRow);
  for (const field of ['reimbursement_items', 'invoice_items', 'attachments']) {
    if (Object.prototype.hasOwnProperty.call(normalizedChanges, field)) normalizedChanges[field] = collections[field];
  }
  const oldStatus = row.current_status;
  const changedFields = new Set();
  const diff = {};
  for (const f of UPDATABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(normalizedChanges, f)) {
      const raw = normalizedChanges[f];
      const newVal = raw == null ? '' : (JSON_FIELDS.has(f) && typeof raw !== 'string' ? JSON.stringify(raw) : String(raw).trim());
      if (newVal !== row[f]) { diff[f] = { old: row[f], new: newVal }; row[f] = newVal; changedFields.add(f); }
    }
  }
  const hasNote = changes.note != null && String(changes.note).trim() !== '';
  const hasInternalNote = changes.internal_note != null && String(changes.internal_note).trim() !== '';
  if (changedFields.size === 0 && !hasNote && !hasInternalNote) return row;

  const returnStatus = row.request_type === PROCUREMENT_TYPE
    ? PROCUREMENT_RETURN_TO_REQUESTOR : 'Returned for Info';
  if (oldStatus !== returnStatus && row.current_status === returnStatus && !hasNote) {
    throw new StoreError('Explain what information is missing and what the user needs to do.', 400, {
      note: 'A message to the user is required when returning a request for information',
    });
  }

  if (previousRow.request_type === SUPPLIER_SETUP_TYPE && previousRow.current_status === 'Approved') {
    if (row.current_status !== 'Approved' || changedFields.has('supplier_form_data') || changedFields.has('vendor_id')) {
      throw new StoreError('An Approved supplier setup request is locked. Update the supplier master or submit an amendment request.', 409);
    }
  }

  await hydrateUnchangedSupplierBank(row, previousRow);
  const ref = await referenceData();
  const operation = options && options.operation ? options.operation : 'update';
  const isAdmin = options && Object.prototype.hasOwnProperty.call(options, 'isAdmin')
    ? options.isAdmin !== false : true;
  validateBusinessRules(row, [], { operation, previousRow, changedFields, isAdmin }, ref);
  applyDerivedFields(row, ref);
  if (row.request_type === SUPPLIER_SETUP_TYPE && row.current_status === 'Approved' &&
      (oldStatus !== 'Approved' || !row.supplier_id)) {
    const supplierId = await syncApprovedSupplierRequest(row);
    if (supplierId !== row.supplier_id) {
      diff.supplier_id = { old: row.supplier_id, new: supplierId };
      row.supplier_id = supplierId;
      changedFields.add('supplier_id');
    }
  }
  applyStatusSideEffects(row, oldStatus, row.current_status);

  const newStatus = row.current_status;
  row.last_updated_at = nextVersionIso(previousRow.last_updated_at);

  const statusChanged = newStatus !== oldStatus;
  const eventType = options && options.eventType
    ? options.eventType
    : hasInternalNote && !statusChanged && changedFields.size === 0
    ? 'Internal Note' : statusChanged ? 'Status Changed' : changedFields.size > 0 ? 'Field Updated' : 'Comment';
  const actor = await actorSnapshot(user);
  const logRow = {
    event_id: nextEventId(), request_id: row.request_id, event_time: row.last_updated_at,
    event_type: eventType, old_status: statusChanged ? oldStatus : '', new_status: statusChanged ? newStatus : '',
    ...actor, note: hasInternalNote ? String(changes.internal_note) : changes.note != null ? String(changes.note) : '',
    changed_fields: Object.keys(diff).length ? JSON.stringify(diff) : '',
  };
  try { await repo.updateRequest(row, logRow, previousRow.last_updated_at); } catch (err) { throw mapRepoError(err); }
  // After the write, and only for a status change: field edits and internal notes are
  // routine, and mailing every one of them is how a notification address becomes a filter
  // rule. `changes.note` rather than the logged note — the logged one carries the internal
  // note text when there is one, and an internal note must never leave the app.
  if (statusChanged) {
    notify.requestStatusChanged({
      row,
      oldStatus,
      newStatus,
      changedBy: user,
      note: changes.note,
      requesterEmail: requesterEmailFor(row, ref),
    });
  }
  return row;
}

async function saveReturnedRequest(id, changes, user, expectedVersion) {
  const current = await repo.getRequestById(id);
  if (!current) throw new StoreError(`Request not found: ${id}`, 404);
  const returnStatus = current.request_type === PROCUREMENT_TYPE
    ? PROCUREMENT_RETURN_TO_REQUESTOR : 'Returned for Info';
  if (current.current_status !== returnStatus) {
    throw new StoreError('Only a request returned for information can save corrections', 409);
  }
  // Status is fixed here, rather than trusted from the browser. This action stores the
  // correction in place and can never turn a save into a resubmission or another workflow
  // transition.
  return updateRequest(id, { ...(changes || {}), current_status: returnStatus }, user, expectedVersion, {
    operation: 'save-returned',
    isAdmin: false,
  });
}

async function saveInvoiceProgress(id, changes, user, expectedVersion) {
  const current = await repo.getRequestById(id);
  if (!current) throw new StoreError(`Request not found: ${id}`, 404);
  if (current.request_type !== PROCUREMENT_TYPE || current.current_status !== PROCUREMENT_PO_ISSUED) {
    throw new StoreError('Only a procurement request waiting for invoice details can save progress', 409);
  }
  return updateRequest(id, { ...(changes || {}), current_status: PROCUREMENT_PO_ISSUED }, user, expectedVersion, {
    operation: 'save-invoice-progress',
    isAdmin: false,
  });
}

async function setDeleted(id, deleted, user) {
  const current = await repo.getRequestById(id);
  if (!current) throw new StoreError(`Request not found: ${id}`, 404);
  const row = { ...current };
  const previousVersion = row.last_updated_at;
  const newFlag = deleted ? 'Yes' : '';
  if ((row.deleted || '') === newFlag) return row;


  row.deleted = newFlag;
  row.last_updated_at = nextVersionIso(previousVersion);
  const actor = await actorSnapshot(user);
  const logRow = {
    event_id: nextEventId(), request_id: row.request_id, event_time: row.last_updated_at,
    event_type: deleted ? 'Deleted' : 'Restored', old_status: '', new_status: '',
    ...actor, note: '', changed_fields: '',
  };
  try { await repo.updateRequest(row, logRow, previousVersion); } catch (err) { throw mapRepoError(err); }
  return row;
}

async function hardDeleteDraft(id) {
  const row = await repo.getRequestById(id);
  if (!row) throw new StoreError(`Request not found: ${id}`, 404);
  if (row.current_status !== 'Draft') throw new StoreError('Only a Draft request can be permanently discarded', 409);
  await repo.hardDeleteRequest(id);
  return row;
}

async function getRequestHistory(id) {
  const log = await repo.getLog();
  return log.filter((e) => e.request_id === id);
}

async function getRequestById(id) { return repo.getRequestById(id); }

function legacyNameOwner(row, displayName) {
  return !!displayName && row.requester_name === displayName;
}

async function isRequestOwner(row, username, personId, displayName) {
  if (personId && row.requester_person_id) return row.requester_person_id === personId;
  const createdBy = await repo.getCreatedBy(row.request_id);
  if (createdBy) return createdBy === username || (createdBy === displayName && legacyNameOwner(row, displayName));
  return legacyNameOwner(row, displayName);
}

async function readOwnedRequests(username, personId, displayName) {
  const [rows, log] = await Promise.all([repo.getRequests(), repo.getLog()]);
  const creators = new Map();
  const createdAt = new Map();
  for (const event of log) {
    if (event.event_type !== 'Created' || creators.has(event.request_id)) continue;
    creators.set(event.request_id, String(event.changed_by || ''));
    createdAt.set(event.request_id, String(event.event_time || ''));
  }
  return rows
    .filter((row) => {
      if (personId && row.requester_person_id) return row.requester_person_id === personId;
      const createdBy = creators.get(row.request_id) || '';
      if (createdBy) return createdBy === username || (createdBy === displayName && legacyNameOwner(row, displayName));
      return legacyNameOwner(row, displayName);
    })
    // received_date is a plain date, so it cannot show a time. The Created event already
    // records the exact moment, so surface that rather than widening the stored column.
    .map((row) => ({ ...row, created_at: row.created_at || createdAt.get(row.request_id) || '' }));
}

function validAttachmentPurpose(purpose) {
  return ATTACHMENT_PURPOSES.includes(purpose)
    || new RegExp(`^receipt:${UUID_PATTERN}$`, 'i').test(purpose)
    || new RegExp(`^invoice:${UUID_PATTERN}$`, 'i').test(purpose)
    || new RegExp(`^invoice_other:${UUID_PATTERN}:${UUID_PATTERN}$`, 'i').test(purpose)
    || new RegExp(`^invoice_approval_other:${UUID_PATTERN}$`, 'i').test(purpose)
    || new RegExp(`^other_document:${UUID_PATTERN}$`, 'i').test(purpose);
}

function assertAttachmentAllowed(row, purpose, isAdmin = true) {
  if (!validAttachmentPurpose(purpose)) throw new StoreError(`Invalid attachment purpose: ${purpose}`, 400);
  if (!isAdmin && ADMIN_ONLY_ATTACHMENT_PURPOSES.includes(purpose)) {
    throw new StoreError(`Only Finance can attach the ${purpose} document`, 403);
  }
  const receipt = purpose.match(new RegExp(`^receipt:(${UUID_PATTERN})$`, 'i'));
  if (receipt) {
    if (row.request_type !== REIMBURSEMENT_TYPE) {
      throw new StoreError('Line receipts are only allowed for Reimbursement requests', 400);
    }
    const item = (parseItems(row.reimbursement_items) || []).find((candidate) => (
      candidate && String(candidate.item_id || '').toLowerCase() === receipt[1].toLowerCase()
    ));
    if (!item) throw new StoreError('The expense line for this receipt no longer exists', 400);
    return true;
  }
  const invoice = purpose.match(new RegExp(`^invoice:(${UUID_PATTERN})$`, 'i'));
  if (invoice) {
    if (row.request_type !== PROCUREMENT_TYPE) throw new StoreError('Invoice attachments are only allowed for Procurement requests', 400);
    const item = (parseItems(row.invoice_items) || []).find((candidate) => (
      candidate && String(candidate.item_id || '').toLowerCase() === invoice[1].toLowerCase()
    ));
    if (!item) throw new StoreError('The invoice for this attachment no longer exists', 400);
    return true;
  }
  const invoiceOther = purpose.match(new RegExp(`^invoice_other:(${UUID_PATTERN}):(${UUID_PATTERN})$`, 'i'));
  if (invoiceOther) {
    if (row.request_type !== PROCUREMENT_TYPE) {
      throw new StoreError('Invoice Other Documents are only allowed for Procurement requests', 400);
    }
    const item = (parseItems(row.invoice_items) || []).find((candidate) => (
      candidate && String(candidate.item_id || '').toLowerCase() === invoiceOther[1].toLowerCase()
    ));
    if (!item) throw new StoreError('The invoice for this document no longer exists', 400);
    return true;
  }
  if (new RegExp(`^invoice_approval_other:${UUID_PATTERN}$`, 'i').test(purpose)) {
    if (row.request_type !== PROCUREMENT_TYPE) {
      throw new StoreError('Additional invoice approval documents are only allowed for Procurement requests', 400);
    }
    return true;
  }
  if (new RegExp(`^other_document:${UUID_PATTERN}$`, 'i').test(purpose)) {
    const allowed = ((ALLOWED_ATTACHMENTS_BY_SUBTYPE[row.request_type] || {})[row.sub_type] || []);
    if (!allowed.includes('other_document')) throw new StoreError(`${purpose} is not allowed for ${row.request_type} / ${row.sub_type}`, 400);
    return true;
  }
  if (purpose === 'receipt') throw new StoreError('Use a line-specific receipt attachment for each reimbursement item', 400);
  const allowed = ((ALLOWED_ATTACHMENTS_BY_SUBTYPE[row.request_type] || {})[row.sub_type] || []);
  if (!allowed.includes(purpose)) throw new StoreError(`${purpose} is not allowed for ${row.request_type} / ${row.sub_type}`, 400);
  return true;
}

async function upsertAttachment(id, attachment, user, expectedVersion, isAdmin = true) {
  const purpose = String((attachment && attachment.purpose) || '').trim();
  if (!validAttachmentPurpose(purpose)) throw new StoreError(`Invalid attachment purpose: ${purpose}`, 400);
  const current = await repo.getRequestById(id);
  if (!current) throw new StoreError(`Request not found: ${id}`, 404);
  assertAttachmentAllowed(current, purpose, isAdmin);
  const atts = parseAttachments(current.attachments);
  if (!Array.isArray(atts)) throw new StoreError('Stored attachment metadata is invalid', 500);
  const previous = atts.find((a) => a && a.purpose === purpose) || null;
  const next = atts.filter((a) => !a || a.purpose !== purpose);
  next.push({ ...attachment, purpose });
  const row = await updateRequest(id, { attachments: next }, user, expectedVersion || current.last_updated_at, {
    eventType: 'Attachment Updated',
    isAdmin,
  });
  return { row, previous };
}

async function removeAttachment(id, purpose, user, expectedVersion, isAdmin = true) {
  const current = await repo.getRequestById(id);
  if (!current) throw new StoreError(`Request not found: ${id}`, 404);
  if (!isAdmin) {
    const returnStatus = current.request_type === PROCUREMENT_TYPE
      ? PROCUREMENT_RETURN_TO_REQUESTOR : 'Returned for Info';
    const invoicePurpose = new RegExp(`^(invoice:${UUID_PATTERN}|invoice_other:${UUID_PATTERN}:${UUID_PATTERN}|invoice_approval_email|invoice_approval_other:${UUID_PATTERN})$`, 'i');
    const requesterCanEdit = current.current_status === 'Draft'
      || current.current_status === returnStatus
      || (current.request_type === PROCUREMENT_TYPE
        && current.current_status === PROCUREMENT_PO_ISSUED && invoicePurpose.test(purpose));
    if (!requesterCanEdit) throw new StoreError('Attachments are locked at this stage of the request', 409);
  }
  assertAttachmentAllowed(current, purpose, isAdmin);
  const atts = parseAttachments(current.attachments);
  if (!Array.isArray(atts)) throw new StoreError('Stored attachment metadata is invalid', 500);
  const removed = atts.find((attachment) => attachment && attachment.purpose === purpose);
  if (!removed) throw new StoreError('Attachment not found', 404);
  const next = atts.filter((attachment) => !attachment || attachment.purpose !== purpose);
  const row = await updateRequest(id, { attachments: next }, user, expectedVersion || current.last_updated_at, {
    eventType: 'Attachment Updated',
    isAdmin,
  });
  return { row, removed };
}

async function findAttachmentByStored(stored) { return repo.findAttachmentByStored(stored); }

// ---- supplier master ----

function validateSupplier(row) {
  const fields = {};
  if (String(row.legal_entity_name || '').trim() === '') fields.legal_entity_name = 'is required';
  const em = validate.validateEmail(row.purchase_order_email);
  if (em) fields.purchase_order_email = em;
  if (String(row.abn || '').trim() !== '') {
    const { value, error } = validate.normalizeAbn(row.abn);
    row.abn = value;
    if (error) fields.abn = error;
  }
  if (row.status && !SUPPLIER_STATUSES.includes(row.status)) fields.status = `Invalid status: ${row.status}`;
  const profile = parseJsonObject(row.supplier_form_data);
  if (profile === null) fields.supplier_form_data = 'is not valid JSON';
  else {
    profile.legal_entity_name = String(row.legal_entity_name || '').trim();
    profile.abn = String(row.abn || '').trim();
    profile.has_abn = profile.abn ? 'Yes' : (profile.has_abn || 'No');
    profile.purchase_order_email = String(row.purchase_order_email || '').trim();
    row.supplier_form_data = JSON.stringify(profile);
  }
  if (Object.keys(fields).length) throw new StoreError('Validation failed', 400, fields);
}

async function readSuppliersAll() {
  const [suppliers, requests] = await Promise.all([repo.getSuppliersAll(), repo.getRequests()]);
  return suppliers.map((supplier) => {
    const latest = latestApprovedSupplierSetup(requests, supplier.supplier_id);
    const profile = latest ? (parseJsonObject(latest.supplier_form_data) || {}) : {};
    const stored = parseJsonObject(supplier.supplier_form_data) || {};
    for (const [field, value] of Object.entries(stored)) {
      if (String(value == null ? '' : value).trim() !== '') profile[field] = value;
    }
    profile.legal_entity_name = String(supplier.legal_entity_name || '').trim();
    profile.abn = String(supplier.abn || '').trim();
    profile.has_abn = profile.abn ? 'Yes' : (profile.has_abn || 'No');
    profile.purchase_order_email = String(supplier.purchase_order_email || '').trim();
    return { ...supplier, supplier_form_data: JSON.stringify(profile) };
  });
}

async function getSupplierAmendmentTemplate(id) {
  const suppliers = await repo.getSuppliersAll();
  const supplier = suppliers.find((s) => s.supplier_id === id && s.status === 'Approved' && String(s.deleted || '') !== 'Yes');
  if (!supplier) throw new StoreError(`Approved supplier not found: ${id}`, 404);

  const sourceRow = latestApprovedSupplierSetup(await repo.getRequests(), id);
  const source = sourceRow ? (parseJsonObject(sourceRow.supplier_form_data) || {}) : {};
  const masterProfile = parseJsonObject(supplier.supplier_form_data) || {};
  for (const [field, value] of Object.entries(masterProfile)) {
    if (String(value == null ? '' : value).trim() !== '') source[field] = value;
  }
  const safeFields = [
    'legal_entity_name', 'has_abn', 'abn', 'no_abn_reason', 'street_address', 'suburb',
    'country', 'postcode', 'state_region', 'contact_name', 'contact_phone', 'contact_email',
    'purchase_order_email', 'remittance_email', 'nt_enterprise', 'icn',
  ];
  const form_data = {};
  for (const field of safeFields) form_data[field] = String(source[field] || '');
  form_data.legal_entity_name = supplier.legal_entity_name || form_data.legal_entity_name;
  form_data.abn = supplier.abn || form_data.abn;
  form_data.has_abn = form_data.abn ? 'Yes' : (form_data.has_abn || 'No');
  form_data.purchase_order_email = supplier.purchase_order_email || form_data.purchase_order_email;

  // Deliberately no bank details of any kind, not even the masked summary. Every
  // requester can list every approved supplier (/api/options), so anything returned here
  // is readable for the whole supplier master by any account that can sign in — and
  // bank name + account name + last four digits is exactly the material an invoice-
  // redirection scam is built from.
  //
  // Nothing is lost by withholding it: when the requester keeps the existing details,
  // hydrateUnchangedSupplierBank refills them server-side from the approved source, so
  // the browser never needs to have seen them. can_keep_bank_details says whether that
  // is possible, which is all the form actually has to know.
  return {
    supplier_id: supplier.supplier_id,
    form_data,
    can_keep_bank_details: !!String(source.account_number || '').trim(),
  };
}

async function createSupplier(input, user) {
  const row = {};
  for (const c of SUPPLIER_COLUMNS) row[c] = '';
  for (const c of SUPPLIER_COLUMNS) if (input[c] != null && input[c] !== '') {
    row[c] = c === 'supplier_form_data' && typeof input[c] !== 'string' ? JSON.stringify(input[c]) : String(input[c]).trim();
  }
  row.supplier_id = '';
  row.status = SUPPLIER_STATUSES[0];
  row.deleted = '';
  row.created_at = nowIso();
  row.last_updated_at = nowIso();
  validateSupplier(row);
  try { await repo.createSupplier(row, `SUP-${dateStamp()}-`); } catch (err) { throw mapRepoError(err); }
  return row;
}

const SUPPLIER_UPDATABLE = new Set(['legal_entity_name', 'abn', 'purchase_order_email', 'vendor_id', 'supplier_form_data', 'status']);

async function updateSupplier(id, changes, user) {
  const rows = await repo.getSuppliersAll();
  const prev = rows.find((s) => s.supplier_id === id);
  if (!prev) throw new StoreError(`Supplier not found: ${id}`, 404);
  if (String(prev.deleted || '') === 'Yes') throw new StoreError(`Supplier ${id} is deleted and cannot be edited. Restore it first.`, 409);
  const unknown = Object.keys(changes).filter((k) => !SUPPLIER_UPDATABLE.has(k));
  if (unknown.length) throw new StoreError(`Unknown or non-updatable field(s): ${unknown.join(', ')}`, 400, Object.fromEntries(unknown.map((k) => [k, 'is not an updatable field'])));

  const row = { ...prev };
  for (const c of SUPPLIER_COLUMNS) if (Object.prototype.hasOwnProperty.call(changes, c)) {
    row[c] = changes[c] == null ? '' : (c === 'supplier_form_data' && typeof changes[c] !== 'string' ? JSON.stringify(changes[c]) : String(changes[c]).trim());
  }

  // Guard: a supplier referenced by active procurement can't leave Approved.
  if (prev.status === 'Approved' && row.status !== 'Approved') {
    const refs = (await repo.getRequests()).filter((r) => r.request_type === PROCUREMENT_TYPE && String(r.deleted || '') !== 'Yes' && String(r.supplier_id || '') === id);
    if (refs.length) throw new StoreError('Validation failed', 400, { status: `Cannot change away from Approved: referenced by ${refs.map((r) => r.request_id).join(', ')}` });
  }
  row.last_updated_at = nextVersionIso(prev.last_updated_at);
  validateSupplier(row);
  try { await repo.updateSupplier(row, prev.last_updated_at); } catch (err) { throw mapRepoError(err); }
  return row;
}

async function setSupplierDeleted(id, deleted, user) {
  const rows = await repo.getSuppliersAll();
  const prev = rows.find((s) => s.supplier_id === id);
  if (!prev) throw new StoreError(`Supplier not found: ${id}`, 404);
  const flag = deleted ? 'Yes' : '';
  if ((prev.deleted || '') === flag) return prev;
  if (deleted) {
    const refs = (await repo.getRequests()).filter((r) => r.request_type === PROCUREMENT_TYPE && String(r.deleted || '') !== 'Yes' && String(r.supplier_id || '') === id);
    if (refs.length) throw new StoreError(`Cannot delete supplier ${id}: still referenced by procurement request(s) ${refs.map((r) => r.request_id).join(', ')}.`);
  }
  const row = { ...prev, deleted: flag, last_updated_at: nextVersionIso(prev.last_updated_at) };
  try { await repo.updateSupplier(row, prev.last_updated_at); } catch (err) { throw mapRepoError(err); }
  return row;
}

// Storage-delegating reads (async).
async function ensureDataFiles() { return repo.init(); }
async function readCurrent() { return repo.getRequests(); }
async function readLog() { return repo.getLog(); }
async function readCostCodes() { return repo.getCostCodes(); }
async function readActivityCodes() { return repo.getActivityCodes(); }
async function readPeople() { return repo.getPeople(); }
function normalisePerson(input, existing = {}) {
  const defaults = {
    active: 'Yes', can_request: 'Yes', can_travel: 'Yes',
    can_approve: 'No', can_process: 'No',
  };
  const row = { ...defaults, ...existing, ...input };
  row.display_name = String(row.display_name || '').trim();
  row.email = String(row.email || '').trim();
  if (!row.display_name) throw new StoreError('Display name is required', 400, { display_name: 'is required' });
  if (row.email) { const error = validate.validateEmail(row.email); if (error) throw new StoreError('Invalid email', 400, { email: error }); }
  for (const field of ['active', 'can_request', 'can_travel', 'can_approve', 'can_process']) {
    row[field] = row[field] === 'No' ? 'No' : 'Yes';
  }
  return row;
}
async function createPerson(input) {
  const row = normalisePerson(input);
  await repo.createPerson(row); return row;
}
async function updatePerson(id, changes) {
  const existing = (await repo.getPeople()).find((person) => person.person_id === id);
  if (!existing) throw new StoreError(`Person not found: ${id}`, 404);
  const row = normalisePerson(changes, existing); row.person_id = id;
  // Deactivating a person now blocks their login, so this switch can lock out the last
  // administrator just as surely as a role change can.
  if (row.active === 'No' && existing.active !== 'No') {
    const account = (await repo.getUsers()).find((user) => user.person_id === id);
    if (account && account.role === 'admin') {
      await assertNotLastAdmin(account.username, `${existing.display_name} holds the last administrator account. Grant admin to someone else first.`);
    }
  }
  await repo.updatePerson(row); return row;
}
async function readSuppliers() { return repo.getSuppliers(); }
async function init() { return repo.init(); }
async function close() { return repo.close ? repo.close() : undefined; }
function supplierProfilesPersistent() { return repo.supportsSupplierProfiles ? repo.supportsSupplierProfiles() : false; }
async function getUserByUsername(username) { return repo.getUserByUsername(username); }
function isStorageUnavailable(err) {
  return typeof repo.isUnavailableError === 'function' && repo.isUnavailableError(err);
}

// ---- accounts ----
//
// An account is always half of a pair: a `users` row for the credentials and a `people`
// row for the identity. Ownership of a request keys off person_id (isRequestOwner), so an
// account without a person cannot see its own requests — which is why registration
// creates both, and why the People directory's Active switch is what disables a login.

// Self-registration is open, so the domain list is the only thing standing between this
// endpoint and the public. Configurable because PolyU may add a sub-domain; defaulted so a
// deployment that forgets to set it is closed rather than open.
const REGISTRATION_DEFAULT_DOMAINS = 'connect.polyu.hk,polyu.edu.hk';
function allowedRegistrationDomains() {
  return String(process.env.REGISTRATION_ALLOWED_DOMAINS || REGISTRATION_DEFAULT_DOMAINS)
    .split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean);
}

function normaliseUsername(email) { return String(email || '').trim().toLowerCase(); }

function assertPasswordAcceptable(password, field = 'password') {
  const value = String(password == null ? '' : password);
  if (value.length < auth.MIN_PASSWORD_LENGTH) {
    throw new StoreError('Validation failed', 400,
      { [field]: `must be at least ${auth.MIN_PASSWORD_LENGTH} characters` });
  }
  return value;
}

function personActive(user, peopleById) {
  if (!user.person_id) return true;
  const person = peopleById.get(user.person_id);
  return !person || person.active !== 'No';
}

// An account that can reach the admin screens: enabled, with an enabled person behind it.
async function activeAdmins() {
  const [users, people] = await Promise.all([repo.getUsers(), repo.getPeople()]);
  const peopleById = new Map(people.map((person) => [person.person_id, person]));
  return users.filter((user) => user.role === 'admin' && String(user.active) !== 'No' && personActive(user, peopleById));
}

// Losing the last admin locks the whole administration surface — supplier master, the
// queue, this very screen — behind a server-side data edit. Every path that could get
// there (role change, account disable, deactivating the person) goes through here.
async function assertNotLastAdmin(username, message) {
  const admins = await activeAdmins();
  if (admins.length <= 1 && admins.some((admin) => admin.username === username)) {
    throw new StoreError(message, 409);
  }
}

async function registerUser({ display_name, email, password }) {
  const name = String(display_name || '').trim();
  const address = String(email || '').trim();
  const fields = {};
  if (!name) fields.display_name = 'is required';
  const emailError = validate.validateEmail(address);
  if (emailError) fields.email = emailError;
  if (Object.keys(fields).length) throw new StoreError('Validation failed', 400, fields);

  const domains = allowedRegistrationDomains();
  const domain = address.split('@').pop().toLowerCase();
  if (!domains.includes(domain)) {
    throw new StoreError('Validation failed', 400,
      { email: `must be a ${domains.map((d) => `@${d}`).join(' or ')} address` });
  }
  assertPasswordAcceptable(password);

  const username = normaliseUsername(address);
  if (await repo.getUserByUsername(username)) {
    throw new StoreError('An account with that email address already exists. Sign in instead.', 409);
  }

  const row = {
    username,
    password_hash: await auth.hashPassword(password),
    // Never from the request body. Self-service is how you get an ordinary account; an
    // admin account is granted, on the People screen, by somebody who already has one.
    role: 'requester',
    person_id: '',
    display_name: name,
    active: 'Yes',
    password_version: '0',
  };
  const personInput = {
    display_name: name, email: address,
    active: 'Yes', can_request: 'Yes', can_travel: 'Yes', can_approve: 'No', can_process: 'No',
  };
  try {
    const result = await repo.registerUser(row, personInput);
    return {
      username: result.account.username, role: result.account.role,
      person_id: result.account.person_id, display_name: result.account.display_name,
    };
  } catch (err) { throw mapRepoError(err); }
}

// The credentials half of an account, never the hash.
async function listUsers() {
  const users = await repo.getUsers();
  return users.map((user) => ({
    username: user.username, role: user.role, person_id: user.person_id || '',
    display_name: user.display_name || '', active: String(user.active) === 'No' ? 'No' : 'Yes',
  }));
}

// Bumping password_version is the whole point: with no session table, it is the only way
// a new password can invalidate the cookies issued under the old one.
async function writePassword(user, password) {
  const version = String((Number(user.password_version) || 0) + 1);
  try {
    await repo.updateUser({
      username: user.username,
      password_hash: await auth.hashPassword(password),
      password_version: version,
    });
  } catch (err) { throw mapRepoError(err); }
  return version;
}

async function changePassword(username, currentPassword, newPassword) {
  const user = await repo.getUserByUsername(username);
  if (!user) throw new StoreError('Account not found', 404);
  if (!await auth.verifyPassword(currentPassword || '', user.password_hash)) {
    throw new StoreError('Validation failed', 400, { current_password: 'is incorrect' });
  }
  assertPasswordAcceptable(newPassword, 'new_password');
  if (String(newPassword) === String(currentPassword)) {
    throw new StoreError('Validation failed', 400, { new_password: 'must be different from the current password' });
  }
  return { username: user.username, password_version: await writePassword(user, newPassword) };
}

// Administrator reset: the password is generated and handed back once, in this response.
// It is deliberately not derived from anything and not recorded anywhere else.
async function resetPassword(username) {
  const user = await repo.getUserByUsername(username);
  if (!user) throw new StoreError('Account not found', 404);
  const temporary = auth.generateTemporaryPassword();
  const version = await writePassword(user, temporary);
  return { username: user.username, temporary_password: temporary, password_version: version };
}

async function setUserRole(username, role) {
  if (!ROLES.includes(role)) throw new StoreError(`Role must be one of: ${ROLES.join(', ')}`, 400, { role: 'is not a valid role' });
  const user = await repo.getUserByUsername(username);
  if (!user) throw new StoreError('Account not found', 404);
  if (user.role === role) return { username: user.username, role };
  if (user.role === 'admin') await assertNotLastAdmin(username, 'This is the last administrator account. Grant admin to someone else first.');
  try { await repo.updateUser({ username: user.username, role }); } catch (err) { throw mapRepoError(err); }
  return { username: user.username, role };
}

// db/createUser.js — creates an account or resets an existing one's password, so it also
// has to invalidate the sessions of the account it overwrites.
async function createUser(row) {
  const existing = await repo.getUserByUsername(row.username);
  return repo.createUser({
    ...row,
    password_version: String((Number(existing && existing.password_version) || 0) + (existing ? 1 : 0)),
  });
}

module.exports = {
  ensureDataFiles, init, close,
  readCurrent, readOwnedRequests, isRequestOwner, readLog, readCostCodes, readActivityCodes, readPeople, createPerson, updatePerson,
  readSuppliers, getSupplierAmendmentTemplate, supplierProfilesPersistent,
  createRequest, updateRequest, saveReturnedRequest, saveInvoiceProgress, setDeleted, hardDeleteDraft, getRequestHistory, getRequestById,
  upsertAttachment, removeAttachment, assertAttachmentAllowed, findAttachmentByStored,
  readSuppliersAll, createSupplier, updateSupplier, setSupplierDeleted,
  getUserByUsername, createUser, registerUser, listUsers,
  changePassword, resetPassword, setUserRole,
  StoreError, localDate, APP_TZ,
  backend: repo.kind,
  isStorageUnavailable,
  paths: repo.paths,
};
