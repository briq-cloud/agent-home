import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { validateAcceptance, verifyAcceptance, VERIFICATION_LIMITS } from '../src/verification/index.ts';

function root(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'agent-home-verification-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('no caller-declared checks means unverified, including empty lists', async (t) => {
  const directory = root(t);
  assert.deepEqual(await verifyAcceptance({ root: directory }), { status: 'unverified', checks: [], durationMs: 0 });
  assert.equal(
    (await verifyAcceptance({ root: directory, spec: { commands: [], artifacts: [] } })).status,
    'unverified',
  );
});

test('runs argv literally in project cwd with only the allowed environment variables', async (t) => {
  const directory = root(t);
  const oldKey = process.env.AGENT_HOME_TEST_PROVIDER_KEY;
  process.env.AGENT_HOME_TEST_PROVIDER_KEY = 'must-not-reach-command';
  t.after(() => {
    if (oldKey === undefined) delete process.env.AGENT_HOME_TEST_PROVIDER_KEY;
    else process.env.AGENT_HOME_TEST_PROVIDER_KEY = oldKey;
  });
  const literal = '$(touch forbidden); * $HOME';
  const result = await verifyAcceptance({
    root: directory,
    spec: {
      commands: [
        {
          argv: [
            process.execPath,
            '-e',
            'console.log(JSON.stringify({cwd:process.cwd(),env:Object.keys(process.env),arg:process.argv[1],key:process.env.AGENT_HOME_TEST_PROVIDER_KEY??null}))',
            literal,
          ],
        },
      ],
    },
  });
  assert.equal(result.status, 'passed');
  const check = result.checks[0]!;
  assert.equal(check.kind, 'command');
  if (check.kind !== 'command') return;
  const observed = JSON.parse(check.stdout);
  assert.equal(observed.arg, literal);
  assert.equal(observed.key, null);
  // macOS injects this CoreFoundation locale variable after spawn; it is not
  // inherited by commandEnvironment and carries no runner/provider credential.
  assert.ok(
    observed.env.every((name: string) => ['PATH', 'LANG', 'HOME', 'TMPDIR', '__CF_USER_TEXT_ENCODING'].includes(name)),
  );
  assert.equal(existsSync(join(directory, 'forbidden')), false);
  assert.equal(observed.cwd, realpathSync(directory));
});

test('command failures, startup errors and bounded stdout/stderr remain structured', async (t) => {
  const directory = root(t);
  const result = await verifyAcceptance({
    root: directory,
    spec: {
      commands: [
        {
          argv: [
            process.execPath,
            '-e',
            'process.stdout.write("x".repeat(64000));process.stderr.write("y".repeat(64000));process.exitCode=7',
          ],
        },
        { argv: ['/nonexistent/agent-home-acceptance-command'] },
      ],
    },
  });
  assert.equal(result.status, 'failed');
  const first = result.checks[0]!,
    second = result.checks[1]!;
  assert.equal(first.kind, 'command');
  assert.equal(second.kind, 'command');
  if (first.kind !== 'command' || second.kind !== 'command') return;
  assert.equal(first.exitCode, 7);
  assert.equal(Buffer.byteLength(first.stdout), VERIFICATION_LIMITS.outputBytes);
  assert.equal(Buffer.byteLength(first.stderr), VERIFICATION_LIMITS.outputBytes);
  assert.equal(first.stdoutTruncated, true);
  assert.equal(first.stderrTruncated, true);
  assert.equal(second.status, 'failed');
  assert.match(second.error!, /ENOENT/);
});

test('timeout kills the entire command process group, including a child writing in the background', async (t) => {
  const directory = root(t);
  const heartbeat = join(directory, 'child-heartbeat.txt');
  const childSource = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),10);`;
  const parentSource = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'});console.log('ready');setInterval(()=>{},1000);`;
  const result = await verifyAcceptance({
    root: directory,
    spec: { commands: [{ argv: [process.execPath, '-e', parentSource], timeoutMs: 250 }] },
  });
  assert.equal(result.status, 'failed');
  const check = result.checks[0]!;
  if (check.kind !== 'command') assert.fail('Expected command result');
  assert.equal(check.timedOut, true);
  assert.equal(check.signal, 'SIGKILL');
  assert.ok(existsSync(heartbeat));
  const before = readFileSync(heartbeat).length;
  await sleep(80);
  assert.equal(readFileSync(heartbeat).length, before);
});

