import { mkdir, readFile, open, rename, readdir } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
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
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(binding)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
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
  constructor({ store, cloud, image, bridgeUrl, registerEnvironment }) {
    if (!/^.+@sha256:[a-f0-9]{64}$/.test(image)) throw Error('Child image must be pinned by digest');
    const bridge = new URL(bridgeUrl);
    if (bridge.protocol !== 'wss:' || bridge.username || bridge.password || bridge.search || bridge.hash)
      throw Error('Child bridge requires a clean WSS URL');
    Object.assign(this, { store, cloud, image, bridgeUrl, registerEnvironment });
  }
  async allocate(ownerId, threadId) {
    identifier(ownerId); identifier(threadId);
    return this.store.serialized(threadId, async () => {
      let binding = await this.store.load(threadId);
      if (binding && binding.ownerId !== ownerId) throw Error('Allocation belongs to another owner');
      if (binding?.state === 'revoked') throw Error('Allocation revoked');
      if (!binding) {
        binding = { version: 1, ownerId, threadId, allocationId: randomUUID(), projectId: randomUUID(),
          bridgeToken: randomBytes(32).toString('base64url'), execToken: randomBytes(32).toString('base64url'),
          state: 'creating', nativeThreadId: null };
        binding.stack = `t3-${binding.allocationId.replaceAll('-', '').slice(0, 24)}`;
        binding.execEnvironmentId = `briq-${binding.allocationId}`;
        await this.store.save(binding);
        try {
          binding.briqId = await this.cloud.create(binding, { image: this.image, bridgeUrl: this.bridgeUrl });
          binding.state = 'created'; await this.store.save(binding);
        } catch { binding.state = 'unknown'; await this.store.save(binding); throw Error('Allocation outcome unknown; reconcile before retry'); }
      }
      if (binding.state === 'creating' || binding.state === 'unknown') {
        const recovered = await this.cloud.find(binding);
        if (!recovered) throw Error('Allocation outcome unknown; no create replay permitted');
        binding.briqId = recovered; binding.state = 'created'; await this.store.save(binding);
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
      return { allocationId: binding.allocationId, environmentId: binding.environmentId, threadId,
        project: { id: binding.projectId, title: 'Sandbox', workspaceRoot: '/work' },
        connection: { url: binding.t3Url, credential } };
    });
  }
  async revoke(ownerId, threadId) {
    return this.store.serialized(threadId, async () => {
      const binding = await this.store.load(threadId);
      if (!binding || binding.ownerId !== ownerId) throw Error('Unknown allocation');
      binding.state = 'revoked'; await this.store.save(binding);
      await this.cloud.stop(binding);
    });
  }
}
