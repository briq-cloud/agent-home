import { type ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import type { Cli } from './clis.ts';
import { log } from './log.ts';

export type Id = string | number;

/** A JSON-RPC message, as ACP sends it: a request, a response or a notification. */
export interface Rpc {
  jsonrpc: '2.0';
  id?: Id | null;
  method?: string;
  params?: any;
  result?: unknown;
  error?: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcFailure extends Error {
  readonly error: RpcError;
  constructor(error: RpcError) {
    super(error.message);
    this.error = error;
  }
}

export interface AgentEvents {
  /** A notification from the CLI: `session/update` and the like. */
  notification(msg: Rpc): void;
  /** A request from the CLI to its client, such as a permission: its result, or a throw. */
  request(msg: Rpc): Promise<unknown>;
  /** The process ended: every session it had must be loaded again. */
  exited(): void;
}

/**
 * One CLI's ACP process, shared by every session of that CLI: one Codex app server per home, one
 * Claude adapter. Started on first use, again after it exits.
 */
export class Agent {
  readonly cli: Cli;
  /** Sessions this process holds. A new process holds none until each is loaded again. */
  readonly known = new Set<string>();
  private readonly env: Record<string, string>;
  private readonly cwd: string;
  private readonly events: AgentEvents;
  private child: ChildProcess | undefined;
  private writer: WritableStreamDefaultWriter<Rpc> | undefined;
  private ready: Promise<unknown> | undefined;
  private next = 1;
  private readonly pending = new Map<Id, { resolve(v: unknown): void; reject(e: Error): void }>();

  constructor(cli: Cli, env: Record<string, string>, cwd: string, events: AgentEvents) {
    this.cli = cli;
    this.env = env;
    this.cwd = cwd;
    this.events = events;
  }

  get running(): boolean {
    return this.child !== undefined;
  }

  /** Its `initialize` answer, starting the process first if needed. */
  ensure(): Promise<unknown> {
    this.ready ??= this.start().catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.ensure().then(() => this.call(method, params));
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  stop(): void {
    this.child?.kill('SIGTERM');
  }

  /** Stops the process and waits for it to exit: nothing holds the CLI's sign-in in memory after. */
  stopAndWait(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private async start(): Promise<unknown> {
    const [cmd, ...args] = this.cli.acp;
    const child = spawn(cmd as string, args, {
      cwd: this.cwd,
      env: withEnv(this.env, this.cli.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    // Kept short and only for a crash: what an adapter prints is its own business.
    let tail = '';
    child.stderr?.on('data', (b: Buffer) => {
      tail = (tail + b.toString()).slice(-400);
    });
    child.on('error', (err) => log.warn('agent did not start', { cli: this.cli.name, err: err.message }));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      log.info('agent exited', { cli: this.cli.name, code, signal, ...(code ? { tail } : {}) });
      this.child = undefined;
      this.writer = undefined;
      this.ready = undefined;
      this.known.clear();
      for (const p of this.pending.values()) p.reject(new RpcFailure({ code: -32603, message: `${this.cli.name} exited` }));
      this.pending.clear();
      this.events.exited();
    });
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin as Writable) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>,
    );
    this.writer = stream.writable.getWriter() as WritableStreamDefaultWriter<Rpc>;
    void this.read(stream.readable as ReadableStream<Rpc>, child);
    log.info('agent started', { cli: this.cli.name, pid: child.pid });
    // No file system or terminal of the client's: each CLI uses its own tools, in the home.
    return this.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-home-runner', version: '0.1.0' },
    });
  }

  private call(method: string, params: unknown): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(msg: Rpc): void {
    this.writer?.write(msg).catch((err: unknown) => {
      log.warn('could not write to agent', { cli: this.cli.name, err: String(err) });
    });
  }

  private async read(readable: ReadableStream<Rpc>, child: ChildProcess): Promise<void> {
    try {
      for await (const msg of readable) {
        if (this.child !== child) return;
        this.receive(msg);
      }
    } catch (err) {
      log.warn('agent stream ended', { cli: this.cli.name, err: String(err) });
    }
  }

  private receive(msg: Rpc): void {
    const isCall = typeof msg.method === 'string';
    const hasId = msg.id !== undefined && msg.id !== null;
    if (!isCall && hasId) {
      const p = this.pending.get(msg.id as Id);
      if (!p) return;
      this.pending.delete(msg.id as Id);
      if (msg.error) p.reject(new RpcFailure(msg.error));
      else p.resolve(msg.result);
    } else if (isCall && hasId) {
      const id = msg.id as Id;
      this.events.request(msg).then(
        (result) => this.write({ jsonrpc: '2.0', id, result }),
        (err: unknown) =>
          this.write({
            jsonrpc: '2.0',
            id,
            error: err instanceof RpcFailure ? err.error : { code: -32603, message: String(err) },
          }),
      );
    } else if (isCall) {
      this.events.notification(msg);
    }
  }
}

/** The runner's variables for its CLIs, with a CLI's own over them: `null` removes one. */
export function withEnv(env: Record<string, string>, own: Record<string, string | null> | undefined): Record<string, string> {
  const out = { ...env };
  for (const [k, v] of Object.entries(own ?? {})) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}
