import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const TOKEN = 'runner-integration-test-token';
let port = 0;
let cwd = '';
let stateDir = '';
let runner: ChildProcess | undefined;
let output = '';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a local test port');
  const selected = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return selected;
}

function testEnvironment() {
  const mock = [process.execPath, join(here, 'mock-agent.ts')];
  return {
    PATH: process.env.PATH ?? '',
    HOME: join(cwd, 'isolated-home'),
    RUNNER_TOKEN: TOKEN,
    RUNNER_PORT: String(port),
    RUNNER_HOST: '127.0.0.1',
    RUNNER_CWD: cwd,
    RUNNER_STATE: stateDir,
    RUNNER_LOGINS: join(cwd, '.logins'),
    RUNNER_KEYS: join(cwd, '.logins', 'keys.json'),
    RUNNER_MAX_TURNS: '2',
    RUNNER_ORCHESTRATOR: '1',
    RUNNER_DYNAMIC_ROUTING: '0',
    RUNNER_DELEGATION: '1',
    RUNNER_MEMORY: '1',
    RUNNER_DEFERRED: '1',
    RUNNER_DEFAULT_ROUTE: 'mock',
    RUNNER_ROUTE: 'mock,claude,codex',
    RUNNER_CLIS: JSON.stringify([
      { name: 'mock', acp: mock, status: ['true'] },
      { name: 'claude', acp: mock, status: ['true'] },
      { name: 'codex', acp: mock, status: ['true'] },
    ]),
  };
}

async function startRunner(): Promise<void> {
  output = '';
  runner = spawn(process.execPath, [join(here, '../src/main.ts')], {
    env: testEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-12_000);
  };
  runner.stdout?.on('data', capture);
  runner.stderr?.on('data', capture);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (runner.exitCode !== null) throw new Error(`runner exited before health check: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(300) });
      if (response.ok) return;
    } catch {
      /* Runner is starting or the previous listener is closing. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runner health check timed out: ${output}`);
}

async function stopRunner(): Promise<void> {
  const current = runner;
  if (!current || current.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => current.once('exit', () => resolve()));
  current.kill('SIGTERM');
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([exited, timeout]);
  if (current.exitCode === null) current.kill('SIGKILL');
  runner = undefined;
}

before(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-home-http-'));
  mkdirSync(join(cwd, 'isolated-home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(cwd, '.logins'), { recursive: true, mode: 0o700 });
  mkdirSync(join(cwd, 'project-one'), { recursive: true, mode: 0o700 });
  mkdirSync(join(cwd, 'project-two'), { recursive: true, mode: 0o700 });
  stateDir = join(cwd, '.runner');
  port = await freePort();
  await startRunner();
});

after(async () => {
  await stopRunner();
});

function api(method: string, path: string, body?: unknown, token = TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const explicit = { mode: 'explicit', agentId: 'mock' } as const;
const auto = { mode: 'auto' } as const;

async function task(id: string): Promise<Record<string, any>> {
  const response = await api('GET', `/tasks/${encodeURIComponent(id)}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<Record<string, any>>;
}

async function waitForTask(
  id: string,
  statuses: string[] = ['succeeded', 'failed', 'blocked', 'cancelled'],
): Promise<Record<string, any>> {
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    const result = await task(id);
    if (statuses.includes(result.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`task ${id} did not finish; last state: ${JSON.stringify(await task(id))}`);
}

async function resultText(project: string, ref: string): Promise<string> {
  const response = await api('GET', `/artifacts/${encodeURIComponent(project)}/${encodeURIComponent(ref)}`);
  assert.equal(response.status, 200);
  const artifact = (await response.json()) as { content: string };
  const parsed = JSON.parse(artifact.content) as { text: string; costMicros: number | null };
  assert.equal(parsed.costMicros, null, 'the mock CLI usage/cost is not treated as a provider charge');
  return parsed.text;
}

test('HTTP token protects task APIs and direct delegate access requires a task capability', async () => {
  assert.equal((await api('POST', '/tasks', {}, '')).status, 401);
  assert.equal((await api('POST', '/tasks', {}, 'wrong-token')).status, 401);
  const denied = await fetch(`http://127.0.0.1:${port}/delegate`, {
    method: 'POST',
    headers: { authorization: 'Bearer invalid-task-capability', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'recall' }),
  });
  assert.equal(denied.status, 403);
});

