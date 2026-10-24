'use strict';

const repo = require('../lib/repoCsv');
const { CURRENT_COLUMNS } = require('../lib/constants');

const SEED_IDS = Array.from(
  { length: 40 },
  (_, index) => `FR-20261024-${String(951 + index).padStart(3, '0')}`,
);

function emptyRow() {
  return Object.fromEntries(CURRENT_COLUMNS.map((column) => [column, '']));
}

function requestRow(overrides) {
  return {
    ...emptyRow(),
    currency: 'AUD',
    cost_code: '2391',
    activity_code: '3203',
    requester_person_id: 'PER-002',
    requester_name: 'Demo Requester One',
    has_attachments: 'No',
    deleted: '',
    attachments: '[]',
    reimbursement_items: '[]',
    invoice_items: '[]',
    created_at: '2026-10-01T01:00:00.000Z',
    last_updated_at: '2026-10-01T01:00:00.000Z',
    ...overrides,
  };
}

function daysAgo(days, hour = 2) {
  return new Date(Date.UTC(2026, 9, 24 - days, hour, 0, 0)).toISOString();
}

function dateOnly(iso) {
  return String(iso).slice(0, 10);
}

function generatedSeedRow(id, index) {
  const profiles = [
    ['Reimbursement', 'Reimbursement', 'Submitted', 'Finance'],
    ['Reimbursement', 'Reimbursement', 'Returned for Info', 'User'],
    ['Reimbursement', 'Reimbursement', 'In Progress', 'Finance'],
    ['Procurement', 'Purchase / PO request', 'Submit to Admin', 'Finance'],
    ['Procurement', 'Purchase / PO request', 'Submit to Approver', 'Approver'],
    ['Procurement', 'Purchase / PO request', 'Requisition submitted', 'Finance'],
    ['Travel', 'Domestic', 'Submitted', 'Finance'],
    ['Travel', 'International', 'In Progress', 'Finance'],
    ['Travel', 'Domestic', 'Processed in External System', 'External System'],
    ['Travel Allowance', 'Meals/incidentals', 'Submitted', 'Finance'],
    ['Travel Allowance', 'Meals/incidentals', 'Returned for Info', 'User'],
    ['Travel Allowance', 'Meals/incidentals', 'In Progress', 'Finance'],
    ['Reimbursement', 'Reimbursement', 'Completed', ''],
    ['Procurement', 'Purchase / PO request', 'Complete', ''],
    ['Travel', 'Domestic', 'Completed', ''],
    ['Travel', 'International', 'Draft', ''],
    ['Procurement', 'Purchase / PO request', 'Cancelled', ''],
    ['Reimbursement', 'Reimbursement', 'Updated and Resubmitted', 'Finance'],
  ];
  const [requestType, subType, status, waitingOn] = profiles[index % profiles.length];
  const ageDays = 1 + ((index * 3) % 25);
  const updatedAt = daysAgo(ageDays, 2 + (index % 6));
  const createdAt = daysAgo(Math.min(ageDays + 2, 27), 1 + (index % 5));
  const amount = (75 + (index * 37.35)).toFixed(2);
  const requester = index % 3 === 1
    ? { requester_person_id: 'PER-015', requester_name: 'Demo Requester Two' }
    : { requester_person_id: 'PER-002', requester_name: 'Demo Requester One' };
  const isTerminal = ['Complete', 'Completed', 'Cancelled'].includes(status);
  const isDraft = status === 'Draft';
  const row = requestRow({
    request_id: id,
    request_type: requestType,
    sub_type: subType,
    ...requester,
    amount,
    activity_code: ['3203', '3206', '3234', '3270'][index % 4],
    short_description: `Synthetic demo request ${index + 8}: ${requestType}`,
    current_status: status,
    waiting_on: waitingOn,
    next_action: isTerminal
      ? ''
      : isDraft
        ? 'Requester to complete draft'
        : waitingOn === 'User'
          ? 'Requester to provide clarification'
          : waitingOn === 'Approver'
            ? 'Approver review'
            : waitingOn === 'External System'
              ? 'Await external system processing'
              : 'Finance review',
    created_at: createdAt,
    last_updated_at: updatedAt,
    submitted_at: isDraft ? '' : createdAt,
    returned_for_info_at: status === 'Returned for Info' ? updatedAt : '',
    completed_at: ['Complete', 'Completed'].includes(status) ? updatedAt : '',
    completed_date: ['Complete', 'Completed'].includes(status) ? dateOnly(updatedAt) : '',
  });

  if (requestType === 'Procurement') {
    const numeric = Number(amount);
    row.supplier_type = 'Existing Supplier';
    row.supplier_name = `Synthetic Supplier ${String((index % 8) + 1).padStart(2, '0')}`;
    row.spending_approver = 'Demo Approver One';
    row.amount_ex_gst = (numeric / 1.1).toFixed(2);
    row.gst_amount = (numeric - Number(row.amount_ex_gst)).toFixed(2);
    row.amount_inc_gst = amount;
  }

  if (requestType === 'Travel' || requestType === 'Travel Allowance') {
    row.beneficiary_person_id = requester.requester_person_id;
    row.beneficiary_name = requester.requester_name;
    row.destination = ['Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Darwin'][index % 5];
    row.travel_start_date = `2026-11-${String(2 + (index % 20)).padStart(2, '0')}`;
    row.travel_end_date = `2026-11-${String(4 + (index % 20)).padStart(2, '0')}`;
  }

  return row;
}

