'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writePeopleFixture } = require('../test-support/peopleFixture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frt-test-'));
process.env.DATA_DIR = TMP;
delete process.env.STORAGE; // CSV backend for tests

const store = require('../lib/store');
const {
  PROCUREMENT_SUBMIT_TO_ADMIN: SUBMIT_TO_ADMIN,
  PROCUREMENT_RETURN_TO_REQUESTOR: RETURN_TO_REQUESTOR,
  PROCUREMENT_PO_ISSUED: PO_ISSUED,
  PROCUREMENT_INVOICE_RECEIVED: INVOICE_RECEIVED,
  PROCUREMENT_RECEIVED_ORDER_LINES: RETURN_ORDER_LINES,
  PROCUREMENT_CLOSED: COMPLETE,
  MAX_REIMBURSEMENT_ITEMS: MAX_ITEMS,
  MAX_OPEN_DRAFTS_PER_REQUESTER: MAX_DRAFTS,
  DEFAULT_COST_CODE,
} = require('../lib/constants');
const U = 'tester';
const rnd = () => Math.random().toString(36).slice(2, 6);
// These fixtures all belong to the same synthetic user and exist to set up domain
// scenarios, not to exercise the per-requester draft quota — which has its own tests.
// Marking them finance-created is also what they are: an admin recording work on
// somebody's behalf, the case the quota deliberately exempts.
const FIXTURE_AS_FINANCE = { isAdmin: true };

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
test.before(() => writePeopleFixture(TMP));

async function approvedSupplier(name) {
  const sup = await store.createSupplier({ legal_entity_name: name, purchase_order_email: 'a@b.com' }, U);
  await store.updateSupplier(sup.supplier_id, { status: 'Approved' }, U);
  return sup.supplier_id;
}

function procurement(supplierId, over) {
  return store.createRequest(
    {
      request_type: 'Procurement', sub_type: 'Purchase / PO request', received_date: '2026-08-03',
      requester_name: 'Alice', supplier_id: supplierId, supplier_quote_number: 'Q-1',
      cost_code: '2391', activity_code: '3203', short_description: 'Widgets',
      gst_entry_method: 'Enter GST separately', amount_ex_gst: '100', gst_amount: '10', amount_inc_gst: '110',
      spending_approver: 'Jane Manager', processed_by: 'Alex Lee',
      attachments: [{ purpose: 'quote', filename: 'q.pdf' }, { purpose: 'approval_email', filename: 'a.eml' }],
      ...(over || {}),
    },
    U, FIXTURE_AS_FINANCE
  );
}

function domestic(over) {
  return store.createRequest(
    {
      request_type: 'Travel', sub_type: 'Domestic', received_date: '2026-08-03',
      beneficiary_name: 'Bob', cost_code: '2391', activity_code: '3270',
      destination: 'Sydney', travel_start_date: '2026-09-01', travel_end_date: '2026-09-05',
      attachments: [{ purpose: 'travel_request', filename: 't.pdf' }, { purpose: 'approval_email', filename: 'a.eml' }],
      ...(over || {}),
    },
    U, FIXTURE_AS_FINANCE
  );
}

function reimbursement(items, over) {
  return store.createRequest(
    {
      request_type: 'Reimbursement', sub_type: 'Reimbursement', received_date: '2026-08-03',
      requester_name: 'Alice', cost_code: '2391', activity_code: '3203',
      reimbursement_items: (items || []).map((item) => ({
        gst_entry_method: 'Total includes GST', amount_ex_gst: item.amount, gst_amount: '0', ...item,
      })), attachments: [
        { purpose: 'reimbursement_form', filename: 'reimbursement-form.pdf' },
        { purpose: 'approval_email', filename: 'a.eml' },
      ],
      ...(over || {}),
    },
    U, FIXTURE_AS_FINANCE
  );
}

function supplierSetup(over) {
  return store.createRequest({
    request_type: 'Supplier Setup', sub_type: 'New supplier', received_date: '2026-08-03',
    requester_name: 'Alice',
    supplier_form_data: {
      legal_entity_name: 'New Vendor ' + rnd(), has_abn: 'Yes', abn: '12345678901',
      street_address: '1 Smith Street', suburb: 'Darwin', country: 'Australia', postcode: '0800', state_region: 'NT',
      contact_name: 'Vendor Contact', contact_phone: '0889000000', contact_email: 'contact@example.com',
      purchase_order_email: 'orders@example.com', remittance_email: 'accounts@example.com',
      nt_enterprise: 'No', icn: '', bank_type: 'Australian EFT', bank_name: 'Example Bank',
      bank_branch_address: 'Darwin NT', bank_account_name: 'New Vendor', bsb: '123-456', account_number: '00123456',
      bank_account_currency: '', payment_currency: '', swift_sort_bank_code: '', iban: '',
      supporting_document_type: 'Bank statement', terms_accepted: 'Yes', declaration_confirmed: 'Yes',
    },
    ...(over || {}),
  }, U, FIXTURE_AS_FINANCE);
}

async function assertRejected(fn, status) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  assert.ok(threw, 'expected the operation to throw');
  if (status) assert.strictEqual(threw.status, status);
  return threw;
}

// --- supplier master ---

test('supplier create requires legal entity name + valid email', async () => {
  await assertRejected(() => store.createSupplier({ purchase_order_email: 'a@b.com' }, U));
  await assertRejected(() => store.createSupplier({ legal_entity_name: 'X', purchase_order_email: 'bad' }, U));
  const ok = await store.createSupplier({ legal_entity_name: 'Good Co', purchase_order_email: 'g@c.com' }, U);
  assert.match(ok.supplier_id, /^SUP-\d{8}-\d{3}$/);
  assert.strictEqual(ok.status, 'Submitted for approval');
});

test('a supplier can be Approved and Rejected', async () => {
  const sup = await store.createSupplier({ legal_entity_name: 'Flip Co', purchase_order_email: 'f@c.com' }, U);
  const app = await store.updateSupplier(sup.supplier_id, { status: 'Approved' }, U);
  assert.strictEqual(app.status, 'Approved');
  const rej = await store.updateSupplier(sup.supplier_id, { status: 'Rejected' }, U);
  assert.strictEqual(rej.status, 'Rejected');
});

// --- requester-facing Supplier Setup ---

test('supplier setup requires valid form data and stored bank evidence before submission', async () => {
  const incomplete = await supplierSetup({ supplier_form_data: { legal_entity_name: 'Incomplete' } });
  const bad = await assertRejected(() => store.updateRequest(incomplete.request_id, { current_status: 'Submitted' }, U));
  assert.ok(bad.fields.supplier_form_data);

  const draft = await supplierSetup();
  assert.strictEqual(draft.current_status, 'Draft');
  assert.strictEqual(draft.legal_entity_name.startsWith('New Vendor'), true);
  const missing = await assertRejected(() => store.updateRequest(draft.request_id, { current_status: 'Submitted' }, U));
  assert.ok(missing.fields.attachments);

  const ready = await store.updateRequest(draft.request_id, { attachments: [
    { purpose: 'supplier_evidence', filename: 'bank.pdf', stored: 'stored-bank' },
  ] }, U);
  const submitted = await store.updateRequest(ready.request_id, { current_status: 'Submitted' }, U);
  assert.strictEqual(submitted.waiting_on, 'Finance');
});

test('Australian supplier state is limited to a recognised state or territory', async () => {
  const draft = await supplierSetup();
  const form = JSON.parse(draft.supplier_form_data);
  form.state_region = 'Darwin';
  const err = await assertRejected(() => store.updateRequest(draft.request_id, { supplier_form_data: form }, U));
  assert.match(err.fields.supplier_form_data, /Australian state or territory/);
});

