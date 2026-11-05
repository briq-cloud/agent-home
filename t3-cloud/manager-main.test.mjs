import test from 'node:test';
import assert from 'node:assert/strict';
import { startManager } from './manager-main.mjs';
test('product startup validates owner configuration before starting any broker or native process',async()=>{
 let started=false;const deps={centralRuntime:async()=>{started=true;throw Error('unexpected runtime');},spawnProcess:()=>{started=true;throw Error('unexpected spawn');}};
 await assert.rejects(startManager({T3_CLOUD_PUBLIC_ORIGIN:'https://cloud.example'},deps),/owner key/);
 await assert.rejects(startManager({T3_CLOUD_PUBLIC_ORIGIN:'https://cloud.example',T3_CLOUD_OWNER_KEY:'random-owner-key-with-at-least-32-bytes'},deps),/owner identity/);
 await assert.rejects(startManager({T3_CLOUD_PUBLIC_ORIGIN:'https://cloud.example/path',T3_CLOUD_OWNER_KEY:'random-owner-key-with-at-least-32-bytes'},deps),/origin/);
 assert.equal(started,false);
});
test('failure composing the manager closes the already started central runtime',async()=>{
 let closed=0,spawned=0;
 await assert.rejects(startManager({T3_CLOUD_PUBLIC_ORIGIN:'https://cloud.example',T3_CLOUD_OWNER_KEY:'owner-key-test-only-at-least-32-bytes',T3_CLOUD_EDGE_TOKEN:'e'.repeat(32),T3_CLOUD_OWNER_ID:'owner'}, {
  centralRuntime:async()=>({close:async()=>{closed++;}}),spawnProcess:()=>{spawned++;throw Error('unexpected spawn');},
 }),/runtime/);
 assert.equal(closed,1);assert.equal(spawned,0);
});
test('central native and terminal processes never inherit the edge credential',async t=>{
 const {createServer}=await import('node:net');const {once,EventEmitter}=await import('node:events');
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const calls=[];
 const runtime=await startManager({PORT:String(port),T3_HOST:'127.0.0.1',T3_CLOUD_PUBLIC_ORIGIN:'https://cloud.example',T3_CLOUD_OWNER_KEY:'owner-key-test-only-at-least-32-bytes',T3_CLOUD_OWNER_ID:'owner',T3_CLOUD_EDGE_TOKEN:'e'.repeat(32),BRIQ_MCP_TOKEN:'fake-central-marker',briq_mcp_token:'fake-case-marker'}, {
  centralRuntime:async env=>{assert.equal(env.BRIQ_MCP_TOKEN,'fake-central-marker');return {allocator:{allocate(){}},broker:{ownerRequest(){}},close:async()=>{}};},
  spawnProcess:(command,args,options)=>{calls.push({command,options});const child=new EventEmitter();child.kill=()=>{};return child;},
 });t.after(()=>runtime.close());
 assert.equal(calls.length,2);for(const {options} of calls){assert.equal(options.env.T3_CLOUD_EDGE_TOKEN,undefined);assert.equal(options.env.BRIQ_MCP_TOKEN,undefined);assert.equal(options.env.briq_mcp_token,undefined);}
});

 test('loopback MCP is listening during restore while public runtime and native launches wait',async t=>{
  const {createServer}=await import('node:net');const {once,EventEmitter}=await import('node:events');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const calls=[];let restored=false,mcpCalls=0;
  const runtime=await startManager({PORT:String(port),T3_HOST:'127.0.0.1',T3_CLOUD_PUBLIC_ORIGIN:'https://cloud.example',T3_CLOUD_OWNER_KEY:'owner-key-test-only-at-least-32-bytes',T3_CLOUD_OWNER_ID:'owner',T3_CLOUD_EDGE_TOKEN:'e'.repeat(32)},{
   centralRuntime:async()=>({allocator:{allocate(){}},broker:{ownerRequest(){}},ready:()=>restored,close:async()=>{},
    briqMcpRequest:(req,res)=>{mcpCalls++;res.writeHead(200);res.end('{}');},
    restore:async()=>{
     assert.equal(calls.length,0);
     const publicResponse=await fetch(`http://127.0.0.1:${port}/_cloud/capabilities`);assert.equal(publicResponse.status,503);await publicResponse.text();
     const mcpResponse=await fetch(`http://127.0.0.1:${port}/_cloud/briq/mcp`,{method:'POST'});assert.equal(mcpResponse.status,200);await mcpResponse.text();
     assert.equal(mcpCalls,1);restored=true;
    }}),
   spawnProcess:()=>{calls.push('spawn');const child=new EventEmitter();child.kill=()=>{};return child;},
  });t.after(()=>runtime.close());
  assert.equal(restored,true);assert.equal(calls.length,2);
  const readyResponse=await fetch(`http://127.0.0.1:${port}/_cloud/capabilities`);assert.equal(readyResponse.status,200);await readyResponse.text();
 });
 test('failed native restoration closes the listening manager and central runtime before native launch',async()=>{
  const {createServer}=await import('node:net');const {once}=await import('node:events');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  let closed=0,spawned=0;
  await assert.rejects(startManager({PORT:String(port),T3_HOST:'127.0.0.1',T3_CLOUD_PUBLIC_ORIGIN:'https://cloud.example',T3_CLOUD_OWNER_KEY:'owner-key-test-only-at-least-32-bytes',T3_CLOUD_OWNER_ID:'owner',T3_CLOUD_EDGE_TOKEN:'e'.repeat(32)},{
   centralRuntime:async()=>({allocator:{allocate(){}},broker:{ownerRequest(){}},ready:()=>false,close:async()=>{closed++;},restore:async()=>{throw Error('restore failed');}}),
   spawnProcess:()=>{spawned++;throw Error('unexpected launch');},
  }),/restore failed/);
  assert.equal(closed,1);assert.equal(spawned,0);
  const replacement=createServer();replacement.listen(port,'127.0.0.1');await once(replacement,'listening');await new Promise(resolve=>replacement.close(resolve));
 });
