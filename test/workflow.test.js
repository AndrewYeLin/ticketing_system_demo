'use strict';

// The status lifecycle, tested as a state machine rather than one happy path at a time.
//
// store.test.js proves the evidence gates (a status cannot claim a step is done while
// that step's documents are missing). What it does not cover is the *shape* of the
// lifecycle: which transitions are legal at all, and whether a finished request stays
// finished. The `todo` tests at the bottom are the transitions the server currently
// permits but should not — see WORKFLOW GAP below.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writePeopleFixture } = require('../test-support/peopleFixture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frt-flow-'));
process.env.DATA_DIR = TMP;
delete process.env.STORAGE;

const store = require('../lib/store');
const {
  STATUSES_BY_TYPE, WAITING_ON_BY_STATUS, WAITING_ON, TERMINAL_STATUSES,
  PROCUREMENT_SUBMIT_TO_ADMIN,
  PROCUREMENT_PO_ISSUED,
  PROCUREMENT_INVOICE_RECEIVED,
} = require('../lib/constants');

const U = 'flow-tester';
// Lifecycle fixtures, all owned by one synthetic user. The per-requester draft quota is
// a separate rule with its own tests; exempting these keeps the state machine under test.
const FIXTURE_AS_FINANCE = { isAdmin: true };

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
test.before(() => writePeopleFixture(TMP));

const stored = (purpose, name) => ({ purpose, filename: name, stored: `st-${purpose}-${Math.random().toString(36).slice(2)}` });

function travel(over) {
  return store.createRequest({
    request_type: 'Travel', sub_type: 'Domestic', received_date: '2026-08-03',
    beneficiary_name: 'Bob', cost_code: '2391', activity_code: '3270',
    destination: 'Sydney', travel_start_date: '2026-09-01', travel_end_date: '2026-09-05',
    attachments: [stored('travel_request', 't.pdf'), stored('approval_email', 'a.eml')],
    ...(over || {}),
  }, U, FIXTURE_AS_FINANCE);
}

async function approvedSupplier() {
  const sup = await store.createSupplier({ legal_entity_name: `Flow Co ${Math.random().toString(36).slice(2, 7)}`, purchase_order_email: 'a@b.com' }, U);
  await store.updateSupplier(sup.supplier_id, { status: 'Approved' }, U);
  return sup.supplier_id;
}

async function procurement() {
  return store.createRequest({
    request_type: 'Procurement', sub_type: 'Purchase / PO request', received_date: '2026-08-03',
    requester_name: 'Alice', supplier_id: await approvedSupplier(), supplier_quote_number: 'Q-1',
    cost_code: '2391', activity_code: '3203',
    gst_entry_method: 'Enter GST separately', amount_ex_gst: '100', gst_amount: '10', amount_inc_gst: '110',
    spending_approver: 'Jane Manager', processed_by: 'Alex Lee',
    attachments: [stored('quote', 'q.pdf'), stored('approval_email', 'a.eml')],
  }, U, FIXTURE_AS_FINANCE);
}

// Move a request to `status`, returning the error instead of throwing.
async function moveTo(row, status, extra) {
  const current = await store.getRequestById(row.request_id);
  try {
    return { row: await store.updateRequest(row.request_id, { current_status: status, ...(extra || {}) }, U, current.last_updated_at) };
  } catch (err) {
    return { error: err };
  }
}

// ---------------------------------------------------------------- vocabulary consistency

test('every status a type can reach has a waiting_on rule naming a known party', () => {
  for (const [type, statuses] of Object.entries(STATUSES_BY_TYPE)) {
    for (const status of statuses) {
      assert.ok(Object.prototype.hasOwnProperty.call(WAITING_ON_BY_STATUS, status),
        `${type} can reach "${status}" but WAITING_ON_BY_STATUS has no entry for it`);
      const party = WAITING_ON_BY_STATUS[status];
      assert.ok(party === '' || WAITING_ON.includes(party),
        `waiting_on "${party}" for "${status}" is not one of ${WAITING_ON.join(', ')}`);
    }
  }
});

test('a terminal status is blocked on nobody', () => {
  for (const status of TERMINAL_STATUSES) {
    assert.strictEqual(WAITING_ON_BY_STATUS[status], '',
      `"${status}" is terminal but still shows as waiting on ${WAITING_ON_BY_STATUS[status]}`);
  }
});