test('caller cancellation kills a running command and pre-cancelled checks do not start', async (t) => {
  const directory = root(t);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 80);
  t.after(() => clearTimeout(timeout));
  const result = await verifyAcceptance({
    root: directory,
    signal: controller.signal,
    spec: { commands: [{ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 2000 }] },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.checks[0]?.status, 'cancelled');
  const marker = join(directory, 'must-not-start');
  const cancelled = await verifyAcceptance({
    root: directory,
    signal: controller.signal,
    spec: {
      commands: [
        { argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`] },
      ],
    },
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(existsSync(marker), false);
});

test('artifact checks observe regular files and verify optional SHA256 without storing content', async (t) => {
  const directory = root(t);
  writeFileSync(join(directory, 'result.txt'), 'expected result');
  const hash = createHash('sha256').update('expected result').digest('hex');
  const passed = await verifyAcceptance({
    root: directory,
    spec: { artifacts: [{ path: 'result.txt', sha256: hash.toUpperCase() }] },
  });
  assert.equal(passed.status, 'passed');
  const check = passed.checks[0]!;
  if (check.kind !== 'artifact') assert.fail('Expected artifact result');
  assert.equal(check.sha256, hash);
  assert.equal(check.bytes, Buffer.byteLength('expected result'));
  const failed = await verifyAcceptance({
    root: directory,
    spec: { artifacts: [{ path: 'result.txt', sha256: '0'.repeat(64) }, { path: 'missing.txt' }] },
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.checks.length, 2);
  assert.match(failed.checks[0]!.error!, /mismatch/);
});

test('artifact policy rejects traversal and credential paths; symlink files and directories fail closed', async (t) => {
  const directory = root(t);
  for (const path of [
    '../outside',
    '/absolute',
    'nested/../file',
    '.env',
    'nested/.env.local',
    '.ssh/id_rsa',
    'nested/credentials.json',
    'private.key',
  ]) {
    assert.throws(() => validateAcceptance({ artifacts: [{ path }] }));
  }
  writeFileSync(join(directory, 'real.txt'), 'data');
  mkdirSync(join(directory, 'real-dir'));
  writeFileSync(join(directory, 'real-dir', 'file.txt'), 'data');
  symlinkSync(join(directory, 'real.txt'), join(directory, 'link.txt'));
  symlinkSync(join(directory, 'real-dir'), join(directory, 'link-dir'));
  const result = await verifyAcceptance({
    root: directory,
    spec: { artifacts: [{ path: 'link.txt' }, { path: 'link-dir/file.txt' }, { path: 'real-dir' }] },
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.checks.every((check) => check.status === 'failed'));
  assert.match(result.checks[0]!.error!, /Symlink/);
  assert.match(result.checks[1]!.error!, /Symlink/);
  assert.match(result.checks[2]!.error!, /regular file/);
});

test('validates command counts, argument sizes and the combined 120-second timeout budget', () => {
  assert.equal(
    validateAcceptance({ commands: Array.from({ length: 4 }, () => ({ argv: ['true'] })) }).commands?.length,
    4,
  );
  assert.throws(() => validateAcceptance({ commands: Array.from({ length: 5 }, () => ({ argv: ['true'] })) }));
  assert.throws(() => validateAcceptance({ commands: [{ argv: [] }] }));
  assert.throws(() => validateAcceptance({ commands: [{ argv: ['true'], timeoutMs: 0 }] }));
  assert.throws(() =>
    validateAcceptance({
      commands: [
        { argv: ['true'], timeoutMs: 60_001 },
        { argv: ['true'], timeoutMs: 60_000 },
      ],
    }),
  );
  assert.throws(() => validateAcceptance({ commands: [{ argv: ['true', 'x'.repeat(8192)] }] }));
  assert.throws(() => validateAcceptance({ artifacts: [{ path: 'result', sha256: 'invalid' }] }));
});

test('oversized artifact metadata fails before reading an unbounded file', async (t) => {
  const directory = root(t);
  const path = join(directory, 'large.bin');
  writeFileSync(path, '');
  truncateSync(path, VERIFICATION_LIMITS.artifactBytes + 1);
  const result = await verifyAcceptance({ root: directory, spec: { artifacts: [{ path: 'large.bin' }] } });
  assert.equal(result.status, 'failed');
  assert.match(result.checks[0]!.error!, /64MiB/);
});
