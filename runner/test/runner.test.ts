import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

/** The runner against the mock agent, over WebSocket as an app would reach it. */
const here = fileURLToPath(new URL('.', import.meta.url));
const TOKEN = 'test-token';
const PORT = 40_000 + Math.floor(Math.random() * 20_000);
let runner: ChildProcess;
let home = '';
const TERMINAL_PORT = PORT + 1;
/** What the fake terminal saw of the last request's cookie: the runner's own must not reach it. */
let terminalCookie: string | undefined;
let stopTerminal = () => {};
/** Codex's way: 30 days from the last refresh. */
const REFRESHED = '2026-10-20T10:00:00Z';
/** Claude's way: a fixed end, three days away. */
const ENDS = Date.now() + 3 * 86_400_000;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'));
  home = dir;
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'secret' }, last_refresh: REFRESHED }));
  writeFileSync(join(dir, 'fixed.json'), JSON.stringify({ oauth: { refreshToken: 'secret', refreshTokenExpiresAt: ENDS } }));
  const mock = [process.execPath, join(here, 'mock-agent.ts')];
  // A stand-in for ttyd: a page under /terminal/, and a WebSocket that echoes.
  const fake = createServer((req, res) => {
    terminalCookie = req.headers.cookie;
    res.end(`ttyd at ${req.url}`);
  });
  const echo = new WebSocketServer({ server: fake });
  echo.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo ${m}`)));
  await new Promise<void>((r) => fake.listen(TERMINAL_PORT, '127.0.0.1', () => r()));
  stopTerminal = () => {
    echo.close();
    fake.closeAllConnections();
    fake.close();
  };
  runner = spawn(process.execPath, [join(here, '../src/main.ts')], {
    env: {
      PATH: process.env.PATH,
      RUNNER_TOKEN: TOKEN,
      RUNNER_PORT: String(PORT),
      RUNNER_HOST: '127.0.0.1',
      RUNNER_CWD: dir,
      RUNNER_STATE: join(dir, 'state'),
      RUNNER_LOGINS: join(dir, 'logins'),
      RUNNER_MAX_TURNS: '1',
      RUNNER_TERMINAL: `http://127.0.0.1:${TERMINAL_PORT}`,
      RUNNER_ROUTE: 'off,mock,second',
      MOCK_HOME: dir,
      RUNNER_CLIS: JSON.stringify([
        {
          name: 'mock',
          acp: mock,
          login: ['sh', '-c', 'echo "Open https://example.test/device and enter ABCD-EFGH"; sleep 2'],
          status: ['true'],
          signIn: { file: '$MOCK_HOME/auth.json', refreshedAt: 'last_refresh', days: 30, refreshAfterDays: 8 },
        },
        { name: 'flaky', acp: mock, login: ['true'], status: ['sh', '-c', 'kill -TERM $$'] },
        { name: 'fixed', acp: mock, login: ['true'], signIn: { file: '$MOCK_HOME/fixed.json', endsAt: 'refreshTokenExpiresAt' } },
        // For /acp: one never signed in, one more to route to.
        { name: 'off', acp: mock, login: ['true'], status: ['false'] },
        { name: 'second', acp: mock, login: ['true'], status: ['true'] },
        // A sign-in in the terminal, and API keys: one set, one not.
        { name: 'term', acp: mock, terminalLogin: 'term auth login' },
        { name: 'keyed', acp: mock, apiKeys: ['GOOGLE_API_KEY'] },
        { name: 'keyless', acp: mock, apiKeys: ['GEMINI_API_KEY'], keyFrom: 'google', blockedAuth: ['personal'] },
        // The harnesses a profile runs: the image's own claude and codex.
        { name: 'claude', acp: mock, login: ['true'], status: ['true'] },
        { name: 'codex', acp: mock, login: ['true'], status: ['true'] },
      ]),
      GOOGLE_API_KEY: 'placeholder',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('runner did not start');
});

