'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { migrateRows } = require('../lib/migrate');

test('migrates old types to type + sub_type and backfills supplier_id', () => {
  const rows = [
    { request_id: 'S1', request_type: 'New Supplier', legal_entity_name: 'Acme', current_status: 'Approved', deleted: '' },
    { request_id: 'P1', request_type: 'Purchase Order', supplier_name: 'Acme', amount: '100', current_status: 'PO Issued', received_date: '2026-07-14' },
    { request_id: 'T1', request_type: 'Travel Allowance', beneficiary_name: 'Bob', current_status: 'Submitted for approval', received_date: '2026-07-13' },
    { request_id: 'R1', request_type: 'Reimbursement', current_status: 'New', received_date: '2026-07-13' },
  ];
  const { rows: out, report } = migrateRows(rows);
  const by = Object.fromEntries(out.map((r) => [r.request_id, r]));

  assert.strictEqual(by.S1.request_type, 'New Supplier'); // unchanged
  assert.strictEqual(by.P1.request_type, 'Procurement');
  assert.strictEqual(by.P1.sub_type, 'Purchase / PO request');
  assert.strictEqual(by.P1.supplier_id, 'S1'); // backfilled from unique name match
  assert.strictEqual(by.P1.amount_ex_gst, '100');
  assert.strictEqual(by.P1.current_status, 'PO issued to user');
  assert.strictEqual(by.P1.waiting_on, 'User');

  assert.strictEqual(by.T1.request_type, 'Travel');
  assert.strictEqual(by.T1.sub_type, 'Travel Allowance - meals/incidentals');
  assert.strictEqual(by.T1.current_status, 'Submitted');

  assert.strictEqual(by.R1.request_type, 'Travel');
  assert.strictEqual(by.R1.sub_type, 'Reimbursement');

  assert.strictEqual(report.migrated, 3);
  assert.strictEqual(report.unchanged, 1);
  assert.strictEqual(report.supplierBackfilled.length, 1);
  // R1 has no line items -> flagged incomplete.
  assert.ok(report.incomplete.some((i) => i.request_id === 'R1' && i.missing.includes('reimbursement_items')));
});

test('ambiguous / missing supplier matches are reported, never guessed', () => {
  const rows = [
    { request_id: 'S1', request_type: 'New Supplier', legal_entity_name: 'Dup', current_status: 'Approved', deleted: '' },
    { request_id: 'S2', request_type: 'New Supplier', legal_entity_name: 'Dup', current_status: 'Approved', deleted: '' },
    { request_id: 'P1', request_type: 'Purchase Order', supplier_name: 'Dup', amount: '10', current_status: 'PO Issued', received_date: '2026-07-14' },
    { request_id: 'P2', request_type: 'Purchase Order', supplier_name: 'Ghost', amount: '10', current_status: 'PO Issued', received_date: '2026-07-14' },
  ];
  const { rows: out, report } = migrateRows(rows);
  const by = Object.fromEntries(out.map((r) => [r.request_id, r]));
  assert.strictEqual(by.P1.supplier_id || '', ''); // ambiguous -> not set
  assert.strictEqual(by.P2.supplier_id || '', ''); // no match -> not set
  assert.strictEqual(report.supplierUnmatched.length, 2);
});

test('migration is idempotent (new-model rows pass through)', () => {
  const rows = [
    { request_id: 'P1', request_type: 'Procurement', sub_type: 'Purchase / PO request', current_status: 'Submitted' },
  ];
  const { report } = migrateRows(rows);
  assert.strictEqual(report.migrated, 0);
  assert.strictEqual(report.unchanged, 1);
});
