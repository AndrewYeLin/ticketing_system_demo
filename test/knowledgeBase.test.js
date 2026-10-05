'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadKnowledge, searchFinanceKnowledge, resetKnowledgeCache } = require('../lib/knowledgeBase');

test('synthetic knowledge base loads multiple chunks', () => {
  resetKnowledgeCache();
  const chunks = loadKnowledge();
  assert.ok(chunks.length >= 12);
  assert.ok(chunks.every((chunk) => chunk.file && chunk.text));
});

test('reimbursement query ranks reimbursement evidence', () => {
  const hits = searchFinanceKnowledge('What documents do I need for reimbursement receipts?', { limit: 3 });
  assert.ok(hits.length > 0);
  assert.match(`${hits[0].title} ${hits[0].section} ${hits[0].text}`, /reimbursement|receipt/i);
});

test('status query can retrieve workflow guidance', () => {
  const hits = searchFinanceKnowledge('returned for info status resubmit request', { limit: 4 });
  assert.ok(hits.some((hit) => /Returned|resubmit|status/i.test(`${hit.section} ${hit.text}`)));
});
