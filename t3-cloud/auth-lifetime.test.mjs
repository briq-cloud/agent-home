import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { commandStatus } from './vendor/auth/status.ts';
import { SignIn } from './vendor/auth/signin.ts';
import { nativeConnections } from './native-connections.mjs';
import { BriqCredentialOwner } from './briq-cloud.mjs';
import { ClaudeCredentialOwner } from './claude-runtime.mjs';

// Inject the child at the real helper's spawn boundary, exercising its actual
// listeners, timeout, input and teardown code, rather than manually ending a lease.
function processFixture() {
  const child = new EventEmitter();
  Object.assign(child, { pid: undefined, exitCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: [] });
  child.kill = signal => { child.kills.push(signal); return false; };
  child.spawned = () => { child.pid = 2147483647; child.emit('spawn'); };
  child.end = (code = 0, signal = null) => { child.exitCode = code; child.emit('exit', code, signal); child.emit('close', code, signal); };
  return child;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function ownedStatus(child, { timeoutMs = 1000, cleanupTimeoutMs = 25 } = {}) {
  const owner = new ClaudeCredentialOwner();
  const connections = nativeConnections({}, { claudeCredentialOwner: owner,
    signIn: () => ({ status: { state: 'idle' }, cancel() {} }), briqIdentity: async () => false,
    status: (command, env, _timeout, subscription, billing, options) => commandStatus(command, env, timeoutMs, subscription, billing,
      { ...options, cleanupTimeoutMs, spawnProcess: () => child }),
  });
  return { owner, connections, result: connections.status() };
}
function blocked(owner) { assert.throws(() => owner.acquire({ kind: 'metadata' }), /busy/); }
function available(owner) { const release = owner.acquire({ kind: 'query' }); release(); }

test('real status helper keeps post-spawn error ownership until exact direct child end', async () => {
  const child = processFixture(), { owner, result } = ownedStatus(child);
  child.spawned(); child.emit('error', Error('injected post-spawn error'));
  await tick(); blocked(owner); assert.deepEqual(child.kills, ['SIGKILL']);
  child.end(); assert.equal((await result).claude.authenticated, null); available(owner);
});
for (const trigger of ['timeout', 'overflow']) test(`real status ${trigger} kill request retains ownership until close`, async () => {
  const child = processFixture(), { owner, result } = ownedStatus(child, { timeoutMs: trigger === 'timeout' ? 0 : 1000, cleanupTimeoutMs: 100 });
  child.spawned();
  if (trigger === 'overflow') child.stdout.write(Buffer.alloc(16385));
  else await new Promise(resolve => setTimeout(resolve, 5));
  blocked(owner); assert.ok(child.kills.length);
  child.end(null, 'SIGKILL'); assert.equal((await result).claude.authenticated, null); available(owner);
});
test('real status failed kill/no termination quarantines and late close cannot clear it', async () => {
  const child = processFixture(), { owner, result } = ownedStatus(child, { cleanupTimeoutMs: 0 });
  child.spawned(); child.emit('error', Error('failed kill'));
  assert.equal((await result).claude.authenticated, null); blocked(owner); assert.equal(owner.quarantined, true);
  child.end(); blocked(owner);
});
test('real status never-spawned and normal exact close allow safe handoff', async () => {
  for (const fails of [true, false]) {
    const child = processFixture(), { owner, result } = ownedStatus(child);
    if (fails) child.emit('error', Object.assign(Error('missing'), { code: 'ENOENT' }));
    else { child.spawned(); child.stdout.write('{"loggedIn":true}'); child.end(); }
    assert.equal((await result).claude.authenticated, fails ? null : true); available(owner);
  }
});
test('status implementation without a lifetime receipt cannot release shared credentials', async () => {
  const owner = new ClaudeCredentialOwner();
  const connections = nativeConnections({}, { claudeCredentialOwner: owner, status: async () => null,
    signIn: () => ({ status: {}, cancel() {} }), briqIdentity: async () => false });
  await connections.status(); blocked(owner); assert.equal(owner.quarantined, true);
});

function ownedLogin(child, options = {}) {
  const owner = new ClaudeCredentialOwner(), spawns = [];
  const connections = nativeConnections({}, { claudeCredentialOwner: owner, briqIdentity: async () => false,
    signIn: (cli, ended) => new SignIn(cli, undefined, {
      direct: cli.name === 'claude', timeoutMs: 1000, pageWaitMs: 0, cleanupTimeoutMs: 25, ...options,
      spawnProcess: (command, args, config) => { spawns.push({ command, args, config }); return child; },
    }, ended),
  });
  return { owner, connections, spawns };
}
test('real direct Claude helper preserves page/input flow and releases only on captured child exit', async () => {
  const child = processFixture(), { owner, connections, spawns } = ownedLogin(child);
  const login = connections.claudeLogin(); child.spawned();
  child.stdout.write('Visit https://example.invalid/auth ABCD-EFGH');
  assert.equal((await login).state, 'waiting'); blocked(owner);
  assert.equal(spawns[0].command, 'claude'); assert.deepEqual(spawns[0].args, ['auth', 'login']);
  assert.deepEqual(spawns[0].config.stdio, ['pipe', 'pipe', 'pipe']);
  let input = ''; child.stdin.on('data', value => { input += value; });
  assert.equal(connections.claudeInput('synthetic-code#state'), true); assert.equal(input, 'synthetic-code#state\n');
  child.end(); available(owner);
});
for (const trigger of ['cancel', 'timeout', 'error']) test(`real direct Claude ${trigger} retains lease through kill request until exit`, async () => {
  const child = processFixture(), { owner, connections } = ownedLogin(child, { timeoutMs: trigger === 'timeout' ? 0 : 1000, cleanupTimeoutMs: 100 });
  const login = connections.claudeLogin(); child.spawned();
  if (trigger === 'cancel') connections.claudeCancel();
  else if (trigger === 'error') child.emit('error', Error('post-spawn'));
  else await new Promise(resolve => setTimeout(resolve, 5));
  blocked(owner); assert.deepEqual(child.kills, ['SIGKILL']); assert.equal((await login).state, 'failed');
  child.end(null, 'SIGKILL'); available(owner);
});
test('real direct helper no termination quarantines and denies restart even after late exit', async () => {
  const child = processFixture(), { owner, connections, spawns } = ownedLogin(child, { cleanupTimeoutMs: 0 });
  const login = connections.claudeLogin(); child.spawned(); child.emit('error', Error('post-spawn'));
  await login; await new Promise(resolve => setTimeout(resolve, 5));
  blocked(owner); assert.equal(owner.quarantined, true);
  assert.throws(() => connections.claudeLogin(), /lifetime unknown/); assert.equal(spawns.length, 1);
  child.end(); blocked(owner); assert.throws(() => connections.claudeLogin(), /lifetime unknown/);
});
test('real direct helper conclusively never spawned releases safely', async () => {
  const child = processFixture(), { owner, connections } = ownedLogin(child);
  const login = connections.claudeLogin(); child.emit('error', Object.assign(Error('missing'), { code: 'ENOENT' }));
  assert.equal((await login).reason, 'start_failed'); available(owner);
});
test('real PTY helper wrapper exit reports unknown credential child lifetime', async () => {
  const child = processFixture(), outcomes = [];
  const helper = new SignIn({ name: 'test', login: ['synthetic', 'login'] }, undefined,
    { spawnProcess: () => child, timeoutMs: 1000 }, value => outcomes.push(value));
  const result = helper.start({}); child.spawned(); child.end();
  assert.equal((await result).state, 'done'); assert.deepEqual(outcomes, ['unknown']);
});

// A local Node fixture also exercises actual OS spawn/exit and pipe delivery.
// It is not Claude, performs no auth/network work, and never reads credentials.
test('direct helper composes real piped line input with exact local child termination', async t => {
  const owner = new ClaudeCredentialOwner(); let captured;
  const connections = nativeConnections({}, { claudeCredentialOwner: owner,
    signIn: (cli, ended) => new SignIn(cli, undefined, { direct: cli.name === 'claude', pageWaitMs: 0,
      spawnProcess: (_command, _args, options) => {
        captured = spawn(process.execPath, ['--input-type=module', '-e',
          "import {createInterface} from 'node:readline'; const lines=createInterface({input:process.stdin}); console.log('https://example.invalid/auth ABCD-EFGH'); lines.once('line', value=>process.exit(value==='synthetic-code#state'?0:1));"], options);
        return captured;
      },
    }, ended),
  });
  t.after(() => { if (captured?.exitCode === null) captured.kill('SIGKILL'); });
  assert.equal((await connections.claudeLogin()).state, 'waiting'); blocked(owner);
  assert.equal(connections.claudeInput('synthetic-code#state'), true);
  await new Promise(resolve => captured.once('exit', resolve));
  available(owner); assert.equal(captured.exitCode, 0);
});

for (const trigger of ['cancel', 'timeout', 'error']) test(`real Briq PTY ${trigger} with failed kill/no exit retains owner and prevents replacement`, async () => {
  const child = processFixture(), owner = new BriqCredentialOwner();
  let spawns = 0, ends = 0;
  const connections = nativeConnections({}, { briqCredentialOwner: owner,
    signIn: (cli, ended) => new SignIn(cli, undefined, {
      timeoutMs: trigger === 'timeout' ? 0 : 1000, cleanupTimeoutMs: 0,
      spawnProcess: command => { assert.equal(command, 'script'); spawns++; return child; },
    }, outcome => { ends++; ended(outcome); }),
  });
  const login = connections.briqLogin(); child.spawned();
  if (trigger === 'cancel') connections.close();
  else if (trigger === 'error') child.emit('error', Error('injected post-spawn error'));
  else await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await login).state, 'failed');
  // Let the direct-mode cleanup deadline pass. PTY must never use that deadline
  // to forget its still-live wrapper or invoke the lease-release callback.
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.throws(() => owner.acquire({kind:'operation'}), /busy/);
  assert.equal(ends, 0); assert.equal(spawns, 1);
  assert.equal((await connections.briqLogin()).state, 'failed');
  assert.equal(spawns, 1); assert.equal(ends, 0);
  // Preserve the pre-existing PTY policy: actual wrapper exit ends this flow.
  child.end(null, 'SIGKILL');
  assert.equal(ends, 1);
  const release = owner.acquire({kind:'operation'}); release();
});
