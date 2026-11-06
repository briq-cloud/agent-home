import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCredentialOwner } from './claude-runtime.mjs';
import { briqStatus, nativeConnections } from './native-connections.mjs';
test('CLI identity checks do not mistake MCP configuration or network errors for sign-in',async()=>{
 const env={BRIQ_MCP_TOKEN:'fake-mcp-capability',T3_CLOUD_EDGE_TOKEN:'must-not-inherit'};
 const run=(error,out,err)=>(command,args,options,done)=>{assert.equal(command,'briq');assert.deepEqual(args,['--json','whoami']);assert.deepEqual(options.env,{});done(error,out,err);};
 assert.equal(await briqStatus(env,run(null,JSON.stringify({apiUrl:'https://api.example',source:'oauth'}),'')),true);
 assert.equal(await briqStatus(env,run(Error(),'','not signed in to https://api.example')),false);
 assert.equal(await briqStatus(env,run(Error(),'','connection timed out')),null);
 assert.equal(await briqStatus(env,run(null,'{}','')),null);
});
test('native sign-in, status and pairing helpers receive no executing MCP grant while status remains unverified',async()=>{
 const calls=[];
 const env={HOME:'/native-home',T3_STATE:'/native-state',T3_CLOUD_EDGE_TOKEN:'edge-marker',BRIQ_MCP_TOKEN:'fake-central-mcp-marker',briq_mcp_token:'fake-case-marker'};
 const expected={HOME:env.HOME,T3_STATE:env.T3_STATE};
 const connections=nativeConnections(env,{
  signIn:({name})=>({status:{state:'idle'},start:async value=>{calls.push(name+'-login');assert.deepEqual(value,expected);return {state:'idle'};},cancel(){},input(){}}),
  status:async(command,value)=>{calls.push('claude-status');assert.deepEqual(value,expected);return false;},
  briqIdentity:async value=>{calls.push('briq-status');assert.deepEqual(value,expected);return false;},
  pair:(command,args,options,done)=>{calls.push('pair');assert.deepEqual(options.env,expected);done(null,JSON.stringify({pairUrl:'https://cloud.example/pair#fake',credential:'fake-native-pairing'}));},
 });
 const status=await connections.status();
 assert.equal(status.briq.authenticated,false);assert.equal(status.briq.mcp,'configured-unverified');
 await connections.claudeLogin();await connections.briqLogin();await connections.pair('https://cloud.example');connections.close();
 assert.deepEqual(calls,['claude-status','briq-status','claude-login','briq-login','pair']);
 const absent=nativeConnections({}, {signIn:()=>({status:{state:'idle'}}),status:async()=>false,briqIdentity:async()=>false});
 assert.equal((await absent.status()).briq.mcp,'unconfigured');
});

test('Claude sign-in retains the query credential owner through cancel until native process end',async()=>{
 const owner=new ClaudeCredentialOwner();let ended,statusCalls=0,cancels=0;
 const connections=nativeConnections({}, {claudeCredentialOwner:owner,
  signIn:({name},onEnd)=>{if(name==='claude')ended=onEnd;return{status:{state:'waiting'},start:async()=>({state:'waiting'}),cancel:()=>{cancels++;},input:()=>true};},
  status:async(_command,_env,_timeout,_subscription,_billing,options)=>{statusCalls++;options.onLifetime('terminated');return true;},briqIdentity:async()=>false});
 const releaseQuery=owner.acquire({kind:'query'});
 assert.throws(()=>connections.claudeLogin(),/busy/);
 assert.equal((await connections.status()).claude.authenticated,null);assert.equal(statusCalls,0);
 releaseQuery();await connections.claudeLogin();
 assert.throws(()=>owner.acquire({kind:'query'}),/busy/);
 connections.claudeCancel();assert.equal(cancels,1);assert.throws(()=>owner.acquire({kind:'query'}),/busy/);
 ended('terminated');const release=owner.acquire({kind:'query'});release();
 assert.equal((await connections.status()).claude.authenticated,true);assert.equal(statusCalls,1);
});

test('Briq native login/status share CLI refresh ownership until actual process end', async () => {
 const { BriqCredentialOwner } = await import('./briq-cloud.mjs');
 const owner = new BriqCredentialOwner(); let ended, reads = 0;
 const connections = nativeConnections({}, { briqCredentialOwner: owner,
  signIn: ({name}, onEnd) => { if(name === 'briq') ended = onEnd; return {status:{state:'waiting'},start:async()=>({state:'waiting'}),cancel(){}}; },
  status: async()=>false, briqIdentity: async()=>{reads++;return true;},
 });
 const release = owner.acquire({kind:'operation'});
 assert.throws(()=>connections.briqLogin(),/busy/);
 assert.equal((await connections.status()).briq.authenticated,null); assert.equal(reads,0);
 release(); await connections.briqLogin(); connections.close();
 assert.throws(()=>owner.acquire({kind:'operation'}),/busy/);
 ended(); assert.equal((await connections.status()).briq.authenticated,true); assert.equal(reads,1);
});
