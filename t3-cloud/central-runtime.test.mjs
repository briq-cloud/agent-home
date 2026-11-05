import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createCentralRuntime } from './central-runtime.mjs';
import { AllocationStore, digest } from './allocations.mjs';

async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'t3-central-'));const runtimes=[];t.after(async()=>{for(const runtime of runtimes)await runtime.close();await rm(directory,{recursive:true,force:true});});
 const env={T3_CLOUD_EDGE_TOKEN:'e'.repeat(32),T3_CLOUD_STATE:directory,T3_CLOUD_CHILD_IMAGE:`image@sha256:${'a'.repeat(64)}`,T3_CLOUD_PUBLIC_ORIGIN:'https://central.example'};
 const calls=[];let closed=0;
 const app={events:new EventEmitter(),notify:()=>{},close:async()=>{closed++;},request:async(method,params)=>{calls.push({method,params});return {thread:{id:'native',environments:[{environmentId:'exec',cwd:'/work'}],turns:[]}};}};
 return {directory,env,app,calls,runtimes,closed:()=>closed,deps:{startAppServer:async()=>app,cloud:{}}};
}
test('composition holds singleton lock until app-server termination is confirmed',async t=>{
 const f=await fixture(t);let finish;
 const runtime=await createCentralRuntime(f.env,f.deps);
 f.app.close=()=>new Promise(resolve=>{finish=resolve;});
 const closing=runtime.close();
 await assert.rejects(createCentralRuntime(f.env,f.deps),{code:'EEXIST'});
 finish();await closing;
 const next=await createCentralRuntime(f.env,{...f.deps,startAppServer:async()=>({...f.app,close:async()=>{}})});await next.close();
});
test('startup failure closes owned app-server and releases lock after exit',async t=>{
 const f=await fixture(t);
 await assert.rejects(createCentralRuntime({...f.env,T3_CLOUD_CHILD_IMAGE:'unpinned'},f.deps),/digest/);
 assert.equal(f.closed(),1);await assert.rejects(stat(join(f.directory,'central.lock')),{code:'ENOENT'});
});
test('composition keeps global Briq credentials out of executing provider options under the owner lock',async t=>{
 const f=await fixture(t);let options;
 const env={...f.env,BRIQ_MCP_TOKEN:'explicit-test-grant',BRIQ_API_URL:'https://api.example/v1',BRIQ_API_KEY:'not-an-mcp-grant',OPENAI_API_KEY:'not-forwarded',HOME:'/native-owner-home'};
 const runtime=await createCentralRuntime(env,{...f.deps,startAppServer:async value=>{await stat(join(f.directory,'central.lock/owner.json'));options=value;return f.app;}});f.runtimes.push(runtime);await runtime.restore();
 assert.deepEqual(options,{binary:'codex',home:join(f.directory,'codex')});
});
test('restart restores remote registration then verifies sticky native thread before serving',async t=>{
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'t3',allocationId:'allocation',nativeThreadId:'native',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability'});
 const runtime=await createCentralRuntime(f.env,f.deps);f.runtimes.push(runtime);
 assert.equal(runtime.ready(),false);assert.deepEqual(f.calls,[]);
 await runtime.restore();await runtime.restore();assert.equal(runtime.ready(),true);
 assert.deepEqual(f.calls.map(value=>value.method),['environment/add','thread/resume']);
 assert.equal(f.calls[0].params.authBearerToken,'capability');
});

for (const [label,turns] of [['completed',[{id:'finished',status:'completed'}]],['in-progress',[{id:'running',status:'inProgress'}]],['missing',[]]]) {
 test(`restart preserves unknown mutation quarantine with ${label} native history`,async t=>{
  const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
  await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'t3',allocationId:'allocation',bridgeToken:'bridge',nativeThreadId:'native',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability',turnState:'unknown'});
  f.app.request=async(method,params)=>{f.calls.push({method,params});return {thread:{id:'native',environments:[{environmentId:'exec',cwd:'/work'}],turns}};};
  const runtime=await createCentralRuntime(f.env,f.deps);f.runtimes.push(runtime);await runtime.restore();
  assert.equal((await store.load('t3')).turnState,'unknown');
  const received=[];const session=await runtime.broker.connect('bridge',value=>received.push(value),()=>{});
  await session.receive({id:0,method:'initialize'});
  await session.receive({id:1,method:'turn/start',params:{threadId:'native',input:[{type:'text',text:'must not replay'}]}});
  assert.ok(received.at(-1).error);assert.equal(f.calls.filter(value=>value.method==='turn/start').length,0);
  assert.equal(runtime.broker.activeTurns.get('native'),label==='in-progress'?'running':undefined);
 });
}
test('restart quarantines an unadopted result even when native turn identity was persisted',async t=>{
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'t3',allocationId:'allocation',bridgeToken:'bridge',nativeThreadId:'native',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability',turnState:'bound',nativeTurnId:'completed'});
 await store.markMutation('t3','unadopted-attempt','turn/start');
 const runtime=await createCentralRuntime(f.env,f.deps);f.runtimes.push(runtime);await runtime.restore();
 const received=[];const session=await runtime.broker.connect('bridge',value=>received.push(value),()=>{});
 await session.receive({id:0,method:'initialize'});
 await session.receive({id:1,method:'turn/start',params:{threadId:'native',input:[{type:'text',text:'must not replay'}]}});
 assert.ok(received.at(-1).error);assert.equal(f.calls.filter(value=>value.method==='turn/start').length,0);
 assert.deepEqual(await store.mutationMarkers('t3'),['unadopted-attempt']);
});

for (const outcome of ['unavailable','running','stopped']) test(`restart keeps revoked stop ${outcome} scoped and never replays a stop`,async t=>{
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 const binding={state:'revoked',threadId:'revoked-thread',allocationId:'revoked-allocation',briqId:'exact-root',rootStop:{briqId:'exact-root',state:'started'}};
 await store.save(binding);let reads=0,stops=0;
 const runtime=await createCentralRuntime(f.env,{...f.deps,cloud:{
  stopped:async value=>{reads++;assert.equal(value.briqId,'exact-root');if(outcome==='unavailable')throw Error('authentication required');return outcome==='stopped';},
  stop:async()=>{stops++;},
 }});f.runtimes.push(runtime);
 await runtime.restore();assert.equal(runtime.ready(),true);assert.equal(reads,1);assert.equal(stops,0);
 assert.equal((await store.load(binding.threadId)).rootStop.state,outcome==='stopped'?'completed':'started');
 assert.deepEqual(await runtime.allocator.revocationIssues(),outcome==='stopped'?[]:[{threadId:binding.threadId,allocationId:binding.allocationId,state:'reconciliation-required'}]);
 assert.deepEqual(f.calls,[]);
});
