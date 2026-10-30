import { type ChildProcess, spawn } from 'node:child_process';
import type { Cli } from '../providers/catalog.ts';
import { log } from '../telemetry/log.ts';

/** What a sign-in shows the app: the vendor's page, and a code when the vendor gives one. */
export interface SignInState {
  state: 'idle' | 'starting' | 'waiting' | 'done' | 'failed';
  url?: string;
  code?: string;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;
const URL_RE = /https:\/\/[^\s"'<>]+/;
/** Device codes as the vendors print them: ABCD-EFGH, ABCD-12345. */
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/;
/** Copilot asks before it writes its sign-in to a file: a VM has no keychain. */
const PLAINTEXT_RE = /plain ?text/i;
const SIGN_IN_MS = 15 * 60_000;

/**
 * The vendor's own sign-in command, in a terminal (`script` gives it one), the person approving
 * on the vendor's page in their own browser. The runner reads the page's address and the code
 * from what the command prints, and passes on what the person types back (Claude's code). Only
 * those leave it: never the rest of the output.
 */
export class SignIn {
  readonly cli: Cli;
  private child: ChildProcess | undefined;
  private current: SignInState = { state: 'idle' };
  private seen = '';
  private answeredPlaintext = false;

  private readonly completed?: () => void;

  constructor(cli: Cli, completed?: () => void) {
    this.completed = completed;
    this.cli = cli;
  }

  get status(): SignInState {
    return this.current;
  }

  /** Starts it, or keeps the one already waiting. Resolves once the page is known, or it ended. */
  start(env: Record<string, string>): Promise<SignInState> {
    if (this.child && this.current.state !== 'done' && this.current.state !== 'failed') return this.settled();
    this.current = { state: 'starting' };
    this.seen = '';
    this.answeredPlaintext = false;
    const command = (this.cli.login ?? []).map(shq).join(' ');
    // util-linux in the home. BSD's, on a Mac for tests, refuses a socket as its input: none there.
    const mac = process.platform === 'darwin';
    const args = mac ? ['-q', '/dev/null', 'sh', '-c', command] : ['-qfec', command, '/dev/null'];
    const child = spawn('script', args, { env, stdio: [mac ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    this.child = child;
    const timer = setTimeout(() => child.kill('SIGTERM'), SIGN_IN_MS);
    const read = (b: Buffer) => this.read(b.toString());
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (this.child !== child) return;
      this.child = undefined;
      this.current = { ...this.current, state: code === 0 ? 'done' : 'failed' };
      if (code === 0) this.completed?.();
      log.info('sign-in ended', { cli: this.cli.name, code });
    });
    return this.settled();
  }

  /** Stops one that is waiting: the person gave up, or will start again. */
  cancel(): void {
    this.child?.kill('SIGTERM');
  }

  /** What the person typed for it: Claude's code, pasted from its page. */
  input(text: string): boolean {
    if (!this.child?.stdin) return false;
    this.child.stdin.write(`${text}\r`);
    return true;
  }

  private read(chunk: string): void {
    this.seen = (this.seen + chunk.replace(ANSI, '')).slice(-8000);
    if (!this.answeredPlaintext && PLAINTEXT_RE.test(this.seen)) {
      this.answeredPlaintext = true;
      this.child?.stdin?.write('y\r');
    }
    const url = this.current.url ?? URL_RE.exec(this.seen)?.[0];
    const code = this.current.code ?? CODE_RE.exec(this.seen)?.[0];
    if (url && this.current.state === 'starting') this.current = { state: 'waiting', url, ...(code ? { code } : {}) };
    else if (code && this.current.state === 'waiting' && !this.current.code) this.current = { ...this.current, code };
  }

  /** Resolves when it shows its page (and its code, if it prints one soon after), or ends. */
  private settled(): Promise<SignInState> {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = setInterval(() => {
        const s = this.current;
        const waited = Date.now() - started;
        if (
          s.state === 'done' ||
          s.state === 'failed' ||
          (s.state === 'waiting' && (s.code || waited > 3000)) ||
          waited > 30_000
        ) {
          clearInterval(tick);
          resolve(s);
        }
      }, 100);
    });
  }
}

/** Single-quoted for sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
