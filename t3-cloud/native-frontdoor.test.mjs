import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import { createNativeFrontdoor, nativeRequestAllowed, nativeOrigin } from './native-frontdoor.mjs';

const origin = 'https://native.example';
const allowed = [
 ['GET','/.well-known/t3/environment'], ['POST','/oauth/token'], ['GET','/api/auth/session'],
 ['POST','/api/auth/websocket-ticket'], ['POST','/api/auth/websocket-ticket/rpc'], ['POST','/api/auth/clients/revoke'],
 ['GET','/api/orchestration/threads/bounded'], ['GET','/api/orchestration/threads/history'],
 ['GET','/api/projects'], ['GET','/api/orchestration/shell?omitIdleSubagents=true&omitOlderSettled=false'],
 ['GET','/api/orchestration/threads/thread%3Aone'], ['GET','/api/orchestration/threads/thread%3Aone/transcript'],
 ['GET','/api/orchestration/threads/thread%3Aone/bounded?deferWork=true&compactTurnItems=true&dedupeBodies=false&compactIds=true'],
 ['GET','/api/orchestration/threads/thread%3Aone/history?cursor=opaque%2B%2F%3D&throughEntryId=one&view=compact&deferWork=false&compactIds=true'],
 ['GET','/api/assets/signed-token/image%20%E2%98%83.png'], ['POST','/api/attachments/upload/signed-token'],
];
const denied = ['/', '/pair', '/_cloud', '/_cloud/terminal/', '/_cloud/exec', '/_cloud/bridge', '/_cloud/briq/mcp',
 '/mcp', '/oauth/mcp/token', '/api/auth/browser-session', '/api/auth/pairing-token', '/api/auth/pairing-links/revoke',
 '/api/auth/clients/revoke-others', '/api/auth/websocket-ticket/terminal', '/api/filesystem', '/ws', '/api/projects/',
 '/api/Projects', '/api//projects', '/api/../api/projects', '/api/%2e%2e/projects', '/api/projects%2f',
 '/api/projects\\foo', '/api/projects#foo', '/api/projects?bad=one', '/api/projects?briq_token=secret',
 '/api/orchestration/threads/bounded?deferWork=true', '/api/orchestration/threads/history?cursor=foo',
 '/api/orchestration/threads/a/transcript/extra', '/api/orchestration/threads/a%2fb', '/api/orchestration/threads/%5cfoo',
 '/api/orchestration/threads/%00foo', '/api/orchestration/threads/%', '/api/orchestration/threads/%zz',
 '/api/orchestration/threads/%FF', '/api/orchestration/threads/a/history?cursor=a&cursor=b',
 '//native.example/api/projects', 'https://native.example/api/projects', '/api/assets/token/file/extra',
 '/api/attachments/upload/token/extra', '/api/orchestration/threads/a?unexpected=1'];
