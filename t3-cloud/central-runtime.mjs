import { ClaudeRuntime } from './claude-runtime.mjs';
import { edgeToken, edgeAuthorized, requireEdgeBinding } from './edge-auth.mjs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { AllocationStore, ThreadAllocator, identifier, threadIdentifier, providerInstanceId } from './allocations.mjs';
import { BriqCloud } from './briq-cloud.mjs';
import { startAppServer, CapabilityBroker } from './broker.mjs';
import { ScopedBriq } from './scoped-briq.mjs';
import { ScopedMcpTransport } from './scoped-mcp-transport.mjs';

// Owner management for existing children only; never calls allocation or recovery.
export function childPairing({ store, cloud, edgeCredential, admittedProviders, ready }) {
  function summary(binding) {
    return { threadId: binding.threadId, allocationId: binding.allocationId, environmentId: binding.environmentId,
      providerInstanceId: providerInstanceId(binding.providerInstanceId), url: binding.t3Url };
  }
  async function checked(ownerId, threadId, allocationId, expected) {
    identifier(ownerId); threadIdentifier(threadId); identifier(allocationId);
    const binding = await store.load(threadId);
    if (!ready() || !binding || binding.ownerId !== ownerId || binding.allocationId !== allocationId || binding.threadId !== threadId ||
        binding.state !== 'ready' || binding.restoreState || binding.nativeState !== undefined && binding.nativeState !== 'bound' || binding.turnState !== undefined && binding.turnState !== 'bound' ||
        binding.nativeCleanup || binding.rootStop || !admittedProviders.includes(providerInstanceId(binding.providerInstanceId))) throw Error('Child pairing unavailable');
    requireEdgeBinding(binding, edgeCredential);
    for (const field of ['briqId', 'rootStackId', 'environmentId', 'execEnvironmentId']) identifier(binding[field]);
    const url = new URL(binding.t3Url);
    if (url.protocol !== 'https:' || url.origin !== binding.t3Url || url.username || url.password) throw Error('Invalid child endpoint');
    if (expected && JSON.stringify([binding.briqId, binding.rootStackId, binding.environmentId, binding.execEnvironmentId,
        binding.t3Url, binding.stack, binding.execUrl, binding.execToken, binding.bridgeToken, binding.nativeThreadId ?? null, binding.claudeNativeSessionId ?? null, providerInstanceId(binding.providerInstanceId)]) !== expected) throw Error('Child binding changed');
    if ((await store.mutationMarkers(threadId)).length) throw Error('Child has unresolved mutations');
    for (const op of await store.listOperations(threadId)) {
      if (op.threadId !== threadId || op.allocationId !== allocationId || (op.method === 'briq/scoped' ? op.state !== 'completed' : op.state !== 'adopted')) throw Error('Child has unresolved operations');
    }
    return binding;
  }
  return {
    async phoneChildren(ownerId) {
      const rows = [];
      for (const binding of await store.list()) {
        try { rows.push(summary(await checked(ownerId, binding.threadId, binding.allocationId))); } catch { /* Only ready owned children are selectable. */ }
      }
      return rows;
    },
    async pairChild(ownerId, threadId, allocationId) {
      return store.serialized(threadId, async () => {
        const binding = await checked(ownerId, threadId, allocationId);
        const expected = JSON.stringify([binding.briqId, binding.rootStackId, binding.environmentId, binding.execEnvironmentId,
          binding.t3Url, binding.stack, binding.execUrl, binding.execToken, binding.bridgeToken, binding.nativeThreadId ?? null, binding.claudeNativeSessionId ?? null, providerInstanceId(binding.providerInstanceId)]);
        const validate = () => checked(ownerId, threadId, allocationId, expected);
        const pairing = await cloud.pair(binding, { phone: true, validate });
        await validate();
        return { ...summary(binding), ...pairing };
      });
    },
  };
}

