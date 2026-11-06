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
export const PREPARATION_SCOPES = Object.freeze(['orchestration:read', 'orchestration:operate', 'source-control:write']);
const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
// Public HTTPS only. URL bytes are immutable; normalization must happen in native admission.
export function projectSource(value) {
  if (!closed(value, ['version', 'sourceId', 'hostProjectId', 'logicalRoot', 'clone', 'sourceDigest']) || value.version !== 1 ||
      !closed(value.clone, ['remoteUrl', 'protocol']) || value.clone.protocol !== 'https') throw Error('Invalid project source');
  identifier(value.sourceId); identifier(value.hostProjectId);
  if (value.sourceId.length < 16) throw Error('Invalid source identifier');
  if (value.logicalRoot !== `/projects/${value.sourceId}`) throw Error('Invalid logical project root');
  const remote = value.clone.remoteUrl;
  if (typeof remote !== 'string' || remote.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(remote)) throw Error('Invalid project remote');
  const url = new URL(remote);
  if (url.protocol !== 'https:' || !['github.com', 'gitlab.com', 'bitbucket.org'].includes(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash || url.href !== remote ||
      !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/.test(url.pathname) || url.pathname.includes('..')) throw Error('Unsupported project remote');
  const { sourceDigest, ...identity } = value;
  if (sourceDigest !== digest(canonicalJson(identity))) throw Error('Project source digest mismatch');
  return JSON.parse(canonicalJson(value));
}
export function launchProject(value) {
  if (!closed(value, ['projectSource', 'workspaceStrategy']) || !value.workspaceStrategy ||
      typeof value.workspaceStrategy !== 'object' || Array.isArray(value.workspaceStrategy) ||
      Buffer.byteLength(canonicalJson(value.workspaceStrategy)) > 8192) throw Error('Invalid managed project launch');
  // Native admission owns OrchestrationV2ThreadLaunchWorkspaceStrategy validation.
  return { projectSource: projectSource(value.projectSource), workspaceStrategy: JSON.parse(canonicalJson(value.workspaceStrategy)) };
}
export function childIdentityMatches(binding, env) {
  if (env?.T3_CLOUD_BINDING_ID !== binding.allocationId) return false;
  if (binding.projectSource && env.T3_CLOUD_OWNER_GENERATION !== binding.managedBridge?.ownerGeneration) return false;
  if (binding.purpose === 'project-source') return env.T3_CLOUD_PURPOSE === 'project-source' &&
    env.T3_CLOUD_SOURCE_ID === binding.projectSource.sourceId && env.T3_CLOUD_SOURCE_DIGEST === binding.projectSource.sourceDigest &&
    env.T3_CLOUD_PROJECT_ID === binding.projectId && env.T3_CLOUD_PROJECT_ROOT === binding.workspaceRoot &&
    env.T3_CLOUD_THREAD_ID === undefined && env.T3_CLOUD_PROVIDER_INSTANCE_ID === undefined &&
    env.T3_CLOUD_EXEC_TOKEN_SHA256 === undefined && env.T3_CLOUD_BRIDGE_URL === undefined && env.T3_CLOUD_BRIDGE_TOKEN === undefined && env.T3_CLOUD_EDGE_TOKEN === undefined;
  return (env.T3_CLOUD_PURPOSE === undefined || env.T3_CLOUD_PURPOSE === 'thread') && env.T3_CLOUD_THREAD_ID === binding.threadId && providerInstanceId(env.T3_CLOUD_PROVIDER_INSTANCE_ID) === providerInstanceId(binding.providerInstanceId) &&
    (binding.projectSource ? env.T3_CLOUD_SOURCE_DIGEST === binding.projectSource.sourceDigest && env.T3_CLOUD_PROJECT_ID === binding.projectId &&
      env.T3_CLOUD_PROJECT_ROOT === binding.workspaceRoot && env.T3_CLOUD_LAUNCH_DIGEST === digest(canonicalJson({ projectSource: binding.projectSource, workspaceStrategy: binding.workspaceStrategy })) : env.T3_CLOUD_SOURCE_DIGEST === undefined);
}
export function equalSecret(value, expected) {
  return typeof value === 'string' && typeof expected === 'string' && value.length > 0 &&
    timingSafeEqual(Buffer.from(digest(value)), Buffer.from(digest(expected)));
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw Error('Invalid identifier');
  return value;
}
// ThreadId is a native trimmed non-empty string, not a resource/CLI identifier.
// Preserve exact bytes (including URI escapes). Never decode or normalize them.
export function threadIdentifier(value) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value || value.includes('\0'))
    throw Error('Invalid thread identifier');
  return value;
}
export function isThreadIdentifier(value) {
  try { threadIdentifier(value); return true; } catch { return false; }
}
const legacyThread = value => /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const threadStorageKey = value => {
  threadIdentifier(value);
  // The '~' namespace cannot collide with an existing legacy filename.
  return legacyThread(value) ? value : `~thread-${digest(JSON.stringify(value))}`;
};
export function nativeSessionId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw Error('Invalid native session identifier');
  return value;
}
export class AllocationStore {
  constructor(directory) { this.directory = directory; this.active = new Map(); }
  async initialize() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  async load(threadId) {
    try {
      const binding = JSON.parse(await readFile(join(this.directory, `${threadStorageKey(threadId)}.json`), 'utf8'));
      if (binding.threadId !== threadId) throw Error('Allocation thread identity mismatch');
      return binding;
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async list() {
    const names = await readdir(this.directory);
    return Promise.all(names.filter(name => /^(?:[a-zA-Z0-9_-]{1,128}|~thread-[a-f0-9]{64})\.json$/.test(name)).map(async name => {
      const binding = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
      if (`${threadStorageKey(binding.threadId)}.json` !== name) throw Error('Allocation thread identity mismatch');
      return binding;
    }));
  }
  async save(binding) {
    const path = join(this.directory, `${threadStorageKey(binding.threadId)}.json`);
    // Check both ordinary accidental corruption and any storage-key collision.
    await this.load(binding.threadId);
    await this.atomicWrite(path, binding, this.directory);
  }
  async loadSource(sourceId) {
    try {
      const value = JSON.parse(await readFile(join(this.directory, `~project-source-${identifier(sourceId)}.json`), 'utf8'));
      if (value.purpose !== 'project-source' || value.projectSource?.sourceId !== sourceId || value.threadId !== undefined || value.providerInstanceId !== undefined || value.execToken !== undefined) throw Error('Source allocation identity mismatch');
      projectSource(value.projectSource);
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async saveSource(binding) {
    const source = projectSource(binding.projectSource);
    if (binding.purpose !== 'project-source' || binding.threadId !== undefined || binding.providerInstanceId !== undefined || binding.execToken !== undefined) throw Error('Invalid source allocation');
    await this.loadSource(source.sourceId);
    await this.atomicWrite(join(this.directory, `~project-source-${source.sourceId}.json`), binding, this.directory);
  }
  async listSources() {
    return Promise.all((await readdir(this.directory)).filter(name => /^~project-source-[a-zA-Z0-9_-]{1,128}\.json$/.test(name))
      .map(name => this.loadSource(name.slice(16, -5))));
  }
  loadBinding(key, purpose) { return purpose === 'project-source' ? this.loadSource(key) : this.load(key); }
  saveBinding(binding) { return binding.purpose === 'project-source' ? this.saveSource(binding) : this.save(binding); }
  async atomicWrite(path, value, parent) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    const directory = await open(parent, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async loadOperation(threadId, key) {
    try { return JSON.parse(await readFile(join(this.directory, 'operations', threadStorageKey(threadId), `${identifier(key)}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async saveOperation(threadId, operation) {
    const directory = join(this.directory, 'operations', threadStorageKey(threadId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.atomicWrite(join(directory, `${identifier(operation.key)}.json`), operation, directory);
    for (const path of [join(this.directory, 'operations'), this.directory]) {
      const parent = await open(path, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    }
  }
  async listOperations(threadId) {
    let names;
    try { names = await readdir(join(this.directory, 'operations', threadStorageKey(threadId))); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).map(name => this.loadOperation(threadId, name.slice(0, -5))));
  }
  async mutationMarkers(threadId) {
    try { return await readdir(join(this.directory, 'pending-mutations', threadStorageKey(threadId))); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async markMutation(threadId, attemptId, method) {
    const directory = join(this.directory, 'pending-mutations', threadStorageKey(threadId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, identifier(attemptId));
    const handle = await open(file, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify({ method })); await handle.sync(); } finally { await handle.close(); }
    for (const path of [directory, join(this.directory, 'pending-mutations'), this.directory]) {
      const parent = await open(path, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    }
  }
  async serialized(threadId, operation) {
    threadIdentifier(threadId);
    const previous = this.active.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.active.set(threadId, current);
    try { return await current; } finally { if (this.active.get(threadId) === current) this.active.delete(threadId); }
  }
}
export class ThreadAllocator {
  constructor({ store, cloud, image, bridgeUrl, edgeCredential, registerEnvironment, cleanup, reconcileCleanup, closeBridge, admittedProviders = ['codex'] }) {
    if (!/^.+@sha256:[a-f0-9]{64}$/.test(image)) throw Error('Child image must be pinned by digest');
    bridgeAddress(bridgeUrl); edgeToken(edgeCredential);
    this.admittedProviders = new Set(admittedProviders.map(providerInstanceId));
    Object.assign(this, { store, cloud, image, bridgeUrl, edgeCredential, registerEnvironment, cleanup, reconcileCleanup, closeBridge });
  }
  async allocate(ownerId, threadId, requestedProvider, managedBridge, project) {
    if (project) project = launchProject(project);
    if (managedBridge) identifier(managedBridge.ownerGeneration);
    const provider = providerInstanceId(requestedProvider);
    if (!this.admittedProviders.has(provider)) throw Error('Provider admission unavailable');
    identifier(ownerId); threadIdentifier(threadId);
    return this.store.serialized(threadId, async () => {
      let binding = await this.store.load(threadId);
      if (binding && binding.ownerId !== ownerId) throw Error('Allocation belongs to another owner');
      if (binding && providerInstanceId(binding.providerInstanceId) !== provider) throw Error('Immutable allocation provider mismatch');
      if (binding && canonicalJson(binding.projectSource ? { projectSource: binding.projectSource, workspaceStrategy: binding.workspaceStrategy } : null) !== canonicalJson(project ?? null)) throw Error('Immutable allocation project mismatch');
      if (binding?.state === 'revoked') throw Error('Allocation revoked');
      if (binding && (managedBridge ? binding.managedBridge?.ownerGeneration !== managedBridge.ownerGeneration : binding.managedBridge !== undefined))
        throw Error('Immutable allocation mode mismatch');
      if (binding) {
        requireEdgeBinding(binding, this.edgeCredential);
        if (binding.providerInstanceId === undefined) { binding.providerInstanceId = provider; await this.store.save(binding); }
      }
      if (!binding) {
        binding = { version: 1, purpose: 'thread', ownerId, threadId, ...(project ?? {}), ...(managedBridge ? { managedBridge } : {}), providerInstanceId: provider, allocationId: randomUUID(), projectId: randomUUID(),
          bridgeToken: randomBytes(32).toString('base64url'), execToken: randomBytes(32).toString('base64url'),
          edgeTokenHash: digest(this.edgeCredential), state: 'creating', nativeThreadId: null };
        if (project) binding.workspaceRoot = `/work/projects/${project.projectSource.sourceId}`;
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
      if (managedBridge) return { allocationId: binding.allocationId, environmentId: binding.environmentId, threadId,
        providerInstanceId: provider, project: { id: binding.projectId, title: 'Sandbox', workspaceRoot: binding.workspaceRoot ?? '/work' } };
      const credential = await this.cloud.pair(binding);
      return { allocationId: binding.allocationId, environmentId: binding.environmentId, threadId, providerInstanceId: provider,
        project: { id: binding.projectId, title: 'Sandbox', workspaceRoot: binding.workspaceRoot ?? '/work' },
        connection: { url: binding.t3Url, credential } };
    });
  }
  async allocateSource(ownerId, source, generation) {
    identifier(ownerId); identifier(generation); source = projectSource(source);
    const key = source.sourceId;
    return this.store.serialized(`~project-source-${key}`, async () => {
      let binding = await this.store.loadSource(key);
      if (binding && (binding.ownerId !== ownerId || binding.managedBridge.ownerGeneration !== generation ||
          canonicalJson(binding.projectSource) !== canonicalJson(source))) throw Error('Immutable source allocation mismatch');
      if (binding) requireEdgeBinding(binding, this.edgeCredential);
      if (!binding) {
        binding = { version: 1, purpose: 'project-source', ownerId, projectSource: source, managedBridge: { ownerGeneration: generation },
          allocationId: randomUUID(), projectId: randomUUID(), workspaceRoot: `/work/projects/${key}`, edgeTokenHash: digest(this.edgeCredential), state: 'creating' };
        binding.stack = `t3-source-${binding.allocationId.replaceAll('-', '').slice(0, 24)}`;
        await this.store.saveSource(binding);
        try {
          const created = await this.cloud.create(binding, { image: this.image, bridgeUrl: this.bridgeUrl, edgeCredential: this.edgeCredential });
          binding.briqId = identifier(created.id); binding.rootStackId = identifier(created.stackId); binding.state = 'created'; await this.store.saveSource(binding);
        } catch { binding.state = 'unknown'; await this.store.saveSource(binding); throw Error('Source allocation outcome unknown; reconcile before retry'); }
      }
      if (['creating', 'unknown'].includes(binding.state)) {
        const recovered = await this.cloud.find(binding);
        if (!recovered) throw Error('Source allocation unknown; no create replay permitted');
        binding.briqId = identifier(recovered.id); binding.rootStackId = identifier(recovered.stackId); binding.state = 'created'; await this.store.saveSource(binding);
      }
      if (binding.state === 'created') {
        const endpoints = await this.cloud.endpoints(binding); binding.t3Url = endpoints.t3Url;
        const descriptor = await this.cloud.descriptor(binding); binding.environmentId = identifier(descriptor.environmentId);
        binding.state = 'ready'; await this.store.saveSource(binding);
      }
      if (binding.state !== 'ready' || binding.rootStop) throw Error('Source allocation not ready');
      return { purpose: binding.purpose, sourceId: key, sourceDigest: source.sourceDigest, allocationId: binding.allocationId,
        environmentId: binding.environmentId, projectId: binding.projectId, workspaceRoot: binding.workspaceRoot };
    });
  }
  bridgeIdentity(binding) {
    return digest(canonicalJson([binding.purpose ?? 'thread', binding.projectSource ?? null, binding.workspaceStrategy ?? null, binding.projectId, binding.workspaceRoot ?? '/work', binding.ownerId, binding.threadId, binding.allocationId, binding.briqId,
      binding.rootStackId, binding.environmentId, binding.execEnvironmentId, binding.t3Url,
      binding.purpose === 'project-source' ? null : providerInstanceId(binding.providerInstanceId), binding.edgeTokenHash]));
  }
  async checkedBridgeBinding(ownerId, threadId, allocationId, generation, expected, cleanup = false, purpose = 'thread') {
    threadIdentifier(threadId);
    for (const value of [ownerId, allocationId, generation]) identifier(value);
    const binding = await this.store.loadBinding(threadId, purpose);
    if (!binding || binding.ownerId !== ownerId || binding.allocationId !== allocationId ||
        (purpose === 'project-source' ? binding.purpose !== purpose : binding.purpose === 'project-source' || !this.admittedProviders.has(providerInstanceId(binding.providerInstanceId))) ||
        (cleanup ? !['ready', 'revoked'].includes(binding.state) : binding.state !== 'ready' || binding.restoreState || binding.rootStop))
      throw Error('Managed bridge binding unavailable');
    requireEdgeBinding(binding, this.edgeCredential);
    for (const value of [binding.briqId, binding.rootStackId, binding.environmentId, ...(purpose === 'project-source' ? [] : [binding.execEnvironmentId])]) identifier(value);
    const url = new URL(binding.t3Url);
    if (url.protocol !== 'https:' || url.origin !== binding.t3Url || url.username || url.password) throw Error('Invalid child endpoint');
    if (expected && this.bridgeIdentity(binding) !== expected) throw Error('Managed bridge binding changed');
    if (binding.managedBridge && binding.managedBridge.ownerGeneration !== generation) throw Error('Managed allocation generation changed');
    for (const session of [binding.bridgeSession, binding.preparationSession]) if (session && (session.ownerGeneration !== generation || session.identity !== this.bridgeIdentity(binding))) throw Error('Managed bridge generation changed');
    return binding;
  }
  // Private server-side link; never return this value from the manager's public allocation routes.
  async bridgeSession(ownerId, threadId, allocationId, generation, purpose = 'thread', preparation = purpose === 'project-source') {
    if (purpose === 'project-source' && !preparation) throw Error('Source child cannot issue ACP session');
    const field = preparation ? 'preparationSession' : 'bridgeSession';
    return this.store.serialized(purpose === 'project-source' ? `~project-source-${threadId}` : threadId, async () => {
      if (typeof this.closeBridge !== 'function') throw Error('Managed bridge socket owner unavailable');
      let binding = await this.checkedBridgeBinding(ownerId, threadId, allocationId, generation, undefined, false, purpose);
      if (preparation && !binding.projectSource) throw Error('Project preparation requires bound source');
      let session = binding[field];
      if (preparation && session?.state === 'revoked') {
        binding.preparationHistory ??= [];
        binding.preparationHistory.push({ subject: session.subject, sessionId: session.sessionId, state: 'revoked' });
        delete binding[field]; await this.store.saveBinding(binding); session = undefined;
      }
      if (!session) {
        const identity = this.bridgeIdentity(binding);
        session = { state: 'issuing', identity, ownerGeneration: generation,
          kind: preparation ? 'preparation' : 'acp',
          subject: `briq-bridge:${allocationId}:${generation}:${randomUUID()}` };
        binding[field] = session; await this.store.saveBinding(binding);
        const validate = () => this.checkedBridgeBinding(ownerId, threadId, allocationId, generation, identity, false, purpose);
        try {
          const issued = await this.cloud.issueBridgeSession(binding, session.subject, validate, { preparation });
          session.issueTerminal = true; binding[field] = session; await this.store.saveBinding(binding);
          nativeSessionId(issued.sessionId);
          const remaining = Date.parse(issued.expiresAt) - Date.now();
          if (issued.subject !== session.subject || issued.method !== 'bearer-access-token' ||
              typeof issued.token !== 'string' || !issued.token || issued.token.length > 16384 || /[\s\x00-\x1f\x7f]/.test(issued.token) ||
              !Array.isArray(issued.scopes) || canonicalJson([...issued.scopes].sort()) !== canonicalJson([...(preparation ? PREPARATION_SCOPES : PREPARATION_SCOPES.slice(0, 2))].sort()) ||
              !Number.isFinite(remaining) || remaining <= 0 || remaining > (preparation ? 300000 : 30 * 86400000))
            throw Error('Native bridge session identity unavailable');
          binding = await validate();
          binding[field] = { ...session, state: 'ready', sessionId: issued.sessionId, token: issued.token, expiresAt: issued.expiresAt };
          await this.store.saveBinding(binding);
          session = binding[field];
        } catch {
          // The native issue may have committed. A new issue requires explicit revoke reconciliation.
          binding = await this.store.loadBinding(threadId, purpose);
          if (binding?.[field]?.subject === session.subject) {
            delete binding[field].token; binding[field].state = 'unknown'; await this.store.saveBinding(binding);
          }
          throw Error('Managed bridge session requires reconciliation');
        }
      }
      if (session.state !== 'ready' || !session.token || Date.parse(session.expiresAt) <= Date.now())
        throw Error('Managed bridge session requires reconciliation');
      return { allocationId, ...(preparation ? { purpose, sourceId: binding.projectSource.sourceId, sourceDigest: binding.projectSource.sourceDigest, workspaceRoot: binding.workspaceRoot } : {}), ...(purpose === 'project-source' ? { purpose, sourceId: threadId, sourceDigest: binding.projectSource.sourceDigest, workspaceRoot: binding.workspaceRoot } : { threadId, providerInstanceId: providerInstanceId(binding.providerInstanceId) }), environmentId: binding.environmentId,
        projectId: binding.projectId, httpBaseUrl: binding.t3Url, token: session.token, sessionId: session.sessionId, ownerGeneration: generation };
    });
  }
  async reconcileBridgeSession(ownerId, threadId, allocationId, generation, purpose = 'thread', preparation = purpose === 'project-source') {
    return this.store.serialized(purpose === 'project-source' ? `~project-source-${threadId}` : threadId, async () => {
      const binding = await this.checkedBridgeBinding(ownerId, threadId, allocationId, generation, undefined, true, purpose);
      return this.revokeManagedBridgeSession(binding, preparation ? 'preparationSession' : 'bridgeSession');
    });
  }
  async revokeManagedBridgeSession(binding, field = 'bridgeSession') {
    const session = binding[field];
    if (!session || session.state === 'revoked') return;
    if (session.issueTerminal !== true) throw Error('Native bridge issue execution requires terminal reconciliation');
    delete session.token; session.state = 'revoking'; await this.store.saveBinding(binding);
    // CLI revocation updates the native database; its process-local PubSub cannot close our sockets.
    await this.closeBridge?.(binding);
    const validate = () => this.checkedBridgeBinding(binding.ownerId, binding.purpose === 'project-source' ? binding.projectSource.sourceId : binding.threadId, binding.allocationId,
      session.ownerGeneration, session.identity, true, binding.purpose ?? 'thread');
    try {
      const rows = await this.cloud.listBridgeSessions(binding, validate);
      for (const row of rows.filter(row => row.subject === session.subject)) {
        nativeSessionId(row.sessionId);
        session.revocations ??= {};
        if (session.revocations[row.sessionId]) throw Error('Native bridge revoke execution requires reconciliation');
        session.revocations[row.sessionId] = 'started'; await this.store.saveBinding(binding);
        await this.cloud.revokeBridgeSession(binding, row.sessionId, validate);
        session.revocations[row.sessionId] = 'completed'; await this.store.saveBinding(binding);
      }
      const remaining = await this.cloud.listBridgeSessions(binding, validate);
      if (remaining.some(row => row.subject === session.subject)) throw Error('Native bridge session still active');
      binding = await validate(); session.state = 'revoked'; binding[field].state = 'revoked'; await this.store.saveBinding(binding);
    } catch {
      binding[field].state = 'revoke_unknown'; await this.store.saveBinding(binding);
      throw Error('Managed bridge revocation requires reconciliation');
    }
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
      try { await this.revokeManagedBridgeSession(binding); await this.revokeManagedBridgeSession(binding, 'preparationSession'); } catch { failures.push(Error('Managed bridge revocation requires reconciliation')); }
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
  async revokeSource(ownerId, sourceId, allocationId, generation) {
    return this.store.serialized(`~project-source-${identifier(sourceId)}`, async () => {
      let binding = await this.checkedBridgeBinding(ownerId, sourceId, allocationId, generation, undefined, true, 'project-source');
      if (binding.state === 'revoked' && binding.rootStop?.state !== 'completed') {
        if (!await this.cloud.stopped(binding)) throw Error('Source stop requires reconciliation; no stop replay permitted');
        binding.rootStop.state = 'completed'; await this.store.saveSource(binding);
      }
      if (binding.state === 'revoked') return this.revokeManagedBridgeSession(binding, 'preparationSession');
      binding.state = 'revoked'; binding.rootStop = { briqId: binding.briqId, state: 'pending' }; await this.store.saveSource(binding);
      const failures = [];
      try { await this.revokeManagedBridgeSession(binding, 'preparationSession'); } catch (error) { failures.push(error); }
      try {
        binding.rootStop.state = 'started'; await this.store.saveSource(binding);
        await this.cloud.stop(binding);
        binding.rootStop.state = 'completed'; await this.store.saveSource(binding);
      } catch { binding.rootStop.state = 'unknown'; await this.store.saveSource(binding); failures.push(Error('Source stop requires reconciliation')); }
      if (failures.length) throw new AggregateError(failures, 'Source revocation requires reconciliation');
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
    if ([binding.bridgeSession, binding.preparationSession].some(session => session && session.state !== 'revoked')) return true;
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
    await this.revokeManagedBridgeSession(binding);
    await this.reconcileCleanup?.(binding);
    const operations = await this.store.listOperations(binding.threadId);
    if (this.unresolvedCleanup(binding, operations))
      throw Error('Revoked allocation cleanup requires reconciliation');
  }

}
