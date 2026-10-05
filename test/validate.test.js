'use strict';

const test = require('node:test');
const assert = require('node:assert');
const v = require('../lib/validate');

test('validateDate accepts real dates', () => {
  assert.strictEqual(v.validateDate('2026-08-03'), null);
  assert.strictEqual(v.validateDate('2024-02-29'), null); // leap day
});

test('validateDate rejects malformed and impossible dates', () => {
  assert.ok(v.validateDate('not-a-date'));
  assert.ok(v.validateDate('2026-2-3')); // not zero-padded
  assert.ok(v.validateDate('2026-13-01')); // bad month
  assert.ok(v.validateDate('2026-02-31')); // impossible day
  assert.ok(v.validateDate('2025-02-29')); // non-leap year
  assert.ok(v.validateDate(''));
});

test('validateAmount accepts non-negative numbers up to 2dp', () => {
  assert.strictEqual(v.validateAmount('0'), null);
  assert.strictEqual(v.validateAmount('100'), null);
  assert.strictEqual(v.validateAmount('12.34'), null);
});

test('validateAmount rejects bad amounts', () => {
  assert.ok(v.validateAmount('-50'));
  assert.ok(v.validateAmount('12.345')); // 3dp
  assert.ok(v.validateAmount('1,000')); // separator
  assert.ok(v.validateAmount('abc'));
  assert.ok(v.validateAmount('1e3')); // exponent
  assert.ok(v.validateAmount(''));
});

test('validateEmail basic shape', () => {
  assert.strictEqual(v.validateEmail('a@b.com'), null);
  assert.ok(v.validateEmail('no-at'));
  assert.ok(v.validateEmail('a@b')); // no dotted domain
  assert.ok(v.validateEmail(''));
});

test('normalizeAbn strips whitespace and enforces 11 digits', () => {
  assert.deepStrictEqual(v.normalizeAbn('51 824 753 556'), {
    value: '51824753556',
    error: null,
  });
  assert.deepStrictEqual(v.normalizeAbn(''), { value: '', error: null });
  assert.strictEqual(v.normalizeAbn('12345').error !== null, true);
  assert.strictEqual(v.normalizeAbn('abcdefghijk').error !== null, true);
});

test('validateYesNo enum', () => {
  assert.strictEqual(v.validateYesNo('Yes'), null);
  assert.strictEqual(v.validateYesNo('No'), null);
  assert.ok(v.validateYesNo('yes'));
  assert.ok(v.validateYesNo('Maybe'));
  assert.ok(v.validateYesNo(''));
});
