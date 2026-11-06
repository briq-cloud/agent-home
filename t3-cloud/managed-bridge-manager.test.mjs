import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { digest, canonicalJson } from './allocations.mjs';
import { createCloudManager } from './manager.mjs';

const ownerKey = 'test-owner-key-12345678901234567890123456789';
const capability = 'test-allocator-capability-1234567890123456789';
const threadId = 'thread:project:project%3Aphone%2Fone:12345678-1234-4234-8234-123456789abc';
async function fixture(t, options = {}) {
  const calls = []; let closeLease; let unregistered = 0;
  let acknowledgeUnregister; const didUnregister = new Promise(resolve => { acknowledgeUnregister = resolve; });
  const allocator = {
    allocateSource: async (...args) => { calls.push(['source', ...args]); return { purpose: 'project-source', sourceId: args[1].sourceId, sourceDigest: args[1].sourceDigest, allocationId: 'allocation', environmentId: 'environment', projectId: 'native-project', workspaceRoot: `/work/projects/${args[1].sourceId}` }; },
    managedPreparationSession: async (...args) => { calls.push(['preparation', ...args]); return { token: 'private-source-only' }; },
    revokePreparationSession: async (...args) => { calls.push(['revoke-preparation', ...args]); },
    allocate: async (...args) => { calls.push(['allocate', ...args]); return { threadId: args[1], allocationId: 'allocation', providerInstanceId: args[2] }; },
    managedBridgeSession: async (...args) => { calls.push(['session', ...args]); return { threadId: args[1], token: 'child-test-only' }; },
    openBridgeLease: async (...args) => { calls.push(['lease', ...args.slice(0,4)]); closeLease = args[4]; return () => { unregistered++; acknowledgeUnregister(); }; },
  };
  const server = createCloudManager({ role: 'central', ownerId: 'owner', ownerKey, publicOrigin: 'https://central.example', allocator,
    allocatorToken: capability, connections: {}, broker: { ownerRequest() {} }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const send = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST',
      headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  return { server, calls, send, closeLease: () => closeLease(), unregistered: () => unregistered, didUnregister };
}

test('private managed routes require exact local capability and reject browser and caller-controlled authority', async t => {
  const f = await fixture(t);
  for (const path of ['managed', 'bridge-session', 'bridge-lease']) {
    for (const headers of [{ authorization: `Bearer ${ownerKey}` }, { cookie: 'owner=session' }, { origin: 'https://central.example' }, { authorization: 'Bearer wrong' }])
      assert.equal((await f.send(`/_cloud/threads/${path}`, { threadId, allocationId: 'allocation' }, headers)).status, 401);
    assert.equal((await f.send(`/_cloud/threads/${path}?extra=1`, { threadId, allocationId: 'allocation' })).status, 401);
  }
  assert.equal(f.calls.length, 0);
  for (const extra of [{ ownerGeneration: 'caller' }, { ownerId: 'foreign' }, { scopes: ['access:write'] }, { httpBaseUrl: 'https://foreign.example' }])
    assert.equal((await f.send('/_cloud/threads/bridge-session', { threadId, allocationId: 'allocation', ...extra })).status, 400);
  for (const providerInstanceId of [undefined, null, 'custom'])
    assert.equal((await f.send('/_cloud/threads/managed', { threadId, providerInstanceId })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('server binds managed allocation and private session to same literal native thread and derived owner generation', async t => {
  const f = await fixture(t);
  const allocated = await f.send('/_cloud/threads/managed', { threadId, providerInstanceId: 'claudeAgent' });
  assert.equal(allocated.status, 200); assert.equal(allocated.body.threadId, threadId);
  const linked = await f.send('/_cloud/threads/bridge-session', { threadId, allocationId: 'allocation' });
  assert.equal(linked.status, 200); assert.equal(linked.headers['cache-control'], 'no-store');
  const generation = f.calls[0][4].ownerGeneration;
  assert.match(generation, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls, [ ['allocate', 'owner', threadId, 'claudeAgent', { ownerGeneration: generation }],
    ['session', 'owner', threadId, 'allocation', generation] ]);
});

test('lease is an actual response-close callback and unregisters after revocation', async t => {
  const f = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: f.server.address().port, path: '/_cloud/threads/bridge-lease', method: 'POST',
      headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' } }, resolve);
    req.on('error', reject); req.end(JSON.stringify({ threadId, allocationId: 'allocation' }));
  });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  const closed = new Promise(resolve => response.once('close', resolve));
  response.on('error', () => {}); response.resume(); f.closeLease(); await closed;
  await f.didUnregister;
  assert.equal(f.unregistered(), 1);
});


test('source and preparation routes keep browser credentials out and bind native project/root identity', async t => {
  const f = await fixture(t);
  const source = { version: 1, sourceId: 'source-one-1234567890', hostProjectId: 'host-project', logicalRoot: '/projects/source-one-1234567890', clone: { remoteUrl: 'https://github.com/up-lab/example.git', protocol: 'https' } };
  source.sourceDigest = digest(canonicalJson(source));
  const identity = { sourceId: source.sourceId, sourceDigest: source.sourceDigest, allocationId: 'allocation', projectId: 'native-project', workspaceRoot: `/work/projects/${source.sourceId}` };
  for (const route of ['/_cloud/projects/source','/_cloud/projects/preparation-session','/_cloud/projects/preparation-lease','/_cloud/projects/preparation-revoke']) {
    assert.equal((await f.send(route, {}, { origin: 'https://central.example' })).status,401);
    assert.equal((await f.send(route, {}, { cookie: 'owner=fake' })).status,401);
    assert.equal((await f.send(`${route}?extra=1`, {})).status,401);
  }
  assert.equal((await f.send('/_cloud/projects/source',{projectSource:source,providerInstanceId:'codex'})).status,400);
  const result=await f.send('/_cloud/projects/source',{projectSource:source}); assert.equal(result.status,200); assert.equal(result.body.purpose,'project-source');
  assert.equal((await f.send('/_cloud/projects/preparation-session',{...identity,scopes:['access:write']})).status,400);
  assert.equal((await f.send('/_cloud/projects/preparation-session',identity)).status,200);
  const generation=f.calls[0][3]; assert.match(generation,/^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls[1],['preparation','owner',source.sourceId,'allocation',generation,'project-source',{sourceDigest:source.sourceDigest,projectId:'native-project',workspaceRoot:identity.workspaceRoot}]);
  assert.equal((await f.send('/_cloud/projects/preparation-revoke',identity)).status,200);
});


test('provider status uses only sanitized centralized account metadata and fails unknown', async t => {
  const calls = [];
  let account = { account: { type: 'chatgpt', email: 'never-return@example.test', token: 'never-return' } };
  const f = await fixture(t, { broker: { ownerRequest: async (...args) => {
    calls.push(args); if (account instanceof Error) throw account; return account;
  } } });
  const status = () => f.send('/_cloud/providers/status', { providerInstanceId: 'codex' });
  assert.deepEqual((await status()).body, { providerInstanceId: 'codex', available: true, ready: true, authStatus: 'authenticated' });
  assert.deepEqual(calls, [['account/read', { refreshToken: false }]]);
  account = { account: null, requiresOpenaiAuth: true };
  assert.deepEqual((await status()).body, { providerInstanceId: 'codex', available: true, ready: false, authStatus: 'unauthenticated' });
  for (const unknown of [{ account: null }, new Error('private failure')]) {
    account = unknown;
    assert.deepEqual((await status()).body, { providerInstanceId: 'codex', available: true, ready: false, authStatus: 'unknown' });
  }
});

test('provider status preserves private guard, admission and disabled Claude gate without vendor probes', async t => {
  let probes = 0;
  const unexpected = () => { probes++; throw Error('Must not probe unavailable provider'); };
  const f = await fixture(t, { admittedProviders: ['codex', 'claudeAgent'], broker: { ownerRequest: unexpected }, connections: { status: unexpected } });
  const path = '/_cloud/providers/status';
  const input = { providerInstanceId: 'claudeAgent' };
  for (const headers of [{ authorization: `Bearer ${ownerKey}` }, { cookie: 'owner=session' }, { origin: 'https://central.example' }, { authorization: 'Bearer wrong' }])
    assert.equal((await f.send(path, input, headers)).status, 401);
  assert.equal((await f.send(`${path}?extra=1`, input)).status, 401);
  for (const invalid of [{}, { providerInstanceId: 'custom' }, { ...input, ownerId: 'foreign' }])
    assert.equal((await f.send(path, invalid)).status, 400);
  assert.deepEqual((await f.send(path, input)).body, { providerInstanceId: 'claudeAgent', available: false, ready: false, authStatus: 'unknown' });
  const unavailable = await fixture(t, { admittedProviders: [], broker: { ownerRequest: unexpected } });
  assert.deepEqual((await unavailable.send(path, { providerInstanceId: 'codex' })).body, { providerInstanceId: 'codex', available: false, ready: false, authStatus: 'unknown' });
  const restoring = await fixture(t, { ready: () => false, broker: { ownerRequest: unexpected } });
  assert.equal((await restoring.send(path, { providerInstanceId: 'codex' })).status, 503);
  assert.equal(probes, 0);
});