after(() => {
  runner.kill();
  stopTerminal();
});

type Msg = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: any; result?: any; error?: any };

/** An ACP client over a raw WebSocket: requests, the notifications it got, the requests it got. */
class App {
  readonly got: Msg[] = [];
  private readonly ws: WebSocket;
  private next = 1;
  private readonly waiting = new Map<string | number, (m: Msg) => void>();
  private readonly watchers: Array<() => void> = [];

  constructor(path = '/acp/mock') {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    this.ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Msg;
      if (m.method === undefined && m.id !== undefined) this.waiting.get(m.id)?.(m);
      else this.got.push(m);
      for (const w of this.watchers) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  request(method: string, params: unknown): Promise<Msg> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  answer(id: string | number, result: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  /** The first message received that matches, now or later. */
  until(match: (m: Msg) => boolean, ms = 5000): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), ms);
      const check = () => {
        const m = this.got.find(match);
        if (m) {
          clearTimeout(timer);
          resolve(m);
        }
      };
      this.watchers.push(check);
      check();
    });
  }

  texts(): string[] {
    return this.got
      .filter((m) => m.method === 'session/update' && m.params.update.sessionUpdate === 'agent_message_chunk')
      .map((m) => m.params.update.content.text);
  }

  close(): void {
    this.ws.close();
  }
}

async function connect(path = '/acp/mock', agent = 'mock'): Promise<App> {
  const app = new App(path);
  await app.open();
  const init = await app.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(init.result.agentInfo.name, agent);
  return app;
}

const say = (sessionId: string, text: string) => ({ sessionId, prompt: [{ type: 'text', text }] });
const turnEnded = (sessionId: string) => (m: Msg) =>
  m.method === '_runner/turn' && m.params.sessionId === sessionId && m.params.state === 'idle';

