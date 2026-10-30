import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('owner account HTTP APIs isolate sign-in/status/native env and preserve a running turn on disable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'account-http-'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const defaultHome = join(root, 'legacy-claude'),
    statusScript = join(root, 'status.mjs'),
    loginScript = join(root, 'login.mjs');
  await mkdir(defaultHome);
  await writeFile(
    statusScript,
    `console.log(JSON.stringify({loggedIn:true,authMethod:process.env.ANTHROPIC_API_KEY?'api_key':'claude.ai'}));`,
  );
  await writeFile(
    loginScript,
    `import{writeFileSync}from'node:fs';writeFileSync(process.env.CLAUDE_CONFIG_DIR+'/login-observed.json',JSON.stringify({config:process.env.CLAUDE_CONFIG_DIR,apiKey:process.env.ANTHROPIC_API_KEY,base:process.env.ANTHROPIC_BASE_URL}));console.log('https://auth.example.test/login');setTimeout(()=>process.exit(0),200);`,
  );
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      CLAUDE_CONFIG_DIR: defaultHome,
      ANTHROPIC_API_KEY: 'fixture-api-key',
      RUNNER_TOKEN: 'account-test',
      RUNNER_PORT: String(port),
      RUNNER_HOST: '127.0.0.1',
      RUNNER_CWD: root,
      RUNNER_STATE: join(root, 'state'),
      RUNNER_LOGINS: join(root, 'logins'),
      RUNNER_MAX_TURNS: '2',
      RUNNER_DYNAMIC_ROUTING: '0',
      RUNNER_EXTENSIONS: '0',
      RUNNER_CLIS: JSON.stringify([
        {
          name: 'claude',
          oneRefresher: true,
          acp: [process.execPath, fileURLToPath(new URL('./mock-agent.ts', import.meta.url))],
          status: [process.execPath, statusScript],
          login: [process.execPath, loginScript],
        },
      ]),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (b) => {
    logs = (logs + b).slice(-16000);
  });
  child.stderr.on('data', (b) => {
    logs = (logs + b).slice(-16000);
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await done;
      clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  });
  const api = (method: string, path: string, body?: unknown, token = 'account-test') =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await api('GET', '/healthz')).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) throw Error(logs);
    await pause(20);
  }
  assert.ok(ready, logs);
  assert.equal((await api('GET', '/accounts', undefined, 'wrong')).status, 401);
  const initial = (await (await api('GET', '/accounts')).json()) as any;
  assert.equal(initial.accounts.length, 1);
  assert.equal(initial.accounts[0].cli, 'claude');
  for (const input of [
    { label: 'x', harness: 'codex' },
    { label: 'x', token: 'not-accepted' },
    { label: 'x'.repeat(81) },
  ])
    assert.equal((await api('POST', '/accounts', input)).status, 400);
  const created = await api('POST', '/accounts', { harness: 'claude', label: 'Second subscription' });
  assert.equal(created.status, 201);
  const { account } = (await created.json()) as any;
  const status = (await (await api('GET', '/status')).json()) as any;
  const named = status.clis.find((c: any) => c.name === account.cli);
  assert.equal(named.subscriptionAccount.label, 'Second subscription');
  assert.equal(named.profile, undefined);
  assert.equal(named.signInWith, 'page');
  assert.equal(named.signedIn, true);
  assert.equal(named.billing, 'subscription');
  assert.equal(status.clis.find((c: any) => c.name === 'claude').billing, 'use');
  assert.equal(
    status.clis.find((c: any) => c.name === 'claude').signedIn,
    true,
    'existing API-key login reports its actual auth state',
  );
  const poll = async (id: string, predicate: (task: any) => boolean) => {
    const until = Date.now() + 8000;
    let task: any;
    while (Date.now() < until) {
      task = await (await api('GET', `/tasks/${id}`)).json();
      if (predicate(task)) return task;
      await pause(15);
    }
    throw Error(`task did not reach expected state: ${JSON.stringify(task)}; ${logs}`);
  };
  const submit = async (id: string, prompt: string, explicit?: string) => {
    const res = await api('POST', '/tasks', {
      id,
      projectId: 'home',
      prompt,
      route: explicit ? { mode: 'explicit', agentId: explicit } : { mode: 'auto' },
    });
    assert.equal(res.status, 202);
    return poll(id, (task) => ['succeeded', 'failed', 'blocked', 'cancelled'].includes(task.status));
  };
  const output = async (task: any) =>
    JSON.parse(((await (await api('GET', `/artifacts/home/${task.outputRef}`)).json()) as any).content);
  // Default inherited API mode stays metered. Without paid consent, Auto uses the native subscription alias.
  const automatic = await submit('auto-env', 'env');
  assert.equal(automatic.status, 'succeeded');
  const result = await output(automatic);
  assert.equal(result.route.cli, account.cli);
  const observed = JSON.parse(result.text);
  assert.equal(observed.config, join(root, 'logins', 'accounts', account.id, 'claude'));
  assert.equal(observed.apiKey, undefined);
  assert.equal(observed.base, undefined);
  const accepted = await api('POST', '/tasks', {
    id: 'active-turn',
    projectId: 'home',
    prompt: 'slow',
    route: { mode: 'explicit', agentId: account.cli },
  });
  assert.equal(accepted.status, 202);
  await poll('active-turn', (task) => task.status === 'running' && task.sessionRef !== null);
  assert.equal((await api('POST', `/connect/${account.cli}`, { wait: false })).status, 409);
  assert.equal(
    (await api('PATCH', `/accounts/${account.id}`, { enabled: false, label: 'Renamed account' })).status,
    200,
  );
  const live = (await (await api('GET', '/status')).json()) as any;
  assert.equal(live.clis.find((c: any) => c.name === account.cli).running, true);
  assert.equal(live.clis.find((c: any) => c.name === account.cli).subscriptionAccount.enabled, false);
  const done = await poll('active-turn', (task) => ['succeeded', 'failed'].includes(task.status));
  assert.equal(done.status, 'succeeded');
  assert.equal((await output(done)).route.cli, account.cli);
  const unavailable = await submit('auto-disabled', 'hello');
  assert.equal(unavailable.status, 'failed');
  // Owner-explicit choice remains available even when excluded from Auto.
  const explicit = await submit('explicit-disabled', 'hello', account.cli);
  assert.equal(explicit.status, 'succeeded');
  assert.equal((await api('POST', `/connect/${account.cli}`, { wait: false })).status, 200);
  let ended = false;
  for (let i = 0; i < 100; i++) {
    const state = (await (await api('GET', `/connect/${account.cli}`)).json()) as any;
    if (state.state === 'done') {
      ended = true;
      break;
    }
    await pause(20);
  }
  assert.ok(ended);
  const loginEnv = JSON.parse(await readFile(join(observed.config, 'login-observed.json'), 'utf8'));
  assert.deepEqual(loginEnv, { config: observed.config });
  assert.equal((await api('DELETE', `/accounts/${account.id}`)).status, 405);
  assert.equal((await api('PATCH', '/accounts/missing', { enabled: false })).status, 404);
  const saved = JSON.parse(await readFile(join(root, 'state', 'accounts.json'), 'utf8'));
  assert.equal(saved.accounts.find((a: any) => a.id === account.id).enabled, false);
});
