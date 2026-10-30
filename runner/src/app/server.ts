import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { createNodeHttpHandler, createNodeWebSocketUpgradeHandler } from '@agentclientprotocol/sdk/experimental/node';
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server';
import { WebSocketServer } from 'ws';
import { ClientConn } from '../acp/client.ts';
import { type Cli, cliEnv, clis } from '../providers/catalog.ts';
import { signInLife } from '../auth/dates.ts';
import { Hub } from '../acp/hub.ts';
import { log } from '../telemetry/log.ts';
import { ASSETS, PAGE } from '../ui/page.ts';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Keys, PROVIDERS, profileFor } from '../providers/profiles.ts';
import { RUNNER_COOKIE, terminalProxy } from '../http/terminal.ts';
import { SignIn } from '../auth/signin.ts';
import { commandStatus } from '../auth/status.ts';
import { CopilotAccountObserver } from '../auth/copilot.ts';
import { usageReport } from '../telemetry/usage.ts';
import { configuration } from './config.ts';
import { Application } from './services.ts';
import { ProviderMutations } from './provider-mutations.ts';
import { AutoConn } from '../acp/auto.ts';
import { prepareAutoProfiles, AUTO_POOL_SOURCE } from '../providers/auto-models.ts';

/**
 * The agent home runner (ADR 0021 in github.com/up-lab/briq; this folder's README): an ACP agent
 * toward apps, at `/acp/<cli>` over WebSocket or Streamable HTTP, and an ACP client toward each
 * CLI. Beside it, `/connect/<cli>` (the vendor's own sign-in), `/status`, `/refresh/<cli>`,
 * `/keys` and `/profiles` (a provider's key, run by Claude Code or Codex), and
 * for the home's person a page at `/` and the terminal at `/terminal/`: the runner is the home's
 * front door.
 */
const env = process.env;
const config = configuration(env);
const token = env.RUNNER_TOKEN ?? '';
if (!token) {
  log.warn('RUNNER_TOKEN is not set: refusing to start');
  process.exit(1);
}
const port = config.port;
const base = clis(env);
const childEnv = cliEnv(env);
const stateDir = config.stateDir;
const logins = env.RUNNER_LOGINS ?? '/work/.logins';
const keys = new Keys({
  keysFile: env.RUNNER_KEYS ?? `${logins}/keys.json`,
  profilesFile: `${stateDir}/profiles.json`,
  logins,
});

/** A CLI of the image with the key its person added on the page, if it takes one. */
function withKey(c: Cli): Cli {
  const key = c.keyFrom ? keys.key(c.keyFrom) : undefined;
  return key && c.apiKeys?.[0] ? { ...c, env: { ...c.env, [c.apiKeys[0]]: key } } : c;
}

/** The person's profiles as CLIs: each one's harness is the image's own CLI of that name. */
function profileClis(): Cli[] {
  return keys.profiles().flatMap((p) => {
    const harness = base.find((c) => c.name === p.harness);
    return harness ? [keys.cliOf(p, harness)] : [];
  });
}

/** Every CLI the runner drives now: the image's, then the person's profiles. */
let table: Cli[] = [...base.map(withKey), ...profileClis()];
const providerMutations = new ProviderMutations();
const hub = new Hub({
  clis: table,
  env: childEnv,
  cwd: config.cwd,
  stateDir,
  maxTurns: config.maxTurns,
  route: (env.RUNNER_ROUTE ?? 'claude,codex,cursor,copilot,grok,gemini,vibe')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),
  signedIn: (name) => signedInCached(name),
  beforeStart: async (name) => {
    if (name !== 'copilot') return () => {};
    copilotNativeStarting++;
    try {
      await copilotAccounts.invalidate();
    } catch {
      copilotNativeStarting--;
      throw new Error('Copilot account observation unavailable');
    }
    return () => {
      copilotNativeStarting--;
    };
  },
});

/**
 * The table again after a key or a profile changed: each CLI whose definition moved is stopped and
 * started anew with it on its next use (a running turn ends), the others keep their process.
 */