test('project roots are immutable after registration and artifact reads stay project-scoped', async () => {
  const registered = await api('PUT', '/projects/project-one', { root: join(cwd, 'project-one'), revision: 'rev-1' });
  assert.equal(registered.status, 200);
  const moved = await api('PUT', '/projects/project-one', { root: join(cwd, 'project-two'), revision: 'rev-1' });
  assert.equal(moved.status, 400);

  const artifactResponse = await api('POST', '/artifacts/project-one', { content: 'scoped artifact payload' });
  assert.equal(artifactResponse.status, 201);
  const artifact = (await artifactResponse.json()) as { id: string };
  assert.equal((await api('GET', `/artifacts/project-one/${artifact.id}`)).status, 200);
  assert.equal((await api('GET', `/artifacts/home/${artifact.id}`)).status, 404);
});

test('explicit and automatic task routes execute through ACP and keep actual provider cost unknown', async () => {
  for (const [id, route] of [
    ['http-explicit', explicit],
    ['http-auto', auto],
  ] as const) {
    const response = await api('POST', '/tasks', { id, projectId: 'home', prompt: 'hello', route });
    assert.equal(response.status, 202);
    const accepted = (await response.json()) as { task: { id: string } };
    assert.equal(accepted.task.id, id);
    const completed = await waitForTask(id);
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.costMicros, null);
    assert.equal(await resultText('home', completed.outputRef), 'hi');
  }
});

test('batch dependencies complete in order through the task API', async () => {
  const response = await api('POST', '/tasks/batch', {
    tasks: [
      { id: 'batch-prerequisite', projectId: 'home', prompt: 'hello', route: explicit },
      {
        id: 'batch-dependent',
        projectId: 'home',
        prompt: 'hello',
        route: explicit,
        dependencyIds: ['batch-prerequisite'],
      },
    ],
  });
  assert.equal(response.status, 202);
  const first = await waitForTask('batch-prerequisite');
  const second = await waitForTask('batch-dependent');
  assert.deepEqual([first.status, second.status], ['succeeded', 'succeeded']);
  assert.ok(second.dependencyIds.includes(first.id));
});

