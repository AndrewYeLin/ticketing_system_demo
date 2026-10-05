'use strict';

// Status-change notifications.
//
// Email is an output channel the app cannot police once it has left, so the assertions
// that matter most here are negative: which events do *not* produce mail, and what a
// message never contains. The `memory` transport (lib/mailer.js) stands in for SMTP so
// this runs end to end through store.updateRequest without a mail server.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writePeopleFixture } = require('../test-support/peopleFixture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'frt-notify-'));
process.env.DATA_DIR = TMP;
delete process.env.STORAGE;
process.env.MAIL_TRANSPORT = 'memory';
process.env.APP_BASE_URL = 'https://requests.example.edu.au';

const store = require('../lib/store');
const notify = require('../lib/notify');
const mailer = require('../lib/mailer');

const U = 'tester';
const AS_FINANCE = { isAdmin: true };

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
test.before(async () => {
  writePeopleFixture(TMP);
  await store.updatePerson('PER-011', { email: 'alice@example.edu.au' });
});
test.beforeEach(() => mailer.clearSentMessages());

function domestic(over) {
  return store.createRequest({
    request_type: 'Travel', sub_type: 'Domestic', received_date: '2026-08-03',
    requester_person_id: 'PER-011', requester_name: 'Alice', beneficiary_name: 'Bob',
    cost_code: '2391', activity_code: '3270',
    destination: 'Sydney', travel_start_date: '2026-09-01', travel_end_date: '2026-09-05',
    attachments: [
      { purpose: 'travel_request', filename: 't.pdf', stored: 'stored-t' },
      { purpose: 'approval_email', filename: 'a.eml', stored: 'stored-a' },
    ],
    ...(over || {}),
  }, U, AS_FINANCE);
}

// ---------------------------------------------------------------- composition

test('the message names the request and the move, and links to it', () => {
  const { subject, text } = notify.buildStatusChangeMessage({
    row: { request_id: 'FR-20260811-001', request_type: 'Travel', sub_type: 'Domestic', requester_name: 'Alice' },
    oldStatus: 'Submitted', newStatus: 'Returned for Info', changedBy: 'demo.admin@polyu.edu.hk',
    note: 'The quote is missing a date.',
  });
  assert.strictEqual(subject, '[FR-20260811-001] Submitted → Returned For Info');
  assert.match(text, /FR-20260811-001/);
  assert.match(text, /Travel · Domestic/);
  assert.match(text, /Alice/);
  assert.match(text, /Submitted → Returned For Info/);
  assert.match(text, /demo\.admin@polyu\.edu\.hk/);
  assert.match(text, /The quote is missing a date\./);
  assert.match(text, /https:\/\/requests\.example\.edu\.au\/\?request=FR-20260811-001/);
  assert.match(text, /User:\s+Alice/);
  assert.match(text, /you are the user/);
});

test('status names in notifications use title case', () => {
  const { subject, text } = notify.buildStatusChangeMessage({
    row: { request_id: 'FR-STATUS-CASE', request_type: 'Procurement', requester_name: 'Alice' },
    oldStatus: 'PO issued to user', newStatus: 'Return to User', changedBy: 'finance@example.edu.au',
  });
  assert.strictEqual(subject, '[FR-STATUS-CASE] PO Issued To User → Return To User');
  assert.match(text, /PO Issued To User → Return To User/);
});

// Mail lands outside every permission check this app makes. A body assembled from the
// whole row would export the supplier bank details the API masks for requesters and the
// amounts nobody asked to have mailed around.
test('the message carries nothing beyond identification and the move', () => {
  const { text } = notify.buildStatusChangeMessage({
    row: {
      request_id: 'FR-20260811-002', request_type: 'Supplier Setup', sub_type: 'New supplier',
      requester_name: 'Alice', amount_inc_gst: '12345.67', amount_ex_gst: '11223.34',
      supplier_form_data: JSON.stringify({ account_number: '987654321', bsb: '084-999' }),
      notes: 'internal-only working note',
    },
    oldStatus: 'Submitted', newStatus: 'Approved', changedBy: 'admin',
  });
  for (const secret of ['987654321', '084-999', '12345.67', '11223.34', 'internal-only working note']) {
    assert.ok(!text.includes(secret), `the body leaked ${secret}`);
  }
});

