'use strict';

// Controlled vocabularies and CSV column order.
//
// A request has a TYPE and a SUB_TYPE. Supplier Setup is a requester-facing intake
// workflow; an Approved setup request is promoted into the separate supplier master.

const PROCUREMENT_TYPE = 'Procurement';
const TRAVEL_TYPE = 'Travel';
const SUPPLIER_SETUP_TYPE = 'Supplier Setup';
// Travel allowance and reimbursement used to be sub-types of Travel. They are their own
// request types: neither is a trip, they have their own evidence and their own rules
// (reimbursement carries expense lines and per-line receipts), and burying them under
// Travel made the picker read as though every claim were a travel booking.
const TRAVEL_ALLOWANCE_TYPE = 'Travel Allowance';
const REIMBURSEMENT_TYPE = 'Reimbursement';
// Retained for migration of the old flat type name.
const NEW_SUPPLIER_TYPE = 'New Supplier';

const REQUEST_TYPES = [
  TRAVEL_TYPE, PROCUREMENT_TYPE, SUPPLIER_SETUP_TYPE, TRAVEL_ALLOWANCE_TYPE, REIMBURSEMENT_TYPE,
];

const TRAVEL_DOMESTIC = 'Domestic';
const TRAVEL_INTERNATIONAL = 'International';
const TRAVEL_ALLOWANCE = 'Meals/incidentals';
const TRAVEL_REIMBURSEMENT = 'Reimbursement';
const PROCUREMENT_PURCHASE = 'Purchase / PO request';
const SUPPLIER_NEW = 'New supplier';
const SUPPLIER_AMEND = 'Amend existing supplier';
// The value stored before the split, still recognised so old rows can be migrated.
const LEGACY_TRAVEL_ALLOWANCE_SUBTYPE = 'Travel Allowance - meals/incidentals';

const SUBTYPES_BY_TYPE = {
  [TRAVEL_TYPE]: [TRAVEL_DOMESTIC, TRAVEL_INTERNATIONAL],
  [PROCUREMENT_TYPE]: [PROCUREMENT_PURCHASE],
  [SUPPLIER_SETUP_TYPE]: [SUPPLIER_NEW, SUPPLIER_AMEND],
  [TRAVEL_ALLOWANCE_TYPE]: [TRAVEL_ALLOWANCE],
  [REIMBURSEMENT_TYPE]: [TRAVEL_REIMBURSEMENT],
};

const REQUESTER_SUBTYPES = {
  [TRAVEL_TYPE]: [TRAVEL_DOMESTIC, TRAVEL_INTERNATIONAL],
  [PROCUREMENT_TYPE]: [PROCUREMENT_PURCHASE],
  [SUPPLIER_SETUP_TYPE]: [SUPPLIER_NEW, SUPPLIER_AMEND],
  [TRAVEL_ALLOWANCE_TYPE]: [TRAVEL_ALLOWANCE],
  [REIMBURSEMENT_TYPE]: [TRAVEL_REIMBURSEMENT],
};

// Procurement keeps the business-facing milestones in the status value because they are
// also used by the queue, audit history and reporting.  The admin transition map below is
// intentionally permissive: Finance may move a record to any non-Draft milestone when
// the real-world process did not follow every intermediate step.
const PROCUREMENT_SUBMIT_TO_ADMIN = 'Submit to Admin';
const PROCUREMENT_SUBMIT_TO_APPROVER = 'Submit to Approver';
const PROCUREMENT_RETURN_TO_REQUESTOR = 'Return to User';
const PROCUREMENT_REQUISITION_SUBMITTED = 'Requisition submitted';
const PROCUREMENT_PO_ISSUED = 'PO issued to user';
const PROCUREMENT_INVOICE_RECEIVED = 'Invoice with PO and approval received';
const PROCUREMENT_RECEIVED_ORDER_LINES = 'Return Order Line submitted';
const PROCUREMENT_AP_INVOICES_SENT = 'Invoice submitted to University Finance';
const PROCUREMENT_POSTED_INVOICE = 'Posted Invoice';
const PROCUREMENT_CLOSED = 'Complete';
const UPDATED_AND_RESUBMITTED = 'Updated and Resubmitted';

