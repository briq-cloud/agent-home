import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cloudProxy, createNativeTransportFence } from './cloud-proxy.mjs';

class Resource extends EventEmitter {
  destroyed = false; writes = []; pipes = [];
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
  setTimeout() {}
  write(value) { this.writes.push(value); }
  end() {}
  pipe(value) { this.pipes.push(value); return value; }
}
const origin = 'https://native.example';
const req = socket => Object.assign(new Resource(), { socket, method: 'GET', url: '/ws?wsTicket=fixture', headers: {host:'native.example'} });
test('revocation fence destroys both peers and pending requests, rejects callbacks from the old generation, and allows fresh transports',()=>{
 const fence=createNativeTransportFence(), client=new Resource(), connecting=new Resource(), pending=new Resource();
 fence.track(client);
 const proxy=cloudProxy({target:'http://127.0.0.1:3773',publicOrigin:origin,ownerBearer:()=>false,nativeOnly:true,transportFence:fence,requestUpstream:()=>pending});
 proxy.upgrade(req(client),client,Buffer.alloc(0));pending.emit('socket',connecting);
 const waitingClient=new Resource(), waitingPending=new Resource();fence.track(waitingClient);
 const waitingProxy=cloudProxy({target:'http://127.0.0.1:3773',publicOrigin:origin,ownerBearer:()=>false,nativeOnly:true,transportFence:fence,requestUpstream:()=>waitingPending});
 waitingProxy.upgrade(req(waitingClient),waitingClient,Buffer.alloc(0));
 const old=fence.generationFor(client);fence.invalidate();
 assert.equal(waitingClient.destroyed,true);assert.equal(waitingPending.destroyed,true);
 assert.equal(client.destroyed,true);assert.equal(connecting.destroyed,true);assert.equal(pending.destroyed,true);
 const late=new Resource();pending.emit('upgrade',{statusCode:101,statusMessage:'Switching Protocols',headers:{}},late,Buffer.alloc(0));
 assert.equal(late.destroyed,true);assert.equal(client.writes.length,0);assert.equal(late.pipes.length,0);
 const delayedSocket=new Resource();waitingPending.emit('socket',delayedSocket);assert.equal(delayedSocket.destroyed,true);
 const fresh=new Resource();fence.track(fresh);assert.equal(fence.current(fence.generationFor(fresh)),true);assert.equal(fence.current(old),false);
 const next=new Resource(), upstream=new Resource();
 const nextProxy=cloudProxy({target:'http://127.0.0.1:3773',publicOrigin:origin,ownerBearer:()=>false,nativeOnly:true,transportFence:fence,requestUpstream:()=>next});
 nextProxy.upgrade(req(fresh),fresh,Buffer.alloc(0));next.emit('upgrade',{statusCode:101,statusMessage:'Switching Protocols',headers:{}},upstream,Buffer.alloc(0));
 assert.equal(fresh.destroyed,false);assert.equal(upstream.destroyed,false);assert.match(fresh.writes[0],/101/);
 fence.invalidate();assert.equal(fresh.destroyed,true);assert.equal(upstream.destroyed,true);
});
test('an HTTP response callback and buffered request cannot attach after their arrival generation is fenced',()=>{
 const fence=createNativeTransportFence(), client=new Resource(), pending=new Resource();let reply, requests=0;
 fence.track(client);const generation=fence.generationFor(client);
 const proxy=cloudProxy({target:'http://127.0.0.1:3773',publicOrigin:origin,ownerBearer:()=>false,nativeOnly:true,transportFence:fence,requestUpstream:(_,callback)=>{requests++;reply=callback;return pending;}});
 const response=new Resource();response.writeHead=()=>{throw Error('Stale response must not be forwarded');};
 proxy.http(req(client),response,Buffer.from('{}'),generation);fence.invalidate();
 const upstreamReply=new Resource();reply(upstreamReply);assert.equal(upstreamReply.destroyed,true);assert.equal(requests,1);
 proxy.http(req(client),response,Buffer.from('{}'),generation);assert.equal(requests,1);
});
