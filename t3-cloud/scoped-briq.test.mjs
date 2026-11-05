import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllocationStore, ThreadAllocator } from './allocations.mjs';
import { BriqCloud, BriqCredentialOwner } from './briq-cloud.mjs';
import { ScopedBriq } from './scoped-briq.mjs';

async function fixture(t, override) {
  const directory = await mkdtemp(join(tmpdir(), 'scoped-briq-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AllocationStore(directory); await store.initialize();
  const identity = { threadId: 'thread-a', allocationId: 'allocation-a', nativeId: 'native-a' };
  const binding = { ...identity, nativeThreadId: identity.nativeId, briqId: 'root-a', state: 'ready' };
  await store.save(binding);
  const calls = [], resources = new Map(), files = new Map(); let sequence = 0;
  const execute = async (args, options) => {
    calls.push({ args, options });
    const [command, target] = args;
    if (override) { const result = await override(args, options); if (result !== undefined) return result; }
    if (command === 'run') {
      const name = args[args.indexOf('--name') + 1], stack = args[args.indexOf('--stack') + 1];
      const row = { id: `child-${++sequence}`, stackId: stack, name, state: 'running', internalHost: `${name}.internal`, env: { SECRET: 'excluded' } };
      resources.set(row.id, row); return { briqs: [row], outputs: { HOST: row.internalHost } };
    }
    if (command === 'list') return { briqs: [...resources.values()].filter(row => row.stackId === args[2]) };
    if (['status', 'start', 'stop', 'destroy'].includes(command)) return { briq: { ...resources.get(target), state: command === 'destroy' ? 'destroyed' : 'running' } };
    if (command === 'exec') return { exec: { id: 'exec-1', briqId: args[5], state: 'running' } };
    if (command === 'exec-result' || command === 'exec-stop') return { exec: { id: args[2], briqId: target, state: command === 'exec-stop' ? 'stopped' : 'exited', exitCode: 0, output: { stdout: 'ok', stderr: '' } } };
    if (command === 'files-put') { files.set(`${target}:${args[2]}`, options.stdin); return { path: args[2], bytes: options.stdin.length }; }
    if (command === 'files-get') return { path: args[2], contentBase64: Buffer.from(files.get(`${target}:${args[2]}`) ?? '').toString('base64') };
    if (command === 'logs') return { lines: [{ ts: 'now', line: 'ready' }] };
    throw Error('Unexpected fixture command');
  };
  const cloud = new BriqCloud({ directory, env: { HOME: '/central-only' }, run: execute });
  const scoped = new ScopedBriq({ store, cloud });
  let request = 0;
  const call = (name, input = {}, requestId = ++request) => scoped.call(identity, requestId, name, input);
  const create = async () => (await call('briq_run', { recipe: 'sandbox' })).briqs[0].id;
  return { directory, identity, binding, store, cloud, scoped, call, create, calls, resources };
}

test('recorded create supports list/status, exec/files and exact lifecycle with fixed CLI arguments', async t => {
  const f = await fixture(t); const id = await f.create();
  assert.deepEqual((await f.call('briq_list')).briqs.map(row => row.id), [id]);
  assert.equal((await f.call('briq_status', { id })).briq.env, undefined);
  await f.call('briq_files_put', { id, path: '/work/file', content: 'hello' });
  assert.equal(Buffer.from((await f.call('briq_files_get', { id, path: '/work/file' })).contentBase64, 'base64').toString(), 'hello');
  const exec = await f.call('briq_exec', { id, command: 'echo ok' });
  assert.equal((await f.call('briq_exec_result', { id, execId: exec.exec.id })).exec.state, 'exited');
  await f.call('briq_stop', { id }); await f.call('briq_start', { id }); await f.call('briq_destroy', { id });
  assert.deepEqual(await f.call('briq_list'), { briqs: [] });
  assert.deepEqual(f.calls.find(row => row.args[0] === 'files-put').args, ['files-put', id, '/work/file']);
  const args = f.calls.find(row => row.args[0] === 'exec').args;
  assert.deepEqual(args, ['exec', '--async', '--clear-env', '--timeout', '120000', id, '--', '/bin/sh', '-c', 'echo ok']);
});

test('root, central, other-thread, unknown IDs and unsupported options never reach CLI', async t => {
  const f = await fixture(t);
  for (const id of ['root-a', 'central', 'thread-b-child', 'unknown']) await assert.rejects(f.call('briq_destroy', { id }));
  const attacks = [
    { recipe: 't3-cloud' }, { recipe: '--api-url' }, { recipe: 'sandbox', stack: 'owner' },
    { recipe: 'sandbox', file: '/central/auth' }, { recipe: 'sandbox', env: { TOKEN: { secret: 'OWNER' } } },
    { recipe: 'sandbox', env: { VALUE: '{{briq:owner}}' } }, { recipe: 'sandbox', env: { VALUE: '$OWNER' } },
    { recipe: 'sandbox', argv: ['--token', 'OWNER'] }, { recipe: 'sandbox', constructor: 'escape' },
  ];
  for (const input of attacks) await assert.rejects(f.call('briq_run', input));
  await assert.rejects(f.call('proxy', { url: 'http://central' }));
  assert.equal(f.calls.length, 0);
});

test('create intent is durable before CLI, lost acknowledgment blocks new IDs and never replays after restart', async t => {
  let store, threadId, observed;
  const f = await fixture(t, async args => {
    if (args[0] === 'run') { observed = (await store.listOperations(threadId))[0]; throw Error('lost ack'); }
  });
  store = f.store; threadId = f.identity.threadId;
  await assert.rejects(f.call('briq_run', { recipe: 'redis' }, 'original'));
  assert.equal(observed.state, 'started'); assert.match(observed.intent.stack, /^td-/);
  const restarted = new ScopedBriq({ store: new AllocationStore(f.directory), cloud: f.cloud });
  await assert.rejects(restarted.call(f.identity, 'original', 'briq_run', { recipe: 'redis' }));
  await assert.rejects(restarted.call(f.identity, 'new-id', 'briq_run', { recipe: 'redis' }));
  assert.equal(f.calls.filter(row => row.args[0] === 'run').length, 1);
});

test('same mutation request returns receipt; changed payload conflicts without CLI', async t => {
  const f = await fixture(t); const first = await f.call('briq_run', { recipe: 'postgres' }, 'request');
  const count = f.calls.length;
  assert.deepEqual(await f.call('briq_run', { recipe: 'postgres' }, 'request'), first);
  await assert.rejects(f.call('briq_run', { recipe: 'redis' }, 'request'), /conflict/);
  assert.equal(f.calls.length, count);
});

test('forged/partial creates never grant ownership or cleanup rights', async t => {
  for (const mode of ['forged-name', 'mixed', 'unconfirmed']) {
    const f = await fixture(t, async args => {
      if (args[0] === 'run') return { briqs: [{ id: 'central', name: mode === 'forged-name' ? 'owner' : args[args.indexOf('--name') + 1], stackId: 'stack-central' }] };
      if (args[0] === 'list') return { briqs: mode === 'mixed' ? [{ id: 'central' }, { id: 'other' }] : [] };
    });
    await assert.rejects(f.call('briq_run', { recipe: 'sandbox' }));
    await assert.rejects(f.call('briq_status', { id: 'central' }));
    f.binding.state = 'revoked'; await f.store.save(f.binding);
    await assert.rejects(f.scoped.cleanup(f.binding));
    assert.equal(f.calls.some(row => ['destroy', 'exec'].includes(row.args[0])), false);
  }
});

test('status identity mismatch blocks data access and mutation before execution', async t => {
  let forged = false;
  const f = await fixture(t, async args => forged && args[0] === 'status' ? { briq: { id: 'other', name: 'owner', stackId: 'owner' } } : undefined);
  const id = await f.create(); forged = true;
  await assert.rejects(f.call('briq_files_get', { id, path: '/work/file' }));
  await assert.rejects(f.call('briq_exec', { id, command: 'hello' }));
  assert.equal(f.calls.some(row => ['exec', 'files-get'].includes(row.args[0])), false);
});

test('ledger write failure cannot admit creation', async t => {
  const f = await fixture(t); f.store.saveOperation = async () => { throw Error('disk unavailable'); };
  await assert.rejects(f.call('briq_run', { recipe: 'sandbox' })); assert.equal(f.calls.length, 0);
});

test('native rebind and revoked allocations deny stale calls before CLI; cleanup uses exact descendant IDs', async t => {
  const f = await fixture(t); const id = await f.create();
  f.binding.nativeThreadId = 'new-native'; await f.store.save(f.binding);
  const count = f.calls.length;
  await assert.rejects(f.call('briq_status', { id })); assert.equal(f.calls.length, count);
  f.binding.state = 'revoked'; await f.store.save(f.binding);
  await assert.rejects(f.scoped.call({ ...f.identity, nativeId: 'new-native' }, 'new', 'briq_status', { id }));
  await f.store.serialized(f.binding.threadId, () => f.scoped.cleanup(f.binding));
  assert.deepEqual(f.calls.filter(row => row.args[0] === 'destroy').map(row => row.args), [['destroy', id]]);
});

test('shared official CLI owner serializes operations and login owns credential until process end', async () => {
  const owner = new BriqCredentialOwner(); const events = [];
  const endLogin = owner.acquire({ kind: 'login' });
  const first = owner.run(async () => { events.push('first'); });
  const second = owner.run(async () => { events.push('second'); });
  assert.deepEqual(events, []); assert.throws(() => owner.acquire({ kind: 'status' }), /busy/);
  endLogin(); await Promise.all([first, second]); assert.deepEqual(events, ['first', 'second']);
  const release = owner.acquire({ kind: 'status' }); release();
});

test('revocation wins queued admission; later calls never start a CLI process', async t => {
 const f = await fixture(t); const id = await f.create();
 let release; const gate = new Promise(resolve => { release = resolve; });
 const revoke = f.store.serialized(f.identity.threadId, async () => { f.binding.state='revoked'; await f.store.save(f.binding); await gate; });
 const count = f.calls.length;
 const attempted = f.call('briq_status', {id});
 release(); await revoke; await assert.rejects(attempted); assert.equal(f.calls.length,count);
});

test('unknown exec outcome blocks later mutations and cleanup retains the exact failed handle', async t => {
 let lose = false;
 const f = await fixture(t, async args => lose && ['exec-result','exec-stop'].includes(args[0]) ? {exec:{id:args[2],briqId:args[1],state:'lost'}} : undefined);
 const id = await f.create(); const launched = await f.call('briq_exec',{id,command:'long command'});
 lose = true;
 await assert.rejects(f.call('briq_exec_result',{id,execId:launched.exec.id}));
 const count = f.calls.length; await assert.rejects(f.call('briq_exec',{id,command:'second command'})); assert.equal(f.calls.length,count);
 f.binding.state='revoked'; await f.store.save(f.binding);
 await assert.rejects(f.scoped.cleanup(f.binding));
 assert.equal(f.calls.some(row=>row.args[0]==='exec-stop' && row.args[1]===id && row.args[2]===launched.exec.id),true);
 assert.deepEqual(f.calls.filter(row=>row.args[0]==='destroy').map(row=>row.args),[['destroy',id]]);
 const launch=(await f.store.listOperations(f.identity.threadId)).find(row=>row.exec?.id===launched.exec.id);
 assert.equal(launch.exec.terminal,undefined); assert.equal(launch.cleanup.state,'unknown');
});


test('revocation tries all exact cleanup handles and the root stop despite independent cleanup failures', async t => {
 const failed = new Set(); let cleanup = false;
 const f = await fixture(t, async args => {
  if (cleanup && args[0]==='exec-stop') throw Error('lost stop acknowledgment');
  if (cleanup && args[0]==='destroy' && failed.has(args[1])) throw Error('lost destroy acknowledgment');
 });
 const first = await f.create(), second = await f.create();
 await f.call('briq_exec',{id:first,command:'first'});
 // Fixture exec IDs are per resource: both exact handles must still be attempted.
 await f.call('briq_exec',{id:second,command:'second'});
 failed.add(first); cleanup = true;
 let rootStops=0, revokedBeforeCleanup=false;
 f.binding.ownerId='owner'; await f.store.save(f.binding);
 const allocator = new ThreadAllocator({store:f.store, cloud:{stop:async binding=>{
  rootStops++; assert.equal(binding.briqId,'root-a'); assert.equal((await f.store.load(binding.threadId)).state,'revoked');
  throw Error('lost root stop acknowledgment');
 }}, image:'registry/child@sha256:'+'a'.repeat(64), bridgeUrl:'wss://central.example/_cloud/bridge', edgeCredential:'e'.repeat(43),
 registerEnvironment:async()=>{}, cleanup:async binding=>{
  revokedBeforeCleanup=(await f.store.load(binding.threadId)).state==='revoked'; await f.scoped.cleanup(binding);
 }});
 await assert.rejects(allocator.revoke('owner',f.identity.threadId),error=>error instanceof AggregateError && error.errors.length===2);
 assert.equal(revokedBeforeCleanup,true); assert.equal(rootStops,1);
 assert.deepEqual(f.calls.filter(row=>row.args[0]==='exec-stop').map(row=>row.args[1]),[first,second]);
 assert.deepEqual(f.calls.filter(row=>row.args[0]==='destroy').map(row=>row.args[1]),[first,second]);
 const records=await f.store.listOperations(f.identity.threadId);
 assert.equal(records.find(row=>row.resource?.id===first).resource.state,'live');
 assert.equal(records.find(row=>row.resource?.id===first).cleanup.state,'unknown');
 assert.equal(records.find(row=>row.resource?.id===second).resource.state,'destroyed');
 const count=f.calls.length; await assert.rejects(f.call('briq_status',{id:second})); assert.equal(f.calls.length,count);
});

for (const action of ['exec-stop', 'destroy']) test(`failed final ${action} receipt save remains unresolved after restart without control replay`, async t => {
 const f=await fixture(t); const id=await f.create();
 if(action==='exec-stop') await f.call('briq_exec',{id,command:'long command'});
 const save=f.store.saveOperation.bind(f.store); let failed=false;
 f.store.saveOperation=async(threadId,row)=>{
  await save(threadId,row);
  if(!failed && row.cleanup?.action===action && row.cleanup.state==='completed') { failed=true; throw Error('directory sync failed after rename'); }
 };
 f.binding.state='revoked'; await f.store.save(f.binding);
 await assert.rejects(f.scoped.cleanup(f.binding)); assert.equal(failed,true);
 const record=(await f.store.listOperations(f.identity.threadId)).find(row=>row.cleanup?.action===action);
 assert.equal(record.cleanup.state,'unknown');
 if(action==='exec-stop') assert.equal(record.exec.terminal,undefined);
 else assert.equal(record.resource.state,'live');
 const count=f.calls.length;
 await assert.rejects(new ScopedBriq({store:new AllocationStore(f.directory),cloud:f.cloud}).cleanup(f.binding));
 assert.equal(f.calls.length,count);
});

test('legacy cleanup unknown flags cannot falsely report completion even with terminal/tombstoned receipts',async t=>{
 const f=await fixture(t);const id=await f.create();
 const record=(await f.store.listOperations(f.identity.threadId)).find(row=>row.resource?.id===id);
 record.resource.state='destroyed';record.cleanup={action:'destroy',state:'unknown'};await f.store.saveOperation(f.identity.threadId,record);
 f.binding.state='revoked';await f.store.save(f.binding);const count=f.calls.length;
 await assert.rejects(f.scoped.cleanup(f.binding));assert.equal(f.calls.length,count);
});

test('root stop intent survives unknown acknowledgment and restart reconciles only by exact read-only status',async t=>{
 const f=await fixture(t);let stops=0,reads=0,stopped=false;
 f.binding.ownerId='owner';await f.store.save(f.binding);
 const options={store:f.store,cloud:{stop:async binding=>{
  stops++;const durable=await f.store.load(binding.threadId);assert.equal(durable.state,'revoked');
  assert.deepEqual(durable.rootStop,{briqId:'root-a',state:'started'});throw Error('lost stop acknowledgment');
 },stopped:async binding=>{reads++;assert.equal(binding.briqId,'root-a');return stopped;}},
 image:'registry/child@sha256:'+'a'.repeat(64),bridgeUrl:'wss://central.example/_cloud/bridge',edgeCredential:'e'.repeat(43),registerEnvironment:async()=>{}};
 await assert.rejects(new ThreadAllocator(options).revoke('owner',f.identity.threadId));
 assert.deepEqual((await f.store.load(f.identity.threadId)).rootStop,{briqId:'root-a',state:'unknown'});
 const restarted=new ThreadAllocator({...options,store:new AllocationStore(f.directory)});
 await assert.rejects(restarted.revoke('owner',f.identity.threadId),/unknown/);assert.equal(stops,1);assert.equal(reads,1);
 stopped=true;await restarted.revoke('owner',f.identity.threadId);assert.equal(stops,1);assert.equal(reads,2);
 assert.equal((await f.store.load(f.identity.threadId)).rootStop.state,'completed');
});

for(const state of ['pending','started','unknown']) test(`crashed ${state} root stop cannot trigger a replacement stop`,async t=>{
 const f=await fixture(t);let stops=0;
 f.binding.ownerId='owner';f.binding.state='revoked';f.binding.rootStop={briqId:'root-a',state};await f.store.save(f.binding);
 const allocator=new ThreadAllocator({store:f.store,cloud:{stop:async()=>{stops++;},stopped:async()=>false},
 image:'registry/child@sha256:'+'a'.repeat(64),bridgeUrl:'wss://central.example/_cloud/bridge',edgeCredential:'e'.repeat(43),registerEnvironment:async()=>{}});
 await assert.rejects(allocator.revoke('owner',f.identity.threadId),/unknown/);assert.equal(stops,0);
 assert.equal((await f.store.load(f.identity.threadId)).rootStop.state,state);
});

test('root reconciliation accepts only an authoritative exact stopped workspace identity',async()=>{
 let response={briq:{id:'root',name:'sandbox',state:'stopped'}};const calls=[];
 const cloud=new BriqCloud({directory:'/unused',env:{},run:async args=>{calls.push(args);return response;}});
 assert.equal(await cloud.stopped({briqId:'root'}),true);
 response={briq:{id:'another-root',name:'sandbox',state:'stopped'}};await assert.rejects(cloud.stopped({briqId:'root'}));
 response={briq:{id:'root',name:'owner-service',state:'stopped'}};await assert.rejects(cloud.stopped({briqId:'root'}));
 response={briq:{id:'root',name:'sandbox',state:'sleeping'}};assert.equal(await cloud.stopped({briqId:'root'}),false);
 assert.equal(calls.every(args=>args[0]==='status' && args[1]==='root'),true);
});
