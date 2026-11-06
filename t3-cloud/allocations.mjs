import { edgeToken, bridgeAddress, requireEdgeBinding } from './edge-auth.mjs';
import { mkdir, readFile, open, rename, readdir } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

// Missing provider fields belong to legacy Codex allocations only.
export function providerInstanceId(value = 'codex') {
  if (!['codex', 'claudeAgent'].includes(value)) throw Error('Unsupported provider instance');
  return value;
}
export function providerMetadata(value) {
  if (!value || !['authenticated', 'unauthenticated', 'unknown'].includes(value.authStatus) ||
    !Array.isArray(value.models) || value.models.length > 256) throw Error('Provider metadata unavailable');
  const slugs = value.models.map(model => model?.slug);
  if (slugs.some(slug => typeof slug !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(slug)) || new Set(slugs).size !== slugs.length)
    throw Error('Provider catalog unavailable');
  return { models: slugs.map(slug => ({ slug })), authStatus: value.authStatus };
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
export function equalSecret(value, expected) {
  return typeof value === 'string' && typeof expected === 'string' && value.length > 0 &&
    timingSafeEqual(Buffer.from(digest(value)), Buffer.from(digest(expected)));
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw Error('Invalid identifier');
  return value;
}
export class AllocationStore {
  constructor(directory) { this.directory = directory; this.active = new Map(); }
  async initialize() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  async load(threadId) {
    try { return JSON.parse(await readFile(join(this.directory, `${identifier(threadId)}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async list() {
    const names = await readdir(this.directory);
    return Promise.all(names.filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).map(name => this.load(name.slice(0, -5))));
  }
  async save(binding) {
    const path = join(this.directory, `${identifier(binding.threadId)}.json`);
    await this.atomicWrite(path, binding, this.directory);
  }
  async atomicWrite(path, value, parent) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    const directory = await open(parent, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async loadOperation(threadId, key) {
    try { return JSON.parse(await readFile(join(this.directory, 'operations', identifier(threadId), `${identifier(key)}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async saveOperation(threadId, operation) {
    const directory = join(this.directory, 'operations', identifier(threadId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.atomicWrite(join(directory, `${identifier(operation.key)}.json`), operation, directory);
    for (const path of [join(this.directory, 'operations'), this.directory]) {
      const parent = await open(path, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    }
  }
  async listOperations(threadId) {
    let names;
    try { names = await readdir(join(this.directory, 'operations', identifier(threadId))); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).map(name => this.loadOperation(threadId, name.slice(0, -5))));
  }
  async mutationMarkers(threadId) {
    try { return await readdir(join(this.directory, 'pending-mutations', identifier(threadId))); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async markMutation(threadId, attemptId, method) {
    const directory = join(this.directory, 'pending-mutations', identifier(threadId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, identifier(attemptId));
    const handle = await open(file, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify({ method })); await handle.sync(); } finally { await handle.close(); }
    for (const path of [directory, join(this.directory, 'pending-mutations'), this.directory]) {
      const parent = await open(path, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    }
  }
  async serialized(threadId, operation) {
    identifier(threadId);
    const previous = this.active.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.active.set(threadId, current);
    try { return await current; } finally { if (this.active.get(threadId) === current) this.active.delete(threadId); }
  }
}
export class ThreadAllocator {
  constructor({ store, cloud, image, bridgeUrl, edgeCredential, registerEnvironment, cleanup, reconcileCleanup, admittedProviders = ['codex'] }) {
    if (!/^.+@sha256:[a-f0-9]{64}$/.test(image)) throw Error('Child image must be pinned by digest');
    bridgeAddress(bridgeUrl); edgeToken(edgeCredential);
    this.admittedProviders = new Set(admittedProviders.map(providerInstanceId));
    Object.assign(this, { store, cloud, image, bridgeUrl, edgeCredential, registerEnvironment, cleanup, reconcileCleanup });
  }
  async allocate(ownerId, threadId, requestedProvider) {
    const provider = providerInstanceId(requestedProvider);
    if (!this.admittedProviders.has(provider)) throw Error('Provider admission unavailable');
    identifier(ownerId); identifier(threadId);
    return this.store.serialized(threadId, async () => {
      let binding = await this.store.load(threadId);
      if (binding && binding.ownerId !== ownerId) throw Error('Allocation belongs to another owner');
      if (binding && providerInstanceId(binding.providerInstanceId) !== provider) throw Error('Immutable allocation provider mismatch');
      if (binding?.state === 'revoked') throw Error('Allocation revoked');
      if (binding) {
        requireEdgeBinding(binding, this.edgeCredential);
        if (binding.providerInstanceId === undefined) { binding.providerInstanceId = provider; await this.store.save(binding); }
      }
      if (!binding) {
        binding = { version: 1, ownerId, threadId, providerInstanceId: provider, allocationId: randomUUID(), projectId: randomUUID(),
          bridgeToken: randomBytes(32).toString('base64url'), execToken: randomBytes(32).toString('base64url'),
          edgeTokenHash: digest(this.edgeCredential), state: 'creating', nativeThreadId: null };
        binding.stack = `t3-${binding.allocationId.replaceAll('-', '').slice(0, 24)}`;
        binding.execEnvironmentId = `briq-${binding.allocationId}`;
        await this.store.save(binding);
        try {
          const created = await this.cloud.create(binding, { image: this.image, bridgeUrl: this.bridgeUrl, edgeCredential: this.edgeCredential });
          binding.briqId = identifier(created.id); binding.rootStackId = identifier(created.stackId);
          binding.state = 'created'; await this.store.save(binding);
        } catch { binding.state = 'unknown'; await this.store.save(binding); throw Error('Allocation outcome unknown; reconcile before retry'); }
      }
      if (binding.state === 'creating' || binding.state === 'unknown') {
        const recovered = await this.cloud.find(binding);
        if (!recovered) throw Error('Allocation outcome unknown; no create replay permitted');
        binding.briqId = identifier(recovered.id); binding.rootStackId = identifier(recovered.stackId); binding.state = 'created'; await this.store.save(binding);
      }
      if (binding.state === 'created') {
        const endpoints = await this.cloud.endpoints(binding);
        binding.t3Url = endpoints.t3Url; binding.execUrl = endpoints.execUrl;
        const descriptor = await this.cloud.descriptor(binding);
        binding.environmentId = identifier(descriptor.environmentId);
        binding.state = 'ready'; await this.store.save(binding);
      }
      if (binding.state !== 'ready') throw Error('Allocation not ready');
      await this.registerEnvironment(binding);
      const credential = await this.cloud.pair(binding);
      return { allocationId: binding.allocationId, environmentId: binding.environmentId, threadId, providerInstanceId: provider,
        project: { id: binding.projectId, title: 'Sandbox', workspaceRoot: '/work' },
        connection: { url: binding.t3Url, credential } };
    });
  }
  async revoke(ownerId, threadId) {
    return this.store.serialized(threadId, async () => {
      const binding = await this.store.load(threadId);
      if (!binding || binding.ownerId !== ownerId) throw Error('Unknown allocation');
      if (binding.state === 'revoked') return this.reconcileRevocation(binding);
      binding.state = 'revoked';
      binding.rootStop = { briqId: binding.briqId, state: 'pending' };
      if (providerInstanceId(binding.providerInstanceId) === 'claudeAgent') binding.nativeCleanup = {
        allocationId: binding.allocationId, threadId: binding.threadId,
        nativeId: binding.claudeNativeSessionId ?? null, state: 'pending',
      };
      await this.store.save(binding);
      const failures = [];
      try { await this.cleanup?.(binding); } catch { failures.push(Error('Descendant cleanup requires reconciliation')); }
      // Revocation is already durable. Cleanup uncertainty must not leave the known root running.
      try {
        binding.rootStop.state = 'started'; await this.store.save(binding);
        await this.cloud.stop(binding);
        binding.rootStop.state = 'completed'; await this.store.save(binding);
      } catch {
        binding.rootStop.state = 'unknown';
        try { await this.store.save(binding); } catch { /* Previous durable intent remains unresolved. */ }
        failures.push(Error('Workspace stop requires reconciliation'));
      }
      if (this.unresolvedNativeCleanup(binding)) failures.push(Error('Native cleanup requires reconciliation'));
      if (failures.length) throw new AggregateError(failures, 'Allocation revoked; cleanup requires reconciliation');
    });
  }
  async restorationIssues() {
    return (await this.store.list()).filter(binding => binding.state === 'ready' && binding.restoreState).map(binding => ({
      threadId: binding.threadId, allocationId: binding.allocationId,
      state: binding.restoreState === 'deferred' ? 'deferred' : 'reconciliation-required',
    }));
  }
  async revocationIssues() {
    const issues = [];
    for (const binding of await this.store.list()) {
      if (binding.state !== 'revoked') continue;
      const operations = await this.store.listOperations(binding.threadId);
      if (binding.rootStop?.state !== 'completed' || binding.rootStop.briqId !== binding.briqId || this.unresolvedCleanup(binding, operations))
        issues.push({ threadId: binding.threadId, allocationId: binding.allocationId, state: 'reconciliation-required' });
    }
    return issues;
  }
  unresolvedNativeCleanup(binding) {
    const native = binding.nativeCleanup;
    return providerInstanceId(binding.providerInstanceId) === 'claudeAgent' &&
      (!native || native.allocationId !== binding.allocationId || native.threadId !== binding.threadId ||
       native.nativeId !== (binding.claudeNativeSessionId ?? null) || native.state !== 'completed');
  }
  unresolvedCleanup(binding, operations) {
    // Root/descendant evidence cannot establish the central native owner's lifetime.
    if (this.unresolvedNativeCleanup(binding)) return true;
    return operations.some(row => row.method === 'briq/scoped' && row.allocationId === binding.allocationId &&
      (row.state !== 'completed' || row.cleanup && row.cleanup.state !== 'completed' || row.resource?.state === 'live' || row.exec && !row.exec.terminal));
  }
  async reconcileRevocation(binding) {
    // Restart and repeated revoke may inspect the exact root, never replay a control request.
    if (binding.state !== 'revoked' || !binding.rootStop || binding.rootStop.briqId !== binding.briqId)
      throw Error('Revoked allocation requires explicit root reconciliation');
    if (binding.rootStop.state !== 'completed') {
      if (!await this.cloud.stopped(binding)) throw Error('Workspace stop outcome remains unknown');
      binding.rootStop.state = 'completed'; await this.store.save(binding);
    }
    await this.reconcileCleanup?.(binding);
    const operations = await this.store.listOperations(binding.threadId);
    if (this.unresolvedCleanup(binding, operations))
      throw Error('Revoked allocation cleanup requires reconciliation');
  }

}