async function reload(): Promise<void> {
  const next = [...base.map(withKey), ...profileClis()];
  const same = (a: Cli, b: Cli | undefined) => b !== undefined && JSON.stringify(a) === JSON.stringify(b);
  for (const c of table)
    if (
      !same(
        c,
        next.find((n) => n.name === c.name),
      )
    )
      await hub.remove(c.name);
  for (const c of next)
    if (
      !same(
        c,
        table.find((t) => t.name === c.name),
      )
    )
      hub.add(c);
  table = next;
  known.clear();
  await copilotAccounts.invalidate();
}
async function prepareModels() {
  if (!keys.key('openrouter')) throw Error("add OpenRouter's key first");
  const result = await prepareAutoProfiles({ keys, claudeAvailable: base.some((c) => c.name === 'claude') });
  return result;
}
// Only completion dates: never a vendor's credentials or sign-in output.
const signInFile = `${stateDir}/sign-ins.json`;
let completedSignIns: Record<string, string> = {};
try {
  completedSignIns = JSON.parse(readFileSync(signInFile, 'utf8'));
} catch {}
function completedSignIn(name: string): void {
  completedSignIns[name] = new Date().toISOString();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(`${signInFile}.tmp`, JSON.stringify(completedSignIns), { mode: 0o600 });
  renameSync(`${signInFile}.tmp`, signInFile);
  known.delete(name);
  if (name === 'copilot') void copilotAccounts.invalidate();
}
const signIns = new Map(base.map((c) => [c.name, new SignIn(c, () => completedSignIn(c.name))]));
/** ttyd on localhost, started with `--base-path /terminal`. */
const terminal = terminalProxy(new URL(env.RUNNER_TERMINAL ?? 'http://127.0.0.1:7681'));

/** One ACP endpoint per CLI (`/acp/<cli>`), and `/acp` (`''` here), which routes each session. */
const acp = new Map<
  string,
  { http: ReturnType<typeof createNodeHttpHandler>; upgrade: ReturnType<typeof createNodeWebSocketUpgradeHandler> }
>();
function endpoint(name: string) {
  let e = acp.get(name);
  if (!e) {
    const server = new AcpServer({
      createAgent: () => ({
        connect: (stream) => {
          const conn =
            name === 'auto'
              ? new AutoConn({
                  engine: application.engine,
                  tasks: application.tasks,
                  context: application.context,
                  hub,
                  stateDir,
                  defaultProject: 'home',
                })
              : new ClientConn(hub, name || null);
          return { closed: conn.run(stream as never) };
        },
      }),
    });
    const wss = new WebSocketServer({ noServer: true });
    e = { http: createNodeHttpHandler(server), upgrade: createNodeWebSocketUpgradeHandler(server, wss as never) };
    acp.set(name, e);
  }
  return e;
}
/** The endpoint of a path: `/acp/<cli>` for a CLI the runner drives now, or `/acp` itself. */
const acpOf = (parts: string[]) =>
  parts[0] === 'acp' &&
  parts.length <= 2 &&
  (!parts[1] || (parts[1] === 'auto' && config.orchestrator) || hub.has(parts[1]))
    ? endpoint(parts[1] ?? '')
    : undefined;

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
    if (Buffer.byteLength(s) > 1_048_576) throw new Error('too large');
  }
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}

/** `signedIn`, kept 30 s: `/acp` asks it for each new session. */
const known = new Map<string, { at: number; value: Promise<boolean | null> }>();
const statusSources = new Map<string, 'command' | 'sign-in'>();
let pendingCopilotStarts = 0;
let copilotNativeStarting = 0;
const copilotAccounts = new CopilotAccountObserver({
  command: base.find((cli) => cli.name === 'copilot')?.acp.filter((arg) => !['--acp', '--stdio'].includes(arg)) ?? [
    'copilot',
  ],
  env: childEnv,
  cwd: config.cwd,
  canCheck: () =>
    pendingCopilotStarts === 0 &&
    copilotNativeStarting === 0 &&
    !['starting', 'waiting'].includes(signIns.get('copilot')?.status.state ?? '') &&
    (!hub.has('copilot') || !hub.running('copilot')),
});
function signedInCached(name: string): Promise<boolean | null> {
  const hit = known.get(name);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const cli = table.find((c) => c.name === name);
  const value = cli ? signedIn(cli) : Promise.resolve(null);
  known.set(name, { at: Date.now(), value });
  return value;
}

