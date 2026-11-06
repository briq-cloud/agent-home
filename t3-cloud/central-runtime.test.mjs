import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createCentralRuntime } from './central-runtime.mjs';
import { AllocationStore, digest, canonicalJson } from './allocations.mjs';

async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'t3-central-'));const runtimes=[];t.after(async()=>{for(const runtime of runtimes)await runtime.close();await rm(directory,{recursive:true,force:true});});
 const env={T3_CLOUD_EDGE_TOKEN:'e'.repeat(32),T3_CLOUD_STATE:directory,T3_CLOUD_CHILD_IMAGE:`image@sha256:${'a'.repeat(64)}`,T3_CLOUD_PUBLIC_ORIGIN:'https://central.example'};
 const calls=[];let closed=0;const observed=new Set(), installed=new Map(), bindings=new Map();let generation=0;
 const toolNames=['briq_docs'];
 const createScopedMcpTransport=()=>({toolNames:()=>toolNames,close:()=>bindings.clear(),closeTurn:()=>{},revoke:allocationId=>bindings.delete(allocationId),
  claimOwner:()=>{},revokeOwner:()=>{},
  bind:binding=>{const token=`private-unit-generation-${++generation}`;const entry={token,ready:false};bindings.set(binding.allocationId,entry);
   return{config:{'mcp_servers.briq':{http_headers:{Authorization:token}}},activate:(nativeId,sessionId)=>{assert.equal(nativeId,binding.nativeThreadId);assert.equal(sessionId,'native-session');},
    waitObserved:async()=>{if(!observed.has(token))throw Error('New MCP client not observed');},ready:()=>{entry.ready=true;},revoke:()=>{if(bindings.get(binding.allocationId)===entry)bindings.delete(binding.allocationId);}};}});
 const app={events:new EventEmitter(),notify:()=>{},close:async()=>{closed++;},request:async(method,params)=>{if(method==='account/read')return{account:{type:'chatgpt'}};if(method==='model/list')return{data:[{model:'mock',isDefault:true}]};calls.push({method,params});
  if(method==='thread/resume')installed.set(params.threadId,params.config['mcp_servers.briq'].http_headers.Authorization);
  if(method==='mcpServerStatus/list'){observed.add(installed.get(params.threadId));return{data:[{name:'briq',tools:{briq_docs:{}}}]};}
  return {model:'mock',thread:{model:'mock',id:'native',sessionId:'native-session',environments:[{environmentId:'exec',cwd:'/work'}],turns:[]}};}};
 return {directory,env,app,calls,runtimes,observed,installed,bindings,closed:()=>closed,deps:{startAppServer:async()=>app,createScopedMcpTransport,cloud:{}}};
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
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'t3',allocationId:'allocation',nativeThreadId:'native',nativeModel:'mock',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability'});
 const runtime=await createCentralRuntime(f.env,f.deps);f.runtimes.push(runtime);
 assert.equal(runtime.ready(),false);assert.deepEqual(f.calls,[]);
 await runtime.restore();await runtime.restore();assert.equal(runtime.ready(),true);
 assert.deepEqual(f.calls.map(value=>value.method),['environment/add','thread/resume','mcpServerStatus/list']);
 assert.equal(f.calls[0].params.authBearerToken,'capability');
});

