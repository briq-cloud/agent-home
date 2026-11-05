import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { AllocationStore, ThreadAllocator } from './allocations.mjs';
import { CapabilityBroker } from './broker.mjs';

async function fixture(t, { send } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 't3-bindings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AllocationStore(directory); await store.initialize();
  const calls = []; const responses = new Map(); const wire = [];
  const app = { events: new EventEmitter(), notify: message => wire.push(message), request: async (method, params) => {
    calls.push({ method, params });
    if (responses.has(method)) return responses.get(method)(params);
    if (method === 'turn/start') return { turn: { id: 'turn-a', status: 'inProgress' } };
    if (method === 'thread/start') return { thread: { id: 'native-a', environments: params.environments } };
    return {};
  } };
  const broker = new CapabilityBroker({ store, app });
  for (const name of ['a', 'b']) await store.save({ ownerId: 'owner', threadId: name, allocationId: `allocation-${name}`, bridgeToken: `cap-${name}`, execToken: `exec-${name}`,
    execEnvironmentId: `exec-${name}`, execUrl: `wss://exec-${name}.example`, state: 'ready', nativeThreadId: name === 'b' ? 'native-b' : null });
  const received = []; const bReceived = [];
  const session = await broker.connect('cap-a', message => { received.push(message); return send?.(message); }, () => {});
  const bSession = await broker.connect('cap-b', message => bReceived.push(message), () => {});
  await session.receive({ id: 0, method: 'initialize', params: {} });
  return { store, directory, broker, app, calls, responses, wire, session, bSession, received, bReceived };
}
test('forces the allocated execution environment and persists native thread identity before reuse', async t => {
  const f = await fixture(t);
  await f.session.receive({ id: 1, method: 'thread/start', params: { model: 'mock' } });
  assert.deepEqual(f.calls[0].params.environments, [{ environmentId: 'exec-a', cwd: '/work', runtimeWorkspaceRoots: ['/work'] }]);
  assert.equal((await f.store.load('a')).nativeThreadId, 'native-a');
  assert.equal((await new AllocationStore(f.directory).load('a')).nativeThreadId, 'native-a');
  await f.session.receive({ id: 2, method: 'thread/start', params: {} });
  assert.equal(f.calls.length, 1);
  assert.ok(f.received.at(-1).error);
});
const scoped = (id, key, method, params) => ({ id, method: 'briq/operation/execute', params: { version: 1, threadId: 'a', key, method, params } });
test('replays a durable scoped result after disconnect and broker restart without another native create', async t => {
  const f = await fixture(t);
  let resolveNative; let dispatched;
  const started = new Promise(resolve => { dispatched = resolve; });
  f.responses.set('thread/start', params => new Promise(resolve => { resolveNative = () => resolve({ thread: { id: 'native-a', environments: params.environments } }); dispatched(); }));
  const request = scoped(1, 'thread-intent-a', 'thread/start', { model: 'mock' });
  const pending = f.session.receive(request); await started; f.session.close(); resolveNative(); await pending;
  assert.equal((await f.store.loadOperation('a', 'thread-intent-a')).state, 'completed');
  const broker = new CapabilityBroker({ store: new AllocationStore(f.directory), app: f.app });
  const replies = []; const session = await broker.connect('cap-a', message => replies.push(message), () => {});
  await session.receive({ id: 0, method: 'initialize' });
  await session.receive({ ...request, id: 2 });
  assert.equal(replies.at(-1).result.result.thread.id, 'native-a');
  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1);
  await session.receive(scoped(3, 'thread-intent-a', 'thread/start', { model: 'changed' }));
  assert.ok(replies.at(-1).error);
  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1);
});
test('retains scoped unknown outcomes and rejects native replay', async t => {
  const f = await fixture(t); f.responses.set('thread/start', () => { throw Error('unknown native outcome'); });
  const request = scoped(1, 'thread-intent-a', 'thread/start', {});
  await f.session.receive(request); await f.session.receive({ ...request, id: 2 });
  assert.equal((await f.store.loadOperation('a', 'thread-intent-a')).state, 'uncertain');
  assert.equal(f.calls.length, 1); assert.ok(f.received.at(-1).error);
  const broker = new CapabilityBroker({ store: new AllocationStore(f.directory), app: f.app });
  const replies = []; const session = await broker.connect('cap-a', message => replies.push(message), () => {});
  await session.receive({ id: 0, method: 'initialize' }); await session.receive(request);
  assert.ok(replies.at(-1).error); assert.equal(f.calls.length, 1);
});
test('a local send callback followed by disconnect still replays the same scoped receipt', async t => {
  const f = await fixture(t);
  const request = scoped(1, 'thread-intent-a', 'thread/start', {});
  await f.session.receive(request);
  const original = f.received.at(-1).result; f.session.close();
  const replies = []; const session = await f.broker.connect('cap-a', message => replies.push(message), () => {});
  await session.receive({ id: 0, method: 'initialize' }); await session.receive({ ...request, id: 2 });
  assert.deepEqual(replies.at(-1).result, original);
  assert.equal((await f.store.loadOperation('a', 'thread-intent-a')).state, 'completed');
  assert.equal(f.calls.length, 1);
});
test('requires a correlated adoption receipt before another scoped mutation and keeps adopted replay results', async t => {
  const f = await fixture(t);
  f.responses.set('thread/read', () => ({ thread: { id: 'native-a', environments: [{ environmentId: 'exec-a', cwd: '/work' }] } }));
  const request = scoped(1, 'thread-intent-a', 'thread/start', {});
  await f.session.receive(request);
  const resultHash = f.received.at(-1).result.resultHash;
  const next = scoped(2, 'turn-intent-a', 'turn/start', { threadId: 'native-a', input: [{ type: 'text', text: 'hello' }] });
  await f.session.receive(next); assert.ok(f.received.at(-1).error);
  const adoption = { key: 'thread-intent-a', resultHash, eventSequence: 10, nativeId: 'native-a' };
  await f.session.receive({ id: 3, method: 'briq/operation/adopt', params: { ...adoption, nativeId: 'native-b' } });
  assert.ok(f.received.at(-1).error);
  assert.equal((await f.store.loadOperation('a', 'thread-intent-a')).state, 'completed');
  await f.session.receive({ id: 4, method: 'briq/operation/adopt', params: adoption });
  assert.deepEqual(f.received.at(-1).result, {});
  await f.session.receive(next); assert.ok(f.received.at(-1).result);
  await f.session.receive({ ...request, id: 5 });
  assert.equal(f.received.at(-1).result.result.thread.id, 'native-a');
  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal((await f.store.loadOperation('a', 'thread-intent-a')).state, 'adopted');
});
test('serializes duplicate scoped mutations even before a native response exists', async t => {
  const f = await fixture(t);
  const request = scoped(1, 'thread-intent-a', 'thread/start', {});
  await Promise.all([f.session.receive(request), f.session.receive({ ...request, id: 2 })]);
  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1);
  const replies = f.received.filter(message => message.id === 1 || message.id === 2);
  assert.equal(replies.length, 2); assert.deepEqual(replies[0].result, replies[1].result);
});
test('denies config, auth, host execution, override fields, nontext input, and cross-thread requests', async t => {
  const f = await fixture(t);
  for (const [method, params] of [
    ['config/read', {}], ['account/read', {}], ['command/exec', { command: ['env'] }],
    ['thread/start', { config: { 'mcp_servers.host.command': 'sh' } }],
    ['thread/start', { environments: [{ environmentId: 'local', cwd: '/' }] }],
    ['turn/start', { threadId: 'native-b', input: [{ type: 'text', text: 'hello' }] }],
    ['turn/start', { threadId: 'native-a', input: [{ type: 'localImage', path: '/home/auth.json' }] }],
  ]) { await f.session.receive({ id: 1, method, params }); assert.ok(f.received.at(-1).error); }
  assert.equal(f.calls.length, 0);
});
test('retains unknown native create outcome without replay', async t => {
  const f = await fixture(t); f.responses.set('thread/start', () => { throw Error('connection lost'); });
  await f.session.receive({ id: 1, method: 'thread/start', params: {} });
  await f.session.receive({ id: 2, method: 'thread/start', params: {} });
  assert.equal(f.calls.length, 1); assert.equal((await f.store.load('a')).nativeState, 'unknown');
});
test('checks returned resume binding and forces every turn selection', async t => {
  const f = await fixture(t); const binding = await f.store.load('a'); binding.nativeThreadId = 'native-a'; await f.store.save(binding);
  f.responses.set('thread/resume', () => ({ thread: { id: 'native-a', environments: [{ environmentId: 'local', cwd: '/work' }] } }));
  await f.session.receive({ id: 1, method: 'thread/resume', params: { threadId: 'native-a', excludeTurns: true } });
  assert.ok(f.received.at(-1).error);
  f.responses.set('thread/read', () => ({ thread: { id: 'native-a', environments: [{ environmentId: 'exec-a', cwd: '/work' }] } }));
  await f.session.receive({ id: 2, method: 'turn/start', params: { threadId: 'native-a', input: [{ type: 'text', text: 'hello' }] } });
  assert.equal(f.calls.find(x => x.method === 'turn/start').params.environments[0].environmentId, 'exec-a');
  assert.ok(f.received.at(-1).result);
});
test('demultiplexes notifications and approvals; one shim exit never closes the app-server or peer', async t => {
  const f = await fixture(t); const binding = await f.store.load('a'); binding.nativeThreadId = 'native-a'; await f.store.save(binding);
  await f.bSession.receive({ id: 0, method: 'initialize', params: {} });
  await f.broker.deliver({ method: 'item/agentMessage/delta', params: { threadId: 'native-a', delta: 'a' } });
  assert.equal(f.bReceived.length, 1);
  await f.broker.deliver({ method: 'turn/started', params: { threadId: 'native-a', turn: { id: 'turn-a' } } });
  await f.broker.deliver({ id: 100, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-a', environmentId: 'exec-b', turnId: 'turn-a', itemId: 'item-a', startedAtMs: 123 } });
  assert.ok(f.wire.at(-1).error);
  await f.broker.deliver({ id: 101, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-a', environmentId: 'exec-a', turnId: 'turn-a', itemId: 'item-a', startedAtMs: 123 } });
  const approvalId = f.received.at(-1).id;
  await f.bSession.receive({ id: approvalId, result: { decision: 'accept' } });
  assert.notEqual(f.wire.at(-1).id, 101);
  f.session.close(); assert.deepEqual(f.wire.at(-1), { id: 101, result: { decision: 'cancel' } });
  await f.broker.deliver({ method: 'turn/completed', params: { threadId: 'native-b', turn: { id: 't' } } });
  assert.equal(f.bReceived.at(-1).method, 'turn/completed');
  binding.state = 'revoked'; await f.store.save(binding);
  await assert.rejects(f.broker.connect('cap-a', () => {}, () => {}));
});
test('allocator serializes duplicate creates, reconciles unknown outcomes without replay, and checks owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 't3-allocate-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AllocationStore(directory); await store.initialize(); let creates = 0; let recovered = null;
  const cloud = { create: async () => { creates++; throw Error('unknown'); }, find: async () => recovered,
    endpoints: async () => ({ t3Url: 'https://t3.example', execUrl: 'wss://exec.example' }), descriptor: async () => ({ environmentId: 'environment-a' }), pair: async () => 'pairing-once' };
  const allocator = new ThreadAllocator({ store, cloud, image: `example/image@sha256:${'a'.repeat(64)}`, bridgeUrl: 'wss://central.example/_cloud/bridge', registerEnvironment: async () => {} });
  await assert.rejects(allocator.allocate('owner', 'thread'));
  await assert.rejects(allocator.allocate('owner', 'thread')); assert.equal(creates, 1);
  recovered = 'bq_one';
  const result = await allocator.allocate('owner', 'thread'); assert.equal(result.environmentId, 'environment-a'); assert.equal(creates, 1);
  await assert.rejects(allocator.allocate('other', 'thread'));
  const raw = JSON.parse(await readFile(join(directory, 'thread.json'))); assert.equal(raw.state, 'ready');
});

test('interrupt bypasses a pending turn start; late completion never resurrects active turn', async t => {
  const f = await fixture(t); const binding = await f.store.load('a'); binding.nativeThreadId = 'native-a'; await f.store.save(binding);
  let finish, started; const signal = new Promise(resolve => { started = resolve; });
  f.responses.set('turn/start', () => { started(); return new Promise(resolve => { finish = resolve; }); });
  f.responses.set('thread/read', () => ({ thread: { id: 'native-a', environments: [{ environmentId: 'exec-a', cwd: '/work' }] } }));
  const pending = f.session.receive({ id: 1, method: 'turn/start', params: { threadId: 'native-a', input: [{ type: 'text', text: 'hello' }] } });
  await signal;
  await f.broker.deliver({ method: 'turn/started', params: { threadId: 'native-a', turn: { id: 'turn-a' } } });
  await f.session.receive({ id: 2, method: 'turn/interrupt', params: { threadId: 'native-a', turnId: 'other' } });
  assert.ok(f.received.at(-1).error);
  await f.session.receive({ id: 3, method: 'turn/interrupt', params: { threadId: 'native-a', turnId: 'turn-a' } });
  assert.equal(f.calls.at(-1).method, 'turn/interrupt');
  await f.broker.deliver({ method: 'turn/completed', params: { threadId: 'native-a', turn: { id: 'turn-a' } } });
  finish({ turn: { id: 'turn-a', status: 'inProgress' } }); await pending;
  assert.equal(f.broker.activeTurns.has('native-a'), false);
});
test('approval response revalidates current turn and file approvals bind without fictional environmentId', async t => {
  const f = await fixture(t); const binding = await f.store.load('a'); binding.nativeThreadId = 'native-a'; await f.store.save(binding);
  await f.broker.deliver({ method: 'turn/started', params: { threadId: 'native-a', turn: { id: 'turn-a' } } });
  await f.broker.deliver({ id: 7, method: 'item/fileChange/requestApproval', params: { threadId: 'native-a', turnId: 'turn-a', itemId: 'file-a', startedAtMs: 123 } });
  const id = f.received.at(-1).id; assert.match(id, /^approval-/);
  await f.broker.deliver({ method: 'turn/completed', params: { threadId: 'native-a', turn: { id: 'turn-a' } } });
  await f.session.receive({ id, result: { decision: 'accept' } });
  assert.ok(f.received.at(-1).error); assert.equal(f.wire.some(value => value.id === 7 && value.result?.decision === 'accept'), false);
});

async function reconnect(f) {
 const received=[];const session=await f.broker.connect('cap-a',value=>received.push(value),()=>{});
 await session.receive({id:0,method:'initialize'});return {session,received};
}
async function prepareCompletedTurn(f) {
 const binding=await f.store.load('a');binding.nativeThreadId='native-a';await f.store.save(binding);
 f.responses.set('turn/start',()=>({turn:{id:'completed-turn',status:'completed'}}));
 f.responses.set('thread/read',()=>({thread:{id:'native-a',environments:[{environmentId:'exec-a',cwd:'/work'}]}}));
}
const turnRequest=id=>({id,method:'turn/start',params:{threadId:'native-a',input:[{type:'text',text:'once'}]}});
test('disconnect during native mutation retains quarantine after authoritative native response arrives',async t=>{
 const f=await fixture(t);await prepareCompletedTurn(f);let finish,started;
 const signal=new Promise(resolve=>{started=resolve;});
 f.responses.set('turn/start',()=>{started();return new Promise(resolve=>{finish=resolve;});});
 const pending=f.session.receive(turnRequest(1));await signal;f.session.close();
 finish({turn:{id:'completed-turn',status:'completed'}});await pending;
 const other=await reconnect(f);await other.session.receive(turnRequest(2));
 assert.ok(other.received.at(-1).error);assert.equal(f.calls.filter(value=>value.method==='turn/start').length,1);
 assert.equal((await f.store.mutationMarkers('a')).length,1);
});
test('native result before WS delivery cannot clear disconnect quarantine',async t=>{
 let attempted,complete;const reached=new Promise(resolve=>{attempted=resolve;});
 const f=await fixture(t,{send:value=>{if(value.id===1&&value.result){attempted();return new Promise(resolve=>{complete=resolve;});}}});
 await prepareCompletedTurn(f);const pending=f.session.receive(turnRequest(1));await reached;
 assert.equal((await f.store.load('a')).nativeTurnId,'completed-turn');
 f.session.close();complete();await pending;
 const other=await reconnect(f);await other.session.receive(turnRequest(2));
 assert.ok(other.received.at(-1).error);assert.equal(f.calls.filter(value=>value.method==='turn/start').length,1);
 assert.equal((await f.store.mutationMarkers('a')).length,1);
});
test('local WS callback permits live-session continuation but never proves durable client adoption',async t=>{
 const f=await fixture(t);await prepareCompletedTurn(f);
 await f.session.receive(turnRequest(1));await f.session.receive(turnRequest(2));
 assert.ok(f.received.at(-1).result);assert.equal((await f.store.mutationMarkers('a')).length,2);
 f.session.close();const other=await reconnect(f);await other.session.receive(turnRequest(3));
 assert.ok(other.received.at(-1).error);assert.equal(f.calls.filter(value=>value.method==='turn/start').length,2);
});
