import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createCloudManager } from './manager.mjs';

const key = 'owner-key-for-test-only-1234567890123456';
const allocationKey = 'allocation-key-test-only-1234567890123456';
const origin = 'https://cloud.example';
const connections = { status: async () => ({claude: { authenticated: false }, briq: { authenticated: null }}), pair: async () => ({pairUrl: 'https://cloud.example/pair#token=short-lived'}) };
async function fixture(t, revocationIssues) {
  const seen = [];
  const upstream = createServer((req,res) => { seen.push(req.headers); res.setHeader('set-cookie',['native=ok','t3_cloud_owner=forged','briq_token=forged']); res.end(req.url); });
  upstream.on('upgrade', (req,socket,head) => { seen.push(req.headers); socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); if(head.length)socket.write(head); socket.pipe(socket); });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const allocations = [], rpc=[];
  const manager = createCloudManager({role:'central',publicOrigin:origin,ownerKey:key,ownerId:'owner-1',allocatorToken:allocationKey,connections,
    allocator:{revocationIssues, async allocate(owner,thread){allocations.push([owner,thread]); return {threadId:thread,connection:{url:'https://child.example',credential:'one-time'}};}},
    broker:{async ownerRequest(method,params){rpc.push([method,params]); return method==='account/login/start'?{type:'chatgptDeviceCode',loginId:'native-login',userCode:'TEST-CODE',verificationUrl:'https://auth.example/device',accessToken:'never-export'}:{account:null};}},
    t3Target:`http://127.0.0.1:${upstream.address().port}`,terminalTarget:`http://127.0.0.1:${upstream.address().port}`});
  manager.listen(0,'127.0.0.1');await once(manager,'listening');
  t.after(()=>{manager.closeAllConnections();manager.close();upstream.closeAllConnections();upstream.close();});
  function send(path,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:manager.address().port,path,method,headers},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});}
  const post=(path,body={},headers={})=>send(path,{method:'POST',body,headers:{origin,'content-type':'application/json',...headers}});
  return {seen,allocations,rpc,manager,send,post};
}
test('owner bootstrap creates secure opaque cookie; rejects cross-origin mutations',async t=>{
 const f=await fixture(t);let r=await f.send('/_cloud/');assert.equal(r.status,200);assert(!r.text.includes(key));assert.match(r.headers['content-security-policy'],/nonce-/);
 r=await f.post('/_cloud/login',{key},{origin:'https://evil.example'});assert.equal(r.status,403);
 r=await f.post('/_cloud/login',{key});assert.equal(r.status,200);const cookie=r.headers['set-cookie'][0];assert.match(cookie,/HttpOnly; SameSite=Strict/);assert.match(cookie,/Secure/);assert(!cookie.includes(key));
 r=await f.send('/_cloud/connections',{headers:{cookie}});assert.equal(r.status,200);assert.deepEqual(f.rpc,[['account/read',{refreshToken:false}]]);
 r=await f.post('/_cloud/logout',{}, {cookie});assert.equal(r.status,200);r=await f.send('/_cloud/connections',{headers:{cookie}});assert.equal(r.status,401);
});
test('allocation-only capability cannot access owner APIs or change owner binding',async t=>{
 const f=await fixture(t);const authorization=`Bearer ${allocationKey}`;
 let r=await f.post('/_cloud/threads',{threadId:'thread-1'},{authorization,origin:''});assert.equal(r.status,200);assert.deepEqual(f.allocations,[['owner-1','thread-1']]);
 r=await f.post('/_cloud/threads',{threadId:'thread-2',ownerId:'other'},{authorization});assert.equal(r.status,400);
 r=await f.send('/_cloud/connections',{headers:{authorization}});assert.equal(r.status,401);
 r=await f.post('/_cloud/threads',{threadId:'thread-3'},{authorization:'Bearer wrong'});assert.equal(r.status,401);
});
test('native proxy preserves native credentials/path but removes owner credentials and forwarded origin',async t=>{
 const f=await fixture(t);let r=await f.send('/api/native?x=1',{headers:{authorization:`Bearer ${key}`,cookie:'native=yes; briq_token=edge; t3_cloud_owner=secret',host:'evil.example','x-forwarded-host':'evil.example'}});
 assert.equal(r.text,'/api/native?x=1');assert.equal(f.seen[0].authorization,undefined);assert.equal(f.seen[0].cookie,'native=yes');assert.equal(f.seen[0].host,'cloud.example');assert.equal(f.seen[0]['x-forwarded-host'],undefined);assert.deepEqual(r.headers['set-cookie'],['native=ok']);
 await f.send('/api/native',{headers:{authorization:'Bearer native-token'}});assert.equal(f.seen[1].authorization,'Bearer native-token');
});
test('terminal requires owner authentication and native WS proxies handshake plus frames',async t=>{
 const f=await fixture(t);assert.equal((await f.send('/_cloud/terminal/')).status,401);
 const socket=connect(f.manager.address().port,'127.0.0.1');t.after(()=>socket.destroy());await once(socket,'connect');
 socket.write('GET /native-ws HTTP/1.1\r\nHost: evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer native-token\r\nCookie: native=yes; briq_token=edge; t3_cloud_owner=secret\r\n\r\n');
 let data='';await new Promise((resolve,reject)=>{socket.on('error',reject);socket.on('data',chunk=>{data+=chunk;if(data.includes('\r\n\r\n'))resolve();});});assert.match(data,/101 Switching/);
 await new Promise(resolve=>setTimeout(resolve,10100)); assert.equal(socket.destroyed,false);
 const payload=Buffer.from([0x81,0x02,0x68,0x69]);const result=once(socket,'data');socket.write(payload);assert.deepEqual((await result)[0],payload);assert.equal(f.seen[0].authorization,'Bearer native-token');assert.equal(f.seen[0].cookie,'native=yes');
});

test('Codex owner login uses one native device-code flow and projects only device metadata',async t=>{
 const f=await fixture(t);
 const r=await f.post('/_cloud/codex/login',{}, {authorization:`Bearer ${key}`});
 assert.equal(r.status,200);
 assert.deepEqual(f.rpc,[['account/login/start',{type:'chatgptDeviceCode'}]]);
 assert.deepEqual(JSON.parse(r.text),{type:'chatgptDeviceCode',loginId:'native-login',verificationUrl:'https://auth.example/device',userCode:'TEST-CODE'});
 assert.equal(r.text.includes('never-export'),false);
});

test('gateway cookie alone cannot authorize owner management',async t=>{
 const f=await fixture(t);assert.equal((await f.send('/_cloud/connections',{headers:{cookie:'briq_token=edge'}})).status,401);
});


test('owner connection status exposes only safe revoked allocation recovery fields',async t=>{
 let reads=0;
 const f=await fixture(t,async()=>{reads++;return [{threadId:'thread-revoked',allocationId:'allocation-revoked',state:'unknown',secret:'never-export',rawError:'never-export'}];});
 assert.equal((await f.send('/_cloud/connections')).status,401);assert.equal(reads,0);
 const result=await f.send('/_cloud/connections',{headers:{authorization:`Bearer ${key}`}});
 assert.equal(result.status,200);assert.equal(reads,1);
 assert.deepEqual(JSON.parse(result.text).revocations,[{threadId:'thread-revoked',allocationId:'allocation-revoked',state:'reconciliation-required'}]);
 assert.equal(result.text.includes('never-export'),false);
});
