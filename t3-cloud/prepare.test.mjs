import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readlinkSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from './prepare.mjs';

const missing = command => ({ status: 1, stdout: '', stderr: command === 'codex' ?
  "Error: No MCP server named 'briq' found.\n" : 'No MCP server named "briq". Run `claude mcp add` to add one.\n' });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 't3-cloud-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(['T3_CWD', 'T3_STATE', 'HOME', 'T3_LOGINS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    'COPILOT_HOME', 'GROK_HOME', 'VIBE_HOME', 'XDG_CONFIG_HOME', 'GEMINI_CLI_HOME', 'BRIQ_CONFIG_DIR'].map(key => [key, join(dir, key)]));
  return env;
}

test('native configs reference credentials without serializing them; skills use native directories', t => {
  const env = { ...fixture(t), BRIQ_MCP_TOKEN: 'private-test-value', T3_CLOUD_EDGE_TOKEN: 'edge-must-not-inherit',
    T3_CLOUD_OWNER_KEY: 'owner-must-not-inherit', T3_CLOUD_ALLOCATOR_TOKEN: 'allocator-must-not-inherit',
    T3_CLOUD_BRIDGE_TOKEN: 'bridge-must-not-inherit', t3_cloud_edge_token: 'mixed-case-must-not-inherit' };
  const calls = [];
  prepare(env, (command, args, options) => {
    calls.push({ command, args });
    assert.deepEqual(Object.keys(options.env).filter(key => key.toUpperCase().startsWith('T3_CLOUD_')), []);
    assert.equal(options.env.BRIQ_MCP_TOKEN, undefined);
    assert.equal(options.stdio === 'ignore' || Array.isArray(options.stdio), true);
    return args[1] === 'get' ? missing(command) : { status: 0 };
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1].args, ['mcp', 'add', 'briq', '--url', 'https://api.briq.cloud/mcp', '--bearer-token-env-var', 'BRIQ_MCP_TOKEN']);
  assert.equal(JSON.parse(calls[3].args.at(-1)).headers.Authorization, 'Bearer ${BRIQ_MCP_TOKEN}');
  assert.equal(JSON.stringify(calls).includes(env.BRIQ_MCP_TOKEN), false);
  assert.match(readlinkSync(join(env.HOME, '.agents/skills/briq')), /skills\/briq$/);
  assert.match(readlinkSync(join(env.CLAUDE_CONFIG_DIR, 'skills/briq')), /skills\/briq$/);
});

test('existing native MCP definitions and owner skills are preserved', t => {
  const env = fixture(t);
  const skill = join(env.CLAUDE_CONFIG_DIR, 'skills/briq');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), 'owner choice');
  const calls = [];
  const run = (command, args) => { calls.push(args); return { status: 0 }; };
  prepare(env, run);
  prepare(env, run);
  assert.equal(calls.every(args => args[1] === 'get'), true);
  assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8'), 'owner choice');
});

test('invalid endpoints and missing native commands stop bootstrap before server launch', t => {
  const env = fixture(t);
  for (const BRIQ_MCP_URL of ['http://example.test/mcp', 'https://user:pass@example.test/mcp', 'https://example.test/mcp?secret=value'])
    assert.throws(() => prepare({ ...env, BRIQ_MCP_URL }), /HTTPS endpoint/);
  assert.throws(() => prepare(env, () => ({ error: Error('missing') })), /configuration unavailable/);
  for (const result of [{ status: null }, { status: 1, signal: 'SIGTERM' }, { status: 1, stderr: 'malformed owner config' }])
    assert.throws(() => prepare(env, () => result), /configuration unavailable/);
  assert.throws(() => prepare(env, (command, args) => args[1] === 'get' ? missing(command) : ({ status: 1 })), /configuration failed/);
});
