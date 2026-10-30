import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { SignIn } from '../src/auth/signin.ts';

const env = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'LANG'].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]!]],
  ),
);
function signin(t: TestContext, source: string, completed?: () => void, options = {}) {
  const flow = new SignIn(
    { name: 'fake-signin', acp: [], login: [process.execPath, '-e', source] },
    completed,
    options,
  );
  t.after(() => flow.cancel());
  return flow;
}
async function until(check: () => unknown, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= end) throw new Error('Fake sign-in timed out');
    await sleep(5);
  }
}

test('nonwaiting start returns before a delayed link; observation gets code and exit without status commands', async (t) => {
  let completed = 0;
  const flow = signin(
    t,
    `setTimeout(()=>console.log('Open https://example.test/device ABCD-EFGH'),250);setTimeout(()=>process.exit(0),450);`,
    () => {
      completed++;
    },
  );
  const started = performance.now();
  assert.deepEqual(await flow.start(env, { wait: false }), { state: 'starting' });
  assert.ok(performance.now() - started < 200, 'start must return before delayed vendor output');
  await until(() => flow.status.state === 'waiting');
  assert.deepEqual(flow.status, { state: 'waiting', url: 'https://example.test/device', code: 'ABCD-EFGH' });
  assert.equal(completed, 0);
  await until(() => flow.status.state === 'done');
  assert.equal(completed, 1);
  assert.equal(flow.input('late-confirmation'), false);
  const state = flow.status;
  state.state = 'idle';
  assert.equal(flow.status.state, 'done', 'observers cannot mutate the active state');
});

test('legacy start waits for page and near-following code, and simultaneous callers reuse one process', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'signin-start-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, 'starts');
  let completed = 0;
  const flow = signin(
    t,
    `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x');setTimeout(()=>console.log('https://example.test/device'),30);setTimeout(()=>console.log('ABCD-12345'),100);setTimeout(()=>process.exit(0),300);`,
    () => {
      completed++;
    },
  );
  const first = flow.start(env);
  assert.equal((await flow.start(env, { wait: false })).state, 'starting');
  const second = flow.start(env);
  assert.deepEqual(await first, { state: 'waiting', url: 'https://example.test/device', code: 'ABCD-12345' });
  assert.deepEqual(await second, flow.status);
  assert.equal(readFileSync(marker, 'utf8'), 'x');
  await until(() => flow.status.state === 'done');
  assert.equal(completed, 1);
});

test('page-only legacy start has a bounded grace period, while input never claims a stopped process', async (t) => {
  const flow = signin(t, `console.log('https://example.test/browser');setTimeout(()=>{},5000);`, undefined, {
    pageWaitMs: 80,
    startWaitMs: 300,
  });
  assert.equal(flow.input('code'), false);
  const state = await flow.start(env);
  assert.deepEqual(state, { state: 'waiting', url: 'https://example.test/browser' });
  assert.equal(flow.input('bad\ncode'), false);
  assert.equal(flow.input('x'.repeat(4097)), false);
  flow.cancel();
  assert.equal(flow.status.state, 'failed');
  assert.equal(flow.status.reason, 'cancelled');
  assert.equal(flow.input('after-cancel'), false);
});

test('cancel and timeout settle legacy waiters promptly, expose distinct safe reasons, and never call completion', async (t) => {
  let completed = 0;
  const cancelled = signin(t, 'setInterval(()=>{},1000)', () => {
    completed++;
  });
  const waiting = cancelled.start(env);
  cancelled.cancel();
  assert.deepEqual(await waiting, { state: 'failed', reason: 'cancelled' });
  const timedOut = signin(
    t,
    'setInterval(()=>{},1000)',
    () => {
      completed++;
    },
    { timeoutMs: 80 },
  );
  assert.deepEqual(await timedOut.start(env), { state: 'failed', reason: 'timed_out' });
  assert.equal(completed, 0);
});

test('spawn failure and failed vendor exit are observed without exposing vendor output', async (t) => {
  const missing = new SignIn({ name: 'missing-wrapper', acp: [], login: [process.execPath, '-e', 'process.exit(0)'] });
  t.after(() => missing.cancel());
  assert.deepEqual(await missing.start({ PATH: '/nonexistent/agent-home-script' }), {
    state: 'failed',
    reason: 'start_failed',
  });
  const failed = signin(t, `console.error('fake-private-output-not-for-client');process.exit(2);`);
  const result = await failed.start(env);
  assert.deepEqual(result, { state: 'failed', reason: 'command_failed' });
  assert.ok(!JSON.stringify(result).includes('fake-private-output'));
  assert.equal(failed.input('code'), false);
});

test('completion callback errors cannot crash observation or change vendor success', async (t) => {
  const flow = signin(t, 'process.exit(0)', () => {
    throw new Error('private persistence failure');
  });
  assert.equal((await flow.start(env)).state, 'done');
});