test('refuses a caller without the key, and says what it runs', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/status`)).status, 401);
  const status = await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const clis = (await status.json()).clis;
  assert.deepEqual(clis.map((c: { name: string; signedIn: boolean }) => [c.name, c.signedIn]), [
    ['mock', true],
    ['flaky', null],
    ['fixed', null],
    ['off', false],
    ['second', true],
    ['term', null],
    ['keyed', true],
    ['keyless', false],
    ['claude', true],
    ['codex', true],
  ]);
  const by = Object.fromEntries(clis.map((c: { name: string }) => [c.name, c]));
  assert.equal(by.mock.signInWith, 'page');
  assert.deepEqual([by.term.signInWith, by.term.command], ['terminal', 'term auth login']);
  assert.deepEqual([by.keyless.signInWith, by.keyless.apiKeys], ['api-key', ['GEMINI_API_KEY']]);
  const term = await fetch(`http://127.0.0.1:${PORT}/connect/term`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(term.status, 409);
  assert.match((await term.json()).error, /signs in in the terminal: term auth login/);
  // The dates of each sign-in, never its tokens.
  assert.deepEqual(clis[0].life, {
    endsAt: '2026-11-19T10:00:00.000Z',
    renews: true,
    endsSoon: Date.parse('2026-11-19T10:00:00Z') - Date.now() < 7 * 86_400_000,
    refreshableAt: '2026-10-28T10:00:00.000Z',
  });
  assert.deepEqual(clis[2].life, { endsAt: new Date(ENDS).toISOString(), renews: false, endsSoon: true });
  assert.doesNotMatch(JSON.stringify(clis), /secret/);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/acp/mock`);
  await assert.rejects(new Promise((_, reject) => ws.once('error', reject)));
});

test('runs a turn: the CLI answers, the turn starts and ends', async () => {
  const app = await connect();
  const { result } = await app.request('session/new', { cwd: '/tmp', mcpServers: [] });
  const done = await app.request('session/prompt', say(result.sessionId, 'hello'));
  assert.equal(done.result.stopReason, 'end_turn');
  assert.deepEqual(app.texts(), ['hi']);
  await app.until(turnEnded(result.sessionId));
  app.close();
});

test('passes a permission to the app and its answer back', async () => {
  const app = await connect();
  const { result } = await app.request('session/new', { cwd: '/tmp', mcpServers: [] });
  const turn = app.request('session/prompt', say(result.sessionId, 'ask'));
  const asked = await app.until((m) => m.method === 'session/request_permission');
  app.answer(asked.id as string, { outcome: { outcome: 'selected', optionId: 'allow' } });
  assert.equal((await turn).result.stopReason, 'end_turn');
  assert.deepEqual(app.texts(), ['asking', 'outcome: allow']);
  app.close();
});

test('holds a permission while no app is there, and replays the session to the next one', async () => {
  const first = await connect();
  const { result } = await first.request('session/new', { cwd: '/tmp', mcpServers: [] });
  const id = result.sessionId;
  void first.request('session/prompt', say(id, 'ask'));
  await first.until((m) => m.method === 'session/request_permission');
  first.close();

  const next = await connect();
  await next.request('session/load', { sessionId: id, cwd: '/tmp', mcpServers: [] });
  const asked = await next.until((m) => m.method === 'session/request_permission');
  // What happened before it came, from the runner's log: the prompt and the first answer.
  const prompt = next.got.find((m) => m.params?.update?.sessionUpdate === 'user_message_chunk');
  assert.equal(prompt?.params.update.content.text, 'ask');
  assert.deepEqual(next.texts(), ['asking']);
  next.answer(asked.id as string, { outcome: { outcome: 'selected', optionId: 'deny' } });
  const ended = await next.until(turnEnded(id));
  assert.equal(ended.params.stopReason, 'end_turn');
  assert.deepEqual(next.texts(), ['asking', 'outcome: deny']);
  next.close();
});

test('queues a turn over the limit, and says where it is', async () => {
  const app = await connect();
  const a = (await app.request('session/new', { cwd: '/tmp', mcpServers: [] })).result.sessionId;
  const b = (await app.request('session/new', { cwd: '/tmp', mcpServers: [] })).result.sessionId;
  const slow = app.request('session/prompt', say(a, 'slow'));
  const quick = app.request('session/prompt', say(b, 'hello'));
  const queued = await app.until((m) => m.method === '_runner/turn' && m.params.sessionId === b && m.params.state === 'queued');
  assert.equal(queued.params.position, 1);
  assert.equal((await slow).result.stopReason, 'end_turn');
  assert.equal((await quick).result.stopReason, 'end_turn');
  app.close();
});

test('loads a session into a new CLI process after a crash, without repeating its events', async () => {
  const app = await connect();
  const id = (await app.request('session/new', { cwd: '/tmp', mcpServers: [] })).result.sessionId;
  await app.request('session/prompt', say(id, 'hello'));
  const died = await app.request('session/prompt', say(id, 'die'));
  assert.ok(died.error, 'the turn fails when its CLI exits');
  app.close();

  const next = await connect();
  await next.request('session/load', { sessionId: id, cwd: '/tmp', mcpServers: [] });
  assert.deepEqual(next.texts(), ['hi']);
  const again = await next.request('session/prompt', say(id, 'hello'));
  assert.equal(again.result.stopReason, 'end_turn');
  assert.deepEqual(next.texts(), ['hi', 'hi']);
  next.close();
});

test('starts the vendor sign-in and gives its page and code', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/connect/mock`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.deepEqual(await res.json(), { state: 'waiting', url: 'https://example.test/device', code: 'ABCD-EFGH' });
});

