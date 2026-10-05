'use strict';

// Authenticated requester intake portal + finance admin work queue.

const state = {
  options: {},
  requests: [],
  suppliers: [],
  people: [],
  users: [],
  currentUser: '',
  currentPersonId: '',
  currentUserDisplay: '',
  role: 'requester',
  activeTab: 'new-finance',
  requestCreationGroup: 'finance',
  adminTab: 'requests',
  selectedId: null,
  selectedVersion: '',
  editingDraftId: null,
  editingDraftVersion: '',
  // Snapshot of the draft as loaded into the editor, so leaving it can tell an untouched
  // draft (leave silently) from an edited one (ask save / discard).
  editorBaseline: '',
  detailOpener: null,
  adminAttachmentEditor: null,
  adminFinanceEditor: null,
};

const LOCAL_DRAFT_DB_NAME = 'finance-request-tracker-local-v1';
const LOCAL_DRAFT_STORE = 'drafts';
const LOCAL_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let localDraftDbPromise = null;
let localDraftSaveTimer = null;

// Supplier Setup remains in the data model and admin processing queue for existing or
// future controlled use, but it is not currently offered in the requester's new-request
// picker. Existing drafts can still be reopened explicitly.
// Travel is hidden for now as well: the booking workflow is being reworked, so the
// New Travel Request tab disappears with it (the tab is driven by this list, not by a
// second hard-coded flag). Existing Travel drafts can still be reopened explicitly.
const HIDDEN_REQUESTER_TYPES = new Set(['Supplier Setup', 'Travel']);
// Travel Allowance keeps its own request type and workflow, but it belongs to the
// Finance/Procurement workspace. Only a booking request belongs in Travel workspace.
const TRAVEL_WORKSPACE_TYPES = new Set(['Travel']);
const NEW_SUPPLIER_FILTER = '__new_supplier__';

function requesterTypesForGroup(group) {
  const available = (state.options.request_types || []).filter((type) => !HIDDEN_REQUESTER_TYPES.has(type));
  return available.filter((type) => group === 'travel' ? TRAVEL_WORKSPACE_TYPES.has(type) : !TRAVEL_WORKSPACE_TYPES.has(type));
}

function requesterTabForType(type) {
  // A hidden type has no workspace of its own to open in, so it lands in the one tab
  // that is always there.
  return TRAVEL_WORKSPACE_TYPES.has(type) && !HIDDEN_REQUESTER_TYPES.has(type)
    ? 'new-travel' : 'new-finance';
}

// The travel workspace tab exists only while there is a travel request type to create.
function syncRequesterTabVisibility() {
  const travelTab = el('requester-tabs')?.querySelector('[data-tab="new-travel"]');
  if (travelTab) travelTab.hidden = requesterTypesForGroup('travel').length === 0;
}

// ---------- generic helpers ----------

function el(id) { return document.getElementById(id); }

function showToast(message, tone = 'info') {
  const region = el('toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  region.replaceChildren(toast);
  window.setTimeout(() => { if (toast.isConnected) toast.remove(); }, 6000);
}

async function api(path, opts) {
  // Identity is the session cookie (sent automatically); no X-User header.
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = { error: text }; } }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.fields = data && data.fields;
    err.status = res.status;
    throw err;
  }
  return data;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Timestamps read the same for everyone: a fixed YYYY-MM-DD hh:mm:ss AM/PM layout in the
// app's timezone, not the browser's locale and not the viewer's clock.
let _timeFmt = null;
let _timeFmtTz = null;
function timeFormatter() {
  const tz = state.options.app_timezone || undefined;
  if (!_timeFmt || _timeFmtTz !== tz) {
    _timeFmtTz = tz;
    _timeFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    });
  }
  return _timeFmt;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = {};
  for (const part of timeFormatter().formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.dayPeriod}`;
}

// waiting_on is '' for terminal statuses — nobody is holding the request.
function waitingLabel(value) {
  const label = String(value || '').trim();
  if (!label) return 'N/A';
  return userFacingLabel(label);
}

function userFacingLabel(value) {
  return String(value == null ? '' : value)
    .replace(/\bRequester\b/g, 'User')
    .replace(/\bRequestor\b/g, 'User')
    .replace(/\brequester\b/g, 'user')
    .replace(/\brequestor\b/g, 'user');
}

function titleCaseStatus(value) {
  return String(value == null ? '' : value).replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function appLocalDate() {
  if (state.options.local_date) return state.options.local_date;
  return new Date().toISOString().slice(0, 10);
}

function parseArr(v) {
  if (Array.isArray(v)) return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return [];
  try { const p = JSON.parse(s); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}

function parseObj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return { ...v };
  const s = String(v == null ? '' : v).trim();
  if (!s) return {};
  try { const p = JSON.parse(s); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch (e) { return {}; }
}

function subtypeKey(r) {
  const subs = (state.options.subtypes_by_type || {})[r.request_type] || [];
  return subs.length ? String(r.sub_type || '') : '';
}

// Missing required fields / attachments / lines for a request (drives the "info" flag).
function incompleteOf(r) {
  const key = subtypeKey(r);
  const req = [...requiredFieldNamesFor(r.request_type, key, r.supplier_type)];
  const missing = req.filter((f) => {
    return String(r[f] || '').trim() === '';
  });
  if (String(r.activity_code || '').trim() === 'Other'
      && String(r.activity_code_other || '').trim() === '') missing.push('activity_code_other');
  if (r.request_type === 'Reimbursement' && parseArr(r.reimbursement_items).length === 0) {
    missing.push('reimbursement_items');
  }
  if (r.request_type === 'Supplier Setup' && !Object.keys(parseObj(r.supplier_form_data)).length) missing.push('supplier_form_data');
  const reqAtt = requiredAttachmentPurposesFor(r.request_type, key, r.supplier_type);
  const present = new Set(parseArr(r.attachments).filter((a) => a && String(a.filename || '').trim() && String(a.stored || '').trim()).map((a) => a.purpose));
  for (const p of reqAtt) if (!present.has(p)) missing.push('attachment:' + p);
  return missing;
}

function isDeleted(r) { return String(r.deleted || '') === 'Yes'; }
function fieldLabel(name) { return (FIELD_SPECS[name] && FIELD_SPECS[name].label) || name; }
function displayCodeValue(row, name) {
  const selected = String(row[name] || '').trim();
  if (selected !== 'Other') return row[name];
  const custom = String(row[`${name}_other`] || '').trim();
  return custom ? `Other — ${custom}` : 'Other (custom code not supplied)';
}

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, 'i');

// `crypto.randomUUID()` is only exposed in a secure browser context.  The deployed
// application may still be reached over plain HTTP, where Chromium keeps `crypto`
// but omits that method; opening an admin request then failed as soon as the detail
// renderer needed a client-side invoice/document id.  These ids are only DOM/form
// correlation keys (the server assigns and validates its own ids), so keep a UUID
// shaped fallback for non-secure contexts and older browsers.
function newClientUuid() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableClientId(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return UUID_RE.test(candidate) ? candidate : newClientUuid();
}

function requestForAttachmentLabels() {
  return state.requests.find((request) => request.request_id === state.selectedId) || null;
}

function itemPosition(items, itemId) {
  const index = items.findIndex((item) => item && item.item_id === String(itemId || '').toLowerCase());
  return index < 0 ? 0 : index + 1;
}

function localDraftKey(requestId = state.editingDraftId || 'new') {
  return `${state.currentUser || 'anonymous'}|${requestId || 'new'}`;
}

function openLocalDraftDb() {
  if (localDraftDbPromise) return localDraftDbPromise;
  if (!window.indexedDB) return Promise.resolve(null);
  localDraftDbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(LOCAL_DRAFT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_DRAFT_STORE)) db.createObjectStore(LOCAL_DRAFT_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local draft storage'));
  }).catch(() => null);
  return localDraftDbPromise;
}

async function localDraftPut(record) {
  const db = await openLocalDraftDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(LOCAL_DRAFT_STORE, 'readwrite');
    tx.objectStore(LOCAL_DRAFT_STORE).put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

async function localDraftGet(key) {
  const db = await openLocalDraftDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(LOCAL_DRAFT_STORE, 'readonly');
    const request = tx.objectStore(LOCAL_DRAFT_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

async function localDraftDelete(key) {
  const db = await openLocalDraftDb();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(LOCAL_DRAFT_STORE, 'readwrite');
    tx.objectStore(LOCAL_DRAFT_STORE).delete(key);
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
}

async function saveLocalDraftSnapshot() {
  if (!state.currentUser) return;
  const form = el('create-form');
  if (!form || !form.request_type || !form.request_type.value) return;
  const files = collectAttachmentFiles().map(({ purpose, file }) => ({
    purpose,
    name: file.name,
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified || Date.now(),
    blob: file,
  }));
  await localDraftPut({
    key: localDraftKey(),
    request_id: state.editingDraftId || '',
    version: state.editingDraftVersion || '',
    saved_at: Date.now(),
    body: collectRequestBody(),
    files,
  });
}

function scheduleLocalDraftSave() {
  window.clearTimeout(localDraftSaveTimer);
  localDraftSaveTimer = window.setTimeout(() => { saveLocalDraftSnapshot().catch(() => {}); }, 350);
}

function localFileInputForPurpose(purpose) {
  if (String(purpose).startsWith('receipt:')) {
    const itemId = String(purpose).split(':')[1];
    return [...(el('reimbursement-table')?.querySelectorAll('tbody tr') || [])]
      .find((row) => row.dataset.itemId === itemId)?.querySelector('.line-receipt') || null;
  }
  return [...el('create-form').querySelectorAll('input[type=file][data-purpose]')]
    .find((input) => input.dataset.purpose === purpose) || null;
}

function restoreLocalFiles(files) {
  for (const saved of files || []) {
    if (!saved || !saved.blob) continue;
    const input = localFileInputForPurpose(saved.purpose);
    if (!input || !window.DataTransfer) continue;
    try {
      const file = new File([saved.blob], saved.name || 'restored-file', {
        type: saved.type || saved.blob.type || 'application/octet-stream',
        lastModified: saved.lastModified || Date.now(),
      });
      const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) { /* A browser without writable FileLists can still restore the fields. */ }
  }
}

async function restoreLocalDraft(record) {
  const body = record && record.body;
  if (!body || !body.request_type) return false;
  const cf = el('create-form');
  // Hidden request types (including retained Travel drafts) are still selectable while
  // restoring an explicitly saved draft, even though they are not offered for new work.
  populateRequesterTypeSelect(body.request_type, true);
  cf.request_type.value = body.request_type;
  onTypeChange();
  cf.sub_type.value = body.sub_type || '';
  renderDynamicForm(body);
  restoreLocalFiles(record.files);
  if (record.request_id) {
    adoptDraftInEditor(record.request_id, record.version || '');
    state.editorBaseline = JSON.stringify(collectRequestBody());
  } else state.editorBaseline = '';
  updateRequestProgress();
  return true;
}

async function offerLocalDraftRestore() {
  const key = localDraftKey('new');
  const record = await localDraftGet(key);
  if (!record || Date.now() - Number(record.saved_at || 0) > LOCAL_DRAFT_TTL_MS) {
    if (record) await localDraftDelete(key);
    return;
  }
  const recovery = el('create-recovery');
  if (!recovery) return;
  recovery.replaceChildren();
  const title = document.createElement('strong'); title.textContent = 'A local draft is available';
  const note = document.createElement('span'); note.textContent = 'It was saved in this browser and can be restored if the database was temporarily unavailable.';
  const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'btn-secondary'; restore.textContent = 'Restore local draft';
  const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'btn-link'; discard.textContent = 'Discard local draft';
  restore.addEventListener('click', async () => {
    await restoreLocalDraft(record);
    recovery.hidden = true;
    showToast('Local draft restored. Review it before saving or submitting.', 'info');
  });
  discard.addEventListener('click', async () => { await localDraftDelete(key); recovery.hidden = true; });
  recovery.append(title, note, restore, discard); recovery.hidden = false;
}

async function cacheLocalOptions(options) {
  if (!state.currentUser || !options) return;
  await localDraftPut({ key: localDraftKey('options'), saved_at: Date.now(), options });
}

async function readCachedLocalOptions() {
  const record = await localDraftGet(localDraftKey('options'));
  if (!record || Date.now() - Number(record.saved_at || 0) > LOCAL_DRAFT_TTL_MS) return null;
  return record.options || null;
}
function displayAmount(row) {
  const raw = String(row.amount_inc_gst || row.amount || '').trim();
  if (!raw) return '';
  return formatMoney(raw);
}

function formatMoney(raw) {
  if (raw == null || String(raw).trim() === '') return 'Not supplied';
  const value = Number(raw);
  return Number.isFinite(value)
    ? `$${new Intl.NumberFormat('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`
    : `$${String(raw == null ? '' : raw)}`;
}

function attachmentLabel(purpose) {
  const row = requestForAttachmentLabels();
  const invoice = new RegExp(`^invoice:(${UUID_SOURCE})$`, 'i').exec(String(purpose || ''));
  if (invoice) return `Invoice ${itemPosition(parseArr(row && row.invoice_items), invoice[1]) || ''}`.trim();
  const invoiceOther = new RegExp(`^invoice_other:(${UUID_SOURCE}):(${UUID_SOURCE})$`, 'i').exec(String(purpose || ''));
  if (invoiceOther) return `Invoice ${itemPosition(parseArr(row && row.invoice_items), invoiceOther[1]) || ''} — Other document`.replace('  —', ' —');
  if (new RegExp(`^invoice_approval_other:${UUID_SOURCE}$`, 'i').test(String(purpose || ''))) return 'Invoice approval — Other document';
  if (new RegExp(`^other_document:${UUID_SOURCE}$`, 'i').test(String(purpose || ''))) return 'Other documents';
  const receipt = new RegExp(`^receipt:(${UUID_SOURCE})$`, 'i').exec(String(purpose || ''));
  if (receipt) return `Receipt for expense line ${itemPosition(parseArr(row && row.reimbursement_items), receipt[1]) || ''}`.trim();
  return (state.options.attachment_labels || {})[purpose] || purpose;
}

// ---------- field configuration ----------

const FIELD_SPECS = {
  requester_name: { label: 'User', control: 'staff' },
  beneficiary_name: { label: 'Traveller', control: 'staff' },
  supplier_type: { label: 'Supplier type', control: 'suppliertype' },
  supplier_quote_number: { label: 'Supplier quote #', control: 'text' },
  activity_code: { label: 'Activity code', control: 'activitycode' },
  activity_code_other: { label: 'Other activity code', control: 'text' },
  short_description: { label: 'Short description', control: 'textarea' },
  amount_ex_gst: { label: 'Total Excl. GST ($)', control: 'amount' },
  amount_inc_gst: { label: 'Total Incl. GST ($)', control: 'amount' },
  invoice_amount_ex_gst: { label: 'Total Excl. GST ($)', control: 'amount' },
  invoice_amount: { label: 'Total Incl. GST ($)', control: 'amount' },
  spending_approver: { label: 'Approver', control: 'approver' },
  destination: { label: 'Destination', control: 'text' },
  travel_start_date: { label: 'Departure date', control: 'date' },
  travel_end_date: { label: 'Return date', control: 'date' },
  supplier_form_data: { label: 'Supplier/Payee form', control: 'text' },
};

// Keep every file picker aligned with the server's extension allow-list. The server
// remains authoritative; this only prevents a confusing picker that offers files the
// upload endpoint will immediately reject.
const UPLOAD_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.doc,.docx,.xls,.xlsx,.csv,.txt,.msg,.eml';

function configureFileInput(input) {
  input.accept = UPLOAD_ACCEPT;
  return input;
}

const SUBTYPE_FIELDS = {
  'Procurement||Purchase / PO request': ['requester_name', 'supplier_type', 'supplier_quote_number', 'activity_code', 'spending_approver', 'short_description', 'amount_ex_gst', 'amount_inc_gst'],
  'Travel||Domestic': ['beneficiary_name', 'activity_code', 'travel_start_date', 'travel_end_date'],
  'Travel||International': ['beneficiary_name'],
  'Travel Allowance||Meals/incidentals': ['beneficiary_name', 'activity_code', 'destination', 'travel_start_date', 'travel_end_date'],
  'Reimbursement||Reimbursement': ['requester_name', 'activity_code'],
  'Supplier Setup||New supplier': ['requester_name'],
  'Supplier Setup||Amend existing supplier': ['requester_name'],
};

const DYNAMIC_REQUIRED_FIELDS = new Set(['amount_ex_gst', 'amount_inc_gst']);

const PROCUREMENT_INTAKE_DOCUMENTS = ['quote', 'approval_email'];

function requiredFieldNamesFor(type, subType, supplierType = '') {
  const required = new Set(((state.options.required_by_subtype || {})[type] || {})[subType] || []);
  // A cached options payload from before this rule was published must not leave the
  // browser showing a form that disagrees with the server's mandatory check.
  const activityRequiredFor = Array.isArray(state.options.activity_code_required_supplier_types)
    ? state.options.activity_code_required_supplier_types : ['Existing Supplier'];
  if (type === 'Procurement' && activityRequiredFor.includes(String(supplierType || '').trim())) {
    required.add('activity_code');
  }
  return required;
}

function wireActivityCodeRequirement(container, type, subType, fallbackSupplierType = '') {
  const activity = container.querySelector('[name=activity_code]');
  if (!activity) return;
  const supplierType = container.querySelector('[name=supplier_type]');
  const title = activity.closest('label')?.querySelector(':scope > span');
  const apply = () => {
    const selected = supplierType ? supplierType.value : fallbackSupplierType;
    const required = requiredFieldNamesFor(type, subType, selected).has('activity_code');
    activity.required = required;
    if (!title) return;
    const star = title.querySelector('.req-star');
    if (required && !star) {
      const s = document.createElement('span'); s.className = 'req-star'; s.textContent = ' *';
      title.appendChild(s);
    } else if (!required && star) star.remove();
  };
  if (supplierType) supplierType.addEventListener('change', apply);
  apply();
}

function isNewSupplierType(value) {
  return String(value || '').trim().toLowerCase() === 'new supplier';
}

function requiredAttachmentPurposesFor(type, subType, supplierType = '') {
  let required = [...(((state.options.required_attachments_by_subtype || {})[type] || {})[subType] || [])];
  if (type === 'Procurement' && isNewSupplierType(supplierType)
      && !required.includes('new_supplier_form')) {
    required = [...required, 'new_supplier_form'];
  }
  return [...new Set(required)];
}

// The activity code is only mandatory for an existing supplier, and the supplier type
// can change after the field has been built, so the star and the constraint follow the
// picker rather than being frozen at render time.
function wireActivityCodeRequirement(container, type, subType, fallbackSupplierType = '') {
  const activity = container.querySelector('[name=activity_code]');
  if (!activity) return;
  const supplierType = container.querySelector('[name=supplier_type]');
  const title = activity.closest('label')?.querySelector(':scope > span');
  const apply = () => {
    const selected = supplierType ? supplierType.value : fallbackSupplierType;
    const required = requiredFieldNamesFor(type, subType, selected).has('activity_code');
    activity.required = required;
    if (!title) return;
    const star = title.querySelector('.req-star');
    if (required && !star) {
      const s = document.createElement('span'); s.className = 'req-star'; s.textContent = ' *';
      title.appendChild(s);
    } else if (!required && star) star.remove();
  };
  if (supplierType) supplierType.addEventListener('change', apply);
  apply();
}

function setAttachmentRequired(field, required) {
  if (!field) return;
  const uploaded = !!field.label.querySelector('.attachment-uploaded');
  const missing = required && !uploaded;
  field.input.required = missing;
  const title = field.label.querySelector(':scope > span');
  if (!title) return;
  let star = title.querySelector('.attachment-required-star');
  if (required && !star) {
    star = document.createElement('span');
    star.className = 'req-star attachment-required-star';
    star.textContent = ' *';
    title.appendChild(star);
  }
  if (!required && star) star.remove();
}

function requestFieldValue(row, name) {
  if (name === 'beneficiary_name') return row.beneficiary_person_id || row.beneficiary_name;
  if (name === 'spending_approver') return row.spending_approver_person_id || row.spending_approver;
  return row[name];
}

// Procurement invoice checklist. chk_forwarded_with_approval was retired: forwarding the
// invoice on to Finance is the act of submitting this panel, so confirming it separately
// asked for the same thing twice. The stored column is left alone so historical rows keep
// what they recorded.
const ADMIN_PROC_CHECKS = [
  ['chk_po_included', 'PO number included'],
  ['chk_desc_matches_po', 'Description matches PO'],
  ['chk_service_completed', 'Service completed as per invoice'],
  ['chk_forwarded_to_approver', 'Approved by spending approver'],
];

// Procurement statuses the workflow keys off. Defined in lib/constants.js; named here so
// the status strings appear once each rather than scattered through the UI code.
const PROCUREMENT_SUBMIT_TO_ADMIN_STATUS = 'Submit to Admin';
const PROCUREMENT_RETURN_TO_REQUESTOR_STATUS = 'Return to User';
const PO_ISSUED_STATUS = 'PO issued to user';
const INVOICE_RECEIVED_STATUS = 'Invoice with PO and approval received';
const PROCUREMENT_COMPLETE_STATUS = 'Complete';

function isReturnedStatus(rowOrStatus) {
  const status = typeof rowOrStatus === 'string' ? rowOrStatus : rowOrStatus?.current_status;
  return status === PROCUREMENT_RETURN_TO_REQUESTOR_STATUS
    || status === 'Return to Requestor'
    || status === 'Returned for Info';
}

function returnStatusFor(row) {
  return row?.request_type === 'Procurement'
    ? PROCUREMENT_RETURN_TO_REQUESTOR_STATUS : 'Returned for Info';
}

const SUPPLIER_FORM_LABELS = {
  legal_entity_name: 'Legal entity name', has_abn: 'Has an ABN?', abn: 'ABN', no_abn_reason: 'Reason no ABN',
  street_address: 'Street address', suburb: 'Suburb', country: 'Country', postcode: 'Post/ZIP code', state_region: 'State/region',
  contact_name: 'Contact name', contact_phone: 'Telephone', contact_email: 'Contact email',
  purchase_order_email: 'Purchase order email', remittance_email: 'Remittance email', nt_enterprise: 'NT enterprise', icn: 'Indigenous Corporation Number (ICN)',
  bank_type: 'Payment method', bank_name: 'Bank/financial institution', bank_branch_address: 'Branch address', bank_account_name: 'Account name',
  bsb: 'BSB', account_number: 'Account number', bank_account_currency: 'Bank account currency', payment_currency: 'Payment currency',
  swift_sort_bank_code: 'SWIFT/sort/bank code', iban: 'IBAN', supporting_document_type: 'Supporting document supplied',
  terms_accepted: 'Purchase order terms accepted', declaration_name: 'Authorised representative', declaration_date: 'Declaration date',
  declaration_confirmed: 'Declaration confirmed',
  bank_details_action: 'Bank details', account_number_masked: 'Account number',
};

const AUSTRALIAN_STATES_AND_TERRITORIES = [
  'ACT — Australian Capital Territory',
  'NSW — New South Wales',
  'NT — Northern Territory',
  'QLD — Queensland',
  'SA — South Australia',
  'TAS — Tasmania',
  'VIC — Victoria',
  'WA — Western Australia',
];

// ---------- control builders ----------

function opt(label, value) {
  const o = document.createElement('option');
  o.textContent = label;
  o.value = value;
  return o;
}

function fillNameSelect(sel, names, blank, current) {
  sel.innerHTML = '';
  sel.appendChild(opt(blank || '— select —', ''));
  const list = (names || []).slice();
  if (current && !list.includes(current)) list.push(current);
  for (const n of list) sel.appendChild(opt(n, n));
  if (current) sel.value = current;
}

function fillPersonSelect(sel, people, blank, current) {
  sel.innerHTML = '';
  sel.appendChild(opt(blank || '— select person —', ''));
  for (const person of people || []) sel.appendChild(opt(person.display_name, person.person_id));
  const matched = (people || []).find((person) => person.person_id === current || person.display_name === current);
  if (current && !matched) sel.appendChild(opt(`${current} (inactive or unavailable)`, current));
  sel.value = matched ? matched.person_id : (current || '');
}

function fillPersonNameSelect(sel, people, blank, current) {
  fillNameSelect(sel, (people || []).map((person) => person.display_name), blank, current);
}

function fillSupplierSelect(sel, current) {
  sel.innerHTML = '';
  sel.appendChild(opt('— select supplier —', ''));
  const list = state.options.suppliers || [];
  for (const s of list) {
    const details = [s.vendor_id ? `Vendor ID ${s.vendor_id}` : '', s.abn ? `ABN ${s.abn}` : ''].filter(Boolean).join(' · ');
    sel.appendChild(opt(details ? `${s.supplier_name} (${details})` : s.supplier_name, s.supplier_id));
  }
  // Keep a link the dropdown no longer offers, so opening the form cannot silently clear it.
  if (current && !list.some((s) => s.supplier_id === current)) sel.appendChild(opt(`${current} (no longer selectable)`, current));
  const hint = opt('Supplier not listed? Contact finance', '');
  hint.disabled = true;
  sel.appendChild(hint);
  if (current) sel.value = current;
}

function otherCodeOptionLabel(otherValue) {
  const custom = String(otherValue || '').trim();
  return custom ? `Other — ${custom}` : 'Other';
}

function fillActivitySelect(sel, current, otherValue = '') {
  sel.innerHTML = '';
  // Every listed activity is selectable. The reference data still tags each activity row
  // with its cost centre for reporting, but no form asks for one any more.
  sel.appendChild(opt('— select —', ''));
  const all = (state.options.activity_codes || []).slice();
  if (current && current !== 'Other' && !all.some((a) => a.activity_code === current)) all.push({ activity_code: current, description: '' });
  for (const a of all) sel.appendChild(opt(a.description ? `${a.activity_code} — ${a.description}` : a.activity_code, a.activity_code));
  if (!all.some((a) => a.activity_code === 'Other')) sel.appendChild(opt(otherCodeOptionLabel(otherValue), 'Other'));
  if (current) sel.value = current;
}

function syncOtherCodeInput(select, otherInput, label) {
  const isOther = select.value === 'Other';
  otherInput.hidden = !isOther;
  otherInput.disabled = !isOther;
  otherInput.required = isOther;
  otherInput.setAttribute('aria-hidden', String(!isOther));
  otherInput.placeholder = isOther ? `Enter other ${label.toLowerCase()}` : '';
  if (isOther) otherInput.setAttribute('aria-label', `Other ${label.toLowerCase()}`);
  else { otherInput.removeAttribute('aria-label'); otherInput.value = ''; }
  const otherOption = [...select.options].find((option) => option.value === 'Other');
  if (otherOption) otherOption.textContent = otherCodeOptionLabel(isOther ? otherInput.value : '');
}

function makeControl(name, spec, value, otherValue = '') {
  let c;
  switch (spec.control) {
    case 'textarea': c = document.createElement('textarea'); c.rows = 4; c.classList.add('long-text-input'); break;
    case 'amount': c = document.createElement('input'); c.type = 'number'; c.step = '0.01'; c.min = '0'; break;
    case 'gstmethod':
      c = document.createElement('select');
      c.append(opt('— select —', ''), opt('Total includes GST', 'Total includes GST'), opt('Enter GST separately', 'Enter GST separately'));
      break;
    case 'date': c = document.createElement('input'); c.type = 'date'; break;
    case 'staff':
      if (name === 'requester_name' && state.role === 'requester') {
        c = document.createElement('input'); c.type = 'text';
        c.value = state.currentUserDisplay;
        c.readOnly = true;
      } else {
        c = document.createElement('select');
        fillPersonSelect(c, state.options.travellers, '— select traveller —', value);
      }
      break;
    case 'supplier': c = document.createElement('select'); fillSupplierSelect(c, value); break;
    case 'suppliertype':
      c = document.createElement('select');
      c.append(opt('— select supplier type —', ''), opt('New Supplier', 'New Supplier'), opt('Existing Supplier', 'Existing Supplier'));
      if (value != null) c.value = value;
      break;
    case 'approver': c = document.createElement('select'); fillPersonSelect(c, state.options.approvers, '— select approver —', value); break;
    case 'activitycode': c = document.createElement('select'); fillActivitySelect(c, value, otherValue); break;
    default: c = document.createElement('input'); c.type = 'text';
  }
  c.name = name === 'beneficiary_name' ? 'beneficiary_person_id'
    : name === 'spending_approver' ? 'spending_approver_person_id' : name;
  if (value != null && !['supplier', 'suppliertype', 'staff', 'approver', 'activitycode'].includes(spec.control)) {
    c.value = value;
  }
  if (spec.control === 'activitycode') {
    const codeField = document.createElement('div');
    codeField.className = 'code-control-pair';
    const other = document.createElement('input');
    other.type = 'text';
    other.name = `${name}_other`;
    other.value = otherValue == null ? '' : otherValue;
    other.className = 'code-other-input';
    other.setAttribute('aria-label', `Other ${spec.label.toLowerCase()}`);
    c.addEventListener('change', () => syncOtherCodeInput(c, other, spec.label));
    other.addEventListener('input', () => syncOtherCodeInput(c, other, spec.label));
    codeField.append(c, other);
    syncOtherCodeInput(c, other, spec.label);
    return codeField;
  }
  return c;
}

function makeField(name, requiredSet, value, otherValue = '') {
  const spec = FIELD_SPECS[name];
  if (!spec) return null;
  const label = document.createElement('label');
  if (spec.control === 'textarea') label.classList.add('long-text-field');
  const span = document.createElement('span');
  span.textContent = spec.label;
  // Supplier Type is required for current Procurement submissions. Keep it here as a
  // presentation rule so legacy rows linked to an existing supplier remain editable,
  // while the server's conditional validation remains the final authority.
  const required = (requiredSet.has(name) || (name === 'supplier_type' && state.role !== 'admin'))
    && !DYNAMIC_REQUIRED_FIELDS.has(name);
  if (required) {
    const s = document.createElement('span');
    s.className = 'req-star';
    s.textContent = ' *';
    span.appendChild(s);
  }
  label.appendChild(span);
  const c = makeControl(name, spec, value, otherValue);
  const validationControl = c.querySelector ? (c.querySelector('select, input, textarea') || c) : c;
  if (required) validationControl.required = true;
  label.appendChild(c);
  return label;
}

function supplierFormControl(name, values, options = {}) {
  const label = document.createElement('label');
  label.dataset.supplierFieldWrap = name;
  const title = document.createElement('span');
  title.textContent = SUPPLIER_FORM_LABELS[name] || name;
  if (options.required) {
    const star = document.createElement('span'); star.className = 'req-star'; star.textContent = ' *'; title.appendChild(star);
  }
  label.appendChild(title);
  let input;
  if (options.choices) {
    input = document.createElement('select');
    input.appendChild(opt('— select —', ''));
    for (const choice of options.choices) {
      const [labelText, value] = Array.isArray(choice) ? choice : [choice, choice];
      input.appendChild(opt(labelText, value));
    }
  } else if (options.checkbox) {
    label.classList.add('checkbox-field', 'supplier-confirmation');
    input = document.createElement('input'); input.type = 'checkbox';
    const wording = document.createElement('span'); wording.textContent = options.checkbox;
    if (options.required) {
      const star = document.createElement('span'); star.className = 'req-star'; star.textContent = ' *';
      wording.appendChild(star);
    }
    label.innerHTML = ''; label.append(input, wording);
  } else if (options.multiline) {
    label.classList.add('long-text-field');
    input = document.createElement('textarea'); input.rows = options.rows || 4; input.className = 'long-text-input';
  } else {
    input = document.createElement('input'); input.type = options.type || 'text';
    if (options.inputmode) input.inputMode = options.inputmode;
  }
  input.dataset.supplierField = name;
  input.autocomplete = 'off';
  if (options.required) input.required = true;
  if (options.checkbox) input.checked = values[name] === 'Yes';
  else input.value = values[name] || options.defaultValue || '';
  if (!options.checkbox) label.appendChild(input);
  return { label, input };
}

function supplierSection(container, title) {
  const heading = document.createElement('div');
  heading.className = 'form-section-title supplier-section-title';
  heading.textContent = title;
  container.appendChild(heading);
}

function renderSupplierFormFields(container, values = {}, options = {}) {
  container.classList.add('supplier-form-grid');
  const add = (name, config) => {
    const built = supplierFormControl(name, values, config);
    container.appendChild(built.label);
    return built;
  };

  let existingSupplier = null;
  if (options.includeExistingSupplier && options.subType === 'Amend existing supplier') {
    const label = document.createElement('label');
    const title = document.createElement('span'); title.textContent = 'Existing supplier';
    const star = document.createElement('span'); star.className = 'req-star'; star.textContent = ' *'; title.appendChild(star);
    const select = document.createElement('select'); select.name = 'supplier_id'; select.required = true; fillSupplierSelect(select, options.supplierId || '');
    label.append(title, select); container.appendChild(label);
    existingSupplier = select;
  }

  supplierSection(container, 'Supplier / payee details');
  add('legal_entity_name', { required: true });
  const hasAbn = add('has_abn', { required: true, choices: ['Yes', 'No'], defaultValue: 'Yes' });
  const abn = add('abn', { required: true, inputmode: 'numeric' });
  const noAbn = add('no_abn_reason', { required: true, multiline: true });
  add('street_address', { required: true });
  add('suburb', { required: true });
  const country = add('country', { required: true, defaultValue: 'Australia' });
  add('postcode', { required: true });
  const stateRegion = add('state_region', {
    required: true,
    choices: AUSTRALIAN_STATES_AND_TERRITORIES.map((label) => [label, label.split(' ')[0]]),
  });
  add('contact_name', { required: true });
  add('contact_phone', { required: true, type: 'tel' });
  add('contact_email', { required: true, type: 'email' });
  add('purchase_order_email', { required: true, type: 'email' });
  const remittance = add('remittance_email', { type: 'email' });
  remittance.input.placeholder = 'Leave blank if same as PO email';
  add('nt_enterprise', { required: true, choices: ['Yes', 'No'], defaultValue: 'No' });
  add('icn', {});

  supplierSection(container, 'Bank details');
  const allowBankReuse = options.subType === 'Amend existing supplier' || values.bank_details_action === 'Unchanged';
  let bankAction = null;
  let bankSummary = null;
  if (allowBankReuse) {
    bankAction = add('bank_details_action', { required: true, choices: ['Unchanged', 'Change'], defaultValue: values.bank_details_action || 'Change' });
    bankSummary = document.createElement('p');
    bankSummary.className = 'span-2 info-note supplier-bank-summary';
    bankSummary.hidden = true;
    container.appendChild(bankSummary);
  }
  const bankType = add('bank_type', { required: true, choices: ['Australian EFT', 'International TT'], defaultValue: 'Australian EFT' });
  const bankName = add('bank_name', { required: true });
  const bankBranch = add('bank_branch_address', { required: true });
  const bankAccountName = add('bank_account_name', { required: true });
  const bsb = add('bsb', { required: true, inputmode: 'numeric' });
  const accountNumber = add('account_number', { required: true, inputmode: 'numeric' });
  const accountCurrency = add('bank_account_currency', { required: true });
  const paymentCurrency = add('payment_currency', { required: true });
  const swift = add('swift_sort_bank_code', { required: true });
  const iban = add('iban', {});

  supplierSection(container, 'Supporting document');
  const termsNote = document.createElement('p'); termsNote.className = 'span-2 muted small supplier-terms-note';
  termsNote.append('Review the ');
  const termsLink = document.createElement('a');
  termsLink.href = '#';
  termsLink.addEventListener('click', (event) => event.preventDefault()); termsLink.textContent = 'demo purchase order terms and conditions';
  termsNote.append(termsLink, ' before accepting.');
  const evidenceSession = document.createElement('div');
  evidenceSession.className = 'span-2 supplier-evidence-session';
  const evidenceTitle = document.createElement('h4'); evidenceTitle.textContent = 'Bank account supporting document';
  const evidenceHelp = document.createElement('p'); evidenceHelp.className = 'muted';
  evidenceHelp.textContent = 'Choose one accepted document type, then upload the matching document.';
  const evidenceTypes = document.createElement('ul'); evidenceTypes.className = 'supplier-evidence-types';
  for (const type of ['Signed supplier letter', 'Quote or tax invoice', 'Financial institution letter', 'Bank statement']) {
    const item = document.createElement('li'); item.textContent = type; evidenceTypes.appendChild(item);
  }
  const evidenceUploadSlot = document.createElement('div'); evidenceUploadSlot.className = 'supplier-evidence-upload-slot';
  evidenceSession.append(evidenceTitle, evidenceHelp, evidenceTypes, evidenceUploadSlot); container.appendChild(evidenceSession);
  const supportingDocument = add('supporting_document_type', { required: true, choices: ['Signed supplier letter', 'Quote or tax invoice', 'Financial institution letter', 'Bank statement'] });
  supportingDocument.label.classList.add('supplier-document-type');
  evidenceSession.insertBefore(supportingDocument.label, evidenceUploadSlot);
  const terms = add('terms_accepted', { required: true, checkbox: 'I accept the demo purchase order terms and conditions.' });
  const declaration = add('declaration_confirmed', { required: true, checkbox: 'I am authorised to represent the supplier/payee and confirm these details are true and correct.' });
  const declarationSession = document.createElement('div'); declarationSession.className = 'span-2 supplier-declaration-session';
  const declarationTitle = document.createElement('h4'); declarationTitle.textContent = 'Declarations';
  declarationSession.append(declarationTitle, termsNote, terms.label, declaration.label);
  container.appendChild(declarationSession);

  const toggleAbn = () => {
    const yes = hasAbn.input.value === 'Yes';
    abn.label.hidden = !yes; abn.input.required = yes;
    noAbn.label.hidden = yes; noAbn.input.required = !yes;
  };
  const toggleBank = () => {
    const unchanged = !!bankAction && bankAction.input.value === 'Unchanged';
    const bankInputs = [bankType, bankName, bankBranch, bankAccountName, bsb, accountNumber, accountCurrency, paymentCurrency, swift, iban];
    for (const item of bankInputs) {
      item.label.hidden = unchanged;
      item.input.required = !unchanged;
    }
    evidenceSession.hidden = unchanged;
    supportingDocument.input.required = !unchanged;
    if (bankSummary) bankSummary.hidden = !unchanged;
    if (unchanged) { syncSupplierEvidenceRequirement(); return; }
    const eft = bankType.input.value === 'Australian EFT';
    bsb.label.hidden = !eft; bsb.input.required = eft;
    for (const item of [accountCurrency, paymentCurrency, swift]) { item.label.hidden = eft; item.input.required = !eft; }
    iban.label.hidden = eft;
    syncSupplierEvidenceRequirement();
  };
  const toggleCountry = () => {
    const australia = country.input.value.trim().toLowerCase() === 'australia';
    stateRegion.label.hidden = !australia; stateRegion.input.required = australia;
  };
  hasAbn.input.addEventListener('change', toggleAbn);
  bankType.input.addEventListener('change', toggleBank);
  if (bankAction) bankAction.input.addEventListener('change', toggleBank);
  country.input.addEventListener('input', toggleCountry);

  const showBankSummary = (summary) => {
    if (!bankSummary) return;
    bankSummary.textContent = summary
      ? `Current bank details: ${summary.bank_name || 'Bank not recorded'}; account name ${summary.bank_account_name || 'not recorded'}; account ${summary.account_number_masked || 'not recorded'}. Full banking details remain hidden.`
      : 'No approved Supplier Setup form with reusable bank details was found. Enter the bank details again and upload new evidence.';
  };
  if (bankSummary && values.account_number_masked) {
    showBankSummary({ bank_name: values.bank_name, bank_account_name: values.bank_account_name, account_number_masked: values.account_number_masked });
  }

  // The amendment template carries no bank details, not even masked ones — see
  // getSupplierAmendmentTemplate in lib/store.js. Keeping the existing details is a
  // server-side operation, so the form only needs to know whether that is possible.
  const showBankOnFile = (canKeep) => {
    if (!bankSummary) return;
    bankSummary.textContent = canKeep
      ? 'Approved bank details are on file for this supplier. Leave "Unchanged" to carry them over — they are never displayed here.'
      : 'No approved Supplier Setup form with reusable bank details was found. Enter the bank details again and upload new evidence.';
  };

  const applyAmendmentTemplate = (template) => {
    for (const [name, value] of Object.entries(template.form_data || {})) {
      const input = container.querySelector(`[data-supplier-field="${name}"]`);
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = value === 'Yes'; else input.value = value || '';
    }
    // Clear anything a previously selected supplier left behind. Bank details are never
    // prefilled now, so a stale value would otherwise be submitted as if it were current.
    for (const name of ['bank_name', 'bank_branch_address', 'bank_account_name', 'bsb',
      'account_number', 'swift_sort_bank_code', 'iban']) {
      const input = container.querySelector(`[data-supplier-field="${name}"]`);
      if (input) input.value = '';
    }
    if (bankAction) {
      const unchangedOption = [...bankAction.input.options].find((item) => item.value === 'Unchanged');
      if (unchangedOption) unchangedOption.disabled = !template.can_keep_bank_details;
      bankAction.input.value = template.can_keep_bank_details ? 'Unchanged' : 'Change';
    }
    showBankOnFile(template.can_keep_bank_details);
    toggleAbn(); toggleBank(); toggleCountry();
  };

  if (existingSupplier) existingSupplier.addEventListener('change', async () => {
    if (!existingSupplier.value) return;
    existingSupplier.disabled = true;
    try {
      applyAmendmentTemplate(await api(`/api/supplier-amendment-template/${encodeURIComponent(existingSupplier.value)}`));
    } catch (err) {
      showToast(formatErr(err), 'error');
    } finally {
      existingSupplier.disabled = false;
    }
  });
  toggleAbn(); toggleBank(); toggleCountry();
}

function syncSupplierEvidenceRequirement() {
  const input = document.querySelector('[data-purpose="supplier_evidence"]');
  if (!input) return;
  const action = el('dynamic-fields').querySelector('[data-supplier-field="bank_details_action"]');
  const unchanged = !!action && action.value === 'Unchanged';
  const session = el('dynamic-fields').querySelector('.supplier-evidence-session');
  if (session) session.hidden = unchanged;
  input.required = false; // Upload happens after the Draft row is created; the server enforces it on submit.
  if (!session) {
    const visible = [...el('attachments-fields').children].some((child) => !child.hidden);
    el('attachments-section').hidden = !visible;
  }
}

function collectSupplierFormData(container) {
  const data = {};
  container.querySelectorAll('[data-supplier-field]').forEach((input) => {
    data[input.dataset.supplierField] = input.type === 'checkbox' ? (input.checked ? 'Yes' : 'No') : input.value.trim();
  });
  return data;
}

// ---------- bootstrap ----------

async function init() {
  wireAuth();
  let me = null;
  try { me = await api('/api/me'); } catch (e) { me = null; }
  if (me) await startAppSafely(me); else showLogin();
}

function showLogin() {
  el('login-view').hidden = false;
  el('app-main').hidden = true;
  el('identity-bar').hidden = true;
  el('password-panel').hidden = true;
  showAuthForm('login');
}

function showStartupError() {
  showLogin();
  const msg = el('login-msg');
  msg.textContent = 'We could not load your workspace. Please try signing in again.';
  msg.className = 'msg err';
}

async function startAppSafely(me) {
  try {
    await startApp(me);
    return true;
  } catch (err) {
    showStartupError();
    return false;
  }
}

// Sign in and register are the same card in two states, not two pages: the app is a
// single static document and a second page would need its own routing and its own
// "already signed in" redirect for no gain.
function showAuthForm(which) {
  const registering = which === 'register';
  el('login-form').hidden = registering;
  el('register-form').hidden = !registering;
  const first = (registering ? el('register-form') : el('login-form')).querySelector('input');
  if (first) first.focus();
}

async function startApp(me) {
  state.currentUser = me.username;
  state.currentPersonId = me.person_id || '';
  state.currentUserDisplay = me.display_name;
  state.role = me.role;

  el('login-view').hidden = true;
  el('app-main').hidden = false;
  el('identity-bar').hidden = false;
  const identity = el('current-user-label');
  const identityName = document.createElement('span');
  identityName.className = 'user-name';
  identityName.textContent = me.display_name;
  const roleLabel = document.createElement('span');
  roleLabel.className = `role-pill role-${me.role}`;
  roleLabel.textContent = me.role === 'admin' ? 'Finance admin' : 'User';
  identity.replaceChildren(identityName, roleLabel);

  // Apply the authenticated role before any data request can fail. Otherwise the
  // default requester section remains visible while an admin session is bootstrapping.
  applyRoleView();
  try {
    state.options = await api('/api/options');
    await cacheLocalOptions(state.options);
  } catch (err) {
    state.options = await readCachedLocalOptions();
    if (!state.options) throw err;
    showToast('The database is temporarily unavailable. Cached form options are being used; changes will be queued or saved locally.', 'info');
  }

  syncRequesterTabVisibility();
  populateRequesterTypeSelect();
  onTypeChange();
  refreshAdminFilterOptions();

  wireEvents();
  applyRoleView();
  try {
    await loadRequests();
  } catch (err) {
    const unavailable = err && (err.status === 503 || err instanceof TypeError);
    if (!unavailable) throw err;
    state.requests = []; state.suppliers = []; state.people = []; state.users = [];
    renderAll();
    showToast('The database is temporarily unavailable. You can continue a local draft and retry shortly.', 'info');
  }
  await offerLocalDraftRestore();
  await openLinkedRequest();
}

// Notification emails link straight at a request (?request=FR-...). Consumed once and
// wiped from the address bar so a reload does not keep reopening the same panel.
async function openLinkedRequest() {
  const requested = new URLSearchParams(location.search).get('request');
  if (!requested) return;
  history.replaceState(null, '', location.pathname);
  if (state.requests.some((row) => row.request_id === requested)) await openDetail(requested);
  else showToast(`Request ${requested} is not available to you.`, 'error');
}

// Role decides the view: requesters get the portal, admins get the queue.
function applyRoleView() {
  const admin = state.role === 'admin';
  el('requester-view').hidden = admin;
  el('admin-view').hidden = !admin;
  if (admin) setAdminTab(state.adminTab);
}

let _authWired = false;
function wireAuth() {
  if (_authWired) return; _authWired = true;
  el('login-form').addEventListener('submit', onLogin);
  el('register-form').addEventListener('submit', onRegister);
  el('show-register').addEventListener('click', () => showAuthForm('register'));
  el('show-login').addEventListener('click', () => showAuthForm('login'));
  el('logout-btn').addEventListener('click', onLogout);
  el('password-btn').addEventListener('click', () => setPasswordPanelOpen(el('password-panel').hidden));
  el('password-cancel').addEventListener('click', () => setPasswordPanelOpen(false));
  el('password-form').addEventListener('submit', onChangePassword);
}

async function onLogin(e) {
  e.preventDefault();
  const f = e.target;
  const msg = el('login-msg'); msg.textContent = ''; msg.className = 'msg';
  try {
    const me = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: f.username.value, password: f.password.value }) });
    f.reset();
    const ready = await startAppSafely(me);
    if (!ready) return;
  } catch (err) { msg.textContent = err.message; msg.className = 'msg err'; }
}