test('permission options are validated and an explicit valid answer resumes the ACP task', async () => {
  const response = await api('POST', '/tasks', {
    id: 'http-permission',
    projectId: 'home',
    prompt: 'ask',
    route: explicit,
  });
  assert.equal(response.status, 202);
  const until = Date.now() + 5_000;
  let permission: { requestId: string; params: { options: Array<{ optionId: string }> } } | undefined;
  while (Date.now() < until) {
    const pending = await api('GET', '/tasks/http-permission/permissions');
    assert.equal(pending.status, 200);
    const body = (await pending.json()) as { permissions: (typeof permission)[] };
    permission = body.permissions[0];
    if (permission) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(permission, 'mock agent should expose a pending permission');
  const wrong = await api('POST', `/tasks/http-permission/permissions/${permission.requestId}`, {
    optionId: 'not-listed',
  });
  assert.equal(wrong.status, 409);
  const allowed = permission.params.options.find((option) => option.optionId === 'allow')?.optionId;
  assert.ok(allowed);
  const answered = await api('POST', `/tasks/http-permission/permissions/${permission.requestId}`, {
    optionId: allowed,
  });
  assert.equal(answered.status, 200);
  const completed = await waitForTask('http-permission');
  assert.equal(completed.status, 'succeeded');
  assert.match(await resultText('home', completed.outputRef), /outcome: allow/);
});

test('memory writes require cached source provenance, stay project-scoped, and reject credential paths', async () => {
  const source = await api('PUT', '/context/source', {
    project: 'home',
    revision: 'unversioned',
    path: 'docs/decision.txt',
    content: 'Use blue for the status badge.',
  });
  assert.equal(source.status, 200);
  const reference = (await source.json()) as { path: string; hash: string; revision: string };
  const memory = await api('PUT', '/memories', {
    project: 'home',
    key: 'status-badge-color',
    text: 'The status badge color is blue.',
    source: reference,
  });
  assert.equal(memory.status, 200);
  const found = await api('GET', '/memories?projectId=home&query=status%20badge');
  assert.deepEqual(((await found.json()) as { memories: unknown[] }).memories.length, 1);
  const isolated = await api('GET', '/memories?projectId=project-one&query=status%20badge');
  assert.equal(((await isolated.json()) as { memories: unknown[] }).memories.length, 0);

  const credential = await api('PUT', '/context/source', {
    project: 'home',
    revision: 'unversioned',
    path: '.runner/auth.json',
    content: '{"fake":"fixture-only"}',
  });
  assert.equal(credential.status, 400);
  const noProvenance = await api('PUT', '/memories', {
    project: 'home',
    key: 'unverified',
    text: 'A fact without a known source.',
    source: { path: 'docs/missing.txt', hash: '0'.repeat(64), revision: 'unversioned' },
  });
  assert.equal(noProvenance.status, 400);
});

test('stale pricing evidence does not claim a discount for a user-selected window', async () => {
  const now = new Date();
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const start = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const response = await api('POST', '/tasks', {
    id: 'stale-price-window',
    projectId: 'home',
    prompt: 'hello',
    route: explicit,
    deadline: Date.now() + 60 * 60_000,
    schedule: {
      flexibleDeadline: true,
      target: { provider: 'mock', model: 'fake-model' },
      userWindows: [{ start: '00:00', end: '24:00' }],
      pricingSchedule: {
        provider: 'mock',
        model: 'fake-model',
        sourceUrl: 'https://example.invalid/pricing',
        observedAt: '2020-01-01T00:00:00Z',
        expiresAt: '2020-01-02T00:00:00Z',
        discountPercent: 90,
        windows: [{ start, end: '24:00' }],
      },
    },
  });
  assert.equal(response.status, 202);
  const accepted = (await response.json()) as {
    task: { id: string };
    schedule: { basis: string; discount: { status: string } };
  };
  assert.equal(accepted.schedule.basis, 'user-window');
  assert.equal(accepted.schedule.discount.status, 'unknown');
  const completed = await waitForTask('stale-price-window');
  assert.ok(['succeeded', 'failed'].includes(completed.status));
});

test('future queued work survives runner restart with its notBefore timestamp', async () => {
  const notBefore = Date.now() + 60_000;
  const accepted = await api('POST', '/tasks', {
    id: 'restart-queued',
    projectId: 'home',
    prompt: 'hello',
    route: explicit,
    notBefore,
  });
  assert.equal(accepted.status, 202);
  const queued = await waitForTask('restart-queued', ['queued']);
  assert.equal(queued.notBefore, notBefore);
  await stopRunner();
  await startRunner();
  const afterRestart = await task('restart-queued');
  assert.equal(afterRestart.status, 'queued');
  assert.equal(afterRestart.notBefore, notBefore);
  assert.equal((await api('POST', '/tasks/restart-queued/cancel')).status, 200);
});

test('named API profiles coexist while automatic catalog eligibility stays off', async () => {
  const putKey = await api('PUT', '/keys/openrouter', { key: 'test-placeholder-key-only' });
  assert.equal(putKey.status, 200);
  for (const harness of ['claude', 'codex']) {
    const profile = await api('POST', '/profiles', { provider: 'openrouter', harness, model: 'fixture/fake-model' });
    assert.equal(profile.status, 200);
    const created = (await profile.json()) as { name: string; autoEligible?: boolean };
    assert.ok(created.name.startsWith(`openrouter-${harness}`));
    assert.notEqual(created.autoEligible, true);
  }
  const listed = await api('GET', '/keys');
  const profiles = ((await listed.json()) as { profiles: Array<{ name: string; autoEligible?: boolean }> }).profiles;
  assert.ok(profiles.some((profile) => profile.name === 'openrouter-claude'));
  assert.ok(profiles.some((profile) => profile.name === 'openrouter-codex'));
  assert.ok(profiles.every((profile) => profile.autoEligible !== true));
});