test('refreshes a sign-in that a refresh renews, and says why not for one that only a sign-in does', async () => {
  const post = (cli: string) =>
    fetch(`http://127.0.0.1:${PORT}/refresh/${cli}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  const ok = await post('mock');
  assert.equal(ok.status, 200);
  // The mock's file does not change: the end did not move.
  assert.deepEqual(await ok.json(), { name: 'mock', moved: false, life: (await (await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).clis[0].life });
  const no = await post('fixed');
  assert.equal(no.status, 409);
  assert.match((await no.json()).error, /sign in again/);
});

test('serves the page through its link once, then by cookie', async () => {
  const base = `http://127.0.0.1:${PORT}`;
  assert.equal((await fetch(`${base}/`)).status, 401);
  const link = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' });
  assert.equal(link.status, 303);
  assert.equal(link.headers.get('location'), '/');
  const cookie = (link.headers.get('set-cookie') ?? '').split(';')[0] as string;
  assert.match(link.headers.get('set-cookie') ?? '', /HttpOnly; Secure; SameSite=Strict/);
  const page = await fetch(`${base}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Agent home<\/title>/);
  assert.equal((await fetch(`${base}/status`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/`, { headers: { cookie: 'agent_home_runner=wrong' } })).status, 401);
});

test('puts the terminal behind the same door, its WebSocket too, without the runner cookie', async () => {
  const base = `http://127.0.0.1:${PORT}`;
  const cookie = `agent_home_runner=${TOKEN}; briq_token=b`;
  assert.equal((await fetch(`${base}/terminal/`)).status, 401);
  const page = await fetch(`${base}/terminal/`, { headers: { cookie } });
  assert.equal(await page.text(), 'ttyd at /terminal/');
  assert.equal(terminalCookie, 'briq_token=b');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/terminal/ws`, { headers: { cookie } });
  await new Promise((r) => ws.once('open', r));
  ws.send('hi');
  const reply = await new Promise<string>((r) => ws.once('message', (data) => r(String(data))));
  assert.equal(reply, 'echo hi');
  ws.close();
});

test('counts what the sessions used, from the logs, per session, per CLI and per day', async () => {
  const app = await connect();
  const id = (await app.request('session/new', { cwd: '/tmp', mcpServers: [] })).result.sessionId;
  await app.request('session/prompt', say(id, 'hello'));
  await app.request('session/prompt', say(id, 'hello'));
  app.close();
  const usage = await (await fetch(`http://127.0.0.1:${PORT}/usage`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const mine = usage.sessions.find((s: { id: string }) => s.id === id);
  assert.equal(mine.turns, 2);
  assert.equal(mine.tokens.total, 220);
  assert.deepEqual(mine.cost, { amount: 0.1, currency: 'USD' });
  assert.deepEqual(mine.context, { used: 2000, size: 200000 });
  const mock = usage.clis.find((c: { name: string }) => c.name === 'mock');
  const today = mock.days[new Date().toISOString().slice(0, 10)];
  assert.ok(today.turns >= 2 && today.tokens.total >= 220);
  assert.deepEqual(mock.limits.value, { status: 'allowed', resetsAt: 1800000000 });
  assert.equal(mock.limits.key, '_mock/rateLimit');
});

test('/acp routes each session: the CLI asked for, else the first fit, skipping one signed out', async () => {
  const app = await connect('/acp', 'agent-home');
  const picked = await app.request('session/new', { cwd: '/tmp', mcpServers: [] });
  // `off` comes first in the route but is signed out: the next one, with its own capabilities.
  assert.equal(picked.result._meta.agentHome.cli, 'mock');
  assert.equal(picked.result._meta.agentHome.agentCapabilities.loadSession, true);
  const asked = await app.request('session/new', { cwd: '/tmp', mcpServers: [], _meta: { agentHome: { cli: 'second' } } });
  assert.equal(asked.result._meta.agentHome.cli, 'second');
  // Later calls go to the CLI that holds the session, whatever the endpoint.
  const done = await app.request('session/prompt', say(asked.result.sessionId, 'hello'));
  assert.equal(done.result.stopReason, 'end_turn');
  const none = await app.request('session/new', { cwd: '/tmp', mcpServers: [], _meta: { agentHome: { cli: 'nope' } } });
  assert.match(none.error.message, /no CLI named nope/);
  app.close();

  // A session started on /acp loads again on /acp, by its id alone.
  const back = await connect('/acp', 'agent-home');
  const loaded = await back.request('session/load', { sessionId: asked.result.sessionId, cwd: '/tmp', mcpServers: [] });
  assert.ok(!loaded.error);
  assert.deepEqual(back.texts(), ['hi']);
  back.close();
});

