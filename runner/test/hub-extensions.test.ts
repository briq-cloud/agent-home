import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { Hub, type Peer } from '../src/acp/hub.ts';
import { ExtensionRegistry } from '../src/extensions/index.ts';
import type { Cli } from '../src/providers/catalog.ts';

function fixture(
  t: TestContext,
  options: { name?: string; harness?: string; caps?: unknown; deployment?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'hub-extensions-')),
    stateDir = join(root, 'state'),
    home = join(root, 'home'),
    native = join(root, 'native-profile');
  mkdirSync(home);
  mkdirSync(native);
  writeFileSync(join(home, 'AGENTS.md'), 'OWNER AGENTS INSTRUCTIONS\n');
  writeFileSync(join(native, 'CLAUDE.md'), 'OWNER CLAUDE INSTRUCTIONS\n');
  const deployment = options.deployment
    ? {
        platform: 'briq' as const,
        apiUrl: 'https://api.example.test',
        homeId: 'home-test',
        stackId: 'stack-test',
      }
    : undefined;
  const registry = new ExtensionRegistry({ stateDir, deployment });
  registry.putSkill({
    name: 'home-test',
    description: 'Bounded native skill',
    body: 'Keep this full skill body out of system prompts. PRIVATE-SKILL-BODY',
  });
  const credentials: Record<string, string | undefined> = { SHARED_TOKEN: 'ephemeral-extension-secret-one' };
  const name = options.name ?? 'profile';
  const cli: Cli = {
    name,
    acp: [process.execPath, fileURLToPath(new URL('./extension-agent.ts', import.meta.url))],
    ...(options.harness ? { profile: { harness: options.harness, provider: 'test-api' } } : {}),
    env: {
      CLAUDE_CONFIG_DIR: native,
      EXTENSION_TEST_CAPS: JSON.stringify(options.caps ?? {}),
      EXTENSION_TEST_SKILL:
        options.harness === 'claude' || name === 'claude'
          ? join(native, 'skills', 'home-test', 'SKILL.md')
          : join(home, '.agents', 'skills', 'home-test', 'SKILL.md'),
    },
  };
  const hub = new Hub({
    clis: [cli],
    cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: home },
    stateDir,
    maxTurns: 2,
    extensions: { registry, env: () => credentials, deployment },
  });
  const peer: Peer = {
    send: () => {},
    ask: async () => {
      throw Error('No permissions in fixture');
    },
  };
  t.after(async () => {
    await hub.remove(name);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    native,
    stateDir,
    registry,
    credentials,
    hub,
    peer,
    name,
    cli,
    inspect: () => hub.forward(name, '_test/inspect', {}) as Promise<Array<{ method: string; params: any }>>,
  };
}