function buildSeedRows() {
  const showcaseRows = [
    requestRow({
      request_id: SEED_IDS[0],
      request_type: 'Reimbursement',
      sub_type: 'Reimbursement',
      amount: '86.40',
      short_description: 'Airport rideshare reimbursement',
      current_status: 'Submitted',
      waiting_on: 'Finance',
      next_action: 'Finance review',
      submitted_at: '2026-10-23T02:15:00.000Z',
      created_at: '2026-10-23T02:10:00.000Z',
      last_updated_at: '2026-10-23T02:15:00.000Z',
    }),
    requestRow({
      request_id: SEED_IDS[1],
      request_type: 'Procurement',
      sub_type: 'Purchase / PO request',
      amount: '1250.00',
      amount_ex_gst: '1136.36',
      gst_amount: '113.64',
      amount_inc_gst: '1250.00',
      supplier_type: 'Existing Supplier',
      supplier_name: 'Synthetic Office Supplies',
      spending_approver: 'Demo Approver One',
      short_description: 'Workshop equipment purchase',
      current_status: 'Submit to Admin',
      waiting_on: 'Finance',
      next_action: 'Finance review',
      submitted_at: '2026-10-14T01:00:00.000Z',
      created_at: '2026-10-14T00:55:00.000Z',
      last_updated_at: '2026-10-14T01:00:00.000Z',
    }),
    requestRow({
      request_id: SEED_IDS[2],
      request_type: 'Travel Allowance',
      sub_type: 'Meals/incidentals',
      requester_person_id: 'PER-015',
      requester_name: 'Demo Requester Two',
      beneficiary_person_id: 'PER-015',
      beneficiary_name: 'Demo Requester Two',
      amount: '420.00',
      destination: 'Melbourne',
      travel_start_date: '2026-11-02',
      travel_end_date: '2026-11-04',
      short_description: 'Conference travel allowance',
      current_status: 'Returned for Info',
      waiting_on: 'User',
      next_action: 'Requester to provide clarification',
      returned_for_info_at: '2026-10-11T03:30:00.000Z',
      submitted_at: '2026-10-09T03:00:00.000Z',
      created_at: '2026-10-09T02:50:00.000Z',
      last_updated_at: '2026-10-11T03:30:00.000Z',
    }),
    requestRow({
      request_id: SEED_IDS[3],
      request_type: 'Reimbursement',
      sub_type: 'Reimbursement',
      amount: '214.75',
      activity_code: '3206',
      short_description: 'Course demo materials reimbursement',
      current_status: 'In Progress',
      waiting_on: 'Finance',
      next_action: 'Finance processing',
      submitted_at: '2026-10-22T04:00:00.000Z',
      created_at: '2026-10-22T03:55:00.000Z',
      last_updated_at: '2026-10-23T05:00:00.000Z',
    }),
    requestRow({
      request_id: SEED_IDS[4],
      request_type: 'Reimbursement',
      sub_type: 'Reimbursement',
      amount: '49.50',
      activity_code: '3234',
      short_description: 'Completed taxi reimbursement',
      current_status: 'Completed',
      waiting_on: '',
      next_action: '',
      submitted_at: '2026-10-16T01:00:00.000Z',
      completed_at: '2026-10-18T01:00:00.000Z',
      completed_date: '2026-10-18',
      created_at: '2026-10-16T00:55:00.000Z',
      last_updated_at: '2026-10-18T01:00:00.000Z',
    }),
    requestRow({
      request_id: SEED_IDS[5],
      request_type: 'Procurement',
      sub_type: 'Purchase / PO request',
      amount: '880.00',
      amount_ex_gst: '800.00',
      gst_amount: '80.00',
      amount_inc_gst: '880.00',
      supplier_type: 'Existing Supplier',
      supplier_name: 'Synthetic AV Services',
      spending_approver: 'Demo Approver One',
      short_description: 'Completed seminar AV purchase',
      current_status: 'Complete',
      waiting_on: '',
      next_action: '',
      submitted_at: '2026-10-04T01:00:00.000Z',
      completed_at: '2026-10-10T01:00:00.000Z',
      completed_date: '2026-10-10',
      created_at: '2026-10-04T00:55:00.000Z',
      last_updated_at: '2026-10-10T01:00:00.000Z',
    }),
    requestRow({
      request_id: SEED_IDS[6],
      request_type: 'Travel',
      sub_type: 'Domestic',
      beneficiary_person_id: 'PER-002',
      beneficiary_name: 'Demo Requester One',
      destination: 'Brisbane',
      travel_start_date: '2026-11-12',
      travel_end_date: '2026-11-14',
      short_description: 'Draft domestic travel request',
      current_status: 'Draft',
      waiting_on: '',
      next_action: 'Requester to complete draft',
      created_at: '2026-10-24T01:00:00.000Z',
      last_updated_at: '2026-10-24T01:00:00.000Z',
    }),
  ];

  return [
    ...showcaseRows,
    ...SEED_IDS.slice(showcaseRows.length).map((id, index) => generatedSeedRow(id, index)),
  ];
}