test('/acp gives a plan nearly used up a session last, until it says otherwise', async () => {
  const app = await connect('/acp', 'agent-home');
  const first = await app.request('session/new', { cwd: '/tmp', mcpServers: [] });
  assert.equal(first.result._meta.agentHome.cli, 'mock');
  // The mock says a window of its plan is 95% used: the next session goes to another CLI.
  await app.request('session/prompt', say(first.result.sessionId, 'hot'));
  const next = await app.request('session/new', { cwd: '/tmp', mcpServers: [] });
  assert.equal(next.result._meta.agentHome.cli, 'second');
  // Its next report has no full window: first again.
  await app.request('session/prompt', say(first.result.sessionId, 'hello'));
  const again = await app.request('session/new', { cwd: '/tmp', mcpServers: [] });
  assert.equal(again.result._meta.agentHome.cli, 'mock');
  app.close();
});

test('/acp leaves out a CLI that hit its plan limit, until its reset', async () => {
  const app = await connect('/acp', 'agent-home');
  const first = await app.request('session/new', { cwd: '/tmp', mcpServers: [] });
  assert.equal(first.result._meta.agentHome.cli, 'mock');
  const limited = await app.request('session/prompt', say(first.result.sessionId, 'limit'));
  assert.match(limited.error.message, /usage limit/);
  const next = await app.request('session/new', { cwd: '/tmp', mcpServers: [] });
  assert.equal(next.result._meta.agentHome.cli, 'second');
  const status = await (await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.ok(status.limited.mock);
  app.close();
});

test('the bridge makes the home a local ACP agent, the folder of the client mapped to one on the home', async () => {
  const bridge = spawn(process.execPath, [join(here, '../bin/agent-home-acp.ts'), `ws://127.0.0.1:${PORT}/acp/mock`], {
    env: { PATH: process.env.PATH, AGENT_HOME_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const answers = new Map<number, Msg>();
  const updates: Msg[] = [];
  let buffer = '';
  bridge.stdout?.on('data', (b: Buffer) => {
    buffer += b.toString();
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const m = JSON.parse(buffer.slice(0, i)) as Msg;
      buffer = buffer.slice(i + 1);
      if (m.method === undefined && typeof m.id === 'number') answers.set(m.id, m);
      else updates.push(m);
    }
  });
  const ask = async (id: number, method: string, params: unknown) => {
    bridge.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let i = 0; i < 100 && !answers.has(id); i++) await new Promise((r) => setTimeout(r, 50));
    return answers.get(id) as Msg;
  };
  assert.equal((await ask(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })).result.agentInfo.name, 'mock');
  const created = await ask(2, 'session/new', { cwd: '/Users/ana/shop', mcpServers: [] });
  assert.equal(created.result._meta.cwd, '/work/shop');
  const done = await ask(3, 'session/prompt', say(created.result.sessionId, 'hello'));
  assert.equal(done.result.stopReason, 'end_turn');
  assert.ok(updates.some((m) => m.params?.update?.content?.text === 'hi'));
  bridge.kill();
});

test('never offers a sign-in method the home blocks, and refuses it', async () => {
  const app = new App('/acp/keyless');
  await app.open();
  const init = await app.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual(init.result.authMethods.map((m: { id: string }) => m.id), ['api-key']);
  const refused = await app.request('authenticate', { methodId: 'personal' });
  assert.match(refused.error.message, /does not sign in with personal/);
  const allowed = await app.request('authenticate', { methodId: 'api-key' });
  assert.ok(!allowed.error);
  app.close();
});

const api = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

/** A turn that says `env`: what the CLI behind a path was started with. */
async function envOf(path: string): Promise<Record<string, string | undefined>> {
  const app = await connect(path);
  const s = await app.request('session/new', { cwd: '/tmp', mcpServers: [] });
  await app.request('session/prompt', say(s.result.sessionId, 'env'));
  const out = JSON.parse(app.texts().at(-1) as string);
  app.close();
  return out;
}

test('keeps a key on the home, never gives it back, and runs a provider with Claude Code', async () => {
  assert.equal((await api('POST', '/profiles', { provider: 'zai', harness: 'claude' })).status, 409);
  assert.equal((await api('PUT', '/keys/zai', { key: 'zai-secret-key' })).status, 200);
  const listed = await (await api('GET', '/keys')).json();
  assert.equal(listed.providers.find((p: { id: string }) => p.id === 'zai').set, true);
  assert.doesNotMatch(JSON.stringify(listed), /zai-secret-key/);
  assert.equal(statSync(join(home, 'logins', 'keys.json')).mode & 0o777, 0o600);
  const made = await (await api('POST', '/profiles', { provider: 'zai', harness: 'claude' })).json();
  assert.deepEqual(made, { name: 'zai-claude', provider: 'zai', harness: 'claude', acp: '/acp/zai-claude' });
  const status = await (await api('GET', '/status')).json();
  const profile = status.clis.find((c: { name: string }) => c.name === 'zai-claude');
  assert.deepEqual([profile.signedIn, profile.signInWith, profile.profile], [true, 'api-key', { provider: 'zai', harness: 'claude' }]);
  assert.doesNotMatch(JSON.stringify(status), /zai-secret-key/);
  // Its own settings folder, never the person's Claude sign-in; the provider maps Claude's model names.
  assert.deepEqual(await envOf('/acp/zai-claude'), {
    base: 'https://api.z.ai/api/anthropic',
    token: 'zai-secret-key',
    config: join(home, 'logins', 'profiles', 'zai-claude'),
  });
  // `/acp` never picks a profile it was not told to: a key may be billed by use.
  const app = await connect('/acp', 'agent-home');
  const picked = await app.request('session/new', { cwd: '/tmp', mcpServers: [] });
  assert.notEqual(picked.result._meta.agentHome.cli, 'zai-claude');
  const named = await app.request('session/new', { cwd: '/tmp', mcpServers: [], _meta: { agentHome: { cli: 'zai-claude' } } });
  assert.equal(named.result._meta.agentHome.cli, 'zai-claude');
  app.close();
});

test('a provider that names its model, with Claude Code or Codex; a new key restarts its profiles', async () => {
  assert.equal((await api('PUT', '/keys/openrouter', { key: 'or-first-key' })).status, 200);
  const noModel = await api('POST', '/profiles', { provider: 'openrouter', harness: 'codex' });
  assert.equal(noModel.status, 200);
  assert.equal((await noModel.json()).model, 'openrouter/auto');
  assert.equal((await api('POST', '/profiles', { provider: 'zai', harness: 'codex' })).status, 400);
  assert.equal((await api('POST', '/profiles', { provider: 'openrouter', harness: 'codex', model: 'vendor/some-model' })).status, 200);
  assert.equal((await api('POST', '/profiles', { provider: 'openrouter', harness: 'claude', model: 'vendor/some-model' })).status, 200);
  const codex = await envOf('/acp/openrouter-codex');
  assert.deepEqual(codex, { codexHome: join(home, 'logins', 'profiles', 'openrouter-codex'), codexKey: 'or-first-key' });
  const config = readFileSync(join(codex.codexHome as string, 'config.toml'), 'utf8');
  assert.match(config, /model = "vendor\/some-model"/);
  assert.match(config, /base_url = "https:\/\/openrouter.ai\/api\/v1"/);
  assert.match(config, /wire_api = "responses"/);
  assert.doesNotMatch(config, /or-first-key/);
  assert.equal((await envOf('/acp/openrouter-claude')).model, 'vendor/some-model');
  assert.equal((await api('PUT', '/keys/openrouter', { key: 'or-second-key' })).status, 200);
  assert.equal((await envOf('/acp/openrouter-codex')).codexKey, 'or-second-key');
  assert.equal((await api('DELETE', '/profiles/openrouter-codex')).status, 200);
  assert.equal((await api('POST', '/acp/openrouter-codex')).status, 404);
});

test('a CLI of the image that takes a key gets the one added on the page', async () => {
  assert.equal((await api('POST', '/profiles', { provider: 'google', harness: 'claude' })).status, 400);
  assert.equal((await api('PUT', '/keys/google', { key: 'gemini-key-1234' })).status, 200);
  const status = await (await api('GET', '/status')).json();
  assert.equal(status.clis.find((c: { name: string }) => c.name === 'keyless').signedIn, true);
  assert.equal((await envOf('/acp/keyless')).gemini, 'gemini-key-1234');
  assert.equal((await api('DELETE', '/keys/google')).status, 200);
  assert.equal((await api('PUT', '/keys/google', { key: 'has spaces in it' })).status, 400);
});


test('Auto configures a provider without requiring a harness or model', async () => {
  const saved = await api('PUT', '/keys/openrouter', { key: 'or-auto-key', auto: true });
  assert.equal(saved.status, 200);
  const auto = await api('POST', '/profiles', { provider: 'openrouter', harness: 'auto', model: 'auto' });
  assert.deepEqual(await auto.json(), { name: 'openrouter-claude', provider: 'openrouter', harness: 'claude', model: 'openrouter/auto', acp: '/acp/openrouter-claude' });
  const actual = await envOf('/acp/openrouter-claude');
  assert.equal(actual.model, 'openrouter/auto');
  assert.equal(actual.token, 'or-auto-key');
  assert.notEqual(actual.config, process.env.CLAUDE_CONFIG_DIR);
});

test('copy link preserves both gates and assets require authentication', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/link`)).status, 401);
  const link = await fetch(`http://127.0.0.1:${PORT}/link`, { headers: { authorization: `Bearer ${TOKEN}`, cookie: 'other=1; briq_token=router-private-token' } });
  assert.equal(link.headers.get('cache-control'), 'no-store');
  const query = new URLSearchParams((await link.json()).query);
  assert.equal(query.get('token'), TOKEN);
  assert.equal(query.get('briq_token'), 'router-private-token');
  for (const path of ['/assets/home.js', '/assets/home.css', '/assets/icons/grok.svg']) {
    assert.equal((await api('GET', path)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}${path}`)).status, 401);
  }
});

test('a successful sign-in without a status command is recorded, without credentials', async () => {
  // fixed has no status command and its login exits successfully.
  assert.equal((await api('POST', '/connect/fixed')).status, 200);
  const status = await (await api('GET', '/status')).json();
  const fixed = status.clis.find((c: { name: string }) => c.name === 'fixed');
  assert.equal(fixed.signedIn, true);
  assert.equal(fixed.statusSource, 'sign-in');
  const record = JSON.parse(readFileSync(join(home, 'state', 'sign-ins.json'), 'utf8'));
  assert.equal(typeof record.fixed, 'string');
  assert.deepEqual(Object.keys(record), ['fixed']);
  assert.equal(statSync(join(home, 'state', 'sign-ins.json')).mode & 0o777, 0o600);
});


test('falls back to the last completed sign-in when a live check is unavailable', async () => {
  assert.equal((await api('POST', '/connect/flaky')).status, 200);
  const status = await (await api('GET', '/status')).json();
  const flaky = status.clis.find((c: { name: string }) => c.name === 'flaky');
  assert.equal(flaky.signedIn, true);
  assert.equal(flaky.statusSource, 'sign-in');
});
