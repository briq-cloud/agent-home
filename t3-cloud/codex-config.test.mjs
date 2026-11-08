import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readlink, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { prepareExecutingCodex, LEGACY_CODEX_CONFIG } from './codex-config.mjs';
import { briqMcpEndpoint, briqMcpCapability } from './briq-native.mjs';
import { startAppServer } from './broker.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 't3-codex-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, file: join(home, 'config.toml'), endpoint: 'https://api.example/mcp',
    capability: { BRIQ_MCP_TOKEN: 'explicit-test-grant' } };
}

test('executing native home has the packaged skill without global raw MCP credentials', async t => {
  const f = await fixture(t);
  const result = await prepareExecutingCodex(f);
  const content = await readFile(f.file, 'utf8');
  assert.equal(result.status, 'allocation-scoped');
  assert.deepEqual(result.env, {});
  assert.equal(content.includes('mcp_servers'), false);
  assert.equal(content.includes(f.capability.BRIQ_MCP_TOKEN), false);
  assert.match(content, /multi_agent = false/);
  assert.match(content, /\[shell_environment_policy\]\nignore_default_excludes = false\n\[shell_environment_policy.filters\]\nBRIQ_MCP_TOKEN = "exclude"/);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.home, 'environments.toml'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(f.home, 'environments.toml'), 'utf8'), 'default = "none"\ninclude_local = false\n');
  const skill = join(f.home, '.agents/skills/briq');
  assert.match(await readlink(skill), /t3-cloud\/skills\/briq$/);
  assert.match(await readFile(join(skill, 'SKILL.md'), 'utf8'), /name: briq/);
});

test('missing MCP grant permits offline startup and never claims authentication', async t => {
  const f = await fixture(t);
  const result = await prepareExecutingCodex({ ...f, capability: { BRIQ_API_KEY: 'not-an-mcp-grant' } });
  assert.deepEqual(result, { env: {}, status: 'allocation-scoped' });
  assert.equal((await readFile(f.file, 'utf8')).includes('mcp_servers'), false);
  await stat(join(f.home, '.agents/skills/briq/SKILL.md'));
});

test('actual app-server launch retains only the explicit MCP fake marker and fixed native environment', async t => {
  const f = await fixture(t);
  const launches = [];
  const app = await startAppServer({ home: f.home, briqEndpoint: f.endpoint,
    briqCapability: { ...f.capability, BRIQ_API_KEY: 'not-forwarded', OPENAI_API_KEY: 'not-forwarded', T3_CLOUD_EDGE_TOKEN: 'not-forwarded' } }, {
    checkVersion: (binary, args, options) => { launches.push({ binary, args, options }); return { status: 0, stdout: 'codex-cli 0.166.0\n' }; },
    spawnProcess: (binary, args, options) => {
      launches.push({ binary, args, options });
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.pid = 42; child.exitCode = null; child.signalCode = null;
      child.stdin = new Writable({ write(chunk, encoding, done) {
        const request = JSON.parse(chunk.toString());
        if (request.id) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'));
        done();
      } });
      child.kill = signal => { child.signalCode = signal; queueMicrotask(() => child.emit('exit')); };
      return child;
    },
  });
  try {
    assert.equal(app.briqMcp, 'allocation-scoped');
    assert.equal(app.version, '0.166.0');
    assert.deepEqual(launches.map(value => value.args), [['--version'], ['app-server']]);
    const baseEnv = { HOME: f.home, CODEX_HOME: f.home, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: '/tmp' };
    assert.deepEqual(launches[0].options.env, baseEnv);
    assert.deepEqual(launches[1].options.env, baseEnv);
  } finally { await app.close(); }
});

test('exact legacy and managed configs migrate grant addition, endpoint change and removal', async t => {
  const f = await fixture(t);
  await writeFile(f.file, LEGACY_CODEX_CONFIG, { mode: 0o644 });
  const nativeCredential = join(f.home, 'auth.json');
  await writeFile(nativeCredential, 'native-owner-marker');
  await prepareExecutingCodex(f);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  await prepareExecutingCodex({ ...f, endpoint: 'https://staging.example/mcp' });
  assert.equal((await readFile(f.file, 'utf8')).includes('mcp_servers'), false);
  await prepareExecutingCodex({ ...f, capability: {} });
  assert.equal((await readFile(f.file, 'utf8')).includes('mcp_servers'), false);
  assert.equal(await readFile(nativeCredential, 'utf8'), 'native-owner-marker');
  await prepareExecutingCodex(f);
});

