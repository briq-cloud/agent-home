import { randomBytes } from 'node:crypto';
import { equalSecret, digest, canonicalJson, providerInstanceId } from './allocations.mjs';
import { scopedBriqTools } from './scoped-briq.mjs';

export async function loadMcpSdk() {
  const [{ Server }, { StreamableHTTPServerTransport }, types] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  return { Server, StreamableHTTPServerTransport, ...types };
}
export function providerRequestId(value) {
  if (!['number', 'string'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) ||
      typeof value === 'string' && (!value || value.length > 200)) throw Error('MCP request identity required');
  return `${typeof value}:${value}`;
}

// Pinned Codex 0.166.0 mcp_tool_call.rs builds these fields from native state,
// independently of tool arguments. The bearer authenticates the native client;
// metadata alone is not proof against a bearer thief.
function nativeIdentity(params) {
  const meta = params?._meta, turn = meta?.['x-codex-turn-metadata'];
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
  if (!meta || !turn || typeof turn !== 'object' || Array.isArray(turn) ||
      ![meta.threadId, meta.sessionId, meta.callId, turn.turn_id, turn.thread_id, turn.session_id].every(valid) ||
      meta.threadId !== turn.thread_id || meta.sessionId !== turn.session_id) throw Error('Native MCP identity required');
  return { nativeId: meta.threadId, nativeSessionId: meta.sessionId, turnId: turn.turn_id, callId: meta.callId };
}

