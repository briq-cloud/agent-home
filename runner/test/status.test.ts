import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandStatus } from '../src/status.ts';

test('distinguishes a signed-out result from a timed-out check', async () => {
  assert.equal(await commandStatus([process.execPath, '-e', 'process.exit(1)'], {}), false);
  assert.equal(await commandStatus([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {}, 100), null);
});

test('a status process killed by a signal or unable to start is unavailable', async () => {
  assert.equal(await commandStatus([process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], {}), null);
  assert.equal(await commandStatus(['/does-not-exist/agent-home-test'], {}), null);
});

test('reads a structured status even when the command exits successfully', async () => {
  assert.equal(await commandStatus([process.execPath, '-e', 'console.log(JSON.stringify({loggedIn:false}))'], {}), false);
  assert.equal(await commandStatus([process.execPath, '-e', 'console.log(JSON.stringify({loggedIn:true}))'], {}), true);
});
