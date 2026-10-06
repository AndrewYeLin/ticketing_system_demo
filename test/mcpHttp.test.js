'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeEqual, safeRequest, safeHistory } = require('../mcp/httpServer');

test('MCP bearer token comparison requires a non-empty exact value', () => {
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
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
  const event = safeHistory({ event_type: 'Status Changed', from_status: 'Draft', to_status: 'Submitted' });
  assert.equal(event.event_type, 'Status Changed');
  assert.equal(Object.hasOwn(event, 'note'), false);
});