async function onRegister(e) {
  e.preventDefault();
  const f = e.target;
  const msg = el('register-msg'); msg.textContent = ''; msg.className = 'msg';
  if (!f.checkValidity()) { f.reportValidity(); return; }
  if (f.password.value !== f.confirm_password.value) {
    msg.textContent = 'The two passwords do not match'; msg.className = 'msg err';
    return;
  }
  try {
    const me = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ display_name: f.display_name.value, email: f.email.value, password: f.password.value }),
    });
    f.reset();
    const ready = await startAppSafely(me);
    if (!ready) return;
    showToast(`Welcome, ${me.display_name}. Your account is ready.`);
  } catch (err) { msg.textContent = formatErr(err); msg.className = 'msg err'; }
}

function setPasswordPanelOpen(open) {
  const panel = el('password-panel');
  panel.hidden = !open;
  const form = el('password-form');
  if (!open) { form.reset(); el('password-msg').textContent = ''; return; }
  form.current_password.focus();
}

async function onChangePassword(e) {
  e.preventDefault();
  const f = e.target;
  const msg = el('password-msg'); msg.textContent = ''; msg.className = 'msg';
  if (!f.checkValidity()) { f.reportValidity(); return; }
  if (f.new_password.value !== f.confirm_password.value) {
    msg.textContent = 'The two passwords do not match'; msg.className = 'msg err';
    return;
  }
  try {
    await api('/api/password', {
      method: 'POST',
      body: JSON.stringify({ current_password: f.current_password.value, new_password: f.new_password.value }),
    });
    setPasswordPanelOpen(false);
    showToast('Password changed. Your other sessions have been signed out.');
  } catch (err) { msg.textContent = formatErr(err); msg.className = 'msg err'; }
}

async function onLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
  location.reload();
}

function fillFilterSelect(id, values, blank, labelFor = (value) => value) {
  const sel = el(id);
  sel.innerHTML = '';
  sel.appendChild(opt(blank, ''));
  for (const v of Array.from(new Set(values || []))) sel.appendChild(opt(labelFor(v), v));
}

function populateRequesterTypeSelect(selected = '', includeCurrent = false) {
  const select = el('create-form')?.request_type;
  if (!select) return;
  const current = selected || select.value || '';
  const values = requesterTypesForGroup(state.requestCreationGroup);
  select.innerHTML = '';
  select.appendChild(opt('— select —', ''));
  for (const type of values) select.appendChild(opt(type, type));
  if (includeCurrent && current && !values.includes(current)) select.appendChild(opt(current, current));
  if (current && [...select.options].some((option) => option.value === current)) select.value = current;
}

function adminQueueTypes() {
  if (state.adminTab === 'travel-requests') return [...TRAVEL_WORKSPACE_TYPES];
  return (state.options.request_types || [])
    .filter((type) => type !== 'Supplier Setup' && !TRAVEL_WORKSPACE_TYPES.has(type));
}

function adminQueueStatuses() {
  const byType = state.options.statuses_by_type || {};
  const visibleStatuses = (statuses) => [...new Set(statuses || [])].filter((status) => status !== 'Draft');
  // Each workspace can contain request types with a different lifecycle. Offer the
  // union of that workspace's statuses so Travel Allowance remains filterable in Finance.
  return visibleStatuses(adminQueueTypes().flatMap((type) => byType[type] || []));
}

function refreshAdminFilterOptions() {
  const type = el('f-type');
  const status = el('f-status');
  const currentType = type?.value || '';
  const typeOptions = adminQueueTypes();
  fillFilterSelect('f-type', typeOptions, 'All types');
  if (state.adminTab !== 'travel-requests') {
    const supplierOption = opt('New Supplier', NEW_SUPPLIER_FILTER);
    type.appendChild(supplierOption);
  }
  if (currentType === NEW_SUPPLIER_FILTER || typeOptions.includes(currentType)) type.value = currentType;
  const currentStatus = status?.value || '';
  fillFilterSelect('f-status', adminQueueStatuses(), 'All status', statusLabel);
  if (adminQueueStatuses().includes(currentStatus)) status.value = currentStatus;
}

let _eventsWired = false;
function wireEvents() {
  if (_eventsWired) return; _eventsWired = true;
  el('requester-tabs').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => onRequesterTabClick(b.dataset.tab)));
  el('admin-tabs').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => setAdminTab(b.dataset.adminTab)));

  const cf = el('create-form');
  cf.request_type.addEventListener('change', onTypeChange);
  cf.sub_type.addEventListener('change', () => {
    clearCreateFeedback();
    renderDynamicForm();
    updateRequestProgress();
  });
  cf.addEventListener('submit', onCreate);
  // Block implicit submission. "Submit request" is the form's only submit button, so
  // without this an Enter pressed anywhere in this long intake form sends the request
  // for real — or, mid-way through, produces a required-field list the requester never
  // asked for while they were reaching for Save draft. Textareas keep their newline.
  cf.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const target = e.target;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON') return;
    e.preventDefault();
  });
  // The stepper now reflects whether the form is actually submittable, so it has to
  // follow every edit rather than only the type/sub-type selects.
  cf.addEventListener('input', () => { clearCreateFeedback(); updateRequestProgress(); scheduleLocalDraftSave(); });
  cf.addEventListener('change', () => { clearCreateFeedback(); updateRequestProgress(); scheduleLocalDraftSave(); });
  el('save-draft-btn').addEventListener('click', () => persistRequest(false));
  // Stop at the cap here rather than letting the server refuse the whole save: the limit
  // comes from /api/options, so there is still only one place that decides it.
  el('add-line-btn').addEventListener('click', () => {
    const max = state.options.max_reimbursement_items || Infinity;
    if (lineRowsHost().rows.length >= max) {
      showToast(`A request can hold at most ${max} expense lines. Split the claim across several requests.`, 'error');
      return;
    }
    addLineRow();
    scheduleLocalDraftSave();
  });

  el('mine-refresh-btn').addEventListener('click', loadRequests);
  el('queue-refresh-btn').addEventListener('click', loadRequests);
  el('suppliers-refresh-btn').addEventListener('click', loadRequests);
  el('supplier-requests-refresh-btn').addEventListener('click', loadRequests);
  ['f-type', 'f-status', 'f-deleted', 'f-from', 'f-to'].forEach((id) => el(id).addEventListener('change', renderQueue));
  ['f-search', 'f-owner', 'f-from', 'f-to'].forEach((id) => el(id).addEventListener('input', renderQueue));
  el('clear-filters-btn').addEventListener('click', clearQueueFilters);
  el('supplier-form-toggle').addEventListener('click', () => setSupplierFormOpen(true));
  el('supplier-form-cancel').addEventListener('click', () => setSupplierFormOpen(false));
  el('supplier-show-deleted').addEventListener('change', renderSuppliers);
  el('supplier-requests-show-deleted').addEventListener('change', renderSupplierRequests);

  el('supplier-form').addEventListener('submit', onCreateSupplier);
  el('person-form').addEventListener('submit', onSavePerson);
  el('person-form-cancel').addEventListener('click', resetPersonForm);
  // The close control lives inside the modal overlay and is reused for both roles.
  // Stop the event at the control so closing a detail panel cannot reach an outer
  // handler or trigger a browser default action that resets the authenticated view.
  el('detail-close').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeDetail();
  });
  el('detail-overlay').addEventListener('click', (e) => { if (e.target === el('detail-overlay')) closeDetail(); });
  el('update-form').addEventListener('submit', onUpdate);
  el('internal-note-btn').addEventListener('click', addInternalNote);
  el('delete-btn').addEventListener('click', () => setDeleted(true));
  el('restore-btn').addEventListener('click', () => setDeleted(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('detail-overlay').hidden) closeDetail(); });
  document.addEventListener('keydown', trapDetailFocus);
}

function clearQueueFilters() {
  for (const id of ['f-search', 'f-type', 'f-status', 'f-owner', 'f-from', 'f-to']) {
    el(id).value = '';
  }
  el('f-deleted').checked = false;
  renderQueue();
}

