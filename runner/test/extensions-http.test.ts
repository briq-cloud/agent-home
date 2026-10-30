import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Application } from '../src/app/services.ts';
import { configuration } from '../src/app/config.ts';
import { Hub } from '../src/acp/hub.ts';
import { Keys } from '../src/providers/profiles.ts';

function fixture(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'extensions-http-'));
  const config = configuration({
    RUNNER_CWD: root,
    RUNNER_STATE: join(root, 'state'),
    RUNNER_DYNAMIC_ROUTING: '0',
    ...env,
  });
  const keys = new Keys({ keysFile: join(root, 'keys.json'), profilesFile: join(root, 'profiles.json'), logins: root });
  const make = () => {
    const hub = new Hub({
      clis: [{ name: 'codex', acp: [process.execPath] }],
      cwd: root,
      stateDir: config.stateDir,
      env: { HOME: root },
      maxTurns: 2,
    });
    return new Application({
      config,
      hub,
      keys,
      table: () => [],
      signedIn: async () => false,
      authEnv: {},
      extensionEnv: () => ({ OWNER_TOOL_TOKEN: 'private-runtime-value-not-public' }),
    });
  };
  let app = make();
  t.after(async () => {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const request = async (method: string, path: string, input: Record<string, unknown> = {}) => {
    let code = 0,
      result: any;
    await app.http(
      { method } as IncomingMessage,
      {
        writeHead: (value: number) => {
          code = value;
        },
        end: (value: string) => {
          result = JSON.parse(value);
        },
      } as unknown as ServerResponse,
      new URL(path, 'http://localhost'),
      async () => input,
    );
    return { code, result };
  };
  return {
    request,
    get app() {
      return app;
    },
    restart: async () => {
      await app.stop();
      app = make();
    },
  };
}

test('extension flag defaults on and deployment accepts only explicit strict public metadata', () => {
  assert.equal(configuration({}).extensions, true);
  assert.equal(configuration({ RUNNER_EXTENSIONS: '0' }).extensions, false);
  const deployment = { platform: 'briq', apiUrl: 'https://api.example.test', homeId: 'home', stackId: 'stack' };
  assert.deepEqual(configuration({ RUNNER_DEPLOYMENT_CONTEXT: JSON.stringify(deployment) }).deployment, deployment);
  for (const value of [
    { ...deployment, token: 'PRIVATE-CONFIG-TOKEN' },
    { ...deployment, apiUrl: 'https://user:PRIVATE-CONFIG-TOKEN@api.example.test' },
    { ...deployment, apiUrl: 'https://api.example.test?token=PRIVATE-CONFIG-TOKEN' },
    { ...deployment, platform: 'other' },
  ]) {
    assert.throws(
      () => configuration({ RUNNER_DEPLOYMENT_CONTEXT: JSON.stringify(value) }),
      (error: unknown) => error instanceof Error && !error.message.includes('PRIVATE-CONFIG-TOKEN'),
    );
  }
});

test('owner extension CRUD exposes credential references/destination metadata and hashes, never values or skill bodies', async (t) => {
  const h = fixture(t);
  assert.equal((await h.request('GET', '/features')).result.extensions, true);
  const initial = await h.request('GET', '/extensions');
  assert.equal(initial.code, 200);
  assert.equal(initial.result.skills.length, 2);
  const server = {
    name: 'owner-tool',
    transport: 'http',
    url: 'https://tools.example.test/mcp',
    headerEnvRefs: { Authorization: { env: 'OWNER_TOOL_TOKEN', prefix: 'Bearer ' } },
  };
  assert.equal((await h.request('PUT', '/extensions/mcp/owner-tool', server)).code, 200);
  assert.equal(
    (
      await h.request('PUT', '/extensions/skills/home-owner', {
        name: 'home-owner',
        description: 'Owner selected guidance',
        body: 'PRIVATE-SKILL-BODY',
      })
    ).code,
    200,
  );
  const listed = await h.request('GET', '/extensions');
  assert.equal(listed.result.servers[0].url, server.url);
  assert.deepEqual(listed.result.servers[0].headerEnvRefs, server.headerEnvRefs);
  assert.ok(
    listed.result.agents[0].statuses.some(
      (status: any) => status.name === 'owner-tool' && status.status === 'unverified',
    ),
  );
  assert.ok(!JSON.stringify(listed).includes('private-runtime-value-not-public'));
  assert.ok(!JSON.stringify(listed).includes('PRIVATE-SKILL-BODY'));
  assert.match(listed.result.skills.find((skill: any) => skill.name === 'home-owner').hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    await h.request('PUT', '/extensions/mcp/owner-tool', {
      ...server,
      headers: [{ name: 'Authorization', value: 'PRIVATE-PLAINTEXT-TOKEN' }],
    }),
    { code: 400, result: { error: 'invalid_extension_configuration' } },
  );
  assert.equal((await h.request('PUT', '/extensions/mcp/other-name', server)).code, 400);
  assert.equal(
    (
      await h.request('PUT', '/extensions/skills/home-owner', {
        name: 'home-owner',
        description: 'x',
        body: 'x',
        extra: true,
      })
    ).code,
    400,
  );
  assert.equal((await h.request('DELETE', '/extensions/mcp/owner-tool')).code, 200);
  const removed = await h.request('DELETE', '/extensions/skills/home-briq');
  assert.equal(removed.result.userFilesPreserved, true);
  await h.restart();
  const after = await h.request('GET', '/extensions');
  assert.equal(after.result.servers.length, 0);
  assert.ok(
    !after.result.skills.some((skill: any) => skill.name === 'home-briq'),
    'logical deletion must survive restart; do not reinstall builtins each boot',
  );
});

test('optional deployment Briq reports authentication required and opt-out disables owner extension routes', async (t) => {
  const h = fixture(t, {
    RUNNER_DEPLOYMENT_CONTEXT: JSON.stringify({
      platform: 'briq',
      apiUrl: 'https://api.example.test',
      homeId: 'home',
      stackId: 'stack',
    }),
  });
  const listed = await h.request('GET', '/extensions');
  const briq = listed.result.servers.find((server: any) => server.name === 'briq');
  assert.equal(briq.url, 'https://api.example.test/mcp');
  assert.equal(briq.required, false);
  assert.equal(listed.result.agents[0].statuses.find((status: any) => status.name === 'briq').status, 'auth_required');
  const off = fixture(t, { RUNNER_EXTENSIONS: '0' });
  assert.equal(off.app.extensions, undefined);
  assert.deepEqual(await off.request('GET', '/extensions'), { code: 403, result: { error: 'extensions_disabled' } });
});
