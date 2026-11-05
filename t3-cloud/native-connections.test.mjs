import test from 'node:test';
import assert from 'node:assert/strict';
import { briqStatus } from './native-connections.mjs';
test('CLI identity checks do not mistake MCP configuration or network errors for sign-in',async()=>{
 const env={BRIQ_MCP_TOKEN:'fake-mcp-capability'};
 const run=(error,out,err)=>(command,args,options,done)=>{assert.equal(command,'briq');assert.deepEqual(args,['--json','whoami']);assert.equal(options.env,env);done(error,out,err);};
 assert.equal(await briqStatus(env,run(null,JSON.stringify({apiUrl:'https://api.example',source:'oauth'}),'')),true);
 assert.equal(await briqStatus(env,run(Error(),'','not signed in to https://api.example')),false);
 assert.equal(await briqStatus(env,run(Error(),'','connection timed out')),null);
 assert.equal(await briqStatus(env,run(null,'{}','')),null);
});
