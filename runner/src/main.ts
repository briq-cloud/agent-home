import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { createNodeHttpHandler, createNodeWebSocketUpgradeHandler } from '@agentclientprotocol/sdk/experimental/node';
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server';
import { WebSocketServer } from 'ws';
import { ClientConn } from './client.ts';
import { type Cli, cliEnv, clis } from './clis.ts';
import { signInLife } from './dates.ts';
import { Hub } from './hub.ts';
import { log } from './log.ts';
import { PAGE } from './page.ts';
import { RUNNER_COOKIE, terminalProxy } from './proxy.ts';
import { SignIn } from './signin.ts';
import { usageReport } from './usage.ts';

/**
 * The agent home runner (ADR 0021 in github.com/up-lab/briq; this folder's README): an ACP agent
 * toward apps, at `/acp/<cli>` over WebSocket or Streamable HTTP, and an ACP client toward each
 * CLI. Beside it, `/connect/<cli>` (the vendor's own sign-in), `/status`, `/refresh/<cli>`, and
 * for the home's person a page at `/` and the terminal at `/terminal/`: the runner is the home's
 * front door.
 */
const env = process.env;
const token = env.RUNNER_TOKEN ?? '';
if (!token) {
  log.warn('RUNNER_TOKEN is not set: refusing to start');
  process.exit(1);
}
const port = Number(env.RUNNER_PORT ?? 8090);
const table = clis(env);
const childEnv = cliEnv(env);
const stateDir = env.RUNNER_STATE ?? '/work/.runner';
const hub = new Hub({
  clis: table,
  env: childEnv,
  cwd: env.RUNNER_CWD ?? '/work',
  stateDir,
  maxTurns: Number(env.RUNNER_MAX_TURNS ?? 2),
  route: (env.RUNNER_ROUTE ?? 'claude,codex,cursor,copilot,grok,vibe').split(',').map((n) => n.trim()).filter(Boolean),
  signedIn: (name) => signedInCached(name),
});
const signIns = new Map(table.map((c) => [c.name, new SignIn(c)]));
/** ttyd on localhost, started with `--base-path /terminal`. */
const terminal = terminalProxy(new URL(env.RUNNER_TERMINAL ?? 'http://127.0.0.1:7681'));

/** One ACP endpoint per CLI: a connection is to one agent, as ACP has it. */
/** One ACP endpoint per CLI (`/acp/<cli>`), and `/acp` (`''` here), which routes each session. */
const acp = new Map(
  [...table.map((c) => c.name), ''].map((name) => {
    const server = new AcpServer({
      createAgent: () => ({
        connect: (stream) => {
          const conn = new ClientConn(hub, name || null);
          return { closed: conn.run(stream as never) };
        },
      }),
    });
    const wss = new WebSocketServer({ noServer: true });
    return [
      name,
      { http: createNodeHttpHandler(server), upgrade: createNodeWebSocketUpgradeHandler(server, wss as never) },
    ] as const;
  }),
);
/** The endpoint of a path: `/acp/<cli>`, or `/acp` itself. */
const acpOf = (parts: string[]) => (parts[0] === 'acp' && parts.length <= 2 ? acp.get(parts[1] ?? '') : undefined);