const STATUSES_BY_TYPE = {
  [PROCUREMENT_TYPE]: [
    'Draft', PROCUREMENT_SUBMIT_TO_ADMIN, PROCUREMENT_SUBMIT_TO_APPROVER,
    PROCUREMENT_RETURN_TO_REQUESTOR, PROCUREMENT_REQUISITION_SUBMITTED,
    PROCUREMENT_PO_ISSUED, PROCUREMENT_INVOICE_RECEIVED, PROCUREMENT_RECEIVED_ORDER_LINES,
    PROCUREMENT_AP_INVOICES_SENT, PROCUREMENT_POSTED_INVOICE, PROCUREMENT_CLOSED, 'Cancelled',
  ],
  [TRAVEL_TYPE]: [
    'Draft', 'Submitted', 'Returned for Info', UPDATED_AND_RESUBMITTED, 'Accepted by Finance', 'In Progress',
    'Processed in External System', 'Completed', 'Cancelled',
  ],
  [SUPPLIER_SETUP_TYPE]: [
    'Draft', 'Submitted', 'Returned for Info', UPDATED_AND_RESUBMITTED,
    'Submitted to University System', 'Approved', 'Rejected', 'Cancelled',
  ],
  // Travel Allowance and Reimbursement use a shorter Finance workflow. They do not need
  // the old Travel-only acceptance and external-system milestones.
  [TRAVEL_ALLOWANCE_TYPE]: [
    'Draft', 'Submitted', 'Returned for Info', UPDATED_AND_RESUBMITTED, 'In Progress', 'Completed', 'Cancelled',
  ],
  [REIMBURSEMENT_TYPE]: [
    'Draft', 'Submitted', 'Returned for Info', UPDATED_AND_RESUBMITTED, 'In Progress', 'Completed', 'Cancelled',
  ],
};

// Supplier master statuses (independent of request statuses).
const SUPPLIER_STATUSES = ['Submitted for approval', 'Approved', 'Rejected'];

const TERMINAL_STATUSES = [PROCUREMENT_CLOSED, 'Completed', 'Cancelled', 'Approved', 'Rejected'];

// Which status may follow which, per type. The evidence gates in store.js still apply on
// top — this map says where a request may go, while the gates say what it must have to get
// there. Procurement is deliberately different from requester-owned workflows: Finance
// may correct a submitted record in place and choose any non-Draft milestone, including
// moving backwards from Complete or Cancelled. Only the requester-facing Return to
// Requestor action opens a correction/resubmission round for the requester.
//
// For the legacy non-Procurement workflows, Returned for Info and Updated and Resubmitted
// remain the controlled round trip. 'Updated and Resubmitted' leads to every processing
// step, not just the first one, because a request returned from a later stage may need to
// be corrected and sent back to that stage.
// Derived from each type's declared status order rather than hand-listed, so adding a
// step to STATUSES_BY_TYPE cannot leave a stale second copy of the lifecycle behind.
// The rule is "forward only", not a fixed pipeline: the intermediate steps are optional
// (Finance may approve a supplier setup without routing it through the university
// system), so a processing status leads to every step after it, and the evidence gates
// decide which of those it can actually satisfy.
const RETURNED_FOR_INFO = 'Returned for Info';

function lifecycleTransitions(order, type) {
  const map = {};
  if (type === PROCUREMENT_TYPE) {
    const adminStatuses = order.filter((status) => status !== 'Draft');
    for (const status of order) {
      // Draft remains a requester-owned private state.  Admin can move every submitted
      // Procurement milestone to any other non-Draft milestone, including Complete and
      // Cancelled; evidence gates still run against the destination status.
      map[status] = status === 'Draft'
        ? [PROCUREMENT_SUBMIT_TO_ADMIN, 'Cancelled']
        : adminStatuses.filter((next) => next !== status);
    }
    return map;
  }
  for (const status of order) {
    if (status === 'Draft') { map[status] = ['Submitted', 'Cancelled']; continue; }
    // A returned request only comes back one way, so the correction is always recorded
    // as a resubmission rather than reappearing mid-pipeline.
    if (status === RETURNED_FOR_INFO) { map[status] = [UPDATED_AND_RESUBMITTED, 'Cancelled']; continue; }
    if (status === 'Closed' || status === 'Completed' || status === 'Rejected') { map[status] = [RETURNED_FOR_INFO]; continue; }
    if (status === 'Cancelled') { map[status] = ['Submitted']; continue; }
    // An Approved setup is already promoted into the supplier master; updateRequest
    // locks it outright and explains the amendment route.
    if (status === 'Approved') { map[status] = []; continue; }
    map[status] = [
      ...order.slice(order.indexOf(status) + 1)
        .filter((next) => next !== RETURNED_FOR_INFO && next !== UPDATED_AND_RESUBMITTED),
      RETURNED_FOR_INFO,
    ];
  }
  return map;
}

