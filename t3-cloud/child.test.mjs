import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { startChild } from './child.mjs';
import { digest } from './allocations.mjs';
import { BriqCloud } from './briq-cloud.mjs';

test('child selects native existing shim and launches only credential-free executor plus T3', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-child-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const runtime = await startChild({ T3_CLOUD_ROLE: 'child', T3_CLOUD_BINDING_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', T3_CLOUD_THREAD_ID: 'thread',
    T3_CLOUD_BRIDGE_URL: 'wss://central.example/_cloud/bridge', T3_CLOUD_BRIDGE_TOKEN: 'a'.repeat(43),
    T3_CLOUD_EXEC_TOKEN_SHA256: digest('b'.repeat(43)), T3_CLOUD_PUBLIC_ORIGIN: 'https://child.example', BRIQ_API_KEY: 'must-not-inherit', OPENAI_API_KEY: 'must-not-inherit' }, {
    root, checkVersion: () => ({ status: 0, stdout: 'codex-cli 0.166.0\n' }),
    spawnProcess: (command, args, options) => { calls.push({ command, args, options }); const child = new EventEmitter(); child.kill = () => {}; return child; },
  });
  t.after(() => runtime.close());
  assert.equal(calls.length, 2); assert.equal(calls[0].args[0], 'exec-server');
  assert.equal(calls[0].args.includes('ws://127.0.0.1:3774'), true);
  assert.equal(calls[1].args.includes('127.0.0.1'), true);
  for (const { options } of calls) { assert.equal(options.env.BRIQ_API_KEY, undefined); assert.equal(options.env.OPENAI_API_KEY, undefined); }
  assert.equal(calls[0].options.env.T3_CLOUD_BRIDGE_TOKEN, undefined);
  const settings = JSON.parse(await readFile(join(root, '.t3/userdata/settings.json'), 'utf8'));
  assert.equal(settings.providerInstances.codex.config.setupMode, 'existing');
  assert.equal(settings.providerInstances.codex.config.binaryPath, '/opt/t3-cloud/bin/codex-remote');
  assert.equal(settings.providerInstances.claudeAgent.enabled, false);
});
test('cloud uses one public endpoint and trusted self hostname; reconciliation verifies allocation identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 't3-cloud-spec-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = []; const binding = { allocationId: 'allocation', threadId: 'thread', stack: 'sandbox-stack', briqId: 'bq_one', bridgeToken: 'a'.repeat(43), execToken: 'b'.repeat(43) };
  const cloud = new BriqCloud({ directory, env: {}, run: async (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'up') return { stack: binding.stack, briqs: [{ id: 'bq_one' }] };
    if (args[0] === 'expose') return { url: 'https://child.example' };
    if (args[0] === 'list') return { briqs: [{ name: 'sandbox', id: 'bq_untrusted', env: { T3_CLOUD_BINDING_ID: 'other' } }] };
  } });
  await cloud.create(binding, { image: `image@sha256:${'a'.repeat(64)}`, bridgeUrl: 'wss://central.example/_cloud/bridge' });
  const spec = JSON.parse(await readFile(join(directory, 'allocation.json'), 'utf8'));
  assert.deepEqual(spec.services.sandbox.ports, [8080]); assert.equal(spec.services.sandbox.expose, 'public');
  assert.equal(spec.services.sandbox.env.T3_CLOUD_PUBLIC_ORIGIN, 'https://{{self:host}}');
  assert.deepEqual(await cloud.endpoints(binding), { t3Url: 'https://child.example', execUrl: 'wss://child.example/_cloud/exec' });
  assert.equal(calls.filter(value => value.args[0] === 'expose').length, 1);
  assert.equal(await cloud.find(binding), null);
});
