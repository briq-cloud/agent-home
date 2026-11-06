import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {AllocationStore} from './allocations.mjs';
import {ClaudeRuntime,CLAUDE_CLOUD_ENABLED,claudeInitializationMetadata} from './claude-runtime.mjs';

const promptKey='11111111-1111-4111-8111-111111111111';
async function fixture(t,{enabled=true,dispose=async()=>{},closeTimeoutMs=10000,sendResult=true}={}) {
 const directory=await mkdtemp(join(tmpdir(),'claude-runtime-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=new AllocationStore(join(directory,'bindings')),ledger=new AllocationStore(join(directory,'ledger'));
 await store.initialize();await ledger.initialize();
 for(const threadId of ['a','b'])await store.save({threadId,allocationId:`allocation-${threadId}`,briqId:`briq-${threadId}`,state:'ready',providerInstanceId:'claudeAgent'});
 const events=[];let resolveResult;const delivered=new Promise(r=>resolveResult=r);let options,handler,loads=0,launches=0;
 const sdk={binary:'/pinned/claude',z:{string:()=>({optional(){return this;}}),number:()=>({optional(){return this;}}),fromJSONSchema:()=>({strict(){return this;}})},
  tool:(name,description,schema,fn)=>{if(name==='bash')handler=fn;return{name,handler:fn};},createSdkMcpServer:input=>({...input,instance:{registerTool(){}}}),
  query:input=>{options=input.options;const iterator=(async function*(){
   yield {type:'system',subtype:'init',permissionMode:'dontAsk',session_id:input.options.sessionId,uuid:promptKey};
   for await(const prompt of input.prompt){
    assert.equal(prompt.session_id,input.options.sessionId);
    const result=await handler({command:'printf remote'});
    yield {type:'assistant',session_id:input.options.sessionId,uuid:promptKey,parent_tool_use_id:null,user_message_uuid:prompt.uuid,message:{content:[{type:'text',text:result.content[0].text}]}};
    yield {type:'result',session_id:input.options.sessionId,uuid:promptKey,user_message_uuid:prompt.uuid,is_error:false};
   }
  })();return{[Symbol.asyncIterator]:()=>iterator,setModel:async()=>{},close:()=>{},[Symbol.asyncDispose]:dispose};}};
 const cloud={execAsync:async(briqId,command)=>{launches++;return{exec:{id:'exec-a',briqId,state:'exited',exitCode:0,output:{stdout:'remote',stderr:'',stdoutBytes:6,stderrBytes:0}}};},execStop:async()=>{throw Error('unexpected stop');}};
 const runtime=new ClaudeRuntime({store,ledger,cloud,scopedBriq:{call:async()=>({owned:true})},directory:join(directory,'claude'),capabilityMetadata:async()=>({models:[{slug:'claude-sonnet-4-6'}],authStatus:'authenticated'}),enabled,closeTimeoutMs,loadSdk:async()=>{loads++;return sdk;}});
 const session=threadId=>({threadId,allocationId:`allocation-${threadId}`,closed:false,send:async message=>{events.push(message);if(message.params?.event.type==='result'){resolveResult();if(!sendResult)throw Error('lost transport');}},close(){this.closed=true;}});
 const a=session('a'),b=session('b');const receive=(session,method,params={})=>runtime.receive(session,{id:1,method,params});
 return{store,ledger,runtime,cloud,a,b,receive,events,delivered,getOptions:()=>options,getLoads:()=>loads,getLaunches:()=>launches};
}
test('cloud enabling remains closed and cannot load SDK or native credentials',async t=>{
 assert.equal(CLAUDE_CLOUD_ENABLED,false);const f=await fixture(t,{enabled:false});
 await assert.rejects(f.receive(f.a,'claude/allocate'),/unavailable/);assert.equal(f.getLoads(),0);
});
test('native session is server-owned, one query owns credentials, and remote Bash preserves allocation identity',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');
 const {nativeId:other}=await f.receive(f.b,'claude/allocate');assert.notEqual(nativeId,other);
 await assert.rejects(f.receive(f.a,'claude/open',{nativeId:other,key:'open-a',model:'claude-sonnet-4-6'}),/identity/);
 await f.receive(f.a,'claude/open',{nativeId,key:'open-a',model:'claude-sonnet-4-6'});
 await assert.rejects(f.receive(f.b,'claude/open',{nativeId:other,key:'open-b',model:'claude-sonnet-4-6'}),/busy/);
 const options=f.getOptions();assert.deepEqual(options.tools,[]);assert.deepEqual(options.settingSources,[]);assert.deepEqual(options.skills,[]);
 assert.deepEqual(options.toolAliases,{Bash:'mcp__workspace__bash'});assert.equal(options.strictMcpConfig,true);assert.equal(options.permissionMode,'dontAsk');
 assert.equal(options.mcpServers.briq.name,'briq');assert(options.allowedTools.includes('mcp__briq__briq_run'));
 assert.equal(options.allowedTools.some(name=>name.includes('*')),false);
 const guidance=await readFile(new URL('./skills/briq/SKILL.md',import.meta.url),'utf8');assert(options.systemPrompt.endsWith(guidance));
 assert.equal(options.env.BRIQ_API_KEY,undefined);assert.equal(options.env.BRIQ_MCP_TOKEN,undefined);
 assert.equal(options.env.ANTHROPIC_API_KEY,undefined);assert.equal(options.env.T3_CLOUD_BRIDGE_TOKEN,undefined);
 assert(options.disallowedTools.includes('Read')&&options.disallowedTools.includes('Agent'));
 await f.receive(f.a,'claude/offer',{nativeId,key:promptKey,text:'Do the remote task'});await f.delivered;
 assert.equal(f.getLaunches(),1);assert.equal(f.events.at(-1).params.nativeId,nativeId);
 const duplicate=await f.receive(f.a,'claude/offer',{nativeId,key:promptKey,text:'Do the remote task'});assert.equal(duplicate.state,'result-pending');
 const receipt=await f.receive(f.a,'claude/receipt',{nativeId,key:promptKey});
 assert.equal((await f.ledger.loadOperation('a',`turn-${promptKey}`)).state,'result-pending');
 await f.receive(f.a,'claude/adopt',{nativeId,key:promptKey,resultHash:receipt.resultHash,eventSequence:7});
 await f.receive(f.a,'claude/adopt',{nativeId,key:promptKey,resultHash:receipt.resultHash,eventSequence:7});
 assert.equal((await f.ledger.loadOperation('a',`turn-${promptKey}`)).state,'adopted');
 await f.receive(f.a,'claude/close',{nativeId});assert.equal(f.runtime.owner,null);
});
test('child cannot submit SDK configuration or execution destination',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');
 await assert.rejects(f.receive(f.a,'claude/open',{nativeId,key:'open-a',model:'claude-sonnet-4-6',env:{HOME:'/owner'}}),/Invalid/);
 await assert.rejects(f.receive(f.a,'claude/open',{nativeId,key:'open-a',model:'claude-sonnet-4-6',briqId:'briq-b'}),/Invalid/);
 assert.equal(f.getLoads(),0);
});
test('restart with an uncertain query record cannot spawn a second native owner',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');
 await f.ledger.saveOperation('a',{key:'open-uncertain',method:'claude/open',state:'started',nativeId});
 await assert.rejects(f.receive(f.a,'claude/open',{nativeId,key:'open-new',model:'claude-sonnet-4-6'}),/outcome unknown/);
 assert.equal(f.getLoads(),0);assert.equal(f.runtime.quarantined,true);
});

