import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { startChild } from './child.mjs';
import { digest } from './allocations.mjs';
import { BriqCloud, cli } from './briq-cloud.mjs';
import { PassThrough } from 'node:stream';

test('child selects native existing shim and launches only credential-free executor plus T3', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-child-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const runtime = await startChild({ T3_CLOUD_ROLE: 'child', T3_CLOUD_BINDING_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', T3_CLOUD_THREAD_ID: 'thread',
    T3_CLOUD_BRIDGE_URL: 'wss://central.example/_cloud/bridge', T3_CLOUD_BRIDGE_TOKEN: 'a'.repeat(43), T3_CLOUD_EDGE_TOKEN: 'e'.repeat(32),
    T3_CLOUD_EXEC_TOKEN_SHA256: digest('b'.repeat(43)), T3_CLOUD_PUBLIC_ORIGIN: 'https://child.example', BRIQ_API_KEY: 'must-not-inherit', OPENAI_API_KEY: 'must-not-inherit', BRIQ_MCP_TOKEN: 'fake-central-mcp-marker-must-not-inherit' }, {
    root, listen: { port: 0, host: '127.0.0.1' }, checkVersion: () => ({ status: 0, stdout: 'codex-cli 0.166.0\n' }),
    spawnProcess: (command, args, options) => { calls.push({ command, args, options }); const child = new EventEmitter(); child.kill = () => {}; return child; },
  });
  t.after(() => runtime.close());
  assert.equal(calls.length, 2); assert.equal(calls[0].args[0], 'exec-server');
  assert.equal(calls[0].args.includes('ws://127.0.0.1:3774'), true);
  assert.equal(calls[1].args.includes('127.0.0.1'), true);
  for (const { options } of calls) { assert.equal(options.env.BRIQ_API_KEY, undefined); assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.BRIQ_MCP_TOKEN, undefined); }
  assert.equal(calls[0].options.env.T3_CLOUD_BRIDGE_TOKEN, undefined);
  assert.equal(calls[0].options.env.T3_CLOUD_EDGE_TOKEN, undefined);
  assert.equal(calls[1].options.env.T3_CLOUD_EDGE_TOKEN, 'e'.repeat(32));
  const settings = JSON.parse(await readFile(join(root, '.t3/userdata/settings.json'), 'utf8'));
  assert.equal(settings.providerInstances.codex.config.setupMode, 'existing');
  assert.equal(settings.providerInstances.codex.config.binaryPath, '/opt/t3-cloud/bin/codex-remote');
  assert.equal(settings.providerInstances.claudeAgent.enabled, false);
});
test('cloud uses one public endpoint and trusted self hostname; reconciliation verifies allocation identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 't3-cloud-spec-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = []; const binding = { allocationId: 'allocation', threadId: 'thread', stack: 'sandbox-stack', briqId: 'bq_one', edgeTokenHash: digest('e'.repeat(32)), bridgeToken: 'a'.repeat(43), execToken: 'b'.repeat(43) };
  const cloud = new BriqCloud({ directory, env: { T3_CLOUD_EDGE_TOKEN: 'e'.repeat(32), BRIQ_MCP_TOKEN: 'fake-central-mcp-marker', briq_mcp_token: 'fake-case-marker' }, run: async (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'up') return { stack: binding.stack, briqs: [{ id: 'bq_one', name: 'sandbox', stackId: 'stack-one' }] };
    if (args[0] === 'expose') return { url: 'https://child.example' };
    if (args[0] === 'list') return calls.filter(row=>row.args[0]==='list').length===1
      ? {briqs:[{id:'bq_one',name:'sandbox',stackId:'stack-one',env:{T3_CLOUD_BINDING_ID:binding.allocationId,T3_CLOUD_THREAD_ID:binding.threadId}}]}
      : { briqs: [{ name: 'sandbox', id: 'bq_untrusted', env: { T3_CLOUD_BINDING_ID: 'other' } }] };
  } });
  assert.deepEqual(await cloud.create(binding, { image: `image@sha256:${'a'.repeat(64)}`, bridgeUrl: 'wss://central.example/_cloud/bridge', edgeCredential: 'e'.repeat(32) }), { id: 'bq_one', stackId: 'stack-one' });
  const spec = JSON.parse(await readFile(join(directory, 'allocation.json'), 'utf8'));
  assert.deepEqual(spec.services.sandbox.env.T3_CLOUD_EDGE_TOKEN, { secret: 'CHILD_EDGE_TOKEN' });
  assert.equal(JSON.stringify(spec).includes('e'.repeat(32)), false);
  assert.equal(calls[0].options.env.CHILD_EDGE_TOKEN, 'e'.repeat(32));
  assert.deepEqual(calls[0].args.slice(-5), ['--secret', 'CHILD_BRIDGE_TOKEN', '--secret', 'CHILD_EDGE_TOKEN', '--no-wait']);
  assert.deepEqual(spec.services.sandbox.ports, [8080]); assert.equal(spec.services.sandbox.expose, 'public');
  assert.equal(spec.services.sandbox.env.T3_CLOUD_PUBLIC_ORIGIN, 'https://{{self:host}}');
  assert.deepEqual(await cloud.endpoints(binding), { t3Url: 'https://child.example', execUrl: 'wss://child.example/_cloud/exec' });
  assert.equal(calls.filter(value => value.args[0] === 'expose').length, 1);
  assert.equal(await cloud.find(binding), null);
  for (const call of calls) { assert.equal(call.options.env.T3_CLOUD_EDGE_TOKEN, undefined); assert.equal(call.options.env.BRIQ_MCP_TOKEN, undefined); assert.equal(call.options.env.briq_mcp_token, undefined); }
  for (const call of calls.slice(1)) assert.equal(call.options.env.CHILD_EDGE_TOKEN, undefined);
});
test('direct Briq CLI subprocess construction strips executing MCP markers', async () => {
  let options;
  const result = await cli(['list'], { env: { HOME: '/native-home', BRIQ_MCP_TOKEN: 'fake-mcp-marker', briq_mcp_token: 'fake-case-marker' } }, (command, args, value) => {
    assert.equal(command, 'briq'); assert.deepEqual(args, ['--json', 'list']); options = value;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.write('{}'); child.emit('close', 0); });
    return child;
  });
  assert.deepEqual(result, {}); assert.deepEqual(options.env, { HOME: '/native-home' });
});