const ALLOWED_TRANSITIONS_BY_TYPE = Object.fromEntries(
  Object.entries(STATUSES_BY_TYPE).map(([type, order]) => [type, lifecycleTransitions(order, type)]));

// waiting_on names the party the request is currently blocked on. A finished request is
// blocked on nobody, so every terminal status maps to '' (rendered as N/A) rather than to
// a pseudo-party — otherwise the "who is this with?" filter is polluted by done work.
const WAITING_ON = ['Finance', 'Approver', 'User', 'Supplier', 'External System', 'University Finance'];
const WAITING_ON_BY_STATUS = {
  Draft: '',
  [PROCUREMENT_SUBMIT_TO_ADMIN]: 'Finance',
  [PROCUREMENT_SUBMIT_TO_APPROVER]: 'Approver',
  [PROCUREMENT_RETURN_TO_REQUESTOR]: 'User',
  [PROCUREMENT_REQUISITION_SUBMITTED]: 'Finance',
  [PROCUREMENT_PO_ISSUED]: 'User',
  [PROCUREMENT_INVOICE_RECEIVED]: 'Finance',
  [PROCUREMENT_RECEIVED_ORDER_LINES]: 'Finance',
  [PROCUREMENT_AP_INVOICES_SENT]: 'University Finance',
  [PROCUREMENT_POSTED_INVOICE]: 'University Finance',
  [PROCUREMENT_CLOSED]: '',
  Submitted: 'Finance',
  [UPDATED_AND_RESUBMITTED]: 'Finance',
  'Returned for Info': 'User',
  'Accepted by Finance': 'Finance',
  Completed: '',
  Cancelled: '',
  'In Progress': 'Finance',
  'Processed in External System': 'External System',
  'Submitted to University System': 'External System',
  Approved: '',
  Rejected: '',
};

const REQUIRED_BY_SUBTYPE = {
  [PROCUREMENT_TYPE]: {
    // short_description, supplier quote details and cost/activity references are
    // optional; the admin queue does not surface the first three fields.
    [PROCUREMENT_PURCHASE]: ['requester_name', 'spending_approver'],
  },
  [TRAVEL_TYPE]: {
    [TRAVEL_DOMESTIC]: ['beneficiary_name', 'travel_start_date', 'travel_end_date'],
    [TRAVEL_INTERNATIONAL]: ['beneficiary_name'],
  },
  [SUPPLIER_SETUP_TYPE]: {
    [SUPPLIER_NEW]: ['requester_name', 'supplier_form_data'],
    [SUPPLIER_AMEND]: ['requester_name', 'supplier_id', 'supplier_form_data'],
  },
  [TRAVEL_ALLOWANCE_TYPE]: {
    [TRAVEL_ALLOWANCE]: ['beneficiary_name', 'activity_code', 'destination', 'travel_start_date', 'travel_end_date'],
  },
  [REIMBURSEMENT_TYPE]: {
    [TRAVEL_REIMBURSEMENT]: ['requester_name', 'activity_code'],
  },
};

// There is only one cost code in this organisation, so it is no longer asked for on any
// form. Every request is stamped with it on the way in, which keeps the reporting column
// and its reference-table foreign key populated without a schema change.
const DEFAULT_COST_CODE = '2391';

// The activity code is what maps spend to a project. An existing supplier is already
// trading with a known project, so Finance needs it stated up front; a brand-new supplier
// is often being set up before that is settled, so it stays optional there.
const ACTIVITY_CODE_REQUIRED_SUPPLIER_TYPES = ['Existing Supplier'];

