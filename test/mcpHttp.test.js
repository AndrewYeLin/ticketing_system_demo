'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeEqual,
  safeRequest,
  safeHistory,
  isOpenRequest,
  summarizeRequests,
  summarizeBottlenecks,
} = require('../mcp/httpServer');
const { createActorHeaders, verifyActorHeaders } = require('../lib/mcpActorAuth');

test('MCP bearer token comparison requires a non-empty exact value', () => {
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('signed MCP actor context cannot be promoted by changing the payload', () => {
  const headers = createActorHeaders('secret', {
    username: 'requester@polyu.edu.hk',
    role: 'requester',
    person_id: 'PER-002',
    display_name: 'Demo Requester',
  });
  assert.equal(verifyActorHeaders(headers, 'secret').role, 'requester');

  const tampered = {
    ...headers,
    'X-Demo-Actor': Buffer.from(JSON.stringify({
      username: 'requester@polyu.edu.hk',
      role: 'admin',
      person_id: 'PER-002',
      display_name: 'Demo Requester',
    })).toString('base64url'),
  };
  assert.equal(verifyActorHeaders(tampered, 'secret'), null);
});

test('remote MCP request projection exposes only safe demo fields', () => {
  const projected = safeRequest({
    request_id: 'FR-20261005-001',
    request_type: 'Reimbursement',
    current_status: 'Submitted',
    requester_name: 'Hidden Person',
    supplier_form_data: '{"account_number":"123"}',
    internal_note: 'hidden',
  });
  assert.equal(projected.request_id, 'FR-20261005-001');
  assert.equal(projected.current_status, 'Submitted');
  assert.equal(Object.hasOwn(projected, 'requester_name'), false);
  assert.equal(Object.hasOwn(projected, 'supplier_form_data'), false);
  assert.equal(Object.hasOwn(projected, 'internal_note'), false);
});

test('remote MCP history projection drops private internal-note events', () => {
  assert.equal(safeHistory({ event_type: 'Internal Note', note: 'secret' }), null);
  const event = safeHistory({ event_type: 'Status Changed', old_status: 'Draft', new_status: 'Submitted' });
  assert.equal(event.event_type, 'Status Changed');
  assert.equal(event.from_status, 'Draft');
  assert.equal(event.to_status, 'Submitted');
  assert.equal(Object.hasOwn(event, 'note'), false);
});

test('admin request summary computes open queue counts server-side', () => {
  const rows = [
    { request_id: 'FR-1', request_type: 'Reimbursement', current_status: 'Draft', waiting_on: '' },
    { request_id: 'FR-2', request_type: 'Reimbursement', current_status: 'Submitted', waiting_on: 'Finance' },
    { request_id: 'FR-3', request_type: 'Procurement', current_status: 'In Progress', waiting_on: 'Finance' },
    { request_id: 'FR-4', request_type: 'Travel Allowance', current_status: 'Returned for Info', waiting_on: 'User' },
    { request_id: 'FR-5', request_type: 'Reimbursement', current_status: 'Completed', waiting_on: '' },
    { request_id: 'FR-6', request_type: 'Procurement', current_status: 'Cancelled', waiting_on: '' },
    { request_id: 'FR-7', request_type: 'Procurement', current_status: 'Submitted', waiting_on: 'Finance', deleted: 'Yes' },
  ];
  assert.equal(isOpenRequest(rows[1]), true);
  assert.equal(isOpenRequest(rows[0]), false);
  assert.equal(isOpenRequest(rows[4]), false);

  const summary = summarizeRequests(rows);
  assert.equal(summary.total_requests, 6);
  assert.equal(summary.open_requests, 3);
  assert.equal(summary.drafts, 1);
  assert.equal(summary.terminal_requests, 2);
  assert.equal(summary.by_status.Submitted, 1);
  assert.equal(summary.by_type.Reimbursement, 3);
  assert.equal(summary.waiting_on_open_requests.Finance, 2);
  assert.equal(summary.waiting_on_open_requests.User, 1);
});

test('admin bottleneck summary detects returned, user-waiting and stale open work', () => {
  const now = Date.parse('2026-10-06T00:00:00Z');
  const rows = [
    {
      request_id: 'FR-1',
      request_type: 'Reimbursement',
      current_status: 'Returned for Info',
      waiting_on: 'User',
      last_updated_at: '2026-09-20T00:00:00Z',
    },
    {
      request_id: 'FR-2',
      request_type: 'Procurement',
      current_status: 'In Progress',
      waiting_on: 'Finance',
      last_updated_at: '2026-10-05T00:00:00Z',
    },
    {
      request_id: 'FR-3',
      request_type: 'Reimbursement',
      current_status: 'Completed',
      waiting_on: '',
      last_updated_at: '2026-08-01T00:00:00Z',
    },
  ];
  const result = summarizeBottlenecks(rows, { staleDays: 7, now });
  assert.equal(result.open_requests, 2);
  assert.equal(result.returned_for_info, 1);
  assert.equal(result.waiting_on_user, 1);
  assert.equal(result.stale_open_requests, 1);
  assert.equal(result.oldest_stale_requests[0].request_id, 'FR-1');
  assert.equal(result.oldest_stale_requests[0].days_since_last_activity, 16);
});