test('approving a supplier setup requires Vendor ID and promotes it into the Procurement list', async () => {
  const draft = await supplierSetup({ attachments: [
    { purpose: 'supplier_evidence', filename: 'bank.pdf', stored: 'stored-bank' },
  ] });
  const submitted = await store.updateRequest(draft.request_id, { current_status: 'Submitted' }, U);
  const missingVendor = await assertRejected(() => store.updateRequest(submitted.request_id, { current_status: 'Approved' }, U));
  assert.ok(missingVendor.fields.vendor_id);

  const approved = await store.updateRequest(submitted.request_id, { current_status: 'Approved', vendor_id: 'V-1001' }, U);
  assert.strictEqual(approved.waiting_on, '');
  assert.match(approved.supplier_id, /^SUP-\d{8}-\d{3}$/);
  const selectable = await store.readSuppliers();
  const promoted = selectable.find((s) => s.supplier_id === approved.supplier_id);
  assert.ok(promoted);
  assert.strictEqual(promoted.vendor_id, 'V-1001');
  const promotedProfile = JSON.parse((await store.readSuppliersAll()).find((s) => s.supplier_id === approved.supplier_id).supplier_form_data);
  assert.strictEqual(promotedProfile.street_address, '1 Smith Street');
  assert.strictEqual(promotedProfile.account_number, '00123456');

  const duplicateDraft = await supplierSetup({ attachments: [
    { purpose: 'supplier_evidence', filename: 'bank-2.pdf', stored: 'stored-bank-2' },
  ] });
  const duplicateSubmitted = await store.updateRequest(duplicateDraft.request_id, { current_status: 'Submitted' }, U);
  const duplicateVendor = await assertRejected(() => store.updateRequest(duplicateSubmitted.request_id, { current_status: 'Approved', vendor_id: 'V-1001' }, U));
  assert.ok(duplicateVendor.fields.vendor_id);
});

test('an Approved supplier setup is locked and amendment requests update the master', async () => {
  const targetId = await approvedSupplier('Existing Vendor ' + rnd());
  const amend = await supplierSetup({
    sub_type: 'Amend existing supplier', supplier_id: targetId,
    attachments: [{ purpose: 'supplier_evidence', filename: 'bank.pdf', stored: 'stored-amend' }],
  });
  const submitted = await store.updateRequest(amend.request_id, { current_status: 'Submitted' }, U);
  const approved = await store.updateRequest(submitted.request_id, { current_status: 'Approved', vendor_id: 'V-2002' }, U);
  assert.strictEqual(approved.supplier_id, targetId);
  const masters = await store.readSuppliersAll();
  const amendedMaster = masters.find((s) => s.supplier_id === targetId);
  assert.strictEqual(amendedMaster.vendor_id, 'V-2002');
  assert.strictEqual(JSON.parse(amendedMaster.supplier_form_data).contact_name, 'Vendor Contact');
  await assertRejected(() => store.updateRequest(approved.request_id, { current_status: 'Submitted' }, U), 409);
});

test('amendment template prefills safe details and withholds bank data entirely', async () => {
  const original = await supplierSetup({ attachments: [
    { purpose: 'supplier_evidence', filename: 'bank.pdf', stored: 'stored-template' },
  ] });
  const submitted = await store.updateRequest(original.request_id, { current_status: 'Submitted' }, U);
  const approved = await store.updateRequest(submitted.request_id, { current_status: 'Approved', vendor_id: `V-TEMPLATE-${rnd()}` }, U);

  const template = await store.getSupplierAmendmentTemplate(approved.supplier_id);
  assert.strictEqual(template.form_data.legal_entity_name, approved.legal_entity_name);
  assert.strictEqual(template.form_data.street_address, '1 Smith Street');
  // can_keep_bank_details is all the amendment form needs: keeping the existing details
  // is done server-side by hydrateUnchangedSupplierBank, so nothing about the account
  // has to travel to a browser. Any requester can read this for any approved supplier.
  assert.strictEqual(template.can_keep_bank_details, true);
  const serialised = JSON.stringify(template);
  // '3456' on its own would be a false positive — it also appears inside the fixture's
  // ABN, which is a public identifier the template is supposed to return.
  for (const field of ['bank_summary', 'account_number', 'account_number_masked', 'bsb',
    'bank_name', 'bank_account_name', '00123456', '123-456', '••••']) {
    assert.ok(!serialised.includes(field), `the template leaked ${field}`);
  }
});

test('amendment can retain server-side bank details without uploading duplicate evidence', async () => {
  const original = await supplierSetup({ attachments: [
    { purpose: 'supplier_evidence', filename: 'bank.pdf', stored: 'stored-original' },
  ] });
  const submitted = await store.updateRequest(original.request_id, { current_status: 'Submitted' }, U);
  const approved = await store.updateRequest(submitted.request_id, { current_status: 'Approved', vendor_id: `V-KEEP-${rnd()}` }, U);
  const template = await store.getSupplierAmendmentTemplate(approved.supplier_id);

  const amendmentData = {
    ...template.form_data,
    bank_details_action: 'Unchanged',
    nt_enterprise: template.form_data.nt_enterprise || 'No',
    terms_accepted: 'Yes', declaration_name: 'Vendor Contact', declaration_date: '2026-08-03', declaration_confirmed: 'Yes',
  };
  const amendment = await supplierSetup({
    sub_type: 'Amend existing supplier', supplier_id: approved.supplier_id,
    supplier_form_data: amendmentData, attachments: [],
  });
  const stored = JSON.parse(amendment.supplier_form_data);
  assert.strictEqual(stored.account_number, '00123456');
  assert.strictEqual(stored.bank_details_source_request_id, approved.request_id);
  const resubmitted = await store.updateRequest(amendment.request_id, { current_status: 'Submitted' }, U);
  assert.strictEqual(resubmitted.current_status, 'Submitted');
});

test('legacy supplier without approved setup history must re-enter amendment bank details', async () => {
  const legacyId = await approvedSupplier('Legacy Vendor ' + rnd());
  const template = await store.getSupplierAmendmentTemplate(legacyId);
  assert.strictEqual(template.can_keep_bank_details, false);
  const error = await assertRejected(() => supplierSetup({
    sub_type: 'Amend existing supplier', supplier_id: legacyId,
    supplier_form_data: { ...template.form_data, bank_details_action: 'Unchanged' },
  }));
  assert.match(error.fields.supplier_form_data, /unavailable/);
});

test('legacy supplier master rows are normalised into the current profile shape', async () => {
  const supplier = await store.createSupplier({
    legal_entity_name: 'Legacy Shape ' + rnd(), abn: '12345678901', purchase_order_email: 'legacy@example.com',
    supplier_form_data: { street_address: '3 Legacy Road', contact_name: 'Legacy Contact' },
  }, U);
  const profile = JSON.parse(supplier.supplier_form_data);
  assert.strictEqual(profile.legal_entity_name, supplier.legal_entity_name);
  assert.strictEqual(profile.has_abn, 'Yes');
  assert.strictEqual(profile.abn, '12345678901');
  assert.strictEqual(profile.purchase_order_email, 'legacy@example.com');
  assert.strictEqual(profile.street_address, '3 Legacy Road');
  assert.strictEqual(profile.contact_name, 'Legacy Contact');
});

