import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
      RUNNER_MAX_TURNS: '1',
      RUNNER_TERMINAL: `http://127.0.0.1:${TERMINAL_PORT}`,
      MOCK_HOME: dir,
      RUNNER_CLIS: JSON.stringify([
        {
          name: 'mock',
          acp: mock,
          login: ['sh', '-c', 'echo "Open https://example.test/device and enter ABCD-EFGH"; sleep 2'],
          status: ['true'],
          signIn: { file: '$MOCK_HOME/auth.json', refreshedAt: 'last_refresh', days: 30, refreshAfterDays: 8 },
        },
        { name: 'fixed', acp: mock, login: ['true'], signIn: { file: '$MOCK_HOME/fixed.json', endsAt: 'refreshTokenExpiresAt' } },
      ]),
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

  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/acp/mock`, { headers: { authorization: `Bearer ${TOKEN}` } });
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

async function connect(): Promise<App> {
  const app = new App();
  await app.open();
  const init = await app.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(init.result.agentInfo.name, 'mock');
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
    ['fixed', null],
  ]);
  // The dates of each sign-in, never its tokens.
  assert.deepEqual(clis[0].life, {
    endsAt: '2026-11-19T10:00:00.000Z',
    renews: true,
    endsSoon: Date.parse('2026-11-19T10:00:00Z') - Date.now() < 7 * 86_400_000,
    refreshableAt: '2026-10-28T10:00:00.000Z',
  });
  assert.deepEqual(clis[1].life, { endsAt: new Date(ENDS).toISOString(), renews: false, endsSoon: true });
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
