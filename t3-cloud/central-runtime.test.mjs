import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createCentralRuntime } from './central-runtime.mjs';
import { AllocationStore } from './allocations.mjs';

async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'t3-central-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const env={T3_CLOUD_STATE:directory,T3_CLOUD_CHILD_IMAGE:`image@sha256:${'a'.repeat(64)}`,T3_CLOUD_PUBLIC_ORIGIN:'https://central.example'};
 const calls=[];let closed=0;
 const app={events:new EventEmitter(),notify:()=>{},close:async()=>{closed++;},request:async(method,params)=>{calls.push({method,params});return {thread:{id:'native',environments:[{environmentId:'exec',cwd:'/work'}],turns:[]}};}};
 return {directory,env,app,calls,closed:()=>closed,deps:{startAppServer:async()=>app,cloud:{}}};
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
test('restart restores remote registration then verifies sticky native thread before serving',async t=>{
 const f=await fixture(t);const store=new AllocationStore(join(f.directory,'allocations'));await store.initialize();
 await store.save({state:'ready',threadId:'t3',allocationId:'allocation',nativeThreadId:'native',execEnvironmentId:'exec',execUrl:'wss://child.example/_cloud/exec',execToken:'capability'});
 const runtime=await createCentralRuntime(f.env,f.deps);t.after(()=>runtime.close());
 assert.deepEqual(f.calls.map(value=>value.method),['environment/add','thread/resume']);
 assert.equal(f.calls[0].params.authBearerToken,'capability');
});