function setAdminTab(tab) {
  // Supplier workflows remain in the data model for controlled/future use, but neither
  // supplier workspace is part of the current Finance navigation. A stale tab value must
  // not reveal either hidden page after a reload or a direct state change.
  state.adminTab = ['suppliers', 'supplier-requests'].includes(tab) ? 'requests' : (tab || 'requests');
  const supplierTab = el('admin-tabs').querySelector('[data-admin-tab="suppliers"]');
  if (supplierTab) supplierTab.hidden = true;
  const supplierRequestsTab = el('admin-tabs').querySelector('[data-admin-tab="supplier-requests"]');
  if (supplierRequestsTab) supplierRequestsTab.hidden = true;
  el('admin-tabs').querySelectorAll('button').forEach((button) => {
    const selected = button.dataset.adminTab === state.adminTab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  el('admin-tab-requests').hidden = !['requests', 'travel-requests'].includes(state.adminTab);
  el('admin-tab-supplier-requests').hidden = true;
  el('admin-tab-suppliers').hidden = true;
  el('admin-tab-people').hidden = state.adminTab !== 'people';
  const travel = state.adminTab === 'travel-requests';
  const eyebrow = el('admin-queue-eyebrow');
  const title = el('admin-queue-title');
  const intro = el('admin-queue-intro');
  const listTitle = el('admin-queue-list-title');
  if (eyebrow) eyebrow.textContent = travel ? 'Travel workspace' : 'Finance workspace';
  if (title) title.textContent = travel ? 'Travel request queue' : 'Finance request queue';
  if (intro) intro.textContent = travel
    ? 'Manage Travel requests separately from Finance requests.'
    : 'Manage Procurement, Travel Allowance and Reimbursement requests in one finance queue.';
  if (listTitle) listTitle.textContent = travel ? 'Travel requests' : 'Finance requests';
  if (state.options && Object.keys(state.options).length) refreshAdminFilterOptions();
  if (el('queue-table')) { renderQueue(); renderRequestSummary(); }
}

function setSupplierFormOpen(open) {
  const form = el('supplier-form');
  const fields = el('supplier-master-fields');
  if (open && fields && !fields.children.length) {
    if (state.options.supplier_master_profiles_persistent) {
      renderSupplierFormFields(fields, {});
      el('supplier-master-form-note').textContent = 'Use this only for exceptional legacy/import records. This form is aligned with the user Supplier Setup form.';
    } else {
      const specs = [
        ['legal_entity_name', 'Legal entity name', 'text', true],
        ['purchase_order_email', 'Purchase order email', 'email', true],
        ['abn', 'ABN', 'text', false],
      ];
      fields.className = 'span-2 dyn-grid';
      for (const [name, labelText, type, required] of specs) {
        const label = document.createElement('label');
        const text = document.createElement('span'); text.textContent = labelText + (required ? ' *' : '');
        const input = document.createElement('input'); input.name = name; input.type = type; input.required = required;
        label.append(text, input); fields.appendChild(label);
      }
      el('supplier-master-form-note').textContent = 'The database profile migration is pending. This record will be saved as a legacy/incomplete supplier; use Supplier Setup amendment to complete it.';
    }
  }
  form.hidden = !open;
  el('supplier-form-toggle').setAttribute('aria-expanded', String(open));
  if (!open) { form.reset(); if (fields) { fields.innerHTML = ''; fields.className = 'span-2'; } el('supplier-msg').textContent = ''; }
}

// ---------- tab ----------

// "New request" while a draft is loaded in the editor must start a blank request, not
// silently keep editing the draft (and not do nothing, which is what it used to do).
async function onRequesterTabClick(tab) {
  const isNewTab = ['new-finance', 'new-travel'].includes(tab);
  if (isNewTab && state.editingDraftId) {
    const left = await leaveDraftEditor();
    if (!left) return;
  }
  if (isNewTab) {
    const group = tab === 'new-travel' ? 'travel' : 'finance';
    const currentType = el('create-form').request_type.value;
    const targetTypes = requesterTypesForGroup(group);
    if (currentType && !targetTypes.includes(currentType)) {
      if (editorIsDirty()) {
        const choice = await askChoice({
          title: 'Switch request workspace?',
          message: 'The current request type belongs to the other workspace. Discard the unsaved form and switch?',
          choices: [
            { id: 'discard', label: 'Discard changes', className: 'btn-secondary' },
            { id: 'cancel', label: 'Keep editing', className: 'btn-secondary' },
          ],
        });
        if (choice !== 'discard') return;
      }
      resetRequestEditor();
    }
    state.requestCreationGroup = group;
  }
  setTab(tab);
}

function editorIsDirty() {
  if (collectAttachmentFiles().length) return true;
  return JSON.stringify(collectRequestBody()) !== state.editorBaseline;
}

// Returns true when the editor has been released and a blank new request can be started.
async function leaveDraftEditor() {
  const draftId = state.editingDraftId;
  if (!editorIsDirty()) {
    closeDetail();
    resetRequestEditor();
    renderDynamicForm();
    return true;
  }
  const choice = await askChoice({
    title: 'Start a new request?',
    message: `You have unsaved changes to draft ${draftId}. Save them before starting a new request, or discard them and keep the draft as it was last saved.`,
    choices: [
      { id: 'save', label: 'Save draft' },
      { id: 'discard', label: 'Discard changes', className: 'btn-secondary' },
      { id: 'cancel', label: 'Keep editing', className: 'btn-secondary' },
    ],
  });
  if (choice === 'cancel') return false;
  if (choice === 'save') {
    await persistRequest(false);
    // persistRequest clears the editor only when the save succeeded; if it is still
    // bound to the draft the save failed and its errors are on screen.
    if (state.editingDraftId) return false;
    closeDetail();
    renderDynamicForm();
    return true;
  }
  closeDetail();
  resetRequestEditor();
  renderDynamicForm();
  return true;
}

function setTab(tab) {
  state.activeTab = tab;
  const isNew = ['new-finance', 'new-travel'].includes(tab);
  if (isNew) state.requestCreationGroup = tab === 'new-travel' ? 'travel' : 'finance';
  el('requester-tabs').querySelectorAll('button').forEach((b) => {
    const selected = b.dataset.tab === tab;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-selected', String(selected));
  });
  el('tab-new').hidden = !isNew;
  el('tab-mine').hidden = tab !== 'mine';
  if (isNew) {
    const currentType = el('create-form').request_type.value;
    populateRequesterTypeSelect(currentType, !!state.editingDraftId);
    const title = el('new-request-title');
    const intro = el('new-request-intro');
    if (title) title.textContent = state.requestCreationGroup === 'travel' ? 'Create a travel request' : 'Create a finance request';
    if (intro) intro.textContent = state.requestCreationGroup === 'travel'
      ? 'Choose Travel and we will show you exactly what to provide.'
      : 'Choose the finance service you need and we will show you exactly what to provide.';
  }
}

// ---------- create form ----------

function onTypeChange() {
  const cf = el('create-form');
  clearCreateFeedback();
  const type = cf.request_type.value;
  const subs = (state.options.requester_subtypes || {})[type] || [];
  cf.sub_type.innerHTML = '';
  for (const s of subs) cf.sub_type.appendChild(opt(s, s));
  el('subtype-field').hidden = subs.length <= 1;
  renderDynamicForm();
  updateRequestProgress();
}

function renderDynamicForm(values = {}) {
  const cf = el('create-form');
  const type = cf.request_type.value;
  const sub = cf.sub_type.value;
  const box = el('dynamic-fields');
  box.innerHTML = '';
  el('reimbursement-section').hidden = true;
  el('attachments-section').hidden = true;
  el('intl-note').hidden = true;

  if (!type) {
    updateRequestProgress();
    return;
  }
  const key = `${type}||${sub}`;
  const supplierTypeValue = String(requestFieldValue(values, 'supplier_type') || '').trim();
  const requiredSet = requiredFieldNamesFor(type, sub, supplierTypeValue);

  if (type === 'Travel' && sub === 'International') {
    el('intl-note').hidden = false;
    el('intl-note').textContent = 'International travel is handled by Finance. Enter the traveller and attach the Travel request and Approval email before submitting.';
  }

  for (const name of (SUBTYPE_FIELDS[key] || [])) {
    const field = makeField(name, requiredSet, requestFieldValue(values, name), requestFieldValue(values, `${name}_other`));
    if (field) box.appendChild(field);
  }

  if (type === 'Supplier Setup') {
    const intro = document.createElement('div');
    intro.className = 'span-2 info-note supplier-form-intro';
    intro.textContent = 'Complete the Supplier/Payee details below. Finance will review the request and register the supplier in the University system. Only approved suppliers become available for Procurement requests.';
    box.appendChild(intro);
    renderSupplierFormFields(box, parseObj(values.supplier_form_data), {
      includeExistingSupplier: true, subType: sub, supplierId: values.supplier_id,
    });
  }

  wireActivityCodeRequirement(box, type, sub, supplierTypeValue);
  if (type === 'Procurement') wireGstAmountFields(box, '', values);

  // Reimbursement lines.
  if (type === 'Reimbursement') {
    el('reimbursement-section').hidden = false;
    el('reimbursement-table').querySelector('tbody').innerHTML = '';
    const items = parseArr(values.reimbursement_items);
    if (items.length) items.forEach((item) => addLineRow(item)); else addLineRow();
  }

  // Attachments. Intake collects the subtype's standard supporting-document slots up front;
  // documents that belong to a later step (PO, invoice) are added from the request detail
  // view when the workflow reaches them.
  const requiredAtt = requiredAttachmentPurposesFor(type, sub, supplierTypeValue);
  // Travel Allowance's TA Calculator is an optional supporting document. Keep its
  // upload slot visible, but do not include it in requiredAttachmentPurposesFor so
  // credit-card holders can submit without a TA form.
  const optionalIntakePurposes = type === 'Travel Allowance' ? ['ta_calculator'] : [];
  const fixedPurposes = type === 'Procurement'
    ? [...new Set([...requiredAtt, ...PROCUREMENT_INTAKE_DOCUMENTS, 'new_supplier_form'])]
    : [...new Set([...requiredAtt, ...optionalIntakePurposes])];
  const reqAtt = [...fixedPurposes, 'other_document'];
  const attBox = el('attachments-fields');
  attBox.innerHTML = '';
  attBox.classList.remove('document-upload-session');
  if (reqAtt.length) {
    el('attachments-section').hidden = false;
    const existing = parseArr(values.attachments);
    const storedByPurpose = new Map(existing.filter((a) => a && a.purpose).map((a) => [a.purpose, a]));
    const required = fixedPurposes.length ? buildRequiredDocumentSection() : null;
    if (required) attBox.appendChild(required.section);
    const documentFields = new Map();
    const otherDocumentList = buildOtherDocumentList({
      attachments: existing,
      purposeDatasetKey: 'purpose',
      allowStoredRemove: true,
      includeNewSupplierEvidence: type === 'Procurement',
      showNewSupplierEvidence: isNewSupplierType(supplierTypeValue),
    });
    for (const purpose of fixedPurposes) {
      const already = storedByPurpose.get(purpose);
      const field = fileField(attachmentLabel(purpose), {
        required: type !== 'Procurement' && requiredAtt.includes(purpose),
        stored: already,
      });
      const label = field.label;
      const input = field.input;
      input.dataset.purpose = purpose;
      label.dataset.documentPurpose = purpose;
      documentFields.set(purpose, field);
      (required ? required.fields : attBox).appendChild(label);
    }
    if (type === 'Procurement') {
      const supplierType = box.querySelector('[name=supplier_type]');
      const syncProcurementDocuments = () => {
        const selected = supplierType?.value || supplierTypeValue;
        const isNewSupplier = isNewSupplierType(selected);
        const requiredPurposes = requiredAttachmentPurposesFor(type, sub, selected);
        for (const purpose of PROCUREMENT_INTAKE_DOCUMENTS) {
          const field = documentFields.get(purpose);
          if (!field) continue;
          required?.fields.appendChild(field.label);
          setAttachmentRequired(field, requiredPurposes.includes(purpose));
        }
        const newSupplier = documentFields.get('new_supplier_form');
        if (newSupplier) {
          newSupplier.label.hidden = !isNewSupplier;
          required?.fields.appendChild(newSupplier.label);
          setAttachmentRequired(newSupplier, isNewSupplier);
          if (!isNewSupplier && !newSupplier.label.querySelector('.attachment-uploaded')) newSupplier.input.value = '';
        }
        otherDocumentList.setNewSupplierEvidence(isNewSupplier);
      };
      if (supplierType) supplierType.addEventListener('change', syncProcurementDocuments);
      syncProcurementDocuments();
    }
    attBox.appendChild(otherDocumentList.container);
    // Anything already uploaded that intake does not ask for (later-stage documents,
    // per-line receipts) still needs somewhere to appear.
    const leftovers = existing.filter((a) => a && !reqAtt.includes(a.purpose)
      && !new RegExp(`^other_document:${UUID_SOURCE}$`, 'i').test(a.purpose));
    const existingControls = renderExistingAttachmentControls(leftovers);
    if (existingControls) attBox.appendChild(existingControls);

    if (type === 'Supplier Setup') {
      const slot = box.querySelector('.supplier-evidence-upload-slot');
      const evidenceInput = attBox.querySelector('[data-purpose="supplier_evidence"]');
      const evidenceLabel = evidenceInput && evidenceInput.closest('label');
      if (slot && existingControls) slot.appendChild(existingControls);
      if (slot && evidenceLabel) {
        evidenceLabel.classList.add('supplier-evidence-file');
        const labelText = evidenceLabel.querySelector('span');
        const evidenceStored = !!evidenceLabel.querySelector('.attachment-uploaded');
        if (labelText) {
          labelText.textContent = evidenceStored
            ? 'Supporting document'
            : 'Upload selected supporting document';
          if (!evidenceStored) {
            const star = document.createElement('span'); star.className = 'req-star'; star.textContent = ' *';
            labelText.appendChild(star);
          }
        }
        slot.appendChild(evidenceLabel);
      }
      // Keep the general attachment area visible so Supplier Setup also has the
      // optional Other documents entry; the sensitive supplier evidence remains in its
      // dedicated form slot above.
      el('attachments-section').hidden = false;
    }
    if (required && !required.fields.children.length) required.section.remove();
  }
  syncSupplierEvidenceRequirement();
  updateRequestProgress();
}

function wireGstAmountFields(container, prefix = '', values = {}) {
  const names = prefix === 'invoice_'
    ? { ex: 'invoice_amount_ex_gst', total: 'invoice_amount' }
    : { ex: 'amount_ex_gst', total: 'amount_inc_gst' };
  const get = (name) => container.querySelector(`[name=${names[name]}]`);
  const ex = get('ex'); const total = get('total');
  if (!ex || !total) return;
  const exLabel = ex.closest('label');
  const totalLabel = total.closest('label');
  const helpHost = exLabel && totalLabel && exLabel.parentElement === totalLabel.parentElement
    ? exLabel.parentElement : container;
  if (exLabel && !helpHost.querySelector(':scope > .gst-amount-guidance')) {
    const help = document.createElement('p');
    help.className = 'gst-amount-guidance muted small span-2';
    help.textContent = 'Enter either Total Excl. GST or Total Incl. GST. At least one amount is required.';
    helpHost.insertBefore(help, exLabel);
  }
  setConditionalRequired(ex, false); setConditionalRequired(total, false);
  const sync = () => {
    const hasAmount = !!String(ex.value || '').trim() || !!String(total.value || '').trim();
    ex.setCustomValidity(hasAmount ? '' : 'Enter either Total Excl. GST or Total Incl. GST.');
    total.setCustomValidity('');
  };
  ex.addEventListener('input', sync); total.addEventListener('input', sync);
  sync();
}

function setConditionalRequired(control, required) {
  control.required = required;
  const title = control.closest('label')?.querySelector(':scope > span');
  if (!title) return;
  let star = title.querySelector('.conditional-req-star');
  const hasRequiredStar = !!title.querySelector('.req-star');
  if (required && !hasRequiredStar) {
    star = document.createElement('span'); star.className = 'req-star conditional-req-star'; star.textContent = ' *'; title.appendChild(star);
  } else if (!required && star) star.remove();
}

// opts.tbody / opts.total render the row into the returned-request editor instead of the
// new-request form; opts.allowRemove is false there, because a resubmit may correct a
// line but not change how many lines exist (receipts are linked by stable line ID).
function addLineRow(item, opts = {}) {
  const tbody = lineRowsHost(opts.tbody);
  const refreshTotal = () => updateLineTotal(opts.tbody, opts.total);
  const tr = document.createElement('tr');
  tr.dataset.itemId = stableClientId(item && item.item_id);
  tr.dataset.existingReceipt = item ? item.receipt || '' : '';

  const catSel = document.createElement('select');
  catSel.className = 'line-category'; catSel.required = true; catSel.setAttribute('aria-label', 'Expense category');
  catSel.appendChild(opt('— category —', ''));
  for (const c of state.options.reimbursement_categories || []) catSel.appendChild(opt(c, c));
  if (item) catSel.value = item.category || '';

  // A line records the two totals and nothing else: the GST entry mode and the separate
  // GST column were removed once both figures became mandatory, so there is nothing left
  // to derive.
  const moneyInput = (cls, value) => { const input = document.createElement('input'); input.type = 'number'; input.step = '0.01'; input.min = '0'; input.className = cls; input.value = value || ''; return input; };
  const ex = moneyInput('line-amount-ex-gst', item && item.amount_ex_gst);
  const total = moneyInput('line-amount', item && item.amount);
  ex.setAttribute('aria-label', 'Total excluding GST'); total.setAttribute('aria-label', 'Total including GST');
  const desc = document.createElement('textarea'); desc.rows = 1; desc.className = 'line-description'; desc.value = item ? item.description || '' : '';
  // Grow with the text. Dragging the corner handle inside a table cell behaves
  // inconsistently from row to row, so the row sizes itself instead of relying on it.
  const autoGrowDesc = () => {
    desc.style.height = 'auto';
    desc.style.height = `${Math.max(desc.scrollHeight, 38)}px`;
  };
  desc.addEventListener('input', autoGrowDesc);
  const rec = configureFileInput(document.createElement('input')); rec.type = 'file'; rec.className = 'line-receipt';
  rec.required = !tr.dataset.existingReceipt;
  if (tr.dataset.existingReceipt) rec.title = `Already uploaded: ${tr.dataset.existingReceipt}. Choose a file to replace it.`;

  const rmTd = document.createElement('td');
  if (opts.allowRemove !== false) {
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'btn-remove btn-remove-icon'; rm.textContent = '×';
    rm.title = 'Remove expense line'; rm.setAttribute('aria-label', 'Remove expense line');
    rm.addEventListener('click', () => { tr.remove(); refreshTotal(); scheduleLocalDraftSave(); });
    rmTd.appendChild(rm);
  }

  // Per-column classes rather than nth-child: the widths below are meaningful (an amount
  // box and a description box want very different room) and should not silently shift if
  // a column is ever inserted.
  // Paired with the control it describes rather than indexed alongside it: the label is
  // what the narrow layout prints above each field (td::before uses data-label), so a
  // list that drifts out of step with the controls silently retitles every box — the
  // the receipt picker calling itself "Description".
  // Headings match the <thead> in index.html.
  const columns = [
    [catSel, 'Category', 'cat'],
    [ex, 'Total Excl. GST ($)', 'money'],
    [total, 'Total Incl. GST ($)', 'money'],
    [desc, 'Description', 'desc'],
    [rec, 'Receipt', 'receipt'],
  ];
  for (const [control, label, cls] of columns) {
    const td = document.createElement('td');
    td.dataset.label = label;
    td.className = `line-cell line-cell-${cls}`;
    td.appendChild(control);
    if (control === rec) td.appendChild(makeFileClearControl(rec));
    tr.appendChild(td);
  }
  rmTd.className = 'line-cell line-cell-remove';
  tr.appendChild(rmTd);
  tbody.appendChild(tr);
  const syncGst = () => {
    const hasAmount = !!String(ex.value || '').trim() || !!String(total.value || '').trim();
    ex.required = false; total.required = false;
    ex.setCustomValidity(hasAmount ? '' : 'Enter either Total Excl. GST or Total Incl. GST.');
    total.setCustomValidity('');
    refreshTotal();
  };
  [ex, total].forEach((control) => control.addEventListener('input', syncGst));
  syncGst();
  refreshTotal();
  // Size a pre-filled description once it is in the document, where scrollHeight is real.
  autoGrowDesc();
  return tr;
}

// `scope` lets the returned-request editor in the detail dialog reuse these rows; it
// defaults to the new-request form's table.
function lineRowsHost(scope) {
  return scope || el('reimbursement-table').querySelector('tbody');
}

function collectLineItems(scope) {
  const rows = lineRowsHost(scope).querySelectorAll('tr');
  const items = [];
  rows.forEach((tr) => {
    items.push({
      item_id: tr.dataset.itemId,
      category: tr.querySelector('.line-category').value,
      amount_ex_gst: tr.querySelector('.line-amount-ex-gst').value,
      amount: tr.querySelector('.line-amount').value,
      description: tr.querySelector('.line-description').value,
      receipt: tr.querySelector('.line-receipt').files && tr.querySelector('.line-receipt').files[0]
        ? tr.querySelector('.line-receipt').files[0].name : (tr.dataset.existingReceipt || ''),
    });
  });
  return items;
}

function effectiveReimbursementLineAmount(item) {
  const inclusive = String(item && item.amount || '').trim();
  const exclusive = String(item && item.amount_ex_gst || '').trim();
  const raw = inclusive || exclusive;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function updateLineTotal(scope, output) {
  const total = collectLineItems(scope).reduce((s, it) => s + effectiveReimbursementLineAmount(it), 0);
  (output || el('reimbursement-total')).textContent = `Total: ${formatMoney(total)}`;
}

// Chosen files from the attachment file inputs.
function collectAttachmentFiles() {
  const out = [];
  el('create-form').querySelectorAll('input[type=file][data-purpose]').forEach((inp) => {
    if (inp.files && inp.files.length) out.push({ purpose: inp.dataset.purpose, file: inp.files[0] });
  });
  if (!el('reimbursement-section').hidden) {
    el('reimbursement-table').querySelectorAll('tbody tr').forEach((tr) => {
      const input = tr.querySelector('.line-receipt');
      if (input && input.files && input.files.length) out.push({ purpose: `receipt:${tr.dataset.itemId}`, file: input.files[0] });
    });
  }
  return out;
}

// Shown in place of an empty-looking file input when this document is already stored on
// the draft, so reopening a saved draft does not read as "the upload was lost".
function makeUploadedFileRow(purpose, attachment) {
  const row = document.createElement('span');
  row.className = 'attachment-uploaded';
  const tick = document.createElement('span');
  tick.className = 'attachment-uploaded-tick';
  tick.setAttribute('aria-hidden', 'true');
  tick.textContent = '✓';
  const name = document.createElement('span');
  name.className = 'attachment-uploaded-name';
  name.textContent = attachment.filename || 'Uploaded file';
  name.title = name.textContent;
  row.append(tick, name);
  if (state.editingDraftId) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-remove attachment-remove';
    remove.textContent = '× Remove';
    remove.addEventListener('click', () => removeAttachment(state.editingDraftId, purpose, true));
    row.appendChild(remove);
  }
  return row;
}

// A native file input cannot be emptied once a file is chosen, only overwritten. This
// gives the requester a way to undo a wrong selection before anything is uploaded.
function makeFileClearControl(input) {
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn-link file-clear';
  clear.textContent = 'Clear selected file';
  clear.hidden = true;
  const sync = () => { clear.hidden = !(input.files && input.files.length); };
  input.addEventListener('change', sync);
  clear.addEventListener('click', () => {
    input.value = '';
    input.classList.remove('field-error');
    input.removeAttribute('aria-invalid');
    sync();
    // The stepper tracks the new-request form only; this control is also used in the
    // detail dialog, where there is no progress to update.
    if (input.closest('#create-form')) updateRequestProgress();
    input.focus();
  });
  return clear;
}

function renderExistingAttachmentControls(attachments) {
  if (!attachments.length) return null;
  const box = document.createElement('div'); box.className = 'existing-attachments';
  const title = document.createElement('strong'); title.textContent = 'Already uploaded'; box.appendChild(title);
  for (const attachment of attachments) {
    const row = document.createElement('div'); row.className = 'existing-attachment-row';
    const name = document.createElement('span');
    name.textContent = `${attachmentLabel(attachment.purpose)}: ${attachment.filename}`;
    row.appendChild(name);
    if (state.editingDraftId) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn-remove attachment-remove'; remove.textContent = '× Remove';
      remove.addEventListener('click', () => removeAttachment(state.editingDraftId, attachment.purpose, true));
      row.appendChild(remove);
    }
    box.appendChild(row);
  }
  return box;
}

// Upload raw file bytes for a request, one purpose at a time. `version` is the row
// version the caller is working from: the server rejects the upload if the row has moved
// on, so a stale screen cannot launder its stale state into a fresh version stamp.
async function uploadOne(requestId, purpose, file, version) {
  const res = await fetch(
    `/api/requests/${encodeURIComponent(requestId)}/attachments?purpose=${encodeURIComponent(purpose)}`
      + `&filename=${encodeURIComponent(file.name)}&version=${encodeURIComponent(version || '')}`,
    { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }
  );
  if (!res.ok) {
    let msg = `Upload failed (${res.status})`;
    try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return res.json();
}

async function removeAttachment(requestId, purpose, fromEditor = false) {
  if (!(await askConfirm('Remove uploaded file?', 'Remove this document from the request?', 'Remove document'))) return;
  try {
    const version = fromEditor && state.editingDraftId === requestId
      ? state.editingDraftVersion : state.selectedVersion;
    const updated = await api(
      `/api/requests/${encodeURIComponent(requestId)}/attachments?purpose=${encodeURIComponent(purpose)}`
        + `&version=${encodeURIComponent(version || '')}`,
      { method: 'DELETE' },
    );
    if (!updated.pending_sync) await loadRequests();
    if (fromEditor && state.editingDraftId === requestId) {
      state.editingDraftVersion = updated.last_updated_at || '';
      // Keep whatever the requester has typed so far; only the attachment list changed.
      refreshEditorFromRow(updated);
    } else {
      if (!updated.pending_sync) await openDetail(requestId);
      else showToast('The document removal was saved temporarily and will synchronise when the database is available.', 'info');
    }
  } catch (err) {
    showToast(formatErr(err), 'error');
  }
}

async function uploadFiles(request, chosen) {
  let current = request;
  // Each upload bumps the row version, so the next one must present the version the
  // previous upload returned.
  for (const { purpose, file } of chosen) {
    current = await uploadOne(current.request_id, purpose, file, current.last_updated_at);
  }
  return current;
}

async function onCreate(e) {
  e.preventDefault();
  await persistRequest(true);
}

function collectRequestBody() {
  const cf = el('create-form');
  const body = { request_type: cf.request_type.value, sub_type: cf.sub_type.value, received_date: appLocalDate() };
  el('dynamic-fields').querySelectorAll('[name]').forEach((c) => { body[c.name] = c.value; });
  if (cf.request_type.value === 'Supplier Setup') body.supplier_form_data = collectSupplierFormData(el('dynamic-fields'));
  if (cf.request_type.value === 'Reimbursement') body.reimbursement_items = collectLineItems();
  return body;
}

// Small centred choice dialog. The detail overlay is styled as a full-height drawer, so
// it is the wrong shape for a short question. Resolves with the chosen action id, or
// 'cancel' on Escape / backdrop click.
function askChoice({ title, message, choices }) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const boxEl = document.createElement('div');
    boxEl.className = 'confirm-box';
    const h = document.createElement('h3'); h.textContent = title;
    h.id = `choice-title-${Math.random().toString(36).slice(2, 8)}`;
    overlay.setAttribute('aria-labelledby', h.id);
    const p = document.createElement('p'); p.textContent = message;
    const actions = document.createElement('div'); actions.className = 'confirm-actions';
    boxEl.append(h, p, actions);
    overlay.appendChild(boxEl);

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish('cancel'); }
      if (e.key === 'Tab') {
        const buttons = [...actions.querySelectorAll('button')];
        if (!buttons.length) return;
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };

    for (const choice of choices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      if (choice.className) btn.className = choice.className;
      btn.textContent = choice.label;
      btn.addEventListener('click', () => finish(choice.id));
      actions.appendChild(btn);
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish('cancel'); });
    // Captured so it runs before the detail overlay's own Escape handler.
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    const first = actions.querySelector('button');
    if (first) first.focus();
  });
}

async function askConfirm(title, message, confirmLabel) {
  return (await askChoice({
    title, message,
    choices: [
      { id: 'confirm', label: confirmLabel },
      { id: 'cancel', label: 'Cancel', className: 'btn-secondary' },
    ],
  })) === 'confirm';
}

function resetRequestEditor() {
  const cf = el('create-form');
  const oldKey = localDraftKey();
  state.editingDraftId = null; state.editingDraftVersion = '';
  state.editorBaseline = '';
  cf.reset(); cf.request_type.disabled = false; cf.sub_type.disabled = false;
  cf.sub_type.innerHTML = '';
  el('subtype-field').hidden = true;
  el('submit-request-btn').textContent = 'Submit request';
  el('dynamic-fields').innerHTML = '';
  el('reimbursement-section').hidden = true; el('attachments-section').hidden = true;
  clearCreateFeedback();
  localDraftDelete(oldKey).catch(() => {});
}

function setCreateBusy(busy, stage = '') {
  const save = el('save-draft-btn');
  const submit = el('submit-request-btn');
  save.disabled = busy; submit.disabled = busy;
  save.setAttribute('aria-busy', String(busy)); submit.setAttribute('aria-busy', String(busy));
  if (busy && stage) submit.textContent = stage;
  else submit.textContent = state.editingDraftId ? 'Submit draft' : 'Submit request';
}

