import test from 'node:test';
import assert from 'node:assert/strict';
import { BriqCloud, BriqCredentialOwner } from './briq-cloud.mjs';
const binding={briqId:'root',rootStackId:'stack',stack:'workspace',allocationId:'allocation',threadId:'thread',providerInstanceId:'codex',t3Url:'https://child.example'};
function fixture({state='running',badIdentity=false,execRefused=false,metadata={}}={}){
 const calls=[],owner=new BriqCredentialOwner();let sequence=0;
 const cloud=new BriqCloud({directory:'/unused',env:{},credentialOwner:owner,run:async args=>{
  calls.push(args);
  if(args[0]==='list')return{briqs:[{id:badIdentity?'other':'root',stackId:'stack',name:'sandbox',env:{T3_CLOUD_BINDING_ID:'allocation',T3_CLOUD_THREAD_ID:'thread',T3_CLOUD_PROVIDER_INSTANCE_ID:'codex'}}]};
  if(args[0]==='status')return{briq:{id:'root',name:'sandbox',state}};
  assert.equal(args[0],'exec');if(execRefused)return{exitCode:1,stdout:'{}'};const code='fresh-'+(++sequence);return{exitCode:0,stdout:JSON.stringify({credential:code,pairUrl:'https://child.example/pair#token='+code,expiresAt:new Date(Date.now()+290000).toISOString(),...metadata})};
 }});return{calls,cloud,owner};
}
test('phone helper mints fresh five-minute native pairing only for running exact child',async()=>{
 const f=fixture();let checked=0;const a=await f.cloud.pair(binding,{phone:true,validate:async()=>{checked++;}}),b=await f.cloud.pair(binding,{phone:true});
 assert.notEqual(a.code,b.code);assert.equal(a.url,'https://child.example');assert.equal(checked,3);
 assert.deepEqual(f.calls.map(a=>a[0]),['list','status','exec','list','status','exec']);
 assert.deepEqual(f.calls[2],['exec','root','--','/opt/t3/t3','auth','pairing','create','--base-dir','/work/.t3','--base-url','https://child.example','--ttl','5m','--json']);
});
for(const options of [{state:'stopped'},{state:'starting'},{badIdentity:true}])test('phone helper rejects stopped/starting/wrong child without exec '+JSON.stringify(options),async()=>{
 const f=fixture(options);await assert.rejects(f.cloud.pair(binding,{phone:true}));assert(!f.calls.some(a=>a[0]==='exec'));
});
test('phone helper queued credential grant revalidates before any command and never retries failure',async()=>{
 const f=fixture();const release=f.owner.acquire({kind:'test'});let revoked=false;
 const result=f.cloud.pair(binding,{phone:true,validate:async()=>{if(revoked)throw Error('revoked');}});
 revoked=true;release();await assert.rejects(result);assert.deepEqual(f.calls,[]);
});
for(const metadata of [{pairUrl:'https://evil.example/pair#token=fresh-1'},{pairUrl:'https://child.example/pair?token=fresh-1#token=fresh-1'},{expiresAt:'invalid'},{expiresAt:'2000-01-01'},{expiresAt:'2100-01-01'}])test('phone helper rejects wrong origin/query/expiry metadata '+JSON.stringify(metadata),async()=>{
 const f=fixture({metadata});await assert.rejects(f.cloud.pair(binding,{phone:true}));assert.equal(f.calls.filter(a=>a[0]==='exec').length,1);
});

test('owner-triggered pairing delegates sleeping-child wake to native exec without start/resume',async()=>{
 const f=fixture({state:'sleeping'});const result=await f.cloud.pair(binding,{phone:true});assert.equal(result.code,'fresh-1');
 assert.deepEqual(f.calls.map(args=>args[0]),['list','status','exec']);
});
test('platform refusal after sleeping admission returns no code and never retries',async()=>{
 const f=fixture({state:'sleeping',execRefused:true});
 await assert.rejects(f.cloud.pair(binding,{phone:true}));assert.deepEqual(f.calls.map(args=>args[0]),['list','status','exec']);
});
