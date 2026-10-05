'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const csv = require('../lib/csv');
const { CURRENT_COLUMNS, LOG_COLUMNS, USER_COLUMNS } = require('../lib/constants');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frt-csv-contract-'));
process.env.DATA_DIR = TMP;
delete process.env.STORAGE;

const currentFile = path.join(TMP, 'requests_current.csv');
const logFile = path.join(TMP, 'request_status_log.csv');
const usersFile = path.join(TMP, 'users.csv');
const oldCurrentColumns = CURRENT_COLUMNS.filter((column) => column !== 'created_at');
const oldLogColumns = ['event_id', 'request_id', 'event_time', 'event_type', 'old_status', 'new_status', 'changed_by', 'note', 'changed_fields'];

const reimbursement = Object.fromEntries(oldCurrentColumns.map((column) => [column, '']));
Object.assign(reimbursement, {
  request_id: 'FR-OLD-001', request_type: 'Reimbursement', sub_type: 'Reimbursement',
  reimbursement_items: JSON.stringify([{ category: 'Meals', amount: '11', receipt: 'meal.pdf' }]),
  attachments: JSON.stringify([{ purpose: 'receipt:1', filename: 'meal.pdf', stored: 'meal-stored' }]),
  last_updated_at: '2026-08-02T00:00:00.000Z',
});
const procurement = Object.fromEntries(oldCurrentColumns.map((column) => [column, '']));
Object.assign(procurement, {
  request_id: 'FR-OLD-002', request_type: 'Procurement', sub_type: 'Purchase / PO request',
  invoice_items: JSON.stringify([{ invoice_number: 'INV-1', amount_inc_gst: '110' }]),
  attachments: JSON.stringify([
    { purpose: 'invoice:1', filename: 'invoice.pdf', stored: 'invoice-stored' },
    { purpose: 'invoice_other:1:1', filename: 'support.pdf', stored: 'support-stored' },
    { purpose: 'other_document:1', filename: 'other.pdf', stored: 'other-stored' },
  ]),
  last_updated_at: '2026-08-03T00:00:00.000Z',
});

fs.writeFileSync(currentFile, csv.stringify([reimbursement, procurement], oldCurrentColumns));
fs.writeFileSync(logFile, csv.stringify([
  { event_id: 'old-1', request_id: 'FR-OLD-001', event_time: '2026-08-01T01:02:03.123Z', event_type: 'Created', old_status: '', new_status: 'Draft', changed_by: 'owner@example.com', note: '', changed_fields: '' },
  { event_id: 'old-2', request_id: 'FR-OLD-002', event_time: '2026-08-01T02:03:04.234Z', event_type: 'Created', old_status: '', new_status: 'Draft', changed_by: 'owner@example.com', note: '', changed_fields: '' },
], oldLogColumns));
fs.writeFileSync(usersFile, csv.stringify([{
  username: 'owner@example.com', password_hash: 'salt:hash', role: 'requester',
  person_id: 'PER-900', display_name: 'Owner', active: 'Yes', password_version: '0',
}], USER_COLUMNS));

const repoCsv = require('../lib/repoCsv');

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

test('CSV startup migration produces the current stable-ID contract idempotently', async () => {
  await repoCsv.init();
  const firstCurrent = fs.readFileSync(currentFile, 'utf8');
  const firstLog = fs.readFileSync(logFile, 'utf8');
  assert.equal(firstCurrent.split(/\r?\n/, 1)[0], CURRENT_COLUMNS.join(','));
  assert.equal(firstLog.split(/\r?\n/, 1)[0], LOG_COLUMNS.join(','));

  const rows = csv.parse(firstCurrent);
  const reimb = rows.find((row) => row.request_id === 'FR-OLD-001');
  const procurementBack = rows.find((row) => row.request_id === 'FR-OLD-002');
  const reimbItem = JSON.parse(reimb.reimbursement_items)[0];
  const reimbAttachment = JSON.parse(reimb.attachments)[0];
  const invoiceItem = JSON.parse(procurementBack.invoice_items)[0];
  const procurementAttachments = JSON.parse(procurementBack.attachments);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  assert.match(reimbItem.item_id, uuid);
  assert.match(reimbAttachment.attachment_id, uuid);
  assert.equal(reimbAttachment.purpose, `receipt:${reimbItem.item_id}`);
  assert.match(invoiceItem.item_id, uuid);
  assert.equal(procurementAttachments[0].purpose, `invoice:${invoiceItem.item_id}`);
  assert.equal(procurementAttachments[1].purpose, `invoice_other:${invoiceItem.item_id}:${procurementAttachments[1].attachment_id}`);
  assert.equal(procurementAttachments[2].purpose, `other_document:${procurementAttachments[2].attachment_id}`);
  assert.equal(reimb.created_at, '2026-08-01T01:02:03.123Z');

  const log = csv.parse(firstLog);
  assert.match(log[0].event_id, uuid);
  assert.match(log[1].event_id, uuid);
  assert.equal(log[0].changed_by_username, 'owner@example.com');
  assert.equal(log[0].changed_by_person_id, 'PER-900');
  assert.equal(log[0].changed_by_role, 'requester');

  await repoCsv.init();
  assert.equal(fs.readFileSync(currentFile, 'utf8'), firstCurrent);
  assert.equal(fs.readFileSync(logFile, 'utf8'), firstLog);
});