test('concurrent supplier approvals create only one supplier master record', async () => {
  const draft = await supplierSetup({ attachments: [
    { purpose: 'supplier_evidence', filename: 'bank-concurrent.pdf', stored: 'stored-concurrent' },
  ] });
  const submitted = await store.updateRequest(draft.request_id, { current_status: 'Submitted' }, U);
  const results = await Promise.allSettled([
    store.updateRequest(submitted.request_id, { current_status: 'Approved', vendor_id: 'V-CONCURRENT' }, 'admin-a'),
    store.updateRequest(submitted.request_id, { current_status: 'Approved', vendor_id: 'V-CONCURRENT' }, 'admin-b'),
  ]);
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.strictEqual(results.find((r) => r.status === 'rejected').reason.status, 409);
  const masters = await store.readSuppliersAll();
  assert.strictEqual(masters.filter((s) => s.vendor_id === 'V-CONCURRENT').length, 1);
});

// --- Procurement ---

test('procurement links supplier by id and snapshots the name', async () => {
  const sid = await approvedSupplier('Acme Pty ' + rnd());
  const p = await procurement(sid);
  assert.strictEqual(p.current_status, 'Draft');
  assert.strictEqual(p.supplier_id, sid);
  assert.ok(p.supplier_name.startsWith('Acme Pty'));
});

test('people capabilities resolve stable ids and preserve display-name snapshots', async () => {
  const people = await store.readPeople();
  const jane = people.find((person) => person.display_name === 'Jane Manager');
  const bob = people.find((person) => person.display_name === 'Bob');
  assert.strictEqual(jane.can_approve, 'Yes');
  assert.strictEqual(bob.can_travel, 'Yes');

  const sid = await approvedSupplier('People Model ' + rnd());
  const purchase = await procurement(sid, { spending_approver_person_id: jane.person_id, spending_approver: '' });
  assert.strictEqual(purchase.spending_approver_person_id, jane.person_id);
  assert.strictEqual(purchase.spending_approver, jane.display_name);

  const travel = await domestic({ beneficiary_person_id: bob.person_id, beneficiary_name: '' });
  assert.strictEqual(travel.beneficiary_person_id, bob.person_id);
  assert.strictEqual(travel.beneficiary_name, bob.display_name);

  const err = await assertRejected(() => procurement(sid, {
    spending_approver_person_id: bob.person_id, spending_approver: '',
  }));
  assert.match(err.fields.spending_approver_person_id, /not authorised/);
});

test('traveller identity does not grant requester ownership', async () => {
  const travel = await domestic({ requester_person_id: 'PER-011', requester_name: 'Alice', beneficiary_person_id: 'PER-012', beneficiary_name: 'Bob' });
  assert.strictEqual(await store.isRequestOwner(travel, 'someone-else', 'PER-012', 'Bob'), false);
  assert.strictEqual(await store.isRequestOwner(travel, 'someone-else', 'PER-011', 'Alice'), true);
});

test('procurement missing required fields is rejected', async () => {
  const sid = await approvedSupplier('Beta ' + rnd());
  const draft = await procurement(sid, { supplier_quote_number: '', amount_ex_gst: '' });
  const err = await assertRejected(() => store.updateRequest(draft.request_id, { current_status: SUBMIT_TO_ADMIN }, U));
  assert.ok(!err.fields.supplier_quote_number && err.fields.amount_ex_gst && !err.fields.attachments);
});

test('Procurement can be submitted without a quote or an approval email', async () => {
  const sid = await approvedSupplier('NoQuote ' + rnd());
  const draft = await procurement(sid, {
    supplier_type: 'Existing Supplier',
    supplier_quote_number: '',
    activity_code: '3203',
    attachments: [],
  });
  const submitted = await store.updateRequest(draft.request_id, { current_status: SUBMIT_TO_ADMIN }, U);
  assert.strictEqual(submitted.current_status, SUBMIT_TO_ADMIN);
  assert.strictEqual(submitted.supplier_quote_number, '');
  assert.strictEqual(submitted.activity_code, '3203');
  assert.deepStrictEqual(submitted.attachments ? JSON.parse(submitted.attachments) : [], []);
});

// No form collects a cost code any more — there is only one in the organisation — so the
// column is stamped on the way in and the reporting/foreign key stays populated.
test('every request is stamped with the single cost code, whatever the form sent', async () => {
  const sid = await approvedSupplier('CostStamp ' + rnd());
  const stamped = await procurement(sid, { cost_code: '', activity_code: '3203' });
  assert.strictEqual(stamped.cost_code, DEFAULT_COST_CODE);
  const travel = await domestic({ cost_code: '' });
  assert.strictEqual(travel.cost_code, DEFAULT_COST_CODE);
});

// Requirement 2: an existing supplier is already trading against a known project, so the
// activity code has to be stated; a brand-new supplier is often set up before it is known.
test('the activity code is required for an existing supplier and optional for a new one', async () => {
  const sid = await approvedSupplier('ActivityGate ' + rnd());
  const existing = await procurement(sid, {
    supplier_type: 'Existing Supplier', activity_code: '', attachments: [],
  });
  const rejected = await assertRejected(() => store.updateRequest(
    existing.request_id, { current_status: SUBMIT_TO_ADMIN }, U));
  assert.ok(rejected.fields.activity_code, 'an existing supplier was submitted without an activity code');

  const fixed = await store.updateRequest(existing.request_id,
    { activity_code: '3206', current_status: SUBMIT_TO_ADMIN }, U);
  assert.strictEqual(fixed.current_status, SUBMIT_TO_ADMIN);
  assert.strictEqual(fixed.activity_code, '3206');

  // A draft is never gated on it, whichever supplier type it carries.
  const stillDraft = await procurement(sid, { supplier_type: 'Existing Supplier', activity_code: '' });
  assert.strictEqual(stillDraft.current_status, 'Draft');
  assert.strictEqual(stillDraft.activity_code, '');
});

test('new supplier procurement makes the activity code and intake evidence optional but keeps its form required', async () => {
  const draft = await store.createRequest({
    request_type: 'Procurement', sub_type: 'Purchase / PO request', received_date: '2026-08-03',
    requester_name: 'Alice', supplier_type: 'New Supplier', supplier_quote_number: 'Q-NEW-OPTIONAL',
    activity_code: '', short_description: 'New supplier request',
    amount_ex_gst: '100', amount_inc_gst: '110', spending_approver: 'Jane Manager',
  }, U, FIXTURE_AS_FINANCE);
  const missingForm = await assertRejected(() => store.updateRequest(
    draft.request_id, { current_status: SUBMIT_TO_ADMIN }, U));
  assert.ok(missingForm.fields.attachments);
  assert.ok(!missingForm.fields.activity_code, 'activity code should be optional for New Supplier');

  const submitted = await store.updateRequest(draft.request_id, {
    current_status: SUBMIT_TO_ADMIN,
    attachments: [{ purpose: 'new_supplier_form', filename: 'supplier-form.pdf', stored: 'new-supplier-form' }],
  }, U);
  assert.strictEqual(submitted.current_status, SUBMIT_TO_ADMIN);
  assert.strictEqual(submitted.cost_code, DEFAULT_COST_CODE);
  assert.strictEqual(submitted.activity_code, '');
});

test('the activity code is optional for domestic travel', async () => {
  const draft = await domestic({
    activity_code: '',
    attachments: [
      { purpose: 'travel_request', filename: 't.pdf', stored: 'travel-optional-code-request' },
      { purpose: 'approval_email', filename: 'a.eml', stored: 'travel-optional-code-approval' },
    ],
  });
  const submitted = await store.updateRequest(draft.request_id, { current_status: 'Submitted' }, U);
  assert.strictEqual(submitted.current_status, 'Submitted');
  assert.strictEqual(submitted.cost_code, DEFAULT_COST_CODE);
  assert.strictEqual(submitted.activity_code, '');
});