test('with no base URL configured the message simply has no link', () => {
  const saved = process.env.APP_BASE_URL;
  try {
    delete process.env.APP_BASE_URL;
    const { text } = notify.buildStatusChangeMessage({
      row: { request_id: 'FR-1', request_type: 'Travel', requester_name: 'Alice' },
      oldStatus: 'Draft', newStatus: 'Submitted', changedBy: 'alice',
    });
    assert.ok(!/Open the request/.test(text));
  } finally { process.env.APP_BASE_URL = saved; }
});

test('a missing requester email means no recipient and no send', async () => {
  assert.deepStrictEqual(notify.recipientsFor(), []);
  const row = await domestic({ requester_person_id: 'PER-012', requester_name: 'Bob' });
  await store.updateRequest(row.request_id, { current_status: 'Submitted' }, U);
  assert.strictEqual(mailer.sentMessages.length, 0);
});

// ---------------------------------------------------------------- what triggers one

test('a status change sends exactly one message to the requester email', async () => {
  const row = await domestic();
  await store.updateRequest(row.request_id, { current_status: 'Submitted', note: 'Please process' }, U);

  assert.strictEqual(mailer.sentMessages.length, 1);
  const [message] = mailer.sentMessages;
  assert.strictEqual(message.to, 'alice@example.edu.au');
  assert.strictEqual(message.subject, `[${row.request_id}] Draft → Submitted`);
  assert.match(message.text, /Please process/);
});

test('a status change that also edits fields still sends one message, about the status', async () => {
  const row = await domestic();
  await store.updateRequest(row.request_id, { current_status: 'Submitted', destination: 'Perth' }, U);
  assert.strictEqual(mailer.sentMessages.length, 1);
  assert.match(mailer.sentMessages[0].subject, /Draft → Submitted/);
});

// The noise floor. Finance touches fields all day; mailing each edit is how a notification
// address becomes a filter rule, taking the returns and rejections down with it.
test('field edits, notes and soft deletes send nothing', async () => {
  const row = await domestic();
  await store.updateRequest(row.request_id, { current_status: 'Submitted' }, U);
  mailer.clearSentMessages();

  await store.updateRequest(row.request_id, { destination: 'Perth' }, U);
  await store.updateRequest(row.request_id, { note: 'just a comment' }, U);
  await store.updateRequest(row.request_id, { internal_note: 'do not email this' }, U);
  await store.setDeleted(row.request_id, true, U);
  await store.setDeleted(row.request_id, false, U);

  assert.strictEqual(mailer.sentMessages.length, 0);
});

test('creating a draft sends nothing — a draft is not news', async () => {
  await domestic();
  assert.strictEqual(mailer.sentMessages.length, 0);
});

// An internal note is hidden from requesters in the history API and the UI. A status change
// carrying one must not smuggle it out through the notification body.
test('an internal note attached to a status change is never in the message', async () => {
  const row = await domestic();
  await store.updateRequest(row.request_id, {
    current_status: 'Submitted', internal_note: 'chase the supplier, do not tell the requester',
  }, U);
  assert.strictEqual(mailer.sentMessages.length, 1);
  assert.ok(!mailer.sentMessages[0].text.includes('chase the supplier'));
});

test('a failing transport does not fail the status change', async () => {
  const saved = process.env.MAIL_TRANSPORT;
  try {
    // smtp with no SMTP_HOST throws inside the transport — the update must still commit.
    process.env.MAIL_TRANSPORT = 'smtp';
    delete process.env.SMTP_HOST;
    const row = await domestic();
    const updated = await store.updateRequest(row.request_id, { current_status: 'Submitted' }, U);
    assert.strictEqual(updated.current_status, 'Submitted');
    assert.strictEqual((await store.getRequestById(row.request_id)).current_status, 'Submitted');
  } finally { process.env.MAIL_TRANSPORT = saved; }
});
