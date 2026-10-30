import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Agent, type Rpc, RpcFailure } from './agent.ts';
import { effectiveCliEnv, nativeHarness, type Cli } from '../providers/catalog.ts';
import type { SubscriptionAccount } from '../providers/accounts.ts';
import { log } from '../telemetry/log.ts';
import { parseAcpAuthStatus } from '../auth/status.ts';
import {
  ExtensionRegistry,
  homeInstructions,
  type AgentCapabilities,
  type DeploymentContext,
  type ExtensionStatus,
} from '../extensions/index.ts';

export interface HubExtensions {
  registry: ExtensionRegistry;
  env?: () => Record<string, string | undefined>;
  deployment?: DeploymentContext;
}
type SessionExtensions = {
  revision: string;
  statuses: ExtensionStatus[];
  skills: Array<{ name: string; status: string }>;
  instructionDelivery: 'system_append' | 'user_context';
};

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
  homeContext?: string;
  homeContextDelivered = false;
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
  extensions?: HubExtensions;
  beforeStart?: (cli: string) => Promise<() => void>;
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
  private readonly authGates = new Map<string, FirstCall>();
  private readonly signingIn = new Set<string>();
  /** One outstanding read-only auth probe per CLI process, even when callers time out. */
  private readonly authProbes = new WeakMap<Engine, Promise<boolean | null>>();
  private readonly slots: Slots;
  private readonly route: string[];
  private readonly signedIn: (cli: string) => Promise<boolean | null>;
  private readonly stateDir: string;
  private readonly beforeStart: HubOptions['beforeStart'];
  private extensions?: HubExtensions;
  private readonly advertised = new Map<string, AgentCapabilities>();
  /** CLIs at their plan's limit, until when: `/acp` picks another. */
  private readonly limited = new Map<string, number>();
  /** How much of its plan each CLI last said it used, its fullest window (0 to 1). */
  private readonly used = new Map<string, number>();

  private readonly env: Record<string, string>;
  private readonly cwd: string;

  constructor(opts: HubOptions) {
    this.slots = new Slots(opts.maxTurns);
    this.stateDir = opts.stateDir;
    this.beforeStart = opts.beforeStart;
    this.extensions = opts.extensions;
    this.env = opts.env;
    this.cwd = opts.cwd;
    this.route = opts.route?.length ? opts.route : opts.clis.map((c) => c.name);
    this.signedIn = opts.signedIn ?? (async () => null);
    for (const cli of opts.clis) this.add(cli);
  }

  /** Owner composition only; updates apply when a native session is opened or
   * loaded into a new process, never by rebinding a live session. */
  configureExtensions(options?: HubExtensions): void {
    this.extensions = options;
  }

  extensionStatus(): Array<{
    cli: string;
    harness: string;
    initialized: boolean;
    statuses: ExtensionStatus[];
  }> {
    if (!this.extensions) return [];
    const names = Object.entries(this.extensions.env?.() ?? this.env)
      .filter(([, value]) => !!value)
      .map(([key]) => key);
    return [...this.engines].map(([cli, engine]) => {
      const harness = nativeHarness(engine.agent.cli);
      const capabilities = this.advertised.get(cli);
      return {
        cli,
        harness,
        initialized: !!capabilities,
        statuses: this.extensions!.registry.status({
          cli: harness,
          capabilities: capabilities ?? {},
          availableEnvNames: names,
        }).map((status) =>
          !capabilities && status.status === 'unsupported'
            ? {
                ...status,
                status: 'unverified' as const,
                reason: 'Native transport capabilities have not been advertised in this process',
              }
            : status,
        ),
      };
    });
  }

  private prepareSkills(cli: string): Array<{ name: string; status: string }> {
    if (!this.extensions) return [];
    const native = this.engine(cli).agent.cli;
    const harness = nativeHarness(native);
    if (!['claude', 'codex', 'copilot', 'cursor', 'grok', 'vibe', 'gemini'].includes(harness)) return [];
    const env: Record<string, string | undefined> = { ...this.env };
    for (const [name, value] of Object.entries(native.env ?? {})) env[name] = value ?? undefined;
    const paths = {
      ...(env.HOME && isAbsolute(env.HOME) ? { agentsHome: join(env.HOME, '.agents') } : {}),
      ...(harness === 'claude' && env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR)
        ? { claudeConfigDir: env.CLAUDE_CONFIG_DIR }
        : {}),
    };
    // Recheck ownership at native lifecycle boundaries: the person may replace
    // a discovery link without changing registry metadata between sessions.
    return this.extensions.registry.syncSkills(paths).map(({ name, status }) => ({ name, status }));
  }

  private async sessionParams(
    cli: string,
    params: Rpc['params'],
  ): Promise<{ params: Rpc['params']; context?: string; snapshot?: SessionExtensions }> {
    if (!this.extensions) return { params };
    let skills: Array<{ name: string; status: string }>;
    try {
      skills = this.prepareSkills(cli);
    } catch {
      throw new RpcFailure({
        code: -32602,
        message: 'Shared skill discovery could not be prepared; inspect extension ownership and native home paths',
      });
    }
    const initialized = (await this.initialize(cli)) as { agentCapabilities?: AgentCapabilities };
    const capabilities = initialized?.agentCapabilities ?? {};
    const harness = nativeHarness(this.engine(cli).agent.cli);
    let plan;
    try {
      plan = this.extensions.registry.plan({
        cli: harness,
        capabilities,
        incomingServers: params?.mcpServers,
        env: this.extensions.env?.() ?? this.env,
      });
    } catch {
      throw new RpcFailure({
        code: -32602,
        message:
          'Shared MCP configuration is invalid: inspect server names, caller collisions, installed commands, and credential references',
      });
    }
    if (plan.blocked) {
      const required = new Set(
        this.extensions.registry
          .list()
          .servers.filter((server) => server.enabled && server.required)
          .map((server) => server.name),
      );
      throw new RpcFailure({
        code: -32602,
        message: `Required shared extensions unavailable: ${plan.statuses
          .filter((status) => required.has(status.name) && status.status !== 'ready')
          .map((status) => `${status.name} (${status.status})`)
          .join(', ')}`,
      });
    }
    const context = homeInstructions({
      workspace: params?.cwd ?? this.cwd,
      availableTools: plan.statuses.filter((status) => status.status === 'ready').map((status) => `mcp:${status.name}`),
      deployment: this.extensions.deployment,
    });
    const caller = params?.systemPrompt;
    const systemCapability = capabilities.sessionCapabilities?.systemPrompt;
    const append =
      ['claude', 'codex'].includes(harness) &&
      typeof systemCapability === 'object' &&
      systemCapability !== null &&
      !Array.isArray(systemCapability) &&
      (caller == null || (caller.mode === 'append' && Array.isArray(caller.content)));
    return {
      params: {
        ...params,
        mcpServers: plan.servers,
        ...(append
          ? {
              systemPrompt: {
                ...(caller ?? {}),
                mode: 'append',
                content: [...(caller?.content ?? []), { type: 'text', text: context }],
              },
            }
          : {}),
      },
      ...(append ? {} : { context }),
      snapshot: {
        revision: plan.registryRevision,
        statuses: plan.statuses,
        skills,
        instructionDelivery: append ? 'system_append' : 'user_context',
      },
    };
  }

  private recordExtensions(
    session: Session,
    prepared: Awaited<ReturnType<Hub['sessionParams']>>,
    delivered = session.homeContextDelivered,
  ): void {
    if (prepared.snapshot)
      session.record({
        jsonrpc: '2.0',
        method: '_runner/extensions',
        params: { sessionId: session.id, ...prepared.snapshot, homeContextDelivered: delivered },
      });
  }

  private protectMcpDispatch(e: Engine, params: Rpc['params']): void {
    if (
      Array.isArray(params?.mcpServers) &&
      params.mcpServers.some((server: any) =>
        [server?.env, server?.headers].some(
          (entries) =>
            Array.isArray(entries) &&
            entries.some((entry) => typeof entry?.value === 'string' && entry.value.length > 0),
        ),
      )
    )
      e.agent.protectCrashDetails();
  }

  /** A CLI to drive, from now on: a profile the person just made. Its sessions' logs stay where they were. */
  add(cli: Cli): void {
    this.advertised.delete(cli.name);
    const dir = join(this.stateDir, 'sessions', cli.name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sessions = new Map<string, Session>();
    const agent = new Agent(cli, this.env, this.cwd, {
      beforeStart: async () => {
        this.assertSignInIdle(cli.name);
        try {
          this.prepareSkills(cli.name);
        } catch {
          throw new RpcFailure({
            code: -32602,
            message: 'Shared skill discovery could not be prepared; inspect extension ownership and native home paths',
          });
        }
        return this.beforeStart ? this.beforeStart(cli.name) : () => {};
      },
      notification: (msg) => this.fromAgent(cli.name, sessions, msg),
      request: (msg) => {
        const s = sessions.get(msg.params?.sessionId);
        if (!s) return Promise.reject(new RpcFailure({ code: -32602, message: 'unknown session' }));
        return s.hold(msg.method as string, msg.params);
      },
      exited: () => {
        this.advertised.delete(cli.name);
        for (const s of sessions.values()) s.dropHeld(`${cli.name} exited`);
      },
    });
    const group = this.authGroup(cli);
    let firstCall = this.authGates.get(group);
    if (!firstCall) this.authGates.set(group, (firstCall = new FirstCall()));
    this.engines.set(cli.name, { agent, sessions, firstCall, dir });
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

  /** Metadata updates never restart an account process or move its existing sessions. */
  setAccountMetadata(cli: string, account: SubscriptionAccount | undefined): void {
    this.engine(cli).agent.cli.subscriptionAccount = account;
  }
  private authGroup(cli: Cli): string {
    const env = effectiveCliEnv(cli, this.env),
      harness = nativeHarness(cli);
    const path =
      harness === 'claude'
        ? (env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? this.cwd, '.claude'))
        : harness === 'codex'
          ? (env.CODEX_HOME ?? join(env.HOME ?? this.cwd, '.codex'))
          : cli.name;
    let canonical = resolve(path);
    try {
      canonical = realpathSync(canonical);
    } catch {}
    return `${harness}:${canonical}`;
  }
  private assertSignInIdle(cli: string): void {
    if (this.signingIn.has(this.authGroup(this.engine(cli).agent.cli)))
      throw new RpcFailure({ code: -32002, message: 'Account sign-in is in progress' });
  }
  /** Pause new work before reauthentication; release only after the native login exits. */
  async beginSignIn(cli: string): Promise<() => void> {
    const e = this.engine(cli),
      group = this.authGroup(e.agent.cli);
    const related = [...this.engines].filter(([, value]) => this.authGroup(value.agent.cli) === group);
    if (this.signingIn.has(group) || related.some(([name]) => this.busy(name)))
      throw new RpcFailure({ code: -32002, message: 'Account has active native work' });
    this.signingIn.add(group);
    try {
      const release = await e.firstCall.enter();
      try {
        if (related.some(([name]) => this.busy(name))) throw Error('Account has active native work');
        await Promise.all(related.map(([, value]) => value.agent.stopAndWait()));
      } finally {
        release();
      }
      return () => {
        this.signingIn.delete(group);
      };
    } catch (error) {
      this.signingIn.delete(group);
      throw error;
    }
  }

  /** The CLI's own `initialize` answer, without the sign-in methods the home never offers. */
  async initialize(cli: string): Promise<unknown> {
    this.assertSignInIdle(cli);
    const e = this.engine(cli);
    const r = (await e.agent.ensure()) as { authMethods?: Array<{ id?: string }> } | undefined;
    this.advertised.set(cli, (r as { agentCapabilities?: AgentCapabilities })?.agentCapabilities ?? {});
    const blocked = e.agent.cli.blockedAuth;
    if (!blocked?.length || !r?.authMethods) return r;
    return { ...r, authMethods: r.authMethods.filter((m) => !blocked.includes(m.id ?? '')) };
  }

  /**
   * A provider's documented read-only ACP auth-status extension, using its existing ACP process.
   * This does not create a conversation or call `session/prompt`; unavailable or malformed
   * responses remain unknown. Only the boolean is surfaced to callers.
   */
  async authStatus(cli: string, timeoutMs = 5_000): Promise<boolean | null> {
    const e = this.engine(cli);
    const method = e.agent.cli.authStatusMethod;
    if (!method) return null;
    let probe = this.authProbes.get(e);
    if (!probe) {
      // Keep the underlying RPC tracked until it settles. A caller deadline only stops waiting;
      // it must not enqueue another request or kill an agent process that may hold active work.
      probe = e.agent.request(method, {}).then(
        (response) => parseAcpAuthStatus(response),
        () => null,
      );
      this.authProbes.set(e, probe);
      void probe.then(() => {
        if (this.authProbes.get(e) === probe) this.authProbes.delete(e);
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        probe,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('ACP auth status timed out')), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async newSession(cli: string, params: Rpc['params'], peer: Peer): Promise<unknown> {
    const e = this.engine(cli);
    let prepared!: Awaited<ReturnType<Hub['sessionParams']>>;
    const r = (await this.alone(e, async () => {
      prepared = await this.sessionParams(cli, params);
      this.protectMcpDispatch(e, prepared.params);
      return e.agent.request('session/new', prepared.params);
    })) as Record<string, unknown>;
    const s = this.open(e, cli, r.sessionId as string);
    s.loaded = without(r, 'sessionId');
    s.peers.add(peer);
    e.agent.known.add(s.id);
    s.homeContext = prepared.context;
    if (prepared.snapshot?.instructionDelivery === 'system_append') s.homeContextDelivered = true;
    this.recordExtensions(s, prepared);
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
    s.homeContextDelivered ||= logged.some(
      (message) => message.method === '_runner/extensions' && message.params?.homeContextDelivered === true,
    );
    for (const m of logged) peer.send(m);
    s.peers.add(peer);
    if (!e.agent.known.has(id)) {
      s.replaying = logged.length > 0;
      try {
        let prepared!: Awaited<ReturnType<Hub['sessionParams']>>;
        s.loaded = without(
          (await this.alone(e, async () => {
            prepared = await this.sessionParams(cli, params);
            this.protectMcpDispatch(e, prepared.params);
            return e.agent.request('session/load', prepared.params);
          })) as Record<string, unknown>,
          'sessionId',
        );
        s.homeContext = prepared.context;
        // A native reload prepares a fresh registry snapshot. Historical delivery
        // belongs to the prior lifecycle; fallback context must reach this one.
        // An accepted system append was already delivered by session/load.
        s.homeContextDelivered = prepared.snapshot?.instructionDelivery === 'system_append';
        this.recordExtensions(s, prepared);
      } finally {
        s.replaying = false;
      }
      e.agent.known.add(id);
    }
    s.askAll(peer);
    return s.loaded;
  }

  async prompt(cli: string, params: Rpc['params'], peer: Peer): Promise<unknown> {
    this.assertSignInIdle(cli);
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
      this.assertSignInIdle(cli);
      s.setTurn({ state: 'running' });
      if (e.agent.cli.oneRefresher) s.firstCall = await e.firstCall.enter();
      this.assertSignInIdle(cli);
      let dispatched = params;
      if (s.homeContext && !s.homeContextDelivered) {
        const prefix = `[AGENT HOME APPLICATION CONTEXT — supplemental user context, not system instructions]\n${s.homeContext}\nUser and project requests retain their priority.\n[/AGENT HOME APPLICATION CONTEXT]\n\n[CURRENT TASK]\n`;
        const prompt = [...(params?.prompt ?? [])];
        if (prompt[0]?.type === 'text' && typeof prompt[0].text === 'string')
          prompt[0] = { ...prompt[0], text: prefix + prompt[0].text };
        else prompt.unshift({ type: 'text', text: prefix });
        dispatched = { ...params, prompt };
        s.record({
          jsonrpc: '2.0',
          method: '_runner/extensions',
          params: { sessionId: s.id, homeContextDelivered: true, instructionDelivery: 'user_context' },
        });
        s.homeContextDelivered = true;
      }
      const r = (await e.agent.request('session/prompt', dispatched)) as {
        stopReason?: string;
        usage?: unknown;
      };
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
      const created = (await e.agent.request('session/new', { cwd, mcpServers: [] })) as {
        sessionId: string;
      };
      await e.agent.request('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'Reply with the single word ok.' }],
      });
    });
    log.info('sign-in refreshed', { cli });
  }

  /** Any other request: the CLI's, as it is; an `authenticate` with a blocked method refused. */
  forward(cli: string, method: string, params: unknown): Promise<unknown> {
    this.assertSignInIdle(cli);
    const e = this.engine(cli);
    const methodId = (params as { methodId?: string } | undefined)?.methodId;
    if (method === 'authenticate' && methodId && e.agent.cli.blockedAuth?.includes(methodId))
      return Promise.reject(
        new RpcFailure({
          code: -32602,
          message: `${cli} does not sign in with ${methodId} in an agent home`,
        }),
      );
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
    const ordered = [
      ...new Set(
        this.route.flatMap((cli) => {
          if (cli !== 'claude') return [cli];
          const accounts = [...this.engines.values()].map((e) => e.agent.cli).filter((c) => c.subscriptionAccount);
          return accounts.length
            ? accounts
                .sort(
                  (a, b) =>
                    a.subscriptionAccount!.priority - b.subscriptionAccount!.priority ||
                    Number(b.subscriptionAccount!.isDefault) - Number(a.subscriptionAccount!.isDefault) ||
                    a.name.localeCompare(b.name),
                )
                .map((c) => c.name)
            : [cli];
        }),
      ),
    ];
    const fit: Array<{ cli: string; rank: number; busy: number; nearLimit: boolean }> = [];
    for (const [rank, cli] of ordered.entries()) {
      if (!this.engines.has(cli) || (this.limited.get(cli) ?? 0) > now) continue;
      const account = this.engine(cli).agent.cli.subscriptionAccount;
      if (account?.enabled === false || this.signingIn.has(this.authGroup(this.engine(cli).agent.cli))) continue;
      const signedIn = await this.signedIn(cli);
      if (signedIn === false || (account && signedIn !== true)) continue;
      let busy = 0;
      for (const s of this.engine(cli).sessions.values()) if (s.turn.state !== 'idle') busy++;
      fit.push({ cli, rank, busy, nearLimit: (this.used.get(cli) ?? 0) >= NEAR_LIMIT });
    }
    // A plan nearly used up last; then the least busy, then the earliest in the route: a second
    // session goes to the next CLI while the first is busy, rather than queue behind it.
    fit.sort((a, b) => Number(a.nearLimit) - Number(b.nearLimit) || a.busy - b.busy || a.rank - b.rank);
    const first = fit[0];
    if (!first)
      throw new RpcFailure({
        code: -32002,
        message: 'no CLI to give a session to: all are signed out or at their limit',
      });
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
    return Object.fromEntries(
      [...this.limited].filter(([, t]) => t > now).map(([cli, t]) => [cli, new Date(t).toISOString()]),
    );
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
        this.limit(
          cli,
          typeof value.resetsAt === 'number'
            ? value.resetsAt < 1e12
              ? value.resetsAt * 1000
              : value.resetsAt
            : undefined,
        );
      // Its fullest window (Claude's `unifiedWindows`); a report without windows says none is full.
      const windows = Object.values(
        (value as { unifiedWindows?: Record<string, { utilization?: number }> }).unifiedWindows ?? {},
      );
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
    this.assertSignInIdle(e.agent.cli.name);
    if (!e.agent.cli.oneRefresher) return start();
    const done = await e.firstCall.enter();
    try {
      this.assertSignInIdle(e.agent.cli.name);
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