for (const [label,turns] of [['completed',[{id:'finished',status:'completed'}]],['in-progress',[{id:'running',status:'inProgress'}]],['missing',[]]]) {
 test(`restart preserves unknown mutation quarantine with ${label} native history`,async t=>{
  const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
  await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'t3',allocationId:'allocation',bridgeToken:'bridge',nativeThreadId:'native',nativeModel:'mock',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability',turnState:'unknown'});
  const nativeRequest=f.app.request;
  f.app.request=async(method,params)=>{if(['account/read','model/list','mcpServerStatus/list'].includes(method))return nativeRequest(method,params);if(method==='thread/resume')f.installed.set(params.threadId,params.config['mcp_servers.briq'].http_headers.Authorization);f.calls.push({method,params});
  return {model:'mock',thread:{model:'mock',id:'native',sessionId:'native-session',environments:[{environmentId:'exec',cwd:'/work'}],turns}};};
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
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'t3',allocationId:'allocation',bridgeToken:'bridge',nativeThreadId:'native',nativeModel:'mock',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability',turnState:'bound',nativeTurnId:'completed'});
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

for (const recovery of ['repeated-revoke','restart']) test(`revoked asynchronous destroy settles through ${recovery} using only exact status`,async t=>{
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 const binding={state:'ready',ownerId:'owner',threadId:'destroy-thread',allocationId:'destroy-allocation',briqId:'exact-root',edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN)};
 const resource={id:'owned-child',name:'recorded-name',stackId:'recorded-stack',state:'live'};
 await store.save(binding);await store.saveOperation(binding.threadId,{key:'create-child',method:'briq/scoped',allocationId:binding.allocationId,state:'completed',resource});
 let phase='running',rootStops=0;const requests=[];
 const cloud={stop:async value=>{assert.equal(value.briqId,binding.briqId);rootStops++;},run:async args=>{
  requests.push(args);assert.equal(args[1],resource.id);
  if(args[0]==='destroy'){phase='destroying';return {briq:{...resource,state:phase}};}
  assert.equal(args[0],'status');return {briq:{...resource,state:phase}};
 }};
 let runtime=await createCentralRuntime(f.env,{...f.deps,cloud});f.runtimes.push(runtime);
 await assert.rejects(runtime.allocator.revoke('owner',binding.threadId));assert.equal(rootStops,1);
 await assert.rejects(runtime.allocator.revoke('owner',binding.threadId));
 assert.equal((await store.listOperations(binding.threadId))[0].resource.state,'live');
 const before=requests.length;phase='destroyed';
 if(recovery==='restart'){
  await runtime.close();runtime=await createCentralRuntime(f.env,{...f.deps,cloud});f.runtimes.push(runtime);
  await runtime.restore();assert.equal(runtime.ready(),true);
 }else await runtime.allocator.revoke('owner',binding.threadId);
 assert.deepEqual(requests.slice(before),[['status',resource.id]]);
 assert.equal(rootStops,1);assert.equal(requests.filter(args=>args[0]==='destroy').length,1);
 const row=(await store.listOperations(binding.threadId))[0];assert.equal(row.resource.state,'destroyed');assert.equal(row.cleanup.state,'completed');
 assert.deepEqual(await runtime.allocator.revocationIssues(),[]);
});

test('admission comes from trusted runtime construction and Claude restore never registers or resumes Codex', async t => {
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'claude',allocationId:'allocation',providerInstanceId:'claudeAgent',claudeNativeSessionId:'claude-native'});
 const runtime=await createCentralRuntime({...f.env,T3_CLOUD_ADMITTED_PROVIDERS:'["custom"]',CLAUDE_CLOUD_ENABLED:'true'},{...f.deps,createClaudeRuntime:()=>({enabled:true,close:async()=>{}})});f.runtimes.push(runtime);
 assert.deepEqual(runtime.admittedProviders,['codex','claudeAgent']);await runtime.restore();assert.deepEqual(f.calls,[]);
});
test('default restore rejects Claude assignment despite environment enablement', async t => {
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'claude',allocationId:'allocation',providerInstanceId:'claudeAgent'});
 const runtime=await createCentralRuntime({...f.env,CLAUDE_CLOUD_ENABLED:'true',T3_CLOUD_ADMITTED_PROVIDERS:'["claudeAgent"]'},f.deps);f.runtimes.push(runtime);
 assert.deepEqual(runtime.admittedProviders,['codex']);await assert.rejects(runtime.restore(),/not admitted/);assert.deepEqual(f.calls,[]);
});

test('restart defers removed persisted Codex model before native resume', async t => {
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'t3',allocationId:'allocation',nativeThreadId:'native',nativeModel:'removed',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability'});
 const runtime=await createCentralRuntime(f.env,f.deps);f.runtimes.push(runtime);
 await runtime.restore();assert.equal(runtime.ready(),true);assert.equal((await store.load('t3')).restoreState,'deferred');assert.deepEqual(f.calls.map(row=>row.method),['environment/add']);
});
test('restart pins legacy authoritative thread-read model and validates top-level resume model', async t => {
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'t3',allocationId:'allocation',nativeThreadId:'native',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability'});
 const runtime=await createCentralRuntime(f.env,f.deps);f.runtimes.push(runtime);await runtime.restore();
 assert.equal(f.calls.find(row=>row.method==='thread/resume').params.model,'mock');
 assert.equal((await store.load('t3')).nativeModel,'mock');assert.equal((await store.load('t3')).nativeState,'bound');
});