test('lost offer acknowledgement never replays and changed payload conflicts',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');
 await f.receive(f.a,'claude/open',{nativeId,key:'open-a',model:'claude-sonnet-4-6'});
 const offer={nativeId,key:promptKey,text:'one side effect'};
 await Promise.all([f.receive(f.a,'claude/offer',offer),f.receive(f.a,'claude/offer',offer)]);
 await f.delivered;assert.equal(f.getLaunches(),1);
 await assert.rejects(f.receive(f.a,'claude/offer',{...offer,text:'changed'}),/conflict/);
 const receipt=await f.receive(f.a,'claude/receipt',{nativeId,key:promptKey});
 await assert.rejects(f.receive(f.a,'claude/adopt',{nativeId,key:promptKey,resultHash:'0'.repeat(64),eventSequence:8}),/match/);
 assert.equal(f.runtime.owner.turnId,`turn-${promptKey}`);
 await f.receive(f.a,'claude/adopt',{nativeId,key:promptKey,resultHash:receipt.resultHash,eventSequence:8});
 await assert.rejects(f.receive(f.a,'claude/adopt',{nativeId,key:promptKey,resultHash:receipt.resultHash,eventSequence:9}),/Conflicting/);
 await f.receive(f.a,'claude/close',{nativeId});
});
test('known-ended unadopted result retains owner until durable receipt reattachment',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');
 await f.receive(f.a,'claude/open',{nativeId,key:'open-a',model:'claude-sonnet-4-6'});
 await f.receive(f.a,'claude/offer',{nativeId,key:promptKey,text:'persist me'});await f.delivered;
 await f.receive(f.a,'claude/close',{nativeId});
 assert.equal(f.runtime.quarantined,false);assert.notEqual(f.runtime.owner,null);
 assert.equal(f.runtime.owner.terminated,true);
 assert.equal((await f.ledger.loadOperation('a',`turn-${promptKey}`)).state,'result-pending');
 const reconnect={...f.a};const pending=await f.receive(reconnect,'claude/pending',{nativeId});
 assert.equal(pending.results.length,1);
 await f.receive(reconnect,'claude/adopt',{...pending.results[0],eventSequence:19});
 assert.equal(f.runtime.owner,null);assert.equal(f.runtime.credentials.current,null);
 const {nativeId:other}=await f.receive(f.b,'claude/allocate');
 await f.receive(f.b,'claude/open',{nativeId:other,key:'next-owner',model:'claude-sonnet-4-6'});
 await f.receive(f.b,'claude/close',{nativeId:other});
});
test('whole SDK disposal deadline quarantines owner instead of releasing credentials',async t=>{
 const f=await fixture(t,{dispose:()=>new Promise(()=>{}),closeTimeoutMs:0});
 const {nativeId}=await f.receive(f.a,'claude/allocate');
 await f.receive(f.a,'claude/open',{nativeId,key:'open-a',model:'claude-sonnet-4-6'});
 await assert.rejects(f.receive(f.a,'claude/close',{nativeId}),/termination unknown/);
 assert.equal(f.runtime.quarantined,true);assert.notEqual(f.runtime.owner,null);
});

