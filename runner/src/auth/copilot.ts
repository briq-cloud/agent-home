import { spawn } from 'node:child_process';
import {
  createMessageConnection,
  ErrorCodes,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';

export type CopilotCheckReason = 'busy' | 'timeout' | 'unavailable' | 'unsupported' | 'invalid-response' | 'closed';
export interface CopilotAccountSnapshot {
  signedIn: boolean | null;
  checkedAt: string;
  source: 'sdk';
  reason?: CopilotCheckReason;
}
type ReadOnlyMethod = 'connect' | 'ping' | 'auth.getStatus';
export interface CopilotReadOnlyTransport {
  request(method: ReadOnlyMethod, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export interface CopilotTransportOptions {
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
  signal: AbortSignal;
}
export interface CopilotAccountOptions {
  command?: string[];
  env?: Record<string, string>;
  cwd?: string;
  canCheck?: () => boolean;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
  createTransport?: (options: CopilotTransportOptions) => CopilotReadOnlyTransport;
}
class ProbeFailure extends Error {
  readonly reason: CopilotCheckReason;
  constructor(reason: CopilotCheckReason) {
    super(reason);
    this.reason = reason;
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const methods = new Set<ReadOnlyMethod>(['connect', 'ping', 'auth.getStatus']);
function reason(error: unknown): CopilotCheckReason {
  if (error instanceof ProbeFailure) return error.reason;
  if (object(error).code === ErrorCodes.MethodNotFound) return 'unsupported';
  return 'unavailable';
}

/** The native stdio transport used by GitHub's SDK, without its bundled CLI or
 * native FFI dependencies. Reference (pinned):
 * https://github.com/github/copilot-sdk/blob/v1.0.28/nodejs/src/client.ts
 * startCLIServer / connectViaStdio / verifyProtocolVersion / getAuthStatus.
 * Methods are allowlisted; no sessions, prompts, sign-in or credential RPCs.
 * No vendor output/errors/identity/token fields are logged or returned.
 */
export function createCopilotReadOnlyTransport(options: CopilotTransportOptions): CopilotReadOnlyTransport {
  if (
    !options.command.length ||
    options.command.some((part) => typeof part !== 'string' || !part || part.includes('\0'))
  )
    throw new ProbeFailure('unavailable');
  const child = spawn(options.command[0]!, [...options.command.slice(1), '--headless', '--no-auto-update', '--stdio'], {
    env: options.env,
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let closing = false,
    closed: Promise<void> | undefined,
    bytes = 0;
  let rejectFailure!: (failure: ProbeFailure) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  failed.catch(() => {});
  const fail = (why: CopilotCheckReason) => rejectFailure(new ProbeFailure(why));
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* Process may already have exited. */
    }
  };
  const count = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 256_000) {
      fail('invalid-response');
      kill('SIGKILL');
    }
  };
  child.stdout.on('data', count);
  child.stdin.on('error', () => fail('unavailable'));
  child.once('error', () => fail('unavailable'));
  child.once('exit', () => {
    if (!closing) fail('unavailable');
  });
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
    {
      error() {},
      warn() {},
      info() {},
      log() {},
    },
  );
  connection.onError(() => fail('invalid-response'));
  connection.onClose(() => {
    if (!closing) fail('unavailable');
  });
  connection.onRequest(() => {
    throw new ResponseError(ErrorCodes.MethodNotFound, 'Read-only account observer');
  });
  connection.onNotification(() => {});
  connection.listen();
  const abort = () => {
    fail(options.signal.reason instanceof ProbeFailure ? options.signal.reason.reason : 'unavailable');
    kill('SIGKILL');
  };
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const waitForExit = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async request(method, params) {
      if (!methods.has(method) || closing) throw new ProbeFailure('unsupported');
      if (options.signal.aborted) throw options.signal.reason;
      return Promise.race([connection.sendRequest(method, params), failed]);
    },
    close() {
      return (closed ??= (async () => {
        closing = true;
        options.signal.removeEventListener('abort', abort);
        child.stdout.off('data', count);
        connection.dispose();
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null) {
          kill('SIGTERM');
          await waitForExit();
          if (child.exitCode === null && child.signalCode === null) {
            kill('SIGKILL');
            await waitForExit();
          }
        }
        child.stdout.destroy();
      })());
    },
  };
}

