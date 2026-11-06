import { edgeToken, requireEdgeBinding, withoutEdgeEnvironment } from './edge-auth.mjs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, identifier, nativeSessionId, providerInstanceId, childIdentityMatches, canonicalJson } from './allocations.mjs';
import { withoutExecutingMcpEnvironment } from './briq-native.mjs';

export function cli(args, { env = process.env, stdin, timeout = 120000, execResult = false } = {}, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const process = spawnProcess('briq', ['--json', ...args], { env: withoutExecutingMcpEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let bytes = 0; let failed = false;
    const timer = setTimeout(() => { failed = true; process.kill('SIGTERM'); }, timeout);
    process.on('error', () => { failed = true; });
    process.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1048576) { failed = true; process.kill('SIGTERM'); } else output += chunk; });
    process.stderr.resume();
    process.stdin.on('error', () => {}); process.stdin.end(stdin);
    process.on('close', code => { clearTimeout(timer); if (failed) return reject(Error('Briq CLI operation failed'));
      try {
        const parsed = JSON.parse(output);
        if (code !== 0 && !(execResult && parsed.exec && ['exited', 'timed_out', 'stopped', 'lost'].includes(parsed.exec.state) &&
          (parsed.exec.state === 'exited' ? parsed.exec.exitCode === code : code === 1))) throw Error('Briq CLI operation failed');
        resolve(parsed);
      } catch { reject(Error('Briq CLI operation failed')); } });
  });
}
function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('Invalid sandbox endpoint');
  return url.origin;
}
// One official CLI credential owner, including refresh-rotating login/status processes.
// A hung process retains ownership: a timeout is never proof it ended.
export class BriqCredentialOwner {
  constructor() { this.current = null; this.waiters = []; }
  acquire(identity) {
    if (this.current || this.waiters.length) throw Error('Central Briq credential owner busy');
    return this.reserve(identity);
  }
  reserve(identity) {
    this.current = identity;
    let released = false;
    return () => {
      if (released || this.current !== identity) return;
      released = true; this.current = null;
      const next = this.waiters.shift();
      if (next) next(this.reserve({ kind: 'operation' }));
    };
  }
  async run(operation) {
    const release = this.current || this.waiters.length
      ? await new Promise(resolve => this.waiters.push(resolve))
      : this.reserve({ kind: 'operation' });
    try { return await operation(); } finally { release(); }
  }
}
export class BriqCloud {
  constructor({ directory, run = cli, env = process.env, credentialOwner = new BriqCredentialOwner() }) {
    Object.assign(this, { directory, credentialOwner, env: withoutExecutingMcpEnvironment(withoutEdgeEnvironment(env)) });
    this.run = (args, options, beforeDispatch) => credentialOwner.run(async () => {
      // The credential owner may queue this operation after its caller admitted it.
      await beforeDispatch?.(run);
      return run(args, options);
    });
  }
  async create(binding, { image, bridgeUrl, edgeCredential }) {
    edgeToken(edgeCredential); requireEdgeBinding(binding, edgeCredential);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${binding.allocationId}.json`);
    const sourceOnly = binding.purpose === 'project-source';
    const projectEnv = binding.projectSource ? { T3_CLOUD_SOURCE_ID: binding.projectSource.sourceId, T3_CLOUD_SOURCE_DIGEST: binding.projectSource.sourceDigest,
      T3_CLOUD_PROJECT_ID: binding.projectId, T3_CLOUD_PROJECT_ROOT: binding.workspaceRoot, T3_CLOUD_OWNER_GENERATION: binding.managedBridge?.ownerGeneration,
      ...(binding.purpose === 'project-source' ? {} : { T3_CLOUD_LAUNCH_DIGEST: digest(canonicalJson({ projectSource: binding.projectSource, workspaceStrategy: binding.workspaceStrategy })) }) } : {};
    const childEnv = sourceOnly ? { T3_CLOUD_PURPOSE: 'project-source', ...projectEnv } : {
      T3_CLOUD_PROVIDER_INSTANCE_ID: providerInstanceId(binding.providerInstanceId), T3_CLOUD_THREAD_ID: binding.threadId,
      T3_CLOUD_BRIDGE_URL: bridgeUrl, T3_CLOUD_BRIDGE_TOKEN: { secret: 'CHILD_BRIDGE_TOKEN' },
      T3_CLOUD_EDGE_TOKEN: { secret: 'CHILD_EDGE_TOKEN' }, T3_CLOUD_EXEC_TOKEN_SHA256: digest(binding.execToken), ...projectEnv };
    await writeFile(file, JSON.stringify({ stack: binding.stack, services: { sandbox: { image, size: sourceOnly ? 'small' : 'medium',
      ports: [8080], expose: 'public', volume: { mount: '/work', gb: 5 }, sleep: sourceOnly ? '5m' : '3h',
      cmd: ['node', '/opt/t3-cloud/child.mjs'], env: { T3_CLOUD_PUBLIC_ORIGIN: 'https://{{self:host}}',
        T3_CLOUD_ROLE: 'child', T3_CLOUD_BINDING_ID: binding.allocationId, ...childEnv } } } }), { mode: 0o600, flag: 'wx' });
    const secrets = sourceOnly ? [] : ['--secret', 'CHILD_BRIDGE_TOKEN', '--secret', 'CHILD_EDGE_TOKEN'];
    const response = await this.run(['up', '-f', file, ...secrets, '--no-wait'],
      { env: sourceOnly ? withoutEdgeEnvironment(this.env) : { ...withoutEdgeEnvironment(this.env), CHILD_BRIDGE_TOKEN: binding.bridgeToken, CHILD_EDGE_TOKEN: edgeCredential } });
    if (response.briqs?.length !== 1 || response.stack !== binding.stack || response.briqs[0].name !== 'sandbox') throw Error('Unexpected allocation result');
    const root = { id: identifier(response.briqs[0].id), stackId: identifier(response.briqs[0].stackId) };
    const listed = await this.run(['list', '--stack', binding.stack], { env: this.env });
    const exact = listed.briqs?.filter(row => row.id === root.id || row.name === 'sandbox');
    if (exact?.length !== 1 || exact[0].id !== root.id || exact[0].stackId !== root.stackId || exact[0].name !== 'sandbox' ||
      !childIdentityMatches(binding, exact[0].env)) throw Error('Root namespace requires reconciliation');
    return root;
  }
  async find(binding) {
    const response = await this.run(['list', '--stack', binding.stack], { env: this.env });
    if (response.briqs?.length !== 1 || response.briqs[0].name !== 'sandbox' ||
      binding.briqId && response.briqs[0].id !== binding.briqId || binding.rootStackId && response.briqs[0].stackId !== binding.rootStackId ||
      !childIdentityMatches(binding, response.briqs[0].env)) return null;
    return { id: identifier(response.briqs[0].id), stackId: identifier(response.briqs[0].stackId) };
  }
  async endpoints(binding) {
    const t3 = await this.run(['expose', binding.briqId, '8080', '--mode', 'public'], { env: this.env });
    return { t3Url: endpoint(t3.url), ...(binding.purpose === 'project-source' ? {} : { execUrl: `${endpoint(t3.url).replace(/^https:/, 'wss:')}/_cloud/exec` }) };
  }
  async descriptor(binding) {
    const response = await fetch(`${binding.t3Url}/.well-known/t3/environment`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Sandbox environment not ready');
    return response.json();
  }
  async pair(binding, { phone = false, validate = async () => {} } = {}) {
    const response = await this.run(['exec', binding.briqId, '--', '/opt/t3/t3', 'auth', 'pairing', 'create',
      '--base-dir', '/work/.t3', '--base-url', binding.t3Url, '--ttl', '5m', '--json'], { env: this.env }, phone ? async run => {
      // These read-only identity/liveness checks share the exec's credential grant.
      // Native exec may wake idle/provider sleep under platform policy. A user stop
      // remains authoritative; no explicit start, resume or allocation recovery occurs here.
      await validate();
      const listed = await run(['list', '--stack', binding.stack], { env: this.env });
      const rows = listed.briqs;
      if (rows?.length !== 1 || rows[0].id !== binding.briqId || rows[0].stackId !== binding.rootStackId || rows[0].name !== 'sandbox' ||
          !childIdentityMatches(binding, rows[0].env)) throw Error('Child identity unavailable');
      const status = await run(['status', binding.briqId], { env: this.env });
      if (status.briq?.id !== binding.briqId || status.briq?.name !== 'sandbox' || !['running', 'sleeping'].includes(status.briq?.state)) throw Error('Child must be running or asleep');
      await validate();
    } : undefined);
    if (response.exitCode !== 0) throw Error('Sandbox pairing failed');
    const pairing = JSON.parse(response.stdout);
    if (typeof pairing.credential !== 'string') throw Error('Sandbox pairing returned invalid credential');
    if (!phone) return pairing.credential;
    await validate();
    const base = endpoint(binding.t3Url), url = new URL(pairing.pairUrl);
    const expiry = Date.parse(pairing.expiresAt), remaining = expiry - Date.now();
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (!pairing.credential || pairing.credential.length > 4096 || /[\s\x00-\x1f\x7f]/.test(pairing.credential) ||
        url.origin !== base || url.pathname !== '/pair' || url.search || url.username || url.password ||
        [...fragment.keys()].join(',') !== 'token' || fragment.get('token') !== pairing.credential ||
        !Number.isFinite(expiry) || remaining <= 0 || remaining > 300000) throw Error('Invalid child pairing metadata');
    return { url: base, code: pairing.credential, expiresAt: new Date(expiry).toISOString() };
  }
  async bridgeAuth(binding, args, validate, { canWake = false } = {}) {
    const response = await this.run(['exec', binding.briqId, '--', '/opt/t3/t3', 'auth', 'session', ...args,
      '--base-dir', '/work/.t3'], { env: this.env }, async run => {
      await validate();
      const listed = await run(['list', '--stack', binding.stack], { env: this.env });
      const rows = listed.briqs;
      if (rows?.length !== 1 || rows[0].id !== binding.briqId || rows[0].stackId !== binding.rootStackId || rows[0].name !== 'sandbox' ||
          !childIdentityMatches(binding, rows[0].env)) throw Error('Child identity unavailable');
      const status = await run(['status', binding.briqId], { env: this.env });
      if (status.briq?.id !== binding.briqId || status.briq?.name !== 'sandbox' || !(canWake ? ['running', 'sleeping'] : ['running']).includes(status.briq?.state))
        throw Error('Native bridge auth child unavailable');
      await validate();
    });
    if (response.exitCode !== 0) throw Error('Native bridge auth requires reconciliation');
    await validate();
    return response.stdout;
  }
  async issueBridgeSession(binding, subject, validate, { preparation = false } = {}) {
    if (binding.purpose === 'project-source' && !preparation) throw Error('Source child requires preparation session');
    if (typeof subject !== 'string' || !/^briq-bridge:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(subject))
      throw Error('Invalid managed bridge subject');
    return JSON.parse(await this.bridgeAuth(binding, ['issue', '--scope', 'orchestration:read', '--scope', 'orchestration:operate', ...(preparation ? ['--scope', 'source-control:write'] : []),
      '--subject', subject, '--label', preparation ? 'Managed project preparation' : 'Managed child bridge', '--ttl', preparation ? '5m' : '30d', '--json'], validate, { canWake: true }));
  }
  async listBridgeSessions(binding, validate) {
    const rows = JSON.parse(await this.bridgeAuth(binding, ['list', '--json'], validate));
    if (!Array.isArray(rows) || rows.length > 4096 || rows.some(row => typeof row?.sessionId !== 'string' ||
        typeof row.subject !== 'string')) throw Error('Native bridge session list unavailable');
    return rows;
  }
  async revokeBridgeSession(binding, sessionId, validate) {
    nativeSessionId(sessionId);
    await this.bridgeAuth(binding, ['revoke', sessionId], validate);
  }
  async execAsync(briqId, command, timeoutMs) {
    return this.run(['exec', '--async', '--clear-env', '--timeout', String(timeoutMs), briqId,
      '--', '/bin/sh', '-c', 'cd /work && exec /bin/sh -c "$1"', 'claude-remote', command], { env: this.env });
  }
  async execStatus(briqId, execId) {
    return this.run(['exec-result', briqId, execId, '--wait', '30000'], { env: this.env, timeout: 45000, execResult: true });
  }
  async execStop(briqId, execId) {
    return this.run(['exec-stop', briqId, execId], { env: this.env });
  }
  async stop(binding) {
    const result = await this.run(['stop', binding.briqId], { env: this.env });
    if (result.briq?.id !== binding.briqId || !['stopped', 'destroyed'].includes(result.briq.state)) throw Error('Workspace stop requires reconciliation');
  }
  async stopped(binding) {
    const result = await this.run(['status', binding.briqId], { env: this.env });
    if (result.briq?.id !== binding.briqId || result.briq.name !== 'sandbox') throw Error('Workspace status identity mismatch');
    return ['stopped', 'destroyed'].includes(result.briq.state);
  }
}