const req = (method,url,headers={}) => ({method,url,headers:{host:'native.example',...headers}});
async function fixture(t) {
 const seen=[], upgrades=[];
 const upstream=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{seen.push({url:req.url,headers:req.headers,body});res.writeHead(200,{'set-cookie':['native=forged'],'content-type':'application/json'});res.end('{}');});});
 upstream.on('upgrade',(req,socket)=>{upgrades.push({url:req.url,headers:req.headers});if(req.url==='/ws?wsTicket=denied')return socket.end('HTTP/1.1 401 Unauthorized\r\nSet-Cookie: native=forged\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: native=forged\r\n\r\n');});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 let ready=true;
 const server=createNativeFrontdoor({publicOrigin:origin,primaryOrigin:'https://private.example',target:`http://127.0.0.1:${upstream.address().port}`,ready:()=>ready,ownerBearer:req=>req.headers.authorization==='Bearer owner'});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.closeAllConnections();server.close();upstream.closeAllConnections();upstream.close();});
 const send=(method,path,headers={},body='')=>new Promise((resolve,reject)=>{const pending=request({hostname:'127.0.0.1',port:server.address().port,method,path,headers:{host:'native.example',...headers}},res=>{res.resume();res.once('end',()=>resolve({status:res.statusCode,headers:res.headers}));});pending.on('error',reject);pending.end(body);});
 const upgrade=(path,headers='')=>new Promise((resolve,reject)=>{const socket=connect(server.address().port,'127.0.0.1');let text='';socket.on('error',reject);socket.on('data',chunk=>{text+=chunk;if(text.includes('\r\n\r\n')){socket.destroy();resolve(text);}});socket.once('connect',()=>socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:19191\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${headers}\r\n`));});
 return {seen,upgrades,send,upgrade,server,unready:()=>ready=false};
}
test('native admission matches exact routes and canonical request targets',()=>{
 for(const [method,url] of allowed) assert.equal(nativeRequestAllowed(req(method,url),origin),true,url);
 for(const url of denied) for(const method of ['GET','POST','OPTIONS','HEAD','DELETE']) assert.equal(nativeRequestAllowed(req(method,url),origin),false,`${method} ${url}`);
 for(const [method,url] of allowed) for(const wrong of ['OPTIONS','HEAD','DELETE',method==='GET'?'POST':'GET']) assert.equal(nativeRequestAllowed(req(wrong,url),origin),false,`${wrong} ${url}`);
 for(const foreign of ['null','https://evil.example','https://native.example/']) assert.equal(nativeRequestAllowed(req('GET','/api/projects',{origin:foreign}),origin),false);
 assert.equal(nativeRequestAllowed(req('GET','/api/projects',{host:'evil.example'}),origin),false);
 for(const bad of ['https://private.example','http://native.example','https://native.example/path','https://native.example/','https://user@native.example']) assert.throws(()=>nativeOrigin(bad,'https://private.example'));
});
test('secondary forwards admitted bytes and native proofs, strips credentials and response cookies',async t=>{
 const f=await fixture(t);
 for(const [method,path] of allowed){const result=await f.send(method,path,{authorization:'DPoP native',dpop:'native-proof',cookie:'native=secret; briq_token=edge; t3_cloud_owner=owner','x-forwarded-proto':'http','x-forwarded-host':'evil.example',forwarded:'host=evil.example','x-owner-key':'secret','content-type':'application/json'},method==='POST'?'{}':'');assert.equal(result.status,200);assert.equal(result.headers['set-cookie'],undefined);assert.equal(result.headers['cache-control'],'no-store');assert.equal(f.seen.at(-1).url,path);}
 for(const {headers} of f.seen){assert.equal(headers.host,'native.example');assert.equal(headers.authorization,'DPoP native');assert.equal(headers.dpop,'native-proof');assert.equal(headers['x-forwarded-proto'],'https');for(const key of ['cookie','forwarded','x-forwarded-host','x-owner-key'])assert.equal(headers[key],undefined);}
 await f.send('GET','/api/auth/session',{authorization:'Bearer owner'});assert.equal(f.seen.at(-1).headers.authorization,undefined);
 const before=f.seen.length;
 for(const path of denied)assert.equal((await f.send('GET',path)).status,404,path);
 assert.equal((await f.send('GET','/api/projects',{host:'evil.example'})).status,404);
 assert.equal((await f.send('GET','/api/projects',{origin:'null'})).status,404);
 assert.equal((await f.send('POST','/oauth/token',{},'x'.repeat(16385))).status,413);
 assert.equal(f.seen.length,before);
 f.unready();assert.equal((await f.send('GET','/api/projects')).status,503);assert.equal(f.seen.length,before);
});
test('only RPC websocket upgrade reaches fixed native authority through actual edge Host rewrite',async t=>{
 const f=await fixture(t);
 for(const [,path] of allowed)assert.match(await f.upgrade(path),/404/);
 assert.equal(f.upgrades.length,0);
 const path='/ws?wsTicket=opaque&dpop=proof&orchestrationProtocol=v2&clientSurface=mobile&clientOwner=owner';
 const result=await f.upgrade(path,'Authorization: Bearer native\r\nCookie: briq_token=edge; native=secret\r\nX-Forwarded-Host: evil.example\r\nX-Forwarded-Proto: http\r\n');
 assert.match(result,/101/);assert.doesNotMatch(result,/set-cookie/i);assert.equal(f.upgrades.length,1);assert.equal(f.upgrades[0].url,path);assert.equal(f.upgrades[0].headers.host,'native.example');assert.equal(f.upgrades[0].headers['x-forwarded-proto'],'https');assert.equal(f.upgrades[0].headers.cookie,undefined);
 for(const denied of ['/ws?wsTicket=a&wsTicket=b','/ws?briq_token=secret','/ws?unknown=secret','/ws/','/_cloud/bridge'])assert.match(await f.upgrade(denied),/404/);
 assert.equal(f.upgrades.length,1);
});


test('native websocket authentication rejection keeps native status and strips all native cookies',async t=>{
 const f=await fixture(t);
 const result=await f.upgrade('/ws?wsTicket=denied');
 assert.match(result,/^HTTP\/1.1 401 Unauthorized/);assert.match(result,/Cache-Control: no-store/i);assert.match(result,/Content-Length: 0/i);assert.doesNotMatch(result,/set-cookie/i);assert.equal(f.upgrades.length,1);
 assert.equal(nativeRequestAllowed({...req('GET','/ws'),rawHeaders:['Host','native.example','Host','native.example']},origin,true),false);
 for(const host of ['[', 'native.example:bad', 'native..example', '[::1]:99999'])assert.equal(nativeRequestAllowed(req('GET','/ws',{host}),origin,true),false);
});


test('native thread reads preserve the official protocol header and leave version validation to native',async t=>{
 const seen=[];
 const upstream=createServer((req,res)=>{seen.push({url:req.url,protocol:req.headers['x-t3-orchestration-protocol']});res.writeHead(req.headers['x-t3-orchestration-protocol']==='2'?200:400);res.end();});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const server=createNativeFrontdoor({publicOrigin:origin,primaryOrigin:'https://private.example',target:`http://127.0.0.1:${upstream.address().port}`});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.closeAllConnections();server.close();upstream.closeAllConnections();upstream.close();});
 const send=(path,protocol)=>new Promise((resolve,reject)=>{const headers={host:'native.example',authorization:'Bearer native'};if(protocol!==undefined)headers['x-t3-orchestration-protocol']=protocol;const pending=request({hostname:'127.0.0.1',port:server.address().port,path,headers},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});pending.on('error',reject);pending.end();});
 // The native OrchestrationProtocolHeaders contract requires this literal on these reads.
 for(const path of ['/api/orchestration/shell','/api/orchestration/threads/thread','/api/orchestration/threads/thread/transcript','/api/orchestration/threads/thread/bounded?compactIds=true','/api/orchestration/threads/thread/history?cursor=opaque%2Bcursor']){
  for(const protocol of ['2',undefined,'3']){assert.equal(await send(path,protocol),protocol==='2'?200:400);assert.equal(seen.at(-1).url,path);assert.equal(seen.at(-1).protocol,protocol);}
 }
});

