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
  const allocator = new ThreadAllocator({ store, cloud, image: `example/image@sha256:${'a'.repeat(64)}`, bridgeUrl: 'wss://central.example/_cloud/bridge', edgeCredential: 'e'.repeat(32), registerEnvironment: async () => {} });
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
    releaseNative = () => resolve({ thread: { id: 'native-a', environments: params.environments } }); signalStarted();
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