test('short description is optional for procurement', async () => {
  const sid = await approvedSupplier('NoDesc ' + rnd());
  const draft = await procurement(sid, {
    short_description: '',
    attachments: [
      { purpose: 'quote', filename: 'q.pdf', stored: 'stored-nodesc-q' },
      { purpose: 'approval_email', filename: 'a.eml', stored: 'stored-nodesc-a' },
    ],
  });
  const submitted = await store.updateRequest(draft.request_id, { current_status: SUBMIT_TO_ADMIN }, U);
  assert.strictEqual(submitted.current_status, SUBMIT_TO_ADMIN);
});

test('procurement GST entry modes derive and store before-GST, GST and total amounts', async () => {
  const sid = await approvedSupplier('GST Modes ' + rnd());
  const inclusive = await procurement(sid, {
    gst_entry_method: 'Total includes GST', amount_ex_gst: '', gst_amount: '10', amount_inc_gst: '110',
  });
  assert.strictEqual(inclusive.amount_ex_gst, '100');
  assert.strictEqual(inclusive.amount, '110');

  const gstNotSupplied = await procurement(sid, {
    gst_entry_method: 'Total includes GST', amount_ex_gst: '', gst_amount: '', amount_inc_gst: '55',
  });
  assert.strictEqual(gstNotSupplied.amount_ex_gst, '');
  assert.strictEqual(gstNotSupplied.gst_amount, '');
  assert.strictEqual(gstNotSupplied.amount, '55');
  const submittedWithoutBreakdown = await store.updateRequest(gstNotSupplied.request_id, {
    attachments: [
      { purpose: 'quote', filename: 'q.pdf', stored: 'gst-inclusive-q' },
      { purpose: 'approval_email', filename: 'a.eml', stored: 'gst-inclusive-a' },
    ],
    current_status: SUBMIT_TO_ADMIN,
  }, U);
  assert.strictEqual(submittedWithoutBreakdown.current_status, SUBMIT_TO_ADMIN);
  assert.strictEqual(submittedWithoutBreakdown.gst_amount, '');

  const gstFree = await procurement(sid, {
    gst_entry_method: 'Enter GST separately', amount_ex_gst: '75', gst_amount: '0', amount_inc_gst: '',
  });
  assert.strictEqual(gstFree.amount_inc_gst, '75');
  assert.strictEqual(gstFree.amount, '75');
});

test('procurement no longer requires an approved supplier', async () => {
  const pending = await store.createSupplier({ legal_entity_name: 'Pending Co', purchase_order_email: 'p@c.com' }, U);
  assert.ok(await procurement(pending.supplier_id));
  assert.ok(await procurement('SUP-19000101-999'));
});

test('Other cost and activity codes require and persist their backup values', async () => {
  const draft = await procurement('', {
    supplier_type: 'Existing Supplier',
    cost_code: 'Other', activity_code: 'Other',
    attachments: [
      { purpose: 'quote', filename: 'q.pdf', stored: 'other-code-quote' },
      { purpose: 'approval_email', filename: 'a.eml', stored: 'other-code-approval' },
    ],
  });
  assert.strictEqual(draft.cost_code, 'Other');
  assert.strictEqual(draft.activity_code, 'Other');
  const missing = await assertRejected(() => store.updateRequest(draft.request_id, { current_status: SUBMIT_TO_ADMIN }, U));
  assert.ok(missing.fields.cost_code_other);
  assert.ok(missing.fields.activity_code_other);

  const submitted = await store.updateRequest(draft.request_id, {
    cost_code_other: 'LOCAL-COST-01', activity_code_other: 'LOCAL-ACT-01', current_status: SUBMIT_TO_ADMIN,
  }, U);
  assert.strictEqual(submitted.cost_code_other, 'LOCAL-COST-01');
  assert.strictEqual(submitted.activity_code_other, 'LOCAL-ACT-01');

  const returned = await store.updateRequest(draft.request_id, {
    current_status: RETURN_TO_REQUESTOR, note: 'Use the controlled codes instead.',
    cost_code: '2391', activity_code: '3203',
  }, U);
  assert.strictEqual(returned.cost_code_other, '');
  assert.strictEqual(returned.activity_code_other, '');
});

test('supplier referenced by procurement cannot be downgraded, but can be renamed', async () => {
  const sid = await approvedSupplier('Linked ' + rnd());
  await procurement(sid);
  await assertRejected(() => store.updateSupplier(sid, { status: 'Submitted for approval' }, U));
  const renamed = await store.updateSupplier(sid, { legal_entity_name: 'Linked Renamed Pty' }, U);
  assert.strictEqual(renamed.legal_entity_name, 'Linked Renamed Pty');
});

test('supplier referenced by procurement cannot be deleted', async () => {
  const sid = await approvedSupplier('Refd ' + rnd());
  await procurement(sid);
  await assertRejected(() => store.setSupplierDeleted(sid, true, U));
});

