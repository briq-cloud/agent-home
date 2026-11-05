import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AllocationStore} from './allocations.mjs';
import {ClaudeRuntime,CLAUDE_CLOUD_ENABLED} from './claude-runtime.mjs';

const promptKey='11111111-1111-4111-8111-111111111111';
async function fixture(t,{enabled=true,dispose=async()=>{},closeTimeoutMs=10000,sendResult=true}={}) {
 const directory=await mkdtemp(join(tmpdir(),'claude-runtime-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=new AllocationStore(join(directory,'bindings')),ledger=new AllocationStore(join(directory,'ledger'));
 await store.initialize();await ledger.initialize();
 for(const threadId of ['a','b'])await store.save({threadId,allocationId:`allocation-${threadId}`,briqId:`briq-${threadId}`,state:'ready'});
 const events=[];let resolveResult;const delivered=new Promise(r=>resolveResult=r);let options,handler,loads=0,launches=0;
 const sdk={binary:'/pinned/claude',z:{string:()=>({optional(){return this;}}),number:()=>({optional(){return this;}})},
  tool:(name,description,schema,fn)=>{handler=fn;return{name};},createSdkMcpServer:input=>input,
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
 const runtime=new ClaudeRuntime({store,ledger,cloud,directory:join(directory,'claude'),enabled,closeTimeoutMs,loadSdk:async()=>{loads++;return sdk;}});
 const session=threadId=>({threadId,allocationId:`allocation-${threadId}`,closed:false,send:async message=>{events.push(message);if(message.params?.event.type==='result'){resolveResult();if(!sendResult)throw Error('lost transport');}},close(){this.closed=true;}});
 const a=session('a'),b=session('b');const receive=(session,method,params={})=>runtime.receive(session,{id:1,method,params});
 return{store,ledger,runtime,a,b,receive,events,delivered,getOptions:()=>options,getLoads:()=>loads,getLaunches:()=>launches};
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
