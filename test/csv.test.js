'use strict';

// The CSV codec carries the whole domain contract for the dev/test backend, including
// the inline-JSON columns (attachments, reimbursement_items, supplier_form_data). A
// quoting bug here silently corrupts every row after it, so the round-trip is asserted
// against the values that actually appear in the data rather than toy strings.

const test = require('node:test');
const assert = require('node:assert');

const csv = require('../lib/csv');
const { CURRENT_COLUMNS } = require('../lib/constants');

const roundTrip = (rows, columns) => csv.parse(csv.stringify(rows, columns));

test('plain values round-trip unchanged', () => {
  const rows = [{ a: 'one', b: 'two' }, { a: '', b: 'three' }];
  assert.deepStrictEqual(roundTrip(rows, ['a', 'b']), rows);
});

test('commas, quotes and newlines survive a round-trip', () => {
  const rows = [{
    a: 'Smith, John',
    b: 'He said "hello"',
    c: 'line one\nline two',
    d: 'crlf\r\ninside',
    e: '"leading quote',
  }];
  assert.deepStrictEqual(roundTrip(rows, ['a', 'b', 'c', 'd', 'e']), rows);
});

test('an inline JSON column round-trips byte for byte', () => {
  const attachments = JSON.stringify([
    { purpose: 'quote', filename: 'Q, "final".pdf', stored: 'uuid__q.pdf', size: 12 },
    { purpose: 'approval_email', filename: 'approve\nme.eml', stored: 'uuid__a.eml' },
  ]);
  const [back] = roundTrip([{ request_id: 'REQ-1', attachments }], ['request_id', 'attachments']);
  assert.strictEqual(back.attachments, attachments);
  assert.deepStrictEqual(JSON.parse(back.attachments), JSON.parse(attachments));
});

test('a full request row round-trips across every declared column', () => {
  const row = {};
  for (const column of CURRENT_COLUMNS) row[column] = `v:${column}`;
  row.notes = 'Multi\nline, "quoted" note';
  row.reimbursement_items = JSON.stringify([{ category: 'Meals', amount: '10.50' }]);
  const [back] = roundTrip([row], CURRENT_COLUMNS);
  assert.deepStrictEqual(back, row);
});

test('empty input and header-only input parse to no rows', () => {
  assert.deepStrictEqual(csv.parse(''), []);
  assert.deepStrictEqual(csv.parse('a,b\r\n'), []);
});

test('blank lines between records are skipped', () => {
  assert.deepStrictEqual(csv.parse('a,b\r\n1,2\r\n\r\n3,4\r\n'), [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
});

test('a short row fills missing trailing cells with empty strings', () => {
  assert.deepStrictEqual(csv.parse('a,b,c\r\n1,2\r\n'), [{ a: '1', b: '2', c: '' }]);
});

test('a file with no trailing newline still yields its last record', () => {
  assert.deepStrictEqual(csv.parse('a,b\r\n1,2'), [{ a: '1', b: '2' }]);
});

test('LF-only files parse the same as CRLF files', () => {
  assert.deepStrictEqual(csv.parse('a,b\n1,2\n'), csv.parse('a,b\r\n1,2\r\n'));
});

test('null and undefined serialize as empty, not as the literal word', () => {
  const out = csv.stringify([{ a: null, b: undefined, c: 0 }], ['a', 'b', 'c']);
  assert.deepStrictEqual(csv.parse(out), [{ a: '', b: '', c: '0' }]);
});

test('a value that is only a delimiter is quoted rather than splitting the row', () => {
  const [back] = roundTrip([{ a: ',', b: '"', c: '\r\n' }], ['a', 'b', 'c']);
  assert.deepStrictEqual(back, { a: ',', b: '"', c: '\r\n' });
});

test('escapeField only quotes when it has to', () => {
  assert.strictEqual(csv.escapeField('plain'), 'plain');
  assert.strictEqual(csv.escapeField('a,b'), '"a,b"');
  assert.strictEqual(csv.escapeField('a"b'), '"a""b"');
});
