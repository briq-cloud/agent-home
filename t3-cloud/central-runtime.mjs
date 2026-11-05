import { ClaudeRuntime } from './claude-runtime.mjs';
import { edgeToken, edgeAuthorized, requireEdgeBinding } from './edge-auth.mjs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { AllocationStore, ThreadAllocator } from './allocations.mjs';
import { BriqCloud } from './briq-cloud.mjs';
import { startAppServer, CapabilityBroker } from './broker.mjs';
import { ScopedBriq } from './scoped-briq.mjs';
import { ScopedMcpTransport } from './scoped-mcp-transport.mjs';

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
  async function close() {
    if (stopped) return; stopped = true;
    for (const peer of peers) peer.terminate();
    websocket?.close(); briqTransport?.close();
    await claude?.close();
    await app?.close();
    await rm(lock, { recursive: true });
  }
  try {
    const handle = await open(join(lock, 'owner.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); } finally { await handle.close(); }
    const store = new AllocationStore(join(directory, 'allocations')); await store.initialize();
    for (const binding of await store.list()) if (binding.state !== 'revoked') requireEdgeBinding(binding, edgeCredential);
    app = await (dependencies.startAppServer ?? startAppServer)({ binary: env.T3_CLOUD_CODEX_BINARY ?? 'codex', home: join(directory, 'codex') });
    const cloud = dependencies.cloud ?? new BriqCloud({ directory: join(directory, 'stacks'), env });
    const scopedBriq = new ScopedBriq({ store, cloud });
    briqTransport = new ScopedMcpTransport({ store, scopedBriq, endpoint: `http://127.0.0.1:${env.PORT ?? 8080}/_cloud/briq/mcp` });
    const claudeLedger = new AllocationStore(join(directory, 'claude-ledger')); await claudeLedger.initialize();
    claude = new ClaudeRuntime({ store, ledger: claudeLedger, cloud, scopedBriq, directory: join(directory, 'claude'), nativeHome: env.HOME, nativeConfigDirectory: env.CLAUDE_CONFIG_DIR });
    const broker = new CapabilityBroker({ store, app, claude, briqTransport });
    let ready = false, restoring;
    function restore() {
      if (stopped) throw Error('Central runtime stopped');
      if (restoring) return restoring;
      restoring = (async () => {
        // The manager must bind the loopback MCP route before native restoration.
        for (const binding of await store.list()) {
          if (binding.state === 'revoked') {
            // Read-only evidence can settle an exact root stop. Unavailable auth or
            // unresolved cleanup stays per-allocation; managed owner sign-in remains usable.
            try { await store.serialized(binding.threadId, () => allocator.reconcileRevocation(binding)); } catch { /* Durable uncertainty remains visible through revocationIssues. */ }
            continue;
          }
          if (binding.state !== 'ready') continue;
          await broker.registerEnvironment(binding);
          if (binding.nativeThreadId) {
            const mcp = briqTransport.bind(binding);
            let result;
            try { result = await app.request('thread/resume', { threadId: binding.nativeThreadId, excludeTurns: false, config: mcp.config }); }
            catch (error) { mcp.revoke(); throw error; }
            if (result.thread?.id !== binding.nativeThreadId || !broker.matchesEnvironment(result.thread, binding)) throw Error('Persisted execution binding mismatch');
            const turn = result.thread.turns?.findLast(value => value.status === 'inProgress');
            if (turn) broker.activeTurns.set(binding.nativeThreadId, turn.id);
            // History alone does not correlate an uncertain client mutation. Keep quarantine.
          }
        }
        if (stopped) throw Error('Central runtime stopped');
        ready = true;
      })();
      return restoring;
    }
    const allocator = new ThreadAllocator({ store, cloud, image: env.T3_CLOUD_CHILD_IMAGE,
      edgeCredential, bridgeUrl: new URL('/_cloud/bridge', env.T3_CLOUD_PUBLIC_ORIGIN).href.replace(/^https:/, 'wss:'),
      registerEnvironment: binding => broker.registerEnvironment(binding),
      cleanup: async binding => { briqTransport.revoke(binding.allocationId); await scopedBriq.cleanup(binding); } });
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
    return { allocator, broker, bridgeUpgrade, close, restore, ready: () => ready && !stopped, briqMcpRequest: (req, res) => briqTransport.handle(req, res),
      claudeCredentialOwner: claude.credentials, briqCredentialOwner: cloud.credentialOwner };
  } catch (error) { await close(); throw error; }
}
