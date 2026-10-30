import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clis } from '../src/providers/catalog.ts';
import { commandStatus, parseAcpAuthStatus, parseBillingStatus, commandBilling } from '../src/auth/status.ts';

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

test('explicit signed-out messages from successful status commands stay negative', async () => {
  const messages = ['Not logged in', 'Logged out', 'Not authenticated', 'Not signed in', 'Login required'];
  for (const message of messages) {
    assert.equal(
      await commandStatus([process.execPath, '-e', `process.stderr.write(${JSON.stringify(message)})`], {}),
      false,
      message,
    );
  }
  assert.equal(
    await commandStatus([process.execPath, '-e', 'process.stdout.write("status available")'], {}),
    true,
    'legacy status commands with no explicit state still use exit status',
  );
});

test('explicit JSON loggedIn state takes precedence over human-readable output and exit status', async () => {
  assert.equal(
    await commandStatus(
      [process.execPath, '-e', 'console.log(JSON.stringify({loggedIn:true})); console.error("Not logged in")'],
      {},
    ),
    true,
  );
  assert.equal(
    await commandStatus(
      [process.execPath, '-e', 'console.log(JSON.stringify({loggedIn:false})); process.exitCode = 0'],
      {},
    ),
    false,
  );
  assert.equal(
    await commandStatus(
      [process.execPath, '-e', 'console.log(JSON.stringify({loggedIn:false})); process.exitCode = 1'],
      {},
    ),
    false,
  );
});

test('status output bounds cover stdout and stderr, while timeout remains unavailable', async () => {
  assert.equal(await commandStatus([process.execPath, '-e', 'process.stderr.write("x".repeat(17000))'], {}), null);
  assert.equal(
    await commandStatus(
      [process.execPath, '-e', 'process.stderr.write("Not logged in"); setInterval(() => {}, 1000)'],
      {},
      100,
    ),
    null,
  );
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

test('Vibe ACP auth status accepts only the documented authenticated boolean', () => {
  assert.equal(
    parseAcpAuthStatus({ authenticated: true, authState: 'api_key', signOutAvailable: true, secret: 'ignored' }),
    true,
  );
  assert.equal(parseAcpAuthStatus({ authenticated: false, authState: 'missing' }), false);
  assert.equal(parseAcpAuthStatus({ authState: 'missing' }), null);
  assert.equal(parseAcpAuthStatus({ authenticated: 'true' }), null);
  assert.equal(parseAcpAuthStatus(null), null);
  assert.equal(parseAcpAuthStatus([]), null);
});
test('only the documented read-only ACP auth method can be configured', () => {
  const configuration = (method: string) => ({
    RUNNER_CLIS: JSON.stringify([{ name: 'vibe', acp: ['vibe-acp'], authStatusMethod: method }]),
  });
  assert.equal(clis(configuration('_auth/status'))[0]?.authStatusMethod, '_auth/status');
  assert.throws(() => clis(configuration('_auth/signOut')), /invalid ACP auth status method/);
});