function creationEvent(row, index) {
  return {
    event_id: `EV-DEMO-SEED-${String(index + 1).padStart(3, '0')}`,
    request_id: row.request_id,
    event_time: row.created_at,
    event_type: 'Demo Seeded',
    old_status: '',
    new_status: row.current_status,
    changed_by_person_id: 'PER-001',
    changed_by_username: 'demo-seed@system.invalid',
    changed_by_role: 'admin',
    changed_by: 'Demo Seed',
    note: 'Synthetic COMP6708 demonstration record.',
    changed_fields: '',
  };
}

async function seedDemoRequests() {
  if (String(process.env.DEMO_MODE || '').toLowerCase() !== 'true') {
    return { skipped: true, reason: 'DEMO_MODE is not true', created: [], existing: [] };
  }
  if (String(process.env.DEMO_SEED_REQUESTS || '').toLowerCase() !== 'true') {
    return { skipped: true, reason: 'DEMO_SEED_REQUESTS is not true', created: [], existing: [] };
  }
  if (String(process.env.STORAGE || 'csv').toLowerCase() !== 'csv') {
    return { skipped: true, reason: 'Synthetic request seeding is supported only for the CSV demo backend', created: [], existing: [] };
  }

  await repo.init();
  const existingRows = await repo.getRequests();
  const existingIds = new Set(existingRows.map((row) => String(row.request_id || '')));
  const created = [];
  const existing = [];

  for (const [index, row] of buildSeedRows().entries()) {
    if (existingIds.has(row.request_id)) {
      existing.push(row.request_id);
      continue;
    }
    const result = await repo.createRequest(row, creationEvent(row, index), 'FR-20261024-');
    if (result && result.existing) existing.push(row.request_id);
    else created.push(row.request_id);
  }

  return { skipped: false, created, existing };
}

async function main() {
  const result = await seedDemoRequests();
  if (result.skipped) {
    console.log(`Demo request seed skipped: ${result.reason}.`);
    return;
  }
  console.log(`Demo request seed complete: created ${result.created.length}, existing ${result.existing.length}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Demo request seed failed:', err.message);
    process.exit(1);
  });
}

module.exports = { SEED_IDS, buildSeedRows, seedDemoRequests };