test('Draft is the first status of every type, so a new request always starts there', async () => {
  for (const [type, statuses] of Object.entries(STATUSES_BY_TYPE)) {
    assert.strictEqual(statuses[0], 'Draft', `${type} does not start at Draft`);
  }
  const row = await travel();
  assert.strictEqual(row.current_status, 'Draft');
  assert.strictEqual(row.waiting_on, '');
});

// ---------------------------------------------------------------- cross-type isolation

test('a status belonging to another type is refused', async () => {
  const row = await travel();
  const bad = await moveTo(row, PROCUREMENT_PO_ISSUED);
  assert.ok(bad.error, 'a Travel request accepted a Procurement status');
  assert.strictEqual(bad.error.status, 400);
  assert.ok(bad.error.fields.current_status);

  const proc = await procurement();
  const alsoBad = await moveTo(proc, 'Accepted by Finance');
  assert.ok(alsoBad.error, 'a Procurement request accepted a Travel status');
  assert.ok(alsoBad.error.fields.current_status);
});

test('an invented status is refused before anything else is validated', async () => {
  const row = await travel();
  const bad = await moveTo(row, 'Definitely Approved');
  assert.ok(bad.error);
  assert.strictEqual(bad.error.status, 400);
});

// ---------------------------------------------------------------- lifecycle stamps

test('each step stamps its own date once and does not restamp on re-entry', async () => {
  const row = await travel();
  const submitted = (await moveTo(row, 'Submitted')).row;
  assert.ok(submitted.submitted_at, 'submitted_at was not stamped');
  assert.strictEqual(submitted.waiting_on, 'Finance');

  const accepted = (await moveTo(submitted, 'Accepted by Finance')).row;
  assert.ok(accepted.accepted_at);
  assert.strictEqual(accepted.submitted_at, submitted.submitted_at, 'submitted_at was overwritten by a later step');

  const done = (await moveTo(accepted, 'Completed', { processed_by: 'Alex Lee' })).row;
  assert.ok(done.completed_at && done.completed_date);
  assert.strictEqual(done.waiting_on, '');
  assert.strictEqual(done.accepted_at, accepted.accepted_at);
});

test('every status change writes exactly one history event with both endpoints', async () => {
  const row = await travel();
  const submitted = (await moveTo(row, 'Submitted')).row;
  await moveTo(submitted, 'Accepted by Finance');

  const history = await store.getRequestHistory(row.request_id);
  const changes = history.filter((e) => e.event_type === 'Status Changed');
  assert.strictEqual(changes.length, 2, `expected 2 status events, got ${changes.length}`);
  assert.deepStrictEqual(
    changes.map((e) => [e.old_status, e.new_status]),
    [['Draft', 'Submitted'], ['Submitted', 'Accepted by Finance']]
  );
  assert.ok(changes.every((e) => e.changed_by === U), 'changed_by was not recorded from the caller');
  assert.strictEqual(history[0].event_type, 'Created');
});

test('a no-op update writes no history event', async () => {
  const row = await travel();
  const before = (await store.getRequestHistory(row.request_id)).length;
  await store.updateRequest(row.request_id, { destination: row.destination }, U);
  assert.strictEqual((await store.getRequestHistory(row.request_id)).length, before);
});

test('returning for information stamps the date and needs a reason each time', async () => {
  const row = await travel();
  const submitted = (await moveTo(row, 'Submitted')).row;

  const bare = await moveTo(submitted, 'Returned for Info');
  assert.strictEqual(bare.error.status, 400);
  assert.ok(bare.error.fields.note);

  const returned = (await moveTo(submitted, 'Returned for Info', { note: 'Missing itinerary' })).row;
  assert.ok(returned.returned_for_info_at);
  assert.strictEqual(returned.waiting_on, 'User');

  const resubmitted = (await moveTo(returned, 'Updated and Resubmitted')).row;
  assert.strictEqual(resubmitted.waiting_on, 'Finance');

  // A second return is a fresh decision and needs its own explanation.
  const secondBare = await moveTo(resubmitted, 'Returned for Info');
  assert.strictEqual(secondBare.error.status, 400);
});

// ---------------------------------------------------------------- evidence gates

