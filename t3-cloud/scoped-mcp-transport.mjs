import { randomBytes } from 'node:crypto';
import { equalSecret, digest, canonicalJson } from './allocations.mjs';
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

// Tokens never enter allocation records or child-facing bridge messages.
export class ScopedMcpTransport {
  constructor({ store, scopedBriq, endpoint, loadSdk = loadMcpSdk }) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/_cloud/briq/mcp' || url.search || url.hash || url.username || url.password)
      throw Error('Fixed loopback MCP endpoint required');
    Object.assign(this, { store, scopedBriq, endpoint, loadSdk }); this.bindings = new Map();
  }
  bind(binding) {
    this.revoke(binding.allocationId);
    const entry = { token: randomBytes(32).toString('base64url'), epoch: randomBytes(16).toString('hex'),
      threadId: binding.threadId, allocationId: binding.allocationId, nativeId: binding.nativeThreadId, closed: false };
    this.bindings.set(binding.allocationId, entry);
    return { config: { 'mcp_servers.briq': { url: this.endpoint, http_headers: { Authorization: `Bearer ${entry.token}` } } },
      activate: nativeId => { if (entry.closed) throw Error('MCP binding revoked'); entry.nativeId = nativeId; },
      revoke: () => this.revokeEntry(entry) };
  }
  revokeEntry(entry) { entry.closed = true; if (this.bindings.get(entry.allocationId) === entry) this.bindings.delete(entry.allocationId); }
  revoke(allocationId) { const entry = this.bindings.get(allocationId); if (entry) this.revokeEntry(entry); }
  async current(entry, allowPending = false) {
    const binding = await this.store.load(entry.threadId);
    if (entry.closed || this.bindings.get(entry.allocationId) !== entry || binding?.state !== 'ready' ||
        binding.allocationId !== entry.allocationId || (!entry.nativeId ? !allowPending || Boolean(binding.nativeThreadId) : binding.nativeThreadId !== entry.nativeId)) throw Error('MCP binding unavailable');
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
    server.setRequestHandler(sdk.ListToolsRequestSchema, async () => { await this.current(entry, true); return { tools: scopedBriqTools }; });
    server.setRequestHandler(sdk.CallToolRequestSchema, async (request, extra) => {
      await this.current(entry);
      try {
        const result = await this.scopedBriq.call(entry, digest(canonicalJson([entry.epoch, providerRequestId(extra.requestId)])), request.params.name, request.params.arguments ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      catch { return { isError: true, content: [{ type: 'text', text: 'Briq operation unavailable; reconcile pending operations before retrying.' }] }; }
    });
    const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
  close() { for (const entry of this.bindings.values()) entry.closed = true; this.bindings.clear(); }
}
