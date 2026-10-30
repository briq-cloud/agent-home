import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionRegistry, homeInstructions } from '../src/extensions/index.ts';
function setup(
  t: test.TestContext,
  deployment?: { platform: 'briq'; apiUrl: string; homeId: string; stackId: string },
) {
  const dir = mkdtempSync(join(tmpdir(), 'extensions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, registry: new ExtensionRegistry({ stateDir: dir, deployment }) };
}
const caps = { mcpCapabilities: { http: true, sse: false } };
test('registry persists private validated references atomically and rejects raw credentials', (t) => {
  const { dir, registry } = setup(t);
  registry.putServer({
    name: 'docs',
    transport: 'http',
    url: 'https://example.com/mcp',
    headerEnvRefs: { Authorization: { env: 'DOCS_TOKEN', prefix: 'Bearer ' } },
  });
  const before = registry.list();
  assert.deepEqual(new ExtensionRegistry({ stateDir: dir }).list(), before);
  assert.equal(lstatSync(join(dir, 'extensions/registry.json')).mode & 0o777, 0o600);
  for (const value of [
    { name: 'bad', transport: 'http', url: 'https://u:p@example.com/mcp' },
    { name: 'bad', transport: 'http', url: 'https://example.com/mcp?token=raw' },
    { name: 'bad', transport: 'http', url: 'http://example.com/mcp' },
    { name: 'bad', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'raw' } },
    { name: 'bad', transport: 'stdio', command: 'npx' },
    { name: 'bad', transport: 'stdio', command: '/tool', env: { TOKEN: 'raw' } },
  ])
    assert.throws(() => registry.putServer(value as any));
  assert.throws(
    () =>
      registry.putServer({
        name: 'oversized',
        transport: 'stdio',
        command: process.execPath,
        args: Array(64).fill('x'.repeat(4096)),
      }),
    /byte limit/,
  );
  assert.deepEqual(registry.list(), before);
});
test('status is secret-free and dispatch resolves only declared ENV refs with sanitized headers', (t) => {
  const { dir, registry } = setup(t);
  registry.putServer({
    name: 'docs',
    transport: 'http',
    url: 'https://example.com/mcp',
    required: true,
    headerEnvRefs: { Authorization: { env: 'DOCS_TOKEN', prefix: 'Bearer ' } },
  });
  registry.putServer({
    name: 'local',
    transport: 'stdio',
    command: process.execPath,
    args: ['--stdio'],
    envRefs: { CHILD_TOKEN: 'LOCAL_TOKEN' },
  });
  assert.equal(
    registry.status({ cli: 'claude', capabilities: caps, availableEnvNames: [] })[0]?.status,
    'auth_required',
  );
  assert.equal(registry.plan({ cli: 'claude', capabilities: caps }).blocked, true);
  const before = readFileSync(join(dir, 'extensions/registry.json'), 'utf8');
  const plan = registry.plan({
    cli: 'claude',
    capabilities: caps,
    env: { DOCS_TOKEN: 'private-docs', LOCAL_TOKEN: 'private-local' },
  });
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.servers, [
    {
      name: 'docs',
      type: 'http',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer private-docs' }],
    },
    {
      name: 'local',
      command: process.execPath,
      args: ['--stdio'],
      env: [{ name: 'CHILD_TOKEN', value: 'private-local' }],
    },
  ]);
  assert.equal(readFileSync(join(dir, 'extensions/registry.json'), 'utf8'), before);
  assert.equal(JSON.stringify(registry.list()).includes('private-'), false);
  assert.throws(
    () =>
      registry.plan({
        cli: 'claude',
        capabilities: caps,
        env: { DOCS_TOKEN: 'bad\r\nInjection', LOCAL_TOKEN: 'safe' },
      }),
    /credential/,
  );
});
test('plans preserve incoming servers, reject collisions, and expose unsupported and unverified delivery', (t) => {
  const { registry } = setup(t);
  registry.putServer({ name: 'remote', transport: 'sse', url: 'https://example.com/events' });
  assert.equal(registry.plan({ cli: 'codex', capabilities: caps }).statuses[0]?.status, 'unsupported');
  assert.equal(registry.plan({ cli: 'cursor', capabilities: caps }).statuses[0]?.status, 'unverified');
  assert.equal(registry.plan({ cli: 'unknown', capabilities: caps }).statuses[0]?.status, 'unverified');
  const incoming = { name: 'user-server', command: '/installed/user', args: [], env: [] };
  assert.deepEqual(registry.plan({ cli: 'codex', capabilities: caps, incomingServers: [incoming] }).servers, [
    incoming,
  ]);
  assert.throws(
    () => registry.plan({ cli: 'codex', capabilities: caps, incomingServers: [{ ...incoming, name: 'remote' }] }),
    /conflict/,
  );
  assert.throws(
    () => registry.plan({ cli: 'codex', capabilities: caps, incomingServers: [incoming, incoming] }),
    /Duplicate/,
  );
});
test('Briq requires explicit deployment and owner credential without blocking unrelated work', (t) => {
  assert.deepEqual(
    setup(t).registry.status({ cli: 'claude', capabilities: caps, availableEnvNames: ['BRIQ_MCP_TOKEN'] }),
    [],
  );
  const { registry } = setup(t, {
    platform: 'briq',
    apiUrl: 'https://api.example',
    homeId: 'home-1',
    stackId: 'stack-1',
  });
  const missing = registry.plan({
    cli: 'claude',
    capabilities: caps,
    env: { BRIQ_API_KEY: 'do-not-copy', RUNNER_TOKEN: 'do-not-copy' },
  });
  assert.deepEqual(missing.statuses, [{ name: 'briq', status: 'auth_required' }]);
  assert.equal(missing.blocked, false);
  assert.deepEqual(missing.servers, []);
  assert.deepEqual(
    registry.plan({ cli: 'claude', capabilities: caps, env: { BRIQ_MCP_TOKEN: 'scoped-owner' } }).servers,
    [
      {
        name: 'briq',
        type: 'http',
        url: 'https://api.example/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer scoped-owner' }],
      },
    ],
  );
  assert.throws(() => registry.putServer({ name: 'briq', transport: 'stdio', command: '/bad' }), /reserved/);
  assert.throws(() => registry.removeServer('briq'), /reserved/);
});
test('skills are hashed and namespaced; syncing preserves user files and dangling links', (t) => {
  const { dir, registry } = setup(t);
  assert.equal(registry.installBuiltins().length, 2);
  const skill = registry.putSkill({
    name: 'home-custom',
    description: 'Quoted: description',
    body: '# Workflow\nRead current status.',
  });
  assert.equal(skill.hash.length, 64);
  assert.throws(() => registry.putSkill({ name: 'not-owned', description: 'bad', body: 'bad' }));
  const agents = join(dir, 'owner/.agents'),
    claude = join(dir, 'owner/claude');
  mkdirSync(join(agents, 'skills/home-agent-home'), { recursive: true });
  writeFileSync(join(agents, 'skills/home-agent-home/SKILL.md'), 'user content');
  symlinkSync('/user/owned/missing', join(agents, 'skills/home-briq'));
  assert.equal(
    registry.syncSkills({ agentsHome: agents, claudeConfigDir: claude }).filter((v) => v.status === 'conflict').length,
    2,
  );
  assert.equal(readFileSync(join(agents, 'skills/home-agent-home/SKILL.md'), 'utf8'), 'user content');
  assert.equal(readlinkSync(join(agents, 'skills/home-briq')), '/user/owned/missing');
  const target = readlinkSync(join(claude, 'skills/home-custom'));
  assert.match(readFileSync(join(target, 'SKILL.md'), 'utf8'), /description: "Quoted: description"/);
  assert.ok(registry.syncSkills({ claudeConfigDir: claude }).every((v) => v.status === 'present'));
  registry.putSkill({ name: 'home-custom', description: 'Changed', body: 'Updated workflow.' });
  const reopened = new ExtensionRegistry({ stateDir: dir });
  assert.equal(
    reopened.syncSkills({ claudeConfigDir: claude }).find((v) => v.name === 'home-custom')?.status,
    'updated',
  );
  assert.notEqual(readlinkSync(join(claude, 'skills/home-custom')), target);
  assert.equal(
    reopened.syncSkills({ claudeConfigDir: claude }).find((v) => v.name === 'home-custom')?.status,
    'present',
  );
  const linkedHome = join(dir, 'linked-home');
  mkdirSync(linkedHome);
  symlinkSync(join(claude, 'skills'), join(linkedHome, 'skills'));
  assert.ok(
    registry.syncSkills({ agentsHome: linkedHome }).every((value) => value.status === 'conflict'),
    'existing discovery-directory links are preserved and reported',
  );
  const removed = new ExtensionRegistry({ stateDir: dir }).removeSkill('home-custom');
  assert.equal(
    registry.list().skills.some((value) => value.name === 'home-custom'),
    false,
  );
  assert.equal(removed.filter((value) => value.status === 'removed').length, 2);
  assert.equal(existsSync(join(claude, 'skills/home-custom')), false);
  assert.equal(
    existsSync(join(target, 'SKILL.md')),
    true,
    'canonical content remains available for existing references',
  );
});
test('awareness is stable additive context without an authentication or permission grant', () => {
  const a = homeInstructions({ workspace: '/work', availableTools: ['status', 'read', 'status'] });
  assert.equal(a, homeInstructions({ workspace: '/work', availableTools: ['read', 'status'] }));
  assert.match(a, /grants no extra permissions/);
  assert.match(a, /unknown/);
  assert.throws(() => homeInstructions({ workspace: '/work\nInjected', availableTools: [] }));
  assert.match(
    homeInstructions({
      workspace: '/work',
      availableTools: [],
      deployment: { platform: 'briq', apiUrl: 'https://api.example', homeId: 'home', stackId: 'stack' },
    }),
    /alone does not establish authentication/,
  );
});

