'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StagingQueue } = require('../lib/stagingQueue');

function actor(username = 'alice', role = 'requester') {
  return { username, role, person_id: 'PER-011', display_name: 'Alice' };
}

test('staging queue persists request edits and file bytes across queue instances', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frt-staging-'));
  try {
    const queue = new StagingQueue(root);
    const created = await queue.createBundle({
      input: { request_type: 'Travel', sub_type: 'Domestic', requester_name: 'Alice' },
      actor: actor(),
    });
    assert.match(created.request_id, /^FR-\d{8}-Q/);
    assert.strictEqual(created.pending_sync, true);

    const withFile = await queue.appendAttachment(created.request_id, {
      purpose: 'travel_request', filename: 'travel.pdf', content_type: 'application/pdf',
      expected_version: created.last_updated_at,
    }, Buffer.from('%PDF-1.4 test'), actor());
    assert.match(withFile.attachments, /travel\.pdf/);
    assert.match(withFile.attachments, /staged:/);

    const restarted = new StagingQueue(root);
    const statuses = await restarted.statusesForActor(actor());
    assert.strictEqual(statuses.length, 1);
    assert.strictEqual(statuses[0].request_id, created.request_id);
    assert.match(statuses[0].pending_request_id, /^STG-/);

    let processed = 0;
    while (await restarted.processOne(async (_manifest, step, bundleDir) => {
      processed += 1;
      if (step.type === 'attachment') {
        assert.ok(fs.existsSync(path.join(bundleDir, 'files', step.file_name)));
      }
    })) {}
    assert.strictEqual(processed, 2);
    assert.deepStrictEqual(await restarted.statusesForActor(actor()), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a transient staging failure remains on disk with backoff instead of losing data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frt-staging-retry-'));
  try {
    const queue = new StagingQueue(root);
    const created = await queue.createBundle({
      input: { request_type: 'Travel', sub_type: 'Domestic' }, actor: actor(),
    });
    await queue.processOne(async () => { throw new Error('SQL connection refused'); }, {
      isTransient: (err) => /connection refused/i.test(err.message),
    });
    const statuses = await queue.statusesForActor(actor());
    assert.strictEqual(statuses.length, 1);
    assert.strictEqual(statuses[0].status, 'pending');
    assert.strictEqual(statuses[0].request_id, created.request_id);
    assert.ok(statuses[0].updated_at);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a bundle left in processing is recovered on the next startup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frt-staging-recover-'));
  try {
    const queue = new StagingQueue(root);
    const created = await queue.createBundle({
      input: { request_type: 'Travel', sub_type: 'Domestic' }, actor: actor(),
    });
    const processing = (await queue.directories(queue.pendingDir))[0];
    const manifest = JSON.parse(fs.readFileSync(path.join(processing, 'manifest.json'), 'utf8'));
    manifest.status = 'processing';
    fs.writeFileSync(path.join(processing, 'manifest.json'), JSON.stringify(manifest));
    fs.renameSync(processing, queue.bundleDir(queue.processingDir, manifest.staging_id));

    const restarted = new StagingQueue(root);
    await restarted.init();
    const statuses = await restarted.statusesForActor(actor());
    assert.strictEqual(statuses.length, 1);
    assert.strictEqual(statuses[0].request_id, created.request_id);
    assert.strictEqual(statuses[0].status, 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent staged operations share one durable bundle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frt-staging-lock-'));
  try {
    const queue = new StagingQueue(root);
    const requestId = 'FR-20260818-QLOCK';
    await Promise.all([
      queue.stageOperation(requestId, { type: 'action', operation: 'save-draft', changes: { notes: 'one' } }, actor()),
      queue.stageOperation(requestId, { type: 'action', operation: 'save-draft', changes: { notes: 'two' } }, actor()),
    ]);
    const statuses = await queue.statusesForActor(actor());
    assert.strictEqual(statuses.length, 1);
    const found = await queue.getBundleByRequestId(requestId, actor());
    assert.ok(found);
    assert.strictEqual(found.manifest.steps.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