async function persistRequest(shouldSubmit) {
  const cf = el('create-form');
  const msg = el('create-msg');
  const recovery = el('create-recovery');
  msg.textContent = ''; msg.className = 'msg';
  recovery.hidden = true; recovery.replaceChildren();
  clearFieldErrors(cf);
  if (!cf.request_type.value) {
    renderSubmissionErrors(msg, ['Request type — choose the type of Finance request you need.'], cf.request_type);
    return;
  }
  if (shouldSubmit) {
    const invalid = [...cf.querySelectorAll('input, select, textarea')]
      .filter((control) => !control.disabled && !control.closest('[hidden]') && !control.checkValidity());
    if (invalid.length) {
      const items = invalid.map((control) => `${controlLabel(control)} — ${controlValidationHelp(control)}`);
      renderSubmissionErrors(msg, items, invalid[0]);
      invalid.forEach((control) => { control.classList.add('field-error'); control.setAttribute('aria-invalid', 'true'); });
      return;
    }
    const missingDocuments = missingRequiredAttachments();
    if (missingDocuments.length) {
      const labels = missingDocuments.map((purpose) => (state.options.attachment_labels || {})[purpose] || purpose);
      renderSubmissionErrors(msg, labels.map((label) => `${label} — choose a file before submitting.`),
        cf.querySelector(`[data-purpose="${missingDocuments[0]}"]`));
      return;
    }
  }
  const body = collectRequestBody();
  const chosen = collectAttachmentFiles();
  let created = null;
  // Declared outside the try so the catch can recover the newest version stamp
  // (uploads bump it) when it adopts a draft that failed to submit.
  let row = null;
  setCreateBusy(true, shouldSubmit ? 'Preparing request…' : 'Saving draft…');
  try {
    if (state.editingDraftId) {
      body._version = state.editingDraftVersion;
      row = await api(`/api/requests/${encodeURIComponent(state.editingDraftId)}/save-draft`, { method: 'POST', body: JSON.stringify(body) });
    } else {
      created = await api('/api/requests', { method: 'POST', body: JSON.stringify(body) });
      row = created;
    }
    if (state.editingDraftId) {
      state.editingDraftVersion = row.last_updated_at || '';
      state.selectedVersion = row.last_updated_at || state.selectedVersion;
    }
    if (chosen.length) {
      msg.textContent = `Saving ${row.request_id} — uploading ${chosen.length} file(s)…`;
      setCreateBusy(true, `Uploading ${chosen.length} file${chosen.length === 1 ? '' : 's'}…`);
      row = await uploadFiles(row, chosen);
      if (state.editingDraftId) {
        state.editingDraftVersion = row.last_updated_at || state.editingDraftVersion;
        state.selectedVersion = row.last_updated_at || state.selectedVersion;
      }
    }
    if (shouldSubmit) {
      setCreateBusy(true, 'Submitting…');
      row = await api(`/api/requests/${encodeURIComponent(row.request_id)}/submit`, {
        method: 'POST', body: JSON.stringify({ _version: row.last_updated_at }),
      });
    }
    if (row && row.pending_sync) {
      msg.textContent = shouldSubmit
        ? 'Saved temporarily. The request will be submitted when the database is available.'
        : 'Draft saved temporarily. It will synchronise when the database is available.';
      msg.className = 'msg ok';
      if (!shouldSubmit) {
        adoptDraftInEditor(row.request_id, row.last_updated_at);
        await saveLocalDraftSnapshot();
        return;
      }
      resetRequestEditor();
      return;
    }
    msg.textContent = shouldSubmit ? `Submitted ${row.request_id}` : `Draft ${row.request_id} saved`;
    msg.className = 'msg ok';
    resetRequestEditor();
    try { await loadRequests(); }
    catch (err) {
      if (err.status === 503 || err instanceof TypeError) {
        showToast('The request was saved, but the list is temporarily unavailable. Refresh after the database recovers.', 'info');
        setTab('mine');
        return;
      }
      throw err;
    }
    // Land on the request that was just saved rather than a blank form, so the requester
    // can confirm the reference, the status and what actually got uploaded.
    setTab('mine');
    await openDetail(row.request_id);
  } catch (err) {
    saveLocalDraftSnapshot().catch(() => {});
    if (created) {
      // The draft row already exists server-side. Adopt it as the editing target so
      // retrying from this form updates that draft instead of creating a second one.
      adoptDraftInEditor(created.request_id, (row || created).last_updated_at);
    } else if (state.editingDraftId && row) {
      // The draft was saved (and possibly had files attached) before the submit failed;
      // keep the version stamp current or the next attempt is rejected as a conflict.
      state.editingDraftVersion = row.last_updated_at;
    }
    // Re-render before the error summary: whatever was uploaded is now stored on the
    // draft, and the requester needs to see it — and be able to remove it — rather than
    // face file inputs that look empty while files sit on the server. Errors are drawn
    // afterwards so their field markers land on the rebuilt controls.
    if (row) refreshEditorFromRow(row);
    renderSubmissionErrors(msg, friendlyErrorItems(err), firstControlForError(err));
    if (created) {
      const title = document.createElement('strong'); title.textContent = 'Your work has been saved';
      const note = document.createElement('span');
      note.textContent = `Draft ${created.request_id} is still open in this form. Correct the items above and submit again.`;
      recovery.append(title, note); recovery.hidden = false;
    }
  } finally {
    setCreateBusy(false);
  }
}

// Rebuild the dynamic fields from the saved row without losing what the requester typed:
// the live form values win, the row supplies what the form does not hold (attachments).
function refreshEditorFromRow(row) {
  renderDynamicForm({ ...row, ...collectRequestBody() });
}

// Switch the create form from "new request" mode to "editing this draft" mode without
// touching the values the requester already typed.
function adoptDraftInEditor(requestId, version) {
  state.editingDraftId = requestId;
  state.editingDraftVersion = version;
  // What is on screen is what was just saved, so leaving now is not an unsaved change.
  state.editorBaseline = JSON.stringify(collectRequestBody());
  const cf = el('create-form');
  cf.request_type.disabled = true;
  cf.sub_type.disabled = true;
  el('submit-request-btn').textContent = 'Submit draft';
}

function clearFieldErrors(form) {
  form.querySelectorAll('.field-error').forEach((control) => {
    control.classList.remove('field-error');
    control.removeAttribute('aria-invalid');
  });
}

function clearCreateFeedback() {
  const msg = el('create-msg');
  if (msg) {
    msg.replaceChildren();
    msg.className = 'msg';
    msg.removeAttribute('role');
    msg.removeAttribute('tabindex');
  }
  const recovery = el('create-recovery');
  if (recovery) {
    recovery.hidden = true;
    recovery.replaceChildren();
  }
  const form = el('create-form');
  if (form) clearFieldErrors(form);
}

function controlLabel(control) {
  const label = control.closest('label');
  const heading = label && label.querySelector(':scope > span');
  return String((heading && heading.textContent) || control.name || control.dataset.supplierField || 'Required information')
    .replace(/\s*\*\s*$/, '').trim();
}

function controlValidationHelp(control) {
  if (control.validity.valueMissing) {
    return control.type === 'checkbox' ? 'tick this confirmation before submitting.' : 'complete this field.';
  }
  if (control.validity.typeMismatch) return 'enter a valid value in the requested format.';
  if (control.validity.rangeUnderflow || control.validity.rangeOverflow) return 'enter a value within the allowed range.';
  return 'check this value and correct it.';
}

