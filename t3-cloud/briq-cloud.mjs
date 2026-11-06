import { edgeToken, requireEdgeBinding, withoutEdgeEnvironment } from './edge-auth.mjs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, identifier, providerInstanceId } from './allocations.mjs';
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
    this.run = (args, options, beforeDispatch) => credentialOwner.run(() => {
      // The credential owner may queue this operation after its caller admitted it.
      beforeDispatch?.();
      return run(args, options);
    });
  }
  async create(binding, { image, bridgeUrl, edgeCredential }) {
    edgeToken(edgeCredential); requireEdgeBinding(binding, edgeCredential);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${binding.allocationId}.json`);
    await writeFile(file, JSON.stringify({ stack: binding.stack, services: { sandbox: { image, size: 'medium',
      ports: [8080], expose: 'public', volume: { mount: '/work', gb: 5 }, sleep: '3h',
      cmd: ['node', '/opt/t3-cloud/child.mjs'], env: {
        T3_CLOUD_PUBLIC_ORIGIN: 'https://{{self:host}}',
        T3_CLOUD_ROLE: 'child', T3_CLOUD_PROVIDER_INSTANCE_ID: providerInstanceId(binding.providerInstanceId), T3_CLOUD_THREAD_ID: binding.threadId, T3_CLOUD_BINDING_ID: binding.allocationId,
        T3_CLOUD_BRIDGE_URL: bridgeUrl, T3_CLOUD_BRIDGE_TOKEN: { secret: 'CHILD_BRIDGE_TOKEN' },
        T3_CLOUD_EDGE_TOKEN: { secret: 'CHILD_EDGE_TOKEN' },
        T3_CLOUD_EXEC_TOKEN_SHA256: digest(binding.execToken),
      } } } }), { mode: 0o600, flag: 'wx' });
    const response = await this.run(['up', '-f', file, '--secret', 'CHILD_BRIDGE_TOKEN', '--secret', 'CHILD_EDGE_TOKEN', '--no-wait'],
      { env: { ...withoutEdgeEnvironment(this.env), CHILD_BRIDGE_TOKEN: binding.bridgeToken, CHILD_EDGE_TOKEN: edgeCredential } });
    if (response.briqs?.length !== 1 || response.stack !== binding.stack || response.briqs[0].name !== 'sandbox') throw Error('Unexpected allocation result');
    const root = { id: identifier(response.briqs[0].id), stackId: identifier(response.briqs[0].stackId) };
    const listed = await this.run(['list', '--stack', binding.stack], { env: this.env });
    const exact = listed.briqs?.filter(row => row.id === root.id || row.name === 'sandbox');
    if (exact?.length !== 1 || exact[0].id !== root.id || exact[0].stackId !== root.stackId || exact[0].name !== 'sandbox' ||
      exact[0].env?.T3_CLOUD_BINDING_ID !== binding.allocationId || exact[0].env?.T3_CLOUD_THREAD_ID !== binding.threadId ||
      providerInstanceId(exact[0].env?.T3_CLOUD_PROVIDER_INSTANCE_ID) !== providerInstanceId(binding.providerInstanceId)) throw Error('Root namespace requires reconciliation');
    return root;
  }
  async find(binding) {
    const response = await this.run(['list', '--stack', binding.stack], { env: this.env });
    if (response.briqs?.length !== 1 || response.briqs[0].name !== 'sandbox' ||
      binding.briqId && response.briqs[0].id !== binding.briqId || binding.rootStackId && response.briqs[0].stackId !== binding.rootStackId ||
      response.briqs[0].env?.T3_CLOUD_BINDING_ID !== binding.allocationId || response.briqs[0].env?.T3_CLOUD_THREAD_ID !== binding.threadId ||
      providerInstanceId(response.briqs[0].env?.T3_CLOUD_PROVIDER_INSTANCE_ID) !== providerInstanceId(binding.providerInstanceId)) return null;
    return { id: identifier(response.briqs[0].id), stackId: identifier(response.briqs[0].stackId) };
  }
  async endpoints(binding) {
    const t3 = await this.run(['expose', binding.briqId, '8080', '--mode', 'public'], { env: this.env });
    return { t3Url: endpoint(t3.url), execUrl: `${endpoint(t3.url).replace(/^https:/, 'wss:')}/_cloud/exec` };
  }
  async descriptor(binding) {
    const response = await fetch(`${binding.t3Url}/.well-known/t3/environment`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Sandbox environment not ready');
    return response.json();
  }
  async pair(binding) {
    const response = await this.run(['exec', binding.briqId, '--', '/opt/t3/t3', 'auth', 'pairing', 'create',
      '--base-dir', '/work/.t3', '--base-url', binding.t3Url, '--ttl', '5m', '--json'], { env: this.env });
    if (response.exitCode !== 0) throw Error('Sandbox pairing failed');
    const pairing = JSON.parse(response.stdout);
    if (typeof pairing.credential !== 'string') throw Error('Sandbox pairing returned invalid credential');
    return pairing.credential;
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