test('the PO step requires both a PO number and the PO document', async () => {
  const sid = await approvedSupplier('PO Gate ' + rnd());
  const p = await procurement(sid, { attachments: [
    { purpose: 'quote', filename: 'q.pdf', stored: 'stored-po-q' },
    { purpose: 'approval_email', filename: 'a.eml', stored: 'stored-po-a' },
  ] });
  const submitted = await store.updateRequest(p.request_id, { current_status: SUBMIT_TO_ADMIN }, U);

  const noPo = await assertRejected(() => store.updateRequest(submitted.request_id, { current_status: PO_ISSUED }, U));
  assert.ok(noPo.fields.po_number && noPo.fields.attachments);

  const noDoc = await assertRejected(() => store.updateRequest(submitted.request_id, { current_status: PO_ISSUED, po_number: 'PO-1' }, U));
  assert.ok(noDoc.fields.attachments);

  const withPo = await store.upsertAttachment(submitted.request_id, {
    purpose: 'po', filename: 'po.pdf', stored: 'stored-po-doc',
  }, U, submitted.last_updated_at);
  const issued = await store.updateRequest(withPo.row.request_id, { current_status: PO_ISSUED, po_number: 'PO-1' }, U);
  assert.strictEqual(issued.waiting_on, 'User');
  assert.match(issued.po_issued_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('only an admin may attach the purchase order', async () => {
  const sid = await approvedSupplier('PO Role ' + rnd());
  const p = await procurement(sid, { attachments: [] });
  const err = await assertRejected(() => store.upsertAttachment(p.request_id, {
    purpose: 'po', filename: 'po.pdf', stored: 'stored-po-role',
  }, U, p.last_updated_at, false), 403);
  assert.match(err.message, /Only Finance/);
});

test('Invoice Received requires the invoice and the email approving its payment', async () => {
  const sid = await approvedSupplier('Invoice Gate ' + rnd());
  const invoiceId = crypto.randomUUID();
  const p = await procurement(sid, { attachments: [
    { purpose: 'quote', filename: 'q.pdf', stored: 'stored-inv-q' },
    { purpose: 'approval_email', filename: 'a.eml', stored: 'stored-inv-a' },
    { purpose: 'po', filename: 'po.pdf', stored: 'stored-inv-po' },
    { purpose: `invoice:${invoiceId}`, filename: 'i.pdf', stored: 'stored-inv-i' },
  ], invoice_items: [{ item_id: invoiceId, invoice_number: 'INV-1', gst_entry_method: 'Enter GST separately', amount_ex_gst: '100', gst_amount: '10', amount_inc_gst: '110' }] });
  const checks = {
    chk_po_included: 'Yes', chk_desc_matches_po: 'Yes', chk_service_completed: 'Yes',
    chk_forwarded_to_approver: 'Yes', chk_forwarded_with_approval: 'Yes',
  };
  const invoiceAmounts = {
    invoice_gst_entry_method: 'Enter GST separately', invoice_amount_ex_gst: '100',
    invoice_gst_amount: '10', invoice_amount: '110',
  };
  // The evidence gates are what this test is about, but a request still has to be in
  // the flow before it can reach the invoice stage — a draft cannot jump there.
  const open = await store.updateRequest(p.request_id, { current_status: SUBMIT_TO_ADMIN }, U);

  const err = await assertRejected(() => store.updateRequest(p.request_id, {
    current_status: INVOICE_RECEIVED, po_number: 'PO-2', invoice_number: 'INV-1', ...invoiceAmounts, ...checks,
  }, U));
  assert.match(err.fields.attachments, /invoice approval email/);

  const ready = await store.upsertAttachment(p.request_id, {
    purpose: 'invoice_approval_email', filename: 'approve.eml', stored: 'stored-inv-approve',
  }, U, open.last_updated_at);

  const noGstMethod = await assertRejected(() => store.updateRequest(ready.row.request_id, {
    current_status: INVOICE_RECEIVED, po_number: 'PO-2', invoice_number: 'INV-1',
    invoice_items: [{ item_id: invoiceId, invoice_number: 'INV-1' }], ...checks,
  }, U));
  assert.ok(noGstMethod.fields.amount_ex_gst || noGstMethod.fields.amount_inc_gst);
  await assertRejected(() => store.updateRequest(ready.row.request_id, {
    current_status: INVOICE_RECEIVED, po_number: 'PO-2', invoice_number: 'INV-1',
    invoice_items: [{ item_id: invoiceId, invoice_number: 'INV-1', amount_ex_gst: '-5', amount_inc_gst: '110' }], ...checks,
  }, U));

  const received = await store.updateRequest(ready.row.request_id, {
    current_status: INVOICE_RECEIVED, po_number: 'PO-2', invoice_number: 'INV-1',
    invoice_items: [{ item_id: invoiceId, invoice_number: 'INV-1', gst_entry_method: 'Enter GST separately', amount_ex_gst: '100', gst_amount: '10', amount_inc_gst: '110' }],
    ...invoiceAmounts, ...checks,
  }, U);
  assert.strictEqual(received.invoice_amount, '110');
  assert.strictEqual(received.waiting_on, 'Finance');
  assert.match(received.invoice_received_at, /^\d{4}-\d{2}-\d{2}T/);

  // Completing it is Finance's step and must name who processed it.
  const done = await store.updateRequest(received.request_id, { current_status: COMPLETE, close_reason: 'Paid' }, U);
  assert.strictEqual(done.waiting_on, '');

  const inclusiveId = crypto.randomUUID();
  const inclusiveInvoice = await procurement(sid, { attachments: [
    { purpose: 'quote', filename: 'q2.pdf', stored: 'stored-inc-q' },
    { purpose: 'approval_email', filename: 'a2.eml', stored: 'stored-inc-a' },
    { purpose: 'po', filename: 'po2.pdf', stored: 'stored-inc-po' },
    { purpose: `invoice:${inclusiveId}`, filename: 'i2.pdf', stored: 'stored-inc-i' },
    { purpose: 'invoice_approval_email', filename: 'ia2.eml', stored: 'stored-inc-ia' },
  ], invoice_items: [{ item_id: inclusiveId, invoice_number: 'INV-INC', gst_entry_method: 'Total includes GST', amount_inc_gst: '122' }] });
  await store.updateRequest(inclusiveInvoice.request_id, { current_status: SUBMIT_TO_ADMIN }, U);
  const inclusiveReceived = await store.updateRequest(inclusiveInvoice.request_id, {
    current_status: INVOICE_RECEIVED, po_number: 'PO-INC', invoice_number: 'INV-INC',
    invoice_gst_entry_method: 'Total includes GST', invoice_amount_ex_gst: '',
    invoice_gst_amount: '', invoice_amount: '122', ...checks,
  }, U);
  assert.strictEqual(inclusiveReceived.invoice_gst_amount, '');
  assert.strictEqual(inclusiveReceived.invoice_amount_ex_gst, '');
  assert.strictEqual(inclusiveReceived.invoice_amount, '122');
});

test('retired procurement statuses are rejected', async () => {
  const sid = await approvedSupplier('Retired ' + rnd());
  const p = await procurement(sid);
  for (const status of ['Accepted by Finance', 'Requisition Requested', 'PO Issued',
    'PO Forwarded to Requester', 'Ready for Invoice Processing', 'Processed in OneEd']) {
    await assertRejected(() => store.updateRequest(p.request_id, { current_status: status }, U));
  }
});

// --- Travel: Domestic ---

test('domestic travel happy path', async () => {
  const t = await domestic();
  assert.strictEqual(t.sub_type, 'Domestic');
  assert.strictEqual(t.has_attachments, 'Yes');
});

test('draft can be saved without files, but submission requires real uploaded files', async () => {
  const draft = await domestic({ attachments: [] });
  const err = await assertRejected(() => store.updateRequest(draft.request_id, { current_status: 'Submitted' }, U));
  assert.ok(err.fields.attachments);
  const ready = await store.updateRequest(draft.request_id, { attachments: [
    { purpose: 'travel_request', filename: 't.pdf', stored: 'stored-t' },
    { purpose: 'approval_email', filename: 'a.eml', stored: 'stored-a' },
  ] }, U);
  const submitted = await store.updateRequest(ready.request_id, { current_status: 'Submitted' }, U);
  assert.strictEqual(submitted.current_status, 'Submitted');
});

test('domestic travel: return date before departure is rejected', async () => {
  const err = await assertRejected(() => domestic({ travel_end_date: '2026-08-31' }));
  assert.ok(err.fields.travel_end_date);
});

test('domestic travel: activity code is valid independently of the cost code', async () => {
  const row = await domestic({
    cost_code: 'Other',
    cost_code_other: 'LOCAL-COST-01',
    activity_code: '3203',
    attachments: [
      { purpose: 'travel_request', filename: 't.pdf', stored: 'independent-travel' },
      { purpose: 'approval_email', filename: 'a.eml', stored: 'independent-approval' },
    ],
  });
  const submitted = await store.updateRequest(row.request_id, { current_status: 'Submitted' }, U);
  assert.strictEqual(submitted.activity_code, '3203');
  assert.strictEqual(submitted.cost_code_other, 'LOCAL-COST-01');
});

// --- Travel: Reimbursement ---

test('reimbursement totals the line items into amount', async () => {
  const r = await reimbursement([
    { category: 'Meals', amount: '20', supplier: 'Cafe', description: '', receipt: 'r1.pdf' },
    { category: 'Fuel', amount: '50.50', supplier: '', description: '', receipt: 'r2.pdf' },
  ]);
  assert.strictEqual(r.amount, '70.5');
  assert.ok(JSON.parse(r.reimbursement_items).every((item) => !Object.prototype.hasOwnProperty.call(item, 'supplier')),
    'removed reimbursement Supplier values must not be stored');
});

test('reimbursement totals use exclusive GST when a line has no inclusive total', async () => {
  const r = await reimbursement([
    { category: 'Meals', amount: '', amount_ex_gst: '20', gst_entry_method: '', supplier: 'Cafe', description: '', receipt: 'r1.pdf' },
    { category: 'Fuel', amount: '50.50', amount_ex_gst: '', gst_entry_method: '', supplier: '', description: '', receipt: 'r2.pdf' },
  ]);
  assert.strictEqual(r.amount, '70.5');
});

// --- attachment volume limits ---
//
// Attachments are stored one per purpose, so the fixed purposes cannot pile up. The
// open-ended one is receipt:<item UUID> — one per expense line — which makes the line
// count the real disk budget.

const line = (n) => ({ category: 'Fuel', amount: '1', description: '', receipt: `r${n}.pdf` });

test('a reimbursement cannot carry more expense lines than the cap', async () => {
  const overCap = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => line(i + 1));
  const err = await assertRejected(() => reimbursement(overCap), 400);
  assert.match(err.fields.reimbursement_items, new RegExp(`more than ${MAX_ITEMS} expense lines`));
});

test('a reimbursement sitting exactly on the cap is still accepted', async () => {
  const atCap = Array.from({ length: MAX_ITEMS }, (_, i) => line(i + 1));
  const row = await reimbursement(atCap);
  assert.strictEqual(JSON.parse(row.reimbursement_items).length, MAX_ITEMS);
});

test('a request cannot hold more attachment bytes than one request is allowed', async () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ ...line(i + 1), item_id: crypto.randomUUID() }));
  const halfGig = items.map((item, i) => ({
    purpose: `receipt:${item.item_id}`, filename: `r${i + 1}.pdf`, stored: `bulk-${i + 1}`, size: 9 * 1024 * 1024,
  }));
  const err = await assertRejected(() => reimbursement(
    items,
    { attachments: [
      { purpose: 'reimbursement_form', filename: 'reimbursement-form.pdf', size: 1024 },
      { purpose: 'approval_email', filename: 'a.eml', size: 1024 },
      ...halfGig,
    ] }
  ), 400);
  assert.match(err.fields.attachments, /over the 200 MB a single request may hold/);
});

