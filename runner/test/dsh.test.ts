import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { clis, cliEnv, effectiveCliEnv, type Cli } from '../src/providers/catalog.ts';
import { Hub, type Peer } from '../src/acp/hub.ts';

test('DSH requires explicit enablement and a configured patch, forwards one named credential', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const patch = join(root, 'provider.yml');
  writeFileSync(patch, '# mock configuration');
  assert.equal(clis({}).some((c) => c.name === 'dsh'), false);
  assert.throws(() => clis({ RUNNER_DSH: '1' }), /requires absolute/);
  assert.throws(() => clis({ RUNNER_DSH: 'yes' }), /must be 0 or 1/);
  const cli = clis({ RUNNER_DSH: '1', DSH_HOME: root, RUNNER_DSH_PATCH: patch }).find((c) => c.name === 'dsh')!;
  assert.deepEqual(cli.acp, ['/opt/dsh/node_modules/.bin/dsh', '--profile', 'acp', '--patch', patch]);
  assert.equal(cli.sessionRecovery, 'resume');
  assert.equal(cli.env?.DSH_TELEMETRY_DISABLED, '1');
  const env = cliEnv({ AGENT_HOME_DSH_PROVIDER_KEY: 'local-placeholder', DSH_OTHER_SECRET: 'not-forwarded' });
  assert.equal(env.AGENT_HOME_DSH_PROVIDER_KEY, 'local-placeholder');
  assert.equal(env.DSH_OTHER_SECRET, undefined);
  const isolated = effectiveCliEnv({ ...cli, env: { ...cli.env, CODEX_HOME: '/override', OPENAI_API_KEY: 'override', NODE_OPTIONS: '--inspect' } }, {
    HOME: '/shared', CLAUDE_CONFIG_DIR: '/shared/claude', CODEX_HOME: '/shared/codex',
    OPENAI_API_KEY: 'other-provider', AGENT_HOME_DSH_PROVIDER_KEY: 'provider-placeholder', HTTP_PROXY: 'http://gateway.test',
  });
  assert.equal(isolated.HOME, root);
  assert.equal(isolated.AGENT_HOME_DSH_PROVIDER_KEY, 'provider-placeholder');
  assert.equal(isolated.HTTP_PROXY, 'http://gateway.test');
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENAI_API_KEY', 'NODE_OPTIONS']) assert.equal(isolated[name], undefined);
  assert.throws(() => effectiveCliEnv({ name: 'dsh', acp: ['dsh'] }, {}), /isolated DSH_HOME/);
});

for (const resume of [true, false]) test(`Hub recovery checks native resume capability (${resume})`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-recovery-'));
  const cli: Cli = {
    name: 'dsh', sessionRecovery: 'resume',
    acp: [process.execPath, fileURLToPath(new URL('./dsh-agent.ts', import.meta.url)), resume ? '1' : '0'],
    env: { DSH_HOME: join(root, 'isolated-home') },
  };
  const options = { clis: [cli], cwd: root, env: { PATH: process.env.PATH ?? '', HOME: '/native/home', CLAUDE_CONFIG_DIR: '/native/claude', CODEX_HOME: '/native/codex', ANTHROPIC_API_KEY: 'other-placeholder', OPENAI_API_KEY: 'other-placeholder', RUNNER_TOKEN: 'private-placeholder', AGENT_HOME_DSH_PROVIDER_KEY: 'dsh-placeholder' }, stateDir: root, maxTurns: 1 };
  let hub = new Hub(options);
  t.after(async () => { await hub.remove('dsh'); rmSync(root, { recursive: true, force: true }); });
  const peer: Peer = { send: () => {}, ask: async () => { throw Error('no permission request expected'); } };
  await assert.rejects(hub.pick(undefined), /no CLI/);
  const params = { cwd: root, mcpServers: [] };
  await hub.newSession('dsh', params, peer);
  const childEnv = await hub.forward('dsh', '_test/environment', {}) as Record<string, string>;
  assert.equal(childEnv.HOME, join(root, 'isolated-home'));
  assert.equal(childEnv.DSH_TELEMETRY_DISABLED, '1');
  assert.equal(childEnv.AGENT_HOME_DSH_PROVIDER_KEY, 'dsh-placeholder');
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'RUNNER_TOKEN'])
    assert.equal(childEnv[name], undefined, `${name} must not reach the DSH process`);
  await hub.prompt('dsh', { sessionId: 'persisted-session', prompt: [{ type: 'text', text: 'local transcript' }] }, peer);
  await hub.remove('dsh');
  hub = new Hub(options); // Runner restart: only persisted Hub transcript and native session ID remain.
  const updates: unknown[] = [];
  const reconnect: Peer = { ...peer, send: (message) => updates.push(message) };
  const load = () => hub.loadSession('dsh', { ...params, sessionId: 'persisted-session' }, reconnect);
  if (!resume) {
    await assert.rejects(load(), /does not advertise session resume/);
    const calls = await hub.forward('dsh', '_test/inspect', {}) as any[];
    assert.equal(calls.some((c) => c.method === 'session/resume'), false);
    return;
  }
  await load();
  assert.ok(JSON.stringify(updates).includes('local transcript'));
  const calls = await hub.forward('dsh', '_test/inspect', {}) as any[];
  assert.deepEqual(calls.map((c) => c.method), ['session/resume']);
  assert.equal(calls[0].params.sessionId, 'persisted-session');
  assert.deepEqual(await hub.prompt('dsh', { sessionId: 'persisted-session', prompt: [] }, reconnect), { stopReason: 'end_turn' });
});