test('generic owner changes and additions to marked configs fail closed', async t => {
  const f = await fixture(t);
  await prepareExecutingCodex(f);
  const managed = await readFile(f.file, 'utf8');
  for (const content of ['# owner config\n', LEGACY_CODEX_CONFIG + '\nmodel = "owner"\n', managed + '\n# owner edit\n', managed.replace('multi_agent = false', 'multi_agent = true')]) {
    await writeFile(f.file, content);
    await assert.rejects(prepareExecutingCodex(f), /configuration changed/);
    assert.equal(await readFile(f.file, 'utf8'), content);
  }
});

test('unknown environments and config symlinks are rejected before config migration', async t => {
  const f = await fixture(t);
  await writeFile(f.file, LEGACY_CODEX_CONFIG);
  const environments = join(f.home, 'environments.toml');
  await writeFile(environments, 'include_local = true\n');
  await assert.rejects(prepareExecutingCodex(f), /configuration changed/);
  assert.equal(await readFile(f.file, 'utf8'), LEGACY_CODEX_CONFIG);
  await rm(environments);
  await rm(f.file);
  const target = join(f.home, 'owner.toml');
  await writeFile(target, LEGACY_CODEX_CONFIG);
  await symlink(target, f.file);
  await assert.rejects(prepareExecutingCodex(f), /configuration changed/);
  assert.equal(await readFile(target, 'utf8'), LEGACY_CODEX_CONFIG);
});

test('existing managed skill collisions are preserved and stop startup', async t => {
  const f = await fixture(t);
  const skill = join(f.home, '.agents/skills/briq');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), 'owner skill');
  await assert.rejects(prepareExecutingCodex(f), /Managed Briq skill changed/);
  assert.equal(await readFile(join(skill, 'SKILL.md'), 'utf8'), 'owner skill');
  await assert.rejects(stat(f.file), { code: 'ENOENT' });
});

test('managed skill root symlinks do not authorize writing into an owner directory', async t => {
  const f = await fixture(t);
  const owner = join(f.home, 'owner-agents');
  await mkdir(owner);
  await symlink(owner, join(f.home, '.agents'));
  await assert.rejects(prepareExecutingCodex(f), /Managed Briq skill changed/);
  await assert.rejects(stat(join(owner, 'skills')), { code: 'ENOENT' });
});

test('only explicitly provisioned MCP token is projected, including when caller passes unrelated credentials', () => {
  assert.deepEqual(briqMcpCapability({ BRIQ_MCP_TOKEN: 'scoped-capability', BRIQ_API_KEY: 'api-key',
    T3_CLOUD_EDGE_TOKEN: 'edge', T3_CLOUD_OWNER_KEY: 'owner', OPENAI_API_KEY: 'provider', HOME: '/owner' }),
  { BRIQ_MCP_TOKEN: 'scoped-capability' });
  assert.deepEqual(briqMcpCapability({ BRIQ_API_KEY: 'api-key' }), {});
  assert.deepEqual(briqMcpCapability({ BRIQ_MCP_TOKEN: '' }), {});
  for (const token of [false, '\nsecret', 'a b', 'secret\u0000'])
    assert.throws(() => briqMcpCapability({ BRIQ_MCP_TOKEN: token }), /Invalid Briq MCP capability/);
});

test('MCP URL validates explicit and API-derived endpoints before TOML serialization', () => {
  assert.equal(briqMcpEndpoint(), 'https://api.briq.cloud/mcp');
  assert.equal(briqMcpEndpoint({ BRIQ_API_URL: 'https://api.example/v1' }), 'https://api.example/mcp');
  assert.equal(briqMcpEndpoint({ BRIQ_MCP_URL: 'https://mcp.example/custom' }), 'https://mcp.example/custom');
  for (const value of ['http://example/mcp', 'https://user:secret@example/mcp', 'https://@example/mcp', 'https://example/mcp?secret=x', 'https://example/mcp#fragment', 'https://example/mcp?', 'https://example/mcp#', 'invalid', 'https://example/mcp\n[mcp_servers.evil]']) {
    assert.throws(() => briqMcpEndpoint({ BRIQ_MCP_URL: value }), /HTTPS endpoint/);
    assert.throws(() => briqMcpEndpoint({ BRIQ_API_URL: value }), /HTTPS endpoint/);
  }
});
