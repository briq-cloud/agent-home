import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Accounts } from '../src/providers/accounts.ts';
import { effectiveCliEnv, nativeHarness, type Cli } from '../src/providers/catalog.ts';
import { Hub, type Peer } from '../src/acp/hub.ts';
import { Routing, type Binding } from '../src/routing/index.ts';
import { commandStatus } from '../src/auth/status.ts';
import { ExtensionRegistry } from '../src/extensions/index.ts';

const peer: Peer = {
  send() {},
  async ask() {
    throw Error('no automatic permission');
  },
};
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'accounts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { stateDir: join(root, 'state'), logins: join(root, 'logins') };
  const accounts = new Accounts(options);
  const base: Cli = {
    name: 'claude',
    acp: [process.execPath, fileURLToPath(new URL('./mock-agent.ts', import.meta.url))],
    oneRefresher: true,
  };
  return { root, options, accounts, base };
}

test('account metadata is private, bounded and durable; each added native home is isolated', (t) => {
  const f = fixture(t),
    added = f.accounts.create({ label: 'Second subscription' });
  assert.match(added.cli, /^claude-account-[a-f0-9]{12}$/);
  f.accounts.update(added.id, { enabled: false, priority: 4 });
  assert.deepEqual(new Accounts(f.options).list(), f.accounts.list());
  assert.equal(statSync(join(f.options.stateDir, 'accounts.json')).mode & 0o777, 0o600);
  const inherited = {
    HOME: f.root,
    CLAUDE_CONFIG_DIR: join(f.root, 'existing-claude'),
    ANTHROPIC_API_KEY: 'test-api-key',
    ANTHROPIC_AUTH_TOKEN: 'test-token',
    ANTHROPIC_BASE_URL: 'https://api.test',
    ANTHROPIC_MODEL: 'metered-model',
    CLAUDE_CODE_USE_BEDROCK: '1',
    NODE_EXTRA_CA_CERTS: '/trusted/ca.pem',
    SSL_CERT_FILE: '/trusted/root.pem',
    HTTPS_PROXY: 'http://trusted-proxy',
  };
  const clis = f.accounts.clis(f.base, inherited),
    first = clis.find((c) => c.name === 'claude')!,
    second = clis.find((c) => c.name === added.cli)!;
  assert.equal(first.env, undefined);
  assert.equal(effectiveCliEnv(first, inherited).CLAUDE_CONFIG_DIR, inherited.CLAUDE_CONFIG_DIR);
  const isolated = effectiveCliEnv(second, inherited);
  assert.equal(isolated.CLAUDE_CONFIG_DIR, join(f.options.logins, 'accounts', added.id, 'claude'));
  assert.equal(statSync(isolated.CLAUDE_CONFIG_DIR).mode & 0o777, 0o700);
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'CLAUDE_CODE_USE_BEDROCK',
  ])
    assert.equal(isolated[name], undefined);
  for (const name of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY'])
    assert.equal(isolated[name], inherited[name as keyof typeof inherited]);
  assert.equal(nativeHarness(second), 'claude');
  assert.equal(second.profile, undefined);
  assert.equal(second.apiKeys, undefined);
  assert.ok(!readFileSync(join(f.options.stateDir, 'accounts.json'), 'utf8').includes('test-api-key'));
  for (const raw of [
    { label: 'x', token: 'not-accepted' },
    { label: 'x', harness: 'codex' },
    { label: 'x'.repeat(81) },
  ])
    assert.throws(() => f.accounts.create(raw));
  for (let i = 0; i < 7; i++) f.accounts.create({ label: `Subscription ${i}` });
  assert.throws(() => f.accounts.create({ label: 'Too many' }), /limit/);
  assert.throws(() => f.accounts.update(added.id, { id: 'other' }));
});

test('malformed metadata fails closed instead of silently losing account bindings', (t) => {
  const f = fixture(t);
  f.accounts.create({ label: 'Known' });
  writeFileSync(join(f.options.stateDir, 'accounts.json'), '{bad');
  assert.throws(() => new Accounts(f.options));
});

test('subscription auth checks require explicit vendor subscription mode; unknown is not signed in', async () => {
  for (const [response, expected] of [
    [{ loggedIn: true, authMethod: 'claude.ai' }, true],
    [{ loggedIn: false }, false],
    [{ loggedIn: true, authMethod: 'api_key' }, null],
    [{ loggedIn: true }, null],
  ] as const) {
    const value = await commandStatus(
      [process.execPath, '-e', `console.log(${JSON.stringify(JSON.stringify(response))})`],
      {},
      1000,
      true,
    );
    assert.equal(value, expected);
  }
});

