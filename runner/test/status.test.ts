import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandStatus, parseBillingStatus, commandBilling } from '../src/auth/status.ts';

test('distinguishes a signed-out result from a timed-out check', async () => {
  assert.equal(await commandStatus([process.execPath, '-e', 'process.exit(1)'], {}), false);
  assert.equal(await commandStatus([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {}, 100), null);
});

test('a status process killed by a signal or unable to start is unavailable', async () => {
  assert.equal(await commandStatus([process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], {}), null);
  assert.equal(await commandStatus(['/does-not-exist/agent-home-test'], {}), null);
});

test('reads a structured status even when the command exits successfully', async () => {
  assert.equal(
    await commandStatus([process.execPath, '-e', 'console.log(JSON.stringify({loggedIn:false}))'], {}),
    false,
  );
  assert.equal(await commandStatus([process.execPath, '-e', 'console.log(JSON.stringify({loggedIn:true}))'], {}), true);
});
test('API authentication is never labelled an included subscription', async () => {
  assert.equal(parseBillingStatus('{"loggedIn":true,"authMethod":"api_key"}'), 'use');
  assert.equal(parseBillingStatus('{"loggedIn":true,"authMethod":"claude.ai"}'), 'subscription');
  assert.equal(parseBillingStatus('Logged in using ChatGPT'), 'subscription');
  assert.equal(parseBillingStatus('Logged in using an API key'), 'use');
  assert.equal(parseBillingStatus('signed in'), 'unknown');
  assert.equal(
    await commandBilling([process.execPath, '-e', 'process.stderr.write("Logged in using ChatGPT")'], {}),
    'subscription',
  );
  assert.equal(
    await commandBilling([process.execPath, '-e', 'process.stdout.write("x".repeat(20000))'], {}),
    'unknown',
  );
});