test('an ordinary claim is nowhere near either limit', async () => {
  const items = [line(1), line(2)].map((item) => ({ ...item, item_id: crypto.randomUUID() }));
  const row = await reimbursement(items, {
    attachments: [
      { purpose: 'reimbursement_form', filename: 'reimbursement-form.pdf', size: 40 * 1024 },
      { purpose: 'approval_email', filename: 'a.eml', size: 40 * 1024 },
      { purpose: `receipt:${items[0].item_id}`, filename: 'r1.pdf', size: 2 * 1024 * 1024 },
      { purpose: `receipt:${items[1].item_id}`, filename: 'r2.pdf', size: 3 * 1024 * 1024 },
    ],
  });
  assert.strictEqual(JSON.parse(row.attachments).length, 4);
});

// --- open-draft quota ---
//
// The per-request limits bound one request; without this they bound nothing in aggregate,
// because a requester can open drafts forever and never has to submit one.

const QUOTA_USER = 'quota-tester';

// A person of their own per test, so one test's drafts can never spill into another's
// count — and so the shared fixtures above, which resolve to the seeded people, stay out
// of the way entirely.
async function quotaPerson() {
  const person = await store.createPerson({
    display_name: `Quota Person ${rnd()}${rnd()}`, active: 'Yes', can_request: 'Yes', can_travel: 'Yes',
  });
  return person.person_id;
}

// Complete rather than minimal, so a draft can actually be moved out of Draft when the
// test needs to prove that releases its slot.
const quotaDraft = (person, user = QUOTA_USER, opts) => store.createRequest({
  request_type: 'Travel', sub_type: 'Domestic', received_date: '2026-08-03',
  requester_person_id: person, beneficiary_name: 'Bob',
  cost_code: '2391', activity_code: '3270',
  destination: 'Sydney', travel_start_date: '2026-09-01', travel_end_date: '2026-09-05',
  attachments: [
    { purpose: 'travel_request', filename: 't.pdf', stored: `q-tr-${rnd()}${rnd()}` },
    { purpose: 'approval_email', filename: 'a.eml', stored: `q-ae-${rnd()}${rnd()}` },
  ],
}, user, opts);

test('a requester is cut off after the open-draft limit', async () => {
  const person = await quotaPerson();
  for (let i = 0; i < MAX_DRAFTS; i++) await quotaDraft(person);
  const err = await assertRejected(() => quotaDraft(person), 409);
  assert.match(err.message, new RegExp(`limit is ${MAX_DRAFTS}`));
});

test('a draft that leaves Draft, or is discarded, frees a slot', async () => {
  const person = await quotaPerson();
  const first = await quotaDraft(person);
  for (let i = 1; i < MAX_DRAFTS; i++) await quotaDraft(person);
  await assertRejected(() => quotaDraft(person), 409);

  // Only open drafts are counted, so moving one out of Draft releases its slot.
  await store.updateRequest(first.request_id, { current_status: 'Cancelled' }, QUOTA_USER);
  const next = await quotaDraft(person);
  assert.strictEqual(next.current_status, 'Draft');

  await assertRejected(() => quotaDraft(person), 409);
  await store.hardDeleteDraft(next.request_id);
  assert.ok(await quotaDraft(person), 'discarding a draft did not free a slot');
});

test('the quota is per requester, not global, and finance is exempt', async () => {
  const busy = await quotaPerson();
  for (let i = 0; i < MAX_DRAFTS; i++) await quotaDraft(busy);
  await assertRejected(() => quotaDraft(busy), 409);

  const other = await quotaPerson();
  assert.ok(await quotaDraft(other), 'one requester at the limit blocked another');

  const onBehalf = await quotaDraft(busy, 'finance-officer', { isAdmin: true });
  assert.strictEqual(onBehalf.current_status, 'Draft', 'finance was blocked by a requester quota');
});

test('reimbursement derives GST per expense line and sums the inclusive totals', async () => {
  const lineIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const row = await reimbursement([
    { item_id: lineIds[0], category: 'Fuel', gst_entry_method: 'Total includes GST', amount: '55', amount_ex_gst: '', gst_amount: '5', receipt: 'a.pdf' },
    { item_id: lineIds[1], category: 'Fuel', gst_entry_method: 'Enter GST separately', amount: '', amount_ex_gst: '20', gst_amount: '0', receipt: 'b.pdf' },
    { item_id: lineIds[2], category: 'Fuel', gst_entry_method: 'Total includes GST', amount: '30', amount_ex_gst: '', gst_amount: '', receipt: 'c.pdf' },
  ], { attachments: [
    { purpose: 'reimbursement_form', filename: 'reimbursement-form.pdf', stored: 'gst-lines-form' },
    { purpose: 'approval_email', filename: 'approval.eml', stored: 'gst-lines-approval' },
    { purpose: `receipt:${lineIds[0]}`, filename: 'a.pdf', stored: 'gst-line-1' },
    { purpose: `receipt:${lineIds[1]}`, filename: 'b.pdf', stored: 'gst-line-2' },
    { purpose: `receipt:${lineIds[2]}`, filename: 'c.pdf', stored: 'gst-line-3' },
  ] });
  const submitted = await store.updateRequest(row.request_id, { current_status: 'Submitted' }, U);
  const items = JSON.parse(submitted.reimbursement_items);
  assert.strictEqual(items[0].amount_ex_gst, '50');
  assert.strictEqual(items[1].amount, '20');
  assert.strictEqual(items[2].gst_amount, '');
  assert.strictEqual(items[2].amount_ex_gst, '');
  assert.strictEqual(submitted.amount, '105');
});

test('reimbursement requires at least one line', async () => {
  const draft = await reimbursement([]);
  const err = await assertRejected(() => store.updateRequest(draft.request_id, { current_status: 'Submitted' }, U));
  assert.ok(err.fields.reimbursement_items);
});

