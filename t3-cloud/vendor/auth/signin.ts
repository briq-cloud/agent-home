import { type ChildProcess, spawn } from 'node:child_process';
interface Cli { name: string; login?: string[] }
import type { CredentialLifetime } from './status.ts';
import { log } from '../telemetry/log.ts';

/** What a sign-in shows the app: the vendor's page, and a code when the vendor gives one. */
export interface SignInState {
  state: 'idle' | 'starting' | 'waiting' | 'done' | 'failed';
  url?: string;
  code?: string;
  reason?: 'cancelled' | 'timed_out' | 'start_failed' | 'command_failed';
}
export interface SignInOptions {
  timeoutMs?: number;
  pageWaitMs?: number;
  startWaitMs?: number;
  direct?: boolean;
  cleanupTimeoutMs?: number;
  spawnProcess?: typeof spawn;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;
const URL_RE = /https:\/\/[^\s"'<>]+/;
/** Device codes as the vendors print them: ABCD-EFGH, ABCD-12345. */
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/;
/** Copilot asks before it writes its sign-in to a file: a VM has no keychain. */
const PLAINTEXT_RE = /plain ?text/i;
const SIGN_IN_MS = 15 * 60_000;

/**
 * The vendor's own sign-in command, directly for line-based commands or through
 * `script` for terminal flows, with the person approving
 * on the vendor's page in their own browser. The runner reads the page's address and the code
 * from what the command prints, and passes on what the person types back (Claude's code). Only
 * those leave it: never the rest of the output.
 */
export class SignIn {
  readonly cli: Cli;
  private child: ChildProcess | undefined;
  private lifetimeUnknown = false;
  private current: SignInState = { state: 'idle' };
  private seen = '';
  private answeredPlaintext = false;
  private readonly listeners = new Set<() => void>();
  private readonly options: Required<Pick<SignInOptions, 'timeoutMs' | 'pageWaitMs' | 'startWaitMs' | 'cleanupTimeoutMs'>>;
  private readonly direct: boolean;
  private readonly spawnProcess: typeof spawn;
  private finishLifetime?: (outcome: CredentialLifetime) => void;

  private readonly completed?: () => void;
  private readonly ended?: (outcome: CredentialLifetime) => void;

  constructor(cli: Cli, completed?: () => void, options: SignInOptions = {}, ended?: (outcome: CredentialLifetime) => void) {
    this.completed = completed;
    this.ended = ended;
    this.cli = cli;
    this.direct = options.direct === true;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.options = {
      timeoutMs: options.timeoutMs ?? SIGN_IN_MS,
      cleanupTimeoutMs: options.cleanupTimeoutMs ?? 1000,
      pageWaitMs: options.pageWaitMs ?? 3000,
      startWaitMs: options.startWaitMs ?? 30_000,
    };
    for (const value of Object.values(this.options))
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid sign-in timeout');
  }

  get status(): SignInState {
    return { ...this.current };
  }

  private update(state: SignInState): void {
    this.current = state;
    for (const listener of [...this.listeners]) listener();
  }

  /** Starts it, or keeps the one already waiting. Resolves once the page is known, or it ended. */
  start(env: Record<string, string>, options: { wait?: boolean } = {}): Promise<SignInState> {
    if (this.lifetimeUnknown) return Promise.resolve(this.status);
    if (this.child) return options.wait === false ? Promise.resolve(this.status) : this.settled();
    this.update({ state: 'starting' });
    this.seen = '';
    this.answeredPlaintext = false;
    if (!this.cli.login?.length || this.cli.login.some((part) => typeof part !== 'string' || part.includes('\0'))) {
      this.update({ state: 'failed', reason: 'start_failed' });
      this.ended?.('never-spawned');
      return Promise.resolve(this.status);
    }
    const command = (this.cli.login ?? []).map(shq).join(' ');
    // util-linux in the home. BSD's, on a Mac for tests, refuses a socket as its input: none there.
    const mac = process.platform === 'darwin';
    const args = mac ? ['-q', '/dev/null', 'sh', '-c', command] : ['-qfec', command, '/dev/null'];
    let child: ChildProcess;
    try {
      child = this.spawnProcess(this.direct ? this.cli.login[0]! : 'script', this.direct ? this.cli.login.slice(1) : args, {
        env,
        detached: process.platform !== 'win32',
        stdio: [this.direct || !mac ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch {
      this.update({ state: 'failed', reason: 'start_failed' });
      this.ended?.('never-spawned');
      return Promise.resolve(this.status);
    }
    this.child = child;
    let spawned = false, finished = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    child.once('spawn', () => { spawned = true; });
    const timer = setTimeout(() => this.stop('timed_out'), this.options.timeoutMs);
    const read = (b: Buffer) => {
      if (this.child === child && ['starting', 'waiting'].includes(this.current.state)) this.read(b.toString());
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    // Writes can race vendor termination; an EPIPE must never crash the runner.
    child.stdin?.on('error', () => {});
    const finish = (code: number | null, outcome: CredentialLifetime, failedToStart = false) => {
      if (finished) return;
      finished = true;
      this.lifetimeUnknown = this.direct && outcome === 'unknown';
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      this.finishLifetime = undefined;
      child.stdout?.off('data', read);
      child.stderr?.off('data', read);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (this.child !== child) return;
      this.child = undefined;
      this.seen = '';
      if (this.current.state !== 'failed') {
        this.update({
          ...this.current,
          state: code === 0 ? 'done' : 'failed',
          ...(code === 0 ? {} : { reason: failedToStart ? 'start_failed' : 'command_failed' }),
        });
        if (code === 0) {
          try {
            this.completed?.();
          } catch {
            log.warn('sign-in completion could not be recorded', { cli: this.cli.name });
          }
        }
      }
      this.ended?.(outcome);
      log.info('sign-in ended', { cli: this.cli.name, code });
    };
    this.finishLifetime = outcome => {
      if (!cleanupTimer) cleanupTimer = setTimeout(() => finish(null, outcome), this.options.cleanupTimeoutMs);
    };
    child.on('error', () => {
      if (finished) return;
      if (!spawned && child.pid === undefined) return finish(null, 'never-spawned', true);
      this.stop('start_failed');
    });
    // For a PTY wrapper, exit is only UI completion. Only a captured direct
    // credential child supplies the exact termination receipt.
    child.once('exit', code => finish(code, this.direct ? 'terminated' : 'unknown'));
    return options.wait === false ? Promise.resolve(this.status) : this.settled();
  }

  /** Stops one that is waiting: the person gave up, or will start again. */
  cancel(): void {
    this.stop('cancelled');
  }

  private stop(reason: 'cancelled' | 'timed_out' | 'start_failed'): void {
    const child = this.child;
    if (!child) return;
    if (this.current.state !== 'failed') this.update({ ...this.current, state: 'failed', reason });
    // Only direct Claude completion has the new bounded quarantine outcome.
    // PTY flows retain their wrapper/lease until the actual wrapper exit.
    if (this.direct) this.finishLifetime?.('unknown');
    // The direct child owns the line-based login. PTY flows keep their private
    // wrapper group cleanup, which does not prove the credential child ended.
    try {
      if (!this.direct && process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      /* The process may have exited between the state change and kill. */
    }
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  /** What the person typed for it: Claude's code, pasted from its page. */
  input(text: string): boolean {
    const child = this.child;
    if (
      !child?.stdin ||
      !['starting', 'waiting'].includes(this.current.state) ||
      child.exitCode !== null ||
      child.stdin.destroyed ||
      child.stdin.writableEnded ||
      typeof text !== 'string' ||
      !text.trim() ||
      Buffer.byteLength(text) > 4096 ||
      /[\0\r\n]/.test(text)
    )
      return false;
    try {
      child.stdin.write(`${text}${this.direct ? '\n' : '\r'}`);
      return true;
    } catch {
      return false;
    }
  }

  private read(chunk: string): void {
    this.seen = (this.seen + chunk.replace(ANSI, '')).slice(-8000);
    if (!this.answeredPlaintext && PLAINTEXT_RE.test(this.seen)) {
      this.answeredPlaintext = true;
      this.child?.stdin?.write('y\r');
    }
    const url = this.current.url ?? URL_RE.exec(this.seen)?.[0];
    const code = this.current.code ?? CODE_RE.exec(this.seen)?.[0];
    if (url && this.current.state === 'starting') this.update({ state: 'waiting', url, ...(code ? { code } : {}) });
    else if (code && this.current.state === 'waiting' && !this.current.code) this.update({ ...this.current, code });
  }

  /** Resolves when it shows its page (and its code, if it prints one soon after), or ends. */
  private settled(): Promise<SignInState> {
    return new Promise((resolve) => {
      const started = Date.now();
      let pageTimer: ReturnType<typeof setTimeout> | undefined;
      let limitTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(pageTimer);
        clearTimeout(limitTimer);
        this.listeners.delete(check);
        resolve(this.status);
      };
      const check = () => {
        const s = this.current;
        const waited = Date.now() - started;
        if (
          s.state === 'done' ||
          s.state === 'failed' ||
          (s.state === 'waiting' && (s.code || waited >= this.options.pageWaitMs))
        ) {
          finish();
        }
      };
      this.listeners.add(check);
      pageTimer = setTimeout(check, this.options.pageWaitMs);
      limitTimer = setTimeout(finish, this.options.startWaitMs);
      check();
    });
  }
}

/** Single-quoted for sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