// Required fields for a request, including the ones that depend on a value the request
// itself carries. Everything keyed only by type/sub-type lives in REQUIRED_BY_SUBTYPE;
// this is the single place the conditional rules are written down.
function requiredFieldsFor(type, subType, supplierType = '') {
  const base = (REQUIRED_BY_SUBTYPE[type] || {})[subType] || [];
  if (type === PROCUREMENT_TYPE
      && ACTIVITY_CODE_REQUIRED_SUPPLIER_TYPES.includes(String(supplierType || '').trim())
      && !base.includes('activity_code')) {
    return [...base, 'activity_code'];
  }
  return [...base];
}

const REIMBURSEMENT_CATEGORIES = ['Meals', 'Fuel', 'Taxi/Uber', 'Refreshments', 'Other - specify'];
const REIMBURSEMENT_DESCRIPTION_REQUIRED = ['Other - specify'];

const ATTACHMENT_PURPOSES = [
  'quote', 'approval_email', 'reimbursement_form', 'travel_request', 'itinerary', 'ta_calculator',
  'po', 'invoice', 'invoice_approval_email', 'receipt', 'supplier_evidence',
  'new_supplier_form', 'other_document',
];
const ATTACHMENT_LABELS = {
  quote: 'Quote', approval_email: 'Approval email', travel_request: 'Travel request',
  reimbursement_form: 'Reimbursement Form', itinerary: 'Itinerary', ta_calculator: 'TA calculator', po: 'Purchase order',
  invoice: 'Invoice', invoice_approval_email: 'Invoice approval email', receipt: 'Receipt',
  supplier_evidence: 'Supporting document', new_supplier_form: 'New Supplier Form',
  other_document: 'Other documents',
};
// Finance issues the PO, so only an admin may attach it; every other purpose is evidence
// the requester supplies.
const ADMIN_ONLY_ATTACHMENT_PURPOSES = ['po'];
// Documents a workflow step demands, collected by that step's own panel together with the
// fields they belong to. The generic "add attachment" control never offers these — that is
// what stops the same document being asked for in two places.
const STAGE_COLLECTED_ATTACHMENT_PURPOSES = ['po', 'invoice', 'invoice_approval_email'];

// ---- attachment volume limits ----
//
// Attachments are stored one per purpose (store.upsertAttachment replaces same-purpose
// entries and the server unlinks the file it displaced), so the fixed purposes above are
// self-limiting. The open-ended part is `receipt:<item UUID>` — one per reimbursement line — which
// is why capping the expense lines is what actually bounds a request's disk footprint.
// A hundred lines is already an extraordinary claim; the previous ceiling was the 999 the
// receipt purpose pattern happens to allow.
const MAX_REIMBURSEMENT_ITEMS = 100;
const MAX_INVOICE_ITEMS = 100;
// Derived, not hand-listed: one line receipt each, plus at most one of every fixed
// purpose. Adding a purpose or raising the line cap moves this on its own.
const MAX_ATTACHMENTS_PER_REQUEST = MAX_REIMBURSEMENT_ITEMS + ATTACHMENT_PURPOSES.length;
// The count alone still allows 110 × 10 MB. This is the limit that bounds the disk, and
// the one a request is realistically measured against: a hundred photographed receipts
// average well under 2 MB each.
const MAX_ATTACHMENT_BYTES_PER_REQUEST = 200 * 1024 * 1024;
// The per-request limits above bound what one request can hold; this bounds how many
// requests one requester can hold open. A draft is the only thing a requester can create
// freely and never has to finish, and each one carries its own attachment budget.
const MAX_OPEN_DRAFTS_PER_REQUESTER = 20;
const REQUIRED_ATTACHMENTS_BY_SUBTYPE = {
  // Quote and approval email are supporting evidence, not submission gates. New Supplier
  // conditionally adds the New Supplier Form in the shared validator and UI rule helpers.
  [PROCUREMENT_TYPE]: { [PROCUREMENT_PURCHASE]: [] },
  [TRAVEL_TYPE]: {
    [TRAVEL_DOMESTIC]: ['travel_request', 'approval_email'],
    [TRAVEL_INTERNATIONAL]: ['travel_request', 'approval_email'],
  },
  [SUPPLIER_SETUP_TYPE]: {
    [SUPPLIER_NEW]: ['supplier_evidence'],
    [SUPPLIER_AMEND]: ['supplier_evidence'],
  },
  [TRAVEL_ALLOWANCE_TYPE]: { [TRAVEL_ALLOWANCE]: ['itinerary', 'approval_email'] },
  [REIMBURSEMENT_TYPE]: { [TRAVEL_REIMBURSEMENT]: ['reimbursement_form', 'approval_email'] },
};
// Everything a subtype may ever hold, across the whole lifecycle. The intake form offers
// the subtype's standard supporting-document slots, including optional Procurement evidence;
// later documents are added from the request detail view once the workflow reaches the step
// that calls for them.
const ALLOWED_ATTACHMENTS_BY_SUBTYPE = {
  [PROCUREMENT_TYPE]: {
    [PROCUREMENT_PURCHASE]: ['quote', 'approval_email', 'po', 'invoice', 'invoice_approval_email', 'new_supplier_form', 'other_document'],
  },
  [TRAVEL_TYPE]: {
    [TRAVEL_DOMESTIC]: ['travel_request', 'approval_email', 'other_document'],
    [TRAVEL_INTERNATIONAL]: ['travel_request', 'approval_email', 'other_document'],
  },
  [SUPPLIER_SETUP_TYPE]: {
    [SUPPLIER_NEW]: ['supplier_evidence', 'other_document'],
    [SUPPLIER_AMEND]: ['supplier_evidence', 'other_document'],
  },
  [TRAVEL_ALLOWANCE_TYPE]: { [TRAVEL_ALLOWANCE]: ['ta_calculator', 'itinerary', 'approval_email', 'other_document'] },
  // Reimbursement receipts use the line-specific receipt:<item UUID> purpose.
  [REIMBURSEMENT_TYPE]: { [TRAVEL_REIMBURSEMENT]: ['reimbursement_form', 'approval_email', 'other_document'] },
};