test('a procurement request cannot reach a step whose evidence is missing', async () => {
  const proc = await procurement();
  const submitted = (await moveTo(proc, PROCUREMENT_SUBMIT_TO_ADMIN)).row;

  const noPo = await moveTo(submitted, PROCUREMENT_PO_ISSUED);
  assert.ok(noPo.error, 'PO Issued was reachable without a PO');
  assert.ok(noPo.error.fields.po_number || noPo.error.fields.attachments);

  const noInvoice = await moveTo(submitted, PROCUREMENT_INVOICE_RECEIVED);
  assert.ok(noInvoice.error, 'Invoice Received was reachable without an invoice');
  assert.ok(noInvoice.error.fields.invoice_number || noInvoice.error.fields.attachments);
});

test('PO Issued can wait for the requester without invoice details or a file', async () => {
  const proc = await procurement();
  const submitted = (await moveTo(proc, PROCUREMENT_SUBMIT_TO_ADMIN)).row;
  const poStage = (await moveTo(submitted, PROCUREMENT_PO_ISSUED, {
    po_number: 'PO-WAITING-FOR-INVOICE',
    attachments: [...JSON.parse(submitted.attachments), stored('po', 'po.pdf')],
  })).row;
  assert.ok(poStage, 'the PO stage could not be reached with only PO evidence');

  const saved = await store.saveInvoiceProgress(proc.request_id, {
    invoice_items: [],
  }, U, poStage.last_updated_at);
  assert.strictEqual(saved.current_status, PROCUREMENT_PO_ISSUED);
  assert.strictEqual(saved.invoice_items, '', 'an empty invoice draft should remain empty');
});

test('a travel-family request cannot be completed without naming who processed it', async () => {
  for (const [type, subType, extra] of [
    ['Travel', 'Domestic', {}],
    ['Travel Allowance', 'Meals/incidentals', {}],
  ]) {
    const required = type === 'Travel'
      ? [stored('travel_request', 't.pdf'), stored('approval_email', 'a.eml')]
      : [stored('itinerary', 'i.pdf'), stored('approval_email', 'a.eml')];
    const row = await store.createRequest({
      request_type: type, sub_type: subType, received_date: '2026-08-03',
      beneficiary_name: 'Bob', cost_code: '2391', activity_code: '3270',
      destination: 'Sydney', travel_start_date: '2026-09-01', travel_end_date: '2026-09-05',
      attachments: required, ...extra,
    }, U, FIXTURE_AS_FINANCE);
    const submitted = (await moveTo(row, 'Submitted')).row;
    const bad = await moveTo(submitted, 'Completed');
    assert.ok(bad.error, `${type} completed without processed_by`);
    assert.ok(bad.error.fields.processed_by);
    const good = await moveTo(submitted, 'Completed', { processed_by: 'Alex Lee' });
    assert.ok(good.row, good.error && good.error.message);
  }
});

test('a supplier setup cannot be Approved without a vendor id, and is locked once it is', async () => {
  const row = await store.createRequest({
    request_type: 'Supplier Setup', sub_type: 'New supplier', received_date: '2026-08-03',
    requester_name: 'Alice',
    supplier_form_data: {
      legal_entity_name: `Locked Co ${Math.random().toString(36).slice(2, 7)}`, has_abn: 'Yes', abn: '12345678901',
      street_address: '1 Smith Street', suburb: 'Darwin', country: 'Australia', postcode: '0800', state_region: 'NT',
      contact_name: 'Vendor Contact', contact_phone: '0889000000', contact_email: 'contact@example.com',
      purchase_order_email: 'orders@example.com', remittance_email: 'accounts@example.com',
      nt_enterprise: 'No', icn: '', bank_type: 'Australian EFT', bank_name: 'Example Bank',
      bank_branch_address: 'Darwin NT', bank_account_name: 'Locked Co', bsb: '123-456', account_number: '00123456',
      bank_account_currency: '', payment_currency: '', swift_sort_bank_code: '', iban: '',
      supporting_document_type: 'Bank statement', terms_accepted: 'Yes', declaration_confirmed: 'Yes',
    },
    attachments: [stored('supplier_evidence', 'bank.pdf')],
  }, U, FIXTURE_AS_FINANCE);
  const submitted = (await moveTo(row, 'Submitted')).row;

  const noVendor = await moveTo(submitted, 'Approved');
  assert.ok(noVendor.error, 'Approved without a vendor id');
  assert.ok(noVendor.error.fields.vendor_id);

  const approved = (await moveTo(submitted, 'Approved', { vendor_id: 'V-1001' })).row;
  assert.strictEqual(approved.waiting_on, '');

  const reopened = await moveTo(approved, 'Submitted');
  assert.strictEqual(reopened.error.status, 409, 'an Approved supplier setup was reopened');
});