test('all bytes after the first question mark participate in query policy',()=>{
 for(const url of ['/ws?wsTicket=a?junk&briq_token=x','/ws?wsTicket=a?junk&wsTicket=b'])assert.equal(nativeRequestAllowed(req('GET',url),origin,true),false);
 for(const url of ['/api/orchestration/threads/thread/history?cursor=a?junk&unknown=x','/api/orchestration/threads/thread/history?cursor=a?junk&cursor=b'])assert.equal(nativeRequestAllowed(req('GET',url),origin),false);
 assert.equal(nativeRequestAllowed(req('GET','/api/orchestration/threads/thread/history?cursor=a?opaque&view=compact'),origin),true);
});


test('fencing a public request while its auth body is incomplete cannot create an upstream request later',async t=>{
 const f=await fixture(t), accepted=once(f.server,'request');
 const socket=connect(f.server.address().port,'127.0.0.1');t.after(()=>socket.destroy());await once(socket,'connect');
 socket.write('POST /oauth/token HTTP/1.1\r\nHost: native.example\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{');
 await accepted;const closed=once(socket,'close');f.server.invalidateConnections();await closed;
 assert.equal(f.seen.length,0);
 assert.equal((await f.send('GET','/api/projects')).status,200);assert.equal(f.seen.length,1);
});
