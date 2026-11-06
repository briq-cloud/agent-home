import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ScopedMcpTransport } from './scoped-mcp-transport.mjs';

function fixture() {
  const records = new Map(['a', 'b'].map(threadId => [threadId, { threadId, allocationId: `allocation-${threadId}`, nativeThreadId: `native-${threadId}`, state: 'ready' }]));
  const calls = [], responses = []; let sdkLoads = 0;
  const sdk = {
    ListToolsRequestSchema: 'list', CallToolRequestSchema: 'call',
    Server: class {
      handlers = new Map();
      setRequestHandler(schema, handler) { this.handlers.set(schema, handler); }
      async connect(transport) { transport.server = this; }
      async close() {}
    },
    StreamableHTTPServerTransport: class {
      async handleRequest(req, res) {
        responses.push(await this.server.handlers.get(req.schema ?? 'call')({ params: req.params ?? { name: 'briq_status', arguments: { id: 'owned-a' } } }, { requestId: req.requestId ?? 9 }));
        res.end();
      }
    },
  };
  const transport = new ScopedMcpTransport({ store: { load: async id => records.get(id) }, scopedBriq: { call: async (...args) => { calls.push(args); return { id: 'owned-a' }; } },
    endpoint: 'http://127.0.0.1:8080/_cloud/briq/mcp', loadSdk: async () => { sdkLoads++; return sdk; } });
  const a = transport.bind(records.get('a')), b = transport.bind(records.get('b'));
  const request = config => ({ params: { name: 'briq_status', arguments: { id: 'owned-a' }, _meta: { threadId: 'native-a', sessionId: 'session-a', callId: 'call-a', 'x-codex-turn-metadata': { thread_id: 'native-a', session_id: 'session-a', turn_id: 'turn-a' } } }, url: '/_cloud/briq/mcp', method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: config.config['mcp_servers.briq'].http_headers.Authorization } });
  const response = () => Object.assign(new EventEmitter(), { status: 200, writeHead(status) { this.status = status; }, end() {} });
  const owners = { a: { closed: false }, b: { closed: false } };
  const ready = async (config, id = 'a') => {
    transport.claimOwner(records.get(id), owners[id]);
    config.activate(`native-${id}`, `session-${id}`);
    const req = request(config); req.schema = 'list'; await transport.handle(req, response());
    await config.waitObserved(); config.ready();
    const lease = transport.reserveTurn(records.get(id), owners[id], `intent-${id}`);
    assert.equal(transport.startTurn(`native-${id}`, `turn-${id}`, lease), true);
  };
  return { transport, records, a, b, owners, ready, request, response, calls, responses, sdkLoads: () => sdkLoads };
}

test('loopback MCP rejects remote, browser, unknown and stale bindings before SDK or handlers', async () => {
  const f = fixture();
  for (const change of [req => { req.socket.remoteAddress = '203.0.113.1'; }, req => { req.headers.origin = 'https://owner.example'; },
    req => { req.headers.authorization = 'Bearer owner-token'; }, req => { req.method = 'GET'; }, req => { req.url += '?token=x'; }]) {
    const req = f.request(f.a); change(req); const res = f.response(); await f.transport.handle(req, res); assert.equal(res.status, 401);
  }
  f.records.get('a').state = 'revoked'; const res = f.response(); await f.transport.handle(f.request(f.a), res);
  assert.equal(res.status, 401); assert.equal(f.sdkLoads(), 0); assert.equal(f.calls.length, 0);
});

test('separate native bindings retain provider request identity and rotation invalidates old capability', async () => {
  const f = fixture();
  assert.notDeepEqual(f.a.config, f.b.config);
  await f.ready(f.a);
  await f.transport.handle(f.request(f.a), f.response()); await f.transport.handle(f.request(f.a), f.response());
  assert.equal(f.calls[0][0].nativeId, 'native-a'); assert.equal(f.calls[0][0].threadId, 'a');
  assert.equal(f.calls[0][1], f.calls[1][1]); assert.equal(f.calls[0][2], 'briq_status');
  const rotated = f.transport.bind(f.records.get('a'));
  const old = f.response(); await f.transport.handle(f.request(f.a), old); assert.equal(old.status, 401);
  await f.ready(rotated);
  await f.transport.handle(f.request(rotated), f.response()); assert.equal(f.calls[2][1], f.calls[0][1]); // Refresh cannot invent a second effect for the same native call.
  f.transport.close(); const closed = f.response(); await f.transport.handle(f.request(f.b), closed); assert.equal(closed.status, 401);
});

test('native thread mismatch and missing provider request identity never call scoped handler', async () => {
  const f = fixture(); f.records.get('a').nativeThreadId = 'native-b';
  const res = f.response(); await f.transport.handle(f.request(f.a), res); assert.equal(res.status, 401);
  const req = f.request(f.b); req.requestId = {}; await f.transport.handle(req, f.response());
  assert.equal(f.calls.length, 0); assert.equal(f.responses.at(-1).isError, true);
});


test('valid bearer requires exact native thread/session/turn/call metadata, never arguments or headers', async () => {
  const f = fixture(); await f.ready(f.a);
  for (const change of [req => { delete req.params._meta; }, req => { req.params.arguments._meta = req.params._meta; delete req.params._meta; },
    req => { req.params._meta.callId = ''; }, req => { req.params._meta.threadId = 'native-b'; },
    req => { req.params._meta.sessionId = 'other-session'; }, req => { req.params._meta['x-codex-turn-metadata'].turn_id = 'old-turn'; },
    req => { req.params._meta['x-codex-turn-metadata'] = JSON.stringify(req.params._meta['x-codex-turn-metadata']); }]) {
    const req = f.request(f.a); change(req); await f.transport.handle(req, f.response()); assert.equal(f.responses.at(-1).isError, true);
  }
  assert.equal(f.calls.length, 0);
  await f.transport.handle(f.request(f.a), f.response()); assert.equal(f.calls.length, 1);
  const captured = f.calls[0][0]; assert.equal(captured.providerInstanceId, 'codex'); assert(Object.isFrozen(captured));
  f.transport.closeTurn('native-a', 'turn-a'); assert.throws(() => captured.validate());
  await f.transport.handle(f.request(f.a), f.response()); assert.equal(f.calls.length, 1);
});

test('readiness requires new capability observation and delayed old-owner disconnect preserves replacement', async () => {
  const f = fixture(); assert.throws(() => f.a.ready(), /not observed/);
  await f.ready(f.a); const oldOwner = f.owners.a;
  const replacementOwner = { closed: false }; oldOwner.closed = true;
  const rotated = f.transport.bind(f.records.get('a'), replacementOwner);
  rotated.activate('native-a', 'session-a');
  const req = f.request(rotated); req.schema = 'list'; await f.transport.handle(req, f.response()); rotated.ready();
  f.transport.revokeOwner('allocation-a', oldOwner);
  const res = f.response(); await f.transport.handle(req, res); assert.equal(res.status, 200);
  const old = f.response(); await f.transport.handle(f.request(f.a), old); assert.equal(old.status, 401);
  f.transport.revokeOwner('allocation-a', replacementOwner);
  const closed = f.response(); await f.transport.handle(req, closed); assert.equal(closed.status, 401);
});
