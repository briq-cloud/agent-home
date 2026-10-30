import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const launcher = join(here, '../../bin/agent-home-start');
const pathNames = [
  'RUNNER_CWD',
  'RUNNER_STATE',
  'RUNNER_LOGINS',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COPILOT_HOME',
  'GROK_HOME',
  'VIBE_HOME',
  'XDG_CONFIG_HOME',
  'GEMINI_CLI_HOME',
];
let root = '';
let fakeBin = '';
let capture = '';
let baseEnv: Record<string, string>;
const children = new Set<ChildProcess>();

before(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-home-launcher-'));
  fakeBin = join(root, 'fake-bin');
  mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
  capture = join(root, 'runner-paths.json');
  const fakeRunner = join(fakeBin, 'agent-home-runner');
  writeFileSync(
    fakeRunner,
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst names = ${JSON.stringify(pathNames)};\nfs.writeFileSync(process.env.LAUNCHER_CAPTURE, JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name] || null]))));\nprocess.on('SIGTERM', () => process.exit(0));\nprocess.on('SIGINT', () => process.exit(0));\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o700 },
  );
  chmodSync(fakeRunner, 0o700);
  baseEnv = {
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    HOME: join(root, 'isolated-home'),
    RUNNER_TOKEN: 'synthetic-launcher-test-token',
    RUNNER_CWD: join(root, 'workspace'),
    RUNNER_STATE: join(root, 'state'),
    RUNNER_LOGINS: join(root, 'logins'),
    RUNNER_TERMINAL_ENABLED: '0',
    LAUNCHER_CAPTURE: capture,
  };
  mkdirSync(baseEnv.HOME, { recursive: true, mode: 0o700 });
});

async function launch(
  overrides: Record<string, string> = {},
): Promise<{ process: ChildProcess; paths: Record<string, string | null>; output: () => string }> {
  try {
    unlinkSync(capture);
  } catch {
    /* First launch. */
  }
  let output = '';
  const child = spawn('/bin/sh', [launcher], {
    env: { ...baseEnv, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const collect = (data: Buffer) => {
    output = (output + data.toString()).slice(-4000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const until = Date.now() + 4_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`launcher exited early: ${output}`);
    try {
      const paths = JSON.parse(readFileSync(capture, 'utf8')) as Record<string, string | null>;
      return { process: child, paths, output: () => output };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`fake runner did not start: ${output}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    children.delete(child);
    return;
  }
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 3_000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (child.exitCode === null) child.kill('SIGKILL');
  children.delete(child);
}

after(async () => {
  await Promise.all([...children].map(stop));
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test('defaults all vendor homes onto persistent logins with private directories and repeat-safe configs', async () => {
  const expected = {
    CLAUDE_CONFIG_DIR: join(baseEnv.RUNNER_LOGINS, 'claude'),
    CODEX_HOME: join(baseEnv.RUNNER_LOGINS, 'codex'),
    COPILOT_HOME: join(baseEnv.RUNNER_LOGINS, 'copilot'),
    GROK_HOME: join(baseEnv.RUNNER_LOGINS, 'grok'),
    VIBE_HOME: join(baseEnv.RUNNER_LOGINS, 'vibe'),
    XDG_CONFIG_HOME: join(baseEnv.RUNNER_LOGINS, 'config'),
    GEMINI_CLI_HOME: join(baseEnv.RUNNER_LOGINS, 'gemini'),
  };
  let child: ChildProcess | undefined;
  try {
    const first = await launch();
    child = first.process;
    assert.deepEqual(Object.fromEntries(Object.entries(expected).map(([name]) => [name, first.paths[name]])), expected);
    assert.equal(first.paths.RUNNER_CWD, baseEnv.RUNNER_CWD);
    assert.equal(first.paths.RUNNER_STATE, baseEnv.RUNNER_STATE);
    assert.equal(first.paths.RUNNER_LOGINS, baseEnv.RUNNER_LOGINS);
    for (const path of [
      baseEnv.RUNNER_STATE,
      baseEnv.RUNNER_LOGINS,
      ...Object.values(expected),
      join(expected.XDG_CONFIG_HOME, 'cursor'),
    ]) {
      assert.equal(mode(path), 0o700, `${path} should be private`);
    }
    const cursorConfig = join(expected.XDG_CONFIG_HOME, 'cursor', 'cli-config.json');
    const cursorInitial = JSON.parse(readFileSync(cursorConfig, 'utf8')) as Record<string, unknown>;
    assert.equal(cursorInitial.channel, 'static');
    assert.equal(mode(cursorConfig), 0o600);
    const vibeConfig = join(expected.VIBE_HOME, 'config.toml');
    assert.match(readFileSync(vibeConfig, 'utf8'), /enable_update_checks = false/);
    assert.equal(mode(vibeConfig), 0o600);
    await stop(child);
    child = undefined;

    writeFileSync(
      cursorConfig,
      JSON.stringify({ version: 1, channel: 'stable', editor: { vimMode: true }, custom: { preserve: 'yes' } }),
      { mode: 0o600 },
    );
    writeFileSync(vibeConfig, 'enable_update_checks = true\ncustom_setting = "preserve"\n', { mode: 0o600 });
    const second = await launch();
    child = second.process;
    const cursorAfter = JSON.parse(readFileSync(cursorConfig, 'utf8')) as {
      channel: string;
      editor: { vimMode: boolean };
      custom: { preserve: string };
    };
    assert.deepEqual(cursorAfter, {
      version: 1,
      channel: 'static',
      editor: { vimMode: true },
      custom: { preserve: 'yes' },
    });
    assert.equal(readFileSync(vibeConfig, 'utf8'), 'enable_update_checks = true\ncustom_setting = "preserve"\n');
  } finally {
    if (child) await stop(child);
  }
});

test('explicit operator home overrides are respected and their existing config data is preserved', async () => {
  const overridesRoot = join(root, 'operator-overrides');
  const overridePaths = Object.fromEntries(
    pathNames.slice(3).map((name) => [name, join(overridesRoot, name.toLowerCase())]),
  );
  const xdg = overridePaths.XDG_CONFIG_HOME as string;
  mkdirSync(join(xdg, 'cursor'), { recursive: true, mode: 0o700 });
  const cursorConfig = join(xdg, 'cursor', 'cli-config.json');
  writeFileSync(cursorConfig, JSON.stringify({ channel: 'beta', editor: { vimMode: true }, other: 17 }), {
    mode: 0o600,
  });
  const vibeConfig = join(overridePaths.VIBE_HOME as string, 'config.toml');
  mkdirSync(overridePaths.VIBE_HOME as string, { recursive: true, mode: 0o700 });
  writeFileSync(vibeConfig, 'enable_update_checks = true\noperator_setting = "kept"\n', { mode: 0o600 });
  let child: ChildProcess | undefined;
  try {
    const launched = await launch(overridePaths as Record<string, string>);
    child = launched.process;
    for (const [name, path] of Object.entries(overridePaths)) assert.equal(launched.paths[name], path);
    const updated = JSON.parse(readFileSync(cursorConfig, 'utf8')) as {
      channel: string;
      editor: { vimMode: boolean };
      other: number;
    };
    assert.deepEqual(updated, { channel: 'static', editor: { vimMode: true }, other: 17 });
    assert.equal(readFileSync(vibeConfig, 'utf8'), 'enable_update_checks = true\noperator_setting = "kept"\n');
    for (const path of Object.values(overridePaths)) assert.equal(mode(path as string), 0o700);
  } finally {
    if (child) await stop(child);
  }
});