/**
 * Exit 0 or `"loggedIn": true`: signed in. A CLI that only takes API keys: one of them is set.
 * Without either: unknown.
 */
function signedIn(cli: Cli): Promise<boolean | null> {
  if (cli.profile) return Promise.resolve(Boolean(keys.key(cli.profile.provider)));
  if (cli.name === 'copilot') return copilotAccounts.check().then((result) => result.signedIn);
  if (cli.authStatusMethod) return hub.authStatus(cli.name);
  if (!cli.status && !cli.login && !cli.terminalLogin && cli.apiKeys)
    return Promise.resolve(cli.apiKeys.some((k) => Boolean(cli.env?.[k] ?? childEnv[k])));
  if (!cli.status) return Promise.resolve(completedSignIns[cli.name] ? true : null);
  return commandStatus(cli.status, childEnv).then((value) => {
    const recorded = value === null && Boolean(completedSignIns[cli.name]);
    statusSources.set(cli.name, recorded ? 'sign-in' : 'command');
    return recorded ? true : value;
  });
}

const application = new Application({
  config,
  hub,
  keys,
  table: () => table,
  signedIn: signedInCached,
  authEnv: childEnv,
  providerSnapshot: () => providerMutations.run(() => ({ profiles: keys.profiles(), table: [...table] })),
});
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (url.pathname === '/delegate' && req.method === 'POST') {
    let keepalive: ReturnType<typeof setInterval> | undefined;
    try {
      const input = await body(req),
        header = req.headers.authorization ?? '';
      if (!header.startsWith('Bearer ')) return json(res, 401, { error: 'task capability required' });
      const capability = header.slice(7);
      await application.delegation.call(capability, 'status', {});
      res.once('close', () => {
        if (!res.writableEnded) application.delegation.disconnect(capability);
      });
      // Whitespace before JSON keeps long waits alive through HTTP clients.
      if (input.action === 'wait') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.write(' \n');
        keepalive = setInterval(() => res.write(' \n'), 15000);
      }
      const result = await application.delegation.call(
        capability,
        String(input.action),
        (input.input as Record<string, unknown>) ?? {},
      );
      if (res.headersSent) {
        res.end(JSON.stringify(result));
        return;
      }
      return json(res, 200, result);
    } catch {
      if (res.headersSent) {
        res.end(JSON.stringify({ error: 'delegation refused' }));
        return;
      }
      return json(res, 403, { error: 'delegation refused' });
    } finally {
      clearInterval(keepalive);
    }
  }
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
  try {
    if (config.orchestrator && (await application.http(req, res, url, () => body(req)))) return;
    if (url.pathname === '/routing/models' && req.method === 'POST')
      return await providerMutations.run(async () => {
        if (!keys.key('openrouter')) return json(res, 409, { error: "add OpenRouter's key first" });
        const models = await prepareModels();
        await reload();
        return json(res, 200, models);
      });
    if (url.pathname === '/routing/models' && req.method === 'GET')
      return json(res, 200, { profiles: keys.profiles().filter((p) => p.autoEligible), source: AUTO_POOL_SOURCE });
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
    const asset = ASSETS.get(url.pathname);
    if (asset && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': asset.type,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      return res.end(asset.body);
    }
    if (url.pathname === '/link' && req.method === 'GET') {
      const query = new URLSearchParams({ token });
      const router = /(?:^|;\s*)briq_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (router) query.set('briq_token', router);
      res.setHeader('cache-control', 'no-store');
      return json(res, 200, { query: `?${query}` });
    }
    if (parts[0] === 'terminal') return terminal.http(req, res);
    const endpoint = acpOf(parts);
    if (endpoint) return endpoint.http(req, res);
    if (url.pathname === '/status' && req.method === 'GET') {
      const out = await Promise.all(
        table.map(async (c) => ({
          name: c.name,
          running: hub.running(c.name),
          signedIn: await signedInCached(c.name),
          signIn: signIns.get(c.name)?.status.state,
          statusSource:
            c.name === 'copilot' && !c.profile
              ? 'sdk'
              : c.authStatusMethod
                ? 'acp'
                : c.status
                  ? (statusSources.get(c.name) ?? 'command')
                  : c.profile || c.apiKeys
                    ? 'key'
                    : completedSignIns[c.name]
                      ? 'sign-in'
                      : 'unavailable',
          // How its person signs in: on the page, with a command in the terminal, or by an API key.
          signInWith: c.login ? 'page' : c.terminalLogin ? 'terminal' : 'api-key',
          ...(c.terminalLogin ? { command: c.terminalLogin } : {}),
          ...(c.apiKeys ? { apiKeys: c.apiKeys } : {}),
          ...(c.keyFrom ? { keyFrom: c.keyFrom } : {}),
          ...(c.profile ? { profile: c.profile } : {}),
          ...(c.signIn ? { life: signInLife(c.signIn, env) ?? null } : {}),
        })),
      );
      return json(res, 200, {
        clis: out,
        limited: hub.limits(),
        features: {
          orchestrator: config.orchestrator,
          dynamicRouting: config.dynamicRouting,
          delegation: config.delegation,
          memory: config.memory,
        },
      });
    }
    if (url.pathname === '/usage' && req.method === 'GET')
      return json(
        res,
        200,
        usageReport(
          stateDir,
          table.map((c) => c.name),
          new Set(table.filter((c) => c.profile).map((c) => c.name)),
        ),
      );
    // The providers and their keys (whether one is set, never the key), and the profiles.
    if (url.pathname === '/keys' && req.method === 'GET')
      return json(res, 200, {
        providers: PROVIDERS.map((p) => ({
          id: p.id,
          name: p.name,
          billing: p.billing,
          set: Boolean(keys.key(p.id)),
          harnesses: [...(p.claude ? ['claude'] : []), ...(p.codex ? ['codex'] : [])],
          ...(p.claude ? { claudeNeedsModel: p.claude.needsModel } : {}),
          ...(p.cli ? { cli: p.cli.name } : {}),
          ...(p.example ? { example: p.example } : {}),
        })),
        profiles: keys.profiles(),
      });
    if (parts[0] === 'keys' && parts.length === 2 && (req.method === 'PUT' || req.method === 'DELETE')) {
      return await providerMutations.run(async () => {
        if (!PROVIDERS.some((p) => p.id === parts[1]))
          return json(res, 404, { error: `no provider named ${parts[1]}` });
        let key: string | undefined;
        let auto = false;
        if (req.method === 'PUT') {
          const input = await body(req);
          const k = input.key;
          auto = input.auto === true;
          if (typeof k !== 'string' || !/^\S{8,1024}$/.test(k))
            return json(res, 400, { error: "key is the provider's key, without spaces" });
          key = k;
        }
        keys.putKey(parts[1] as string, key);
        let models;
        if (key && auto && parts[1] === 'openrouter') models = await prepareModels();
        else if (key && auto) {
          const provider = PROVIDERS.find((p) => p.id === parts[1]);
          if (provider && !provider.cli) {
            const profile = profileFor(provider.id, 'auto', 'auto');
            if (
              typeof profile !== 'string' &&
              base.some((c) => c.name === profile.harness) &&
              !keys.profiles().some((p) => p.provider === provider.id)
            )
              keys.putProfile(profile);
          }
        }
        await reload();
        return json(res, 200, { provider: parts[1], set: Boolean(key), ...(models ? { models } : {}) });
      });
    }
    if (url.pathname === '/profiles' && req.method === 'POST') {
      return await providerMutations.run(async () => {
        const b = await body(req);
        const p = profileFor(b.provider, b.harness, b.model);
        if (typeof p === 'string') return json(res, 400, { error: p });
        if (!keys.key(p.provider))
          return json(res, 409, { error: `add ${p.provider}'s key first: PUT /keys/${p.provider}` });
        if (!base.some((c) => c.name === p.harness)) return json(res, 409, { error: `this home has no ${p.harness}` });
        if (b.name !== undefined) {
          if (
            typeof b.name !== 'string' ||
            !b.name.startsWith(`${p.provider}-${p.harness}-`) ||
            !/^[a-z0-9][a-z0-9-]{0,95}$/.test(b.name)
          )
            return json(res, 400, {
              error: 'name must start with provider-harness- and use lowercase letters, digits or hyphens',
            });
          p.name = b.name;
        }
        if (base.some((c) => c.name === p.name))
          return json(res, 409, { error: 'profile name conflicts with a native CLI' });
        if (b.autoEligible === true) {
          if (p.provider !== 'openrouter' || !p.model || p.model === 'openrouter/auto')
            return json(res, 400, { error: 'automatic API routes need a pinned OpenRouter model' });
          const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15000) });
          if (!r.ok) return json(res, 503, { error: 'model catalog unavailable' });
          const catalog = (await r.json()) as { data: Array<{ id: string; canonical_slug: string }> };
          const model = catalog.data.find((m) => m.id === p.model);
          if (!model?.canonical_slug) return json(res, 400, { error: 'model is not in the catalog' });
          p.canonical = model.canonical_slug;
          p.autoEligible = true;
        }
        keys.putProfile(p);
        await reload();
        return json(res, 200, { ...p, acp: `/acp/${p.name}` });
      });
    }
    if (parts[0] === 'profiles' && parts.length === 2 && req.method === 'DELETE') {
      return await providerMutations.run(async () => {
        if (!keys.profiles().some((p) => p.name === parts[1]))
          return json(res, 404, { error: `no profile named ${parts[1]}` });
        keys.dropProfile(parts[1] as string);
        await reload();
        return json(res, 200, { name: parts[1], removed: true });
      });
    }
    if (parts[0] === 'refresh' && parts[1] && signIns.has(parts[1]) && req.method === 'POST') {
      const c = table.find((t) => t.name === parts[1]) as Cli;
      const life = c.signIn ? signInLife(c.signIn, env) : undefined;
      if (life && !life.renews)
        return json(res, 409, {
          error: `a refresh does not move ${c.name}'s sign-in: it ends ${life.endsAt}, sign in again (POST /connect/${c.name})`,
          life,
        });
      if (hub.busy(c.name)) return json(res, 409, { error: `a turn of ${c.name} is running: try again when it ends` });
      await hub.refresh(c.name, env.RUNNER_REFRESH_CWD ?? '/tmp');
      const after = c.signIn ? signInLife(c.signIn, env) : undefined;
      // `moved`: the end is later than before. A CLI that refreshes only after some days moves nothing earlier.
      return json(res, 200, {
        name: c.name,
        ...(c.signIn
          ? { moved: Boolean(life?.endsAt && after?.endsAt && after.endsAt > life.endsAt), life: after ?? null }
          : {}),
      });
    }
    if (parts[0] === 'connect' && parts[1] && signIns.has(parts[1])) {
      const s = signIns.get(parts[1]) as SignIn;
      const c = table.find((t) => t.name === parts[1]) as Cli;
      if (!c.login && req.method === 'POST' && parts.length === 2)
        return json(res, 409, {
          error: c.terminalLogin
            ? `${c.name} signs in in the terminal: ${c.terminalLogin}`
            : `${c.name} takes an API key: ${c.keyFrom ? `add ${c.keyFrom}'s on the page (PUT /keys/${c.keyFrom}), or ` : ''}${(c.apiKeys ?? []).join(' or ')} in its environment`,
        });
      if (parts.length === 2 && req.method === 'POST') {
        let input: Record<string, unknown>;
        try {
          input = await body(req);
        } catch {
          return json(res, 400, { error: 'invalid connect body' });
        }
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          (input.wait !== undefined && typeof input.wait !== 'boolean')
        )
          return json(res, 400, { error: 'wait must be a boolean' });
        if (c.name === 'copilot') pendingCopilotStarts++;
        try {
          if (c.name === 'copilot') {
            known.delete(c.name);
            await copilotAccounts.invalidate();
          }
          return json(res, 200, await s.start(childEnv, { wait: input.wait !== false }));
        } finally {
          if (c.name === 'copilot') pendingCopilotStarts--;
        }
      }
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

server.requestTimeout = 360_000;
server.listen(port, config.host, () => {
  log.info('runner listening', { port, clis: table.map((c) => c.name) });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void application.stop().finally(async () => {
      await copilotAccounts.close();
      hub.stop();
      server.close();
      process.exit(0);
    });
  });