test('user-replaced managed files and links survive update/removal after registry restart', (t) => {
  const { dir, registry } = setup(t);
  const home = join(dir, 'owner/.agents');
  registry.putSkill({ name: 'home-file', description: 'File skill', body: 'Original file workflow.' });
  registry.putSkill({ name: 'home-link', description: 'Link skill', body: 'Original link workflow.' });
  registry.syncSkills({ agentsHome: home });
  const file = join(home, 'skills/home-file'),
    link = join(home, 'skills/home-link');
  unlinkSync(file);
  writeFileSync(file, 'user replacement');
  unlinkSync(link);
  symlinkSync('/user/replacement', link);
  const restarted = new ExtensionRegistry({ stateDir: dir });
  restarted.putSkill({ name: 'home-file', description: 'New version', body: 'Updated workflow.' });
  assert.equal(restarted.syncSkills({ agentsHome: home }).filter((value) => value.status === 'conflict').length, 2);
  assert.equal(restarted.removeSkill('home-file')[0]?.status, 'conflict');
  assert.equal(restarted.removeSkill('home-link').filter((value) => value.status === 'conflict').length, 2);
  assert.equal(readFileSync(file, 'utf8'), 'user replacement');
  assert.equal(readlinkSync(link), '/user/replacement');
});
test('incoming ACP records preserve PATH commands, query URLs, metadata and extensions', (t) => {
  const { registry } = setup(t);
  const incoming = [
    {
      name: 'caller tool',
      command: 'node',
      args: ['server.js'],
      env: [{ name: 'MixedCase', value: 'caller-value', _meta: { origin: 'caller' } }],
      _meta: { source: 'client' },
      customField: { keep: true },
    },
    {
      name: 'remote user',
      type: 'http' as const,
      url: 'http://remote.internal/mcp?session=abc',
      headers: [{ name: 'Authorization', value: 'caller-token', _meta: { keep: true } }],
      _meta: { source: 'client' },
    },
  ];
  assert.deepEqual(registry.plan({ cli: 'claude', capabilities: caps, incomingServers: incoming }).servers, incoming);
  assert.equal(JSON.stringify(registry.list()).includes('caller-token'), false);
});
test('interrupted managed link updates recover both sides of the atomic switch', (t) => {
  for (const switched of [false, true]) {
    const { dir, registry } = setup(t),
      home = join(dir, 'owner/.agents');
    registry.putSkill({ name: 'home-recovery', description: 'First', body: 'Version one.' });
    registry.syncSkills({ agentsHome: home });
    const file = join(dir, 'extensions/links.json'),
      state = JSON.parse(readFileSync(file, 'utf8')),
      old = state.links[0],
      next = registry.putSkill({ name: 'home-recovery', description: 'Second', body: 'Version two.' });
    const target = join(dir, 'extensions/skills/home-recovery', next.hash);
    state.links[0] = { ...old, target, hash: next.hash, previous: { target: old.target, hash: old.hash } };
    writeFileSync(file, JSON.stringify(state));
    if (switched) {
      unlinkSync(old.path);
      symlinkSync(target, old.path);
    }
    const restarted = new ExtensionRegistry({ stateDir: dir });
    assert.equal(restarted.syncSkills({ agentsHome: home })[0]?.status, switched ? 'present' : 'updated');
    assert.equal(readlinkSync(old.path), target);
    assert.equal(restarted.removeSkill('home-recovery')[0]?.status, 'removed');
    assert.equal(existsSync(old.path), false);
  }
});