const STATUSES = Array.from(new Set(Object.values(STATUSES_BY_TYPE).flat()));

// requests_current.csv column order (supplier-onboarding columns kept for back-compat /
// the supplier_name display snapshot; suppliers themselves live in the master now).
const CURRENT_COLUMNS = [
  'request_id', 'request_type', 'sub_type', 'requester_person_id', 'requester_name',
  'beneficiary_person_id', 'beneficiary_name',
  'supplier_name', 'legal_entity_name', 'abn', 'purchase_order_email', 'vendor_id', 'supplier_type',
  'amount', 'currency', 'cost_code', 'cost_code_other', 'activity_code', 'activity_code_other', 'spending_approver_person_id', 'spending_approver', 'received_date',
  'acknowledged_date', 'current_status', 'external_ref', 'invoice_number', 'purchase_order',
  'evidence_provided', 'due_date', 'travel_start_date', 'travel_end_date', 'destination',
  'has_attachments', 'processed_by_person_id', 'processed_by', 'created_at', 'last_updated_at', 'completed_date', 'deleted', 'notes',
  'waiting_on', 'next_action', 'submitted_at', 'accepted_at', 'returned_for_info_at',
  'completed_at', 'supplier_id', 'supplier_quote_number', 'short_description', 'amount_ex_gst',
  'gst_entry_method', 'gst_amount', 'amount_inc_gst', 'close_reason', 'invoice_items',
  'po_number', 'po_issued_at', 'invoice_received_at', 'invoice_gst_entry_method',
  'invoice_amount_ex_gst', 'invoice_gst_amount', 'invoice_amount',
  'chk_po_included', 'chk_desc_matches_po', 'chk_service_completed',
  'chk_forwarded_to_approver', 'chk_forwarded_with_approval',
  'reimbursement_items', 'attachments', 'supplier_form_data',
];

// suppliers master column order (suppliers.csv / suppliers table).
const SUPPLIER_COLUMNS = [
  'supplier_id', 'legal_entity_name', 'abn', 'purchase_order_email', 'vendor_id',
  'supplier_form_data', 'status', 'deleted', 'created_at', 'last_updated_at',
];

// users column order (users.csv / users table). password_hash is "salt:hash" (scrypt).
// password_version is the session kill switch: it is stamped into the signed session and
// re-checked on every request, so changing or resetting a password invalidates the
// sessions already out there. Without it a stolen cookie survives the password change it
// was stolen for — there is no session table to delete rows from.
const USER_COLUMNS = ['username', 'password_hash', 'role', 'person_id', 'display_name', 'active', 'password_version'];
const PERSON_COLUMNS = [
  'person_id', 'display_name', 'email', 'active',
  'can_request', 'can_travel', 'can_approve', 'can_process',
];
const ROLES = ['requester', 'admin'];