test('Hub account Auto excludes exhausted/disabled/unknown, resets eligibility, and preserves pinned native sessions', async (t) => {
  const f = fixture(t),
    a = f.accounts.create({ label: 'A', priority: 1 }),
    b = f.accounts.create({ label: 'B', priority: 2 });
  const clis = f.accounts.clis(f.base, { HOME: f.root });
  const signed = new Map<string, boolean | null>([
    ['claude', false],
    [a.cli, true],
    [b.cli, true],
  ]);
  const hub = new Hub({
    clis,
    env: { HOME: f.root },
    cwd: f.root,
    stateDir: f.options.stateDir,
    maxTurns: 2,
    route: ['claude'],
    signedIn: async (cli) => signed.get(cli) ?? null,
  });
  t.after(() => hub.stop());
  assert.equal(await hub.pick(undefined), a.cli);
  const session = (await hub.newSession(a.cli, { cwd: f.root, mcpServers: [] }, peer)) as { sessionId: string };
  await assert.rejects(
    hub.prompt(a.cli, { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'limit' }] }, peer),
    /usage limit/,
  );
  assert.equal(await hub.pick(undefined), b.cli);
  assert.equal(hub.cliOf(session.sessionId), a.cli);
  assert.equal(await hub.pick(a.cli), a.cli);
  // A native reset report is observed for the same session; no model retry is made.
  const internals = hub as any;
  internals.fromAgent(a.cli, internals.engines.get(a.cli).sessions, {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'usage_update',
        _meta: { '_claude/rateLimit': { status: 'rejected', resetsAt: Date.now() - 1 } },
      },
    },
  });
  assert.equal(await hub.pick(undefined), a.cli);
  hub.setAccountMetadata(a.cli, { ...clis.find((c) => c.name === a.cli)!.subscriptionAccount!, enabled: false });
  assert.equal(await hub.pick(undefined), b.cli);
  signed.set(b.cli, null);
  await assert.rejects(hub.pick(undefined), /no CLI/);
  assert.equal(await hub.pick(a.cli), a.cli);
  assert.equal(hub.cliOf(session.sessionId), a.cli);
});

test('metadata updates keep active turns; reauthentication gates native work and shared auth roots', async (t) => {
  const f = fixture(t),
    account = f.accounts.create({ label: 'A' }),
    cli = f.accounts.clis(f.base, { HOME: f.root }).find((c) => c.name === account.cli)!;
  const sameRoot = { ...cli, name: 'same-native-root' };
  const hub = new Hub({
    clis: [cli, sameRoot],
    env: { HOME: f.root },
    cwd: f.root,
    stateDir: f.options.stateDir,
    maxTurns: 2,
  });
  t.after(() => hub.stop());
  const session = (await hub.newSession(cli.name, { cwd: f.root, mcpServers: [] }, peer)) as { sessionId: string };
  const prompt = hub.prompt(cli.name, { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'slow' }] }, peer);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(hub.busy(cli.name), true);
  await assert.rejects(hub.beginSignIn(sameRoot.name), /active native work/);
  hub.setAccountMetadata(cli.name, { ...cli.subscriptionAccount!, enabled: false, label: 'Renamed' });
  assert.equal(hub.running(cli.name), true);
  assert.equal(((await prompt) as any).stopReason, 'end_turn');
  const release = await hub.beginSignIn(cli.name);
  await assert.rejects(hub.newSession(sameRoot.name, { cwd: f.root, mcpServers: [] }, peer), /sign-in is in progress/);
  release();
  await hub.loadSession(cli.name, { sessionId: session.sessionId, cwd: f.root, mcpServers: [] }, peer);
  assert.equal(hub.cliOf(session.sessionId), cli.name);
});

test('account MCP and skill dispatch use native Claude capabilities and its isolated config home', async (t) => {
  const f = fixture(t),
    account = f.accounts.create({ label: 'Skills' });
  const registry = new ExtensionRegistry({ stateDir: f.options.stateDir });
  registry.putSkill({ name: 'home-account-skill', description: 'Fixture', body: 'Fixture skill body' });
  registry.putServer({ name: 'fixture', transport: 'http', url: 'https://tools.example.test/mcp' });
  const base = {
    ...f.base,
    acp: [process.execPath, fileURLToPath(new URL('./extension-agent.ts', import.meta.url))],
    env: {
      EXTENSION_TEST_CAPS: JSON.stringify({
        mcpCapabilities: { http: true },
        sessionCapabilities: { systemPrompt: {} },
      }),
    },
  };
  const cli = f.accounts.clis(base, { HOME: f.root }).find((c) => c.name === account.cli)!;
  const hub = new Hub({
    clis: [cli],
    env: { HOME: f.root },
    cwd: f.root,
    stateDir: f.options.stateDir,
    maxTurns: 1,
    extensions: { registry },
  });
  t.after(() => hub.stop());
  await hub.newSession(cli.name, { cwd: f.root, mcpServers: [] }, peer);
  const requests = (await hub.forward(cli.name, '_test/inspect', {})) as any[];
  assert.equal(requests.find((r) => r.method === 'session/new').params.mcpServers[0].name, 'fixture');
  assert.equal(hub.extensionStatus()[0].harness, 'claude');
  assert.ok(statSync(join(cli.env!.CLAUDE_CONFIG_DIR!, 'skills', 'home-account-skill', 'SKILL.md')).isFile());
});

test('free pool check records zero native/model requests across failover, reset, disable and pinned cases', async () => {
  const { checkAccountPool } = await import('../benchmarks/account-pool.ts');
  const result = await checkAccountPool();
  assert.equal(result.observations.length, 5);
  assert.deepEqual(result.requests, { native: 0, model: 0, metadata: 0 });
});
