import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { AllocationStore, ThreadAllocator } from './allocations.mjs';
import { CapabilityBroker, resumeScopedCodex } from './broker.mjs';

async function fixture(t, { send, briqTransport } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 't3-bindings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AllocationStore(directory); await store.initialize();
  const calls = []; const responses = new Map(); const wire = [];
  const app = { events: new EventEmitter(), notify: message => wire.push(message), request: async (method, params) => {
    if (['account/read', 'model/list'].includes(method) && responses.has(method)) return responses.get(method)(params);
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ model: 'mock', isDefault: true }] };
    calls.push({ method, params });
    if (responses.has(method)) return responses.get(method)(params);
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    if (method === 'turn/start') return { turn: { id: 'turn-a', status: 'inProgress' } };
    if (method === 'thread/start') return { model: 'mock', thread: { model: 'mock', id: 'native-a', environments: params.environments } };
    return {};
  } };
  const broker = new CapabilityBroker({ store, app, briqTransport });
  for (const name of ['a', 'b']) await store.save({ ownerId: 'owner', threadId: name, allocationId: `allocation-${name}`, bridgeToken: `cap-${name}`, execToken: `exec-${name}`,
    execEnvironmentId: `exec-${name}`, execUrl: `wss://exec-${name}.example`, state: 'ready', nativeModel: 'mock', nativeThreadId: name === 'b' ? 'native-b' : null });
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
  f.responses.set('thread/start', params => new Promise(resolve => { resolveNative = () => resolve({ model: 'mock', thread: { model: 'mock', id: 'native-a', environments: params.environments } }); dispatched(); }));
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
  f.responses.set('thread/read', () => ({ model: 'mock', thread: { model: 'mock', id: 'native-a', environments: [{ environmentId: 'exec-a', cwd: '/work' }] } }));
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
test('serializes admission for distinct steer intents while keeping cancellation independent', async t => {
  const f = await fixture(t); const binding = await f.store.load('a'); binding.nativeThreadId = 'native-a'; await f.store.save(binding);
  f.broker.activeTurns.set('native-a', 'turn-a');
  let releaseAdmission, enteredAdmission, queuedSecond;
  const gate = new Promise(resolve => { releaseAdmission = resolve; });
  const admitted = new Promise(resolve => { enteredAdmission = resolve; });
  const queued = new Promise(resolve => { queuedSecond = resolve; });
  const assertAllowed = f.broker.assertMutationAllowed.bind(f.broker); let checks = 0;
  f.broker.assertMutationAllowed = async session => {
    await assertAllowed(session);
    if (++checks === 1) { enteredAdmission(); await gate; }
  };
  const serialize = f.store.serialized.bind(f.store); let threadAdmissions = 0;
  f.store.serialized = (key, operation) => {
    if (key === 'a' && ++threadAdmissions === 2) queuedSecond();
    return serialize(key, operation);
  };
  const params = { threadId: 'native-a', expectedTurnId: 'turn-a', input: [{ type: 'text', text: 'steer' }] };
  const first = f.session.receive(scoped(1, 'steer-first', 'turn/steer', params)); await admitted;
  const second = f.session.receive(scoped(2, 'steer-second', 'turn/steer', params));
  // The unfixed path completes the second steer; the guarded path queues its admission.
  await Promise.race([queued, second]);
  await f.session.receive(scoped(3, 'interrupt-a', 'turn/interrupt', { threadId: 'native-a', turnId: 'turn-a' }));
  assert.equal(f.calls.filter(call => call.method === 'turn/interrupt').length, 1);
  releaseAdmission(); await Promise.all([first, second]);
  assert.equal(f.calls.filter(call => call.method === 'turn/steer').length, 1);
  assert.ok(f.received.find(message => message.id === 2).error);
});
test('interrupt reaches native Codex while a scoped steer response is pending', async t => {
  const f = await fixture(t); const binding = await f.store.load('a'); binding.nativeThreadId = 'native-a'; await f.store.save(binding);
  f.broker.activeTurns.set('native-a', 'turn-a');
  let nativeEntered, resolveNative;
  const entered = new Promise(resolve => { nativeEntered = resolve; });
  f.responses.set('turn/steer', () => new Promise(resolve => { resolveNative = resolve; nativeEntered(); }));
  const pending = f.session.receive(scoped(1, 'steer-first', 'turn/steer', { threadId: 'native-a', expectedTurnId: 'turn-a', input: [{ type: 'text', text: 'steer' }] }));
  await entered;
  await f.session.receive(scoped(2, 'interrupt-a', 'turn/interrupt', { threadId: 'native-a', turnId: 'turn-a' }));
  assert.equal(f.calls.filter(call => call.method === 'turn/interrupt').length, 1);
  resolveNative({}); await pending;
  assert.ok(f.received.find(message => message.id === 1).result);
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
  f.responses.set('thread/resume', () => ({ model: 'mock', thread: { model: 'mock', id: 'native-a', environments: [{ environmentId: 'local', cwd: '/work' }] } }));
  await f.session.receive({ id: 1, method: 'thread/resume', params: { threadId: 'native-a', excludeTurns: true } });
  assert.ok(f.received.at(-1).error);
  assert.equal((await f.store.load('a')).nativeState, 'unknown');
  const verified = await fixture(t); const current = await verified.store.load('a'); current.nativeThreadId = 'native-a'; await verified.store.save(current);
  verified.responses.set('thread/read', () => ({ thread: { model: 'mock', id: 'native-a', environments: [{ environmentId: 'exec-a', cwd: '/work' }] } }));
  await verified.session.receive({ id: 2, method: 'turn/start', params: { threadId: 'native-a', input: [{ type: 'text', text: 'hello' }] } });
  assert.equal(verified.calls.find(x => x.method === 'turn/start').params.environments[0].environmentId, 'exec-a');
  assert.ok(verified.received.at(-1).result);
});
test('demultiplexes notifications and approvals; one shim exit never closes the app-server or peer', async t => {
  const f = await fixture(t); const binding = await f.store.load('a'); binding.nativeThreadId = 'native-a'; await f.store.save(binding);
  await f.bSession.receive({ id: 0, method: 'initialize', params: {} });
  await f.broker.deliver({ method: 'item/agentMessage/delta', params: { threadId: 'native-a', delta: 'a' } });
  assert.equal(f.bReceived.length, 1);
  f.responses.set('thread/read', () => ({ thread: { id: 'native-a', model: 'mock', environments: [{environmentId:'exec-a',cwd:'/work'}] } }));
  await f.session.receive({ id: 50, method: 'turn/start', params: { threadId:'native-a',input:[{type:'text',text:'approval fixture'}] } });
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
  const allocator = new ThreadAllocator({ store, cloud, image: `example/image@sha256:${'a'.repeat(64)}`, bridgeUrl: 'wss://central.example/_cloud/bridge', edgeCredential: 'e'.repeat(32), registerEnvironment: async () => {} });
  await assert.rejects(allocator.allocate('owner', 'thread'));
  await assert.rejects(allocator.allocate('owner', 'thread')); assert.equal(creates, 1);
  recovered = { id: 'bq_one' };
  await assert.rejects(allocator.allocate('owner', 'thread')); assert.equal(creates, 1);
  recovered = { id: 'bq_one', stackId: 'stack-one' };
  const result = await allocator.allocate('owner', 'thread'); assert.equal(result.environmentId, 'environment-a'); assert.equal(creates, 1);
  await assert.rejects(allocator.allocate('other', 'thread'));
  const raw = JSON.parse(await readFile(join(directory, 'thread.json'))); assert.equal(raw.state, 'ready'); assert.equal(raw.rootStackId, 'stack-one');
});