test('reimbursement line rules', async () => {
  const mealsWithoutSupplier = await reimbursement([
    { category: 'Meals', amount: '10', description: '', receipt: 'r.pdf' },
  ]);
  assert.ok(mealsWithoutSupplier, 'Meals should not require a supplier input');

  const otherWithoutSupplier = await reimbursement([
    { category: 'Other - specify', amount: '10', description: 'Taxi to airport', receipt: 'r.pdf' },
  ]);
  assert.ok(otherWithoutSupplier, 'Other expense lines should not require a supplier input');

  for (const item of [
    { category: 'Other - specify', amount: '10', description: '', receipt: 'r.pdf' },
    { category: 'Fuel', amount: '-5', description: '', receipt: 'r.pdf' },
    { category: 'Fuel', amount: '5', description: '', receipt: '' },
    { category: 'Bribes', amount: '5', description: '', receipt: 'r.pdf' },
  ]) {
    const draft = await reimbursement([item]);
    await assertRejected(() => store.updateRequest(draft.request_id, { current_status: 'Submitted' }, U));
  }
});

test('attachment purposes are restricted by request subtype', async () => {
  const sid = await approvedSupplier('Attachment Matrix ' + rnd());
  const purchase = await procurement(sid, { attachments: [] });
  await assertRejected(() => store.upsertAttachment(purchase.request_id, {
    purpose: 'travel_request', filename: 'wrong.pdf', stored: 'wrong-travel',
  }, U, purchase.last_updated_at), 400);
  const quote = await store.upsertAttachment(purchase.request_id, {
    purpose: 'quote', filename: 'quote.pdf', stored: 'stored-quote-matrix',
  }, U, purchase.last_updated_at);
  const invoiceId = crypto.randomUUID();
  const staged = await store.updateRequest(purchase.request_id, {
    invoice_items: [{ item_id: invoiceId, invoice_number: 'INV-MATRIX', amount_inc_gst: '10' }],
  }, U, quote.row.last_updated_at);
  await store.upsertAttachment(purchase.request_id, {
    purpose: `invoice:${invoiceId}`, filename: 'invoice.pdf', stored: 'stored-invoice-matrix',
  }, U, staged.last_updated_at);
  await store.upsertAttachment(purchase.request_id, {
    purpose: `invoice_other:${invoiceId}:${crypto.randomUUID()}`, filename: 'delivery-docket.pdf', stored: 'stored-invoice-other-matrix',
  }, U);
  await store.upsertAttachment(purchase.request_id, {
    purpose: `invoice_approval_other:${crypto.randomUUID()}`, filename: 'second-approval.eml', stored: 'stored-approval-other-matrix',
  }, U);

  const travel = await domestic({ attachments: [] });
  await assertRejected(() => store.upsertAttachment(travel.request_id, {
    purpose: `invoice:${crypto.randomUUID()}`, filename: 'wrong.pdf', stored: 'wrong-invoice',
  }, U, travel.last_updated_at), 400);
  await assertRejected(() => store.upsertAttachment(travel.request_id, {
    purpose: `invoice_other:${crypto.randomUUID()}:${crypto.randomUUID()}`, filename: 'wrong-other.pdf', stored: 'wrong-invoice-other',
  }, U, travel.last_updated_at), 400);
  await assertRejected(() => store.upsertAttachment(travel.request_id, {
    purpose: `invoice_approval_other:${crypto.randomUUID()}`, filename: 'wrong-approval.pdf', stored: 'wrong-approval-other',
  }, U, travel.last_updated_at), 400);
});

test('draft attachments can be removed but submitted evidence is locked', async () => {
  const draft = await domestic({ attachments: [] });
  const withFile = await store.upsertAttachment(draft.request_id, {
    purpose: 'travel_request', filename: 'travel.pdf', stored: 'stored-removable-travel',
  }, U, draft.last_updated_at);
  const removed = await store.removeAttachment(draft.request_id, 'travel_request', U, withFile.row.last_updated_at, false);
  assert.deepStrictEqual(JSON.parse(removed.row.attachments || '[]'), []);
  assert.strictEqual(removed.removed.filename, 'travel.pdf');

  const ready = await store.updateRequest(removed.row.request_id, { attachments: [
    { purpose: 'travel_request', filename: 'travel.pdf', stored: 'stored-locked-travel' },
    { purpose: 'approval_email', filename: 'approval.eml', stored: 'stored-locked-approval' },
  ] }, U, removed.row.last_updated_at);
  const submitted = await store.updateRequest(ready.request_id, { current_status: 'Submitted' }, U, ready.last_updated_at);
  await assertRejected(() => store.removeAttachment(submitted.request_id, 'travel_request', U, submitted.last_updated_at, false), 409);
});

test('reimbursement accepts only line-specific receipts for existing lines', async () => {
  const draft = await reimbursement([{ category: 'Fuel', amount: '5', supplier: '', description: '', receipt: 'r.pdf' }], { attachments: [] });
  const itemId = JSON.parse(draft.reimbursement_items)[0].item_id;
  await assertRejected(() => store.upsertAttachment(draft.request_id, {
    purpose: 'receipt', filename: 'r.pdf', stored: 'generic-receipt',
  }, U, draft.last_updated_at), 400);
  await assertRejected(() => store.upsertAttachment(draft.request_id, {
    purpose: `receipt:${crypto.randomUUID()}`, filename: 'r2.pdf', stored: 'wrong-line',
  }, U, draft.last_updated_at), 400);
  const saved = await store.upsertAttachment(draft.request_id, {
    purpose: `receipt:${itemId}`, filename: 'r.pdf', stored: 'right-line',
  }, U, draft.last_updated_at);
  assert.strictEqual(saved.row.has_attachments, 'Yes');
});

// --- lifecycle + guards ---

test('status changes set waiting_on and lifecycle timestamps', async () => {
  const sid = await approvedSupplier('WO ' + rnd());
  const p = await procurement(sid, { attachments: [
    { purpose: 'quote', filename: 'q.pdf', stored: 'stored-q' },
    { purpose: 'approval_email', filename: 'a.eml', stored: 'stored-a' },
  ] });
  const submitted = await store.updateRequest(p.request_id, { current_status: SUBMIT_TO_ADMIN }, U);
  assert.strictEqual(submitted.waiting_on, 'Finance');
  assert.match(submitted.submitted_at, /^\d{4}-\d{2}-\d{2}T/);
  const missingReason = await assertRejected(() => store.updateRequest(p.request_id, { current_status: RETURN_TO_REQUESTOR }, U));
  assert.ok(missingReason.fields.note);
  const returned = await store.updateRequest(p.request_id, {
    current_status: RETURN_TO_REQUESTOR,
    note: 'Please upload a readable approval email and confirm the activity code.',
  }, U);
  assert.strictEqual(returned.waiting_on, 'User');
  const resubmitted = await store.updateRequest(returned.request_id, {
    current_status: SUBMIT_TO_ADMIN,
    note: 'Activity code confirmed and approval email replaced.',
  }, U);
  assert.strictEqual(resubmitted.waiting_on, 'Finance');
});

test('concurrent creates get unique IDs and a stale update is rejected', async () => {
  const created = await Promise.all(Array.from({ length: 12 }, (_, i) => domestic({
    beneficiary_name: `Concurrent ${i}`,
  })));
  assert.strictEqual(new Set(created.map((r) => r.request_id)).size, created.length);

  const target = created[0];
  const results = await Promise.allSettled([
    store.updateRequest(target.request_id, { destination: 'Alice update' }, 'alice'),
    store.updateRequest(target.request_id, { notes: 'Bob update' }, 'bob'),
  ]);
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.strictEqual(rejected.reason.status, 409);
});