test('root namespace projection requires matching authoritative create and stack lookup identities',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'t3-root-namespace-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const edgeCredential='e'.repeat(32);
 for(const mode of ['valid','missing-stack','wrong-stack','wrong-root']){
  const binding={allocationId:mode,threadId:'thread',stack:'t3-'+'a'.repeat(24),edgeTokenHash:digest(edgeCredential),bridgeToken:'a'.repeat(43),execToken:'b'.repeat(43)};
  const cloud=new BriqCloud({directory,env:{},run:async args=>args[0]==='up'
   ? {stack:binding.stack,briqs:[{id:'root',name:'sandbox',...(mode==='missing-stack'?{}:{stackId:'stack-a'})}]}
   : {briqs:[{id:mode==='wrong-root'?'foreign':'root',name:'sandbox',stackId:mode==='wrong-stack'?'foreign-stack':'stack-a',env:{T3_CLOUD_BINDING_ID:binding.allocationId,T3_CLOUD_THREAD_ID:binding.threadId}}]}});
  const create=()=>cloud.create(binding,{image:'image@sha256:'+'a'.repeat(64),bridgeUrl:'wss://central.example/_cloud/bridge',edgeCredential});
  if(mode==='valid')assert.deepEqual(await create(),{id:'root',stackId:'stack-a'});else await assert.rejects(create());
 }
});

test('root recovery returns exact stack identity and rejects a changed recorded root or stack',async()=>{
 const binding={allocationId:'allocation',threadId:'thread',stack:'t3-'+'a'.repeat(24),briqId:'root',rootStackId:'stack-a'};
 let row={id:'root',name:'sandbox',stackId:'stack-a',env:{T3_CLOUD_BINDING_ID:binding.allocationId,T3_CLOUD_THREAD_ID:binding.threadId}};
 const cloud=new BriqCloud({directory:'/unused',env:{},run:async args=>{assert.deepEqual(args,['list','--stack',binding.stack]);return {briqs:[row]};}});
 assert.deepEqual(await cloud.find(binding),{id:'root',stackId:'stack-a'});
 row={...row,stackId:'foreign-stack'};assert.equal(await cloud.find(binding),null);
 row={...row,stackId:'stack-a',id:'another-root'};assert.equal(await cloud.find(binding),null);
});
