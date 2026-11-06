import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllocationStore } from './allocations.mjs';
import { ClaudeRemoteExec } from './claude-exec.mjs';

const result = (state = 'exited', exitCode = 0) => ({ exec: { id: 'exec-a', briqId: 'briq-a', state, exitCode,
  output: { stdout: 'done', stderr: '', stdoutBytes: 4, stderrBytes: 0 } } });
async function fixture(t, overrides = {}) {
 const directory = await mkdtemp(join(tmpdir(), 'claude-exec-')); t.after(() => rm(directory, {recursive:true,force:true}));
 const store = new AllocationStore(join(directory,'bindings')), ledger = new AllocationStore(join(directory,'ledger'));
 await store.initialize();await ledger.initialize();
 const binding = {threadId:'thread-a',allocationId:'allocation-a',briqId:'briq-a',claudeNativeSessionId:'native-a',state:'ready'};
 await store.save(binding);
 const owner = {threadId:'thread-a',allocationId:'allocation-a',briqId:'briq-a',nativeId:'native-a',turnId:'turn-a',closed:false};
 const calls=[];
 const cloud={execAsync:async (...args)=>{calls.push(args);return result();},execStatus:async()=>result(),execStop:async()=>result('stopped',null),...overrides};
 const executor=new ClaudeRemoteExec({store,ledger,cloud});return {store,ledger,binding,owner,cloud,calls,executor};
}
test('persists a command receipt, reuses exact result, and rejects changed payload or destination fields',async t=>{
 const f=await fixture(t);const input={command:'printf done'};
 const first=await f.executor.execute(f.owner,'call-a',input);
 assert.equal(first.stdout,'done');assert.equal(first.truncated,false);
 assert.deepEqual(await f.executor.execute(f.owner,'call-a',input),first);assert.equal(f.calls.length,1);
 await assert.rejects(f.executor.execute(f.owner,'call-a',{command:'changed'}),/conflict/);
 await assert.rejects(f.executor.execute(f.owner,'call-b',{command:'x',briqId:'briq-b'}),/Invalid/);
 assert.equal((await f.ledger.loadOperation('thread-a','call-a')).state,'completed');
});
test('quarantines a lost accepted launch and blocks both retry and a different command after restart',async t=>{
 let launches=0;const f=await fixture(t,{execAsync:async()=>{launches++;throw Error('lost reply');}});
 await assert.rejects(f.executor.execute(f.owner,'call-a',{command:'side effect'}),/quarantined/);
 assert.equal((await f.ledger.loadOperation('thread-a','call-a')).state,'unknown');
 const restarted=new ClaudeRemoteExec({store:f.store,ledger:f.ledger,cloud:f.cloud});
 await assert.rejects(restarted.execute(f.owner,'call-a',{command:'side effect'}),/no launch replay/);
 await assert.rejects(restarted.execute(f.owner,'call-b',{command:'another'}),/reconciliation/);assert.equal(launches,1);
});
test('preserves nonzero exit, stderr and explicit tail truncation',async t=>{
 const r=result('exited',7);r.exec.output={stdout:'tail',stderr:'failure',stdoutBytes:100000,stderrBytes:7};
 const f=await fixture(t,{execAsync:async()=>r});
 assert.deepEqual(await f.executor.execute(f.owner,'call-a',{command:'false'}),{state:'exited',exitCode:7,stdout:'tail',stderr:'failure',truncated:true});
});
test('revocation and wrong returned briq identity cannot yield a successful tool result',async t=>{
 const f=await fixture(t,{execAsync:async()=>({...result(),exec:{...result().exec,briqId:'briq-b'}})});
 await assert.rejects(f.executor.execute(f.owner,'call-a',{command:'x'}),/quarantined/);
 f.binding.state='revoked';await f.store.save(f.binding);
 await assert.rejects(f.executor.execute(f.owner,'call-b',{command:'x'}),/revoked/);
});
test('cancellation waits for a late handle and confirms exact remote stop; no second launch',async t=>{
 let launch,started;const began=new Promise(r=>started=r);let stops=0;
 const f=await fixture(t,{execAsync:()=>{started();return new Promise(r=>launch=r);},execStop:async(id,handle)=>{assert.equal(id,'briq-a');assert.equal(handle,'exec-a');stops++;return result('stopped',null);}});
 const running=f.executor.execute(f.owner,'call-a',{command:'long'});await began;
 const stopping=f.executor.stop(f.owner);launch(result('running',null));
 await assert.rejects(running,/quarantined/);await stopping;assert.equal(stops,1);
});
test('cancellation with a lost launch handle cannot report terminal process proof',async t=>{
 let launch,started;const began=new Promise(r=>started=r);
 const f=await fixture(t,{execAsync:()=>{started();return new Promise((_,r)=>launch=r);}});
 const running=f.executor.execute(f.owner,'call-a',{command:'long'});await began;
 const stopping=f.executor.stop(f.owner);launch(Error('lost response'));
 await assert.rejects(running,/quarantined/);await assert.rejects(stopping,/handle unknown/);
});
test('status transport failure stops the retained handle and late close still has terminal proof',async t=>{
 let stops=0;const f=await fixture(t,{execAsync:async()=>result('running',null),execStatus:async()=>{throw Error('transport');},execStop:async()=>{stops++;return result('stopped',null);}});
 await assert.rejects(f.executor.execute(f.owner,'call-a',{command:'long'}),/quarantined/);
 assert.equal(stops,1);assert.equal((await f.ledger.loadOperation('thread-a','call-a')).terminalConfirmed,true);
 await f.executor.stop(f.owner);assert.equal(stops,1);
});
test('a failed stop remains durable after active bookkeeping is released',async t=>{
 const f=await fixture(t,{execAsync:async()=>result('running',null),execStatus:async()=>{throw Error('transport');},execStop:async()=>{throw Error('stop lost');}});
 await assert.rejects(f.executor.execute(f.owner,'call-a',{command:'long'}),/quarantined/);
 await assert.rejects(f.executor.stop(f.owner),/stop lost/);
});
test('a cached receipt is not delivered after revocation while loading its durable record',async t=>{
 const f=await fixture(t);const input={command:'printf done'};await f.executor.execute(f.owner,'call-a',input);
 const load=f.ledger.loadOperation.bind(f.ledger);
 f.ledger.loadOperation=async(...args)=>{const value=await load(...args);f.binding.state='revoked';await f.store.save(f.binding);return value;};
 await assert.rejects(f.executor.execute(f.owner,'call-a',input),/revoked/);assert.equal(f.calls.length,1);
});
