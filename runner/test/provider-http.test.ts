import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test('HTTP provider mutations serialize catalog preparation and keep profile/runtime generations consistent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'provider-http-'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const entered = join(root, 'catalog-entered'),
    release = join(root, 'catalog-release'),
    bootstrap = join(root, 'catalog-mock.mjs');
  // Only the public catalog is mocked. No provider inference or external network
  // is used: this test exercises the actual runner HTTP composition and queue.
  await writeFile(
    bootstrap,
    `import {existsSync,writeFileSync} from 'node:fs';
    const realFetch=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      if(String(input)!=='https://openrouter.ai/api/v1/models')return realFetch(input,init);
      writeFileSync(${JSON.stringify(entered)},'entered');
      while(!existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,5));
      return Response.json({data:[{id:'fixture/model-a',canonical_slug:'fixture/model-a-v1'}]});
    };`,
  );
  const here = fileURLToPath(new URL('.', import.meta.url));
  const child = spawn(process.execPath, ['--import', bootstrap, join(here, '../src/main.ts')], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      RUNNER_TOKEN: 'provider-test-token',
      RUNNER_PORT: String(port),
      RUNNER_HOST: '127.0.0.1',
      RUNNER_CWD: root,
      RUNNER_STATE: join(root, 'state'),
      RUNNER_LOGINS: join(root, 'logins'),
      RUNNER_DYNAMIC_ROUTING: '0',
      RUNNER_CLIS: JSON.stringify([
        { name: 'claude', acp: [process.execPath, join(here, 'mock-agent.ts')], status: ['true'] },
      ]),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk) => {
    logs += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    logs += String(chunk);
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await stopped;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        authorization: 'Bearer provider-test-token',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
  let healthy = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw Error(`runner failed: ${logs}`);
    try {
      if ((await api('GET', '/healthz')).ok) {
        healthy = true;
        break;
      }
    } catch {}
    await delay(20);
  }
  assert.ok(healthy, `runner did not start: ${logs}`);
  assert.equal((await api('POST', '/routing/models', {})).status, 409);
  // JSON parse failure happens inside the queue. The outer route catch must
  // answer the request, and the rejection must not poison subsequent writes.
  const malformed = await fetch(`http://127.0.0.1:${port}/keys/openrouter`, {
    method: 'PUT',
    headers: { authorization: 'Bearer provider-test-token', 'content-type': 'application/json' },
    body: '{',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(malformed.status, 500);
  assert.equal((await api('PUT', '/keys/openrouter', { key: 'fake-test-key-only' })).status, 200);
  const first = api('POST', '/profiles', {
    provider: 'openrouter',
    harness: 'claude',
    name: 'openrouter-claude-ordered',
    model: 'fixture/model-a',
    autoEligible: true,
  });
  let enteredCatalog = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      await readFile(entered);
      enteredCatalog = true;
      break;
    } catch {}
    await delay(10);
  }
  assert.ok(enteredCatalog, 'first mutation must reach the controlled catalog await');
  const second = api('POST', '/profiles', {
    provider: 'openrouter',
    harness: 'claude',
    name: 'openrouter-claude-ordered',
    model: 'fixture/model-b',
  });
  await delay(30);
  await writeFile(release, 'release');
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  const saved = (await (await api('GET', '/keys')).json()) as { profiles: { name: string; model: string }[] };
  const status = (await (await api('GET', '/status')).json()) as {
    clis: { name: string; profile?: { model: string } }[];
  };
  assert.equal(saved.profiles.find((p) => p.name === 'openrouter-claude-ordered')?.model, 'fixture/model-b');
  assert.equal(status.clis.find((c) => c.name === 'openrouter-claude-ordered')?.profile?.model, 'fixture/model-b');
});