test('an acknowledgement lost after adoption can be recovered without replaying the prompt',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');
 await f.receive(f.a,'claude/open',{nativeId,key:'open-a',model:'claude-sonnet-4-6'});
 await f.receive(f.a,'claude/offer',{nativeId,key:promptKey,text:'one write'});await f.delivered;
 const receipt=await f.receive(f.a,'claude/receipt',{nativeId,key:promptKey});
 // Ignore the original acknowledgement, then recover the same receipt and
 // committed event sequence. Neither operation may enqueue a native prompt.
 await f.receive(f.a,'claude/adopt',{nativeId,key:promptKey,resultHash:receipt.resultHash,eventSequence:11});
 const recovered=await f.receive(f.a,'claude/receipt',{nativeId,key:promptKey});assert.deepEqual(recovered,receipt);
 await f.receive(f.a,'claude/adopt',{nativeId,key:promptKey,resultHash:receipt.resultHash,eventSequence:11});
 assert.equal(f.getLaunches(),1);await f.receive(f.a,'claude/close',{nativeId});
});

test('partially adopted journal remains discoverable after binding persistence fails',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');
 await f.receive(f.a,'claude/open',{nativeId,key:'open-a',model:'claude-sonnet-4-6'});
 await f.receive(f.a,'claude/offer',{nativeId,key:promptKey,text:'one write'});await f.delivered;
 await f.receive(f.a,'claude/close',{nativeId});
 const receipt=(await f.receive(f.a,'claude/pending',{nativeId})).results[0];
 const save=f.store.save.bind(f.store);let fail=true;
 f.store.save=async value=>{if(fail&&value.claudeHasTurns){fail=false;throw Error('injected binding write failure');}return save(value);};
 await assert.rejects(f.receive({...f.a},'claude/adopt',{...receipt,eventSequence:23}),/injected/);
 assert.equal((await f.ledger.loadOperation('a',`turn-${promptKey}`)).state,'adopted');
 assert.notEqual(f.runtime.credentials.current,null);
 const reconnect={...f.a};assert.deepEqual((await f.receive(reconnect,'claude/pending',{nativeId})).results,[receipt]);
 await f.receive(reconnect,'claude/adopt',{...receipt,eventSequence:23});
 assert.equal(f.runtime.owner,null);assert.equal(f.runtime.credentials.current,null);assert.equal(f.getLaunches(),1);
});
test('adoption cannot overwrite a revocation committed while its journal write is awaiting',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');
 await f.receive(f.a,'claude/open',{nativeId,key:'open-a',model:'claude-sonnet-4-6'});
 await f.receive(f.a,'claude/offer',{nativeId,key:promptKey,text:'one write'});await f.delivered;
 const receipt=await f.receive(f.a,'claude/receipt',{nativeId,key:promptKey});
 let journalWritten,continueWrite;const entered=new Promise(r=>journalWritten=r),release=new Promise(r=>continueWrite=r);
 const save=f.ledger.saveOperation.bind(f.ledger);
 f.ledger.saveOperation=async(thread,record)=>{await save(thread,record);if(record.state==='adopted'){journalWritten();await release;}};
 const adoption=f.receive(f.a,'claude/adopt',{nativeId,key:promptKey,resultHash:receipt.resultHash,eventSequence:29});
 const rejected=assert.rejects(adoption,/revoked/);await entered;
 await f.store.serialized('a',async()=>{const binding=await f.store.load('a');binding.state='revoked';await f.store.save(binding);});
 continueWrite();await rejected;assert.equal((await f.store.load('a')).state,'revoked');
 await f.runtime.close();
});
test('revocation after prompt journal persistence prevents dispatch',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');
 await f.receive(f.a,'claude/open',{nativeId,key:'open-a',model:'claude-sonnet-4-6'});
 const save=f.ledger.saveOperation.bind(f.ledger);
 f.ledger.saveOperation=async(thread,record)=>{await save(thread,record);if(record.method==='claude/offer'){
   await f.store.serialized('a',async()=>{const binding=await f.store.load('a');binding.state='revoked';await f.store.save(binding);});
 }};
 await assert.rejects(f.receive(f.a,'claude/offer',{nativeId,key:promptKey,text:'do not dispatch'}),/revoked/);
 assert.equal(f.getLaunches(),0);await f.runtime.close();
});

 test('official MCP rejects unknown Claude tool options before scoped mutation admission',async()=>{
  const [{McpServer},{Client},{InMemoryTransport},{z},{createScopedClaudeMcpServer}]=await Promise.all([
   import('@modelcontextprotocol/sdk/server/mcp.js'),import('@modelcontextprotocol/sdk/client/index.js'),
   import('@modelcontextprotocol/sdk/inMemory.js'),import('zod'),import('./claude-runtime.mjs')]);
  let calls=0;
  const {ScopedBriq}=await import('./scoped-briq.mjs');
  const identity={nativeId:'native-a',allocationId:'allocation-a',threadId:'a',turnId:'turn-a',turnRecord:{state:'started'},openRecord:{key:'open-a'}};
  const scopedBriq=new ScopedBriq({store:{load:async()=>({...identity,providerInstanceId:'claudeAgent',claudeNativeSessionId:identity.nativeId,state:'ready',briqId:'protected-root',stack:'t3-'+'a'.repeat(24),rootStackId:'stack-a'}),
   serialized:async(key,operation)=>operation(),listOperations:async()=>[],saveOperation:async()=>{}},
   cloud:{env:{},run:async()=>{calls++;throw Error('Fake CLI unavailable');}}});
  const server=createScopedClaudeMcpServer({z,createSdkMcpServer:({name,version})=>({instance:new McpServer({name,version})})},
   identity,scopedBriq);
  const client=new Client({name:'schema-regression',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);await client.connect(clientTransport);
  try {
   const inventory=await client.listTools();
   assert.equal(inventory.tools.find(tool=>tool.name==='briq_run').inputSchema.additionalProperties,false);
   const rejected=await client.callTool({name:'briq_run',arguments:{recipe:'sandbox',file:'/central/auth'}});
   assert.equal(rejected.isError,true);assert.equal(calls,0);
   const accepted=await client.callTool({name:'briq_run',arguments:{recipe:'sandbox'}});
   assert.equal(accepted.isError,true);assert.equal(calls,1);
  } finally {await client.close();await server.instance.close();}
 });

test('Claude runtime independently denies Codex and legacy capabilities before metadata or SDK access', async t => {
 const f=await fixture(t);
 for(const providerInstanceId of [undefined,'codex','custom']) {
  const binding=await f.store.load('a');await f.store.save({...binding,providerInstanceId});
  await assert.rejects(f.receive(f.a,'claude/allocate'));
 }
 assert.equal(f.getLoads(),0);assert.equal(f.getLaunches(),0);
});
test('enabled is never authentication and unknown metadata cannot allocate a native identity', async t => {
 const f=await fixture(t);f.runtime.capabilityMetadata=undefined;f.runtime.loadSdk=async()=>{throw Error('SDK unavailable');};
 assert.deepEqual(await f.runtime.capabilities(f.a),{models:[],authStatus:'unknown'});
 await assert.rejects(f.receive(f.a,'claude/allocate'),/authentication/);
 assert.equal((await f.store.load('a')).claudeNativeSessionId,undefined);assert.equal(f.getLoads(),0);
 for(const authStatus of ['unknown','unauthenticated']) {
  f.runtime.capabilityMetadata=async()=>({models:[{slug:'claude-sonnet-4-6'}],authStatus});
  await assert.rejects(f.receive(f.a,'claude/allocate'),/authentication/);
 }
 f.runtime.capabilityMetadata=async()=>({models:[{slug:'claude-other'}],authStatus:'authenticated'});
 const {nativeId}=await f.receive(f.a,'claude/allocate');
 await assert.rejects(f.receive(f.a,'claude/open',{nativeId,key:'open',model:'claude-sonnet-4-6'}),/model is not admitted/);
 assert.equal(f.getLoads(),0);
});

const subscriptionInit={account:{apiProvider:'firstParty',subscriptionType:'pro',tokenSource:'oauth',apiKeySource:'none',email:'never-export'},models:[{value:'sonnet',resolvedModel:'claude-sonnet-4-6'},{value:'claude-sonnet-4-6'},{value:'unsupported-alias'}]};
test('initialization authority requires explicit subscription tuple and exact canonical IDs',()=>{
 assert.deepEqual(claudeInitializationMetadata(subscriptionInit),{models:[{slug:'claude-sonnet-4-6'}],authStatus:'authenticated'});
 for(const account of [{},{...subscriptionInit.account,tokenSource:undefined},{...subscriptionInit.account,tokenSource:'none'},{...subscriptionInit.account,apiProvider:'vertex'},{...subscriptionInit.account,apiKeySource:'env'},{...subscriptionInit.account,subscriptionType:''}]) {
  assert.deepEqual(claudeInitializationMetadata({...subscriptionInit,account}),{models:[],authStatus:'unknown'});
 }
 assert.deepEqual(claudeInitializationMetadata({...subscriptionInit,models:[{value:'sonnet'}]}),{models:[],authStatus:'unknown'});
 assert.deepEqual(claudeInitializationMetadata({...subscriptionInit,models:[{value:'claude-sonnet-4-6[1m]'}]}),{models:[],authStatus:'unknown'});
});
async function metadataFixture(t,{exit=true,dispose=async()=>{},initialize=async()=>subscriptionInit}={}) {
 const f=await fixture(t);let loads=0,queries=0,spawns=0,prompts=0,closed=0,options;const children=[];
 f.runtime.capabilityMetadata=undefined;f.runtime.closeTimeoutMs=100;
 f.runtime.spawnProcess=()=>{spawns++;const child=new EventEmitter();children.push(child);child.kill=()=>{if(exit)queueMicrotask(()=>child.emit('exit',0));};return child;};
 f.runtime.loadSdk=async()=>{loads++;return{binary:'/pinned/claude',query:input=>{queries++;options=input.options;
  input.prompt[Symbol.asyncIterator]().next().then(value=>{if(!value.done)prompts++;});
  input.options.spawnClaudeCodeProcess({command:'/pinned/claude',args:[],cwd:input.options.cwd,env:input.options.env});
  return{initializationResult:initialize,close:()=>{closed++;},[Symbol.asyncDispose]:dispose};}};};
 return{...f,counts:()=>({loads,queries,spawns,prompts,closed}),options:()=>options,children};
}
test('idle capabilities single-flight one owned initialization with no prompt and exit before lease handoff',async t=>{
 const f=await metadataFixture(t);const [a,b]=await Promise.all([f.runtime.capabilities(f.a),f.runtime.capabilities(f.b)]);
 assert.deepEqual(a,b);assert.equal(a.authStatus,'authenticated');assert.deepEqual(f.counts(),{loads:1,queries:1,spawns:1,prompts:0,closed:1});
 assert.equal(f.runtime.credentials.current,null);assert.equal(f.runtime.credentials.quarantined,false);
 const options=f.options();assert.equal(options.persistSession,false);assert.equal(options.model,undefined);assert.equal(options.resume,undefined);assert.equal(options.sessionId,undefined);
 assert.deepEqual(options.tools,[]);assert.deepEqual(options.mcpServers,{});assert.deepEqual(options.settingSources,[]);assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS,'false');
 assert.equal(options.env.CLAUDE_CODE_AUTO_CONNECT_IDE,'0');assert.equal(JSON.stringify(a).includes('never-export'),false);
});
test('metadata cleanup uncertainty quarantines owner and blocks replacement even after late exit',async t=>{
 const f=await metadataFixture(t,{exit:false});
 assert.deepEqual(await f.runtime.capabilities(f.a),{models:[],authStatus:'unknown'});
 assert.equal(f.runtime.credentials.quarantined,true);assert.notEqual(f.runtime.credentials.current,null);
 f.children[0].emit('exit',0);await f.runtime.capabilities(f.b);assert.equal(f.counts().spawns,1);
 await assert.rejects(f.receive(f.a,'claude/allocate'),/authentication/);
});
test('stuck metadata SDK disposer quarantines even when captured process exits',async t=>{
 const f=await metadataFixture(t,{dispose:()=>new Promise(()=>{})});
 assert.deepEqual(await f.runtime.capabilities(f.a),{models:[],authStatus:'unknown'});assert.equal(f.runtime.credentials.quarantined,true);
 assert.equal(f.counts().spawns,1);
});
test('capabilities reuse active initialized execution metadata without probing',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');await f.receive(f.a,'claude/open',{nativeId,key:'open',model:'claude-sonnet-4-6'});
 f.runtime.capabilityMetadata=undefined;
 assert.equal((await f.runtime.capabilities(f.b)).authStatus,'authenticated');assert.equal(f.getLoads(),1);
 await f.receive(f.a,'claude/close',{nativeId});
});
test('existing identity and durable receipt recovery remain available after auth loss without metadata',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');await f.receive(f.a,'claude/open',{nativeId,key:'open',model:'claude-sonnet-4-6'});
 await f.receive(f.a,'claude/offer',{nativeId,key:promptKey,text:'hello'});await f.delivered;
 let probes=0;f.runtime.capabilityMetadata=async()=>{probes++;throw Error('auth unavailable');};
 assert.deepEqual(await f.receive(f.a,'claude/allocate'),{nativeId});
 assert.equal((await f.receive(f.a,'claude/pending',{nativeId})).results.length,1);
 const receipt=await f.receive(f.a,'claude/receipt',{nativeId,key:promptKey});
 await f.receive(f.a,'claude/close',{nativeId});assert.notEqual(f.runtime.credentials.current,null);
 await f.receive(f.a,'claude/adopt',{nativeId,key:promptKey,resultHash:receipt.resultHash,eventSequence:7});
 assert.equal(f.runtime.credentials.current,null);assert.equal(probes,0);assert.equal(f.getLoads(),1);
});
test('catalog removal denies new prompt but exact cancellation ignores auth and model membership',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');await f.receive(f.a,'claude/open',{nativeId,key:'open',model:'claude-sonnet-4-6'});
 f.runtime.capabilityMetadata=async()=>({authStatus:'authenticated',models:[{slug:'claude-other'}]});
 await assert.rejects(f.receive(f.a,'claude/offer',{nativeId,key:promptKey,text:'denied'}),/model is not admitted/);
 await f.receive(f.a,'claude/interrupt',{nativeId});assert.equal(f.runtime.credentials.current,null);assert.equal(f.getLaunches(),0);
});
test('revocation closes exact idle owner while allocation lock is held and never touches another allocation',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');await f.receive(f.a,'claude/open',{nativeId,key:'open',model:'claude-sonnet-4-6'});
 await f.runtime.revoke({allocationId:'allocation-b',threadId:'b'});assert.notEqual(f.runtime.owner,null);
 await f.store.serialized('a',async()=>{const binding=await f.store.load('a');binding.state='revoked';await f.store.save(binding);await f.runtime.revoke(binding);});
 assert.equal(f.runtime.owner,null);assert.equal(f.runtime.credentials.current,null);
});