test('interrupt bypasses a pending turn start; late completion never resurrects active turn', async t => {
  const f = await fixture(t); const binding = await f.store.load('a'); binding.nativeThreadId = 'native-a'; await f.store.save(binding);
  let finish, started; const signal = new Promise(resolve => { started = resolve; });
  f.responses.set('turn/start', () => { started(); return new Promise(resolve => { finish = resolve; }); });
  f.responses.set('thread/read', () => ({ model: 'mock', thread: { model: 'mock', id: 'native-a', environments: [{ environmentId: 'exec-a', cwd: '/work' }] } }));
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
  f.responses.set('thread/read', () => ({ thread: { id: 'native-a', model: 'mock', environments: [{environmentId:'exec-a',cwd:'/work'}] } }));
  await f.session.receive({ id: 50, method: 'turn/start', params: { threadId:'native-a',input:[{type:'text',text:'approval fixture'}] } });
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
 f.responses.set('thread/read',()=>({thread:{model:'mock',id:'native-a',environments:[{environmentId:'exec-a',cwd:'/work'}]}}));
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

test('scoped pending outcomes have a fixed classification distinct from definitive binding rejection', async t => {
  const f = await fixture(t);
  f.responses.set('thread/start', () => { throw Error('native outcome is unknown'); });
  const request = scoped(1, 'pending-classification', 'thread/start', {});
  await f.session.receive(request);
  assert.equal(f.received.at(-1).error.code, -32010);
  assert.deepEqual(f.received.at(-1).error.data, { sandboxOperationState: 'pending' });
  await f.session.receive({ ...request, id: 2 });
  assert.equal(f.received.at(-1).error.code, -32010);
  assert.equal(f.calls.length, 1);
  await f.session.receive({ ...request, id: 3, params: { ...request.params, params: { model: 'changed' } } });
  assert.equal(f.received.at(-1).error.code, -32600);
  assert.equal(f.received.at(-1).error.data, undefined);
  assert.equal(f.calls.length, 1);
});


test('lost adoption reply reuses the committed receipt after reconnect without another native mutation', async t => {
  let loseReply = false;
  let ownedSession;
  const f = await fixture(t, { send: message => {
    if (loseReply && message.id === 2 && message.result) { ownedSession.close(); return false; }
  } });
  ownedSession = f.session;
  const request = scoped(1, 'lost-adopt-reply', 'thread/start', {});
  await f.session.receive(request);
  const receipt = { key: request.params.key, nativeId: 'native-a', resultHash: f.received.at(-1).result.resultHash, eventSequence: 27 };
  loseReply = true;
  await f.session.receive({ id: 2, method: 'briq/operation/adopt', params: receipt });
  assert.deepEqual((await f.store.loadOperation('a', receipt.key)).adoption, receipt);
  const broker = new CapabilityBroker({ store: new AllocationStore(f.directory), app: f.app });
  const replies = [];
  const session = await broker.connect('cap-a', message => replies.push(message), () => {});
  await session.receive({ id: 0, method: 'initialize' });
  await session.receive({ id: 3, method: 'briq/operation/adopt', params: receipt });
  assert.deepEqual(replies.at(-1).result, {});
  await session.receive({ id: 4, method: 'briq/operation/adopt', params: { ...receipt, eventSequence: 28 } });
  assert.equal(replies.at(-1).error.code, -32600);
  assert.deepEqual((await f.store.loadOperation('a', receipt.key)).adoption, receipt);
  assert.equal(f.calls.length, 1);
});


for (const phase of ['execute-replay', 'adopt']) test(`post-commit ${phase} send rejection remains uncertain and replays the same receipt`, async t => {
  let rejectId;
  const f = await fixture(t, { send: message => {
    if (message.id === rejectId && Object.hasOwn(message, 'result')) { rejectId = undefined; return Promise.reject(Error('one-shot receipt delivery rejection')); }
  } });
  const request = scoped(1, 'send-rejection', 'thread/start', {});
  await f.session.receive(request);
  const result = f.received.at(-1).result;
  const receipt = { key: request.params.key, nativeId: 'native-a', resultHash: result.resultHash, eventSequence: 31 };
  rejectId = 2;
  const retry = phase === 'execute-replay' ? { ...request, id: 2 } : { id: 2, method: 'briq/operation/adopt', params: receipt };
  await f.session.receive(retry);
  assert.equal(f.received.at(-1).error.code, -32010);
  assert.equal((await f.store.loadOperation('a', receipt.key)).state, phase === 'adopt' ? 'adopted' : 'completed');
  await f.session.receive({ ...retry, id: 3 });
  assert.deepEqual(f.received.at(-1).result, phase === 'adopt' ? {} : result);
  if (phase === 'adopt') assert.deepEqual((await f.store.loadOperation('a', receipt.key)).adoption, receipt);
  assert.equal(f.calls.length, 1);
});

const receiptRequest = (request, id) => ({ ...request, id, method: 'briq/operation/receipt' });
test('receipt-only lookup denies absent and lost ledgers without creating a row or dispatching', async t => {
  const f = await fixture(t);
  const request = scoped(1, 'receipt-missing', 'thread/start', {});
  await f.session.receive(receiptRequest(request, 2));
  assert.equal(f.received.at(-1).error.code, -32600);
  assert.equal(await f.store.loadOperation('a', request.params.key), null);
  assert.equal(f.calls.length, 0);
  await f.session.receive(request);
  assert.equal(f.calls.length, 1);
  await rm(join(f.directory, 'operations', 'a', `${request.params.key}.json`));
  f.session.close();
  const broker = new CapabilityBroker({ store: new AllocationStore(f.directory), app: f.app });
  const replies = []; const session = await broker.connect('cap-a', message => replies.push(message), () => {});
  await session.receive({ id: 0, method: 'initialize' });
  await session.receive(receiptRequest(request, 3));
  assert.deepEqual(replies.at(-1).error, { code: -32600, message: 'Operation denied by sandbox binding' });
  assert.equal(await f.store.loadOperation('a', request.params.key), null);
  assert.equal(f.calls.length, 1);
});

for (const adopted of [false, true]) test(`receipt-only lookup recovers the exact ${adopted ? 'adopted' : 'completed'} receipt after restart`, async t => {
  const f = await fixture(t);
  const request = scoped(1, 'receipt-restart', 'thread/start', { model: 'mock' });
  await f.session.receive(request);
  const result = f.received.at(-1).result;
  if (adopted) await f.session.receive({ id: 2, method: 'briq/operation/adopt', params: {
    key: request.params.key, nativeId: 'native-a', resultHash: result.resultHash, eventSequence: 43,
  } });
  const before = await f.store.loadOperation('a', request.params.key);
  f.session.close();
  const broker = new CapabilityBroker({ store: new AllocationStore(f.directory), app: f.app });
  const replies = []; const session = await broker.connect('cap-a', message => replies.push(message), () => {});
  await session.receive({ id: 0, method: 'initialize' });
  await Promise.all([session.receive(receiptRequest(request, 3)), session.receive(receiptRequest(request, 4))]);
  assert.deepEqual(replies.filter(message => message.id === 3 || message.id === 4).map(message => message.result), [result, result]);
  assert.deepEqual(await f.store.loadOperation('a', request.params.key), before);
  assert.equal(f.calls.length, 1);
});

for (const state of ['started', 'uncertain']) test(`receipt-only lookup preserves ${state} classification after restart without replay`, async t => {
  const f = await fixture(t);
  const request = scoped(1, 'receipt-pending', 'thread/start', {});
  f.responses.set('thread/start', () => { throw Error('private native diagnostic'); });
  await f.session.receive(request);
  const record = { ...await f.store.loadOperation('a', request.params.key), state };
  await f.store.saveOperation('a', record);
  f.session.close();
  const broker = new CapabilityBroker({ store: new AllocationStore(f.directory), app: f.app });
  const replies = []; const session = await broker.connect('cap-a', message => replies.push(message), () => {});
  await session.receive({ id: 0, method: 'initialize' });
  await session.receive(receiptRequest(request, 2));
  assert.deepEqual(replies.at(-1).error, { code: -32010, message: 'Sandbox operation outcome requires reconciliation', data: { sandboxOperationState: 'pending' } });
  assert.deepEqual(await f.store.loadOperation('a', request.params.key), record);
  assert.equal(f.calls.length, 1);
});

test('receipt-only lookup rejects changed envelopes and stored identities without revealing the receipt', async t => {
  const f = await fixture(t);
  const request = scoped(1, 'receipt-conflict', 'thread/start', { model: 'mock' });
  await f.session.receive(request);
  const record = await f.store.loadOperation('a', request.params.key);
  const changed = [
    { ...request.params, params: { model: 'changed' } },
    { ...request.params, method: 'turn/start' },
    { ...request.params, threadId: 'b' },
    { ...request.params, key: 'another-key' },
    { ...request.params, version: 2 },
    { ...request.params, unexpected: true },
  ];
  for (const params of changed) {
    await f.session.receive({ id: 2, method: 'briq/operation/receipt', params });
    assert.deepEqual(f.received.at(-1).error, { code: -32600, message: 'Operation denied by sandbox binding' });
  }
  for (const mismatch of [{ allocationId: 'allocation-b' }, { threadId: 'b' }, { key: 'another-key' }]) {
    const path = join(f.directory, 'operations', 'a', `${record.key}.json`);
    await f.store.atomicWrite(path, { ...record, ...mismatch }, join(f.directory, 'operations', 'a'));
    await f.session.receive(receiptRequest(request, 3));
    assert.equal(f.received.at(-1).error.code, -32600);
    await f.store.atomicWrite(path, record, join(f.directory, 'operations', 'a'));
  }
  assert.deepEqual(await f.store.loadOperation('a', record.key), record);
  assert.equal(f.calls.length, 1);
});

test('receipt-only lookup enforces initialization, request identity and current allocation boundary', async t => {
  const f = await fixture(t);
  const request = scoped(1, 'receipt-boundary', 'thread/start', {});
  await f.session.receive(request);
  f.session.close();
  const replies = []; const session = await f.broker.connect('cap-a', message => replies.push(message), () => {});
  await session.receive(receiptRequest(request, 2));
  assert.equal(replies.at(-1).error.code, -32600);
  await session.receive({ id: 0, method: 'initialize' });
  await session.receive(receiptRequest(request, null));
  assert.equal(replies.at(-1).error.code, -32600);
  await f.bSession.receive({ id: 0, method: 'initialize' });
  await f.bSession.receive(receiptRequest(request, 3));
  assert.equal(f.bReceived.at(-1).error.code, -32600);
  const binding = await f.store.load('a');
  await f.store.save({ ...binding, allocationId: 'replacement' });
  await session.receive(receiptRequest(request, 4));
  assert.equal(replies.at(-1).error.code, -32600);
  await f.store.save({ ...binding, state: 'revoked' });
  await session.receive(receiptRequest(request, 5));
  assert.equal(replies.at(-1).error.code, -32600);
  assert.equal(f.calls.length, 1);
});

test('receipt-only lookups serialize with a live execute and never cause a second mutation', async t => {
  const f = await fixture(t);
  let releaseNative, signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  f.responses.set('thread/start', params => new Promise(resolve => {
    releaseNative = () => resolve({ model: 'mock', thread: { model: 'mock', id: 'native-a', environments: params.environments } }); signalStarted();
  }));
  const request = scoped(1, 'receipt-concurrent', 'thread/start', {});
  const execution = f.session.receive(request); await started;
  assert.equal((await f.store.loadOperation('a', request.params.key)).state, 'started');
  const lookups = [f.session.receive(receiptRequest(request, 2)), f.session.receive(receiptRequest(request, 3))];
  releaseNative(); await Promise.all([execution, ...lookups]);
  const replies = f.received.filter(message => [1, 2, 3].includes(message.id));
  assert.equal(replies.length, 3);
  assert.ok(replies[0].result);
  assert.deepEqual(replies.map(message => message.result), Array(3).fill(replies[0].result));
  assert.equal(f.calls.length, 1);
});

test('receipt-only delivery failure stays pending and the stored receipt remains recoverable', async t => {
  let failReply = true;
  const f = await fixture(t, { send: message => {
    if (message.id === 2 && Object.hasOwn(message, 'result') && failReply) { failReply = false; throw Error('private transport diagnostic'); }
  } });
  const request = scoped(1, 'receipt-send', 'thread/start', {});
  await f.session.receive(request);
  const result = f.received.at(-1).result;
  const before = await f.store.loadOperation('a', request.params.key);
  await f.session.receive(receiptRequest(request, 2));
  assert.deepEqual(f.received.at(-1).error, { code: -32010, message: 'Sandbox operation outcome requires reconciliation', data: { sandboxOperationState: 'pending' } });
  await f.session.receive(receiptRequest(request, 3));
  assert.deepEqual(f.received.at(-1).result, result);
  assert.deepEqual(await f.store.loadOperation('a', request.params.key), before);
  assert.equal(f.calls.length, 1);
});

 test('central start and resume own scoped MCP config and child config cannot override it', async t => {
  const bindings=[];
  const briqTransport={closeTurn:nativeId=>assert.equal(nativeId,'native-a'),claimOwner:(binding,owner)=>{assert.ok(['a','b'].includes(binding.threadId));assert.ok(owner);},toolNames:()=>['briq_docs'],bind:binding=>{bindings.push(binding.threadId);return{config:{'mcp_servers.briq':{url:'http://127.0.0.1:8080/_cloud/briq/mcp',http_headers:{Authorization:`Bearer scoped-${binding.threadId}`}}},activate:()=>{},waitObserved:async()=>{},ready:()=>{},revoke:()=>{}};},revoke:()=>{}};
  const f=await fixture(t,{briqTransport});
  await f.session.receive({id:1,method:'thread/start',params:{config:{'mcp_servers.evil':{url:'https://evil.example'}}}});
  assert.equal(f.calls.length,0);
  f.responses.set('thread/start',params=>({model:'mock',config:params.config,thread:{model:'mock',id:'native-a',environments:params.environments,config:params.config}}));
  await f.session.receive({id:2,method:'thread/start',params:{}});
  assert.equal(f.calls[0].params.config['mcp_servers.briq'].http_headers.Authorization,'Bearer scoped-a');
  assert.equal(JSON.stringify(f.received.at(-1)).includes('scoped-a'),false);
  f.responses.set('thread/resume',params=>({model:'mock',config:params.config,thread:{model:'mock',id:'native-a',environments:[{environmentId:'exec-a',cwd:'/work'}]}}));
  f.responses.set('thread/read',()=>({thread:{id:'native-a',status:{type:'idle'},canAcceptDirectInput:true,environments:[{environmentId:'exec-a',cwd:'/work'}]}}));
  f.responses.set('mcpServerStatus/list',()=>({data:[{name:'briq',tools:{briq_docs:{}}}]}));
  await f.session.receive({id:3,method:'thread/resume',params:{threadId:'native-a'}});
  assert.equal(f.calls.findLast(row=>row.method==='thread/resume').params.config['mcp_servers.briq'].http_headers.Authorization,'Bearer scoped-a');
  assert.deepEqual(bindings,['a','a']);
  assert.equal(JSON.stringify(f.received.at(-1)).includes('scoped-a'),false);
  await f.broker.deliver({method:'thread/started',params:{threadId:'native-a',config:{'mcp_servers.briq':{http_headers:{Authorization:'Bearer scoped-a'}}}}});
  assert.equal(JSON.stringify(f.received.at(-1)).includes('scoped-a'),false);
 });

test('immutable allocation provider is durable before effect and rejects incompatible retry and default admission', async t => {
  const f = await fixture(t); let creates = 0;
  const cloud = { create: async binding => {
    creates++; assert.equal((await f.store.load(binding.threadId)).providerInstanceId, 'claudeAgent');
    throw Error('uncertain');
  }, find: async () => null };
  const options = { store: f.store, cloud, image: `image@sha256:${'a'.repeat(64)}`, bridgeUrl: 'wss://central.example/_cloud/bridge', edgeCredential: 'e'.repeat(32), registerEnvironment: async () => {} };
  await assert.rejects(new ThreadAllocator(options).allocate('owner', 'new', 'claudeAgent'), /admission/);
  assert.equal(await f.store.load('new'), null); assert.equal(creates, 0);
  const allocator = new ThreadAllocator({ ...options, admittedProviders: ['codex', 'claudeAgent'] });
  await assert.rejects(allocator.allocate('owner', 'new', 'claudeAgent'), /unknown/);
  await assert.rejects(allocator.allocate('owner', 'new'), /provider mismatch/);
  await assert.rejects(allocator.allocate('owner', 'new', 'claudeAgent'), /unknown/);
  await assert.rejects(allocator.allocate('owner', 'a', 'claudeAgent'), /provider mismatch/);
  await assert.rejects(allocator.allocate('owner', 'custom', 'custom'), /Unsupported/);
  assert.equal(creates, 1);
});
test('bridge capabilities expose exact safe metadata and bind every request to persisted provider', async t => {
  const f = await fixture(t);
  await f.session.receive({ id: 1, method: 'bridge/capabilities' });
  assert.deepEqual(f.received.at(-1).result, { providerInstanceId: 'codex', threadId: 'a', models: [{ slug: 'mock' }], authStatus: 'authenticated' });
  await f.session.receive({ id: 2, method: 'claude/allocate' });
  assert.ok(f.received.at(-1).error); assert.equal(f.calls.length, 0);
  const binding = await f.store.load('a');
  await f.store.save({ ...binding, providerInstanceId: 'claudeAgent' });
  await f.session.receive({ id: 3, method: 'bridge/capabilities' });
  assert.ok(f.received.at(-1).error);
});
test('Claude capability cannot use Codex initialization, operation receipts or environment registration', async t => {
  const f = await fixture(t); const binding = { ...await f.store.load('a'), providerInstanceId: 'claudeAgent' }; await f.store.save(binding);
  const broker = new CapabilityBroker({ store: f.store, app: f.app, admittedProviders: ['codex', 'claudeAgent'], claude: { enabled: true, capabilities: async () => ({ models: [{ slug: 'claude-fixture' }], authStatus: 'authenticated', secret: 'never-return' }) } });
  await broker.registerEnvironment(binding); assert.equal(f.calls.length, 0);
  const replies = []; const session = await broker.connect('cap-a', message => replies.push(message), () => {});
  await session.receive({ id: 1, method: 'bridge/capabilities' });
  assert.deepEqual(replies.at(-1).result, { providerInstanceId: 'claudeAgent', threadId: 'a', models: [{ slug: 'claude-fixture' }], authStatus: 'authenticated' });
  for (const method of ['initialize', 'thread/start', 'briq/operation/receipt']) {
    await session.receive({ id: 2, method }); assert.ok(replies.at(-1).error);
  }
  assert.equal(f.calls.length, 0);
});

test('omitted initial model uses unique native catalog default and verifies top-level start model', async t => {
  const f = await fixture(t);
  await f.session.receive({ id: 1, method: 'thread/start', params: {} });
  assert.equal(f.calls[0].params.model, 'mock');
  assert.equal((await f.store.load('a')).nativeModel, 'mock');
  const other = await fixture(t);
  other.responses.set('model/list', () => ({ data: [{ model: 'mock', isDefault: false }] }));
  await other.session.receive({ id: 1, method: 'thread/start', params: {} });
  assert.ok(other.received.at(-1).error); assert.equal(other.calls.length, 0);
});
test('removed model cannot continue by explicit selection, omission, steer or resume', async t => {
  const f = await fixture(t); const binding = await f.store.load('a'); binding.nativeThreadId = 'native-a'; binding.nativeModel = 'old'; await f.store.save(binding);
  f.responses.set('model/list', () => ({ data: [{ model: 'new', isDefault: true }] }));
  f.broker.activeTurns.set('native-a', 'active');
  for (const [method, params] of [
    ['turn/start', { threadId: 'native-a', model: 'old', input: [{ type: 'text', text: 'denied' }] }],
    ['turn/start', { threadId: 'native-a', input: [{ type: 'text', text: 'denied' }] }],
    ['thread/resume', { threadId: 'native-a' }],
    ['turn/steer', { threadId: 'native-a', expectedTurnId: 'active', input: [{ type: 'text', text: 'denied' }] }],
  ]) { await f.session.receive({ id: 2, method, params }); assert.ok(f.received.at(-1).error); }
  assert.equal(f.calls.length, 0);
});
test('omitted turn pins admitted binding model rather than changed account default', async t => {
  const f = await fixture(t); const binding = await f.store.load('a'); binding.nativeThreadId = 'native-a'; await f.store.save(binding);
  f.responses.set('model/list', () => ({ data: [{ model: 'mock', isDefault: false }, { model: 'new', isDefault: true }] }));
  f.responses.set('thread/read', () => ({ thread: { id: 'native-a', model: 'mock', environments: [{ environmentId: 'exec-a', cwd: '/work' }] } }));
  await f.session.receive({ id: 1, method: 'turn/start', params: { threadId: 'native-a', input: [{ type: 'text', text: 'hello' }] } });
  assert.equal(f.calls.find(call => call.method === 'turn/start').params.model, 'mock');
  assert.equal((await f.store.load('a')).turnState, 'bound');
});
test('resume validates native top-level model and quarantines mismatched response', async t => {
  const f = await fixture(t); const binding = await f.store.load('a'); binding.nativeThreadId = 'native-a'; await f.store.save(binding);
  f.responses.set('thread/resume', () => ({ model: 'wrong', thread: { id: 'native-a', model: 'mock', environments: [{ environmentId: 'exec-a', cwd: '/work' }] } }));
  await f.session.receive({ id: 1, method: 'thread/resume', params: { threadId: 'native-a' } });
  assert.ok(f.received.at(-1).error); assert.equal((await f.store.load('a')).nativeState, 'unknown');
  const count = f.calls.length;
  await f.session.receive({ id: 2, method: 'turn/start', params: { threadId: 'native-a', model: 'mock', input: [{ type: 'text', text: 'denied' }] } });
  assert.ok(f.received.at(-1).error); assert.equal(f.calls.length, count);
});
test('start response model mismatch retains unknown effect and cannot produce a clean durable receipt', async t => {
  const f = await fixture(t);
  f.responses.set('thread/start', params => ({ model: 'wrong', thread: { id: 'native-a', environments: params.environments } }));
  await f.session.receive(scoped(1, 'wrong-model-start', 'thread/start', {}));
  assert.equal((await f.store.load('a')).nativeState, 'unknown');
  assert.equal((await f.store.loadOperation('a', 'wrong-model-start')).state, 'uncertain');
  assert.ok(f.received.at(-1).error);
});

test('Codex durable receipt/adoption and exact interrupt remain available during metadata outage',async t=>{
 const f=await fixture(t);const request=scoped(1,'recover-no-auth','thread/start',{});await f.session.receive(request);
 const receipt=f.received.at(-1).result;assert.ok(receipt.result.thread.id);
 f.responses.set('account/read',()=>{throw Error('metadata unavailable');});
 await f.session.receive({id:2,method:'briq/operation/receipt',params:request.params});assert.deepEqual(f.received.at(-1).result,receipt);
 await f.session.receive({id:3,method:'briq/operation/adopt',params:{key:'recover-no-auth',nativeId:'native-a',resultHash:receipt.resultHash,eventSequence:7}});assert.deepEqual(f.received.at(-1).result,{});
 f.broker.activeTurns.set('native-a','active');
 await f.session.receive({id:4,method:'turn/interrupt',params:{threadId:'native-a',turnId:'active'}});assert.deepEqual(f.received.at(-1).result,{});
 const count=f.calls.length;
 await f.session.receive({id:5,method:'turn/start',params:{threadId:'native-a',input:[{type:'text',text:'denied'}]}});assert.ok(f.received.at(-1).error);assert.equal(f.calls.length,count);
});

test('deferred restart requires admitted verified resume before new prompt dispatch',async t=>{
 const f=await fixture(t);const binding=await f.store.load('a');Object.assign(binding,{nativeThreadId:'native-a',nativeState:'bound',restoreState:'deferred'});await f.store.save(binding);
 await f.session.receive({id:1,method:'turn/start',params:{threadId:'native-a',input:[{type:'text',text:'blocked until resumed'}]}});
 assert.ok(f.received.at(-1).error);assert.deepEqual(f.calls,[]);
 f.responses.set('thread/resume',()=>({model:'mock',thread:{id:'native-a',environments:[{environmentId:'exec-a',cwd:'/work'}]}}));
 f.responses.set('thread/read',()=>({thread:{id:'native-a',model:'mock',status:{type:'idle'},canAcceptDirectInput:true,environments:[{environmentId:'exec-a',cwd:'/work'}]}}));
 await f.session.receive({id:2,method:'thread/resume',params:{threadId:'native-a'}});assert.equal(f.received.at(-1).error,undefined);
 assert.equal((await f.store.load('a')).restoreState,undefined);assert.equal(f.calls.find(row=>row.method==='thread/resume').params.model,'mock');
 await f.session.receive({id:3,method:'turn/start',params:{threadId:'native-a',input:[{type:'text',text:'new prompt'}]}});
 assert.equal(f.received.at(-1).error,undefined);assert.equal(f.calls.filter(row=>row.method==='turn/start').length,1);
});


for (const shutdownSucceeds of [true, false]) test(`idle scoped resume detects subscribed override fallback (shutdown=${shutdownSucceeds})`, async () => {
 const binding={threadId:'a',allocationId:'allocation-a',nativeThreadId:'native-a'};
 const owner={closed:false}, calls=[], other={id:'native-b',token:'unchanged-b'};
 let subscribed=true, installed='old', observed=false, revoked=0, usable=false;
 const config={'mcp_servers.briq':{http_headers:{Authorization:'new'}}};
 const transport={closeTurn:()=>calls.push('lease-close'),toolNames:()=>['briq_docs'],bind:()=>{
  calls.push('bind');installed=installed==='old'?'old':installed;
  return {config,activate:(native,session)=>{assert.equal(native,'native-a');assert.equal(session,'session-a');},
   waitObserved:async()=>{if(!observed)throw Error('New MCP client not observed');},ready:()=>{usable=true;},revoke:()=>{revoked++;}};
 }};
 const app={request:async(method,params)=>{
  calls.push(method);
  if(method==='thread/read')return{thread:{id:'native-a',status:{type:'idle'},canAcceptDirectInput:true}};
  if(method==='thread/unsubscribe'){assert.deepEqual(params,{threadId:'native-a'});subscribed=false;return{status:'unsubscribed'};}
  if(method==='thread/resume'){
   // Faithful pinned behavior: config is ignored while subscribed or if native
   // shutdown fails; the RPC itself still succeeds with the old client.
   if(!subscribed&&shutdownSucceeds)installed=params.config['mcp_servers.briq'].http_headers.Authorization;
   subscribed=true;return{thread:{id:'native-a',sessionId:'session-a'}};
  }
  if(method==='mcpServerStatus/list'){if(installed==='new')observed=true;return{data:[{name:'briq',tools:{briq_docs:{}}}]};}
  throw Error('unexpected request');
 }};
 await app.request('thread/resume',{threadId:'native-a',config});assert.equal(installed,'old');calls.length=0;
 const attempt=resumeScopedCodex({app,transport,binding,owner,params:{excludeTurns:true},check:async()=>{},verify:async()=>{}});
 if(shutdownSucceeds){await attempt;assert.equal(usable,true);assert.equal(revoked,0);}
 else{await assert.rejects(attempt,/not observed/);assert.equal(usable,false);assert.equal(revoked,1);}
 assert.deepEqual(calls,['thread/read','lease-close','bind','thread/unsubscribe','thread/resume','mcpServerStatus/list']);
 assert.deepEqual(other,{id:'native-b',token:'unchanged-b'});
});

test('unsolicited or completed native turn events cannot reopen scoped turn authority', async t => {
 const f=await fixture(t);
 f.broker.observeTurn({method:'turn/started',params:{threadId:'native-a',turn:{id:'unsolicited'}}});
 assert.equal(f.broker.activeTurns.has('native-a'),false);
 const owner=[...f.broker.sessions].find(session=>session.threadId==='a');
 const pending={session:owner,intent:'pending',turnId:null,closed:false};f.broker.pendingTurns.set('native-a',pending);
 f.broker.observeTurn({method:'turn/completed',params:{threadId:'native-a',turn:{id:'early-completed'}}});
 f.broker.observeTurn({method:'turn/started',params:{threadId:'native-a',turn:{id:'early-completed'}}});
 assert.equal(pending.closed,true);assert.equal(f.broker.activeTurns.has('native-a'),false);
});

test('settled scoped operations admit next native turn; unknown families and uncertainty do not', async t => {
 const f=await fixture(t);const binding=await f.store.load('a');binding.nativeThreadId='native-a';await f.store.save(binding);
 const session=[...f.broker.sessions].find(value=>value.threadId==='a');
 const record={version:1,key:'scoped-receipt',method:'briq/scoped',providerInstanceId:'codex',threadId:'a',allocationId:'allocation-a',nativeId:'native-a',turnId:'completed-turn',requestId:'native-call',state:'completed'};
 await f.store.saveOperation('a',record);await f.broker.assertMutationAllowed(session);
 for(const changed of [{state:'unknown'},{state:'started'},{method:'unknown/family'},{providerInstanceId:'claudeAgent'},{nativeId:'native-b'}]){
  await f.store.saveOperation('a',{...record,...changed});await assert.rejects(f.broker.assertMutationAllowed(session));
 }
});


test('completed scoped mutation permits the next native turn and preserves later turn admission', async t => {
 const f=await fixture(t);const binding=await f.store.load('a');binding.nativeThreadId='native-a';await f.store.save(binding);
 await f.store.saveOperation('a',{version:1,key:'completed-scoped',method:'briq/scoped',providerInstanceId:'codex',threadId:'a',allocationId:'allocation-a',nativeId:'native-a',turnId:'old-turn',requestId:'old-call',state:'completed'});
 let count=0;f.responses.set('turn/start',()=>({turn:{id:`next-${++count}`,status:'inProgress'}}));
 f.responses.set('thread/read',()=>({thread:{id:'native-a',model:'mock',environments:[{environmentId:'exec-a',cwd:'/work'}]}}));
 for(const id of [1,2]){
  await f.session.receive({id,method:'turn/start',params:{threadId:'native-a',input:[{type:'text',text:'next task'}]}});
  assert.equal(f.received.at(-1).error,undefined);
  await f.broker.deliver({method:'turn/completed',params:{threadId:'native-a',turn:{id:`next-${id}`}}});
 }
 assert.equal(count,2);assert.equal((await f.store.loadOperation('a','completed-scoped')).state,'completed');
});

test('active or pending native turn denies rotation and competing bridge owner', async t => {
 const f=await fixture(t);const binding=await f.store.load('a');binding.nativeThreadId='native-a';await f.store.save(binding);
 await assert.rejects(f.broker.connect('cap-a',()=>{},()=>{}),/owner busy/);
 for(const state of ['active','pending']){
  if(state==='active')f.broker.activeTurns.set('native-a','running');
  else{f.broker.activeTurns.clear();f.broker.pendingTurns.set('native-a',{intent:'pending',closed:false});}
  await f.session.receive({id:state,method:'thread/resume',params:{threadId:'native-a'}});
  assert.ok(f.received.at(-1).error);
 }
 assert.equal(f.calls.some(row=>['thread/unsubscribe','thread/resume'].includes(row.method)),false);
 assert.equal((await f.store.load('a')).nativeState,undefined);
});
