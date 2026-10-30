import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hub } from '../src/acp/hub.ts';

function fixture(t: TestContext, result: unknown, hang = false, holdResponse = false) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-vibe-auth-'));
  const methods = join(dir, 'methods.log');
  const releasePath = join(dir, 'release-status');
  const resultJson = JSON.stringify(result);
  const script = [
    "let input='';",
    "process.stdin.on('data', chunk => { input += chunk; let n; while ((n=input.indexOf('\\n')) >= 0) {",
    'const m = JSON.parse(input.slice(0,n)); input = input.slice(n+1);',
    "require('node:fs').appendFileSync(process.env.METHOD_LOG, m.method + '\\n');",
    'if (m.id === undefined) continue;',
    "if (m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\\n');",
    ...(hang
      ? ["if (m.method === '_auth/status') continue;"]
      : [
          holdResponse
            ? `if (m.method === '_auth/status') { const respond = () => { if (require('node:fs').existsSync(process.env.RELEASE_FILE)) { require('node:fs').appendFileSync(process.env.METHOD_LOG, '.settled\\n'); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:${resultJson}})+'\\n'); } else setTimeout(respond, 5); }; respond(); }`
            : `if (m.method === '_auth/status') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:${resultJson}})+'\\n');`,
        ]),
    '} });',
  ].join('\n');
  const hub = new Hub({
    clis: [{ name: 'vibe', acp: [process.execPath, '-e', script], authStatusMethod: '_auth/status' }],
    env: { PATH: process.env.PATH ?? '', METHOD_LOG: methods, RELEASE_FILE: releasePath },
    cwd: dir,
    stateDir: join(dir, 'state'),
    maxTurns: 1,
  });
  t.after(async () => {
    await hub.remove('vibe');
    rmSync(dir, { recursive: true, force: true });
  });
  return { hub, methods, release: () => writeFileSync(releasePath, '') };
}

test('Vibe auth status uses initialize plus the read-only ACP extension without a session or prompt', async (t) => {
  const { hub, methods } = fixture(t, {
    authenticated: true,
    authState: 'browser_authenticated',
    signOutAvailable: true,
    account: 'must not be surfaced',
  });
  assert.equal(await hub.authStatus('vibe'), true);
  assert.deepEqual(readFileSync(methods, 'utf8').trim().split('\n'), ['initialize', '_auth/status']);
});

test('Vibe ACP auth status maps false and malformed replies to false and unknown', async (t) => {
  const signedOut = fixture(t, { authenticated: false, authState: 'missing', signOutAvailable: false });
  assert.equal(await signedOut.hub.authStatus('vibe'), false);
  const malformed = fixture(t, { authState: 'missing' });
  assert.equal(await malformed.hub.authStatus('vibe'), null);
});

test('Vibe ACP auth status times out to unknown and leaves ordinary CLIs unsupported', async (t) => {
  const hanging = fixture(t, {}, true);
  assert.equal(await hanging.hub.authStatus('vibe', 50), null);
  const dir = mkdtempSync(join(tmpdir(), 'runner-no-auth-status-'));
  const unsupported = new Hub({
    clis: [{ name: 'copilot', acp: [process.execPath, '-e', 'process.stdin.resume()'] }],
    env: {},
    cwd: dir,
    stateDir: join(dir, 'state'),
    maxTurns: 1,
  });
  t.after(async () => {
    await unsupported.remove('copilot');
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(await unsupported.authStatus('copilot'), null);
});

test('timed-out callers share one pending status RPC until it settles', async (t) => {
  const { hub, methods, release } = fixture(t, { authenticated: true }, false, true);
  const first = hub.authStatus('vibe', 25);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = hub.authStatus('vibe', 45);
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  const countStatus = () =>
    readFileSync(methods, 'utf8')
      .split('\n')
      .filter((line) => line === '_auth/status').length;
  assert.equal(countStatus(), 1, 'concurrent/timed-out callers did not enqueue another RPC');

  release();
  const settledBy = Date.now() + 1000;
  while (!readFileSync(methods, 'utf8').includes('.settled') && Date.now() < settledBy)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(readFileSync(methods, 'utf8').includes('.settled'), 'the original RPC response settled');
  assert.equal(countStatus(), 1, 'the original result settled before allowing a fresh probe');
  assert.equal(await hub.authStatus('vibe'), true);
  assert.equal(countStatus(), 2, 'a fresh probe is allowed after the earlier request settled');
});