test('metadata lifetime quarantine prevents central close from reporting safe shutdown',async t=>{
 const f=await metadataFixture(t,{exit:false});await f.runtime.capabilities(f.a);
 await assert.rejects(f.runtime.close(),/lifetime requires reconciliation/);
 f.children[0].emit('exit',0);assert.equal(f.runtime.credentials.quarantined,true);
});

for(const phase of ['started','result-pending','closed-unadopted']) test(`revocation releases a terminated ${phase} owner without inventing adoption`,async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');const other=await f.receive(f.b,'claude/allocate');
 await f.receive(f.a,'claude/open',{nativeId,key:'open-a',model:'claude-sonnet-4-6'});
 let entered,continueLaunch;const launched=new Promise(resolve=>entered=resolve),launch=new Promise(resolve=>continueLaunch=resolve);
 if(phase==='started'){
  f.cloud.execAsync=async briqId=>{entered();await launch;return{exec:{id:'exact-exec',briqId,state:'running'}};};
  f.cloud.execStop=async(briqId,id)=>({exec:{id,briqId,state:'stopped'}});
 }
 await f.receive(f.a,'claude/offer',{nativeId,key:promptKey,text:'preserve the outcome'});
 if(phase==='started')await launched;else await f.delivered;
 if(phase==='closed-unadopted')await f.receive(f.a,'claude/close',{nativeId});
 let stopping;const stopEntered=new Promise(resolve=>stopping=resolve),stop=f.runtime.executor.stop.bind(f.runtime.executor);
 f.runtime.executor.stop=owner=>{stopping();return stop(owner);};
 const revoking=f.store.serialized('a',async()=>{const binding=await f.store.load('a');binding.state='revoked';await f.store.save(binding);await f.runtime.revoke(binding);});
 if(phase==='started'){await stopEntered;continueLaunch();}
 await revoking;
 const record=await f.ledger.loadOperation('a',`turn-${promptKey}`);
 assert.equal(record.state,phase==='started'?'started':'result-pending');assert.equal(record.ownerDisposition,'revoked-terminated');assert.equal(record.adoption,undefined);
 assert.equal(f.runtime.owner,null);assert.equal(f.runtime.credentials.current,null);assert.equal(f.runtime.credentials.quarantined,false);
 await assert.rejects(f.receive(f.a,'claude/adopt',{nativeId,key:promptKey,resultHash:record.resultHash,eventSequence:7}),/revoked/);
 await f.receive(f.b,'claude/open',{nativeId:other.nativeId,key:'open-b',model:'claude-sonnet-4-6'});
 assert.equal(f.runtime.owner.threadId,'b');await f.receive(f.b,'claude/close',{nativeId:other.nativeId});
});
test('revoked unadopted turn keeps its lease quarantined when native disposal is uncertain',async t=>{
 const f=await fixture(t,{dispose:()=>new Promise(()=>{}),closeTimeoutMs:10});const {nativeId}=await f.receive(f.a,'claude/allocate');
 await f.receive(f.a,'claude/open',{nativeId,key:'open',model:'claude-sonnet-4-6'});
 await f.receive(f.a,'claude/offer',{nativeId,key:promptKey,text:'uncertain'});await f.delivered;
 await assert.rejects(f.store.serialized('a',async()=>{const binding=await f.store.load('a');binding.state='revoked';await f.store.save(binding);await f.runtime.revoke(binding);}),/lifetime unknown/);
 assert.notEqual(f.runtime.credentials.current,null);assert.equal(f.runtime.credentials.quarantined,true);
 const record=await f.ledger.loadOperation('a',`turn-${promptKey}`);assert.equal(record.state,'result-pending');assert.equal(record.ownerDisposition,undefined);
});