test('verified advertised append preserves caller/delegate params and resolves fresh secrets only at dispatch', async (t) => {
  const f = fixture(t, {
    harness: 'claude',
    caps: { mcpCapabilities: { http: true }, sessionCapabilities: { systemPrompt: {} } },
  });
  f.registry.putServer({
    name: 'shared',
    transport: 'http',
    url: 'https://tools.example.test/mcp',
    headerEnvRefs: { Authorization: { env: 'SHARED_TOKEN', prefix: 'Bearer ' } },
  });
  const incoming = { name: 'agent-home', command: process.execPath, args: ['delegate.ts'], env: [] };
  const caller = {
    cwd: f.root,
    mcpServers: [incoming],
    _meta: { trace: 'preserve' },
    systemPrompt: {
      mode: 'append',
      content: [{ type: 'text', text: 'USER APPEND' }],
      _meta: { owner: 'caller' },
    },
  };
  const original = structuredClone(caller);
  await f.hub.newSession(f.name, caller, f.peer);
  const first = (await f.inspect()).find((call) => call.method === 'session/new')!.params;
  assert.deepEqual(caller, original);
  assert.deepEqual(first.mcpServers[0], incoming);
  assert.equal(first.mcpServers[1].headers[0].value, 'Bearer ephemeral-extension-secret-one');
  assert.equal(first.systemPrompt.mode, 'append');
  assert.equal(first.systemPrompt.content[0].text, 'USER APPEND');
  assert.equal(first.systemPrompt._meta.owner, 'caller');
  assert.ok(first.systemPrompt.content[1].text.includes('User and project instructions still apply'));
  assert.ok(!JSON.stringify(first.systemPrompt).includes('PRIVATE-SKILL-BODY'));
  assert.deepEqual(first._meta, caller._meta);
  const initialized = (await f.hub.initialize(f.name)) as any;
  assert.equal(initialized._meta.skillReadyBeforeStart, true);
  assert.equal(existsSync(join(f.home, '.agents', 'skills', 'home-test', 'SKILL.md')), true);
  f.credentials.SHARED_TOKEN = 'ephemeral-extension-secret-two';
  await f.hub.newSession(f.name, { cwd: f.root, mcpServers: [] }, f.peer);
  const second = (await f.inspect()).filter((call) => call.method === 'session/new')[1]!.params;
  assert.equal(second.mcpServers[0].headers[0].value, 'Bearer ephemeral-extension-secret-two');
  const persisted = readFileSync(join(f.stateDir, 'sessions', f.name, 'session-1.jsonl'), 'utf8');
  const accepted = persisted
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((message) => message.method === '_runner/extensions');
  assert.equal(accepted.params.instructionDelivery, 'system_append');
  assert.equal(accepted.params.homeContextDelivered, true, 'native session/new success acknowledged append delivery');
  assert.ok(!persisted.includes('ephemeral-extension-secret'));
  assert.ok(!JSON.stringify(f.registry.list()).includes('ephemeral-extension-secret'));
  assert.ok(!JSON.stringify(f.hub.extensionStatus()).includes('ephemeral-extension-secret'));
  assert.equal(readFileSync(join(f.home, 'AGENTS.md'), 'utf8'), 'OWNER AGENTS INSTRUCTIONS\n');
  assert.equal(readFileSync(join(f.native, 'CLAUDE.md'), 'utf8'), 'OWNER CLAUDE INSTRUCTIONS\n');
});

test('unsupported append and caller overrides use labelled context once while caller data stays intact', async (t) => {
  for (const override of [false, true]) {
    const f = fixture(t, {
      name: 'codex',
      caps: { sessionCapabilities: { systemPrompt: override ? {} : false } },
    });
    const callerPrompt = { mode: 'override', content: [{ type: 'text', text: 'USER OVERRIDE' }] };
    const created = (await f.hub.newSession(
      f.name,
      { cwd: f.root, mcpServers: [], ...(override ? { systemPrompt: callerPrompt } : {}) },
      f.peer,
    )) as { sessionId: string };
    const beforePrompt = readFileSync(join(f.stateDir, 'sessions', f.name, `${created.sessionId}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      beforePrompt.find((message) => message.method === '_runner/extensions').params.homeContextDelivered,
      false,
      'fallback is not delivered before its first native turn',
    );
    const content = [{ type: 'text', text: 'Original user task', _meta: { original: true } }];
    await f.hub.prompt(f.name, { sessionId: created.sessionId, prompt: content, _meta: { turn: 'keep' } }, f.peer);
    await f.hub.prompt(f.name, { sessionId: created.sessionId, prompt: content }, f.peer);
    const calls = await f.inspect(),
      request = calls.find((call) => call.method === 'session/new')!.params,
      prompts = calls.filter((call) => call.method === 'session/prompt');
    assert.deepEqual(request.systemPrompt, override ? callerPrompt : undefined);
    assert.match(prompts[0]!.params.prompt[0].text, /supplemental user context, not system instructions/);
    assert.ok(prompts[0]!.params.prompt[0].text.endsWith('Original user task'));
    assert.equal(prompts[0]!.params.prompt[0]._meta.original, true);
    assert.deepEqual(prompts[0]!.params._meta, { turn: 'keep' });
    assert.deepEqual(prompts[1]!.params.prompt, content);
    assert.equal(content[0]!.text, 'Original user task');
    assert.equal(existsSync(join(f.native, 'skills')), false, 'Codex uses HOME/.agents, not a Claude config directory');
  }
});

test('native reload delivers current fallback context once without rebinding an already-held session', async (t) => {
  const f = fixture(t, { harness: 'claude', caps: { mcpCapabilities: { http: true } } });
  f.registry.putServer({
    name: 'shared',
    transport: 'http',
    url: 'https://tools.example.test/mcp',
    headerEnvRefs: { Authorization: 'SHARED_TOKEN' },
  });
  const created = (await f.hub.newSession(f.name, { cwd: f.root, mcpServers: [] }, f.peer)) as {
    sessionId: string;
  };
  await f.hub.prompt(f.name, { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'First' }] }, f.peer);
  f.credentials.SHARED_TOKEN = 'fresh-after-reload';
  f.registry.putServer({ name: 'added-after-first-turn', transport: 'stdio', command: process.execPath });
  const before = (await f.inspect()).length;
  await f.hub.loadSession(f.name, { sessionId: created.sessionId, cwd: f.root, mcpServers: [] }, f.peer);
  assert.equal((await f.inspect()).length, before, 'already held native session is not reconfigured');
  await f.hub.remove(f.name);
  f.hub.add(f.cli);
  await f.hub.loadSession(f.name, { sessionId: created.sessionId, cwd: f.root, mcpServers: [] }, f.peer);
  const lifecycle = readFileSync(join(f.stateDir, 'sessions', f.name, `${created.sessionId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((message) => message.method === '_runner/extensions');
  assert.equal(
    lifecycle.at(-1).params.homeContextDelivered,
    false,
    'historical delivery must not acknowledge newly prepared fallback context',
  );
  await f.hub.prompt(f.name, { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'After load' }] }, f.peer);
  await f.hub.prompt(
    f.name,
    { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'Second after load' }] },
    f.peer,
  );
  const calls = await f.inspect();
  assert.equal(
    calls
      .find((call) => call.method === 'session/load')!
      .params.mcpServers.find((server: any) => server.name === 'shared').headers[0].value,
    'fresh-after-reload',
  );
  const prompts = calls.filter((call) => call.method === 'session/prompt');
  assert.match(prompts[0]!.params.prompt[0].text, /supplemental user context, not system instructions/);
  assert.match(prompts[0]!.params.prompt[0].text, /mcp:added-after-first-turn/);
  assert.ok(prompts[0]!.params.prompt[0].text.endsWith('After load'));
  assert.deepEqual(prompts[1]!.params.prompt, [{ type: 'text', text: 'Second after load' }]);
});

