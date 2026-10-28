import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { createNodeHttpHandler, createNodeWebSocketUpgradeHandler } from '@agentclientprotocol/sdk/experimental/node';
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server';
import { WebSocketServer } from 'ws';
import { ClientConn } from './client.ts';
import { type Cli, cliEnv, clis } from './clis.ts';
import { Hub } from './hub.ts';
import { log } from './log.ts';
import { SignIn } from './signin.ts';

/**
 * The agent home runner (ADR 0021 in github.com/up-lab/briq; this folder's README): an ACP agent
 * toward apps, at `/acp/<cli>` over WebSocket or Streamable HTTP, and an ACP client toward each
 * CLI. Beside it, `/connect/<cli>` (the vendor's own sign-in) and `/status`.
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
const hub = new Hub({
  clis: table,
  env: childEnv,
  cwd: env.RUNNER_CWD ?? '/work',
  stateDir: env.RUNNER_STATE ?? '/work/.runner',
  maxTurns: Number(env.RUNNER_MAX_TURNS ?? 2),
});
const signIns = new Map(table.map((c) => [c.name, new SignIn(c)]));

/** One ACP endpoint per CLI: a connection is to one agent, as ACP has it. */
const acp = new Map(
  table.map((c) => {
    const server = new AcpServer({
      createAgent: () => ({
        connect: (stream) => {
          const conn = new ClientConn(hub, c.name);
          return { closed: conn.run(stream as never) };
        },
      }),
    });
    const wss = new WebSocketServer({ noServer: true });
    return [
      c.name,
      { http: createNodeHttpHandler(server), upgrade: createNodeWebSocketUpgradeHandler(server, wss as never) },
    ] as const;
  }),
);

/** The app's key, in constant time: `Authorization: Bearer`, or `?token=` for a browser's WebSocket. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ')
    ? header.slice(7)
    : (new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '');
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(token).digest();
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
    if (parts[0] === 'acp' && parts[1] && acp.has(parts[1])) return acp.get(parts[1])?.http(req, res);
    if (url.pathname === '/status' && req.method === 'GET') {
      const out = await Promise.all(
        table.map(async (c) => ({
          name: c.name,
          running: hub.running(c.name),
          signedIn: await signedIn(c),
          signIn: signIns.get(c.name)?.status.state,
        })),
      );
      return json(res, 200, { clis: out });
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
  const target = parts[0] === 'acp' && parts[1] ? acp.get(parts[1]) : undefined;
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