/**
 * The key, in constant time: `Authorization: Bearer` (an app), `?token=` (a browser's WebSocket,
 * or the page's link), or the cookie the page's link sets (the person's browser).
 */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const cookie = new RegExp(`(?:^|;\\s*)${RUNNER_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
  const given = header.startsWith('Bearer ')
    ? header.slice(7)
    : (new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? cookie ?? '');
  return same(given, token);
}

function same(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b) && given.length > 0;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 16_384) throw new Error('too large');
  }
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}

/** `signedIn`, kept 30 s: `/acp` asks it for each new session. */
const known = new Map<string, { at: number; value: Promise<boolean | null> }>();
function signedInCached(name: string): Promise<boolean | null> {
  const hit = known.get(name);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const cli = table.find((c) => c.name === name);
  const value = cli ? signedIn(cli) : Promise.resolve(null);
  known.set(name, { at: Date.now(), value });
  return value;
}

/** Exit 0 or `"loggedIn": true`: signed in. Without a status command: unknown. */
function signedIn(cli: Cli): Promise<boolean | null> {
  if (!cli.status) return Promise.resolve(null);
  return new Promise((resolve) => {
    const [cmd, ...args] = cli.status as string[];
    const child = spawn(cmd as string, args, { env: childEnv, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      clearTimeout(timer);
      const m = /"loggedIn"\s*:\s*(true|false)/.exec(out);
      resolve(m ? m[1] === 'true' : code === 0);
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
  try {
    // The page's link carries the key once: kept as a cookie for this origin, then dropped from
    // the address. SameSite=Strict: no other site's page sends it.
    if (url.searchParams.has('token') && req.method === 'GET' && !parts.length) {
      res.writeHead(303, {
        'set-cookie': `${RUNNER_COOKIE}=${url.searchParams.get('token')}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`,
        location: '/',
      });
      return res.end();
    }
    if (!parts.length && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE);
    }
    if (parts[0] === 'terminal') return terminal.http(req, res);
    const endpoint = acpOf(parts);
    if (endpoint) return endpoint.http(req, res);
    if (url.pathname === '/status' && req.method === 'GET') {
      const out = await Promise.all(
        table.map(async (c) => ({
          name: c.name,
          running: hub.running(c.name),
          signedIn: await signedIn(c),
          signIn: signIns.get(c.name)?.status.state,
          ...(c.signIn ? { life: signInLife(c.signIn, env) ?? null } : {}),
        })),
      );
      return json(res, 200, { clis: out, limited: hub.limits() });
    }
    if (url.pathname === '/usage' && req.method === 'GET') return json(res, 200, usageReport(stateDir, table.map((c) => c.name)));
    if (parts[0] === 'refresh' && parts[1] && hub.has(parts[1]) && req.method === 'POST') {
      const c = table.find((t) => t.name === parts[1]) as Cli;
      const life = c.signIn ? signInLife(c.signIn, env) : undefined;
      if (life && !life.renews)
        return json(res, 409, { error: `a refresh does not move ${c.name}'s sign-in: it ends ${life.endsAt}, sign in again (POST /connect/${c.name})`, life });
      if (hub.busy(c.name)) return json(res, 409, { error: `a turn of ${c.name} is running: try again when it ends` });
      await hub.refresh(c.name, env.RUNNER_REFRESH_CWD ?? '/tmp');
      const after = c.signIn ? signInLife(c.signIn, env) : undefined;
      // `moved`: the end is later than before. A CLI that refreshes only after some days moves nothing earlier.
      return json(res, 200, {
        name: c.name,
        ...(c.signIn ? { moved: Boolean(life?.endsAt && after?.endsAt && after.endsAt > life.endsAt), life: after ?? null } : {}),
      });
    }
    if (parts[0] === 'connect' && parts[1] && signIns.has(parts[1])) {
      const s = signIns.get(parts[1]) as SignIn;
      if (parts.length === 2 && req.method === 'POST') return json(res, 200, await s.start(childEnv));
      if (parts.length === 2 && req.method === 'GET') return json(res, 200, s.status);
      if (parts.length === 2 && req.method === 'DELETE') {
        s.cancel();
        return json(res, 200, s.status);
      }
      if (parts[2] === 'input' && req.method === 'POST') {
        const text = (await body(req)).text;
        if (typeof text !== 'string' || !text) return json(res, 400, { error: 'text missing' });
        return json(res, s.input(text) ? 200 : 409, s.status);
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    log.warn('request failed', { path: url.pathname, err: String(err) });
    if (!res.headersSent) json(res, 500, { error: 'failed' });
  }
});

server.on('upgrade', (req, socket, head) => {
  const parts = new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean);
  const target = acpOf(parts) ?? (parts[0] === 'terminal' ? terminal : undefined);
  if (!target || !authorized(req)) {
    socket.end(`HTTP/1.1 ${target ? '401 Unauthorized' : '404 Not Found'}\r\n\r\n`);
    return;
  }
  target.upgrade(req, socket, head);
});

server.listen(port, env.RUNNER_HOST ?? '0.0.0.0', () => {
  log.info('runner listening', { port, clis: table.map((c) => c.name) });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    hub.stop();
    server.close();
    process.exit(0);
  });