test('revocation attempts root stop despite exact Claude cleanup failure',async t=>{
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'claude',ownerId:'owner',allocationId:'allocation',providerInstanceId:'claudeAgent',briqId:'root'});
 await store.saveOperation('claude',{key:'child',method:'briq/scoped',allocationId:'allocation',state:'completed',resource:{id:'owned-child',name:'child',stackId:'stack',state:'live'}});
 let revoked=0,stopped=0,descendants=0;
 const runtime=await createCentralRuntime(f.env,{...f.deps,cloud:{run:async args=>{descendants++;assert.equal(args[1],'owned-child');assert.ok(['status','destroy'].includes(args[0]));return{briq:{id:'owned-child',name:'child',stackId:'stack',state:args[0]==='status'?'running':'destroyed'}};},stop:async binding=>{assert.equal(binding.briqId,'root');stopped++;}},createClaudeRuntime:()=>({enabled:true,close:async()=>{},revoke:async binding=>{assert.equal(binding.allocationId,'allocation');revoked++;throw Error('unknown native lifetime');}})});f.runtimes.push(runtime);
 await assert.rejects(runtime.allocator.revoke('owner','claude'),/cleanup requires reconciliation/);
 assert.equal(revoked,1);assert.equal(stopped,1);assert.equal(descendants,2);assert.equal((await store.load('claude')).rootStop.state,'completed');
 assert.equal((await store.load('claude')).nativeCleanup.state,'unknown');assert.equal((await runtime.allocator.revocationIssues()).length,1);
});

for (const outage of ['unauthenticated','unknown','account-error','catalog-error','removed']) test(`restart keeps durable recovery and owner sign-in available during ${outage}`,async t=>{
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'t3',allocationId:'allocation',bridgeToken:'bridge',nativeThreadId:'native',nativeModel:'mock',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability',turnState:'unknown'});
 const params={threadId:'native',input:[{type:'text',text:'original prompt'}]},result={turn:{id:'completed-turn'}};
 const envelope={version:1,threadId:'t3',key:'recover',method:'turn/start',params};
 const resultHash=digest(canonicalJson(result));
 await store.saveOperation('t3',{...envelope,allocationId:'allocation',state:'completed',result,resultHash,requestHash:digest(canonicalJson({allocationId:'allocation',threadId:'t3',method:'turn/start',params}))});
 let unavailable=true;const original=f.app.request;
 f.app.request=async(method,input)=>{
  if(method==='account/login/start')return {type:'chatgptDeviceCode',loginId:'login',userCode:'CODE',verificationUrl:'https://auth.example/device'};
  if(unavailable){
   if(method==='account/read'&&outage==='account-error')throw Error('account unavailable');
   if(method==='account/read'&&['unauthenticated','unknown'].includes(outage))return{account:null,requiresOpenaiAuth:outage==='unauthenticated'};
   if(method==='model/list'&&outage==='catalog-error')throw Error('catalog unavailable');
   if(method==='model/list'&&outage==='removed')return{data:[{model:'other',isDefault:true}]};
  }
  return original(method,input);
 };
 const runtime=await createCentralRuntime(f.env,f.deps);f.runtimes.push(runtime);await runtime.restore();
 assert.equal(runtime.ready(),true);assert.equal((await store.load('t3')).restoreState,'deferred');
 assert.deepEqual(await runtime.allocator.restorationIssues(),[{threadId:'t3',allocationId:'allocation',state:'deferred'}]);
 assert.equal((await runtime.broker.ownerRequest('account/login/start',{type:'chatgptDeviceCode'})).loginId,'login');
 const received=[];const session=await runtime.broker.connect('bridge',value=>received.push(value),()=>{});
 await session.receive({id:0,method:'initialize'});
 await session.receive({id:1,method:'briq/operation/receipt',params:envelope});assert.deepEqual(received.at(-1).result,{result,resultHash});
 await session.receive({id:2,method:'briq/operation/adopt',params:{key:'recover',nativeId:'completed-turn',resultHash,eventSequence:9}});assert.deepEqual(received.at(-1).result,{});
 await session.receive({id:3,method:'turn/start',params});assert.ok(received.at(-1).error);
 assert.equal(f.calls.some(row=>['thread/resume','turn/start'].includes(row.method)),false);
 unavailable=false;await runtime.restore();assert.equal((await store.load('t3')).nativeModel,'mock');
 assert.equal((await store.load('t3')).restoreState,undefined);assert.equal((await store.load('t3')).turnState,'unknown');
 assert.equal(f.calls.filter(row=>row.method==='thread/resume').length,1);assert.equal(f.calls.find(row=>row.method==='thread/resume').params.model,'mock');
 await runtime.restore();assert.equal(f.calls.filter(row=>row.method==='thread/resume').length,1);
 await session.receive({id:4,method:'turn/start',params});assert.ok(received.at(-1).error);assert.equal(f.calls.some(row=>row.method==='turn/start'),false);
});
test('restart keeps uncertain resume per-allocation and never retries its native effect',async t=>{
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'t3',allocationId:'allocation',nativeThreadId:'native',nativeModel:'mock',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability'});
 const original=f.app.request;f.app.request=async(method,params)=>{const result=await original(method,params);if(method==='thread/resume')throw Error('lost acknowledgement');return result;};
 const runtime=await createCentralRuntime(f.env,f.deps);f.runtimes.push(runtime);await runtime.restore();await runtime.restore();
 assert.equal(runtime.ready(),true);assert.equal(f.calls.filter(row=>row.method==='thread/resume').length,1);
 const binding=await store.load('t3');assert.equal(binding.nativeState,'unknown');assert.equal(binding.restoreState,'reconciliation-required');
});
for(const outcome of ['completed','unknown']) test(`native revoke ${outcome} survives repeated revoke and restart without control replay`,async t=>{
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'claude',ownerId:'owner',allocationId:'allocation',providerInstanceId:'claudeAgent',claudeNativeSessionId:'native-session',briqId:'root'});
 let revoked=0,stopped=0;
 const deps={...f.deps,cloud:{stop:async()=>{stopped++;}},createClaudeRuntime:()=>({enabled:true,close:async()=>{},revoke:async()=>{revoked++;if(outcome==='unknown')throw Error('native lifetime unknown');}})};
 let runtime=await createCentralRuntime(f.env,deps);f.runtimes.push(runtime);
 if(outcome==='unknown')await assert.rejects(runtime.allocator.revoke('owner','claude'));else await runtime.allocator.revoke('owner','claude');
 const marker=(await store.load('claude')).nativeCleanup;
 assert.deepEqual(marker,{allocationId:'allocation',threadId:'claude',nativeId:'native-session',state:outcome});
 const check=async()=>{const issues=await runtime.allocator.revocationIssues();assert.equal(issues.length,outcome==='unknown'?1:0);if(outcome==='unknown')await assert.rejects(runtime.allocator.revoke('owner','claude'),/reconciliation/);else await runtime.allocator.revoke('owner','claude');};
 await check();await runtime.close();runtime=await createCentralRuntime(f.env,deps);f.runtimes.push(runtime);await runtime.restore();await check();
 assert.equal(revoked,1);assert.equal(stopped,1);assert.deepEqual((await store.load('claude')).nativeCleanup,marker);
});