/** Sessionless native account observation; unknown never implies signed in/out.
 * A short-lived process avoids stale process-global vendor account caches. Only
 * public SDK auth.getStatus is used; no account token reads or login/refresh RPCs.
 * Callers gate active native work/sign-in via canCheck and invalidate before a
 * sign-in starts and after it completes. Cache and singleflight cover all calls.
 * See https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility
 */
export class CopilotAccountObserver {
  private readonly options: CopilotAccountOptions;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private generation = 0;
  private cached?: { at: number; value: CopilotAccountSnapshot };
  private active?: { generation: number; controller: AbortController; promise: Promise<CopilotAccountSnapshot> };
  private closed = false;
  constructor(options: CopilotAccountOptions = {}) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cacheMs = options.cacheMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 30_000 ||
      !Number.isSafeInteger(this.cacheMs) ||
      this.cacheMs < 0 ||
      this.cacheMs > 300_000
    )
      throw new Error('Invalid Copilot observation limits');
  }
  private snapshot(signedIn: boolean | null, why?: CopilotCheckReason): CopilotAccountSnapshot {
    return { signedIn, checkedAt: new Date(this.now()).toISOString(), source: 'sdk', ...(why ? { reason: why } : {}) };
  }
  async check(): Promise<CopilotAccountSnapshot> {
    if (this.closed) return this.snapshot(null, 'closed');
    if (this.active) {
      if (this.active.generation === this.generation) return { ...(await this.active.promise) };
      await this.active.promise;
      return this.check();
    }
    if (this.cached && this.now() - this.cached.at >= 0 && this.now() - this.cached.at < this.cacheMs)
      return { ...this.cached.value };
    if (this.options.canCheck && !this.options.canCheck()) return this.snapshot(null, 'busy');
    const controller = new AbortController(),
      generation = this.generation;
    // Defer work one microtask so all exit paths see the registered singleflight.
    const promise = Promise.resolve()
      .then(() => this.observe(controller))
      .then((value) => {
        if (generation === this.generation && !this.closed) this.cached = { at: this.now(), value };
        return value;
      })
      .finally(() => {
        if (this.active?.promise === promise) this.active = undefined;
      });
    this.active = { generation, controller, promise };
    return { ...(await promise) };
  }
  async invalidate(): Promise<void> {
    this.generation++;
    this.cached = undefined;
    const active = this.active;
    active?.controller.abort(new ProbeFailure('busy'));
    await active?.promise;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.invalidate();
  }
  private async observe(controller: AbortController): Promise<CopilotAccountSnapshot> {
    let transport: CopilotReadOnlyTransport | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const request = (method: ReadOnlyMethod) => Promise.race([transport!.request(method, {}), interrupted]);
    try {
      timer = setTimeout(() => controller.abort(new ProbeFailure('timeout')), this.timeoutMs);
      if (controller.signal.aborted) throw controller.signal.reason;
      transport = (this.options.createTransport ?? createCopilotReadOnlyTransport)({
        command: this.options.command ?? ['copilot'],
        env: this.options.env,
        cwd: this.options.cwd,
        signal: controller.signal,
      });
      let handshake: unknown;
      try {
        handshake = await request('connect');
      } catch (error) {
        if (object(error).code !== ErrorCodes.MethodNotFound) throw error;
        handshake = await request('ping'); // Same legacy fallback as the official SDK.
      }
      if (object(handshake).protocolVersion !== 3) throw new ProbeFailure('unsupported');
      const response = object(await request('auth.getStatus'));
      if (typeof response.isAuthenticated !== 'boolean') throw new ProbeFailure('invalid-response');
      return this.snapshot(response.isAuthenticated);
    } catch (error) {
      return this.snapshot(null, reason(error));
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      try {
        await transport?.close();
      } catch {
        /* Never expose vendor teardown errors. */
      }
    }
  }
}
