'use strict';

// Durable, single-process staging queue used when SQL Server is temporarily unavailable.
// The queue deliberately lives outside the request store: switching production to CSV
// would create two authorities and would make recovery ambiguous. A manifest is written
// atomically, while file bytes remain in the same request directory until the matching
// SQL transaction has committed.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 120;

function nowIso() { return new Date().toISOString(); }

function safePart(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160) || 'file';
}

function versionIso(previous) {
  const previousMs = Date.parse(previous || '');
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString();
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value == null ? '' : value).trim() || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function isPendingRequestId(value) {
  return /^STG-[0-9a-f-]{36}$/i.test(String(value || '').trim());
}

function makeTargetRequestId(stagingId) {
  const stamp = nowIso().slice(0, 10).replace(/-/g, '');
  return `FR-${stamp}-Q${stagingId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function actorMatches(manifest, actor) {
  if (!manifest || !manifest.actor || !actor) return false;
  return String(manifest.actor.username || '').toLowerCase() === String(actor.username || '').toLowerCase();
}

function actorCanAccess(manifest, actor) {
  return !!(actor && (String(actor.role || '') === 'admin' || actorMatches(manifest, actor)));
}

function shadowFromInput(input, pendingId) {
  const shadow = { ...(input || {}) };
  shadow.request_id = pendingId;
  shadow.current_status = shadow.current_status || 'Draft';
  shadow.currency = shadow.currency || 'AUD';
  shadow.has_attachments = shadow.has_attachments || 'No';
  shadow.attachments = shadow.attachments || '';
  shadow.last_updated_at = nowIso();
  shadow.pending_sync = true;
  shadow.staging_status = 'pending';
  return shadow;
}

function applyShadowStep(shadow, step) {
  const next = { ...(shadow || {}) };
  if (step.type === 'update' || step.type === 'action') {
    for (const [key, value] of Object.entries(step.changes || {})) {
      if (key === '_version' || key === '_from_status') continue;
      next[key] = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
  if (step.type === 'attachment') {
    const attachments = parseArray(next.attachments).filter((item) => item && item.purpose !== step.purpose);
    attachments.push({
      attachment_id: step.attachment_id || step.step_id,
      purpose: step.purpose,
      filename: step.filename,
      stored: `staged:${step.step_id}`,
      size: Number(step.size) || 0,
      type: step.content_type || '',
      uploaded_by: step.actor && step.actor.username ? step.actor.username : '',
      uploaded_at: step.created_at,
    });
    next.attachments = JSON.stringify(attachments);
    next.has_attachments = 'Yes';
  }
  if (step.type === 'remove-attachment') {
    next.attachments = JSON.stringify(parseArray(next.attachments).filter((item) => item && item.purpose !== step.purpose));
  }
  next.last_updated_at = versionIso(next.last_updated_at);
  next.pending_sync = true;
  next.staging_status = 'pending';
  return next;
}

class StagingQueue {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.pendingDir = path.join(this.rootDir, 'pending');
    this.processingDir = path.join(this.rootDir, 'processing');
    this.failedDir = path.join(this.rootDir, 'failed');
    this.completedDir = path.join(this.rootDir, 'completed');
    this.locks = new Map();
  }

  async init() {
    await Promise.all([
      fsp.mkdir(this.pendingDir, { recursive: true, mode: 0o700 }),
      fsp.mkdir(this.processingDir, { recursive: true, mode: 0o700 }),
      fsp.mkdir(this.failedDir, { recursive: true, mode: 0o700 }),
      fsp.mkdir(this.completedDir, { recursive: true, mode: 0o700 }),
    ]);
    // A container can stop after a bundle has moved to processing but before its
    // current step is marked done. Put those bundles back in the durable work queue;
    // the replay checks in the worker make a committed SQL step idempotent.
    for (const dir of await this.directories(this.processingDir)) {
      const manifest = await this.readManifest(dir);
      if (!manifest) continue;
      manifest.status = 'pending';
      manifest.next_attempt_at = '';
      await this.writeJsonAtomic(this.manifestPath(dir), manifest);
      await fsp.rename(dir, this.bundleDir(this.pendingDir, manifest.staging_id));
    }
  }

  isPendingRequestId(value) { return isPendingRequestId(value); }

  bundleIdForRequest(requestId, username) {
    return crypto.createHash('sha256')
      .update(`${String(username || '').toLowerCase()}|${String(requestId || '')}`)
      .digest('hex');
  }

  bundleDir(base, bundleId) { return path.join(base, safePart(bundleId)); }
  manifestPath(dir) { return path.join(dir, 'manifest.json'); }

  async withLock(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.then(fn, fn);
    this.locks.set(key, current.catch(() => {}));
    try { return await current; } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      // Windows scanners can briefly hold the existing manifest after a reader has
      // closed it. Retry the rename before falling back to an overwrite copy; the
      // queue is protected by its in-process lock, so the fallback cannot race a
      // second writer and is preferable to dropping a staged operation.
      if (!['EBUSY', 'EACCES', 'EPERM', 'EEXIST'].includes(err.code)) throw err;
      let lastError = err;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 10));
        try {
          await fsp.rename(tmp, file);
          return;
        } catch (retryError) {
          if (!['EBUSY', 'EACCES', 'EPERM', 'EEXIST'].includes(retryError.code)) throw retryError;
          lastError = retryError;
        }
      }
      try {
        await fsp.copyFile(tmp, file);
        await fsp.unlink(tmp);
      } catch (copyError) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        copyError.cause = lastError;
        throw copyError;
      }
    }
  }

  async readManifest(dir) {
    try { return JSON.parse(await fsp.readFile(this.manifestPath(dir), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }

  async directories(base) {
    let entries = [];
    try { entries = await fsp.readdir(base, { withFileTypes: true }); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(base, entry.name));
  }

  async findManifest(predicate) {
    for (const base of [this.pendingDir, this.processingDir, this.failedDir]) {
      for (const dir of await this.directories(base)) {
        const manifest = await this.readManifest(dir);
        if (manifest && predicate(manifest)) return { dir, manifest };
      }
    }
    return null;
  }

  async createBundle({ requestId = '', input = {}, actor, isAdmin = false }) {
    await this.init();
    const stagingId = crypto.randomUUID();
    const pendingId = requestId || `STG-${stagingId}`;
    const targetRequestId = requestId || makeTargetRequestId(stagingId);
    const dir = this.bundleDir(this.pendingDir, stagingId);
    const filesDir = path.join(dir, 'files');
    const manifest = {
      schema_version: 2,
      staging_id: stagingId,
      pending_request_id: pendingId,
      target_request_id: targetRequestId,
      // New requests get their stable business-facing ID before SQL is available.
      // The STG ID remains internal metadata; keeping the target ID in the browser
      // means a tab can continue editing after the worker has synchronised the row.
      request_id: targetRequestId,
      is_new: !requestId,
      actor: clone(actor),
      is_admin: !!isAdmin,
      created_at: nowIso(),
      updated_at: nowIso(),
      attempts: 0,
      next_attempt_at: '',
      status: 'pending',
      shadow: shadowFromInput(input, targetRequestId),
      steps: [],
    };
    await fsp.mkdir(filesDir, { recursive: true, mode: 0o700 });
    await this.writeJsonAtomic(this.manifestPath(dir), manifest);
    if (!requestId) {
      await this.appendStepByDir(dir, manifest, {
        type: 'create', input, actor, is_admin: isAdmin,
      });
    }
    return this.publicShadow(manifest);
  }

  async findBundle(requestId, username) {
    return this.findManifest((manifest) => {
      if (manifest.pending_request_id === requestId) return actorMatches(manifest, { username });
      return manifest.request_id === requestId && actorMatches(manifest, { username });
    });
  }

  async getBundleByRequestId(requestId, actor) {
    if (isPendingRequestId(requestId)) {
      return this.findManifest((manifest) => manifest.pending_request_id === requestId && actorCanAccess(manifest, actor));
    }
    return this.findManifest((manifest) => manifest.request_id === requestId && actorCanAccess(manifest, actor));
  }

  publicShadow(manifest) {
    return {
      ...clone(manifest.shadow),
      pending_sync: true,
      staging_id: manifest.staging_id,
      staging_status: manifest.status,
      staging_message: manifest.status === 'failed'
        ? 'This change is waiting for manual retry because database synchronisation failed.'
        : 'Saved temporarily. Waiting for database synchronisation.',
    };
  }

  async appendStep(requestId, step, actor) {
    const found = await this.getBundleByRequestId(requestId, actor);
    if (!found) throw new Error('Staged request was not found');
    return this.withLock(found.manifest.staging_id, async () => {
      const current = await this.readManifest(found.dir);
      if (!current) throw new Error('Staged request was not found');
      await this.appendStepByDir(found.dir, current, { ...step, actor });
      return this.publicShadow(current);
    });
  }

  async stageOperation(requestId, step, actor) {
    return this.withLock(`request:${requestId}`, async () => {
      const found = await this.getBundleByRequestId(requestId, actor);
      if (!found) {
        await this.createBundle({ requestId, actor, isAdmin: actor.role === 'admin' });
      }
      return this.appendStep(requestId, step, actor);
    });
  }

  async appendAttachment(requestId, data, buffer, actor) {
    return this.withLock(`request:${requestId}`, async () => {
      let bundle = await this.getBundleByRequestId(requestId, actor);
      if (!bundle) {
        await this.createBundle({ requestId, actor, isAdmin: actor.role === 'admin' });
        bundle = await this.getBundleByRequestId(requestId, actor);
      }
      if (!bundle) throw new Error('Staged request was not found');
      return this.withLock(bundle.manifest.staging_id, async () => {
        const current = await this.readManifest(bundle.dir);
        if (!current) throw new Error('Staged request was not found');
        const stepId = crypto.randomUUID();
        const fileName = `${stepId}__${safePart(data.filename)}`;
        const filePath = path.join(bundle.dir, 'files', fileName);
        await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await fsp.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
        await this.appendStepByDir(bundle.dir, current, {
          ...data,
          type: 'attachment',
          step_id: stepId,
          file_name: fileName,
          filename: data.filename,
          size: buffer.length,
          actor,
        });
        return this.publicShadow(current);
      });
    });
  }

  async appendStepByDir(dir, manifest, rawStep) {
    const step = {
      step_id: rawStep.step_id || crypto.randomUUID(),
      type: rawStep.type,
      operation: rawStep.operation || '',
      input: clone(rawStep.input),
      changes: clone(rawStep.changes),
      purpose: rawStep.purpose || '',
      attachment_id: rawStep.attachment_id || rawStep.step_id || crypto.randomUUID(),
      filename: rawStep.filename || '',
      content_type: rawStep.content_type || '',
      size: Number(rawStep.size) || 0,
      file_name: rawStep.file_name || '',
      expected_version: rawStep.expected_version || '',
      actor: clone(rawStep.actor || manifest.actor),
      is_admin: !!(rawStep.is_admin || manifest.is_admin),
      created_at: rawStep.created_at || nowIso(),
      done: false,
    };
    manifest.steps.push(step);
    manifest.shadow = applyShadowStep(manifest.shadow, step);
    manifest.updated_at = nowIso();
    await this.writeJsonAtomic(this.manifestPath(dir), manifest);
    return step;
  }

  async markFailed(dir, manifest, err) {
    manifest.status = 'failed';
    manifest.error = String(err && err.message || 'Staging synchronisation failed').slice(0, 500);
    manifest.updated_at = nowIso();
    await this.writeJsonAtomic(this.manifestPath(dir), manifest);
    const target = this.bundleDir(this.failedDir, manifest.staging_id);
    await fsp.rename(dir, target).catch(async (renameErr) => {
      if (renameErr.code !== 'EXDEV') throw renameErr;
      await fsp.cp(dir, target, { recursive: true, force: true });
      await fsp.rm(dir, { recursive: true, force: true });
    });
  }

  async retryFailed(stagingId, actor) {
    const dir = this.bundleDir(this.failedDir, stagingId);
    const manifest = await this.readManifest(dir);
    if (!manifest) return false;
    if (!actorCanAccess(manifest, actor)) return false;
    manifest.status = 'pending'; manifest.error = ''; manifest.attempts = 0; manifest.next_attempt_at = '';
    await this.writeJsonAtomic(this.manifestPath(dir), manifest);
    await fsp.rename(dir, this.bundleDir(this.pendingDir, stagingId));
    return true;
  }

  async pendingManifests() {
    const out = [];
    for (const dir of await this.directories(this.pendingDir)) {
      const manifest = await this.readManifest(dir);
      if (manifest) out.push({ dir, manifest });
    }
    return out.sort((a, b) => String(a.manifest.created_at).localeCompare(String(b.manifest.created_at)));
  }

  async processOne(processStep, { isTransient = () => false } = {}) {
    const candidates = await this.pendingManifests();
    const found = candidates.find(({ manifest }) => !manifest.next_attempt_at || Date.parse(manifest.next_attempt_at) <= Date.now());
    if (!found) return false;
    const { dir: pendingDir, manifest: pendingManifest } = found;
    const processingDir = this.bundleDir(this.processingDir, pendingManifest.staging_id);
    // Use the same request-level lock as append operations. Without it, the worker
    // could delete a just-synchronised bundle between a route's lookup and append.
    await this.withLock(`request:${pendingManifest.request_id}`, () => this.withLock(pendingManifest.staging_id, async () => {
      await fsp.rename(pendingDir, processingDir);
      const manifest = await this.readManifest(processingDir);
      if (!manifest) return;
      manifest.status = 'processing';
      await this.writeJsonAtomic(this.manifestPath(processingDir), manifest);
      try {
        for (const step of manifest.steps) {
          if (step.done) continue;
          await processStep(manifest, step, processingDir);
          step.done = true;
          manifest.updated_at = nowIso();
          await this.writeJsonAtomic(this.manifestPath(processingDir), manifest);
        }
        await fsp.rm(processingDir, { recursive: true, force: true });
      } catch (err) {
        if (isTransient(err) && manifest.attempts < MAX_ATTEMPTS) {
          manifest.attempts += 1;
          const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(manifest.attempts - 1, 6)));
          manifest.next_attempt_at = new Date(Date.now() + delay).toISOString();
          manifest.status = 'pending';
          manifest.error = String(err && err.message || '').slice(0, 500);
          await this.writeJsonAtomic(this.manifestPath(processingDir), manifest);
          await fsp.rename(processingDir, this.bundleDir(this.pendingDir, manifest.staging_id));
        } else {
          await this.markFailed(processingDir, manifest, err);
        }
      }
    }));
    return true;
  }

  async statusesForActor(actor) {
    const matches = [];
    for (const base of [this.pendingDir, this.processingDir, this.failedDir]) {
      for (const dir of await this.directories(base)) {
        const manifest = await this.readManifest(dir);
        if (!manifest || (String(actor && actor.role || '') !== 'admin' && !actorMatches(manifest, actor))) continue;
        matches.push({
          staging_id: manifest.staging_id,
          request_id: manifest.request_id,
          pending_request_id: manifest.pending_request_id,
          status: manifest.status,
          error: manifest.error || '',
          created_at: manifest.created_at,
          updated_at: manifest.updated_at,
        });
      }
    }
    return matches.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }
}

module.exports = {
  StagingQueue,
  isPendingRequestId,
  shadowFromInput,
  applyShadowStep,
  RETRY_BASE_MS,
};