// ---------------------------------------------------------------- deletion

test('a soft-deleted request is closed to every status change until it is restored', async () => {
  const row = await travel();
  await store.setDeleted(row.request_id, true, U);
  const blocked = await moveTo(row, 'Submitted');
  assert.strictEqual(blocked.error.status, 409);

  await store.setDeleted(row.request_id, false, U);
  const after = await moveTo(row, 'Submitted');
  assert.ok(after.row, 'a restored request stayed locked');
});

test('only a draft can be hard-deleted', async () => {
  const row = await travel();
  const submitted = (await moveTo(row, 'Submitted')).row;
  await assert.rejects(() => store.hardDeleteDraft(submitted.request_id));
  assert.ok(await store.getRequestById(submitted.request_id), 'a submitted request was destroyed');
});

// ---------------------------------------------------------------- transition graph

// A Travel request carried to Completed, the way Finance would.
async function completedTravel() {
  const submitted = (await moveTo(await travel(), 'Submitted')).row;
  return (await moveTo(submitted, 'Completed', { processed_by: 'Alex Lee' })).row;
}

test('a draft can only be submitted or cancelled', async () => {
  for (const status of ['Completed', 'Processed in External System', 'Accepted by Finance', 'In Progress']) {
    const attempt = await moveTo(await travel(), status, { processed_by: 'Alex Lee' });
    assert.ok(attempt.error, `a Draft went straight to ${status}`);
    assert.strictEqual(attempt.error.status, 400);
    assert.match(attempt.error.fields.current_status, /cannot go from "Draft"/);
  }
  assert.ok((await moveTo(await travel(), 'Submitted')).row);
  assert.ok((await moveTo(await travel(), 'Cancelled')).row);
});

test('a request cannot walk backwards through its lifecycle', async () => {
  const submitted = (await moveTo(await travel(), 'Submitted')).row;
  const back = await moveTo(submitted, 'Draft');
  assert.ok(back.error, 'a Submitted request was pushed back to Draft');

  const inProgress = (await moveTo(submitted, 'In Progress')).row;
  const rewound = await moveTo(inProgress, 'Accepted by Finance');
  assert.ok(rewound.error, 'a request moved back to an earlier processing step');
});

test('intermediate steps stay optional — a status leads to every later one', async () => {
  const submitted = (await moveTo(await travel(), 'Submitted')).row;
  const done = await moveTo(submitted, 'Completed', { processed_by: 'Alex Lee' });
  assert.ok(done.row, 'Finance could not complete a request without the optional middle steps');
});

test('a returned request comes back only as a resubmission', async () => {
  const submitted = (await moveTo(await travel(), 'Submitted')).row;
  const returned = (await moveTo(submitted, 'Returned for Info', { note: 'Please fix the dates' })).row;

  for (const status of ['Completed', 'Accepted by Finance', 'Submitted']) {
    const jumped = await moveTo(returned, status, { processed_by: 'Alex Lee' });
    assert.ok(jumped.error, `a Returned request jumped to ${status} without being resubmitted`);
  }
  assert.ok((await moveTo(returned, 'Updated and Resubmitted')).row);
});

test('a completed request is frozen until it is returned for correction', async () => {
  const done = await completedTravel();

  const rewritten = await moveTo(done, 'Completed', { amount: '99999' });
  assert.ok(rewritten.error, 'the amount on a Completed request was rewritten in place');
  assert.match(rewritten.error.fields.current_status, /locked/);

  const reopened = await moveTo(done, 'Draft');
  assert.ok(reopened.error, 'a Completed request was walked back to Draft and left the admin queue');

  // The sanctioned route: return it, which forces an explanation into the history.
  const bare = await moveTo(done, 'Returned for Info');
  assert.strictEqual(bare.error.status, 400, 'a request was returned with no message to the requester');

  const returned = (await moveTo(done, 'Returned for Info', { note: 'The amount was wrong.' })).row;
  assert.strictEqual(returned.waiting_on, 'User');
  const corrected = await moveTo(returned, 'Updated and Resubmitted', { amount: '250' });
  assert.strictEqual(corrected.row.amount, '250', 'the correction did not stick');
  assert.ok((await moveTo(corrected.row, 'Completed', { processed_by: 'Alex Lee' })).row);
});

