import { QrCode } from './vendor/qr-code.ts';
import { withoutEdgeEnvironment } from './edge-auth.mjs';
import { execFile } from 'node:child_process';
import { SignIn } from './vendor/auth/signin.ts';
import { commandStatus } from './vendor/auth/status.ts';
import { withoutExecutingMcpEnvironment } from './briq-native.mjs';

const helperEnvironment = env => { const clean = withoutExecutingMcpEnvironment(withoutEdgeEnvironment(env)); delete clean.T3_CLOUD_OWNER_KEY; delete clean.T3_CLOUD_ALLOCATOR_TOKEN; return clean; };

export function briqStatus(env, run = execFile) {
  return new Promise(resolve => run('briq', ['--json', 'whoami'], {env:helperEnvironment(env), timeout:10000, maxBuffer:16384}, (error, stdout, stderr) => {
    if (!error) { try { const value=JSON.parse(stdout); if (typeof value.apiUrl === 'string' && typeof value.source === 'string') return resolve(true); } catch {} }
    // Network errors and unavailable CLI commands do not establish sign-out.
    resolve(/not signed in|not authenticated|unauthenticated|unauthorized/i.test(stderr ?? '') ? false : null);
  }));
}

// Keep credential files under each native CLI's existing home. No credentials are read here.
export function nativeConnections(env = process.env, { signIn = (options, ended) => new SignIn(options, undefined, { direct: options.name === 'claude' }, ended), claudeCredentialOwner, briqCredentialOwner, status = commandStatus, briqIdentity = briqStatus, pair = execFile } = {}) {
  const mcpConfigured = Boolean(env.BRIQ_MCP_TOKEN);
  env = helperEnvironment(env);
  const nativeAuth = (args, json = false) => new Promise((resolve, reject) => pair('/opt/t3/t3',
    ['auth', ...args, '--base-dir', env.T3_STATE, ...(json ? ['--json'] : [])],
    { env, timeout: 10000, maxBuffer: 16384 }, (error, stdout) => {
      if (error) return reject(Error('Native access management unavailable'));
      try { resolve(json ? JSON.parse(stdout) : undefined); } catch { reject(Error('Native access management unavailable')); }
    }));
  const accessId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  let releaseClaude, releaseBriq;
  let claudeLifetimeUnknown = false;
  const claude = signIn({ name: 'claude', login: ['claude', 'auth', 'login'] }, outcome => {
    if (outcome === 'terminated' || outcome === 'never-spawned') { releaseClaude?.(); releaseClaude = undefined; }
    else { claudeLifetimeUnknown = true; claudeCredentialOwner?.quarantine(); }
  });
  const claudeStatus = async () => {
    if (releaseClaude) return null;
    let release;
    try { release = claudeCredentialOwner?.acquire({ kind: 'status' }); }
    catch { return null; }
    let lifetime = 'unknown';
    try {
      return await status(['claude', 'auth', 'status'], env, undefined, false, undefined,
        { onLifetime: outcome => { lifetime = outcome; } });
    } finally {
      if (lifetime === 'terminated' || lifetime === 'never-spawned') release?.();
      else claudeCredentialOwner?.quarantine();
    }
  };
  const briq = signIn({ name: 'briq', login: ['briq', 'login'] }, () => { releaseBriq?.(); releaseBriq = undefined; });
  const briqStatusOwned = async () => {
    if (releaseBriq) return null;
    let release;
    try { release = briqCredentialOwner?.acquire({ kind: 'status' }); } catch { return null; }
    try { return await briqIdentity(env); } finally { release?.(); }
  };
  return {
    async status() {
      return { claude: { authenticated: await claudeStatus(), signIn: claude.status },
        briq: { authenticated: await briqStatusOwned(), signIn: briq.status, mcp: mcpConfigured ? 'configured-unverified' : 'unconfigured' } };
    },
    claudeLogin: () => {
      if (claudeLifetimeUnknown) throw Error('Claude credential process lifetime unknown');
      if (!releaseClaude) releaseClaude = claudeCredentialOwner?.acquire({ kind: 'sign-in' });
      // start() returns at the authorization page. Release only when its native
      // process exits; cancel() and a failed UI state are not exit evidence.
      return claude.start(env);
    }, claudeInput: code => claude.input(code), claudeCancel: () => claude.cancel(),
    briqLogin: () => {
      if (!releaseBriq) releaseBriq = briqCredentialOwner?.acquire({ kind: 'sign-in' });
      return briq.start(env);
    },
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
    async phonePair(origin) {
      const value = await nativeAuth(['pairing', 'create', '--base-url', origin, '--ttl', '5m'], true);
      try {
        const url = new URL(value.pairUrl), fragment = new URLSearchParams(url.hash.slice(1));
        const expires = Date.parse(value.expiresAt), remaining = expires - Date.now();
        if (!accessId(value.id) || typeof value.credential !== 'string' || !/^[a-zA-Z0-9]{12}$/.test(value.credential) ||
            url.origin !== origin || url.pathname !== '/pair' || url.search || url.username || url.password ||
            [...fragment.keys()].join(',') !== 'token' || fragment.get('token') !== value.credential ||
            !Number.isFinite(expires) || remaining <= 0 || remaining > 300000) throw Error();
        const qr = QrCode.encodeText(url.href, QrCode.Ecc.MEDIUM), modules = [];
        for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) modules.push([x + 4, y + 4]);
        return { id: value.id, url: origin, pairUrl: url.href, code: value.credential,
          expiresAt: new Date(expires).toISOString(), qr: { size: qr.size + 8, modules } };
      } catch { throw Error('Native phone pairing unavailable'); }
    },
    async phoneAccess() {
      const [pairings, sessions] = await Promise.all([nativeAuth(['pairing', 'list'], true), nativeAuth(['session', 'list'], true)]);
      if (!Array.isArray(pairings) || !Array.isArray(sessions)) throw Error('Native access management unavailable');
      return { pairings: pairings.filter(value => accessId(value.id)).map(value => ({ id: value.id, expiresAt: value.expiresAt })),
        sessions: sessions.filter(value => accessId(value.sessionId)).map(value => ({ id: value.sessionId, expiresAt: value.expiresAt, connected: value.connected === true })) };
    },
    async phoneRevoke(kind, id) {
      if (!['pairing', 'session'].includes(kind) || !accessId(id)) throw Error('Invalid native access identity');
      await nativeAuth([kind, 'revoke', id]);
      return { revoked: true };
    },
    close() { claude.cancel(); briq.cancel(); },
  };
}
