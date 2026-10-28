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
  | { state: 'idle'; stopReason?: string }
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

  setTurn(turn: Turn): void {
    this.turn = turn;
    this.record({ jsonrpc: '2.0', method: '_runner/turn', params: { sessionId: this.id, ...turn } });
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
}

export class Hub {
  private readonly engines = new Map<string, Engine>();
  private readonly slots: Slots;

  constructor(opts: HubOptions) {
    this.slots = new Slots(opts.maxTurns);
    for (const cli of opts.clis) {
      const dir = join(opts.stateDir, 'sessions', cli.name);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const sessions = new Map<string, Session>();
      const agent = new Agent(cli, opts.env, opts.cwd, {
        notification: (msg) => this.fromAgent(sessions, msg),
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
  }

  has(cli: string): boolean {
    return this.engines.has(cli);
  }

  running(cli: string): boolean {
    return this.engine(cli).agent.running;
  }

  /** The CLI's own `initialize` answer: the runner speaks for it. */
  initialize(cli: string): Promise<unknown> {
    return this.engine(cli).agent.ensure();
  }

  async newSession(cli: string, params: Rpc['params'], peer: Peer): Promise<unknown> {
    const e = this.engine(cli);
    const r = (await e.agent.request('session/new', params)) as Record<string, unknown>;
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
        s.loaded = without((await e.agent.request('session/load', params)) as Record<string, unknown>, 'sessionId');
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
      const r = (await e.agent.request('session/prompt', params)) as { stopReason?: string };
      s.setTurn({ state: 'idle', ...(r?.stopReason ? { stopReason: r.stopReason } : {}) });
      return r;
    } catch (err) {
      s.setTurn({ state: 'idle', stopReason: 'error' });
      throw err;
    } finally {
      s.firstCall?.();
      s.firstCall = undefined;
      release();
    }
  }

  /** Any other request: the CLI's, as it is. */
  forward(cli: string, method: string, params: unknown): Promise<unknown> {
    return this.engine(cli).agent.request(method, params);
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

  private fromAgent(sessions: Map<string, Session>, msg: Rpc): void {
    const s = sessions.get(msg.params?.sessionId);
    if (!s || s.replaying) return;
    if (msg.method === 'session/update' && MODEL_UPDATES.has(msg.params?.update?.sessionUpdate)) {
      s.firstCall?.();
      s.firstCall = undefined;
    }
    s.record(msg);
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
