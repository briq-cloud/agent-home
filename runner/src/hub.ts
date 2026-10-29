import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, type Rpc, RpcFailure } from './agent.ts';
import type { Cli } from './clis.ts';
import { log } from './log.ts';

/** A client connection, as the hub sees it. */
export interface Peer {
  send(msg: Rpc): void;
  /** A request to this client: resolves with its response, rejects if it goes away first. */
  ask(method: string, params: unknown): Promise<Rpc>;
}

/** Where a session's turn is, told to every client as `_runner/turn` and kept in its log. */
export type Turn =
  | { state: 'idle'; stopReason?: string; usage?: unknown }
  | { state: 'queued'; position: number }
  | { state: 'running' };

/** Updates that mean the model answered: the sign-in it used is fresh. */
const MODEL_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call']);
/** How long one prompt may hold a CLI's first model call before the next goes anyway. */
const FIRST_CALL_MS = 30_000;

interface Held {
  method: string;
  params: unknown;
  settle(msg: Rpc): void;
  asked: Set<Peer>;
}

/**
 * A session the runner holds: the CLI keeps it, the runner keeps its events in a log on the
 * volume and follows it for any number of clients, none included.
 */
class Session {
  readonly id: string;
  readonly cli: string;
  readonly peers = new Set<Peer>();
  readonly held = new Map<number, Held>();
  readonly file: string;
  /** What `session/new` or `session/load` answered, for the next client that loads it. */
  loaded: Record<string, unknown> = {};
  turn: Turn = { state: 'idle' };
  /** Drops the CLI's replay of what the log has, while the runner loads it into a new process. */
  replaying = false;
  /** Set while a prompt holds its CLI's first model call. */
  firstCall: (() => void) | undefined;
  /** Set while a prompt waits for a slot. */
  unqueue: (() => void) | undefined;
  private nextHeld = 1;

  constructor(cli: string, id: string, dir: string) {
    this.cli = cli;
    this.id = id;
    this.file = join(dir, `${safeName(id)}.jsonl`);
  }

  /** Into the log and to every client but `except`. */
  record(msg: Rpc, except?: Peer): void {
    appendFileSync(this.file, `${JSON.stringify(msg)}\n`, { mode: 0o600 });
    for (const p of this.peers) if (p !== except) p.send(msg);
  }

  replay(): Rpc[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Rpc);
  }

  /** Told to every client and kept with its time: `/usage` counts turns by day from the log. */
  setTurn(turn: Turn): void {
    this.turn = turn;
    this.record({
      jsonrpc: '2.0',
      method: '_runner/turn',
      params: { sessionId: this.id, ...turn, at: new Date().toISOString() },
    });
  }

  /** A request from the CLI, answered by the first client that answers; held while none is there. */
  hold(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const key = this.nextHeld++;
      const held: Held = {
        method,
        params,
        asked: new Set(),
        settle: (msg) => {
          if (!this.held.delete(key)) return;
          if (msg.error) reject(new RpcFailure(msg.error));
          else resolve(msg.result);
        },
      };
      this.held.set(key, held);
      for (const p of this.peers) this.ask(held, p);
    });
  }

  /** Every request still waiting, to a client that just came. */
  askAll(peer: Peer): void {
    for (const held of this.held.values()) this.ask(held, peer);
  }

  dropHeld(reason: string): void {
    for (const held of this.held.values())
      held.settle({ jsonrpc: '2.0', id: null, error: { code: -32603, message: reason } });
  }

  private ask(held: Held, peer: Peer): void {
    if (held.asked.has(peer)) return;
    held.asked.add(peer);
    peer.ask(held.method, held.params).then(held.settle, () => held.asked.delete(peer));
  }
}

/** A number of turns at once for the whole home, the rest in order. */
class Slots {
  private free: number;
  private readonly waiting: Array<{ go(): void; position(n: number): void }> = [];

  constructor(max: number) {
    this.free = max;
  }