// A single refresh owner. A stale lock needs explicit operator reconciliation;
// an uncertain process lifetime never licenses a second app-server.
export async function createCentralRuntime(env = process.env, dependencies = {}) {
  const edgeCredential = edgeToken(env.T3_CLOUD_EDGE_TOKEN);
  const directory = env.T3_CLOUD_STATE;
  if (!directory || !isAbsolute(directory)) throw Error('Absolute central state directory required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'central.lock');
  await mkdir(lock, { mode: 0o700 });
  let app, websocket, claude, briqTransport; const peers = new Set(); let stopped = false;
  const bridgeLeases = new Map();
  const closeManagedBridge = binding => {
    for (const close of bridgeLeases.get(binding.allocationId) ?? []) close();
    bridgeLeases.delete(binding.allocationId);
  };
  async function close() {
    if (stopped) return; stopped = true;
    for (const peer of peers) peer.terminate();
    for (const callbacks of bridgeLeases.values()) for (const close of callbacks) close();
    bridgeLeases.clear();
    websocket?.close(); briqTransport?.close();
    await claude?.close();
    await app?.close();
    await rm(lock, { recursive: true });
  }
  try {
    const handle = await open(join(lock, 'owner.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); } finally { await handle.close(); }
    const store = new AllocationStore(join(directory, 'allocations')); await store.initialize();
    for (const binding of [...await store.list(), ...await store.listSources()]) if (binding.state !== 'revoked') requireEdgeBinding(binding, edgeCredential);
    app = await (dependencies.startAppServer ?? startAppServer)({ binary: env.T3_CLOUD_CODEX_BINARY ?? 'codex', home: join(directory, 'codex') });
    const cloud = dependencies.cloud ?? new BriqCloud({ directory: join(directory, 'stacks'), env });
    const scopedBriq = new ScopedBriq({ store, cloud });
    briqTransport = (dependencies.createScopedMcpTransport ?? (options => new ScopedMcpTransport(options)))({ store, scopedBriq, endpoint: `http://127.0.0.1:${env.PORT ?? 8080}/_cloud/briq/mcp` });
    const claudeLedger = new AllocationStore(join(directory, 'claude-ledger')); await claudeLedger.initialize();
    claude = (dependencies.createClaudeRuntime ?? (options => new ClaudeRuntime(options)))({ store, ledger: claudeLedger, cloud, scopedBriq, directory: join(directory, 'claude'), nativeHome: env.HOME, nativeConfigDirectory: env.CLAUDE_CONFIG_DIR });
    const admittedProviders = Object.freeze(['codex', ...(claude.enabled === true ? ['claudeAgent'] : [])]);
    const broker = new CapabilityBroker({ store, app, claude, briqTransport, admittedProviders });
    let ready = false, restoring, retryRestore = false;
    function restore() {
      if (stopped) throw Error('Central runtime stopped');
      if (restoring) return restoring;
      if (ready && !retryRestore) return Promise.resolve();
      retryRestore = false;
      restoring = (async () => {
        // The manager must bind the loopback MCP route before native restoration.
        for (let binding of await store.list()) {
          if (binding.state === 'revoked') {
            if (allocator.unresolvedNativeCleanup(binding)) claude.quarantineRevocation?.(binding);
            // Read-only evidence can settle an exact root stop. Unavailable auth or
            // unresolved cleanup stays per-allocation; managed owner sign-in remains usable.
            try { await store.serialized(binding.threadId, () => allocator.reconcileRevocation(binding)); } catch { /* Durable uncertainty remains visible through revocationIssues. */ }
            continue;
          }
          if (binding.state !== 'ready' || ready && !binding.restoreState) continue;
          const provider = providerInstanceId(binding.providerInstanceId);
          if (!admittedProviders.includes(provider)) throw Error('Persisted provider is not admitted');
          if (provider === 'claudeAgent') {
            if (binding.nativeThreadId) throw Error('Claude allocation contains Codex identity');
            continue;
          }
          await store.serialized(binding.threadId, async () => {
            const current = await store.load(binding.threadId);
            if (current?.state !== 'ready' || current.allocationId !== binding.allocationId || ready && !current.restoreState) return;
            binding = current;
            try {
              await broker.registerEnvironment(binding);
              if (binding.nativeThreadId) {
                const model = await broker.effectiveCodexModel(binding);
                const result = await broker.resumeNative(binding, { model, recovery: true, params: { excludeTurns: false } });
                const turn = result.thread.turns?.findLast(value => value.status === 'inProgress');
                if (turn) broker.activeTurns.set(binding.nativeThreadId, turn.id);
                // History alone does not correlate an uncertain client mutation. Keep quarantine.
              } else if (binding.restoreState) { delete binding.restoreState; await store.save(binding); }
            } catch {
              // Failure before resume leaves the previous binding intact; failure after
              // its durable intent retains nativeState=unknown. Neither permits replay.
              retryRestore = true;
              binding.restoreState = binding.nativeState === 'unknown' ? 'reconciliation-required' : 'deferred';
              await store.save(binding);
            }
          });
        }
        if (stopped) throw Error('Central runtime stopped');
        ready = true;
      })();
      return restoring.finally(() => { restoring = null; });
    }
    const allocator = new ThreadAllocator({ store, cloud, admittedProviders, closeBridge: closeManagedBridge, image: env.T3_CLOUD_CHILD_IMAGE,
      edgeCredential, bridgeUrl: new URL('/_cloud/bridge', env.T3_CLOUD_PUBLIC_ORIGIN).href.replace(/^https:/, 'wss:'),
      registerEnvironment: binding => broker.registerEnvironment(binding),
      reconcileCleanup: binding => scopedBriq.reconcileCleanup(binding),
      cleanup: async binding => {
        briqTransport.revoke(binding.allocationId);
        const nativeCleanup = async () => {
          if (providerInstanceId(binding.providerInstanceId) !== 'claudeAgent') return;
          binding.nativeCleanup.state = 'started'; await store.save(binding);
          try {
            await claude.revoke(binding);
            binding.nativeCleanup.state = 'completed'; await store.save(binding);
          } catch {
            binding.nativeCleanup.state = 'unknown';
            try { await store.save(binding); } catch { /* Durable intent stays unresolved. */ }
            throw Error('Native termination requires reconciliation');
          }
        };
        const results = await Promise.allSettled([nativeCleanup(), scopedBriq.cleanup(binding)]);
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Allocation cleanup requires reconciliation');
      } });
    const managedBinding = async (ownerId, threadId, allocationId, generation) => {
      if (!ready || stopped) throw Error('Managed bridge unavailable');
      const binding = await allocator.checkedBridgeBinding(ownerId, threadId, allocationId, generation);
      if (binding.managedBridge?.ownerGeneration !== generation) throw Error('Managed launch binding required');
      return binding;
    };
    allocator.managedBridgeSession = async (ownerId, threadId, allocationId, generation) => {
      await managedBinding(ownerId, threadId, allocationId, generation);
      return allocator.bridgeSession(ownerId, threadId, allocationId, generation);
    };
    allocator.openBridgeLease = (ownerId, threadId, allocationId, generation, close) => store.serialized(threadId, async () => {
      const binding = await managedBinding(ownerId, threadId, allocationId, generation);
      const session = binding.bridgeSession;
      if (session?.state !== 'ready' || !session.token || Date.parse(session.expiresAt) <= Date.now()) throw Error('Managed session unavailable');
      let callbacks = bridgeLeases.get(allocationId);
      if (!callbacks) bridgeLeases.set(allocationId, callbacks = new Set());
      callbacks.add(close);
      return () => {
        callbacks.delete(close);
        if (!callbacks.size) bridgeLeases.delete(allocationId);
      };
    });
    const preparationBinding = async (ownerId, key, allocationId, generation, purpose, identity) => {
      if (!ready || stopped || !['thread', 'project-source'].includes(purpose)) throw Error('Managed preparation unavailable');
      const binding = await allocator.checkedBridgeBinding(ownerId, key, allocationId, generation, undefined, false, purpose);
      if (binding.managedBridge?.ownerGeneration !== generation || !binding.projectSource ||
          binding.projectSource.sourceDigest !== identity.sourceDigest || binding.projectId !== identity.projectId || binding.workspaceRoot !== identity.workspaceRoot)
        throw Error('Immutable preparation identity mismatch');
      return binding;
    };
    allocator.managedPreparationSession = async (ownerId, key, allocationId, generation, purpose, identity) => {
      await preparationBinding(ownerId, key, allocationId, generation, purpose, identity);
      return allocator.bridgeSession(ownerId, key, allocationId, generation, purpose, true);
    };
    allocator.revokePreparationSession = async (ownerId, key, allocationId, generation, purpose, identity) => {
      await preparationBinding(ownerId, key, allocationId, generation, purpose, identity);
      return allocator.reconcileBridgeSession(ownerId, key, allocationId, generation, purpose, true);
    };
    allocator.openPreparationLease = (ownerId, key, allocationId, generation, purpose, identity, close) =>
      store.serialized(purpose === 'project-source' ? `~project-source-${key}` : key, async () => {
        const binding = await preparationBinding(ownerId, key, allocationId, generation, purpose, identity);
        const session = binding.preparationSession;
        if (session?.state !== 'ready' || !session.token || Date.parse(session.expiresAt) <= Date.now()) throw Error('Preparation session unavailable');
        let callbacks = bridgeLeases.get(allocationId);
        if (!callbacks) bridgeLeases.set(allocationId, callbacks = new Set());
        callbacks.add(close);
        const expiry = setTimeout(close, Math.max(1, Date.parse(session.expiresAt) - Date.now())); expiry.unref?.();
        return () => { clearTimeout(expiry); callbacks.delete(close); if (!callbacks.size) bridgeLeases.delete(allocationId); };
      });
    Object.assign(allocator, childPairing({ store, cloud, edgeCredential, admittedProviders, ready: () => ready && !stopped }));
    websocket = new WebSocketServer({ noServer: true, maxPayload: 2097152, perMessageDeflate: false });
    async function bridgeUpgrade(req, socket, head) {
      let session;
      try {
        if (stopped || !ready || req.headers.origin !== undefined || req.url !== '/_cloud/bridge' || !edgeAuthorized(req, edgeCredential)) throw Error('Invalid bridge request');
        const authorization = req.headers.authorization;
        if (authorization === `Bearer ${edgeCredential}` || typeof authorization !== 'string' || !/^Bearer [a-zA-Z0-9_-]{43}$/.test(authorization)) throw Error('Missing capability');
        let peer;
        session = await broker.connect(authorization.slice(7), value => new Promise((resolve, reject) => {
          if (peer?.readyState !== WebSocket.OPEN) return reject(Error('Sandbox reply transport unavailable'));
          peer.send(JSON.stringify(value), error => error ? reject(Error('Sandbox reply transport unavailable')) : resolve());
        }), () => peer?.close(1008));
        websocket.handleUpgrade(req, socket, head, connected => {
          peer = connected; peers.add(peer);
          peer.on('message', data => { let message; try { message = JSON.parse(data.toString()); } catch { return peer.close(1008); } void session.receive(message).catch(() => peer.close(1008)); });
          peer.once('close', () => { peers.delete(peer); session.close(); });
          peer.on('error', () => peer.close());
        });
      } catch { session?.close(); socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
    }
    return { allocator, broker, admittedProviders, bridgeUpgrade, close, restore, ready: () => ready && !stopped, briqMcpRequest: (req, res) => briqTransport.handle(req, res),
      claudeCredentialOwner: claude.credentials, briqCredentialOwner: cloud.credentialOwner };
  } catch (error) { await close(); throw error; }
}
