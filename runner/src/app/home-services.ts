import { accessSync, constants } from 'node:fs';
import { commandStatus } from '../auth/status.ts';
import { SignIn } from '../auth/signin.ts';

/** Native CLI connections and optional local agent capabilities. Child output stays private. */
export class HomeServices {
  private readonly briqEnv: Record<string, string>;
  private readonly login = new SignIn({ name: 'briq', acp: [], login: ['briq', 'login'] });
  private readonly options: { env: NodeJS.ProcessEnv };
  constructor(options: { env: NodeJS.ProcessEnv }) {
    this.options = options;
    const env = options.env;
    // Briq owns its existing native login; no credentials are copied.
    this.briqEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'USER', 'TMPDIR',
      'BRIQ_API_URL', 'BRIQ_CONFIG_DIR', 'BRIQ_API_KEY', 'XDG_CONFIG_HOME'].flatMap((key) =>
      env[key] === undefined ? [] : [[key, env[key]!]],
    ));
  }
  private installed(binary: string): boolean {
    try { accessSync(binary, constants.X_OK); return true; } catch { return false; }
  }
  status() {
    return { briq: { login: this.login.status },
      dsh: { installed: this.installed('/opt/dsh/node_modules/.bin/dsh'), enabled: this.options.env.RUNNER_DSH === '1' } };
  }
  async briqStatus() { return { authenticated: await commandStatus(['briq', 'whoami', '--json'], this.briqEnv), login: this.login.status }; }
  async briqLogin() { return this.login.start(this.briqEnv, { wait: false }); }
  async stop() { this.login.cancel(); }
}
