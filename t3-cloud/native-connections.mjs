import { withoutEdgeEnvironment } from './edge-auth.mjs';
import { execFile } from 'node:child_process';
import { SignIn } from './vendor/auth/signin.ts';
import { commandStatus } from './vendor/auth/status.ts';

export function briqStatus(env, run = execFile) {
  return new Promise(resolve => run('briq', ['--json', 'whoami'], {env:withoutEdgeEnvironment(env), timeout:10000, maxBuffer:16384}, (error, stdout, stderr) => {
    if (!error) { try { const value=JSON.parse(stdout); if (typeof value.apiUrl === 'string' && typeof value.source === 'string') return resolve(true); } catch {} }
    // Network errors and unavailable CLI commands do not establish sign-out.
    resolve(/not signed in|not authenticated|unauthenticated|unauthorized/i.test(stderr ?? '') ? false : null);
  }));
}

// Keep credential files under each native CLI's existing home. No credentials are read here.
export function nativeConnections(env = process.env) {
  env = withoutEdgeEnvironment(env);
  const claude = new SignIn({ name: 'claude', login: ['claude', 'auth', 'login'] });
  const briq = new SignIn({ name: 'briq', login: ['briq', 'login'] });
  return {
    async status() {
      return { claude: { authenticated: await commandStatus(['claude', 'auth', 'status'], env), signIn: claude.status },
        briq: { authenticated: await briqStatus(env), signIn: briq.status, mcp: env.BRIQ_MCP_TOKEN ? 'configured-unverified' : 'disconnected' } };
    },
    claudeLogin: () => claude.start(env), claudeInput: code => claude.input(code), claudeCancel: () => claude.cancel(),
    briqLogin: () => briq.start(env),
    pair(origin) {
      return new Promise((resolve, reject) => execFile('/opt/t3/t3', ['auth', 'pairing', 'create', '--base-dir', env.T3_STATE,
        '--base-url', origin, '--ttl', '5m', '--json'], { env, timeout: 10000, maxBuffer: 16384 }, (error, stdout) => {
        if (error) return reject(Error('Native pairing unavailable'));
        try { const value = JSON.parse(stdout); const url = new URL(value.pairUrl);
          if (url.origin !== origin || url.pathname !== '/pair' || typeof value.credential !== 'string') throw Error();
          resolve({ pairUrl: url.href, expiresAt: value.expiresAt });
        } catch { reject(Error('Native pairing unavailable')); }
      }));
    },
    close() { claude.cancel(); briq.cancel(); },
  };
}