for(const state of ['pending','started','unknown']) test(`restart preserves ${state} native cleanup intent despite completed root evidence`,async t=>{
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 const binding={state:'revoked',ownerId:'owner',threadId:'claude',allocationId:'allocation',providerInstanceId:'claudeAgent',claudeNativeSessionId:'native-session',briqId:'root',rootStop:{briqId:'root',state:'completed'},nativeCleanup:{allocationId:'allocation',threadId:'claude',nativeId:'native-session',state}};
 await store.save(binding);let controls=0;
 const runtime=await createCentralRuntime(f.env,{...f.deps,cloud:{stop:async()=>{controls++;}},createClaudeRuntime:()=>({enabled:true,close:async()=>{},revoke:async()=>{controls++;}})});f.runtimes.push(runtime);
 await runtime.restore();assert.equal(runtime.ready(),true);
 await assert.rejects(runtime.allocator.revoke('owner','claude'),/reconciliation/);
 assert.equal((await runtime.allocator.revocationIssues()).length,1);assert.equal(controls,0);assert.equal((await store.load('claude')).nativeCleanup.state,state);
});

test('restart quarantines the credential owner from durable unknown native termination without probing',async t=>{
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({state:'revoked',threadId:'claude',allocationId:'allocation',providerInstanceId:'claudeAgent',briqId:'root',rootStop:{briqId:'root',state:'completed'},nativeCleanup:{allocationId:'allocation',threadId:'claude',nativeId:null,state:'unknown'}});
 const runtime=await createCentralRuntime(f.env,f.deps);await runtime.restore();assert.equal(runtime.ready(),true);
 assert.equal(runtime.claudeCredentialOwner.quarantined,true);assert.equal((await runtime.allocator.revocationIssues()).length,1);
 await assert.rejects(runtime.close(),/lifetime requires reconciliation/);assert.deepEqual(f.calls,[]);
});


test('cold history restore observes fresh capability without granting a scoped turn or replaying native mutation', async t => {
 const f=await fixture(t),store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({edgeTokenHash:digest(f.env.T3_CLOUD_EDGE_TOKEN),state:'ready',threadId:'t3',allocationId:'allocation',nativeThreadId:'native',nativeModel:'mock',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability',turnState:'unknown'});
 const runtime=await createCentralRuntime(f.env,f.deps);f.runtimes.push(runtime);await runtime.restore();
 assert.equal(f.bindings.get('allocation').ready,true);assert.equal(f.observed.size,1);
 assert.equal((await store.load('t3')).turnState,'unknown');
 assert.equal(runtime.broker.pendingTurns.size,0);
 assert.equal(f.calls.some(row=>['turn/start','turn/steer','turn/interrupt'].includes(row.method)),false);
 await runtime.restore();assert.equal(f.calls.filter(row=>row.method==='thread/resume').length,1);
});