test('revocation cannot certify a settled metadata probe whose captured process lifetime remains unknown',async t=>{
 const f=await metadataFixture(t,{exit:false});await f.runtime.capabilities(f.a);
 assert.equal(f.runtime.metadataOwner,null);assert.equal(f.runtime.credentials.quarantined,true);
 await assert.rejects(f.runtime.revoke(await f.store.load('a')),/lifetime unknown/);
 f.children[0].emit('exit',0);
 await assert.rejects(f.runtime.revoke(await f.store.load('a')),/lifetime unknown/);
});

test('revocation without a captured owner cannot certify an outstanding persisted native query',async t=>{
 const f=await fixture(t);const {nativeId}=await f.receive(f.a,'claude/allocate');
 await f.ledger.saveOperation('a',{key:'open-lost-owner',method:'claude/open',state:'started',allocationId:'allocation-a',threadId:'a',nativeId});
 await assert.rejects(f.runtime.revoke(await f.store.load('a')),/lifetime unknown/);
 assert.equal(f.runtime.credentials.quarantined,true);assert.equal(f.getLoads(),0);
 assert.equal((await f.ledger.loadOperation('a','open-lost-owner')).state,'started');
});


test('Claude scoped request captures its original open and turn before waiting for allocation admission', async () => {
 const {createScopedClaudeMcpServer}=await import('./claude-runtime.mjs');
 let callback, captured, release;
 const waiting=new Promise(resolve=>{release=resolve;});
 const owner={threadId:'a',allocationId:'allocation-a',nativeId:'native-a',turnId:'turn-a',turnRecord:{state:'started'},openRecord:{key:'open-a'},closed:false};
 const sdk={z:{fromJSONSchema:()=>({strict(){return this;}})},createSdkMcpServer:()=>({instance:{registerTool:(name,options,handler)=>{if(name==='briq_run')callback=handler;}}})};
 createScopedClaudeMcpServer(sdk,owner,{call:async identity=>{captured=identity;await waiting;identity.validate();return{};}});
 const request=callback({recipe:'sandbox'},{requestId:1});
 owner.turnId='turn-b';owner.turnRecord={state:'started'};release();
 const result=await request;assert.equal(result.isError,true);assert.equal(captured.turnId,'turn-a');assert.equal(captured.providerInstanceId,'claudeAgent');assert(Object.isFrozen(captured));
});
