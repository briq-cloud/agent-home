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
  const request = config => ({ url: '/_cloud/briq/mcp', method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: config.config['mcp_servers.briq'].http_headers.Authorization } });
  const response = () => Object.assign(new EventEmitter(), { status: 200, writeHead(status) { this.status = status; }, end() {} });
  return { transport, records, a, b, request, response, calls, responses, sdkLoads: () => sdkLoads };
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
  await f.transport.handle(f.request(f.a), f.response()); await f.transport.handle(f.request(f.a), f.response());
  assert.equal(f.calls[0][0].nativeId, 'native-a'); assert.equal(f.calls[0][0].threadId, 'a');
  assert.equal(f.calls[0][1], f.calls[1][1]); assert.equal(f.calls[0][2], 'briq_status');
  const rotated = f.transport.bind(f.records.get('a'));
  const old = f.response(); await f.transport.handle(f.request(f.a), old); assert.equal(old.status, 401);
  await f.transport.handle(f.request(rotated), f.response()); assert.notEqual(f.calls[2][1], f.calls[0][1]);
  f.transport.close(); const closed = f.response(); await f.transport.handle(f.request(f.b), closed); assert.equal(closed.status, 401);
});

test('native thread mismatch and missing provider request identity never call scoped handler', async () => {
  const f = fixture(); f.records.get('a').nativeThreadId = 'native-b';
  const res = f.response(); await f.transport.handle(f.request(f.a), res); assert.equal(res.status, 401);
  const req = f.request(f.b); req.requestId = {}; await f.transport.handle(req, f.response());
  assert.equal(f.calls.length, 0); assert.equal(f.responses.at(-1).isError, true);
});