test('required unsupported extensions and collisions fail without model/session dispatch; optional auth remains visible', async (t) => {
  const f = fixture(t, { name: 'claude', deployment: true });
  f.registry.putServer({
    name: 'remote',
    transport: 'http',
    required: true,
    url: 'https://tools.example.test/mcp',
  });
  await assert.rejects(f.hub.newSession(f.name, { cwd: f.root, mcpServers: [] }, f.peer), /remote \(unsupported\)/);
  assert.equal((await f.inspect()).filter((call) => call.method.startsWith('session/')).length, 0);
  f.registry.removeServer('remote');
  await f.hub.newSession(f.name, { cwd: f.root, mcpServers: [] }, f.peer);
  assert.ok(
    f.hub.extensionStatus()[0]!.statuses.some((status) => status.name === 'briq' && status.status === 'auth_required'),
  );
  const native = (await f.inspect()).find((call) => call.method === 'session/new')!;
  assert.deepEqual(native.params.mcpServers, []);
  f.registry.putServer({ name: 'collision', transport: 'stdio', command: process.execPath });
  await assert.rejects(
    f.hub.newSession(
      f.name,
      { cwd: f.root, mcpServers: [{ name: 'collision', command: process.execPath, args: [], env: [] }] },
      f.peer,
    ),
    /caller collisions/,
  );
});