// Supplier forms remain objects at the API/CSV boundary, but SQL stores every field in
// typed one-to-one tables. Keeping the field lists here gives both repositories exactly
// the same contract and keeps sensitive bank fields out of the ordinary profile table.
const SUPPLIER_PROFILE_FIELDS = [
  'legal_entity_name', 'has_abn', 'abn', 'no_abn_reason',
  'street_address', 'suburb', 'country', 'postcode', 'state_region',
  'contact_name', 'contact_phone', 'contact_email', 'purchase_order_email',
  'remittance_email', 'nt_enterprise', 'icn', 'bank_details_action',
  'supporting_document_type', 'terms_accepted', 'declaration_name',
  'declaration_date', 'declaration_confirmed', 'bank_details_source_request_id',
];
const SUPPLIER_BANK_FIELDS = [
  'bank_type', 'bank_name', 'bank_branch_address', 'bank_account_name', 'bsb',
  'account_number', 'bank_account_currency', 'payment_currency',
  'swift_sort_bank_code', 'iban',
];

const LOG_COLUMNS = [
  'event_id', 'request_id', 'event_time', 'event_type', 'old_status', 'new_status',
  'changed_by_person_id', 'changed_by_username', 'changed_by_role',
  'changed_by', 'note', 'changed_fields',
];

module.exports = {
  REQUEST_TYPES, SUBTYPES_BY_TYPE, REQUESTER_SUBTYPES,
  PROCUREMENT_TYPE, TRAVEL_TYPE, SUPPLIER_SETUP_TYPE, NEW_SUPPLIER_TYPE,
  TRAVEL_ALLOWANCE_TYPE, REIMBURSEMENT_TYPE, LEGACY_TRAVEL_ALLOWANCE_SUBTYPE,
  PROCUREMENT_PURCHASE, TRAVEL_DOMESTIC, TRAVEL_INTERNATIONAL, TRAVEL_ALLOWANCE, TRAVEL_REIMBURSEMENT,
  SUPPLIER_NEW, SUPPLIER_AMEND,
  STATUSES, STATUSES_BY_TYPE, SUPPLIER_STATUSES, TERMINAL_STATUSES, ALLOWED_TRANSITIONS_BY_TYPE,
  PROCUREMENT_SUBMIT_TO_ADMIN, PROCUREMENT_SUBMIT_TO_APPROVER, PROCUREMENT_RETURN_TO_REQUESTOR,
  PROCUREMENT_REQUISITION_SUBMITTED, PROCUREMENT_PO_ISSUED, PROCUREMENT_INVOICE_RECEIVED,
  PROCUREMENT_RECEIVED_ORDER_LINES, PROCUREMENT_AP_INVOICES_SENT, PROCUREMENT_POSTED_INVOICE,
  PROCUREMENT_CLOSED, UPDATED_AND_RESUBMITTED,
  WAITING_ON, WAITING_ON_BY_STATUS,
  REQUIRED_BY_SUBTYPE, requiredFieldsFor, ACTIVITY_CODE_REQUIRED_SUPPLIER_TYPES, DEFAULT_COST_CODE,
  REIMBURSEMENT_CATEGORIES, REIMBURSEMENT_DESCRIPTION_REQUIRED,
  ATTACHMENT_PURPOSES, ATTACHMENT_LABELS, ADMIN_ONLY_ATTACHMENT_PURPOSES,
  STAGE_COLLECTED_ATTACHMENT_PURPOSES,
  MAX_REIMBURSEMENT_ITEMS, MAX_INVOICE_ITEMS, MAX_ATTACHMENTS_PER_REQUEST, MAX_ATTACHMENT_BYTES_PER_REQUEST,
  MAX_OPEN_DRAFTS_PER_REQUESTER,
  REQUIRED_ATTACHMENTS_BY_SUBTYPE, ALLOWED_ATTACHMENTS_BY_SUBTYPE,
  CURRENT_COLUMNS, SUPPLIER_COLUMNS, USER_COLUMNS, PERSON_COLUMNS, LOG_COLUMNS, ROLES,
  SUPPLIER_PROFILE_FIELDS, SUPPLIER_BANK_FIELDS,
};
