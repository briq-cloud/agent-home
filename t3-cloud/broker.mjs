import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { equalSecret } from './allocations.mjs';

const VERSION = 'codex-cli 0.166.0';
const CONFIG = 'check_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n[features]\nmulti_agent = false\n';
export async function startAppServer({ binary = 'codex', home, path = '/usr/local/bin:/usr/bin:/bin' }) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const [name, content] of [['config.toml', CONFIG], ['environments.toml', 'default = "none"\ninclude_local = false\n']]) {
    const file = join(home, name);
    try { await writeFile(file, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; if (await readFile(file, 'utf8') !== content) throw Error('Managed Codex configuration changed'); }
  }
  const env = { HOME: home, CODEX_HOME: home, PATH: path, LANG: 'C.UTF-8', TMPDIR: '/tmp' };
  const version = spawnSync(binary, ['--version'], { env, encoding: 'utf8', timeout: 15000 });
  if (version.status !== 0 || version.stdout.trim() !== VERSION) throw Error('Codex 0.166.0 required');
  const child = spawn(binary, ['app-server'], { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = new EventEmitter(); const pending = new Map(); let sequence = 0;
  // Native diagnostics stay out of HTTP/WebSocket responses and never echo credential-bearing messages.
  child.stderr.resume();
  let failed = false;
  const fail = () => { if (failed) return; failed = true; child.kill('SIGTERM'); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Central app-server unavailable')); } pending.clear(); events.emit('closed'); };
  child.once('error', fail); child.once('exit', fail); child.stdin.on('error', fail);
  createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return fail(); }
    if (message.id !== undefined && !message.method) {
      const entry = pending.get(message.id); if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(Error('Central app-server rejected request')); else entry.resolve(message.result);
    } else events.emit('message', message);
  });
  const notify = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failed) return reject(Error('Central app-server unavailable'));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Central request outcome unknown')); }, 60000);
    pending.set(id, { resolve, reject, timer }); notify({ id, method, params });
  });
  const close = () => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
  let initialized;
  try { initialized = await request('initialize', { clientInfo: { name: 'briq_t3_cloud', version: '0.1.0' }, capabilities: { experimentalApi: true } }); } catch (error) { fail(); await close(); throw error; }
  notify({ method: 'initialized' });
  return { request, notify, events, initialized, pid: child.pid, close };
}
const fields = {
  'thread/start': ['model', 'cwd', 'approvalPolicy', 'sandbox'],
  'thread/resume': ['threadId', 'excludeTurns'],
  'thread/read': ['threadId', 'includeTurns'],
  'thread/unsubscribe': ['threadId'],
  'turn/start': ['threadId', 'input', 'model', 'effort'],
  'turn/steer': ['threadId', 'input', 'expectedTurnId'],
  'turn/interrupt': ['threadId', 'turnId'],
};
const notifications = new Set(['thread/started', 'thread/closed', 'thread/tokenUsage/updated', 'turn/started', 'turn/completed', 'turn/plan/updated', 'item/started', 'item/completed', 'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/plan/delta', 'error']);
const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
function error(id, message = 'Operation denied by sandbox binding') { return { id, error: { code: -32600, message } }; }
function textInput(input) {
  return Array.isArray(input) && input.length <= 64 && input.every(item => item && item.type === 'text' &&
    typeof item.text === 'string' && item.text.length <= 1048576 && Object.keys(item).every(key => ['type', 'text', 'text_elements'].includes(key)) &&
    (item.text_elements === undefined || Array.isArray(item.text_elements) && item.text_elements.length === 0));
}
export class CapabilityBroker {
  constructor({ store, app }) {
    Object.assign(this, { store, app }); this.sessions = new Set(); this.approvals = new Map(); this.sequence = 0; this.registered = new Set(); this.activeTurns = new Map(); this.finishedTurns = new Map(); this.unavailable = false; this.mutations = new Map();
    app.events.on('message', message => { this.deliver(message).catch(() => {}); });
    app.events.on('closed', () => { this.unavailable = true; this.registered.clear(); this.approvals.clear(); for (const session of this.sessions) session.close(); });
  }
  async registerEnvironment(binding) {
    if (binding.state !== 'ready') throw Error('Allocation not ready');
    if (this.registered.has(binding.allocationId)) return;
    await this.app.request('environment/add', { environmentId: binding.execEnvironmentId, execServerUrl: binding.execUrl, authBearerToken: binding.execToken });
    this.registered.add(binding.allocationId);
  }
  async connect(token, send, close) {
    const bindings = await this.store.list();
    const binding = bindings.find(value => value?.state === 'ready' && equalSecret(token, value.bridgeToken));
    if (!binding) throw Error('Invalid sandbox capability');
    const session = { allocationId: binding.allocationId, threadId: binding.threadId, send, close, initialized: false, closed: false, mutations: new Set() };
    this.sessions.add(session);
    return { receive: message => this.receive(session, message), close: () => this.disconnect(session) };
  }
  async binding(session) {
    if (session.closed || this.unavailable) throw Error('Central app-server unavailable');
    const binding = await this.store.load(session.threadId);
    if (binding?.state !== 'ready' || binding.allocationId !== session.allocationId) throw Error('Allocation revoked');
    return binding;
  }
  async assertMutationAllowed(session) {
    for (const id of await this.store.mutationMarkers(session.threadId)) {
      const active = this.mutations.get(id);
      if (!active || active.session !== session || active.quarantined || active.session.closed || !active.locallyWritten)
        throw Error('Unadopted mutation requires explicit reconciliation');
    }
  }
  async beginMutation(session, method) {
    // Internal attempt IDs are not durable client action identities. Markers remain until
    // explicit authoritative adoption; neither native results nor WS writes prove adoption.
    const mutation = { id: randomUUID(), session, method, quarantined: false, locallyWritten: false };
    this.mutations.set(mutation.id, mutation); session.mutations.add(mutation);
    try {
      await this.store.markMutation(session.threadId, mutation.id, method);
      if (session.closed) throw Error('Sandbox disconnected');
      return mutation;
    } catch (error) {
      mutation.quarantined = true; this.mutations.delete(mutation.id); session.mutations.delete(mutation); throw error;
    }
  }
  async deliverMutation(mutation, message) {
    const { session } = mutation;
    try {
      if (session.closed || mutation.quarantined) throw Error('Sandbox disconnected');
      if (await session.send(message) === false) throw Error('Sandbox reply undelivered');
      if (session.closed || mutation.quarantined) throw Error('Sandbox disconnected');
      // Only allow this live session to continue. Retain the journal and ownership so a
      // subsequent disconnect, even after this callback, quarantines the unadopted result.
      mutation.locallyWritten = true;
    } catch (error) { mutation.quarantined = true; throw error; }
  }
  async receive(session, message) {
    if (!message || typeof message !== 'object' || JSON.stringify(message).length > 2097152) return session.close();
    const id = message.id; let mutation;
    try {
      const binding = await this.binding(session);
      if (!message.method && id !== undefined) {
        const approval = this.approvals.get(id);
        if (!approval || approval.session !== session || approval.threadId !== binding.nativeThreadId ||
          approval.environmentId !== binding.execEnvironmentId || this.activeTurns.get(binding.nativeThreadId) !== approval.turnId || !message.result ||
          Object.keys(message.result).some(key => key !== 'decision') || !['accept', 'decline', 'cancel'].includes(message.result.decision))
          return session.send(error(id));
        this.approvals.delete(id); this.app.notify({ id: approval.nativeId, result: message.result }); return;
      }
      if (message.method === 'initialize') {
        if (session.initialized) return session.send(error(id));
        session.initialized = true;
        return session.send({ id, result: { userAgent: 'codex/0.166.0', platformFamily: 'unix', platformOs: 'linux', codexHome: '/work/.codex-empty' } });
      }
      if (!session.initialized) return session.send(error(id));
      if (message.method === 'initialized' && id === undefined) return;
      if ((typeof id !== 'number' && typeof id !== 'string') || !Object.hasOwn(fields, message.method)) return session.send(error(id));
      const params = message.params ?? {};
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !fields[message.method].includes(key))) return session.send(error(id));
      if (message.method !== 'thread/start' && typeof params.threadId !== 'string') return session.send(error(id));
      if (Object.hasOwn(params, 'threadId') && (!binding.nativeThreadId || params.threadId !== binding.nativeThreadId)) return session.send(error(id));
      if (params.cwd !== undefined && params.cwd !== '/work') return session.send(error(id));
      if (params.model !== undefined && (typeof params.model !== 'string' || params.model.length > 128)) return session.send(error(id));
      if (params.effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(params.effort)) return session.send(error(id));
      if (params.input !== undefined && !textInput(params.input)) return session.send(error(id));
      if (params.approvalPolicy !== undefined && params.approvalPolicy !== 'on-request') return session.send(error(id));
      if (params.sandbox !== undefined && params.sandbox !== 'workspace-write') return session.send(error(id));
      if (['turn/interrupt', 'turn/steer'].includes(message.method)) {
        const turnId = params.turnId ?? params.expectedTurnId;
        if (!turnId || this.activeTurns.get(binding.nativeThreadId) !== turnId) return session.send(error(id));
        // Cancellation must remain independent of a pending turn/start or read response.
        if (message.method === 'turn/steer') await this.assertMutationAllowed(session);
        mutation = await this.beginMutation(session, message.method);
        const result = await this.app.request(message.method, params);
        return await this.deliverMutation(mutation, { id, result });
      }
      let response;
      await this.store.serialized(binding.threadId, async () => {
        const current = await this.binding(session);
        const environment = { environmentId: current.execEnvironmentId, cwd: '/work', runtimeWorkspaceRoots: ['/work'] };
        if (message.method === 'thread/start') {
          if (current.nativeThreadId || current.nativeState === 'unknown') throw Error('Native thread already allocated or requires reconciliation');
          await this.assertMutationAllowed(session);
          mutation = await this.beginMutation(session, message.method);
          current.nativeState = 'unknown'; await this.store.save(current);
          response = await this.app.request(message.method, { ...params, cwd: '/work', environments: [environment], approvalPolicy: 'on-request', sandbox: 'workspace-write' });
          if (!response.thread?.id || !this.matchesEnvironment(response.thread, current)) throw Error('Native thread environment mismatch');
          current.nativeThreadId = response.thread.id; current.nativeState = 'bound'; await this.store.save(current);
        } else {
          if (message.method === 'turn/start') {
            if (this.activeTurns.has(current.nativeThreadId) || current.turnState === 'unknown') throw Error('Turn already active or outcome unknown');
            await this.assertMutationAllowed(session);
            mutation = await this.beginMutation(session, message.method);
            current.turnState = 'unknown'; await this.store.save(current);
          }
          response = await this.app.request(message.method, { ...params, ...(message.method === 'turn/start' ? { environments: [environment] } : {}) });
          if (['thread/resume', 'thread/read'].includes(message.method) &&
            (response.thread?.id !== current.nativeThreadId || !this.matchesEnvironment(response.thread, current))) throw Error('Resumed thread environment mismatch');
          if (message.method === 'turn/start') {
            if (!response.turn?.id) throw Error('Missing turn binding');
            if (this.finishedTurns.get(current.nativeThreadId) !== response.turn.id && response.turn.status !== 'completed' && response.turn.status !== 'interrupted' && response.turn.status !== 'failed') this.activeTurns.set(current.nativeThreadId, response.turn.id);
            current.turnState = 'bound'; current.nativeTurnId = response.turn.id; await this.store.save(current);
            const loaded = await this.app.request('thread/read', { threadId: current.nativeThreadId, includeTurns: false });
            if (loaded.thread?.id !== current.nativeThreadId || !this.matchesEnvironment(loaded.thread, current)) throw Error('Turn environment mismatch');
          }
        }
      });
      if (mutation) await this.deliverMutation(mutation, { id, result: response });
      else if (!session.closed) await session.send({ id, result: response });
    } catch {
      if (mutation) { mutation.quarantined = true; this.mutations.delete(mutation.id); session.mutations.delete(mutation); }
      if (!session.closed) await session.send(error(id));
    }
  }
  matchesEnvironment(thread, binding) {
    return Array.isArray(thread.environments) && thread.environments.length === 1 &&
      thread.environments[0].environmentId === binding.execEnvironmentId && thread.environments[0].cwd === '/work';
  }
  async deliver(message) {
    const threadId = message.params?.threadId ?? message.params?.thread?.id;
    if (!threadId) {
      if (message.id !== undefined) this.app.notify({ id: message.id, error: { code: -32600, message: 'Unbound server request denied' } });
      return;
    }
    const candidates = [];
    for (const session of this.sessions) {
      const binding = await this.binding(session).catch(() => null);
      if (binding?.nativeThreadId === threadId) candidates.push({ session, binding });
    }
    if (message.method === 'turn/started' && message.params?.turn?.id) this.activeTurns.set(threadId, message.params.turn.id);
    if (message.method === 'turn/completed' && message.params?.turn?.id) { this.finishedTurns.set(threadId, message.params.turn.id); if (this.activeTurns.get(threadId) === message.params.turn.id) this.activeTurns.delete(threadId); }
    if (message.id !== undefined) {
      const target = candidates.find(({ binding }) =>
        typeof message.params.itemId === 'string' && Number.isSafeInteger(message.params.startedAtMs) &&
        this.activeTurns.get(threadId) === message.params.turnId &&
        (message.method === 'item/commandExecution/requestApproval' ? message.params.environmentId === binding.execEnvironmentId :
          message.params.environmentId === undefined && (message.params.grantRoot == null || message.params.grantRoot === '/work')));
      if (!target || !approvalMethods.has(message.method)) {
        this.app.notify({ id: message.id, error: { code: -32600, message: 'Unbound server request denied' } }); return;
      }
      const id = `approval-${++this.sequence}`;
      this.approvals.set(id, { session: target.session, nativeId: message.id, threadId, turnId: message.params.turnId, environmentId: target.binding.execEnvironmentId });
      await target.session.send({ ...message, id });
    } else {
      if (notifications.has(message.method)) await Promise.allSettled(candidates.map(({ session }) => session.send(message)));
    }
  }
  disconnect(session) {
    session.closed = true;
    for (const mutation of session.mutations) { mutation.quarantined = true; this.mutations.delete(mutation.id); }
    session.mutations.clear();
    this.sessions.delete(session);
    for (const [id, approval] of this.approvals) if (approval.session === session) {
      this.approvals.delete(id); this.app.notify({ id: approval.nativeId, result: { decision: 'cancel' } });
    }
  }
  async ownerRequest(method, params) {
    if (!['account/read', 'account/login/start', 'account/login/cancel', 'account/logout'].includes(method)) throw Error('Unsupported connection operation');
    if (method === 'account/login/start' && (params?.type !== 'chatgptDeviceCode' || Object.keys(params).some(key => !['type'].includes(key)))) throw Error('Only native ChatGPT sign-in supported');
    const response = await this.app.request(method, params);
    if (method === 'account/read') return { account: response.account ? { type: response.account.type, email: response.account.email, planType: response.account.planType } : null, requiresOpenaiAuth: response.requiresOpenaiAuth };
    return response;
  }
}