  /** A release, once a slot is free; `undefined` when `cancel` came first. */
  take(position: (n: number) => void, cancel: (stop: () => void) => void): Promise<(() => void) | undefined> {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => {
      const entry = {
        go: () => resolve(() => this.release()),
        position,
      };
      this.waiting.push(entry);
      position(this.waiting.length);
      cancel(() => {
        const i = this.waiting.indexOf(entry);
        if (i < 0) return;
        this.waiting.splice(i, 1);
        this.tell();
        resolve(undefined);
      });
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      this.tell();
      next.go();
    } else this.free++;
  }

  private tell(): void {
    this.waiting.forEach((w, i) => w.position(i + 1));
  }
}

/** One prompt at a time makes its CLI's first model call: see `Cli.oneRefresher`. */
class FirstCall {
  private tail: Promise<void> = Promise.resolve();

  enter(): Promise<() => void> {
    let done!: () => void;
    const mine = new Promise<void>((r) => {
      done = r;
    });
    const before = this.tail;
    this.tail = before.then(() => mine);
    return before.then(() => {
      const timer = setTimeout(done, FIRST_CALL_MS);
      return () => {
        clearTimeout(timer);
        done();
      };
    });
  }
}

interface Engine {
  agent: Agent;
  sessions: Map<string, Session>;
  firstCall: FirstCall;
  dir: string;
}

export interface HubOptions {
  clis: Cli[];
  env: Record<string, string>;
  /** Where the CLIs run: the home's volume. */
  cwd: string;
  /** Where the runner keeps its session logs. */
  stateDir: string;
  maxTurns: number;
  /** The order `/acp` picks CLIs in for a new session: `RUNNER_ROUTE`. A profile is picked only when named there. */
  route?: string[];
  /** Whether a CLI's person is signed in: `false` keeps `/acp` from picking it. */
  signedIn?: (cli: string) => Promise<boolean | null>;
}

/** A plan this used (its fullest window) comes last in `/acp`'s picks. */
const NEAR_LIMIT = 0.9;
/** How long a CLI that hit its plan's limit is left out of `/acp`'s picks, when it gives no reset. */
const LIMITED_MS = 15 * 60_000;
/** What a turn that failed on its plan's limit says. */
const LIMIT_RE = /rate.?limit|usage limit|limit reached|quota|too many requests|out of (credits|usage)/i;

/** What `/acp` announces for every CLI it may pick: what each one supports. */
export const GLOBAL_CAPABILITIES = {
  loadSession: true,
  promptCapabilities: { image: false, audio: false, embeddedContext: false },
  mcpCapabilities: { http: false, sse: false },
};

export class Hub {
  private readonly engines = new Map<string, Engine>();
  private readonly slots: Slots;
  private readonly route: string[];
  private readonly signedIn: (cli: string) => Promise<boolean | null>;
  private readonly stateDir: string;
  /** CLIs at their plan's limit, until when: `/acp` picks another. */
  private readonly limited = new Map<string, number>();
  /** How much of its plan each CLI last said it used, its fullest window (0 to 1). */
  private readonly used = new Map<string, number>();

  private readonly env: Record<string, string>;
  private readonly cwd: string;

  constructor(opts: HubOptions) {
    this.slots = new Slots(opts.maxTurns);
    this.stateDir = opts.stateDir;
    this.env = opts.env;
    this.cwd = opts.cwd;
    this.route = opts.route?.length ? opts.route : opts.clis.map((c) => c.name);
    this.signedIn = opts.signedIn ?? (async () => null);
    for (const cli of opts.clis) this.add(cli);
  }

