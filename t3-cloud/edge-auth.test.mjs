import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { bridgeOptions, edgeToken } from './edge-auth.mjs';
import { AllocationStore, ThreadAllocator, digest } from './allocations.mjs';
import { createCentralRuntime } from './central-runtime.mjs';
const edge = 'e'.repeat(32), capability = 'a'.repeat(43);
test('shim uses a clean exact bridge URL with two separate headers and no Origin', () => {
 const env={T3_CLOUD_EDGE_TOKEN:edge,T3_CLOUD_BRIDGE_TOKEN:capability,T3_CLOUD_BRIDGE_URL:'wss://central.example/_cloud/bridge'};
 const result=bridgeOptions(env);assert.equal(result.url,env.T3_CLOUD_BRIDGE_URL);
 assert.deepEqual(result.options.headers,{authorization:`Bearer ${capability}`,cookie:`briq_token=${edge}`});
 for(const suffix of ['?token=secret','#secret','/extra']) assert.throws(()=>bridgeOptions({...env,T3_CLOUD_BRIDGE_URL:env.T3_CLOUD_BRIDGE_URL+suffix}));
 for(const bad of [undefined,'short',edge+';other=x',edge+'\r\nX: bad']) assert.throws(()=>edgeToken(bad));
 assert.throws(()=>bridgeOptions({...env,T3_CLOUD_EDGE_TOKEN:capability}));
});
async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'t3-edge-'));const store=new AllocationStore(join(directory,'allocations'));await store.initialize();
 await store.save({state:'ready',threadId:'thread',allocationId:'allocation',bridgeToken:capability,edgeTokenHash:digest(edge),execEnvironmentId:'executor',execUrl:'wss://child.example/_cloud/exec',execToken:'executor-token'});
 const calls=[];const app={events:new EventEmitter(),notify(){},close:async()=>{},request:async(method)=>{calls.push(method);return {};}};
 const env={T3_CLOUD_STATE:directory,T3_CLOUD_EDGE_TOKEN:edge,T3_CLOUD_PUBLIC_ORIGIN:'https://central.example',T3_CLOUD_CHILD_IMAGE:`image@sha256:${'a'.repeat(64)}`};
 const cleanups=[];
 t.after(async()=>{try{for(const close of cleanups)await close();}finally{await rm(directory,{recursive:true,force:true});}});
 return {directory,store,app,calls,env,cleanups,deps:{startAppServer:async()=>app,cloud:{}}};
}
test('real upgrade requires edge cookie plus allocation capability and rejects request smuggling surfaces',async t=>{
 const f=await fixture(t);const runtime=await createCentralRuntime(f.env,f.deps);
 const sockets=new Set(), clients=new Set();
 const server=createServer();server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});server.on('upgrade',runtime.bridgeUpgrade);server.listen(0,'127.0.0.1');await once(server,'listening');
 f.cleanups.push(async()=>{for(const peer of clients)peer.terminate();for(const socket of sockets)socket.destroy();try{await runtime.close();}finally{await new Promise(resolve=>server.close(resolve));}});
 async function attempt(headers,path='/_cloud/bridge') {
  const peer=new WebSocket(`ws://127.0.0.1:${server.address().port}${path}`,{headers});
  clients.add(peer);
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{peer.terminate();reject(Error(`Bridge upgrade did not settle: ${path}`));},2000);
   function finish(value){clearTimeout(timer);peer.terminate();clients.delete(peer);resolve(value);}
   peer.once('error',()=>finish(false));peer.once('open',()=>finish(true));
  });
 }
 const valid={cookie:`briq_token=${edge}`,authorization:`Bearer ${capability}`};
 // A bound listener alone does not establish restored execution readiness.
 assert.equal(runtime.ready(),false);assert.equal(await attempt(valid),false);assert.deepEqual(f.calls,[]);
 await runtime.restore();assert.equal(runtime.ready(),true);assert.deepEqual(f.calls,['environment/add']);
 assert.equal(await attempt(valid),true);
 for(const headers of [{cookie:valid.cookie},{authorization:valid.authorization},{...valid,authorization:`Bearer ${'o'.repeat(43)}`},{...valid,authorization:`Bearer ${edge}`},{...valid,cookie:`briq_token=wrong`},{...valid,cookie:`${valid.cookie}; ${valid.cookie}`},{...valid,origin:'https://central.example'}]) assert.equal(await attempt(headers),false);
 assert.equal(await attempt(valid,'/_cloud/bridge?token=secret'),false);
});
test('rotation or missing allocation fingerprint fails before native startup or cloud reuse; revocation remains available',async t=>{
 const f=await fixture(t);let started=0;
 for(const credential of ['r'.repeat(32),undefined]) await assert.rejects(createCentralRuntime({...f.env,T3_CLOUD_EDGE_TOKEN:credential},{...f.deps,startAppServer:async()=>{started++;return f.app;}}));
 assert.equal(started,0);
 let stopped=0;const allocator=new ThreadAllocator({store:f.store,cloud:{stop:async()=>{stopped++;}},image:f.env.T3_CLOUD_CHILD_IMAGE,bridgeUrl:'wss://central.example/_cloud/bridge',edgeCredential:'r'.repeat(32),registerEnvironment:async()=>{throw Error('must not register');}});
 const binding=await f.store.load('thread');binding.ownerId='owner';await f.store.save(binding);
 await assert.rejects(allocator.allocate('owner','thread'),/reconciliation/);
 delete binding.edgeTokenHash;await f.store.save(binding);
 await assert.rejects(allocator.allocate('owner','thread'),/reconciliation/);
 await allocator.revoke('owner','thread');assert.equal(stopped,1);assert.equal((await f.store.load('thread')).state,'revoked');
});
