import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { commandStatus } from '../auth/status.ts';
import { SignIn } from '../auth/signin.ts';

/** Only fixed executables and public launch metadata enter this controller. Child output stays private. */
export class HomeServices {
  private child?: ChildProcess;
  private failed = false;
  private starting?: Promise<unknown>;
  private readonly baseDir: string;
  private readonly binary: string;
  private readonly bridge: string;
  private readonly port: number;
  private readonly publicUrl?: string;
  private readonly childEnv: Record<string, string>;
  private readonly briqEnv: Record<string, string>;
  private readonly login = new SignIn({ name: 'briq', acp: [], login: ['briq', 'login'] });
  private readonly options: { env: NodeJS.ProcessEnv; stateDir: string; cwd: string; token: string; runnerPort: number };
  constructor(options: { env: NodeJS.ProcessEnv; stateDir: string; cwd: string; token: string; runnerPort: number }) {
    this.options = options;
    const env = options.env;
    this.baseDir = join(options.stateDir, 't3');
    this.binary = env.RUNNER_T3_BINARY ?? '/opt/t3/t3';
    this.bridge = env.RUNNER_BRIQ_AGENT_BINARY ?? '/usr/local/bin/briq-agent-acp';
    if (!isAbsolute(this.binary) || !isAbsolute(this.bridge)) throw Error('Home service executables must be absolute paths');
    this.port = Number(env.RUNNER_T3_PORT ?? 3773);
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535 || this.port === options.runnerPort)
      throw Error('Invalid T3 port');
    if (env.RUNNER_T3_PUBLIC_URL) {
      const url = new URL(env.RUNNER_T3_PUBLIC_URL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
        throw Error('RUNNER_T3_PUBLIC_URL must be a dedicated HTTP origin without credentials');
      this.publicUrl = url.origin;
    }
    const safe = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'USER', 'TMPDIR'].flatMap((key) =>
      env[key] === undefined ? [] : [[key, env[key]!]],
    ));
    this.childEnv = { ...safe, HOME: join(this.baseDir, 'home'), AGENT_HOME_TOKEN_FILE: join(this.baseDir, 'bridge-token'),
      AGENT_HOME_RUNNER_PORT: String(options.runnerPort), AGENT_HOME_CWD: options.cwd,
      AGENT_HOME_POLICY_FILE: join(this.baseDir, 'briq-agent.json') };
    // Briq owns its existing native login, never a copied credential or T3's settings directory.
    this.briqEnv = { ...safe, ...Object.fromEntries(['BRIQ_API_URL', 'BRIQ_CONFIG_DIR', 'BRIQ_API_KEY', 'XDG_CONFIG_HOME'].flatMap((key) =>
      env[key] === undefined ? [] : [[key, env[key]!]],
    )) };
  }
  private installed(binary: string): boolean {
    try { accessSync(binary, constants.X_OK); return true; } catch { return false; }
  }
  status() {
    return { t3: { installed: this.installed(this.binary), state: this.child ? 'running' : this.failed ? 'failed' : 'stopped',
      publicUrl: this.publicUrl ?? null, port: this.port, agent: 'Briq Agent', optinOpenRouter: this.optinOpenRouter() }, briq: { login: this.login.status },
      dsh: { installed: this.installed('/opt/dsh/node_modules/.bin/dsh'), enabled: this.options.env.RUNNER_DSH === '1' } };
  }
  private optinOpenRouter(): boolean {
    try { return JSON.parse(readFileSync(this.childEnv.AGENT_HOME_POLICY_FILE!, 'utf8')).optinOpenRouter === true; }
    catch { return false; }
  }
  setOpenRouter(enabled: unknown) {
    if (typeof enabled !== 'boolean') throw Error('optinOpenRouter must be a boolean');
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.childEnv.AGENT_HOME_POLICY_FILE!, JSON.stringify({ optinOpenRouter: enabled }), { mode: 0o600 });
    return this.status();
  }
  private prepare() {
    mkdirSync(join(this.baseDir, 'userdata'), { recursive: true, mode: 0o700 });
    mkdirSync(this.childEnv.HOME!, { recursive: true, mode: 0o700 });
    const path = join(this.baseDir, 'userdata/settings.json');
    const expected = { providerInstances: {
      codex: { driver: 'codex', enabled: false, config: {} },
      claudeAgent: { driver: 'claudeAgent', enabled: false, config: {} },
      briqAgent: { driver: 'acpRegistry', enabled: true, displayName: 'Briq Agent',
        config: { source: 'local', commandPath: this.bridge, commandArgs: [] } },
    } };
    try {
      const settings = JSON.parse(readFileSync(path, 'utf8'));
      // Fail closed if a user enables a second owner of shared CLIs. Never rewrite their settings.
      if (settings.providerInstances?.codex?.enabled !== false || settings.providerInstances?.claudeAgent?.enabled !== false ||
        settings.providerInstances?.briqAgent?.config?.commandPath !== this.bridge ||
        settings.providerInstances?.briqAgent?.driver !== 'acpRegistry' ||
        Object.values(settings.providerInstances ?? {}).some((instance: any) =>
          ['codex', 'claudeAgent'].includes(instance.driver) && instance.enabled !== false))
        throw Error('T3 settings conflict with shared CLI ownership');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      writeFileSync(path, JSON.stringify(expected, null, 2), { mode: 0o600, flag: 'wx' });
    }
    writeFileSync(this.childEnv.AGENT_HOME_TOKEN_FILE!, this.options.token, { mode: 0o600 });
    chmodSync(this.childEnv.AGENT_HOME_TOKEN_FILE!, 0o600);
  }
  async start() {
    if (this.child) return this.status();
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async launch() {
    if (!this.installed(this.binary) || !this.installed(this.bridge)) throw Error('T3 or Briq Agent bridge is not installed');
    this.prepare();
    this.failed = false;
    const child = spawn(this.binary, ['serve', '--host', this.options.env.RUNNER_T3_HOST ?? '127.0.0.1', '--port', String(this.port),
      '--base-dir', this.baseDir, '--no-browser', this.options.cwd], { env: this.childEnv, cwd: this.options.cwd, stdio: 'ignore' });
    this.child = child;
    child.once('exit', (code) => { if (this.child === child) { this.child = undefined; this.failed = code !== 0; } });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => { this.child = undefined; this.failed = true; reject(Error('T3 could not start')); });
    });
    return this.status();
  }
  async pair() {
    if (!this.child || !this.publicUrl) throw Error('Start T3 and configure its dedicated public origin first');
    return await new Promise<{ url: string; expiresAt: string }>((resolve, reject) => {
      const child = spawn(this.binary, ['auth', 'pairing', 'create', '--base-dir', this.baseDir, '--base-url', this.publicUrl!,
        '--ttl', '5m', '--label', 'Agent Home browser', '--json'], { env: this.childEnv, stdio: ['ignore', 'pipe', 'ignore'] });
      let data = '', invalid = false;
      const timer = setTimeout(() => { invalid = true; child.kill('SIGKILL'); }, 10_000);
      child.stdout!.on('data', (chunk: Buffer) => { if (data.length + chunk.length > 16_384) { invalid = true; child.kill('SIGKILL'); } else data += chunk.toString(); });
      child.once('error', () => { clearTimeout(timer); reject(Error('T3 pairing unavailable')); });
      child.once('close', (code) => {
        clearTimeout(timer);
        try {
          if (invalid || code !== 0) throw Error();
          const value = JSON.parse(data), url = new URL(value.pairUrl);
          if (url.origin !== this.publicUrl || url.pathname !== '/pair' || !url.hash.startsWith('#token=') || typeof value.expiresAt !== 'string') throw Error();
          resolve({ url: url.href, expiresAt: value.expiresAt });
        } catch { reject(Error('T3 pairing unavailable')); }
      });
    });
  }
  async briqStatus() { return { authenticated: await commandStatus(['briq', 'whoami', '--json'], this.briqEnv), login: this.login.status }; }
  async briqLogin() { return this.login.start(this.briqEnv, { wait: false }); }
  async stop() {
    this.login.cancel();
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
}