test('reimbursement submission requires a stored receipt for every line', async () => {
  const draft = await reimbursement([
    { category: 'Fuel', amount: '10', supplier: '', description: '', receipt: 'fuel.pdf' },
  ], { attachments: [
    { purpose: 'reimbursement_form', filename: 'reimbursement-form.pdf', stored: 'stored-form' },
    { purpose: 'approval_email', filename: 'a.eml', stored: 'stored-a' },
  ] });
  const err = await assertRejected(() => store.updateRequest(draft.request_id, { current_status: 'Submitted' }, U));
  assert.ok(err.fields.attachments);
  const ready = await store.updateRequest(draft.request_id, { attachments: [
    { purpose: 'reimbursement_form', filename: 'reimbursement-form.pdf', stored: 'stored-form' },
    { purpose: 'approval_email', filename: 'a.eml', stored: 'stored-a' },
    { purpose: `receipt:${JSON.parse(draft.reimbursement_items)[0].item_id}`, filename: 'fuel.pdf', stored: 'stored-r' },
  ] }, U);
  const submitted = await store.updateRequest(ready.request_id, { current_status: 'Submitted' }, U);
  assert.strictEqual(submitted.current_status, 'Submitted');
});

test('soft-deleted records cannot be edited (409)', async () => {
  const t = await domestic();
  await store.setDeleted(t.request_id, true, U);
  await assertRejected(() => store.updateRequest(t.request_id, { destination: 'Perth' }, U), 409);
});

test('a draft can be permanently discarded without retaining request history', async () => {
  const draft = await domestic();
  await store.hardDeleteDraft(draft.request_id);
  assert.strictEqual(await store.getRequestById(draft.request_id), null);
  assert.deepStrictEqual(await store.getRequestHistory(draft.request_id), []);
  await assertRejected(() => store.hardDeleteDraft(draft.request_id), 404);
});

test('internal admin notes are stored as distinct history events', async () => {
  const draft = await domestic();
  const updated = await store.updateRequest(draft.request_id, { internal_note: 'Finance-only context' }, 'admin');
  assert.ok(updated.last_updated_at);
  const event = (await store.getRequestHistory(draft.request_id)).at(-1);
  assert.strictEqual(event.event_type, 'Internal Note');
  assert.strictEqual(event.note, 'Finance-only context');
});

test('unknown fields are rejected', async () => {
  const t = await domestic();
  const err = await assertRejected(() => store.updateRequest(t.request_id, { made_up: 'x' }, U));
  assert.ok(err.fields.made_up);
});

test('invalid sub_type is rejected', async () => {
  const err = await assertRejected(() => store.createRequest({ request_type: 'Travel', sub_type: 'Teleportation', received_date: '2026-08-03', beneficiary_name: 'B' }, U));
  assert.ok(err.fields.sub_type);
});

test('New Supplier is no longer a valid request type', async () => {
  await assertRejected(() => store.createRequest({ request_type: 'New Supplier', received_date: '2026-08-03', legal_entity_name: 'X', purchase_order_email: 'x@y.com' }, U));
});

test('localDate returns YYYY-MM-DD', () => {
  assert.match(store.localDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('new procurement flow supports an unregistered supplier, multiple invoices, and close reason', async () => {
  const row = await store.createRequest({
    request_type: 'Procurement', sub_type: 'Purchase / PO request', received_date: '2026-08-03',
    requester_name: 'Alice', supplier_type: 'New Supplier', supplier_quote_number: 'Q-NEW',
    cost_code: '2391', activity_code: '3203', amount_ex_gst: '100', amount_inc_gst: '110',
    spending_approver: 'Jane Manager', attachments: [
      { purpose: 'quote', filename: 'q.pdf', stored: 'new-q' },
      { purpose: 'approval_email', filename: 'a.eml', stored: 'new-a' },
      { purpose: 'new_supplier_form', filename: 'supplier-form.pdf', stored: 'new-sf' },
    ],
  }, U, FIXTURE_AS_FINANCE);
  const submitted = await store.updateRequest(row.request_id, { current_status: SUBMIT_TO_ADMIN }, U);
  const po = await store.updateRequest(row.request_id, {
    current_status: PO_ISSUED, po_number: 'PO-100',
    attachments: [...JSON.parse(submitted.attachments), { purpose: 'po', filename: 'po.pdf', stored: 'new-po' }],
  }, U);
  // Stable invoice rows are saved before files, so every upload has a relational owner.
  const invoiceItems = [
    { item_id: crypto.randomUUID(), invoice_number: 'INV-1', amount_ex_gst: '20', amount_inc_gst: '22' },
    { item_id: crypto.randomUUID(), invoice_number: 'INV-2', amount_ex_gst: '30', amount_inc_gst: '33' },
  ];
  const invoiceDraft = await store.updateRequest(row.request_id, { invoice_items: invoiceItems }, U, po.last_updated_at);
  const firstInvoice = await store.upsertAttachment(row.request_id,
    { purpose: `invoice:${invoiceItems[0].item_id}`, filename: 'inv-1.pdf', stored: 'new-i1' }, U, invoiceDraft.last_updated_at);
  const secondInvoice = await store.upsertAttachment(row.request_id,
    { purpose: `invoice:${invoiceItems[1].item_id}`, filename: 'inv-2.pdf', stored: 'new-i2' }, U, firstInvoice.row.last_updated_at);
  const received = await store.updateRequest(row.request_id, {
    current_status: INVOICE_RECEIVED, invoice_items: invoiceItems,
    attachments: [...JSON.parse(secondInvoice.row.attachments),
      { purpose: 'invoice_approval_email', filename: 'invoice-approval.eml', stored: 'new-ia' }],
    chk_po_included: 'Yes', chk_desc_matches_po: 'Yes', chk_service_completed: 'Yes', chk_forwarded_to_approver: 'Yes',
  }, U, secondInvoice.row.last_updated_at);
  assert.strictEqual(JSON.parse(received.invoice_items).length, 2);
  const lines = await store.updateRequest(row.request_id, { current_status: RETURN_ORDER_LINES }, U);
  const closed = await store.updateRequest(row.request_id, { current_status: COMPLETE, close_reason: 'Paid' }, U);
  assert.strictEqual(lines.waiting_on, 'Finance');
  assert.strictEqual(closed.close_reason, 'Paid');
  assert.strictEqual(closed.waiting_on, '');
});

test('procurement accepts either GST total and can hold multiple Other Documents', async () => {
  const row = await store.createRequest({
    request_type: 'Procurement', sub_type: 'Purchase / PO request', received_date: '2026-08-03',
    requester_name: 'Alice', supplier_type: 'Existing Supplier', supplier_quote_number: 'Q-OTHER',
    cost_code: '2391', activity_code: '3203', amount_ex_gst: '100',
    spending_approver: 'Jane Manager', attachments: [
      { purpose: 'quote', filename: 'q.pdf' }, { purpose: 'approval_email', filename: 'a.eml' },
    ],
  }, U, FIXTURE_AS_FINANCE);
  assert.strictEqual(row.amount, '100');
  const edited = await store.updateRequest(row.request_id, { supplier_type: 'New Supplier' }, U, row.last_updated_at);
  assert.strictEqual(edited.supplier_type, 'New Supplier');
  const firstOther = `other_document:${crypto.randomUUID()}`;
  const secondOther = `other_document:${crypto.randomUUID()}`;
  const one = await store.upsertAttachment(row.request_id,
    { purpose: firstOther, filename: 'one.pdf', stored: 'other-1' }, U, edited.last_updated_at);
  const two = await store.upsertAttachment(row.request_id,
    { purpose: secondOther, filename: 'two.pdf', stored: 'other-2' }, U, one.row.last_updated_at);
  assert.strictEqual(JSON.parse(two.row.attachments).filter((item) => item.purpose.startsWith('other_document:')).length, 2);
  const removed = await store.removeAttachment(row.request_id, firstOther, U, two.row.last_updated_at, true);
  assert.strictEqual(JSON.parse(removed.row.attachments).some((item) => item.purpose === firstOther), false);
});