// Tokens never enter allocation records or child-facing bridge messages.
export class ScopedMcpTransport {
  constructor({ store, scopedBriq, endpoint, loadSdk = loadMcpSdk }) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/_cloud/briq/mcp' || url.search || url.hash || url.username || url.password)
      throw Error('Fixed loopback MCP endpoint required');
    Object.assign(this, { store, scopedBriq, endpoint, loadSdk }); this.bindings = new Map();
  }
  bind(binding, owner) {
    if (providerInstanceId(binding.providerInstanceId) !== 'codex' || binding.claudeNativeSessionId) throw Error('MCP provider mismatch');
    this.revoke(binding.allocationId);
    const entry = { token: randomBytes(32).toString('base64url'),
      threadId: binding.threadId, allocationId: binding.allocationId, nativeId: binding.nativeThreadId, providerInstanceId: 'codex', owner, closed: false, usable: false, observed: false, lease: null };
    this.bindings.set(binding.allocationId, entry);
    return { config: { 'mcp_servers.briq': { url: this.endpoint, http_headers: { Authorization: `Bearer ${entry.token}` } } },
      activate: (nativeId, nativeSessionId) => { if (entry.closed || typeof nativeId !== 'string' || !nativeId || typeof nativeSessionId !== 'string' || !nativeSessionId || nativeSessionId.length > 200) throw Error('MCP native session required'); entry.nativeId = nativeId; entry.nativeSessionId = nativeSessionId; },
      ready: () => { if (entry.closed || !entry.observed) throw Error('New MCP client not observed'); entry.usable = true; },
      observed: () => entry.observed,
      waitObserved: (timeoutMs = 10000) => entry.observed ? Promise.resolve() : new Promise((resolve, reject) => {
        const timer = setTimeout(() => { entry.witness = null; reject(Error('New MCP client not observed')); }, timeoutMs);
        entry.witness = () => { clearTimeout(timer); entry.witness = null; entry.closed ? reject(Error('MCP binding revoked')) : resolve(); };
        if (entry.closed) entry.witness();
      }),
      revoke: () => this.revokeEntry(entry) };
  }
  revokeEntry(entry) { entry.closed = true; entry.lease = null; entry.witness?.(); if (this.bindings.get(entry.allocationId) === entry) this.bindings.delete(entry.allocationId); }
  revoke(allocationId) { const entry = this.bindings.get(allocationId); if (entry) this.revokeEntry(entry); }
  revokeOwner(allocationId, owner) {
    const entry = this.bindings.get(allocationId);
    if (entry?.owner === owner) this.revokeEntry(entry);
  }
  toolNames() { return scopedBriqTools.map(tool => tool.name).sort(); }
  claimOwner(binding, owner) {
    const entry = this.bindings.get(binding.allocationId);
    if (entry && !entry.closed) {
      if (entry.owner && entry.owner !== owner && !entry.owner.closed || entry.lease) throw Error('Native execution owner busy');
      entry.owner = owner;
    }
  }
  reserveTurn(binding, owner, intent) {
    const entry = this.bindings.get(binding.allocationId);
    if (!entry || entry.closed || !entry.usable || entry.owner !== owner || entry.nativeId !== binding.nativeThreadId || entry.lease)
      throw Error('Scoped turn unavailable');
    entry.lease = { intent, owner, turnId: null, closed: false };
    return entry.lease;
  }
  startTurn(nativeId, turnId, lease) {
    const entry = [...this.bindings.values()].find(value => value.nativeId === nativeId && value.lease === lease);
    if (!entry || entry.closed || !entry.usable || !lease || lease.closed || lease.owner?.closed ||
        typeof turnId !== 'string' || !turnId || turnId.length > 200 || lease.turnId && lease.turnId !== turnId) return false;
    lease.turnId = turnId; return true;
  }
  closeTurn(nativeId, turnId) {
    for (const entry of this.bindings.values()) if (entry.nativeId === nativeId && entry.lease &&
        (turnId === undefined || !entry.lease.turnId || entry.lease.turnId === turnId)) {
      entry.lease.closed = true; entry.lease = null;
    }
  }
  capture(entry, params) {
    const native = nativeIdentity(params), lease = entry.lease;
    if (!entry.usable || !lease || lease.closed || lease.owner?.closed || lease.turnId !== native.turnId || entry.nativeId !== native.nativeId ||
        entry.nativeSessionId && entry.nativeSessionId !== native.nativeSessionId) throw Error('Native turn unavailable');
    if (!entry.nativeSessionId || entry.nativeSessionId !== native.nativeSessionId) throw Error('Native session mismatch');
    const identity = { providerInstanceId: 'codex', threadId: entry.threadId, allocationId: entry.allocationId, ...native,
      validate: () => {
        if (entry.closed || !entry.usable || this.bindings.get(entry.allocationId) !== entry || entry.lease !== lease ||
            lease.closed || lease.owner?.closed || lease.turnId !== native.turnId || entry.nativeSessionId !== native.nativeSessionId)
          throw Error('Native turn lease closed');
      } };
    identity.validate(); return Object.freeze(identity);
  }
  async current(entry, allowPending = false) {
    const binding = await this.store.load(entry.threadId);
    if (entry.closed || this.bindings.get(entry.allocationId) !== entry || binding?.state !== 'ready' ||
        binding.allocationId !== entry.allocationId || providerInstanceId(binding.providerInstanceId) !== entry.providerInstanceId || binding.claudeNativeSessionId || (!entry.nativeId ? !allowPending || Boolean(binding.nativeThreadId) : binding.nativeThreadId !== entry.nativeId)) throw Error('MCP binding unavailable');
    return binding;
  }
  async handle(req, res) {
    const deny = status => { res.writeHead(status, { 'cache-control': 'no-store' }); res.end(); };
    if (req.url !== '/_cloud/briq/mcp' || !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress) ||
        req.headers.origin !== undefined || req.method !== 'POST' || typeof req.headers.authorization !== 'string') return deny(401);
    const entry = [...this.bindings.values()].find(value => equalSecret(req.headers.authorization, `Bearer ${value.token}`));
    if (!entry) return deny(401);
    try { await this.current(entry, true); } catch { return deny(401); }
    const sdk = await this.loadSdk();
    const server = new sdk.Server({ name: 'briq', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(sdk.ListToolsRequestSchema, async () => { await this.current(entry, true); entry.observed = true; entry.witness?.(); return { tools: scopedBriqTools }; });
    server.setRequestHandler(sdk.CallToolRequestSchema, async (request, extra) => {
      try {
        // Capture before the first await; a queued old-turn call cannot acquire a
        // replacement turn's authority when it eventually reaches the store lock.
        const identity = this.capture(entry, request.params);
        providerRequestId(extra.requestId);
        await this.current(entry);
        const result = await this.scopedBriq.call(identity, digest(canonicalJson([identity.providerInstanceId, identity.allocationId, identity.nativeId, identity.turnId, identity.callId])), request.params.name, request.params.arguments ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      catch { return { isError: true, content: [{ type: 'text', text: 'Briq operation unavailable; reconcile pending operations before retrying.' }] }; }
    });
    const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
  close() { for (const entry of this.bindings.values()) this.revokeEntry(entry); }
}