test('a cancelled request can be reopened, and nothing else', async () => {
  const cancelled = (await moveTo(await travel(), 'Cancelled')).row;

  const edited = await moveTo(cancelled, 'Cancelled', { destination: 'Perth' });
  assert.ok(edited.error, 'a Cancelled request was edited in place');

  const sideways = await moveTo(cancelled, 'Completed', { processed_by: 'Alex Lee' });
  assert.ok(sideways.error, 'a Cancelled request went straight to Completed');

  const reopened = await moveTo(cancelled, 'Submitted');
  assert.ok(reopened.row, 'a Cancelled request could not be reopened');
  assert.strictEqual(reopened.row.current_status, 'Submitted');
  assert.strictEqual(reopened.row.waiting_on, 'Finance');
});

test('a note can still be added to a finished request', async () => {
  const done = await completedTravel();
  const noted = await store.updateRequest(done.request_id, { internal_note: 'Paid in the July run.' }, U);
  assert.strictEqual(noted.current_status, 'Completed');
  const history = await store.getRequestHistory(done.request_id);
  assert.ok(history.some((e) => e.event_type === 'Internal Note'), 'a closed request could not be annotated');
});

test('a rejected supplier setup can be returned but not silently revived', async () => {
  const row = await store.createRequest({
    request_type: 'Supplier Setup', sub_type: 'New supplier', received_date: '2026-08-03',
    requester_name: 'Alice',
    supplier_form_data: {
      legal_entity_name: `Rejected Co ${Math.random().toString(36).slice(2, 7)}`, has_abn: 'Yes', abn: '12345678901',
      street_address: '1 Smith Street', suburb: 'Darwin', country: 'Australia', postcode: '0800', state_region: 'NT',
      contact_name: 'Vendor Contact', contact_phone: '0889000000', contact_email: 'contact@example.com',
      purchase_order_email: 'orders@example.com', remittance_email: 'accounts@example.com',
      nt_enterprise: 'No', icn: '', bank_type: 'Australian EFT', bank_name: 'Example Bank',
      bank_branch_address: 'Darwin NT', bank_account_name: 'Rejected Co', bsb: '123-456', account_number: '00123456',
      bank_account_currency: '', payment_currency: '', swift_sort_bank_code: '', iban: '',
      supporting_document_type: 'Bank statement', terms_accepted: 'Yes', declaration_confirmed: 'Yes',
    },
    attachments: [stored('supplier_evidence', 'bank.pdf')],
  }, U, FIXTURE_AS_FINANCE);
  const submitted = (await moveTo(row, 'Submitted')).row;
  const rejected = (await moveTo(submitted, 'Rejected')).row;

  assert.ok((await moveTo(rejected, 'Approved', { vendor_id: 'V-9' })).error, 'a Rejected setup was approved outright');
  assert.ok((await moveTo(rejected, 'Returned for Info', { note: 'Resubmit with the right ABN.' })).row);
});

test('the graph never offers a status the type does not have', () => {
  const { ALLOWED_TRANSITIONS_BY_TYPE } = require('../lib/constants');
  for (const [type, map] of Object.entries(ALLOWED_TRANSITIONS_BY_TYPE)) {
    const valid = new Set(STATUSES_BY_TYPE[type]);
    assert.deepStrictEqual(Object.keys(map).sort(), [...valid].sort(),
      `${type} has a transition map that does not match its status list`);
    for (const [from, successors] of Object.entries(map)) {
      for (const to of successors) {
        assert.ok(valid.has(to), `${type}: "${from}" offers "${to}", which is not a ${type} status`);
        assert.notStrictEqual(to, from, `${type}: "${from}" lists itself as a successor`);
      }
    }
  }
});