test('existing native skill files survive session preparation and expose a conflict status', async (t) => {
  const f = fixture(t, { name: 'claude' });
  const owned = join(f.native, 'skills', 'home-test');
  mkdirSync(owned, { recursive: true });
  writeFileSync(join(owned, 'SKILL.md'), 'EXISTING USER SKILL\n');
  await f.hub.newSession(f.name, { cwd: f.root, mcpServers: [] }, f.peer);
  assert.equal(readFileSync(join(owned, 'SKILL.md'), 'utf8'), 'EXISTING USER SKILL\n');
  const markers = readFileSync(join(f.stateDir, 'sessions', f.name, 'session-1.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(
    markers.some(
      (message) =>
        message.method === '_runner/extensions' &&
        message.params.skills.some((skill: any) => skill.name === 'home-test' && skill.status === 'conflict'),
    ),
  );
});

test('valid incoming MCP PATH commands and extension metadata remain caller-owned and unchanged', async (t) => {
  const f = fixture(t, { name: 'claude' });
  const incoming = {
    name: 'caller-tool',
    command: 'node',
    args: [],
    env: [],
    _meta: { owner: 'caller' },
    vendorField: { preserve: true },
  };
  const created = (await f.hub.newSession(f.name, { cwd: f.root, mcpServers: [incoming] }, f.peer)) as {
    sessionId: string;
  };
  assert.ok(created.sessionId);
  assert.deepEqual((await f.inspect()).find((call) => call.method === 'session/new')!.params.mcpServers, [incoming]);
});

test('common known native homes get filesystem discovery links before Grok starts without claiming ingestion or MCP compatibility', async (t) => {
  const f = fixture(t, { name: 'grok' });
  await f.hub.newSession(f.name, { cwd: f.root, mcpServers: [] }, f.peer);
  const initialized = (await f.hub.initialize(f.name)) as any;
  assert.equal(initialized._meta.skillReadyBeforeStart, true);
  assert.equal(existsSync(join(f.home, '.agents', 'skills', 'home-test', 'SKILL.md')), true);
  assert.equal(existsSync(join(f.native, 'skills')), false);
});

test('credential-bearing MCP dispatch suppresses native crash details while ordinary diagnostics remain available', async (t) => {
  for (const protectedDispatch of [true, false]) {
    const f = fixture(t, { name: 'claude' });
    await f.hub.newSession(
      f.name,
      {
        cwd: f.root,
        mcpServers: protectedDispatch
          ? [
              {
                name: 'task-capability',
                command: process.execPath,
                args: [],
                env: [{ name: 'AGENT_HOME_TASK_CAP', value: 'PRIVATE-NATIVE-CRASH-TOKEN' }],
              },
            ]
          : [],
      },
      f.peer,
    );
    const write = process.stderr.write.bind(process.stderr);
    let output = '';
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: any[]) => {
      output += chunk.toString();
      const callback = rest.find((value) => typeof value === 'function');
      callback?.();
      return true;
    }) as typeof process.stderr.write;
    let message = '';
    try {
      await f.hub.forward(f.name, '_test/crash', {
        detail: protectedDispatch ? 'PRIVATE-NATIVE-CRASH-TOKEN' : 'ordinary adapter diagnostic',
      });
    } catch (error) {
      message = (error as Error).message;
    } finally {
      process.stderr.write = write;
    }
    assert.ok(output.includes('agent exited'));
    assert.ok(output.includes('"code":7'));
    assert.equal(output.includes('PRIVATE-NATIVE-CRASH-TOKEN'), false);
    assert.equal(message.includes('PRIVATE-NATIVE-CRASH-TOKEN'), false);
    assert.equal(output.includes('ordinary adapter diagnostic'), !protectedDispatch);
    assert.equal(output.includes('"tail"'), !protectedDispatch);
  }
});

test('native reload acknowledges system append without adding a fallback prefix', async (t) => {
  const f = fixture(t, { harness: 'claude', caps: { sessionCapabilities: { systemPrompt: {} } } });
  const created = (await f.hub.newSession(f.name, { cwd: f.root, mcpServers: [] }, f.peer)) as {
    sessionId: string;
  };
  await f.hub.remove(f.name);
  f.hub.add(f.cli);
  await f.hub.loadSession(f.name, { sessionId: created.sessionId, cwd: f.root, mcpServers: [] }, f.peer);
  const metadata = readFileSync(join(f.stateDir, 'sessions', f.name, `${created.sessionId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((message) => message.method === '_runner/extensions');
  assert.equal(metadata.at(-1).params.instructionDelivery, 'system_append');
  assert.equal(metadata.at(-1).params.homeContextDelivered, true);
  const content = [{ type: 'text', text: 'After native append load' }];
  await f.hub.prompt(f.name, { sessionId: created.sessionId, prompt: content }, f.peer);
  const calls = await f.inspect();
  assert.equal(calls.find((call) => call.method === 'session/load')!.params.systemPrompt.mode, 'append');
  assert.deepEqual(calls.find((call) => call.method === 'session/prompt')!.params.prompt, content);
});
