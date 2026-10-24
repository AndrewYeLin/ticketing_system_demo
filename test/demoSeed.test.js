'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SEED_IDS, buildSeedRows } = require('../scripts/seed-demo-requests');
const { summarizeRequests, summarizeBottlenecks } = require('../mcp/httpServer');

test('demo seed rows are deterministic and exercise admin insights', () => {
  const rows = buildSeedRows();
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((row) => row.request_id), SEED_IDS);
  assert.equal(new Set(SEED_IDS).size, SEED_IDS.length);
  for (const id of SEED_IDS) assert.match(id, /^FR-\d{8}-\d{3}$/);

  const summary = summarizeRequests(rows);
  assert.equal(summary.total_requests, 7);
  assert.equal(summary.open_requests, 4);
  assert.equal(summary.drafts, 1);
  assert.equal(summary.terminal_requests, 2);
  assert.equal(summary.by_status.Submitted, 1);
  assert.equal(summary.by_status['Submit to Admin'], 1);
  assert.equal(summary.by_status['Returned for Info'], 1);
  assert.equal(summary.by_status['In Progress'], 1);
  assert.equal(summary.waiting_on_open_requests.Finance, 3);
  assert.equal(summary.waiting_on_open_requests.User, 1);

  const bottlenecks = summarizeBottlenecks(rows, {
    staleDays: 7,
    now: Date.parse('2026-10-24T05:00:00.000Z'),
  });
  assert.equal(bottlenecks.open_requests, 4);
  assert.equal(bottlenecks.returned_for_info, 1);
  assert.equal(bottlenecks.waiting_on_user, 1);
  assert.equal(bottlenecks.stale_open_requests, 2);
});

test('demo seed uses only synthetic requesters and supplier names', () => {
  const rows = buildSeedRows();
  assert.ok(rows.every((row) => /^Demo Requester/.test(row.requester_name)));
  assert.ok(rows.filter((row) => row.supplier_name).every((row) => /^Synthetic /.test(row.supplier_name)));
  assert.ok(rows.every((row) => row.deleted !== 'Yes'));
});