  /** A CLI to drive, from now on: a profile the person just made. Its sessions' logs stay where they were. */
  add(cli: Cli): void {
    const dir = join(this.stateDir, 'sessions', cli.name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sessions = new Map<string, Session>();
    const agent = new Agent(cli, this.env, this.cwd, {
      notification: (msg) => this.fromAgent(cli.name, sessions, msg),
      request: (msg) => {
        const s = sessions.get(msg.params?.sessionId);
        if (!s) return Promise.reject(new RpcFailure({ code: -32602, message: 'unknown session' }));
        return s.hold(msg.method as string, msg.params);
      },
      exited: () => {
        for (const s of sessions.values()) s.dropHeld(`${cli.name} exited`);
      },
    });
    this.engines.set(cli.name, { agent, sessions, firstCall: new FirstCall(), dir });
  }

  /** A CLI no more: its process stopped, its turns ended with it. Its logs stay. */
  async remove(cli: string): Promise<void> {
    const e = this.engines.get(cli);
    if (!e) return;
    this.engines.delete(cli);
    await e.agent.stopAndWait();
  }

  has(cli: string): boolean {
    return this.engines.has(cli);
  }

  running(cli: string): boolean {
    return this.engine(cli).agent.running;
  }

  /** The CLI's own `initialize` answer, without the sign-in methods the home never offers. */
  async initialize(cli: string): Promise<unknown> {
    const e = this.engine(cli);
    const r = (await e.agent.ensure()) as { authMethods?: Array<{ id?: string }> } | undefined;
    const blocked = e.agent.cli.blockedAuth;
    if (!blocked?.length || !r?.authMethods) return r;
    return { ...r, authMethods: r.authMethods.filter((m) => !blocked.includes(m.id ?? '')) };
  }

  async newSession(cli: string, params: Rpc['params'], peer: Peer): Promise<unknown> {
    const e = this.engine(cli);
    const r = (await this.alone(e, () => e.agent.request('session/new', params))) as Record<string, unknown>;
    const s = this.open(e, cli, r.sessionId as string);
    s.loaded = without(r, 'sessionId');
    s.peers.add(peer);
    e.agent.known.add(s.id);
    log.info('session opened', { cli, sessionId: s.id });
    return r;
  }

  /**
   * A client follows a session: what happened so far from the log, then live. A CLI process that
   * does not hold it any more (it restarted) loads it again, its replay dropped.
   */
  async loadSession(cli: string, params: Rpc['params'], peer: Peer): Promise<unknown> {
    const e = this.engine(cli);
    const id = params?.sessionId as string;
    const s = e.sessions.get(id) ?? this.open(e, cli, id);
    const logged = s.replay();
    for (const m of logged) peer.send(m);
    s.peers.add(peer);
    if (!e.agent.known.has(id)) {
      s.replaying = logged.length > 0;
      try {
        s.loaded = without(
          (await this.alone(e, () => e.agent.request('session/load', params))) as Record<string, unknown>,
          'sessionId',
        );
      } finally {
        s.replaying = false;
      }
      e.agent.known.add(id);
    }
    s.askAll(peer);
    return s.loaded;
  }

  async prompt(cli: string, params: Rpc['params'], peer: Peer): Promise<unknown> {
    const e = this.engine(cli);
    const s = this.known(e, params?.sessionId);
    s.peers.add(peer);
    // The prompt is part of the conversation a client that loads it later should see.
    for (const content of params?.prompt ?? [])
      s.record(
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: s.id, update: { sessionUpdate: 'user_message_chunk', content } },
        },
        peer,
      );
    const release = await this.slots.take(
      (position) => s.setTurn({ state: 'queued', position }),
      (stop) => {
        s.unqueue = stop;
      },
    );
    s.unqueue = undefined;
    if (!release) {
      s.setTurn({ state: 'idle', stopReason: 'cancelled' });
      return { stopReason: 'cancelled' };
    }
    try {
      if (e.agent.cli.oneRefresher) s.firstCall = await e.firstCall.enter();
      s.setTurn({ state: 'running' });
      const r = (await e.agent.request('session/prompt', params)) as { stopReason?: string; usage?: unknown };
      // The session's token totals, when the CLI gives them (ACP's `usage`, unstable).
      s.setTurn({
        state: 'idle',
        ...(r?.stopReason ? { stopReason: r.stopReason } : {}),
        ...(r?.usage ? { usage: r.usage } : {}),
      });
      return r;
    } catch (err) {
      s.setTurn({ state: 'idle', stopReason: 'error' });
      if (err instanceof Error && LIMIT_RE.test(err.message)) this.limit(cli);
      throw err;
    } finally {
      s.firstCall?.();
      s.firstCall = undefined;
      release();
    }
  }

  /** Whether a turn of the CLI runs or waits. */
  busy(cli: string): boolean {
    for (const s of this.engine(cli).sessions.values()) if (s.turn.state !== 'idle') return true;
    return false;
  }

  /**
   * Has the CLI refresh its sign-in now: its process stopped first (nothing then holds the old
   * token in memory; its sessions load again on their next use), then one short turn in a session
   * no client sees, which refreshes the sign-in the way any use does. Costs that turn's tokens.
   */
  async refresh(cli: string, cwd: string): Promise<void> {
    const e = this.engine(cli);
    if (this.busy(cli)) throw new RpcFailure({ code: -32002, message: `a turn of ${cli} is running` });
    await this.alone(e, async () => {
      await e.agent.stopAndWait();
      const created = (await e.agent.request('session/new', { cwd, mcpServers: [] })) as { sessionId: string };
      await e.agent.request('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'Reply with the single word ok.' }],
      });
    });
    log.info('sign-in refreshed', { cli });
  }

  /** Any other request: the CLI's, as it is; an `authenticate` with a blocked method refused. */
  forward(cli: string, method: string, params: unknown): Promise<unknown> {
    const e = this.engine(cli);
    const methodId = (params as { methodId?: string } | undefined)?.methodId;
    if (method === 'authenticate' && methodId && e.agent.cli.blockedAuth?.includes(methodId))
      return Promise.reject(new RpcFailure({ code: -32602, message: `${cli} does not sign in with ${methodId} in an agent home` }));
    return e.agent.request(method, params);
  }

  notify(cli: string, method: string, params: Rpc['params']): void {
    const e = this.engine(cli);
    if (method === 'session/cancel') e.sessions.get(params?.sessionId)?.unqueue?.();
    if (e.agent.running) e.agent.notify(method, params);
  }

  /** A client went away: its sessions carry on without it. */
  detach(peer: Peer): void {
    for (const e of this.engines.values()) for (const s of e.sessions.values()) s.peers.delete(peer);
  }

  stop(): void {
    for (const e of this.engines.values()) e.agent.stop();
  }

  /** The CLI `/acp` gives a new session: the one asked for, else the first fit in the route. */
  async pick(asked: unknown): Promise<string> {
    if (typeof asked === 'string') {
      if (!this.engines.has(asked)) throw new RpcFailure({ code: -32602, message: `no CLI named ${asked}` });
      return asked;
    }
    const now = Date.now();
    const fit: Array<{ cli: string; rank: number; busy: number; nearLimit: boolean }> = [];
    for (const [rank, cli] of this.route.entries()) {
      if (!this.engines.has(cli) || (this.limited.get(cli) ?? 0) > now) continue;
      if ((await this.signedIn(cli)) === false) continue;
      let busy = 0;
      for (const s of this.engine(cli).sessions.values()) if (s.turn.state !== 'idle') busy++;
      fit.push({ cli, rank, busy, nearLimit: (this.used.get(cli) ?? 0) >= NEAR_LIMIT });
    }
    // A plan nearly used up last; then the least busy, then the earliest in the route: a second
    // session goes to the next CLI while the first is busy, rather than queue behind it.
    fit.sort((a, b) => Number(a.nearLimit) - Number(b.nearLimit) || a.busy - b.busy || a.rank - b.rank);
    const first = fit[0];
    if (!first) throw new RpcFailure({ code: -32002, message: 'no CLI to give a session to: all are signed out or at their limit' });
    return first.cli;
  }

  /** The CLI that holds a session, from the runner's sessions and then its logs. */
  cliOf(sessionId: unknown): string {
    if (typeof sessionId !== 'string') throw new RpcFailure({ code: -32602, message: 'sessionId missing' });
    for (const [cli, e] of this.engines) if (e.sessions.has(sessionId)) return cli;
    for (const [cli, e] of this.engines) if (existsSync(join(e.dir, `${safeName(sessionId)}.jsonl`))) return cli;
    throw new RpcFailure({ code: -32602, message: 'unknown session' });
  }

  /** A CLI's capabilities, from its own `initialize`. */
  async capabilitiesOf(cli: string): Promise<unknown> {
    return ((await this.initialize(cli)) as { agentCapabilities?: unknown } | undefined)?.agentCapabilities ?? null;
  }

  /** The CLIs at their limit now, and until when. */
  limits(): Record<string, string> {
    const now = Date.now();
    return Object.fromEntries([...this.limited].filter(([, t]) => t > now).map(([cli, t]) => [cli, new Date(t).toISOString()]));
  }

  private limit(cli: string, until = Date.now() + LIMITED_MS): void {
    this.limited.set(cli, until);
    log.info('cli at its limit', { cli, until: new Date(until).toISOString() });
  }

  private fromAgent(cli: string, sessions: Map<string, Session>, msg: Rpc): void {
    const s = sessions.get(msg.params?.sessionId);
    if (!s || s.replaying) return;
    // A CLI that says it is at its plan's limit (Claude: `_claude/rateLimit`, status "rejected").
    const meta = msg.params?.update?._meta as Record<string, { status?: string; resetsAt?: number }> | undefined;
    for (const [key, value] of Object.entries(meta ?? {})) {
      if (!/rate.?limit/i.test(key) || !value) continue;
      if (value.status === 'rejected')
        this.limit(cli, typeof value.resetsAt === 'number' ? (value.resetsAt < 1e12 ? value.resetsAt * 1000 : value.resetsAt) : undefined);
      // Its fullest window (Claude's `unifiedWindows`); a report without windows says none is full.
      const windows = Object.values((value as { unifiedWindows?: Record<string, { utilization?: number }> }).unifiedWindows ?? {});
      this.used.set(cli, Math.max(0, ...windows.map((w) => (typeof w?.utilization === 'number' ? w.utilization : 0))));
    }
    if (msg.method === 'session/update' && MODEL_UPDATES.has(msg.params?.update?.sessionUpdate)) {
      s.firstCall?.();
      s.firstCall = undefined;
    }
    s.record(msg);
  }

  /**
   * A session's start, one at a time for a CLI whose refresh tokens work once: starting one starts
   * a process of the CLI, which may refresh its sign-in before any prompt.
   */
  private async alone<T>(e: Engine, start: () => Promise<T>): Promise<T> {
    if (!e.agent.cli.oneRefresher) return start();
    const done = await e.firstCall.enter();
    try {
      return await start();
    } finally {
      done();
    }
  }

  private engine(cli: string): Engine {
    const e = this.engines.get(cli);
    if (!e) throw new RpcFailure({ code: -32602, message: `no CLI named ${cli}` });
    return e;
  }

  private open(e: Engine, cli: string, id: string): Session {
    if (typeof id !== 'string' || !id) throw new RpcFailure({ code: -32602, message: 'sessionId missing' });
    let s = e.sessions.get(id);
    if (!s) {
      s = new Session(cli, id, e.dir);
      e.sessions.set(id, s);
    }
    return s;
  }

  /** A session the CLI holds now; one it does not is loaded first, with its cwd and MCP servers. */
  private known(e: Engine, id: unknown): Session {
    const s = typeof id === 'string' ? e.sessions.get(id) : undefined;
    if (!s || !e.agent.known.has(s.id))
      throw new RpcFailure({ code: -32602, message: 'unknown session: session/load it first' });
    return s;
  }
}

function without(r: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> {
  const { [key]: _, ...rest } = r ?? {};
  return rest;
}

/** A session id as a file name: the id when it is one, its hash otherwise. */
function safeName(id: string): string {
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : createHash('sha256').update(id).digest('hex');
}
