import { withoutEdgeEnvironment } from './edge-auth.mjs';
import { execFile } from 'node:child_process';
import { SignIn } from './vendor/auth/signin.ts';
import { commandStatus } from './vendor/auth/status.ts';
import { withoutExecutingMcpEnvironment } from './briq-native.mjs';

const helperEnvironment = env => withoutExecutingMcpEnvironment(withoutEdgeEnvironment(env));

export function briqStatus(env, run = execFile) {
  return new Promise(resolve => run('briq', ['--json', 'whoami'], {env:helperEnvironment(env), timeout:10000, maxBuffer:16384}, (error, stdout, stderr) => {
    if (!error) { try { const value=JSON.parse(stdout); if (typeof value.apiUrl === 'string' && typeof value.source === 'string') return resolve(true); } catch {} }
    // Network errors and unavailable CLI commands do not establish sign-out.
    resolve(/not signed in|not authenticated|unauthenticated|unauthorized/i.test(stderr ?? '') ? false : null);
  }));
}

// Keep credential files under each native CLI's existing home. No credentials are read here.
export function nativeConnections(env = process.env, { signIn = (options, ended) => new SignIn(options, undefined, {}, ended), claudeCredentialOwner, status = commandStatus, briqIdentity = briqStatus, pair = execFile } = {}) {
  const mcpConfigured = Boolean(env.BRIQ_MCP_TOKEN);
  env = helperEnvironment(env);
  let releaseClaude;
  const claude = signIn({ name: 'claude', login: ['claude', 'auth', 'login'] }, () => { releaseClaude?.(); releaseClaude = undefined; });
  const claudeStatus = async () => {
    if (releaseClaude) return null;
    let release;
    try { release = claudeCredentialOwner?.acquire({ kind: 'status' }); }
    catch { return null; }
    try { return await status(['claude', 'auth', 'status'], env); } finally { release?.(); }
  };
  const briq = signIn({ name: 'briq', login: ['briq', 'login'] });
  return {
    async status() {
      return { claude: { authenticated: await claudeStatus(), signIn: claude.status },
        briq: { authenticated: await briqIdentity(env), signIn: briq.status, mcp: mcpConfigured ? 'configured-unverified' : 'unconfigured' } };
    },
    claudeLogin: () => {
      if (!releaseClaude) releaseClaude = claudeCredentialOwner?.acquire({ kind: 'sign-in' });
      // start() returns at the authorization page. Release only when its native
      // process exits; cancel() and a failed UI state are not exit evidence.
      return claude.start(env);
    }, claudeInput: code => claude.input(code), claudeCancel: () => claude.cancel(),
    briqLogin: () => briq.start(env),
    pair(origin) {
      return new Promise((resolve, reject) => pair('/opt/t3/t3', ['auth', 'pairing', 'create', '--base-dir', env.T3_STATE,
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