// Every "you cannot submit this yet" message in the app goes through here, so an
// incomplete new request, an incomplete resubmission and an incomplete invoice handover
// all look and read the same way.
function renderSubmissionErrors(host, items, focusTarget, titleText) {
  host.className = 'msg err form-error-summary';
  host.setAttribute('role', 'alert');
  host.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = titleText || 'We could not submit this request';
  const intro = document.createElement('p'); intro.textContent = 'Please fix the following items and try again:';
  const list = document.createElement('ul');
  for (const item of [...new Set(items.filter(Boolean))]) {
    const li = document.createElement('li'); li.textContent = item; list.appendChild(li);
  }
  host.append(title, intro, list);
  const keepSummaryVisible = !!host.closest('#requester-actions');
  if (focusTarget) {
    focusTarget.classList.add('field-error');
    focusTarget.setAttribute('aria-invalid', 'true');
  }
  if (keepSummaryVisible) {
    host.tabIndex = -1;
    host.focus({ preventScroll: true });
    host.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (focusTarget) {
    focusTarget.focus({ preventScroll: true });
    focusTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    host.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function friendlyErrorItems(err) {
  if (!err.fields) return [err.message || 'Something went wrong. Please try again.'];
  const form = el('create-form');
  return Object.entries(err.fields).map(([field, detail]) => {
    if (field === 'attachments') {
      if (form.request_type.value === 'Supplier Setup') {
        return 'Supporting document — choose one of the four accepted document types and upload the matching file.';
      }
      return `Attachments — ${String(detail).replace(/_/g, ' ')}.`;
    }
    if (field === 'supplier_form_data') {
      const text = String(detail).replace(/_/g, ' ');
      if (/terms.*accepted/i.test(text)) return 'Purchase order terms — tick the acceptance confirmation.';
      if (/declaration.*confirmed/i.test(text)) return 'Authorisation declaration — tick the confirmation.';
      const match = text.match(/^(.+?) is required$/i);
      return match ? `${match[1]} — complete this field.` : `Supplier / Payee details — ${text}.`;
    }
    if (field === 'reimbursement_items') return `Expense lines — ${detail}.`;
    return `${fieldLabel(field)} — ${String(detail).replace(/_/g, ' ')}.`;
  });
}

function firstControlForError(err) {
  const form = el('create-form');
  const invalid = [...form.querySelectorAll('input, select, textarea')]
    .find((control) => !control.disabled && !control.closest('[hidden]') && !control.checkValidity());
  if (invalid) return invalid;
  const fields = Object.keys(err.fields || {});
  if (fields.includes('attachments')) return form.querySelector('[data-purpose]');
  if (fields.includes('supplier_form_data')) return form.querySelector('[data-supplier-field]');
  for (const field of fields) {
    const control = form.querySelector(`[name="${field}"]`);
    if (control) return control;
  }
  return null;
}

function formatErr(err) {
  if (err.fields) {
    return err.message + ': ' + Object.entries(err.fields).map(([k, v]) => `${fieldLabel(k)} ${v}`).join('; ');
  }
  return err.message;
}

// ---------- suppliers (admin) ----------

async function onCreateSupplier(e) {
  e.preventDefault();
  const f = e.target;
  const msg = el('supplier-msg');
  msg.textContent = ''; msg.className = 'msg';
  const invalid = [...f.querySelectorAll('input, select')].find((input) => !input.checkValidity());
  if (invalid) { invalid.reportValidity(); return; }
  const profilePersistent = !!state.options.supplier_master_profiles_persistent;
  const profile = profilePersistent ? collectSupplierFormData(el('supplier-master-fields')) : null;
  const body = profilePersistent ? {
    legal_entity_name: profile.legal_entity_name, abn: profile.abn,
    purchase_order_email: profile.purchase_order_email, supplier_form_data: profile,
  } : {};
  f.querySelectorAll('[name]').forEach((c) => { body[c.name] = c.value; });
  try {
    const row = await api('/api/suppliers', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = `Added ${row.supplier_id} — approve it to make it selectable`;
    msg.className = 'msg ok';
    f.reset();
    await loadRequests();
    setSupplierFormOpen(false);
  } catch (err) {
    msg.textContent = formatErr(err);
    msg.className = 'msg err';
  }
}

// ---------- data + rendering ----------

async function loadRequests() {
  const [reqs, sups, people, users, opt] = await Promise.all([
    api('/api/requests'), state.role === 'admin' ? api('/api/suppliers') : Promise.resolve([]),
    state.role === 'admin' ? api('/api/people') : Promise.resolve([]),
    state.role === 'admin' ? api('/api/users') : Promise.resolve([]), api('/api/options'),
  ]);
  state.requests = reqs;
  state.suppliers = sups;
  state.people = people;
  state.users = users;
  state.options.suppliers = opt.suppliers; // approved suppliers for the dropdown
  renderAll();
}

// Approve / reject / delete / restore a supplier.
async function supplierAction(id, action, patch) {
  try {
    if (action === 'patch') await api('/api/suppliers/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) });
    else await api('/api/suppliers/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
    await loadRequests();
  } catch (e) { showToast(formatErr(e), 'error'); }
}

function renderAll() {
  renderMine();
  renderQueue();
  renderSupplierRequests();
  renderSuppliers();
  renderPeople();
  renderRequestSummary();
  const cf = el('create-form');
  if (cf.request_type.value) {
    const sup = el('dynamic-fields').querySelector('[name=supplier_id]');
    if (sup) fillSupplierSelect(sup, sup.value);
  }
}

// One form serves both jobs, so it has to say which one it is doing. Without this the
// button reads "Save person" whether you are creating someone or overwriting an existing
// record — the two most different outcomes this panel has.
function setPersonFormMode(person) {
  const editing = !!person;
  const mode = el('person-form-mode');
  mode.textContent = editing ? `Editing ${person.display_name} (${person.person_id})` : 'Adding a new person';
  mode.classList.toggle('is-editing', editing);
  el('person-submit-btn').textContent = editing ? 'Save changes' : 'Add person';
  el('person-form-cancel').textContent = editing ? 'Cancel edit' : 'Clear';
  el('people-table').querySelectorAll('tr.person-row-editing').forEach((tr) => tr.classList.remove('person-row-editing'));
  if (editing) {
    const row = el('people-table').querySelector(`tr[data-person-id="${person.person_id}"]`);
    if (row) row.classList.add('person-row-editing');
  }
}

function resetPersonForm() {
  const form = el('person-form'); form.reset(); form.person_id.value = '';
  form.active.checked = true; form.can_request.checked = true; form.can_travel.checked = true;
  el('person-msg').textContent = '';
  setPersonFormMode(null);
}

function editPerson(person) {
  const form = el('person-form');
  for (const field of ['person_id', 'display_name', 'email']) form.elements[field].value = person[field] || '';
  for (const field of ['active', 'can_request', 'can_travel', 'can_approve', 'can_process']) form.elements[field].checked = person[field] === 'Yes';
  setPersonFormMode(person);
  form.display_name.focus();
}

async function onSavePerson(event) {
  event.preventDefault();
  const form = event.currentTarget; const msg = el('person-msg');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const body = { display_name: form.display_name.value.trim(), email: form.email.value.trim() };
  for (const field of ['active', 'can_request', 'can_travel', 'can_approve', 'can_process']) body[field] = form.elements[field].checked ? 'Yes' : 'No';
  try {
    const id = form.person_id.value;
    await api(id ? `/api/people/${encodeURIComponent(id)}` : '/api/people', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    const name = body.display_name;
    resetPersonForm(); await loadRequests();
    showToast(id ? `Saved changes to ${name}.` : `Added ${name} to the directory.`);
  } catch (error) { msg.textContent = formatErr(error); msg.className = 'msg err'; }
}

// Whether someone can sign in, and as what, is shown on the row of the person it belongs
// to. Accounts have no screen of their own precisely so that the Active switch here and
// the ability to sign in can never disagree.
function accountCell(person) {
  const td = document.createElement('td');
  const account = state.users.find((user) => user.person_id === person.person_id);
  if (!account) { td.textContent = '—'; return td; }
  const name = document.createElement('div'); name.className = 'account-username'; name.textContent = account.username;
  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'btn-link'; reset.textContent = 'Reset password';
  reset.addEventListener('click', () => resetAccountPassword(account));
  td.append(name, reset);
  return td;
}

function roleCell(person) {
  const td = document.createElement('td');
  const account = state.users.find((user) => user.person_id === person.person_id);
  if (!account) { td.textContent = '—'; return td; }
  const select = document.createElement('select');
  select.setAttribute('aria-label', `Role for ${account.username}`);
  for (const role of ['requester', 'admin']) select.appendChild(opt(role === 'admin' ? 'Finance admin' : 'User', role));
  select.value = account.role;
  select.addEventListener('change', async () => {
    try {
      await api(`/api/users/${encodeURIComponent(account.username)}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) });
      showToast(`${account.username} is now ${select.value === 'admin' ? 'a Finance admin' : 'a user'}.`);
      await loadRequests();
    } catch (error) {
      select.value = account.role;
      showToast(formatErr(error), 'error');
    }
  });
  td.appendChild(select);
  return td;
}

// The generated password exists only in this response. Shown in a prompt-style toast that
// the administrator reads out; there is no second chance to see it and no copy of it
// anywhere else, which is the point.
async function resetAccountPassword(account) {
  if (!window.confirm(`Reset the password for ${account.username}? Their current password stops working immediately.`)) return;
  try {
    const result = await api(`/api/users/${encodeURIComponent(account.username)}/reset-password`, { method: 'POST' });
    window.alert(`Temporary password for ${account.username}:\n\n${result.temporary_password}\n\nGive it to them directly — it is not shown again and is not stored anywhere. Ask them to change it after signing in.`);
  } catch (error) { showToast(formatErr(error), 'error'); }
}

function renderPeople() {
  const table = el('people-table'); if (!table) return;
  const tbody = table.querySelector('tbody'); tbody.innerHTML = '';
  el('people-empty').hidden = state.people.length > 0;
  const yesNo = (value) => value === 'Yes' ? 'Yes' : '—';
  const editingId = el('person-form').person_id.value;
  for (const person of state.people) {
    const tr = document.createElement('tr');
    tr.dataset.personId = person.person_id;
    // Keep the "you are editing this one" marker across a refresh, or the form would still
    // say "Editing X" with nothing on the table pointing at X.
    if (editingId && editingId === person.person_id) tr.classList.add('person-row-editing');
    for (const value of [person.person_id, person.display_name, person.email || '—', person.active === 'Yes' ? 'Active' : 'Inactive',
      yesNo(person.can_request), yesNo(person.can_travel), yesNo(person.can_approve), yesNo(person.can_process)]) tr.appendChild(cell(value));
    tr.appendChild(accountCell(person));
    tr.appendChild(roleCell(person));
    const action = document.createElement('td'); const edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'btn-link'; edit.textContent = 'Edit'; edit.addEventListener('click', () => editPerson(person));
    action.appendChild(edit); tr.appendChild(action); tbody.appendChild(tr);
  }
}

// The summary tiles sit directly above the queue, so they must count exactly the rows the
// queue can show. They previously counted retired "New Supplier" records the queue filters
// out, which is why the Active tile read higher than the number of visible rows.
const QUEUE_EXCLUDED_TYPES = ['New Supplier', 'Supplier Setup'];
const TERMINAL_REQUEST_STATUSES = [PROCUREMENT_COMPLETE_STATUS, 'Completed', 'Cancelled', 'Rejected', 'Approved'];

function queuePopulation() {
  return state.requests.filter((request) => {
    if (QUEUE_EXCLUDED_TYPES.includes(request.request_type)) return false;
    if (state.adminTab === 'travel-requests') return TRAVEL_WORKSPACE_TYPES.has(request.request_type);
    return !TRAVEL_WORKSPACE_TYPES.has(request.request_type);
  });
}

function renderRequestSummary() {
  const reportable = queuePopulation();
  const active = reportable.filter((request) => !isDeleted(request)
    && !TERMINAL_REQUEST_STATUSES.includes(request.current_status));
  const completed = reportable.filter((request) => !isDeleted(request)
    && request.current_status === PROCUREMENT_COMPLETE_STATUS);
  const needsInfo = active.filter((request) => request.current_status === PROCUREMENT_RETURN_TO_REQUESTOR_STATUS
    || request.current_status === 'Returned for Info'
    || request.waiting_on === 'User'
    || request.waiting_on === 'Requester');
  const withFinance = active.filter((request) => request.waiting_on === 'Finance');

  const values = {
    'summary-active': active.length,
    'summary-returned': needsInfo.length,
    'summary-finance': withFinance.length,
    'summary-completed': completed.length,
  };
  for (const [id, value] of Object.entries(values)) {
    const node = el(id);
    if (node) node.textContent = String(value);
  }
}

// Required documents that neither hold a newly chosen file nor already sit on the draft.
function missingRequiredAttachments() {
  const cf = el('create-form');
  const reqAtt = requiredAttachmentPurposesFor(
    cf.request_type.value,
    cf.sub_type.value,
    cf.querySelector('[name=supplier_type]')?.value,
  );
  return reqAtt.filter((purpose) => {
    const input = cf.querySelector(`input[type=file][data-purpose="${purpose}"]`);
    if (!input || input.closest('[hidden]')) return true;
    if (input.files && input.files.length) return false;
    const label = input.closest('label');
    return !(label && label.querySelector('.attachment-uploaded'));
  });
}

function requestFormReady() {
  const cf = el('create-form');
  if (!cf.request_type.value) return false;
  const invalid = [...cf.querySelectorAll('input, select, textarea')]
    .some((control) => !control.disabled && !control.closest('[hidden]') && !control.checkValidity());
  return !invalid && missingRequiredAttachments().length === 0;
}

function updateRequestProgress() {
  const form = el('create-form');
  const steps = document.querySelectorAll('.form-progress li');
  if (!form || !steps.length) return;
  // Documents are collected in the same form as the details, so there is no separate
  // document step: step 2 covers both and step 3 lights up once the form is submittable.
  const current = form.request_type.value ? (requestFormReady() ? 2 : 1) : 0;
  steps.forEach((step, index) => {
    step.classList.toggle('active', index === current);
    step.classList.toggle('complete', index < current);
  });
}

// A few status names describe Finance's side of the workflow and read wrongly to the
// person who did the work: "Invoice Received" is what Finance sees, but the requester
// just sent it. Presentation only — the stored status is untouched, so the CSS class and
// every workflow rule still key off the real value.
const REQUESTER_STATUS_LABELS = {};

function statusLabel(status) {
  const value = status == null ? '' : String(status);
  return titleCaseStatus(userFacingLabel(REQUESTER_STATUS_LABELS[value] || value));
}

function statusBadge(r) {
  const span = document.createElement('span');
  if (isDeleted(r)) { span.className = 'badge status-Deleted'; span.textContent = 'Deleted'; return span; }
  span.className = 'badge status-' + String(r.current_status).replace(/[^a-zA-Z]+/g, '-');
  span.textContent = statusLabel(r.current_status);
  return span;
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text == null ? '' : text;
  if (className) td.className = className;
  return td;
}
function cellNode(node, className) {
  const td = document.createElement('td');
  td.appendChild(node);
  if (className) td.className = className;
  return td;
}

function renderMine() {
  // The API already scopes requester results to the authenticated owner.
  const mine = state.requests.filter((r) => r.request_type !== 'New Supplier' && !isDeleted(r));
  const tbody = el('mine-table').querySelector('tbody');
  tbody.innerHTML = '';
  el('mine-empty').hidden = mine.length > 0;
  for (const r of mine) {
    const tr = document.createElement('tr');
    tr.append(cell(r.request_id), cell(r.request_type, 'wrap-cell'), cell(r.sub_type, 'wrap-cell'),
      cellNode(statusBadge(r), 'wrap-cell'),
      cell(waitingLabel(r.waiting_on)), cell(displayAmount(r)),
      // created_at is the exact submission moment from the log; received_date is the
      // plain date and is all older rows have.
      cell(r.created_at ? fmtTime(r.created_at) : r.received_date),
      cell(fmtTime(r.last_updated_at)));
    makeRowInteractive(tr, () => openDetail(r.request_id));
    tbody.appendChild(tr);
  }
}

function renderQueue() {
  const showDel = el('f-deleted').checked;
  const f = {
    search: el('f-search').value.trim().toLowerCase(),
    type: el('f-type').value, status: el('f-status').value,
    owner: el('f-owner').value.trim().toLowerCase(),
    from: el('f-from').value, to: el('f-to').value,
  };
  const rows = queuePopulation().filter((r) => {
    if (!showDel && isDeleted(r)) return false;
    if (f.type === NEW_SUPPLIER_FILTER && !(r.request_type === 'Procurement' && r.supplier_type === 'New Supplier')) return false;
    if (f.type && f.type !== NEW_SUPPLIER_FILTER && r.request_type !== f.type) return false;
    if (f.status && r.current_status !== f.status) return false;
    if (f.owner && !String(r.processed_by).toLowerCase().includes(f.owner)) return false;
    if (f.from && r.received_date < f.from) return false;
    if (f.to && r.received_date > f.to) return false;
    if (f.search) {
      const searchable = [r.request_id, r.request_type, r.sub_type, r.requester_name,
        r.beneficiary_name, r.supplier_name, r.destination, r.po_number, r.invoice_number,
        r.current_status].join(' ').toLowerCase();
      if (!searchable.includes(f.search)) return false;
    }
    return true;
  });
  const tbody = el('queue-table').querySelector('tbody');
  tbody.innerHTML = '';
  el('queue-empty').hidden = rows.length > 0;
  el('queue-count').textContent = `${rows.length} ${rows.length === 1 ? 'request' : 'requests'}`;
  renderFilterChips(f, showDel);
  for (const r of rows) {
    const tr = document.createElement('tr');
    const missing = incompleteOf(r);
    const info = document.createElement('span');
    if (missing.length) { info.className = 'attention-badge'; info.textContent = `Missing ${missing.length}`; info.title = 'Missing: ' + missing.join(', '); }
    tr.append(
      cell(r.request_id), requestKindCell(r), cell(r.requester_name || r.beneficiary_name),
      cell(r.supplier_name || r.destination, 'wrap-cell'),
      cell(displayAmount(r)), cellNode(statusBadge(r), 'wrap-cell'), cell(waitingLabel(r.waiting_on)),
      cell(fmtTime(r.last_updated_at)), cellNode(info));
    makeRowInteractive(tr, () => openDetail(r.request_id));
    tbody.appendChild(tr);
  }
}

function renderSupplierRequests() {
  const showDeleted = el('supplier-requests-show-deleted').checked;
  const rows = state.requests.filter((request) => request.request_type === 'Supplier Setup'
    && (showDeleted || !isDeleted(request)));
  const tbody = el('supplier-requests-table').querySelector('tbody'); tbody.innerHTML = '';
  el('supplier-requests-count').textContent = `${rows.length} ${rows.length === 1 ? 'request' : 'requests'}`;
  el('supplier-requests-empty').hidden = rows.length > 0;
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.append(cell(row.request_id), cell(row.sub_type), cell(row.supplier_name, 'wrap-cell'),
      cell(row.requester_name), cellNode(statusBadge(row), 'wrap-cell'),
      cell(waitingLabel(row.waiting_on)), cell(fmtTime(row.last_updated_at)));
    makeRowInteractive(tr, () => openDetail(row.request_id)); tbody.appendChild(tr);
  }
}

function requestKindCell(row) {
  const td = document.createElement('td');
  // Type and sub-type are the widest free text in the queue; letting them wrap is what
  // keeps the table inside the page instead of behind a horizontal scrollbar.
  td.className = 'wrap-cell';
  const type = document.createElement('strong'); type.textContent = row.request_type || '';
  const sub = document.createElement('span'); sub.className = 'cell-subtitle'; sub.textContent = row.sub_type || '';
  td.append(type, sub); return td;
}

function renderFilterChips(filters, showDeleted) {
  const box = el('active-filter-chips');
  box.innerHTML = '';
  const values = [
    ['Search', filters.search], ['Type', filters.type === NEW_SUPPLIER_FILTER ? 'New Supplier' : filters.type],
    ['Status', statusLabel(filters.status)], ['Processed by', filters.owner],
    ['From', filters.from], ['To', filters.to],
  ];
  for (const [label, value] of values) {
    if (!value) continue;
    const chip = document.createElement('span'); chip.className = 'filter-chip'; chip.textContent = `${label}: ${value}`;
    box.appendChild(chip);
  }
  if (showDeleted) { const chip = document.createElement('span'); chip.className = 'filter-chip'; chip.textContent = 'Including deleted'; box.appendChild(chip); }
  el('clear-filters-btn').hidden = box.childElementCount === 0;
}

function makeRowInteractive(row, activate) {
  row.tabIndex = 0;
  row.setAttribute('aria-label', `${row.cells[0]?.textContent || 'Request'} — open details`);
  row.addEventListener('click', activate);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
}

function renderSuppliers() {
  const showDel = el('supplier-show-deleted').checked;
  const sup = (state.suppliers || []).filter((s) => showDel || String(s.deleted || '') !== 'Yes');
  const tbody = el('suppliers-table').querySelector('tbody');
  tbody.innerHTML = '';
  el('suppliers-empty').hidden = sup.length > 0;
  const mk = (label, cls, fn) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    if (cls) b.className = cls; b.addEventListener('click', fn); return b;
  };
  const profileState = (supplier) => {
    const data = parseObj(supplier.supplier_form_data);
    const required = ['legal_entity_name', 'street_address', 'suburb', 'country', 'postcode', 'contact_name',
      'contact_phone', 'contact_email', 'purchase_order_email', 'nt_enterprise', 'bank_type', 'bank_name',
      'bank_branch_address', 'bank_account_name', 'account_number'];
    if (String(data.country || '').trim().toLowerCase() === 'australia') required.push('state_region');
    if (data.has_abn === 'Yes') required.push('abn'); else required.push('no_abn_reason');
    if (data.bank_type === 'Australian EFT') required.push('bsb');
    if (data.bank_type === 'International TT') required.push('bank_account_currency', 'payment_currency', 'swift_sort_bank_code');
    const complete = required.filter((field) => String(data[field] || '').trim()).length;
    return complete === required.length ? { text: 'Complete', cls: 'ok' } : { text: `${complete}/${required.length}`, cls: 'partial' };
  };
  for (const s of sup) {
    const tr = document.createElement('tr');
    const del = String(s.deleted || '') === 'Yes';
    const badge = document.createElement('span');
    badge.className = 'badge status-' + String(del ? 'Deleted' : s.status).replace(/[^a-zA-Z]+/g, '-');
    badge.textContent = del ? 'Deleted' : s.status;
    const actions = document.createElement('td');
    const profile = profileState(s);
    const profileBadge = document.createElement('span');
    profileBadge.className = `badge profile-${profile.cls}`;
    profileBadge.textContent = profile.text;
    profileBadge.title = profile.cls === 'ok' ? 'Aligned with the current Supplier/Payee form' : 'Legacy supplier profile is incomplete; submit an amendment to complete it';
    if (del) {
      actions.appendChild(mk('Restore', 'btn-secondary', () => supplierAction(s.supplier_id, 'restore')));
    } else {
      if (s.status === 'Submitted for approval') {
        actions.appendChild(mk('Approve', null, () => supplierAction(s.supplier_id, 'patch', { status: 'Approved' })));
        actions.appendChild(mk('Reject', 'btn-secondary', () => supplierAction(s.supplier_id, 'patch', { status: 'Rejected' })));
      }
      actions.appendChild(mk('Delete', 'btn-danger', () => supplierAction(s.supplier_id, 'delete')));
    }
    tr.append(cell(s.supplier_id), cell(s.legal_entity_name, 'wrap-cell'), cell(s.abn), cell(s.purchase_order_email),
      cell(s.vendor_id), cellNode(profileBadge), cellNode(badge, 'wrap-cell'), actions);
    tbody.appendChild(tr);
  }
}

// ---------- detail / update ----------

const META_FIELDS = [
  ['current_status', 'Status'], ['beneficiary_name', 'Traveller'],
  ['supplier_name', 'Supplier'], ['supplier_quote_number', 'Quote #'],
  ['legal_entity_name', 'Legal entity'], ['abn', 'ABN'], ['purchase_order_email', 'PO email'], ['vendor_id', 'Vendor ID'],
  ['short_description', 'Description'], ['gst_entry_method', 'GST entry method'],
  ['amount_ex_gst', 'Total Excl. GST ($)'], ['amount_inc_gst', 'Total Incl. GST ($)'],
  ['activity_code', 'Activity code'], ['spending_approver', 'Approver'],
  ['destination', 'Destination'], ['travel_start_date', 'Departure'], ['travel_end_date', 'Return'],
  ['po_number', 'PO number'], ['invoice_number', 'Invoice #'], ['invoice_items', 'Invoice details'], ['close_reason', 'Reason to Close'],
  ['invoice_amount_ex_gst', 'Total Excl. GST ($)'], ['invoice_amount', 'Total Incl. GST ($)'],
  ['processed_by', 'Processed by'], ['notes', 'Notes'],
];

function appendMetaValue(host, label, value, options = {}) {
  const wrap = document.createElement('div');
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = options.waiting ? waitingLabel(value)
    : options.amount ? formatMoney(value) : String(value == null ? '' : value);
  wrap.append(dt, dd); host.appendChild(wrap);
}

// `omit` carries the fields the admin editor renders as inputs further down. Repeating
// them read-only would say the same thing twice, but the rest of META_FIELDS — PO and
// invoice values, notes, fields belonging to an earlier workflow stage — has nowhere
// else to appear, so it is kept rather than dropped with them.
function renderRequestDetails(row, omit = new Set()) {
  const host = el('request-form-details'); host.innerHTML = '';
  if (row.request_type === 'Supplier Setup') { host.hidden = true; return; }
  const details = document.createElement('details'); details.className = 'supplier-details request-details'; details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = omit.size ? 'Other recorded fields' : 'Request details';
  const grid = document.createElement('dl'); grid.className = 'supplier-summary-grid request-details-grid';
  for (const [key, label] of META_FIELDS) {
    if (omit.has(key)) continue;
    const value = key === 'current_status' ? statusLabel(row[key])
      : key === 'activity_code' ? displayCodeValue(row, key) : row[key];
    if (value == null || String(value).trim() === '') continue;
    const rendered = key === 'invoice_items' ? parseArr(value).map((item, index) => `Invoice ${index + 1}: ${item.invoice_number || '—'} · Excl. ${formatMoney(item.amount_ex_gst)} · Incl. ${formatMoney(item.amount_inc_gst)}`).join(' | ') : value;
    const displayLabel = key === 'processed_by'
      && row.request_type === 'Procurement' && row.current_status === PROCUREMENT_COMPLETE_STATUS
      ? 'Closed by' : label;
    appendMetaValue(grid, displayLabel, rendered, { amount: ['amount', 'amount_ex_gst', 'amount_inc_gst', 'invoice_amount_ex_gst', 'invoice_amount'].includes(key) });
  }
  host.hidden = !grid.children.length;
  if (host.hidden) return;
  details.append(summary, grid); host.appendChild(details);
}

function renderSupplierFormSummary(row) {
  const host = el('supplier-form-details');
  host.innerHTML = '';
  host.hidden = row.request_type !== 'Supplier Setup';
  if (host.hidden) return;
  const data = parseObj(row.supplier_form_data);
  const details = document.createElement('details');
  details.className = 'supplier-details';
  details.open = true;
  const summary = document.createElement('summary'); summary.textContent = 'Supplier / Payee form details'; details.appendChild(summary);
  const grid = document.createElement('dl'); grid.className = 'supplier-summary-grid';
  for (const [name, label] of Object.entries(SUPPLIER_FORM_LABELS)) {
    let value = String(data[name] || '').trim();
    if (!value) continue;
    if (state.role !== 'admin' && name === 'account_number') value = value.length > 4 ? `•••• ${value.slice(-4)}` : '••••';
    const wrap = document.createElement('div');
    if (['account_number', 'bsb', 'swift_sort_bank_code', 'iban'].includes(name)) wrap.classList.add('sensitive-value');
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value;
    wrap.append(dt, dd); grid.appendChild(wrap);
  }
  details.appendChild(grid); host.appendChild(details);
}

async function openDetail(id) {
  const row = state.requests.find((r) => r.request_id === id);
  if (!row) return;
  state.selectedId = id;
  state.selectedVersion = row.last_updated_at || '';
  const isAdmin = state.role === 'admin';
  const deleted = isDeleted(row);

  el('detail-title').textContent = `${row.request_id} — ${row.request_type}${row.sub_type ? ' · ' + row.sub_type : ''}`;
  el('deleted-banner').hidden = !deleted;

  // Missing-info panel.
  const missing = incompleteOf(row);
  const mp = el('missing-panel');
  if (missing.length) { mp.hidden = false; mp.textContent = 'Missing information: ' + missing.map((m) => m.startsWith('attachment:') ? m.replace('attachment:', 'attachment ') : fieldLabel(m)).join(', '); }
  else mp.hidden = true;

  // Compact identity header. Workflow-specific information belongs in the details panel.
  const meta = el('detail-meta');
  meta.innerHTML = '';
  appendMetaValue(meta, 'Type', `${row.request_type}${row.sub_type ? ` (${row.sub_type})` : ''}`);
  appendMetaValue(meta, 'User', row.requester_name || row.beneficiary_name || '—');
  // Admins can edit the workflow below the complete request content. Keeping a second
  // Waiting on value in the identity strip makes it look like the workflow sits above
  // the form and can drift from the editable control.
  if (!isAdmin) appendMetaValue(meta, 'Waiting on', row.waiting_on, { waiting: true });
  appendMetaValue(meta, 'Created date', row.received_date || '—');
  appendMetaValue(meta, 'Updated date', row.last_updated_at ? fmtTime(row.last_updated_at) : '—');

  resetDetailBlockPlacement();

  // Admins get these fields as editable inputs below, so the read-only copy drops them.
  renderRequestDetails(row, isAdmin
    ? new Set([...adminEditableFieldNames(row), 'current_status'])
    : new Set());
  renderSupplierFormSummary(row);

  // Reimbursement lines + attachments.
  renderDetailLists(row);

  const history = await loadHistory(id);

  // Admin update form vs requester read-only.
  const form = el('update-form');
  form.hidden = !isAdmin;
  el('requester-actions').hidden = true;
  if (isAdmin) buildAdminForm(row, deleted);
  else buildRequesterActions(row, history);

  renderResubmissionSummary(row, history, isAdmin);
  placeDetailBlocks(isAdmin);

  el('update-msg').textContent = ''; el('update-msg').className = 'msg';
  el('internal-note-input').value = '';
  el('internal-note-msg').textContent = ''; el('internal-note-msg').className = 'msg';
  const reopening = !el('detail-overlay').hidden;
  el('detail-overlay').hidden = false;
  // aria-modal promises focus stays in the dialog, so put it there and remember where it
  // came from. Re-opening after an in-place save must not steal focus back to the header.
  if (!reopening) {
    state.detailOpener = document.activeElement;
    el('detail-close').focus();
  }
}

// Admins read the record as: its own fields, then the workflow controls, then its
// evidence. The attachments block therefore moves inside the update form, directly
// after Workflow; requesters keep it in the panel body, where there is no form to sit
// in. Both blocks are moved rather than duplicated so there is only ever one of each
// in the DOM.
// Park the movable blocks back at their markup position before anything re-renders.
// #requester-actions clears itself with innerHTML, which would otherwise destroy the
// attachment list along with it once it has been moved inside.
function resetDetailBlockPlacement() {
  const attachments = el('attachments-list');
  attachments.classList.remove('span-2');
  el('supplier-form-details').after(attachments);
}

function placeDetailBlocks(isAdmin) {
  const attachments = el('attachments-list');
  const workflow = el('admin-workflow-fields');
  const returnedSlot = el('returned-attachments-slot');
  if (isAdmin) {
    workflow.after(attachments);
    // The update form is a 3-column grid; the attachment list is full width in it.
    attachments.classList.add('span-2');
    // Open by default: these inputs are the only place the requester's own fields appear
    // for an admin, so leaving them collapsed would hide the record itself.
    el('admin-edit-details').open = true;
  } else if (returnedSlot) {
    // Same reading order as the admin panel: the fields being corrected, then the
    // documents belonging to them, then the response and the resubmit button.
    returnedSlot.appendChild(attachments);
  }
}

// Tab must not walk out of an open dialog into the page behind it.
function trapDetailFocus(event) {
  if (event.key !== 'Tab' || el('detail-overlay').hidden) return;
  const modal = el('detail-overlay').querySelector('.modal');
  const focusable = [...modal.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.disabled && node.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  else if (!modal.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
}

function buildAttachmentList(list, row) {
  const ul = document.createElement('ul'); ul.className = 'plain-list attachment-items';
  for (const a of list) {
    const li = document.createElement('li');
    li.className = 'attachment-item';
    // The document type is a category, not part of the file — keep it out of the link
    // so the clickable text is the filename alone.
    const kind = document.createElement('span');
    kind.className = 'attachment-kind';
    kind.textContent = attachmentLabel(a.purpose);
    li.appendChild(kind);
    if (a.stored) {
      const link = document.createElement('a');
      link.href = '/api/uploads/' + encodeURIComponent(a.stored);
      link.className = 'attachment-filename';
      link.textContent = a.filename;
      link.target = '_blank';
      li.appendChild(link);
      if (a.size) { const s = document.createElement('span'); s.className = 'muted small'; s.textContent = `${Math.round(a.size / 1024)} KB`; li.appendChild(s); }
    } else {
      const name = document.createElement('span');
      name.className = 'attachment-filename';
      name.textContent = a.filename;
      li.appendChild(name);
      const note = document.createElement('span');
      note.className = 'muted small'; note.textContent = 'metadata only';
      li.appendChild(note);
    }
    const requesterInvoicePurpose = new RegExp(
      '^(invoice:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
      + '|invoice_other:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
      + '|invoice_approval_email|invoice_approval_other:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$', 'i');
    const requesterCanRemove = row.current_status === 'Draft' || isReturnedStatus(row)
      || (row.request_type === 'Procurement' && row.current_status === PO_ISSUED_STATUS
        && requesterInvoicePurpose.test(String(a.purpose || '')));
    if (!isDeleted(row) && (state.role === 'admin' || (state.role !== 'admin' && requesterCanRemove))) {
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn-remove attachment-remove'; remove.textContent = '× Remove';
      remove.addEventListener('click', () => removeAttachment(row.request_id, a.purpose));
      li.appendChild(remove);
    }
    ul.appendChild(li);
  }
  return ul;
}

function buildAttachmentSummaryGroup(titleText, className, list, row, heading = 'h4') {
  const section = document.createElement('section');
  section.className = `attachment-summary-group ${className}`;
  const title = document.createElement(heading);
  title.className = 'attachment-summary-title';
  title.textContent = titleText;
  section.append(title, buildAttachmentList(list, row));
  return section;
}

function buildAttachmentSummarySubgroup(titleText, className, list, row) {
  return buildAttachmentSummaryGroup(titleText, `attachment-summary-subgroup ${className}`, list, row, 'h5');
}

function requiredAttachmentPurposes(row) {
  return new Set(requiredAttachmentPurposesFor(row.request_type, row.sub_type, row.supplier_type));
}

function invoiceAttachmentIndex(purpose, row) {
  const invoice = new RegExp(`^invoice:(${UUID_SOURCE})$`, 'i').exec(String(purpose || ''));
  if (invoice) return itemPosition(parseArr(row && row.invoice_items), invoice[1]);
  const invoiceOther = new RegExp(`^invoice_other:(${UUID_SOURCE}):${UUID_SOURCE}$`, 'i').exec(String(purpose || ''));
  return invoiceOther ? itemPosition(parseArr(row && row.invoice_items), invoiceOther[1]) : 0;
}

function groupRequesterAttachments(attachments, row) {
  const required = [];
  const other = [];
  const invoiceApproval = [];
  const receipts = [];
  const invoices = new Map();
  const additional = [];
  const requiredPurposes = requiredAttachmentPurposes(row);
  const supportingPurposes = new Set([
    ...requiredPurposes,
    ...adminSupportingUploadPlan(row).fixedPurposes,
  ]);

  for (const attachment of attachments) {
    const purpose = String(attachment.purpose || '');
    if (supportingPurposes.has(purpose)) {
      required.push(attachment);
    } else if (new RegExp(`^other_document:${UUID_SOURCE}$`, 'i').test(purpose)) {
      other.push(attachment);
    } else if (purpose === 'invoice_approval_email' || new RegExp(`^invoice_approval_other:${UUID_SOURCE}$`, 'i').test(purpose)) {
      invoiceApproval.push(attachment);
    } else if (invoiceAttachmentIndex(purpose, row)) {
      const index = invoiceAttachmentIndex(purpose, row);
      if (!invoices.has(index)) invoices.set(index, []);
      invoices.get(index).push(attachment);
    } else if (new RegExp(`^receipt:${UUID_SOURCE}$`, 'i').test(purpose)) {
      receipts.push(attachment);
    } else {
      additional.push(attachment);
    }
  }
  return { required, other, invoiceApproval, receipts, invoices, additional };
}

// One repeatable Other documents control shared by intake, admin, returned requests and
// stage-specific uploads. The stored purpose is stable, while the visible label is always
// the current list position so legacy gaps and removed draft slots never confuse users.
function buildRequiredDocumentSection(helpText = 'Required documents are marked with *.') {
  const section = document.createElement('section');
  section.className = 'attachment-subsection required-document-section';
  const title = document.createElement('h4');
  title.className = 'attachment-subsection-title';
  title.textContent = 'Required documents';
  const help = document.createElement('p');
  help.className = 'muted small';
  help.textContent = helpText;
  const fields = document.createElement('div');
  fields.className = 'attachment-subsection-grid';
  section.append(title, help, fields);
  return { section, fields };
}

const NEW_SUPPLIER_EVIDENCE_OPTIONS = [
  "A signed letter on official supplier letterhead detailing bank details (N/A to Non-Supplier Payee);",
  "A quotation or tax invoice bearing the supplier’s ABN and bank details (N/A to Non-Supplier Payee);",
  "A letter from your financial institution’s official letterhead with the bank details;",
  'A copy of the bank statement with the bank details.',
];

function buildNewSupplierEvidenceNote() {
  const note = document.createElement('div');
  note.className = 'info-note other-document-note';
  const intro = document.createElement('p');
  intro.textContent = 'Additional supporting documentation required for New Suppliers, ONE of the following must be provided:';
  const list = document.createElement('ul');
  for (const option of NEW_SUPPLIER_EVIDENCE_OPTIONS) {
    const item = document.createElement('li'); item.textContent = option; list.appendChild(item);
  }
  const outro = document.createElement('p');
  outro.textContent = 'Please upload one of above via Other documents';
  note.append(intro, list, outro);
  return note;
}

function buildOtherDocumentList({ attachments = [], storedByPurpose, purposeDatasetKey = 'purpose', allowStoredRemove = false, includeNewSupplierEvidence = false, showNewSupplierEvidence = false } = {}) {
  const source = storedByPurpose ? [...storedByPurpose.values()] : attachments;
  const existing = source
    .filter((item) => item && new RegExp(`^other_document:${UUID_SOURCE}$`, 'i').test(item.purpose));
  const container = document.createElement('section'); container.className = 'other-document-list attachment-subsection';
  const title = document.createElement('h4'); title.textContent = 'Other documents';
  const help = document.createElement('p'); help.className = 'muted';
  help.textContent = 'Add any supporting document that does not match the listed categories.';
  const note = includeNewSupplierEvidence ? buildNewSupplierEvidenceNote() : null;
  if (note) note.hidden = !showNewSupplierEvidence;
  const slots = document.createElement('div'); slots.className = 'other-document-slots';

  const sync = () => {
    [...slots.children].forEach((slot, offset) => {
      const input = slot.querySelector('input[type=file]');
      if (!input) return;
      const purpose = slot.dataset.storedPurpose || `other_document:${slot.dataset.documentId}`;
      input.dataset[purposeDatasetKey] = purpose;
      const label = input.closest('label');
      const labelText = label && label.querySelector(':scope > span');
      if (labelText && labelText.firstChild) labelText.firstChild.textContent = `Other document ${offset + 1}`;
    });
  };
  const addSlot = (stored) => {
    const documentId = stored ? String(stored.purpose).split(':')[1] : stableClientId();
    const slot = document.createElement('div'); slot.className = 'other-document-slot';
    slot.dataset.documentId = documentId;
    if (stored) slot.dataset.storedPurpose = stored.purpose;
    const fieldOptions = { stored };
    if (stored && allowStoredRemove && state.editingDraftId) {
      fieldOptions.storedRow = makeUploadedFileRow(stored.purpose, stored);
    }
    const field = fileField('Other document', fieldOptions);
    slot.appendChild(field.label);
    if (!stored) {
      const remove = document.createElement('button'); remove.type = 'button';
      remove.className = 'btn-remove attachment-remove other-slot-remove'; remove.textContent = '\u00d7 Remove document';
      remove.addEventListener('click', () => {
        slot.remove();
        sync();
      });
      slot.appendChild(remove);
    }
    slots.appendChild(slot);
    sync();
  };
  existing.forEach((item) => addSlot(item));
  const addButton = document.createElement('button'); addButton.type = 'button'; addButton.className = 'btn-quiet';
  addButton.textContent = '+ Add other document'; addButton.addEventListener('click', () => addSlot());
  container.append(title, help, ...(note ? [note] : []), slots, addButton);
  return {
    container,
    slots,
    addButton,
    sync,
    setNewSupplierEvidence(show) {
      if (note) note.hidden = !show;
    },
  };
}

function adminSupportingUploadPlan(row) {
  const stageCollected = new Set(state.options.stage_collected_attachment_purposes || []);
  const purposes = ((((state.options.allowed_attachments_by_subtype || {})[row.request_type] || {})[row.sub_type]) || []);
  const fixedPurposes = purposes.filter((purpose) => purpose !== 'other_document'
    && !stageCollected.has(purpose)
    && (row.request_type === 'Procurement' || purpose !== 'new_supplier_form'));
  return { purposes, fixedPurposes };
}

function appendAdminFinanceUploads(box, row) {
  const attachments = parseArr(row.attachments);
  const storedByPurpose = new Map(attachments.filter((item) => item && item.purpose).map((item) => [item.purpose, item]));
  const allowed = ((((state.options.allowed_attachments_by_subtype || {})[row.request_type] || {})[row.sub_type]) || []);
  const financePurposes = (state.options.admin_only_attachment_purposes || [])
    .filter((purpose) => allowed.includes(purpose) || storedByPurpose.has(purpose));
  if (!financePurposes.length) return null;

  const panel = document.createElement('div');
  panel.className = 'dyn-grid document-upload-session admin-finance-documents admin-attachment-editor';
  const fields = document.createElement('div'); fields.className = 'attachment-subsection-grid span-2';
  for (const purpose of financePurposes) {
    const field = fileField(attachmentLabel(purpose), { stored: storedByPurpose.get(purpose) });
    field.input.dataset.purpose = purpose;
    if (purpose === 'po') field.input.dataset.stagePurpose = purpose;
    fields.appendChild(field.label);
  }
  panel.appendChild(fields);
  box.appendChild(panel);
  state.adminFinanceEditor = panel;
  return panel;
}

function adminSupportingUploadAvailable(row) {
  const { purposes, fixedPurposes } = adminSupportingUploadPlan(row);
  const attachments = parseArr(row.attachments);
  const hasInvoiceDocuments = row.request_type === 'Procurement'
    && (purposes.includes('invoice') || purposes.includes('invoice_approval_email')
      || attachments.some((item) => item && /^(invoice(?::|$)|invoice_other:|invoice_approval_)/.test(String(item.purpose || ''))));
  const hasReceipts = row.request_type === 'Reimbursement'
    && (parseArr(row.reimbursement_items).length > 0 || attachments.some((item) => item && new RegExp(`^receipt:${UUID_SOURCE}$`, 'i').test(String(item.purpose || ''))));
  return fixedPurposes.length > 0 || purposes.includes('other_document') || hasInvoiceDocuments || hasReceipts;
}

function appendAdminSupportingUploads(box, row) {
  const { purposes, fixedPurposes } = adminSupportingUploadPlan(row);
  const attachments = parseArr(row.attachments);
  const storedByPurpose = new Map(attachments.filter((item) => item && item.purpose).map((item) => [item.purpose, item]));
  const required = new Set(requiredAttachmentPurposesFor(row.request_type, row.sub_type, row.supplier_type));

  const hasInvoiceDocuments = row.request_type === 'Procurement'
    && (purposes.includes('invoice') || purposes.includes('invoice_approval_email')
      || attachments.some((item) => item && /^(invoice(?::|$)|invoice_other:|invoice_approval_)/.test(String(item.purpose || ''))));
  const hasReceipts = row.request_type === 'Reimbursement'
    && (parseArr(row.reimbursement_items).length > 0 || attachments.some((item) => item && new RegExp(`^receipt:${UUID_SOURCE}$`, 'i').test(String(item.purpose || ''))));
  if (!adminSupportingUploadAvailable(row)) return null;

  const panel = document.createElement('div');
  // The surrounding "Requester-uploaded documents" group already provides the owner
  // and editing context. Keep this wrapper structural so the actual document categories
  // are the next visible level instead of adding another redundant heading.
  panel.className = 'admin-supporting-documents admin-attachment-editor';
  const requiredSection = fixedPurposes.length
    ? buildRequiredDocumentSection('Required documents are marked with *.')
    : null;
  if (requiredSection) panel.appendChild(requiredSection.section);
  const fixedFields = new Map();
  for (const purpose of fixedPurposes) {
    const existing = storedByPurpose.get(purpose);
    const field = fileField(attachmentLabel(purpose), {
      required: row.request_type === 'Procurement' ? false : required.has(purpose) && !existing,
      stored: existing,
    });
    field.input.dataset.purpose = purpose;
    fixedFields.set(purpose, field);
    requiredSection.fields.appendChild(field.label);
  }
  const otherDocumentList = buildOtherDocumentList({
    storedByPurpose,
    purposeDatasetKey: 'purpose',
  });
  const syncProcurementDocuments = (supplierType = row.supplier_type) => {
    if (row.request_type !== 'Procurement') return;
    const isNewSupplier = isNewSupplierType(supplierType);
    const requiredPurposes = requiredAttachmentPurposesFor(row.request_type, row.sub_type, supplierType);
    for (const purpose of PROCUREMENT_INTAKE_DOCUMENTS) {
      const field = fixedFields.get(purpose);
      if (!field) continue;
      requiredSection?.fields.appendChild(field.label);
      setAttachmentRequired(field, requiredPurposes.includes(purpose));
    }
    const newSupplier = fixedFields.get('new_supplier_form');
    if (newSupplier) {
      newSupplier.label.hidden = !isNewSupplier;
      requiredSection?.fields.appendChild(newSupplier.label);
      setAttachmentRequired(newSupplier, isNewSupplier);
    }
    otherDocumentList.setNewSupplierEvidence(isNewSupplier);
  };
  syncProcurementDocuments();
  panel.syncSupplierType = syncProcurementDocuments;

  if (purposes.includes('other_document')) {
    panel.appendChild(otherDocumentList.container);
  }

  let syncInvoiceSlots = () => {};
  if (hasInvoiceDocuments) {
    const invoiceItems = parseArr(row.invoice_items);
    const initialInvoiceCount = Math.max(invoiceItems.length, purposes.includes('invoice') ? 1 : 0);
    const invoiceDocuments = document.createElement('section');
    invoiceDocuments.className = 'admin-invoice-documents invoice-admin-editor attachment-subsection';
    const invoiceTitle = document.createElement('h4'); invoiceTitle.textContent = 'Invoice documents';
    const invoiceHelp = document.createElement('p'); invoiceHelp.className = 'muted';
    invoiceHelp.textContent = 'Enter each invoice’s details and manage its invoice file or optional documents in the same section.';
    const invoiceSlots = document.createElement('div'); invoiceSlots.className = 'invoice-items admin-invoice-slots';
    const invoiceSlotRecords = [];
    const addInvoiceSlot = (initialIndex, requestedItemId) => {
      const itemId = stableClientId(requestedItemId || invoiceItems[initialIndex - 1]?.item_id);
      const existing = storedByPurpose.get(`invoice:${itemId}`);
      const invoiceFile = fileField('Invoice file', { stored: existing });
      invoiceFile.label.classList.add('invoice-document-field');
      invoiceFile.input.dataset.purpose = `invoice:${itemId}`;
      const otherDocuments = buildInvoiceOtherDocuments(itemId, storedByPurpose, 'purpose');
      const group = buildInvoiceDocumentGroup(initialIndex, invoiceFile.label, otherDocuments, `Invoice ${initialIndex} documents`);
      group.dataset.itemId = itemId;
      group.querySelectorAll('input[type=file]').forEach((input) => {
        input.addEventListener('change', () => state.adminAttachmentEditor?.onInvoiceFileChange?.());
      });
      const record = {
        group,
        sync(index) {
          group.dataset.invoiceIndex = String(index);
          const groupTitle = group.querySelector('.invoice-document-title');
          if (groupTitle) groupTitle.textContent = `Invoice ${index} documents`;
          otherDocuments.sync(itemId);
        },
      };
      invoiceSlotRecords.push(record);
      invoiceSlots.appendChild(group);
    };
    const minimumInvoiceSlots = purposes.includes('invoice') ? 1 : 0;
    syncInvoiceSlots = (requestedCount) => {
      const count = Math.max(Number(requestedCount) || 0, minimumInvoiceSlots);
      while (invoiceSlotRecords.length > count) {
        const record = invoiceSlotRecords[invoiceSlotRecords.length - 1];
        const hasStoredFile = !!record.group.querySelector('.attachment-uploaded');
        const hasSelectedFile = [...record.group.querySelectorAll('input[type=file]')]
          .some((input) => input.files && input.files.length);
        if (hasStoredFile || hasSelectedFile) break;
        record.group.remove();
        invoiceSlotRecords.pop();
      }
      while (invoiceSlotRecords.length < count) addInvoiceSlot(invoiceSlotRecords.length + 1);
      invoiceSlotRecords.slice(0, count).forEach((record, offset) => record.sync(offset + 1));
    };
    syncInvoiceSlots(initialInvoiceCount);
    invoiceDocuments.append(invoiceTitle, invoiceHelp, invoiceSlots);
    panel.appendChild(invoiceDocuments);

    if (purposes.includes('invoice_approval_email') || storedByPurpose.has('invoice_approval_email')) {
      const approval = fileField('Invoice approval email', { stored: storedByPurpose.get('invoice_approval_email') });
      approval.input.dataset.purpose = 'invoice_approval_email';
      approval.label.classList.add('invoice-approval-field');
      const approvalOtherDocuments = buildApprovalOtherDocuments(storedByPurpose, 'purpose');
      panel.appendChild(buildApprovalDocumentSection(approval, approvalOtherDocuments));
    }
  }

  if (hasReceipts) {
    const items = parseArr(row.reimbursement_items);
    const receiptDocuments = document.createElement('section');
    receiptDocuments.className = 'admin-receipt-documents attachment-subsection';
    const receiptTitle = document.createElement('h4'); receiptTitle.textContent = 'Receipt documents';
    const receiptHelp = document.createElement('p'); receiptHelp.className = 'muted';
    receiptHelp.textContent = 'Finance can replace or add the receipt for each expense line.';
    const receiptFields = document.createElement('div'); receiptFields.className = 'attachment-subsection-grid';
    items.forEach((item, offset) => {
      const purpose = `receipt:${item.item_id}`;
      const field = fileField(`Receipt for expense line ${offset + 1}`, { stored: storedByPurpose.get(purpose) });
      field.input.dataset.purpose = purpose;
      receiptFields.appendChild(field.label);
    });
    receiptDocuments.append(receiptTitle, receiptHelp, receiptFields);
    panel.appendChild(receiptDocuments);
  }

  const known = new Set([
    ...fixedPurposes,
    ...(state.options.admin_only_attachment_purposes || []),
  ]);
  for (const attachment of attachments) {
    const purpose = String(attachment && attachment.purpose || '');
    if (new RegExp(`^other_document:${UUID_SOURCE}$`, 'i').test(purpose)
      || new RegExp(`^invoice:${UUID_SOURCE}$`, 'i').test(purpose)
      || new RegExp(`^invoice_other:${UUID_SOURCE}:${UUID_SOURCE}$`, 'i').test(purpose)
      || purpose === 'invoice_approval_email'
      || new RegExp(`^invoice_approval_other:${UUID_SOURCE}$`, 'i').test(purpose)
      || new RegExp(`^receipt:${UUID_SOURCE}$`, 'i').test(purpose)) known.add(purpose);
  }
  const additional = attachments.filter((attachment) => attachment && attachment.purpose && !known.has(attachment.purpose));
  if (additional.length) {
    const additionalDocuments = document.createElement('section');
    additionalDocuments.className = 'admin-additional-documents attachment-subsection';
    const additionalTitle = document.createElement('h4'); additionalTitle.textContent = 'Additional documents';
    const additionalHelp = document.createElement('p'); additionalHelp.className = 'muted';
    additionalHelp.textContent = 'Existing documents that do not match the current standard categories can still be replaced here.';
    const additionalFields = document.createElement('div'); additionalFields.className = 'attachment-subsection-grid';
    for (const attachment of additional) {
      const field = fileField(attachmentLabel(attachment.purpose), { stored: attachment });
      field.input.dataset.purpose = attachment.purpose;
      additionalFields.appendChild(field.label);
    }
    additionalDocuments.append(additionalTitle, additionalHelp, additionalFields);
    panel.appendChild(additionalDocuments);
  }

  box.appendChild(panel);
  state.adminAttachmentEditor = {
    panel,
    invoiceDocuments: panel.querySelector('.admin-invoice-documents'),
    syncInvoiceSlots,
    onInvoiceFileChange: null,
    getInvoiceGroup(index) {
      return panel.querySelector(`.invoice-document-group[data-invoice-index="${index}"]`);
    },
    hasInvoiceFile(index) {
      const record = panel.querySelector(`.invoice-document-group[data-invoice-index="${index}"]`);
      if (!record) return false;
      return !!record.querySelector('.attachment-uploaded')
        || [...record.querySelectorAll('input[type=file]')].some((input) => input.files && input.files.length);
    },
  };
  return state.adminAttachmentEditor;
}

function buildReturnedSupportingUploads(row, returnedFrom = '', supplierTypeControl = null) {
  const attachments = parseArr(row.attachments);
  const storedByPurpose = new Map(attachments.filter((item) => item && item.purpose).map((item) => [item.purpose, item]));
  const adminOnly = new Set(state.options.admin_only_attachment_purposes || []);
  const stageCollected = new Set(state.options.stage_collected_attachment_purposes || []);
  const purposes = ((((state.options.allowed_attachments_by_subtype || {})[row.request_type] || {})[row.sub_type]) || []);
  const required = requiredAttachmentPurposesFor(row.request_type, row.sub_type, row.supplier_type);

  const panel = document.createElement('div');
  panel.className = 'dyn-grid document-upload-session returned-supporting-documents';
  const title = document.createElement('h4'); title.textContent = 'Supporting documents';
  const help = document.createElement('p'); help.className = 'muted';
  help.textContent = 'Choose a new file only when you need to add or replace a document. Selected files upload when you save or resubmit.';
  panel.append(title, help);

  const fixedPurposes = purposes.filter((purpose) => purpose !== 'other_document'
    && !adminOnly.has(purpose) && !stageCollected.has(purpose)
    && (row.request_type === 'Procurement' || purpose !== 'new_supplier_form'));
  const requiredSection = fixedPurposes.length
    ? buildRequiredDocumentSection('Required documents are marked with *.')
    : null;
  if (requiredSection) panel.appendChild(requiredSection.section);
  const fixedFields = new Map();
  for (const purpose of fixedPurposes) {
    const existing = storedByPurpose.get(purpose);
    const field = fileField(attachmentLabel(purpose), {
      required: row.request_type === 'Procurement' ? false : required.includes(purpose) && !existing,
      stored: existing,
    });
    field.input.dataset.returnedPurpose = purpose;
    fixedFields.set(purpose, field);
    requiredSection.fields.appendChild(field.label);
  }
  const syncProcurementDocuments = (supplierType = row.supplier_type) => {
    if (row.request_type !== 'Procurement') return;
    const isNewSupplier = isNewSupplierType(supplierType);
    const requiredPurposes = requiredAttachmentPurposesFor(row.request_type, row.sub_type, supplierType);
    for (const purpose of PROCUREMENT_INTAKE_DOCUMENTS) {
      const field = fixedFields.get(purpose);
      if (!field) continue;
      requiredSection?.fields.appendChild(field.label);
      setAttachmentRequired(field, requiredPurposes.includes(purpose));
    }
    const newSupplier = fixedFields.get('new_supplier_form');
    if (newSupplier) {
      newSupplier.label.hidden = !isNewSupplier;
      requiredSection?.fields.appendChild(newSupplier.label);
      setAttachmentRequired(newSupplier, isNewSupplier);
      if (!isNewSupplier && !newSupplier.label.querySelector('.attachment-uploaded')) newSupplier.input.value = '';
    }
  };
  syncProcurementDocuments(supplierTypeControl?.value || row.supplier_type);
  if (supplierTypeControl) supplierTypeControl.addEventListener('change', () => syncProcurementDocuments(supplierTypeControl.value));

  const procurementStatuses = (state.options.statuses_by_type || {}).Procurement || [];
  const returnedIndex = procurementStatuses.indexOf(returnedFrom);
  const invoiceIndex = procurementStatuses.indexOf(INVOICE_RECEIVED_STATUS);
  if (row.request_type === 'Procurement' && invoiceIndex >= 0 && returnedIndex >= invoiceIndex) {
    const invoiceDocuments = document.createElement('div'); invoiceDocuments.className = 'returned-stage-documents span-2';
    const invoiceTitle = document.createElement('h4'); invoiceTitle.textContent = 'Invoice documents';
    invoiceDocuments.appendChild(invoiceTitle);
    const invoiceItems = parseArr(row.invoice_items);
    // Older requests may have reached the invoice stage before invoice_items was
    // introduced. Keep one invoice upload slot available so those rows can still be
    // corrected and resubmitted instead of rendering an empty document section.
    (invoiceItems.length ? invoiceItems : [{ item_id: stableClientId() }]).forEach((item, offset) => {
      const index = offset + 1;
      const itemId = stableClientId(item.item_id);
      const existing = storedByPurpose.get(`invoice:${itemId}`);
      const invoiceFile = fileField(`Invoice ${index} file`, { required: !existing, stored: existing });
      // Keep the returned-request editor visually identical to the live invoice handover
      // editor. The shared grid styles use these classes to give the main document the same
      // card treatment as its optional Other documents.
      invoiceFile.label.classList.add('invoice-document-field');
      invoiceFile.input.dataset.returnedPurpose = `invoice:${itemId}`;
      const otherDocuments = buildInvoiceOtherDocuments(itemId, storedByPurpose, 'returnedPurpose');
      invoiceDocuments.appendChild(buildInvoiceDocumentGroup(index, invoiceFile.label, otherDocuments));
    });
    const existingApproval = storedByPurpose.get('invoice_approval_email');
    const approval = fileField('Invoice approval email', { required: !existingApproval, stored: existingApproval });
    approval.label.classList.add('invoice-approval-field');
    approval.input.dataset.returnedPurpose = 'invoice_approval_email';
    const approvalOther = buildApprovalOtherDocuments(storedByPurpose, 'returnedPurpose');
    invoiceDocuments.appendChild(buildApprovalDocumentSection(approval, approvalOther));
    panel.appendChild(invoiceDocuments);
  }

  if (purposes.includes('other_document')) {
    panel.appendChild(buildOtherDocumentList({
      storedByPurpose,
      purposeDatasetKey: 'returnedPurpose',
    }).container);
  }
  return panel;
}

async function uploadReturnedSupportingFiles(row, panel, startingVersion = '') {
  let current = { ...row, last_updated_at: startingVersion || state.selectedVersion || row.last_updated_at };
  for (const input of panel.querySelectorAll('input[type=file][data-returned-purpose]')) {
    if (input.files && input.files.length) {
      current = await uploadOne(row.request_id, input.dataset.returnedPurpose, input.files[0], current.last_updated_at);
    }
  }
  state.selectedVersion = current.last_updated_at || state.selectedVersion;
  return current;
}

async function uploadReturnedRequestFiles(row, returnedUploads, lineBody) {
  let current = { ...row, last_updated_at: state.selectedVersion || row.last_updated_at };
  if (lineBody) {
    const rows = [...lineBody.querySelectorAll('tr')];
    for (const line of rows) {
      const input = line.querySelector('.line-receipt');
      if (input && input.files && input.files.length) {
        current = await uploadOne(row.request_id, `receipt:${line.dataset.itemId}`, input.files[0], current.last_updated_at);
      }
    }
  }
  return uploadReturnedSupportingFiles(row, returnedUploads, current.last_updated_at);
}

function renderDetailLists(row) {
  const box = el('attachments-list');
  box.innerHTML = '';
  const items = parseArr(row.reimbursement_items);
  if (items.length) {
    const h = document.createElement('h4'); h.textContent = 'Expense lines'; box.appendChild(h);
    const ul = document.createElement('ul'); ul.className = 'plain-list';
    for (const it of items) {
      const li = document.createElement('li');
      li.textContent = `${it.category} · Total Excl. GST ${formatMoney(it.amount_ex_gst)} · Total Incl. GST ${formatMoney(it.amount)}${it.supplier ? ' · ' + it.supplier : ''}${it.description ? ' · ' + it.description : ''} · receipt: ${it.receipt || '—'}`;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  const atts = parseArr(row.attachments);
  // Documents Finance issues are not the requester's own paperwork and must not read as
  // if they were: the PO is something handed back, not something supplied.
  const financeOnly = state.options.admin_only_attachment_purposes || [];
  const fromFinance = atts.filter((a) => a && financeOnly.includes(a.purpose));
  const fromRequester = atts.filter((a) => a && !financeOnly.includes(a.purpose));
  const adminEditingAttachments = state.role === 'admin' && !isDeleted(row);
  const adminHasSupportingEditor = adminEditingAttachments && adminSupportingUploadAvailable(row);
  const adminFinancePurposes = adminEditingAttachments
    ? financeOnly.filter((purpose) => {
      const allowed = ((((state.options.allowed_attachments_by_subtype || {})[row.request_type] || {})[row.sub_type]) || []);
      return allowed.includes(purpose) || atts.some((item) => item && item.purpose === purpose);
    })
    : [];
  const adminHasFinanceEditor = adminFinancePurposes.length > 0;
  state.adminAttachmentEditor = null;
  state.adminFinanceEditor = null;

  if (fromFinance.length || adminHasFinanceEditor) {
    if (state.role === 'admin') {
      const financeGroup = document.createElement('section');
      financeGroup.className = 'attachment-summary-group attachment-summary-finance';
      const financeHeading = document.createElement('h4');
      financeHeading.className = 'attachment-summary-title';
      financeHeading.textContent = 'Issued by Finance';
      const financeNote = document.createElement('p');
      financeNote.className = 'attachment-summary-owner-note muted small';
      financeNote.textContent = adminEditingAttachments
        ? 'Finance-issued documents can be uploaded or replaced here. Every change is recorded in History.'
        : 'Finance-issued documents are shown separately.';
      financeGroup.append(financeHeading, financeNote);
      if (adminHasFinanceEditor) appendAdminFinanceUploads(financeGroup, row);
      else if (fromFinance.length) financeGroup.appendChild(buildAttachmentList(fromFinance, row));
      box.appendChild(financeGroup);
    } else {
      const financeHeading = 'Documents from Finance';
      box.appendChild(buildAttachmentSummaryGroup(financeHeading, 'attachment-summary-finance', fromFinance, row));
    }
  }

  const requesterGroup = document.createElement('section');
  requesterGroup.className = state.role === 'admin'
    ? 'attachment-summary-subgroup attachment-summary-requester attachment-summary-requester-owner'
    : 'attachment-summary-group attachment-summary-requester';
  const requesterHeading = document.createElement(state.role === 'admin' ? 'h5' : 'h4');
  requesterHeading.className = 'attachment-summary-title';
  requesterHeading.textContent = state.role === 'admin'
    ? 'User-uploaded documents'
    : (fromFinance.length ? 'Documents you supplied' : 'Attachments');
  requesterGroup.appendChild(requesterHeading);

  let requesterContainer = requesterGroup;
  if (state.role === 'admin') {
    requesterContainer = document.createElement('section');
    requesterContainer.className = 'attachment-summary-group attachment-summary-supporting';
    const supportingHeading = document.createElement('h4');
    supportingHeading.className = 'attachment-summary-title';
    supportingHeading.textContent = 'Supporting documents';
    const supportingNote = document.createElement('p');
    supportingNote.className = 'attachment-summary-owner-note muted small';
    supportingNote.textContent = 'User-uploaded documents are shown below. Finance-issued documents are shown separately above.';
    requesterContainer.append(supportingHeading, supportingNote, requesterGroup);
    box.appendChild(requesterContainer);
  } else {
    box.appendChild(requesterGroup);
  }

  if (state.role === 'admin') {
    const ownerNote = document.createElement('p');
    ownerNote.className = 'attachment-summary-owner-note muted small';
    ownerNote.textContent = 'Files supplied by the user. Finance can upload or replace them here; every change is recorded in History.';
    requesterGroup.appendChild(ownerNote);
  }

  if (adminHasSupportingEditor) {
    appendAdminSupportingUploads(requesterGroup, row);
  } else if (!fromRequester.length) {
    const p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'No attachments yet.';
    requesterGroup.appendChild(p);
  } else {
    const grouped = groupRequesterAttachments(fromRequester, row);
    if (grouped.required.length) {
      requesterGroup.appendChild(buildAttachmentSummarySubgroup('Required documents', 'attachment-summary-required', grouped.required, row));
    }
    if (grouped.other.length) {
      requesterGroup.appendChild(buildAttachmentSummarySubgroup('Other documents', 'attachment-summary-other', grouped.other, row));
    }
    [...grouped.invoices.entries()].sort(([a], [b]) => a - b).forEach(([index, list]) => {
      requesterGroup.appendChild(buildAttachmentSummarySubgroup(`Invoice ${index} documents`, 'attachment-summary-invoice', list, row));
    });
    if (grouped.invoiceApproval.length) {
      requesterGroup.appendChild(buildAttachmentSummarySubgroup('Approval documents', 'attachment-summary-approval', grouped.invoiceApproval, row));
    }
    if (grouped.receipts.length) {
      requesterGroup.appendChild(buildAttachmentSummarySubgroup('Receipts', 'attachment-summary-receipts', grouped.receipts, row));
    }
    if (grouped.additional.length) {
      requesterGroup.appendChild(buildAttachmentSummarySubgroup('Additional documents', 'attachment-summary-additional', grouped.additional, row));
    }
  }

}

function buildAdminForm(row, deleted) {
  const form = el('update-form');
  // Only where this request can actually go from where it is. The server enforces the
  // same map, so offering the rest would just be a dropdown full of guaranteed 400s.
  const successors = ((state.options.allowed_transitions_by_type || {})[row.request_type] || {})[row.current_status];
  const statuses = (successors
    ? [row.current_status, ...successors]
    : ((state.options.statuses_by_type || {})[row.request_type] || []))
    .filter((status) => status !== 'Updated and Resubmitted' || status === row.current_status)
    .filter((status) => row.request_type !== 'Procurement' || status !== 'Draft');
  fillNameSelectRaw(form.current_status, statuses, row.current_status);
  fillPersonNameSelect(form.processed_by, state.options.processors, '— unassigned —', row.processed_by);
  form.current_status.onchange = () => updateAdminStage(form.current_status.value, row.request_type, row);

  // Procurement admin follow-up fields.
  const extra = el('admin-extra-fields');
  extra.innerHTML = '';
  if (row.request_type === 'Procurement') {
    const storedByPurpose = new Map(parseArr(row.attachments).filter((a) => a && a.stored).map((a) => [a.purpose, a]));
    const addTextField = (name, text, stageClass, required = false) => {
      const label = document.createElement('label'); label.classList.add(stageClass);
      const span = document.createElement('span'); span.textContent = text;
      if (required) { const star = document.createElement('span'); star.className = 'req-star'; star.textContent = ' *'; span.appendChild(star); }
      const input = document.createElement('input'); input.type = name.includes('amount') ? 'number' : 'text'; input.name = name; input.value = row[name] || '';
      input.dataset.stageRequired = required ? 'true' : 'false';
      if (input.type === 'number') { input.step = '0.01'; input.min = '0'; }
      label.append(span, input); extra.appendChild(label);
    };
    const addGstMethod = (stageClass) => {
      const label = document.createElement('label'); label.classList.add(stageClass);
      const span = document.createElement('span'); span.textContent = 'How was GST entered?';
      const select = document.createElement('select'); select.name = 'invoice_gst_entry_method';
      select.append(opt('— select —', ''), opt('Total includes GST', 'Total includes GST'), opt('Enter GST separately', 'Enter GST separately'));
      select.value = row.invoice_gst_entry_method || ''; label.append(span, select); extra.appendChild(label);
    };
    // Stage documents sit with the fields they belong to. The input carries data-purpose
    // instead of a name so the form's field collector ignores it — onUpdate stores the file
    // through the attachments endpoint before patching the fields.
    // Documents are much taller than a text field once they show the stored file, so they
    // get their own full-width panel. Mixed into the same grid they leave ragged rows and
    // strand the checkboxes in whatever column happens to be free.
    const poHeading = document.createElement('div'); poHeading.className = 'form-section-title stage-po'; poHeading.textContent = 'Purchase order'; extra.appendChild(poHeading);
    // The required marker follows the workflow status below; before a PO is issued the
    // existing value is still useful context, but the field is not yet required.
    addTextField('po_number', 'PO number', 'stage-po', false);

    // Invoice details are rendered inside the matching Invoice documents card below.
    const closeSelect = form.elements.close_reason;
    if (closeSelect) closeSelect.value = row.close_reason || '';
    const invoiceItems = parseArr(row.invoice_items);
    const invoiceEditor = state.adminAttachmentEditor;
    const invoiceDocuments = invoiceEditor?.invoiceDocuments;
    const invoiceRows = invoiceEditor?.panel.querySelector('.admin-invoice-slots');
    const syncAdminInvoiceRows = () => {
      if (!invoiceRows) return;
      const groups = [...invoiceRows.children];
      if (state.adminAttachmentEditor) state.adminAttachmentEditor.syncInvoiceSlots(groups.length);
      [...invoiceRows.children].forEach((invoiceRow, offset) => {
        const index = offset + 1;
        const cardTitle = invoiceRow.querySelector('.invoice-document-title');
        const numberTitle = invoiceRow.querySelector('.admin-invoice-number')?.closest('label')?.querySelector(':scope > span');
        if (cardTitle) cardTitle.textContent = `Invoice ${index} documents`;
        if (numberTitle?.firstChild) numberTitle.firstChild.textContent = 'Invoice number';
        const remove = invoiceRow.querySelector('.invoice-remove-button');
        if (!remove) return;
        if (invoiceRows.children.length <= 1) {
          remove.disabled = true;
          remove.title = 'At least one invoice is required.';
        } else if (state.adminAttachmentEditor?.hasInvoiceFile(index)) {
          remove.disabled = true;
          remove.title = 'Clear the invoice documents first if this invoice should be removed.';
        } else if (invoiceRow !== invoiceRows.lastElementChild) {
          remove.disabled = true;
          remove.title = 'Remove the last invoice first so invoice document numbers stay aligned.';
        } else {
          remove.disabled = false;
          remove.title = '';
        }
      });
    };
    if (invoiceEditor) invoiceEditor.onInvoiceFileChange = syncAdminInvoiceRows;
    const addAdminInvoice = (item = {}, requestedIndex = invoiceRows?.children.length + 1) => {
      if (!invoiceEditor || !invoiceRows || !invoiceDocuments) return;
      if (!invoiceEditor.getInvoiceGroup(requestedIndex)) invoiceEditor.syncInvoiceSlots(requestedIndex);
      const invoiceRow = invoiceEditor.getInvoiceGroup(requestedIndex);
      if (!invoiceRow || invoiceRow.querySelector('.invoice-admin-details')) return;
      const number = textField('Invoice number');
      number.input.className = 'admin-invoice-number'; number.input.required = false; number.input.value = item.invoice_number || '';
      number.label.classList.add('invoice-number-field');
      const amountHelp = document.createElement('p'); amountHelp.className = 'gst-amount-guidance muted small span-3';
      amountHelp.textContent = 'Enter either Total Excl. GST or Total Incl. GST. At least one amount is required.';
      const ex = textField('Total Excl. GST ($)', { type: 'number' }); ex.input.className = 'admin-invoice-ex'; ex.input.value = item.amount_ex_gst || '';
      const total = textField('Total Incl. GST ($)', { type: 'number' }); total.input.className = 'admin-invoice-total'; total.input.value = item.amount_inc_gst || '';
      const syncAmounts = () => {
        const hasAmount = !!ex.input.value.trim() || !!total.input.value.trim();
        const required = ex.input.dataset.stageInvoiceRequired === 'true';
        ex.input.setCustomValidity(!required || hasAmount ? '' : 'Enter either Total Excl. GST or Total Incl. GST.');
      };
      ex.input.dataset.stageInvoiceRequired = 'false';
      ex.input.addEventListener('input', syncAmounts); total.input.addEventListener('input', syncAmounts); syncAmounts();
      const existingDocument = storedByPurpose.get(`invoice:${invoiceRow.dataset.itemId}`);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn-remove invoice-remove-button'; remove.textContent = '× Remove invoice';
      if (existingDocument || invoiceEditor.hasInvoiceFile(requestedIndex)) {
        remove.disabled = true;
        remove.title = 'Clear the invoice documents first if this invoice should be removed.';
      }
      const details = document.createElement('div'); details.className = 'invoice-admin-details dyn-grid stage-invoice-entry';
      details.append(amountHelp, number.label, ex.label, total.label, remove);
      const attachmentGrid = invoiceRow.querySelector('.invoice-attachment-grid');
      invoiceRow.insertBefore(details, attachmentGrid || null);
      remove.addEventListener('click', () => {
        if (invoiceRows.children.length <= 1 || remove.disabled) return;
        invoiceRow.remove(); syncAdminInvoiceRows();
      });
    };
    if (invoiceEditor && invoiceRows && invoiceDocuments) {
      const initialInvoiceCount = Math.max(invoiceItems.length, invoiceRows.children.length, 1);
      invoiceEditor.syncInvoiceSlots(initialInvoiceCount);
      for (let index = 1; index <= initialInvoiceCount; index++) addAdminInvoice(invoiceItems[index - 1] || {}, index);
      const addInvoiceButton = document.createElement('button'); addInvoiceButton.type = 'button';
      addInvoiceButton.className = 'btn-quiet invoice-add-button stage-invoice-entry';
      addInvoiceButton.textContent = '+ Add another invoice';
      addInvoiceButton.addEventListener('click', () => {
        if (invoiceRows.children.length >= (state.options.max_invoice_items || 100)) { showToast('A request cannot have more than 100 invoices.', 'error'); return; }
        const nextIndex = invoiceRows.children.length + 1;
        invoiceEditor.syncInvoiceSlots(nextIndex);
        addAdminInvoice({}, nextIndex); syncAdminInvoiceRows();
      });
      invoiceDocuments.appendChild(addInvoiceButton);
      syncAdminInvoiceRows();
    }

    const checkPanel = document.createElement('div');
    checkPanel.className = 'invoice-checklist span-2 stage-invoice';
    const checkTitle = document.createElement('h4'); checkTitle.textContent = 'Invoice checklist';
    const checkHelp = document.createElement('p'); checkHelp.className = 'muted';
    checkHelp.textContent = 'All of these must be true before the invoice is sent to Finance.';
    checkPanel.append(checkTitle, checkHelp);
    for (const [name, text] of ADMIN_PROC_CHECKS) {
      const label = document.createElement('label'); label.className = 'checkbox-field';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.name = name; cb.checked = row[name] === 'Yes';
      const span = document.createElement('span'); span.textContent = text;
      label.append(cb, span);
      checkPanel.appendChild(label);
    }
    // Invoice checklist is requester self-check only; Finance sees the resulting invoice data and attachments.
  } else if (row.request_type === 'Supplier Setup') {
    const heading = document.createElement('div'); heading.className = 'form-section-title'; heading.textContent = 'University supplier registration'; extra.appendChild(heading);
    const guidance = document.createElement('p'); guidance.className = 'span-2 muted small'; guidance.textContent = 'After registration is accepted in the University system, enter the Vendor ID and set the request to Approved. The supplier will then appear in Procurement.'; extra.appendChild(guidance);
    const label = document.createElement('label'); label.className = 'stage-supplier-approved';
    const span = document.createElement('span'); span.innerHTML = 'University Vendor ID <span class="req-star">*</span>';
    const input = document.createElement('input'); input.type = 'text'; input.name = 'vendor_id'; input.required = true; input.value = row.vendor_id || '';
    label.append(span, input); extra.appendChild(label);
  }

  buildAdminDetailEditor(row);
  if (row.request_type === 'Procurement') wireGstAmountFields(extra, 'invoice_', row);
  form.elements.note.value = '';
  updateAdminStage(row.current_status, row.request_type, row);

  el('delete-btn').hidden = deleted;
  el('restore-btn').hidden = !deleted;
  // Collapse the destructive menu on every render: leaving Delete request exposed from a
  // previous request is how an accidental click happens.
  el('more-actions').open = false;
  form.querySelectorAll('input, select, textarea, button[type=submit]').forEach((c) => { c.disabled = deleted; });
}

// Finance can correct the requester's own fields in place. Only fields the store accepts
// on update are offered — requester_name decides ownership and is not one of them.
const ADMIN_UNEDITABLE_FIELDS = new Set(['requester_name', 'supplier_form_data']);

function adminEditableFieldNames(row) {
  if (row.request_type === 'Supplier Setup') return [];
  return (SUBTYPE_FIELDS[`${row.request_type}||${row.sub_type}`] || [])
    .filter((name) => !ADMIN_UNEDITABLE_FIELDS.has(name));
}

function buildAdminDetailEditor(row) {
  const box = el('admin-detail-fields');
  const wrap = el('admin-edit-details');
  box.innerHTML = '';

  const names = adminEditableFieldNames(row);
  wrap.hidden = !names.length;
  if (wrap.hidden) return;

  const requiredSet = requiredFieldNamesFor(row.request_type, row.sub_type, row.supplier_type);
  for (const name of names) {
    const field = makeField(name, requiredSet, requestFieldValue(row, name), requestFieldValue(row, `${name}_other`));
    if (field) box.appendChild(field);
  }

  wireActivityCodeRequirement(box, row.request_type, row.sub_type, row.supplier_type);
  const supplierType = box.querySelector('[name=supplier_type]');
  if (supplierType) {
    const sync = () => {
      el('attachments-list').querySelector('.admin-supporting-documents')?.syncSupplierType?.(supplierType.value);
    };
    supplierType.addEventListener('change', sync);
    sync();
  }
}

function updateAdminStage(status, requestType, row = {}) {
  const waiting = (state.options.waiting_on_by_status || {})[status];
  el('upd-waiting-output').textContent = waiting === undefined ? '—' : waitingLabel(waiting);
  const procStatuses = (state.options.statuses_by_type || {}).Procurement || [];
  // Cancelled sits last in the list but is not a later stage. Keep the existing PO visible
  // when one was already issued, while still hiding invoice-stage controls that are not
  // actionable after cancellation.
  const statusIndex = status === 'Cancelled' ? -1 : procStatuses.indexOf(status);
  const poIndex = procStatuses.indexOf(PO_ISSUED_STATUS);
  const invoiceIndex = procStatuses.indexOf(INVOICE_RECEIVED_STATUS);
  const poDocument = document.querySelector('[data-stage-purpose="po"]');
  const hasExistingPo = requestType === 'Procurement'
    && (String(row.po_number || '').trim()
      || parseArr(row.attachments).some((attachment) => attachment && attachment.purpose === 'po' && attachment.stored)
      || !!(poDocument && poDocument.files && poDocument.files.length));
  const showPoFields = statusIndex >= poIndex || (status === 'Cancelled' && hasExistingPo);
  el('admin-extra-fields').querySelectorAll('.stage-po').forEach((node) => { node.hidden = !showPoFields; });
  const poRequired = requestType === 'Procurement' && statusIndex >= poIndex;
  const poNumber = el('admin-extra-fields').querySelector('[name=po_number]');
  if (poNumber) poNumber.required = poRequired;
  const poNumberTitle = poNumber && poNumber.closest('label')?.querySelector(':scope > span');
  if (poNumberTitle) {
    let star = poNumberTitle.querySelector('.stage-req-star');
    if (poRequired && !star) { star = document.createElement('span'); star.className = 'req-star stage-req-star'; star.textContent = ' *'; poNumberTitle.appendChild(star); }
    if (!poRequired && star) star.remove();
  }
  const poDocumentTitle = poDocument && poDocument.closest('label')?.querySelector(':scope > span');
  if (poDocumentTitle) {
    let star = poDocumentTitle.querySelector('.stage-req-star');
    if (poRequired && !star) { star = document.createElement('span'); star.className = 'req-star stage-req-star'; star.textContent = ' *'; poDocumentTitle.appendChild(star); }
    if (!poRequired && star) star.remove();
  }
  document.querySelectorAll('#admin-extra-fields .stage-invoice-entry, #attachments-list .stage-invoice-entry')
    .forEach((node) => { node.hidden = statusIndex < invoiceIndex; });
  const invoiceFieldsRequired = requestType === 'Procurement' && statusIndex >= invoiceIndex;
  document.querySelectorAll('#attachments-list .admin-invoice-number').forEach((input) => {
    input.required = invoiceFieldsRequired;
    const title = input.closest('label')?.querySelector(':scope > span');
    if (!title) return;
    let star = title.querySelector('.stage-req-star');
    if (invoiceFieldsRequired && !star) {
      star = document.createElement('span'); star.className = 'req-star stage-req-star'; star.textContent = ' *'; title.appendChild(star);
    }
    if (!invoiceFieldsRequired && star) star.remove();
  });
  document.querySelectorAll('#attachments-list .admin-invoice-ex').forEach((input) => {
    input.dataset.stageInvoiceRequired = String(invoiceFieldsRequired);
    if (!invoiceFieldsRequired) input.setCustomValidity('');
  });
  el('admin-extra-fields').querySelectorAll('.stage-invoice').forEach((node) => { node.hidden = statusIndex < invoiceIndex; });
  const closeField = el('upd-close-reason-field');
  const closeSelect = closeField?.querySelector('[name=close_reason]');
  const closeTitle = closeField?.querySelector(':scope > span');
  const closeVisible = requestType === 'Procurement' && (status === PROCUREMENT_COMPLETE_STATUS || status === 'Cancelled');
  if (closeField) closeField.hidden = !closeVisible;
  if (closeSelect) closeSelect.required = requestType === 'Procurement' && status === PROCUREMENT_COMPLETE_STATUS;
  if (closeTitle) {
    let star = closeTitle.querySelector('.close-reason-star');
    if (status === PROCUREMENT_COMPLETE_STATUS && !star) {
      star = document.createElement('span'); star.className = 'req-star close-reason-star'; star.textContent = ' *'; closeTitle.appendChild(star);
    }
    if (star) star.hidden = status !== PROCUREMENT_COMPLETE_STATUS;
    if (closeTitle.firstChild) closeTitle.firstChild.textContent = status === 'Cancelled' ? 'Reason to Cancel' : 'Reason to Close';
  }
  // Procurement closing is attributed to the signed-in admin automatically; it is not a
  // separate person-processing step. Travel-family Completed still keeps the processor
  // control because that status has its own business rule.
  const processedStatuses = new Set(['Completed']);
  const travelProcessed = requestType === 'Travel' && status === 'Processed in External System';
  el('upd-processed-field').hidden = requestType === 'Supplier Setup'
    || (!processedStatuses.has(status) && !travelProcessed);
  el('admin-extra-fields').querySelectorAll('.stage-supplier-approved').forEach((node) => {
    node.hidden = requestType !== 'Supplier Setup' || status !== 'Approved';
    const input = node.querySelector('input');
    if (input) input.disabled = node.hidden;
  });
  const returning = requestType === 'Procurement'
    ? status === PROCUREMENT_RETURN_TO_REQUESTOR_STATUS : status === 'Returned for Info';
  const note = el('update-form').elements.note;
  el('upd-note-label').innerHTML = returning
    ? 'Message to user <span class="req-star">*</span> <span class="visibility-badge visibility-public">Visible to user</span>'
    : 'Update note (optional) <span class="visibility-badge visibility-public">Visible to user</span>';
  note.required = returning;
  note.placeholder = returning
    ? 'Clearly explain what is missing, what must be corrected, and what the user should do next.'
    : 'Optional context for this update. It will appear in History and is visible to the user.';
}

function fillNameSelectRaw(sel, values, current) {
  sel.innerHTML = '';
  for (const v of values) sel.appendChild(opt(statusLabel(v), v));
  if (current) sel.value = current;
}

function editDraft(row) {
  closeDetail();
  state.editingDraftId = row.request_id;
  state.editingDraftVersion = row.last_updated_at;
  state.requestCreationGroup = TRAVEL_WORKSPACE_TYPES.has(row.request_type) ? 'travel' : 'finance';
  setTab(requesterTabForType(row.request_type));
  const cf = el('create-form');
  // Supplier Setup is hidden from the new-request picker, but an older draft may still
  // exist. Add its disabled value only while reopening that explicit draft.
  populateRequesterTypeSelect(row.request_type, true);
  cf.request_type.value = row.request_type;
  const subs = (state.options.requester_subtypes || {})[row.request_type] || [];
  cf.sub_type.innerHTML = '';
  for (const sub of subs) cf.sub_type.appendChild(opt(sub, sub));
  cf.sub_type.value = row.sub_type;
  cf.request_type.disabled = true; cf.sub_type.disabled = true;
  el('subtype-field').hidden = subs.length <= 1;
  el('submit-request-btn').textContent = 'Submit draft';
  el('create-msg').textContent = `Editing draft ${row.request_id}`;
  el('create-msg').className = 'msg';
  renderDynamicForm(row);
  // Baseline for the unsaved-changes check, taken after the form is populated.
  state.editorBaseline = JSON.stringify(collectRequestBody());
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function buildRequesterActions(row, history = []) {
  const box = el('requester-actions');
  box.innerHTML = '';
  const show = () => { box.hidden = false; };
  const addNoteAndButton = (intro, buttonText, action, defaultNote) => {
    show();
    const p = document.createElement('p'); p.className = 'info-note';
    p.textContent = intro;
    const ta = document.createElement('textarea'); ta.rows = 4; ta.className = 'long-text-input'; ta.placeholder = 'Optional note…';
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = buttonText;
    const msg = document.createElement('span'); msg.className = 'msg';
    btn.addEventListener('click', () => runRequesterAction(row.request_id, action, { note: ta.value || defaultNote }, msg));
    box.append(p, ta, btn, msg);
  };

  const addSupplierResubmit = () => {
    show();
    const p = document.createElement('p'); p.className = 'info-note';
    p.textContent = 'Finance has returned this supplier request. Correct the details below, save your progress when needed, then resubmit when ready.';
    const fields = document.createElement('div'); fields.className = 'dyn-grid returned-supplier-form';
    renderSupplierFormFields(fields, parseObj(row.supplier_form_data), { subType: row.sub_type });
    const note = document.createElement('textarea'); note.rows = 4; note.className = 'long-text-input'; note.placeholder = 'Response to Finance (optional)…';
    const msg = document.createElement('span'); msg.className = 'msg';
    const attachmentSlot = makeReturnedAttachmentsSlot();
    const returnedUploads = buildReturnedSupportingUploads(row, returnedFromStatus(history));
    const makeBody = (defaultNote = '') => {
      const body = { request_type: row.request_type, supplier_form_data: collectSupplierFormData(fields) };
      const response = note.value.trim();
      if (response || defaultNote) body.note = response || defaultNote;
      return body;
    };
    const persist = async (action, errorTitle, validateBeforeSubmit, defaultNote = '') => {
      msg.textContent = ''; msg.className = 'msg';
      if (validateBeforeSubmit) {
        const invalid = [...fields.querySelectorAll('input, select'), ...returnedUploads.querySelectorAll('input[type=file]')]
          .find((input) => !input.checkValidity());
        if (invalid) { invalid.reportValidity(); return; }
      }
      try {
        const current = await uploadReturnedSupportingFiles(row, returnedUploads);
        await runRequesterAction(row.request_id, action, {
          ...makeBody(defaultNote), _version: current.last_updated_at,
        }, msg, errorTitle);
      } catch (err) {
        renderSubmissionErrors(msg, friendlyErrorItems(err), null, errorTitle);
      }
    };
    const save = document.createElement('button'); save.type = 'button'; save.className = 'btn-secondary'; save.textContent = 'Save draft';
    const resubmit = document.createElement('button'); resubmit.type = 'button'; resubmit.textContent = 'Save corrections and resubmit';
    save.addEventListener('click', () => persist('save-returned', 'We could not save this draft', false));
    resubmit.addEventListener('click', () => persist('resubmit', 'We could not resubmit this request', true, 'Supplier details corrected and resubmitted'));
    const actions = document.createElement('div'); actions.className = 'requester-edit-actions'; actions.append(save, resubmit);
    box.append(p, fields, attachmentSlot, returnedUploads, note, actions, msg);
  };

  if (row.current_status === 'Draft') {
    show();
    const p = document.createElement('p'); p.className = 'info-note';
    p.textContent = 'This draft has not been submitted to Finance. Continue editing to use the same fields, document choices and upload requirements as a new request.';
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Continue editing';
    btn.addEventListener('click', () => editDraft(row));
    const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'btn-danger'; discard.textContent = 'Discard draft';
    discard.addEventListener('click', () => discardDraft(row.request_id));
    const actions = document.createElement('div'); actions.className = 'requester-draft-actions'; actions.append(btn, discard);
    box.append(p, actions);
  } else if (isReturnedStatus(row) && row.request_type === 'Supplier Setup') {
    appendReturnInstructions(box, history);
    addSupplierResubmit();
  } else if (isReturnedStatus(row)) {
    appendReturnInstructions(box, history);
    addReturnedRequestEditor(box, row, show, history);
  } else if (row.request_type === 'Procurement' && row.current_status === PO_ISSUED_STATUS) {
    addInvoiceHandover(box, row, show);
  }
}

// The attachment list and its supporting-document panel are moved into this slot by
// placeDetailBlocks, so on a returned request the documents sit with the fields they
// support instead of above the instructions explaining what to fix.
function makeReturnedAttachmentsSlot() {
  const slot = document.createElement('div');
  slot.id = 'returned-attachments-slot';
  slot.className = 'returned-attachments-slot';
  return slot;
}

// Fields a requester may correct on a returned request. request_type / sub_type decide
// what the request is, requester_name decides who owns it — the server refuses all three.
function requesterEditableFieldNames(row) {
  return (SUBTYPE_FIELDS[`${row.request_type}||${row.sub_type}`] || [])
    .filter((name) => name !== 'requester_name');
}

// The status the request held when Finance sent it back. Recorded as the old_status of the
// return event, so nothing extra has to be stored to know where it came from.
function returnedFromStatus(history) {
  for (let i = (history || []).length - 1; i >= 0; i--) {
    if (isReturnedStatus(history[i].new_status)) return String(history[i].old_status || '');
  }
  return '';
}

// Invoice figures belong to a later step, so they are only offered when the request was
// returned from that step — which is usually returned *because* they are wrong. Mirrors
// STAGE_EDITABLE_FIELDS on the server; the server is the one that enforces it.
const STAGE_EDITABLE_FIELDS = {
  [INVOICE_RECEIVED_STATUS]: [['invoice_items', 'Invoice details', 'text']],
};

function buildReturnedInvoiceEditor(row) {
  const rows = document.createElement('div');
  rows.className = 'returned-invoice-items';
  const items = parseArr(row.invoice_items);
  (items.length ? items : [{}]).forEach((item, offset) => {
    const card = document.createElement('div'); card.className = 'invoice-item dyn-grid returned-invoice-item';
    card.dataset.itemId = stableClientId(item.item_id);
    const title = document.createElement('h4'); title.className = 'invoice-card-title'; title.textContent = `Invoice ${offset + 1}`;
    const help = document.createElement('p'); help.className = 'gst-amount-guidance muted small';
    help.textContent = 'Enter either Total Excl. GST or Total Incl. GST. At least one amount is required.';
    const number = textField('Invoice number', { required: true });
    number.input.required = true; number.input.className = 'returned-invoice-number'; number.input.value = item.invoice_number || '';
    const ex = textField('Total Excl. GST ($)', { type: 'number' });
    ex.input.step = '0.01'; ex.input.min = '0'; ex.input.className = 'returned-invoice-ex'; ex.input.value = item.amount_ex_gst || '';
    const total = textField('Total Incl. GST ($)', { type: 'number' });
    total.input.step = '0.01'; total.input.min = '0'; total.input.className = 'returned-invoice-total'; total.input.value = item.amount_inc_gst || '';
    const syncAmounts = () => {
      const hasAmount = !!ex.input.value.trim() || !!total.input.value.trim();
      ex.input.setCustomValidity(hasAmount ? '' : 'Enter either Total Excl. GST or Total Incl. GST.');
    };
    ex.input.addEventListener('input', syncAmounts); total.input.addEventListener('input', syncAmounts); syncAmounts();
    card.append(title, help, number.label, ex.label, total.label);
    rows.appendChild(card);
  });
  return rows;
}

function collectReturnedInvoiceItems(rows) {
  return [...rows.children].map((card) => ({
    item_id: card.dataset.itemId,
    invoice_number: card.querySelector('.returned-invoice-number').value.trim(),
    amount_ex_gst: card.querySelector('.returned-invoice-ex').value.trim(),
    amount_inc_gst: card.querySelector('.returned-invoice-total').value.trim(),
  }));
}

// Finance returns a request because something in it is wrong, so this panel offers the
// same fields the requester filled in, pre-filled, rather than only a comment box.
function addReturnedRequestEditor(box, row, show, history) {
  show();
  const isReimbursement = row.request_type === 'Reimbursement';
  const returnedFrom = returnedFromStatus(history);
  const p = document.createElement('p'); p.className = 'info-note';
  p.textContent = returnedFrom
    ? `Correct the details below, replace or add any documents Finance asked for, save your progress when needed, then resubmit. Finance returned this from the "${returnedFrom}" step.`
    : 'Correct the details below, replace or add any documents Finance asked for, save your progress when needed, then resubmit.';
  box.appendChild(p);

  const names = requesterEditableFieldNames(row);
  const fields = document.createElement('div'); fields.className = 'dyn-grid returned-request-form';
  const requiredSet = requiredFieldNamesFor(row.request_type, row.sub_type, row.supplier_type);
  for (const name of names) {
    const field = makeField(name, requiredSet, requestFieldValue(row, name), requestFieldValue(row, `${name}_other`));
    if (field) fields.appendChild(field);
  }
  wireActivityCodeRequirement(fields, row.request_type, row.sub_type, row.supplier_type);
  const supplierType = fields.querySelector('[name=supplier_type]');
  if (fields.children.length) box.appendChild(fields);
  if (row.request_type === 'Procurement') wireGstAmountFields(fields, '', row);

  // Fields belonging to the step the request was returned from.
  const stageSpecs = STAGE_EDITABLE_FIELDS[returnedFrom] || [];
  let stageFields = null;
  let returnedInvoiceRows = null;
  if (stageSpecs.length) {
    stageFields = document.createElement('div');
    stageFields.className = 'dyn-grid returned-request-form returned-stage-fields';
    const heading = document.createElement('h4');
    heading.textContent = `${returnedFrom} details`;
    heading.className = 'span-2';
    stageFields.appendChild(heading);
    for (const [name, label, kind] of stageSpecs) {
      if (name === 'invoice_items') {
        returnedInvoiceRows = buildReturnedInvoiceEditor(row);
        stageFields.appendChild(returnedInvoiceRows);
        continue;
      }
      let control;
      if (kind === 'gst-mode') {
        control = document.createElement('select');
        control.append(opt('— select —', ''), opt('Total includes GST', 'Total includes GST'), opt('Enter GST separately', 'Enter GST separately'));
      } else {
        control = document.createElement('input');
        control.type = kind === 'number' ? 'number' : 'text';
        if (kind === 'number') { control.step = '0.01'; control.min = '0'; }
      }
      control.name = name;
      control.value = row[name] == null ? '' : row[name];
      stageFields.appendChild(labelledControl(label, control).label);
    }
    box.appendChild(stageFields);
    wireGstAmountFields(stageFields, 'invoice_', row);
  }

  // Expense lines: values and receipts can be corrected, but lines cannot be added or
  // removed — receipts are stored against each line's stable item UUID.
  let lineBody = null; let lineTotal = null;
  if (isReimbursement) {
    const items = parseArr(row.reimbursement_items);
    const wrap = document.createElement('div'); wrap.className = 'returned-lines';
    const heading = document.createElement('h4'); heading.textContent = 'Expense lines';
    const hint = document.createElement('p'); hint.className = 'muted small';
    hint.textContent = 'Lines cannot be added or removed here. Ask Finance to reopen the request if the number of lines must change.';
    const wrapper = document.createElement('div'); wrapper.className = 'table-wrap';
    const table = document.createElement('table'); table.className = 'reimbursement-table';
    // Same columns addLineRow emits, in the same order as the intake form's table.
    table.innerHTML = '<thead><tr><th>Category</th><th>Total Excl. GST ($)</th><th>Total Incl. GST ($)</th>'
      + '<th>Description</th><th>Receipt <span class="req-star">*</span></th><th></th></tr></thead>';
    lineBody = document.createElement('tbody');
    table.appendChild(lineBody); wrapper.appendChild(table);
    const totalWrap = document.createElement('div'); totalWrap.className = 'line-total-wrap';
    lineTotal = document.createElement('span'); lineTotal.className = 'line-total';
    const totalNote = document.createElement('span');
    totalNote.className = 'line-total-note';
    totalNote.textContent = 'Calculated from all expense lines. If a line has both amounts, its Total Incl. GST is used; otherwise its Total Excl. GST is used.';
    totalWrap.append(lineTotal, totalNote);
    wrap.append(heading, hint, wrapper, totalWrap);
    box.appendChild(wrap);
    for (const item of items) addLineRow(item, { tbody: lineBody, total: lineTotal, allowRemove: false });
  }

  const attachmentSlot = makeReturnedAttachmentsSlot();
  const returnedUploads = buildReturnedSupportingUploads(row, returnedFrom, supplierType);
  box.append(attachmentSlot, returnedUploads);

  const note = document.createElement('textarea'); note.rows = 4; note.className = 'long-text-input';
  note.placeholder = 'Response to Finance (optional)…';
  const msg = document.createElement('span'); msg.className = 'msg';
  const makeBody = (defaultNote = '') => {
    const body = { request_type: row.request_type };
    const response = note.value.trim();
    if (response || defaultNote) body.note = response || defaultNote;
    for (const control of fields.querySelectorAll('[name]')) body[control.name] = control.value;
    if (stageFields) for (const control of stageFields.querySelectorAll('[name]')) body[control.name] = control.value;
    if (returnedInvoiceRows) body.invoice_items = collectReturnedInvoiceItems(returnedInvoiceRows);
    if (lineBody) body.reimbursement_items = collectLineItems(lineBody);
    return body;
  };
  const persist = async (action, errorTitle, validateBeforeSubmit, defaultNote = '') => {
    msg.textContent = ''; msg.className = 'msg';
    if (validateBeforeSubmit) {
      const invalid = [...fields.querySelectorAll('input, select, textarea'),
        ...(stageFields ? stageFields.querySelectorAll('input, select, textarea') : []),
        ...returnedUploads.querySelectorAll('input[type=file]')]
        .filter((control) => !control.disabled && !control.closest('[hidden]') && !control.checkValidity());
      if (invalid.length) {
        const items = invalid.map((control) => `${controlLabel(control)} — ${controlValidationHelp(control)}`);
        renderSubmissionErrors(msg, items, invalid[0], errorTitle);
        invalid.forEach((control) => { control.classList.add('field-error'); control.setAttribute('aria-invalid', 'true'); });
        return;
      }
    }
    try {
      const current = await uploadReturnedRequestFiles(row, returnedUploads, lineBody);
      await runRequesterAction(row.request_id, action, {
        ...makeBody(defaultNote), _version: current.last_updated_at,
      }, msg, errorTitle);
    } catch (err) {
      renderSubmissionErrors(msg, friendlyErrorItems(err), null, errorTitle);
    }
  };
  const save = document.createElement('button'); save.type = 'button'; save.className = 'btn-secondary'; save.textContent = 'Save draft';
  const resubmit = document.createElement('button'); resubmit.type = 'button'; resubmit.textContent = 'Save corrections and resubmit';
  save.addEventListener('click', () => persist('save-returned', 'We could not save this draft', false));
  resubmit.addEventListener('click', () => persist('resubmit', 'We could not resubmit this request', true, 'Updated and resubmitted'));
  const actions = document.createElement('div'); actions.className = 'requester-edit-actions'; actions.append(save, resubmit);
  box.append(note, actions, msg);
}

function appendReturnInstructions(box, history) {
  const event = [...history].reverse().find((item) => isReturnedStatus(item.new_status));
  const panel = document.createElement('section'); panel.className = 'return-instructions';
  const title = document.createElement('strong'); title.textContent = 'What Finance needs from you';
  const message = document.createElement('p');
  message.textContent = (event && String(event.note || '').trim())
    || 'Finance did not provide instructions. Contact Finance before resubmitting.';
  panel.append(title, message); box.appendChild(panel);
}

// Keep the attachment relationship visible instead of relying on the order of a flat grid:
// every invoice owns one bordered group containing its required invoice file, its optional
// Other Documents and the add button for that same invoice.
function buildInvoiceDocumentGroup(index, documentField, otherDocuments, titleText = `Invoice ${index}`) {
  const group = document.createElement('section');
  group.className = 'invoice-document-group invoice-attachment-section';
  group.dataset.invoiceIndex = String(index);
  const title = document.createElement('h5');
  title.className = 'invoice-document-title';
  title.textContent = titleText;
  const grid = document.createElement('div');
  grid.className = 'invoice-attachment-grid';
  grid.append(documentField, otherDocuments.slots);
  group.append(title, grid, otherDocuments.addButton);
  return group;
}

function buildApprovalDocumentSection(approval, otherDocuments) {
  const section = document.createElement('section');
  section.className = 'invoice-approval-section';
  const title = document.createElement('h5');
  title.className = 'attachment-subsection-title';
  title.textContent = 'Approval documents';
  const grid = document.createElement('div');
  grid.className = 'invoice-attachment-grid invoice-approval-grid';
  grid.append(approval.label, otherDocuments.slots);
  section.append(title, grid, otherDocuments.addButton);
  return section;
}

// Optional files belong to an individual invoice, not to the request as a whole. Stable
// IDs keep that relationship intact even if a preceding invoice is removed.
function buildRepeatableInvoiceDocuments({
  groupId, storedByPurpose, purposeDatasetKey, purposePattern, documentIdFromPurpose, purposeFor,
}) {
  const slots = document.createElement('div');
  slots.className = 'invoice-other-document-slots';
  const existing = [...storedByPurpose.values()]
    .filter((attachment) => attachment && purposePattern.test(attachment.purpose));
  let activeGroupId = groupId;

  const setPurpose = (input, purpose) => { input.dataset[purposeDatasetKey] = purpose; };
  const sync = (currentGroupId = activeGroupId) => {
    activeGroupId = currentGroupId;
    [...slots.children].forEach((slot, offset) => {
      const input = slot.querySelector('input[type=file]');
      const purpose = slot.dataset.storedPurpose
        || purposeFor(currentGroupId, slot.dataset.documentId);
      setPurpose(input, purpose);
      const title = input.closest('label')?.querySelector(':scope > span');
      if (title?.firstChild) title.firstChild.textContent = `Other document ${offset + 1}`;
    });
  };
  const addSlot = (stored) => {
    const documentId = stored ? documentIdFromPurpose(stored.purpose) : stableClientId();
    const slot = document.createElement('div'); slot.className = 'invoice-other-document-slot';
    slot.dataset.documentId = documentId;
    if (stored) slot.dataset.storedPurpose = stored.purpose;
    const field = fileField('Other document', { stored });
    field.label.classList.add('invoice-other-document-field');
    slot.appendChild(field.label);
    if (!stored) {
      const remove = document.createElement('button'); remove.type = 'button';
      remove.className = 'btn-remove invoice-other-remove'; remove.textContent = '× Remove document';
      remove.addEventListener('click', () => {
        slot.remove();
        sync(activeGroupId);
      });
      slot.appendChild(remove);
    }
    slots.appendChild(slot);
    sync();
  };
  existing.forEach(addSlot);
  const addButton = document.createElement('button'); addButton.type = 'button';
  addButton.className = 'btn-quiet invoice-other-add'; addButton.textContent = '+ Add other document';
  addButton.addEventListener('click', () => addSlot());
  return { slots, addButton, sync };
}

function buildInvoiceOtherDocuments(invoiceId, storedByPurpose, purposeDatasetKey) {
  return buildRepeatableInvoiceDocuments({
    groupId: invoiceId,
    storedByPurpose,
    purposeDatasetKey,
    purposePattern: new RegExp(`^invoice_other:${invoiceId}:${UUID_SOURCE}$`, 'i'),
    documentIdFromPurpose: (purpose) => purpose.split(':')[2],
    purposeFor: (currentInvoiceId, documentId) => `invoice_other:${currentInvoiceId}:${documentId}`,
  });
}

function buildApprovalOtherDocuments(storedByPurpose, purposeDatasetKey) {
  return buildRepeatableInvoiceDocuments({
    groupId: '',
    storedByPurpose,
    purposeDatasetKey,
    purposePattern: new RegExp(`^invoice_approval_other:${UUID_SOURCE}$`, 'i'),
    documentIdFromPurpose: (purpose) => purpose.split(':')[1],
    purposeFor: (_groupId, documentId) => `invoice_approval_other:${documentId}`,
  });
}

// The single place a supplier invoice is handed to Finance: both documents, the invoice
// number and total, and the checklist — all gated together so a half-finished handover
// cannot reach Finance. These documents are deliberately separated from the intake
// evidence above. The PO-stage editor itself is a requester work area, so every field is
// allowed to remain incomplete while the requester saves a draft; the send action below
// performs the complete handover validation.
function addInvoiceHandover(box, row, show) {
  show();
  const storedByPurpose = new Map(parseArr(row.attachments).filter((a) => a && a.stored).map((a) => [a.purpose, a]));
  const stored = new Set(storedByPurpose.keys());
  const invoiceItems = parseArr(row.invoice_items);
  const p = document.createElement('p'); p.className = 'info-note';
  p.textContent = 'PO Issued means Finance is waiting for you to provide the invoice details. You can save an incomplete draft; each invoice, one GST total, its file, the approval email and the checks are required before sending to Finance.';
  const invoiceRows = document.createElement('div'); invoiceRows.className = 'invoice-items';
  const syncInvoiceRows = () => {
    [...invoiceRows.children].forEach((invoiceRow, offset) => {
      const index = offset + 1;
      const cardTitle = invoiceRow.querySelector('.invoice-card-title');
      const numberTitle = invoiceRow.querySelector('.invoice-item-number')?.closest('label')?.querySelector(':scope > span');
      const file = invoiceRow.querySelector('.invoice-document-field input[type=file]');
      const fileTitle = file?.closest('label')?.querySelector(':scope > span');
      if (cardTitle) cardTitle.textContent = `Invoice ${index}`;
      if (numberTitle?.firstChild) numberTitle.firstChild.textContent = 'Invoice number';
      if (fileTitle?.firstChild) fileTitle.firstChild.textContent = 'Invoice file';
      if (invoiceRow.syncInvoiceOtherDocuments) invoiceRow.syncInvoiceOtherDocuments(invoiceRow.dataset.itemId);
    });
  };
  const addInvoice = (item = {}) => {
    const index = invoiceRows.children.length + 1;
    const itemId = stableClientId(item.item_id);
    // These controls are required for the final handover, not for an incomplete PO-stage
    // draft. The send path below owns the validation so Save draft remains usable.
    const number = textField('Invoice number'); number.input.value = item.invoice_number || '';
    number.input.className = 'invoice-item-number';
    number.label.classList.add('invoice-number-field');
    const ex = textField('Total Excl. GST ($)', { type: 'number' }); ex.input.value = item.amount_ex_gst || '';
    ex.input.className = 'invoice-item-ex';
    const total = textField('Total Incl. GST ($)', { type: 'number' }); total.input.value = item.amount_inc_gst || '';
    total.input.className = 'invoice-item-total';
    const existingDocument = storedByPurpose.get(`invoice:${itemId}`);
    const doc = fileField('Invoice file', { stored: existingDocument });
    doc.input.dataset.invoicePurpose = `invoice:${itemId}`;
    doc.label.classList.add('invoice-document-field');
    const otherDocuments = buildInvoiceOtherDocuments(itemId, storedByPurpose, 'invoicePurpose');
    const attachmentSection = buildInvoiceDocumentGroup(index, doc.label, otherDocuments, `Invoice ${index} documents`);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn-remove invoice-remove-button'; remove.textContent = '× Remove invoice';
    const amountHelp = document.createElement('p'); amountHelp.className = 'gst-amount-guidance muted small span-2';
    amountHelp.textContent = 'Enter either Total Excl. GST or Total Incl. GST. At least one amount is required.';
    const wrap = document.createElement('div'); wrap.className = 'invoice-item dyn-grid';
    wrap.dataset.itemId = itemId;
    wrap.syncInvoiceOtherDocuments = otherDocuments.sync;
    const cardTitle = document.createElement('h4'); cardTitle.className = 'invoice-card-title'; cardTitle.textContent = `Invoice ${index}`;
    wrap.append(cardTitle, amountHelp, number.label, ex.label, total.label, attachmentSection, remove);
    remove.disabled = !!existingDocument;
    if (existingDocument) remove.title = 'Replace the uploaded file if it is incorrect. An uploaded invoice cannot be removed from the middle of the set.';
    remove.addEventListener('click', () => { if (invoiceRows.children.length > 1) { wrap.remove(); syncInvoiceRows(); } });
    invoiceRows.appendChild(wrap);
    syncInvoiceRows();
  };
  (invoiceItems.length ? invoiceItems : [{}]).forEach(addInvoice);
  const addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'btn-quiet invoice-add-button'; addBtn.textContent = '+ Add another invoice';
  addBtn.addEventListener('click', () => {
    if (invoiceRows.children.length >= (state.options.max_invoice_items || 100)) { showToast('A request cannot have more than 100 invoices.', 'error'); return; }
    addInvoice();
  });
  const approval = fileField('Invoice approval email', { stored: storedByPurpose.get('invoice_approval_email') });
  approval.label.classList.add('invoice-approval-field');
  approval.input.dataset.invoicePurpose = 'invoice_approval_email';
  const approvalOtherDocuments = buildApprovalOtherDocuments(storedByPurpose, 'invoicePurpose');
  const approvalSection = buildApprovalDocumentSection(approval, approvalOtherDocuments);

  const checks = ADMIN_PROC_CHECKS.map(([name, text]) => {
    const label = document.createElement('label'); label.className = 'checkbox-field';
    const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.name = name;
    input.checked = row[name] === 'Yes';
    label.append(input, document.createTextNode(text));
    return { label, input, name };
  });

  const note = document.createElement('textarea'); note.rows = 4; note.className = 'long-text-input'; note.placeholder = 'Optional note…';
  const msg = document.createElement('span'); msg.className = 'msg';
  const send = document.createElement('button'); send.type = 'button'; send.textContent = 'Send invoice to Finance';
  // The workflow refuses to move past PO Issued unless the PO document is on the record,
  // and only Finance can upload it. Without this the requester fills the whole panel in
  // and is refused by a rule they have no way to satisfy.
  let blocked = null;
  if (!stored.has('po')) {
    send.disabled = true;
    blocked = document.createElement('p');
    blocked.className = 'info-note info-note-blocked';
    blocked.textContent = 'Finance has not attached the purchase order document to this request yet, and the invoice cannot be sent to them until it is there. Ask Finance to upload the PO document, then come back to this panel.';
  }
  const collectInvoiceData = () => [...invoiceRows.children].map((wrap) => ({
    item_id: wrap.dataset.itemId,
    invoice_number: wrap.querySelector('.invoice-item-number').value.trim(),
    amount_ex_gst: wrap.querySelector('.invoice-item-ex').value.trim(),
    amount_inc_gst: wrap.querySelector('.invoice-item-total').value.trim(),
  }));
  const persist = async (action, errorTitle, validateBeforeSend) => {
    msg.textContent = ''; msg.className = 'msg';
    if (validateBeforeSend) {
      // Collect every problem rather than stopping at the first: being told about one
      // missing thing at a time is what makes a long panel like this feel like a maze.
      const problems = [];
      let firstBad = null;
      const flag = (control, text) => { problems.push(text); if (!firstBad) firstBad = control; };
      for (const [i, wrap] of [...invoiceRows.children].entries()) {
        const number = wrap.querySelector('.invoice-item-number');
        const ex = wrap.querySelector('.invoice-item-ex');
        const total = wrap.querySelector('.invoice-item-total');
        const file = wrap.querySelector('.invoice-document-field input[type=file]');
        if (!number.value.trim()) flag(number, `Invoice ${i + 1} number — enter the invoice number.`);
        if (!ex.value.trim() && !total.value.trim()) flag(ex, `Invoice ${i + 1} — enter either Total Excl. GST or Total Incl. GST.`);
        if (!(file.files && file.files.length) && !storedByPurpose.has(`invoice:${wrap.dataset.itemId}`)) flag(file, `Invoice ${i + 1} attachment — upload the invoice.`);
      }
      if (!(approval.input.files && approval.input.files.length) && !storedByPurpose.has('invoice_approval_email')) flag(approval.input, 'Invoice approval email — upload the email.');
      for (const c of checks) {
        if (!c.input.checked) flag(c.input, `${c.label.textContent.trim()} — tick this confirmation before sending.`);
      }
      if (problems.length) {
        renderSubmissionErrors(msg, problems, firstBad, errorTitle);
        return;
      }
    }
    try {
      let current = { ...row, last_updated_at: state.selectedVersion || row.last_updated_at };
      const invoiceData = collectInvoiceData();
      if (JSON.stringify(parseArr(current.invoice_items)) !== JSON.stringify(invoiceData)) {
        current = await api(`/api/requests/${encodeURIComponent(row.request_id)}/save-invoice-progress`, {
          method: 'POST',
          body: JSON.stringify({ invoice_items: invoiceData, _version: current.last_updated_at }),
        });
      }
      for (const input of invoiceRows.querySelectorAll('input[type=file][data-invoice-purpose]')) {
        if (input.files && input.files.length) current = await uploadOne(row.request_id, input.dataset.invoicePurpose, input.files[0], current.last_updated_at);
      }
      for (const input of approvalSection.querySelectorAll('input[type=file][data-invoice-purpose]')) {
        if (input.files && input.files.length) current = await uploadOne(row.request_id, input.dataset.invoicePurpose, input.files[0], current.last_updated_at);
      }
      const body = {
        invoice_items: invoiceData,
        note: note.value, _version: current.last_updated_at,
      };
      for (const c of checks) body[c.name] = c.input.checked ? 'Yes' : 'No';
      await runRequesterAction(row.request_id, action, body, msg, errorTitle);
    } catch (err) {
      renderSubmissionErrors(msg, friendlyErrorItems(err), null, errorTitle);
    }
  };
  const save = document.createElement('button'); save.type = 'button'; save.className = 'btn-secondary'; save.textContent = 'Save draft';
  save.addEventListener('click', () => persist('save-invoice-progress', 'We could not save this draft', false));
  send.addEventListener('click', () => persist('invoice-received', 'We could not send this invoice to Finance', true));

  const grid = document.createElement('div'); grid.className = 'invoice-editor-layout';
  grid.append(invoiceRows, addBtn, approvalSection);
  wireGstAmountFields(grid, 'invoice_', row);

  // Same treatment as the intake documents on the new-request form: a titled panel with
  // its own explanation, rather than two file inputs trailing the amount fields.
  const docBox = document.createElement('div');
  docBox.className = 'dyn-grid document-upload-session';
  const docTitle = document.createElement('h4');
  docTitle.textContent = 'Invoice documents';
  const docHelp = document.createElement('p');
  docHelp.className = 'muted';
  docHelp.textContent = 'Upload the supplier invoice and the email in which the spending approver approved paying it. Selected files upload when you save or send.';
  docBox.append(docTitle, docHelp, grid);

  const checkBox = document.createElement('div');
  checkBox.className = 'invoice-checklist';
  const checkTitle = document.createElement('h4');
  checkTitle.textContent = 'Confirm before sending to Finance';
  const checkHelp = document.createElement('p');
  checkHelp.className = 'muted';
  checkHelp.textContent = 'Finance cannot pay the invoice until each of these is true. Tick every item.';
  checkBox.append(checkTitle, checkHelp, ...checks.map((c) => c.label));

  const actions = document.createElement('div'); actions.className = 'requester-edit-actions'; actions.append(save, send);
  box.append(p, ...(blocked ? [blocked] : []), docBox, checkBox, note, actions, msg);
}

function labelledControl(text, control, required) {
  const label = document.createElement('label');
  const span = document.createElement('span'); span.textContent = text;
  if (required) { const star = document.createElement('span'); star.className = 'req-star'; star.textContent = ' *'; span.appendChild(star); }
  label.append(span, control);
  return { label, input: control };
}

function textField(text, options = {}) {
  const input = document.createElement('input');
  input.type = options.type || 'text';
  return labelledControl(text, input, options.required);
}

// A labelled file input. `replaces` marks a document that is already on file, so leaving
// the picker empty keeps what is there instead of looking like a missed field.
function fileField(text, options = {}) {
  const input = configureFileInput(document.createElement('input')); input.type = 'file';
  input.required = !!options.required && !options.stored;
  const field = labelledControl(text, input, options.required);
  // `stored` shows which file is actually held, so the slot does not look empty; without
  // it the only clue was a hint saying something had been uploaded, with no name.
  if (options.stored) {
    const storedRow = Object.prototype.hasOwnProperty.call(options, 'storedRow')
      ? options.storedRow : makeStoredDocRow(options.stored);
    if (storedRow) field.label.insertBefore(storedRow, input);
    const hint = document.createElement('span'); hint.className = 'file-replace-hint';
    hint.textContent = 'Choose a file only if you want to replace the one above.';
    field.label.insertBefore(hint, input);
  }
  field.label.appendChild(makeFileClearControl(input));
  return field;
}

// The stored file for one document slot: name, size and a link to open it.
function makeStoredDocRow(attachment) {
  const row = document.createElement('span');
  row.className = 'attachment-uploaded';
  const tick = document.createElement('span');
  tick.className = 'attachment-uploaded-tick'; tick.setAttribute('aria-hidden', 'true'); tick.textContent = '✓';
  row.appendChild(tick);
  if (attachment.stored) {
    const link = document.createElement('a');
    link.className = 'attachment-uploaded-name';
    link.href = '/api/uploads/' + encodeURIComponent(attachment.stored);
    link.target = '_blank';
    link.textContent = attachment.filename || 'Uploaded file';
    link.title = link.textContent;
    row.appendChild(link);
  } else {
    const name = document.createElement('span');
    name.className = 'attachment-uploaded-name';
    name.textContent = attachment.filename || 'Uploaded file';
    row.appendChild(name);
  }
  if (attachment.size) {
    const size = document.createElement('span');
    size.className = 'muted small'; size.textContent = `${Math.round(attachment.size / 1024)} KB`;
    row.appendChild(size);
  }
  return row;
}

// msgHost matters: #update-msg lives inside the admin form, which is hidden for
// requesters — without somewhere visible to report to, a rejected action looks like
// nothing happened at all.
async function runRequesterAction(id, action, body, msgHost, errorTitle = 'We could not complete this action') {
  try {
    const payload = { ...(body || {}) };
    if (!payload._version) payload._version = state.selectedVersion;
    const result = await api(`/api/requests/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(payload) });
    if (result && result.pending_sync) {
      const msg = msgHost || el('update-msg');
      msg.textContent = 'Saved temporarily. It will synchronise when the database is available.';
      msg.className = 'msg ok';
      return true;
    }
    await loadRequests();
    await openDetail(id);
    return true;
  } catch (err) {
    const msg = msgHost || el('update-msg');
    if (msgHost) renderSubmissionErrors(msg, friendlyErrorItems(err), null, errorTitle);
    else { msg.textContent = formatErr(err); msg.className = 'msg err'; }
    return false;
  }
}

async function onUpdate(e) {
  e.preventDefault();
  const id = state.selectedId;
  if (!id) return;
  const msg = el('update-msg'); msg.textContent = ''; msg.className = 'msg';
  el('update-alert').hidden = true; el('update-alert').replaceChildren();
  const form = e.target;
  const body = { _version: state.selectedVersion };
  form.querySelectorAll('[name]').forEach((c) => {
    if (c.type === 'checkbox') body[c.name] = c.checked ? 'Yes' : 'No';
    else body[c.name] = c.value;
  });
  el('admin-extra-fields').querySelectorAll('[name]').forEach((c) => {
    if (c.type === 'checkbox') body[c.name] = c.checked ? 'Yes' : 'No';
    else body[c.name] = c.value;
  });
  const adminInvoiceRows = [...el('attachments-list').querySelectorAll('.invoice-admin-editor .invoice-document-group')];
  if (adminInvoiceRows.length || el('attachments-list').querySelector('.invoice-admin-editor')) {
    body.invoice_items = adminInvoiceRows.map((invoiceRow) => ({
      item_id: invoiceRow.dataset.itemId,
      invoice_number: invoiceRow.querySelector('.admin-invoice-number').value.trim(),
      amount_ex_gst: invoiceRow.querySelector('.admin-invoice-ex').value.trim(),
      amount_inc_gst: invoiceRow.querySelector('.admin-invoice-total').value.trim(),
    }));
  }
  const selected = state.requests.find((request) => request.request_id === id);
  if (selected && body.current_status === returnStatusFor(selected)
      && body.current_status !== selected.current_status && !String(body.note || '').trim()) {
    const note = form.elements.note;
    msg.textContent = 'Add a message explaining what is missing and what the user needs to do.';
    msg.className = 'msg err';
    note.focus();
    return;
  }
  if (selected && selected.request_type === 'Procurement' && body.current_status !== 'Cancelled') {
    const procurementStatuses = (state.options.statuses_by_type || {}).Procurement || [];
    const targetIndex = procurementStatuses.indexOf(body.current_status);
    const poIndex = procurementStatuses.indexOf(PO_ISSUED_STATUS);
    const invoiceIndex = procurementStatuses.indexOf(INVOICE_RECEIVED_STATUS);
    if (targetIndex >= poIndex) {
      const poNumber = el('admin-extra-fields').querySelector('[name=po_number]');
      const poFile = document.querySelector('[data-stage-purpose="po"]');
      const storedPo = parseArr(selected.attachments).some((a) => a && a.purpose === 'po' && a.stored);
      if (!String(body.po_number || '').trim()) {
        msg.textContent = 'PO number is required when the status is PO issued to user.';
        msg.className = 'msg err'; if (poNumber) poNumber.focus(); return;
      }
      if (!storedPo && !(poFile && poFile.files && poFile.files.length)) {
        msg.textContent = 'Purchase order document is required when the status is PO issued to user.';
        msg.className = 'msg err'; if (poFile) poFile.focus(); return;
      }
    }
    if (targetIndex >= invoiceIndex) {
      const approvalFile = document.querySelector('[data-purpose="invoice_approval_email"]');
      const storedApproval = parseArr(selected.attachments).some((a) => a && a.purpose === 'invoice_approval_email' && a.stored);
      if (!body.invoice_items.length) {
        msg.textContent = `Add at least one invoice before setting the status to ${INVOICE_RECEIVED_STATUS}.`;
        msg.className = 'msg err'; return;
      }
      if (!storedApproval && !(approvalFile && approvalFile.files && approvalFile.files.length)) {
        msg.textContent = `Invoice approval email is required before setting the status to ${INVOICE_RECEIVED_STATUS}.`;
        msg.className = 'msg err'; if (approvalFile) approvalFile.focus(); return;
      }
    }
  }
  if (selected && selected.request_type === 'Supplier Setup' && body.current_status === 'Approved'
      && !String(body.vendor_id || '').trim()) {
    const vendorId = el('admin-extra-fields').querySelector('[name=vendor_id]');
    msg.textContent = 'Enter the University Vendor ID before approving this supplier setup.';
    msg.className = 'msg err';
    if (vendorId) vendorId.focus();
    return;
  }
  const invalid = [...form.querySelectorAll('input, select, textarea')]
    .find((control) => !control.disabled && !control.closest('[hidden]') && !control.checkValidity());
  if (invalid) {
    msg.textContent = `${controlLabel(invalid)} is required before this update can be saved.`;
    msg.className = 'msg err'; invalid.focus(); return;
  }
  // The status this screen was built from. The uploads below legitimately move the
  // version forward, which is exactly what used to let a stale screen through the
  // optimistic lock, so the server checks this separately from _version.
  body._from_status = (selected && selected.current_status) || '';
  try {
    // Files go through the attachments endpoint, which bumps the row version — so the
    // field patch must carry the version the last upload returned. Each upload presents
    // the version before it, so a row that moved on is refused at the first upload.
    const uploadInputs = [...el('attachments-list').querySelectorAll('.admin-attachment-editor input[type=file][data-purpose]')];
    const currentInvoiceItems = JSON.stringify(parseArr(selected && selected.invoice_items));
    const nextInvoiceItems = JSON.stringify(body.invoice_items || []);
    const hasInvoiceUpload = uploadInputs.some((input) => new RegExp(`^invoice:${UUID_SOURCE}$`, 'i').test(input.dataset.purpose || '')
      && input.files && input.files.length);
    if (selected && hasInvoiceUpload && currentInvoiceItems !== nextInvoiceItems) {
      const staged = await api(`/api/requests/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          invoice_items: body.invoice_items,
          current_status: selected.current_status,
          _version: body._version,
          _from_status: selected.current_status,
        }),
      });
      body._version = staged.last_updated_at;
    }
    for (const input of uploadInputs) {
      if (!input.files || !input.files.length) continue;
      msg.textContent = `Uploading ${input.files[0].name}…`;
      const uploaded = await uploadOne(id, input.dataset.purpose, input.files[0], body._version);
      body._version = uploaded.last_updated_at;
    }
    await api(`/api/requests/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    msg.textContent = 'Saved.'; msg.className = 'msg ok';
    await loadRequests();
    await openDetail(id);
    el('update-msg').textContent = '✓ Update saved successfully'; el('update-msg').className = 'msg ok save-confirmation';
  } catch (err) {
    if (err.status === 409) return recoverFromConflict(id, err, body);
    msg.textContent = formatErr(err); msg.className = 'msg err';
  }
}

// A conflict means someone else moved this request while it was open. Reload it so the
// admin is looking at the truth, then hand back the text they had typed — except the
// status, which is reset to the stored one so a second save cannot repeat the overwrite.
async function recoverFromConflict(id, err, attempted) {
  const keep = { ...attempted };
  delete keep._version; delete keep._from_status; delete keep.current_status;
  const before = state.requests.find((r) => r.request_id === id) || {};
  try {
    await loadRequests();
    await openDetail(id);
  } catch (reloadErr) {
    const msg = el('update-msg');
    msg.textContent = `${formatErr(err)} (reloading the request also failed: ${formatErr(reloadErr)})`;
    msg.className = 'msg err';
    return;
  }
  const after = state.requests.find((r) => r.request_id === id) || {};
  const form = el('update-form');
  for (const [name, value] of Object.entries(keep)) {
    // Only put back a field nobody else touched. Where the stored value moved while this
    // screen was open, the reloaded value stands — otherwise saving again would quietly
    // revert someone else's correction, which is the whole failure being fixed here.
    if (String(before[name] == null ? '' : before[name]) !== String(after[name] == null ? '' : after[name])) continue;
    const control = form.querySelector(`[name="${name}"]`);
    if (!control) continue;
    if (control.type === 'checkbox') control.checked = value === 'Yes';
    else control.value = value;
  }
  // Rendered above the fields, not in the sticky action bar: a tall message there
  // stretches the bar and pulls "Delete request" up next to where the admin is clicking.
  const alert = el('update-alert');
  alert.replaceChildren();
  const title = document.createElement('strong'); title.textContent = 'Not saved — this request changed while you had it open';
  const detail = document.createElement('p'); detail.textContent = formatErr(err);
  const help = document.createElement('p');
  help.textContent = 'The panel now shows the current state. Your edits have been put back, except the status and any field someone else changed — check what moved, then save again.';
  alert.append(title, detail, help);
  alert.hidden = false;
  const msg = el('update-msg');
  msg.textContent = 'Not saved — see the message at the top of this panel.';
  msg.className = 'msg err';
  alert.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function addInternalNote() {
  const input = el('internal-note-input'); const msg = el('internal-note-msg');
  const value = input.value.trim();
  if (!value) { msg.textContent = 'Enter an internal note first.'; msg.className = 'msg err'; input.focus(); return; }
  try {
    const updated = await api(`/api/requests/${encodeURIComponent(state.selectedId)}/internal-note`, {
      method: 'POST', body: JSON.stringify({ internal_note: value, _version: state.selectedVersion }),
    });
    state.selectedVersion = updated.last_updated_at || ''; input.value = '';
    msg.textContent = '✓ Internal note added'; msg.className = 'msg ok save-confirmation';
    await loadHistory(state.selectedId);
  } catch (error) { msg.textContent = formatErr(error); msg.className = 'msg err'; }
}

async function discardDraft(id) {
  if (!(await askConfirm('Permanently discard draft?', 'This draft will not appear in History and cannot be recovered.', 'Discard draft'))) return;
  try {
    await api(`/api/requests/${encodeURIComponent(id)}/discard`, { method: 'POST', body: '{}' });
    closeDetail(); await loadRequests();
  } catch (error) { showToast(formatErr(error), 'error'); }
}

async function setDeleted(deleted) {
  const id = state.selectedId;
  if (!id) return;
  if (deleted && !(await askConfirm('Delete this request?', 'The request will be hidden from active lists and can be restored later.', 'Delete request'))) return;
  try {
    await api(`/api/requests/${encodeURIComponent(id)}/${deleted ? 'delete' : 'restore'}`, { method: 'POST' });
    await loadRequests();
    if (deleted) closeDetail(); else await openDetail(id);
  } catch (err) {
    const msg = el('update-msg'); msg.textContent = formatErr(err); msg.className = 'msg err';
  }
}

function closeDetail() {
  el('detail-overlay').hidden = true;
  state.selectedId = null;
  // Send the keyboard back to the row that opened the dialog, not to the top of the page.
  const opener = state.detailOpener;
  state.detailOpener = null;
  if (opener && document.contains(opener)) opener.focus();
}

// ---------- change descriptions ----------
//
// Every one of these reads a diff the SERVER computed by comparing the stored row with
// the incoming one. Nothing here is supplied by whoever made the change, so a requester
// cannot hide an edit by leaving it out of the payload, and cannot describe it away in
// their note — the note is displayed separately, as their claim, never as the record.

function shortValue(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '(empty)';
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function attachmentsByPurpose(raw) {
  const map = new Map();
  for (const a of parseArr(raw)) if (a && a.purpose) map.set(a.purpose, a);
  return map;
}

function describeAttachmentChange(change) {
  const before = attachmentsByPurpose(change.old);
  const after = attachmentsByPurpose(change.new);
  const label = (purpose) => (state.options.attachment_labels || {})[purpose] || purpose;
  const out = [];
  for (const [purpose, item] of after) {
    const prev = before.get(purpose);
    if (!prev) out.push(`${label(purpose)} added: ${shortValue(item.filename)}`);
    else if (String(prev.stored || '') !== String(item.stored || '')) {
      out.push(`${label(purpose)} replaced: ${shortValue(prev.filename)} → ${shortValue(item.filename)}`);
    }
  }
  for (const [purpose, item] of before) {
    if (!after.has(purpose)) out.push(`${label(purpose)} removed: ${shortValue(item.filename)}`);
  }
  return out.length ? out : ['Attachments changed'];
}

function describeLineItemsChange(change) {
  const before = parseArr(change.old);
  const after = parseArr(change.new);
  if (before.length !== after.length) return [`Expense lines: ${before.length} → ${after.length} lines`];
  const out = [];
  for (let i = 0; i < after.length; i++) {
    const a = after[i]; const b = before[i] || {};
    for (const key of ['category', 'gst_entry_method', 'amount_ex_gst', 'gst_amount', 'amount', 'supplier', 'description']) {
      if (String(b[key] == null ? '' : b[key]) !== String(a[key] == null ? '' : a[key])) {
        out.push(`Expense line ${i + 1} ${key.replace(/_/g, ' ')}: ${shortValue(b[key])} → ${shortValue(a[key])}`);
      }
    }
  }
  return out.length ? out : ['Expense lines changed'];
}

function describeSupplierFormChange(change) {
  const before = parseObj(change.old);
  const after = parseObj(change.new);
  const out = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (String(before[key] == null ? '' : before[key]) === String(after[key] == null ? '' : after[key])) continue;
    // Bank details are the highest-risk thing on a supplier form; name them explicitly
    // rather than letting them hide inside a generic "supplier details changed".
    out.push(`Supplier form — ${key.replace(/_/g, ' ')}: ${shortValue(before[key])} → ${shortValue(after[key])}`);
  }
  return out.length ? out : ['Supplier form details changed'];
}

// changed_fields is {field: {old, new}}; returns one readable line per real change.
function describeChanges(changedFields, { includeStatus = true } = {}) {
  let diff = null;
  try { diff = JSON.parse(changedFields || 'null'); } catch (e) { diff = null; }
  if (!diff || typeof diff !== 'object') return [];
  const out = [];
  for (const [field, change] of Object.entries(diff)) {
    if (!change || typeof change !== 'object') continue;
    if (field === 'current_status' && !includeStatus) continue;
    if (field === 'attachments') { out.push(...describeAttachmentChange(change)); continue; }
    if (field === 'reimbursement_items') { out.push(...describeLineItemsChange(change)); continue; }
    if (field === 'supplier_form_data') { out.push(...describeSupplierFormChange(change)); continue; }
    const oldValue = field === 'current_status' ? statusLabel(change.old)
      : field === 'waiting_on' ? waitingLabel(change.old) : shortValue(change.old);
    const newValue = field === 'current_status' ? statusLabel(change.new)
      : field === 'waiting_on' ? waitingLabel(change.new) : shortValue(change.new);
    out.push(`${fieldLabel(field)}: ${oldValue} → ${newValue}`);
  }
  return out;
}

function changeListCell(changedFields) {
  const td = document.createElement('td');
  td.className = 'change-cell';
  const items = describeChanges(changedFields);
  if (!items.length) { td.className = 'change-cell muted'; td.textContent = '—'; return td; }
  const ul = document.createElement('ul'); ul.className = 'change-list';
  for (const item of items) { const li = document.createElement('li'); li.textContent = item; ul.appendChild(li); }
  td.appendChild(ul);
  return td;
}

async function loadHistory(id) {
  const events = await api(`/api/requests/${encodeURIComponent(id)}/history`);
  el('history-count').textContent = String(events.length);
  const tbody = el('history-table').querySelector('tbody');
  tbody.innerHTML = '';
  if (!events.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 6; td.className = 'muted'; td.textContent = 'No events yet.';
    tr.appendChild(td); tbody.appendChild(tr); return events;
  }
  for (const ev of events.slice().reverse()) {
    const tr = document.createElement('tr');
    if (ev.event_type === 'Internal Note') tr.className = 'internal-note-row';
    const status = ev.new_status
      ? `${ev.old_status ? statusLabel(ev.old_status) + ' → ' : ''}${statusLabel(ev.new_status)}`
      : '';
    tr.append(cell(fmtTime(ev.event_time)), cell(ev.event_type), cell(status, 'wrap-cell'),
      cell(ev.changed_by), cell(ev.note, 'note-cell'), changeListCell(ev.changed_fields));
    tbody.appendChild(tr);
  }
  return events;
}

// What the requester altered while the request was back with them. Built by merging the
// server's per-event diffs since the most recent "Returned for Info", so it cannot be
// shaped by what the requester chose to tell Finance.
function renderResubmissionSummary(row, events, isAdmin) {
  const host = el('resubmission-summary');
  host.hidden = true; host.replaceChildren();
  if (!isAdmin || (row.request_type === 'Procurement'
    ? row.current_status !== PROCUREMENT_SUBMIT_TO_ADMIN_STATUS
    : row.current_status !== 'Updated and Resubmitted')) return;

  let returnedAt = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (isReturnedStatus(events[i].new_status)) { returnedAt = i; break; }
  }
  if (returnedAt === -1) return;
  const since = events.slice(returnedAt + 1);
  if (!since.length) return;

  // Merge per-event diffs: earliest "old" against latest "new", so a value edited twice
  // is reported once, against what Finance actually last saw.
  const merged = {};
  for (const ev of since) {
    let diff = null;
    try { diff = JSON.parse(ev.changed_fields || 'null'); } catch (e) { diff = null; }
    if (!diff) continue;
    for (const [field, change] of Object.entries(diff)) {
      if (!change || typeof change !== 'object') continue;
      if (merged[field]) merged[field].new = change.new;
      else merged[field] = { old: change.old, new: change.new };
    }
  }
  const items = describeChanges(JSON.stringify(merged), { includeStatus: false });
  const explanation = [...since].reverse().find((ev) => String(ev.note || '').trim());
  const who = since[since.length - 1].changed_by || 'the user';

  const title = document.createElement('strong');
  title.textContent = items.length
    ? 'Changed since you returned this request'
    : 'Resubmitted with no field or document changes';
  host.appendChild(title);

  if (items.length) {
    const intro = document.createElement('p');
    intro.className = 'resubmission-intro';
    intro.textContent = `Recorded by the system from ${who}'s edits — not from what they wrote below.`;
    const list = document.createElement('ul'); list.className = 'change-list';
    for (const item of items) { const li = document.createElement('li'); li.textContent = item; list.appendChild(li); }
    host.append(intro, list);
  } else {
    const intro = document.createElement('p');
    intro.className = 'resubmission-intro';
    intro.textContent = 'The system recorded no change to any field or document. Only a message was sent.';
    host.appendChild(intro);
  }

  // Where it was before the round trip. Resubmitting lands on Updated and Resubmitted,
  // which sits early in the order — leaving a request that had reached the invoice stage
  // parked before "PO Issued", where the PO and invoice gates stop applying. The admin is
  // offered the way back explicitly rather than the status being restored behind them.
  const cameFrom = String(events[returnedAt].old_status || '');
  const cameFromLabel = statusLabel(cameFrom);
  const currentStatusLabel = statusLabel(row.current_status);
  const order = (state.options.statuses_by_type || {})[row.request_type] || [];
  if (cameFrom && order.indexOf(cameFrom) > order.indexOf(row.current_status)) {
    const resume = document.createElement('div');
    resume.className = 'resubmission-resume';
    const text = document.createElement('span');
    text.textContent = `Returned from "${cameFromLabel}". Resubmission put it back to "${currentStatusLabel}".`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-secondary';
    btn.textContent = `Resume at ${cameFromLabel}`;
    btn.addEventListener('click', async () => {
      const form = el('update-form');
      form.current_status.value = cameFrom;
      updateAdminStage(cameFrom, row.request_type, row);
      btn.disabled = true;
      const msg = el('update-msg');
      msg.textContent = `Status set to "${cameFromLabel}" — review the panel, then Save update to apply it.`;
      msg.className = 'msg';
      form.current_status.focus();
      form.current_status.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    resume.append(text, btn);
    host.appendChild(resume);
  }

  if (explanation) {
    const claim = document.createElement('div');
    claim.className = 'resubmission-claim';
    const claimTitle = document.createElement('span');
    claimTitle.className = 'resubmission-claim-title';
    claimTitle.textContent = `${explanation.changed_by || 'User'} wrote:`;
    const claimBody = document.createElement('p');
    claimBody.textContent = explanation.note;
    claim.append(claimTitle, claimBody);
    host.appendChild(claim);
  }
  host.hidden = false;
}

init().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin', `<p class="fatal">Failed to load: ${escapeHtml(err.message)}</p>`);
});
