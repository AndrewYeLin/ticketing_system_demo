'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideTurn } = require('../lib/turnTaking');

test('waits during the immediate message-burst window', () => {
  const result = decideTurn({ messages: [{ role: 'user', text: 'I need a reimbursement' }], elapsed_ms: 100 });
  assert.equal(result.decision, 'WAIT');
});

test('keeps an ordinary message inside the 2.5 second demo burst window', () => {
  const result = decideTurn({ messages: [{ role: 'user', text: 'I need a reimbursement for an Uber from the airport' }], elapsed_ms: 1500 });
  assert.equal(result.decision, 'WAIT');
  assert.equal(result.reason, 'message-burst-window');
  assert.equal(result.idle_ms, 2500);
});

test('responds immediately to a direct question', () => {
  const result = decideTurn({ messages: [{ role: 'user', text: 'What documents do I need?' }], elapsed_ms: 50 });
  assert.equal(result.decision, 'RESPOND');
  assert.equal(result.reason, 'question-signal');
});

test('waits on a continuation cue', () => {
  const result = decideTurn({ messages: [{ role: 'user', text: 'Uber from the airport and' }], elapsed_ms: 1500 });
  assert.equal(result.decision, 'WAIT');
  assert.equal(result.reason, 'continuation-cue');
});

test('maximum wait always yields a response', () => {
  const result = decideTurn({ messages: [{ role: 'user', text: '$46.80' }], elapsed_ms: 4000, max_wait_ms: 3600 });
  assert.equal(result.decision, 'RESPOND');
  assert.equal(result.reason, 'max-wait-reached');
});

test('explicit yield phrase responds', () => {
  const result = decideTurn({ messages: [{ role: 'user', text: 'I have two receipts, that is all' }], elapsed_ms: 0 });
  assert.equal(result.decision, 'RESPOND');
  assert.equal(result.reason, 'explicit-turn-yield');
});
