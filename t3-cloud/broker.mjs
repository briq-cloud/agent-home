import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { equalSecret, canonicalJson, digest, identifier, providerInstanceId, providerMetadata } from './allocations.mjs';
import { prepareExecutingCodex } from './codex-config.mjs';
import { withoutExecutingMcpEnvironment } from './briq-native.mjs';
import { scopedBriqTools } from './scoped-briq.mjs';

const VERSION = 'codex-cli 0.166.0';
export async function startAppServer({ binary = 'codex', home, path = '/usr/local/bin:/usr/bin:/bin', briqCapability, briqEndpoint },
  { checkVersion = spawnSync, spawnProcess = spawn } = {}) {
  const briq = await prepareExecutingCodex({ home, capability: briqCapability, endpoint: briqEndpoint });
  const env = { HOME: home, CODEX_HOME: home, PATH: path, LANG: 'C.UTF-8', TMPDIR: '/tmp', ...briq.env };
  const version = checkVersion(binary, ['--version'], { env: withoutExecutingMcpEnvironment(env), encoding: 'utf8', timeout: 15000 });
  if (version.status !== 0 || version.stdout.trim() !== VERSION) throw Error('Codex 0.166.0 required');
  const child = spawnProcess(binary, ['app-server'], { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
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
      if (message.error) {
        const error = Error('Central app-server rejected request');
        if (Number.isInteger(message.error.code) && message.error.code >= -2147483648 && message.error.code <= 2147483647)
          error.nativeRpcCode = message.error.code;
        entry.reject(error);
      } else entry.resolve(message.result);
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
  return { request, notify, events, initialized, version: version.stdout.trim().slice('codex-cli '.length), pid: child.pid, close, briqMcp: briq.status };
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
const questionMethod = 'item/tool/requestUserInput';
const elicitationMethod = 'mcpServer/elicitation/request';
const scopedToolNames = new Set(scopedBriqTools.map(tool => tool.name));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeKey = key => key.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(key);
function questionIds(params) {
  if (!record(params) || Object.keys(params).some(key => !['threadId', 'turnId', 'itemId', 'questions', 'isBlocking', 'autoResolutionMs'].includes(key)) ||
      ![params.threadId, params.turnId, params.itemId].every(value => typeof value === 'string' && value.length > 0) ||
      typeof params.isBlocking !== 'boolean' || params.autoResolutionMs != null && (!Number.isSafeInteger(params.autoResolutionMs) || params.autoResolutionMs < 0) ||
      !Array.isArray(params.questions) || !params.questions.length || params.questions.length > 64) return null;
  const ids = [];
  for (const question of params.questions) {
    if (!record(question) || Object.keys(question).some(key => !['id', 'header', 'question', 'isOther', 'isSecret', 'options'].includes(key)) ||
        typeof question.id !== 'string' || !safeKey(question.id) || ids.includes(question.id) ||
        !['header', 'question'].every(key => typeof question[key] === 'string') ||
        !['isOther', 'isSecret'].every(key => question[key] === undefined || typeof question[key] === 'boolean') ||
        question.options != null && (!Array.isArray(question.options) || question.options.some(option => !record(option) ||
          Object.keys(option).sort().join(',') !== 'description,label' || typeof option.label !== 'string' || typeof option.description !== 'string'))) return null;
    ids.push(question.id);
  }
  return ids;
}
function questionAnswer(result, ids) {
  return record(result) && Object.keys(result).join(',') === 'answers' && record(result.answers) &&
    Object.keys(result.answers).length === ids.length && Object.keys(result.answers).every(id => safeKey(id) && ids.includes(id)) &&
    ids.every(id => Object.hasOwn(result.answers, id) && record(result.answers[id]) && Object.keys(result.answers[id]).join(',') === 'answers' &&
      Array.isArray(result.answers[id].answers) && result.answers[id].answers.length <= 64 &&
      result.answers[id].answers.every(answer => typeof answer === 'string' && answer.length <= 1048576));
}
// Only the pinned native custom-server tool approval form is supported. The
// owner sees canonical arguments; display metadata never supplies authority or
// persistent choices. Keep the original request snapshot with its live intent.
function toolElicitation(params) {
  if (!record(params) || Object.keys(params).some(key => !['threadId', 'turnId', 'serverName', 'mode', '_meta', 'message', 'requestedSchema'].includes(key)) ||
      ![params.threadId, params.turnId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096) ||
      params.serverName !== 'briq' || params.mode !== 'form' || !record(params._meta) || !record(params._meta.tool_params) ||
      canonicalJson(params.requestedSchema) !== canonicalJson({ type: 'object', properties: {} }) || typeof params.message !== 'string') return null;
  const tool = /^Allow the briq MCP server to run tool "([a-z_]+)"\?$/.exec(params.message)?.[1];
  if (!scopedToolNames.has(tool)) return null;
  const snapshot = canonicalJson(params);
  if (Buffer.byteLength(snapshot) > 4194304) return null;
  const original = JSON.parse(snapshot);
  return { original, params: { ...original, _meta: {}, message: `${params.message}\n\nArguments: ${canonicalJson(original._meta.tool_params)}` } };
}
function elicitationAnswer(result) {
  if (!record(result) || Object.keys(result).some(key => !['action', 'content', '_meta'].includes(key)) ||
      !['accept', 'decline', 'cancel'].includes(result.action) || result._meta != null ||
      result.content != null && (!record(result.content) || Object.keys(result.content).length)) return null;
  return result.action === 'accept' ? { action: 'accept', content: {} } : { action: result.action };
}
const mutationMethods = new Set(['thread/start', 'turn/start', 'turn/steer', 'turn/interrupt']);
function error(id, message = 'Operation denied by sandbox binding', pending = false) { return { id, error: { code: pending ? -32010 : -32600, message, ...(pending ? { data: { sandboxOperationState: 'pending' } } : {}) } }; }
class SandboxOperationPending extends Error {}
// Called under the allocation lock after durable transition intent. The fixture
// uses this same per-thread lifecycle; there is no second app-server or home.
export async function resumeScopedCodex({ app, transport, binding, owner, params, verify, check, warm = true, observeTimeoutMs = 10000 }) {
  await check();
  if (warm) {
    const loaded = await app.request('thread/read', { threadId: binding.nativeThreadId, includeTurns: false });
    if (loaded.thread?.id !== binding.nativeThreadId || loaded.thread.status?.type !== 'idle' || loaded.thread.canAcceptDirectInput !== true)
      throw Error('Native thread is not safely idle');
    await check();
  }
  // Revocation is synchronous. An unsubscribe acknowledgement alone does not
  // establish that the runtime was rebuilt or that its config was accepted.
  transport?.closeTurn(binding.nativeThreadId);
  const mcp = transport?.bind(binding, owner);
  try {
    if (warm) {
      const unsubscribed = await app.request('thread/unsubscribe', { threadId: binding.nativeThreadId });
      if (unsubscribed.status !== 'unsubscribed') throw Error('Native subscription not removed');
      await check();
    }
    const result = await app.request('thread/resume', { ...params, threadId: binding.nativeThreadId, ...(mcp ? { config: { ...params.config, ...mcp.config } } : {}) });
    await verify(result);
    mcp?.activate(result.thread.id, result.thread.sessionId);
    if (mcp) {
      const inventory = await app.request('mcpServerStatus/list', { threadId: binding.nativeThreadId, serverName: 'briq', detail: 'toolsAndAuthOnly' });
      const tools = inventory.data?.find(server => server.name === 'briq')?.tools;
      if (!tools || Object.keys(tools).sort().join(',') !== transport.toolNames().join(',')) throw Error('Scoped native inventory mismatch');
      await mcp.waitObserved(observeTimeoutMs);
      await check();
      mcp.ready();
    }
    return result;
  } catch (error) { mcp?.revoke(); throw error; }
}
function textInput(input) {
  return Array.isArray(input) && input.length <= 64 && input.every(item => item && item.type === 'text' &&
    typeof item.text === 'string' && item.text.length <= 1048576 && Object.keys(item).every(key => ['type', 'text', 'text_elements'].includes(key)) &&
    (item.text_elements === undefined || Array.isArray(item.text_elements) && item.text_elements.length === 0));
}
export class CapabilityBroker {
  constructor({ store, app, claude, briqTransport, admittedProviders = ['codex'] }) {
    this.admittedProviders = new Set(admittedProviders.map(providerInstanceId));
    Object.assign(this, { store, app, claude, briqTransport }); this.sessions = new Set(); this.approvals = new Map(); this.sequence = 0; this.registered = new Set(); this.activeTurns = new Map(); this.finishedTurns = new Map(); this.unavailable = false; this.mutations = new Map(); this.owners = new Map(); this.pendingTurns = new Map(); this.questionTurns = new Map(); this.seenQuestions = new Set();
    app.events.on('message', message => { this.deliver(message).catch(() => {}); });
    app.events.on('closed', () => { this.briqTransport?.close(); this.unavailable = true; this.registered.clear(); this.approvals.clear(); for (const session of this.sessions) session.close(); });
  }
  async registerEnvironment(binding) {
    const provider = providerInstanceId(binding.providerInstanceId);
    if (binding.state !== 'ready' || !this.admittedProviders.has(provider)) throw Error('Allocation not ready');
    if (provider === 'claudeAgent') {
      if (binding.nativeThreadId) throw Error('Claude allocation contains Codex identity');
      return;
    }
    if (this.registered.has(binding.allocationId)) return;
    await this.app.request('environment/add', { environmentId: binding.execEnvironmentId, execServerUrl: binding.execUrl, authBearerToken: binding.execToken });
    this.registered.add(binding.allocationId);
  }
  async connect(token, send, close) {
    const bindings = await this.store.list();
    const binding = bindings.find(value => value?.state === 'ready' && equalSecret(token, value.bridgeToken));
    if (!binding || !this.admittedProviders.has(providerInstanceId(binding.providerInstanceId))) throw Error('Invalid sandbox capability');
    const session = { providerInstanceId: providerInstanceId(binding.providerInstanceId), allocationId: binding.allocationId, threadId: binding.threadId, send, close, initialized: false, closed: false, mutations: new Set() };
    await this.store.serialized(binding.threadId, async () => {
      await this.binding(session);
      const previous = this.owners.get(binding.allocationId);
      if (previous && !previous.closed) throw Error('Native execution owner busy');
      this.briqTransport?.claimOwner?.(binding, session);
      this.owners.set(binding.allocationId, session); this.sessions.add(session);
    });
    return { receive: message => this.receive(session, message), close: () => this.disconnect(session) };
  }
  async binding(session) {
    if (session.closed || this.unavailable) throw Error('Central app-server unavailable');
    const binding = await this.store.load(session.threadId);
    if (binding?.state !== 'ready' || binding.allocationId !== session.allocationId ||
      providerInstanceId(binding.providerInstanceId) !== session.providerInstanceId || !this.admittedProviders.has(session.providerInstanceId)) throw Error('Allocation revoked');
    return binding;
  }
  async capabilities(session) {
    const binding = await this.binding(session);
    const provider = providerInstanceId(binding.providerInstanceId);
    let metadata;
    if (provider === 'claudeAgent') {
      if (!this.claude?.enabled) throw Error('Claude admission unavailable');
      metadata = await this.claude.capabilities(session);
    } else {
      try { metadata = await this.codexMetadata(); } catch { metadata = { models: [], authStatus: 'unknown' }; }
    }
    await this.binding(session);
    return { providerInstanceId: provider, threadId: binding.threadId, ...providerMetadata(metadata) };
  }
  async codexMetadata() {
    const account = await this.app.request('account/read', { refreshToken: false });
    const catalog = await this.app.request('model/list', {});
    if (catalog.nextCursor || !Array.isArray(catalog.data)) throw Error('Provider catalog incomplete');
    const metadata = providerMetadata({ models: catalog.data.map(row => ({ slug: row.model })),
      authStatus: account.account ? 'authenticated' : account.requiresOpenaiAuth === true ? 'unauthenticated' : 'unknown' });
    const defaults = catalog.data.filter(row => row.isDefault === true);
    return { ...metadata, defaultModel: defaults.length === 1 ? defaults[0].model : undefined };
  }
  async effectiveCodexModel(binding, requested, initial = false) {
    if (providerInstanceId(binding.providerInstanceId) !== 'codex' || !this.admittedProviders.has('codex')) throw Error('Provider binding mismatch');
    if (binding.nativeState === 'unknown') throw Error('Native model requires reconciliation');
    const metadata = await this.codexMetadata();
    if (metadata.authStatus !== 'authenticated') throw Error('Provider authentication unavailable');
    let model = requested ?? (initial ? metadata.defaultModel : binding.nativeModel);
    if (model === undefined && !initial && binding.nativeThreadId) {
      const loaded = await this.app.request('thread/read', { threadId: binding.nativeThreadId, includeTurns: false });
      if (loaded.thread?.id !== binding.nativeThreadId || !this.matchesEnvironment(loaded.thread, binding)) throw Error('Native thread environment mismatch');
      model = loaded.thread.model;
    }
    if (typeof model !== 'string' || !metadata.models.some(row => row.slug === model)) throw Error('Effective model is not admitted');
    return model;
  }
  async verifyCodexModel(response, model) {
    // Pinned v2 ThreadStartResponse/ThreadResumeResponse carry model at top level.
    const metadata = await this.codexMetadata();
    if (metadata.authStatus !== 'authenticated' || response.model !== model || !metadata.models.some(row => row.slug === response.model))
      throw Error('Native model requires reconciliation');
  }
  async assertMutationAllowed(session) {
    const binding = await this.binding(session);
    for (const operation of await this.store.listOperations(session.threadId)) {
      if (operation.threadId !== binding.threadId || operation.allocationId !== binding.allocationId) throw Error('Operation identity requires reconciliation');
      if (operation.method === 'briq/scoped') {
        if (operation.state !== 'completed' || operation.providerInstanceId !== 'codex' || operation.nativeId !== binding.nativeThreadId ||
            typeof operation.turnId !== 'string' || !operation.turnId || typeof operation.requestId !== 'string' && typeof operation.requestId !== 'number')
          throw Error('Scoped operation requires reconciliation');
      } else if (!mutationMethods.has(operation.method) || operation.state !== 'adopted') throw Error('Unadopted operation requires explicit reconciliation');
    }
    for (const id of await this.store.mutationMarkers(session.threadId)) {
      const active = this.mutations.get(id);
      if (!active || active.session !== session || active.quarantined || active.session.closed || !active.locallyWritten)
        throw Error('Unadopted mutation requires explicit reconciliation');
    }
  }
  async beginMutation(session, method, operation) {
    // Internal attempt IDs are not durable client action identities. Markers remain until
    // explicit authoritative adoption; neither native results nor WS writes prove adoption.
    const mutation = { id: randomUUID(), session, method, operation, quarantined: false, locallyWritten: false };
    this.mutations.set(mutation.id, mutation); session.mutations.add(mutation);
    try {
      if (operation) {
        operation.record = { ...operation.record, state: 'started' };
        await this.store.saveOperation(session.threadId, operation.record);
      } else await this.store.markMutation(session.threadId, mutation.id, method);
      if (session.closed) throw Error('Sandbox disconnected');
      return mutation;
    } catch (error) {
      mutation.quarantined = true; this.mutations.delete(mutation.id); session.mutations.delete(mutation); throw error;
    }
  }
  async resumeNative(binding, { session, params = {}, model, recovery = false } = {}) {
    if (providerInstanceId(binding.providerInstanceId) !== 'codex' || binding.claudeNativeSessionId || !binding.nativeThreadId ||
        this.activeTurns.has(binding.nativeThreadId) || this.pendingTurns.has(binding.nativeThreadId) || !recovery && binding.turnState === 'unknown')
      throw Error('Native resume requires idle reconciliation');
    if (session) await this.assertMutationAllowed(session);
    const check = async () => {
      const current = session ? await this.binding(session) : await this.store.load(binding.threadId);
      if (this.unavailable || current?.state !== 'ready' || current.allocationId !== binding.allocationId || current.nativeThreadId !== binding.nativeThreadId ||
          providerInstanceId(current.providerInstanceId) !== 'codex' || current.claudeNativeSessionId || current.execEnvironmentId !== binding.execEnvironmentId ||
          this.activeTurns.has(binding.nativeThreadId) || this.pendingTurns.has(binding.nativeThreadId) || session && this.owners.get(binding.allocationId) !== session)
        throw Error('Native transition owner changed');
    };
    await check();
    binding.nativeState = 'unknown'; binding.restoreState = 'reconciliation-required'; await this.store.save(binding);
    const result = await resumeScopedCodex({ app: this.app, transport: this.briqTransport, binding, owner: session, params: { ...params, model }, warm: !recovery, check,
      verify: async result => {
        if (result.thread?.id !== binding.nativeThreadId || !this.matchesEnvironment(result.thread, binding)) throw Error('Resumed thread environment mismatch');
        await this.verifyCodexModel(result, model);
      } });
    await check();
    binding.nativeModel = model; binding.nativeState = 'bound'; delete binding.restoreState; await this.store.save(binding);
    return result;
  }
  observeTurn(message) {
    const threadId = message.params?.threadId, turn = message.params?.turn;
    if (!threadId || !turn?.id) return;
    const pending = this.pendingTurns.get(threadId);
    if (message.method === 'turn/started') {
      if (!pending || pending.closed || pending.turnId && pending.turnId !== turn.id || this.finishedTurns.get(threadId) === turn.id) return;
      pending.turnId = turn.id;
      this.activeTurns.set(threadId, turn.id);
      this.questionTurns.set(threadId, pending);
      if (this.briqTransport?.startTurn?.(threadId, turn.id, pending.lease) === false) this.closeQuestionTurn(threadId);
    }
    if (message.method === 'turn/completed') {
      // Close synchronously, before any store read or notification delivery.
      if (pending && (!pending.turnId || pending.turnId === turn.id)) { pending.turnId = turn.id; pending.closed = true; }
      this.finishedTurns.set(threadId, turn.id);
      if (this.questionTurns.get(threadId)?.turnId === turn.id) this.questionTurns.delete(threadId);
      if (this.activeTurns.get(threadId) === turn.id) this.activeTurns.delete(threadId);
      this.briqTransport?.closeTurn?.(threadId, turn.id);
    }
  }
  closeQuestionTurn(threadId) {
    const scope = this.questionTurns.get(threadId) ?? this.pendingTurns.get(threadId);
    if (scope) scope.closed = true;
    this.questionTurns.delete(threadId);
    this.briqTransport?.closeTurn?.(threadId);
  }
  questionTurnLive(threadId, turnId, scope, session, binding) {
    // The durable turn may still be unknown while start is in flight. Authority
    // comes from the original live intent and reserved execution lease instead.
    const mutation = scope?.mutation;
    return Boolean(scope && this.questionTurns.get(threadId) === scope && !scope.closed && scope.session === session &&
      scope.turnId === turnId && this.activeTurns.get(threadId) === turnId &&
      scope.allocationId === binding.allocationId && scope.environmentId === binding.execEnvironmentId &&
      mutation?.method === 'turn/start' && mutation.session === session && !mutation.quarantined &&
      this.mutations.get(scope.intent) === mutation && session.mutations.has(mutation) && !session.closed &&
      this.owners.get(binding.allocationId) === session &&
      (!this.briqTransport || scope.lease && !scope.lease.closed && this.briqTransport.startTurn?.(threadId, turnId, scope.lease) === true));
  }
  async deliverMutation(mutation, message) {
    const { session } = mutation;
    if (mutation.operation) {
      const record = { ...mutation.operation.record, state: 'completed', result: message.result, resultHash: digest(canonicalJson(message.result)) };
      await this.store.saveOperation(session.threadId, record);
      mutation.operation.record = record;
      message = { id: message.id, result: { result: record.result, resultHash: record.resultHash } };
    }
    try {
      if (session.closed || mutation.quarantined) throw Error('Sandbox disconnected');
      if (await session.send(message) === false) throw Error('Sandbox reply undelivered');
      if (session.closed || mutation.quarantined) throw Error('Sandbox disconnected');
      // Only allow this live session to continue. Retain the journal and ownership so a
      // subsequent disconnect, even after this callback, quarantines the unadopted result.
      mutation.locallyWritten = true;
    } catch (error) { mutation.quarantined = true; throw error; }
  }
  async sendOperationReceipt(session, message) {
    try {
      if (await session.send(message) === false) throw new SandboxOperationPending();
    } catch { throw new SandboxOperationPending(); }
  }
  async executeOperation(session, message, binding, locked = false, receiptOnly = false) {
    const envelope = message.params;
    if (!session.initialized || !envelope || Object.keys(envelope).sort().join(',') !== 'key,method,params,threadId,version' ||
      envelope.version !== 1 || envelope.threadId !== binding.threadId || !mutationMethods.has(envelope.method) ||
      !envelope.params || typeof envelope.params !== 'object' || Array.isArray(envelope.params)) throw Error('Invalid operation envelope');
    identifier(envelope.key);
    if (!locked) return this.store.serialized(`operation-${digest(`${binding.allocationId}:${envelope.key}`)}`, () => this.executeOperation(session, message, binding, true, receiptOnly));
    binding = await this.binding(session);
    const requestHash = digest(canonicalJson({ allocationId: binding.allocationId, threadId: binding.threadId, method: envelope.method, params: envelope.params }));
    const stored = await this.store.loadOperation(binding.threadId, envelope.key);
    if (stored) {
      if (stored.requestHash !== requestHash || stored.allocationId !== binding.allocationId ||
        stored.threadId !== binding.threadId || stored.key !== envelope.key) throw Error('Operation payload conflict');
      if (!['completed', 'adopted'].includes(stored.state)) throw new SandboxOperationPending();
      return this.sendOperationReceipt(session, { id: message.id, result: { result: stored.result, resultHash: stored.resultHash } });
    }
    // Recovery with local durable facts may only read an existing receipt. A lost
    // broker ledger cannot establish that the original native mutation never ran.
    if (receiptOnly) throw Error('Operation receipt unavailable');
    const operation = { record: { version: 1, key: envelope.key, allocationId: binding.allocationId, threadId: binding.threadId,
      method: envelope.method, params: envelope.params, requestHash } };
    await this.receive(session, { id: message.id, method: envelope.method, params: envelope.params }, operation);
  }
  async adoptOperation(session, message, binding) {
    const params = message.params;
    if (!session.initialized || !params || Object.keys(params).sort().join(',') !== 'eventSequence,key,nativeId,resultHash' ||
      !Number.isSafeInteger(params.eventSequence) || params.eventSequence < 1 || typeof params.nativeId !== 'string') throw Error('Invalid adoption receipt');
    identifier(params.key);
    await this.store.serialized(`adopt-${digest(binding.threadId)}`, async () => {
      binding = await this.binding(session);
      const record = await this.store.loadOperation(binding.threadId, params.key);
      const nativeId = record?.result?.thread?.id ?? record?.result?.turn?.id ?? record?.params?.expectedTurnId ?? record?.params?.turnId;
      if (!record || !['completed', 'adopted'].includes(record.state) || record.allocationId !== binding.allocationId ||
        record.resultHash !== params.resultHash || !nativeId || nativeId !== params.nativeId) throw Error('Adoption does not match result');
      if (record.state === 'adopted' && (record.adoption.nativeId !== params.nativeId || record.adoption.resultHash !== params.resultHash || record.adoption.eventSequence !== params.eventSequence)) throw Error('Conflicting adoption');
      if (record.state !== 'adopted') await this.store.saveOperation(binding.threadId, { ...record, state: 'adopted', adoption: { ...params } });
    });
    return this.sendOperationReceipt(session, { id: message.id, result: {} });
  }
  async receive(session, message, operation) {
    if (!message || typeof message !== 'object' || JSON.stringify(message).length > 2097152) return session.close();
    const id = message.id; let mutation;
    try {
      const binding = await this.binding(session);
      if (message.method === 'bridge/capabilities') {
        if (!['number', 'string'].includes(typeof id) || message.params !== undefined &&
          (!message.params || typeof message.params !== 'object' || Array.isArray(message.params) || Object.keys(message.params).length)) throw Error('Invalid capability request');
        return await session.send({ id, result: await this.capabilities(session) });
      }
      if (message.method?.startsWith('claude/')) {
        if (session.providerInstanceId !== 'claudeAgent') throw Error('Provider binding mismatch');
        if (!this.claude) throw Error('Claude cloud execution unavailable');
        return await session.send({ id, result: await this.claude.receive(session, message) });
      }
      if (session.providerInstanceId !== 'codex') throw Error('Provider binding mismatch');
      if (['thread/start', 'turn/start', 'turn/steer', 'thread/resume'].includes(message.method)) {
        const metadata = await this.capabilities(session);
        if (metadata.authStatus !== 'authenticated' || !metadata.models.length) throw Error('Provider authentication unavailable');
      }
      if (message.method?.startsWith('briq/operation/') && typeof message.id !== 'number' && typeof message.id !== 'string') throw Error('Invalid request identity');
      if (message.method === 'briq/operation/execute') return await this.executeOperation(session, message, binding);
      if (message.method === 'briq/operation/receipt') return await this.executeOperation(session, message, binding, false, true);
      if (message.method === 'briq/operation/adopt') return await this.adoptOperation(session, message, binding);
      if (!message.method && id !== undefined) {
        const approval = this.approvals.get(id);
        if (approval?.method === elicitationMethod) {
          const result = elicitationAnswer(message.result);
          if (message.error !== undefined || !result || approval.session !== session) return session.send(error(id));
          if (result.action === 'accept' && (await this.capabilities(session)).authStatus !== 'authenticated') return session.send(error(id));
          const current = await this.binding(session);
          if (approval.allocationId !== current.allocationId || approval.providerInstanceId !== session.providerInstanceId ||
              approval.threadId !== current.nativeThreadId || approval.environmentId !== current.execEnvironmentId ||
              !this.questionTurnLive(approval.threadId, approval.turnId, approval.scope, session, current) || this.approvals.get(id) !== approval)
            return session.send(error(id));
          this.approvals.delete(id); this.app.notify({ id: approval.nativeId, result }); return;
        }
        if (approval?.method === questionMethod) {
          if (message.error !== undefined || !questionAnswer(message.result, approval.questionIds)) return session.send(error(id));
          const current = await this.binding(session);
          if (approval.session !== session || approval.allocationId !== current.allocationId || approval.providerInstanceId !== session.providerInstanceId ||
              approval.threadId !== current.nativeThreadId || approval.environmentId !== current.execEnvironmentId ||
              this.owners.get(current.allocationId) !== session || this.questionTurns.get(approval.threadId) !== approval.scope ||
              !this.questionTurnLive(approval.threadId, approval.turnId, approval.scope, session, current) || this.approvals.get(id) !== approval)
            return session.send(error(id));
          this.approvals.delete(id); this.app.notify({ id: approval.nativeId, result: message.result }); return;
        }
        if (!approval || approval.session !== session || approval.threadId !== binding.nativeThreadId ||
          approval.environmentId !== binding.execEnvironmentId || this.activeTurns.get(binding.nativeThreadId) !== approval.turnId || !message.result ||
          Object.keys(message.result).some(key => key !== 'decision') || !['accept', 'decline', 'cancel'].includes(message.result.decision))
          return session.send(error(id));
        if (message.result.decision === 'accept' && (await this.capabilities(session)).authStatus !== 'authenticated') return session.send(error(id));
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
      if (params.model !== undefined && !(await this.capabilities(session)).models.some(row => row.slug === params.model)) return session.send(error(id));
      if (params.effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(params.effort)) return session.send(error(id));
      if (params.input !== undefined && !textInput(params.input)) return session.send(error(id));
      if (params.approvalPolicy !== undefined && params.approvalPolicy !== 'on-request') return session.send(error(id));
      if (params.sandbox !== undefined && params.sandbox !== 'workspace-write') return session.send(error(id));
      if (message.method === 'turn/steer') return await this.store.serialized(binding.threadId, async () => {
        const current = await this.binding(session);
        if (!params.expectedTurnId || this.activeTurns.get(current.nativeThreadId) !== params.expectedTurnId) throw Error('Turn no longer active');
        if (current.restoreState) throw Error('Native restoration required');
        await this.effectiveCodexModel(current);
        await this.assertMutationAllowed(session);
        mutation = await this.beginMutation(session, message.method, operation);
        const result = await this.app.request(message.method, params);
        await this.deliverMutation(mutation, { id, result });
      });
      if (message.method === 'turn/interrupt') {
        const turnId = params.turnId;
        if (!turnId || this.activeTurns.get(binding.nativeThreadId) !== turnId) return session.send(error(id));
        // Cancellation must remain independent of a pending turn/start or read response.
        this.questionTurns.delete(binding.nativeThreadId);
        this.briqTransport?.closeTurn?.(binding.nativeThreadId, turnId);
        const pendingTurn = this.pendingTurns.get(binding.nativeThreadId); if (pendingTurn) pendingTurn.closed = true;
        mutation = await this.beginMutation(session, message.method, operation);
        const result = await this.app.request(message.method, params);
        return await this.deliverMutation(mutation, { id, result });
      }
      if (message.method === 'thread/unsubscribe') this.closeQuestionTurn(binding.nativeThreadId);
      let response;
      await this.store.serialized(binding.threadId, async () => {
        const current = await this.binding(session);
        const environment = { environmentId: current.execEnvironmentId, cwd: '/work', runtimeWorkspaceRoots: ['/work'] };
        if (current.restoreState && ['thread/start', 'turn/start'].includes(message.method)) throw Error('Native restoration required');
        if (message.method === 'thread/start') {
          if (current.nativeThreadId || current.nativeState === 'unknown') throw Error('Native thread already allocated or requires reconciliation');
          const model = await this.effectiveCodexModel(current, params.model, true);
          await this.assertMutationAllowed(session);
          mutation = await this.beginMutation(session, message.method, operation);
          current.nativeState = 'unknown'; await this.store.save(current);
          const mcp = this.briqTransport?.bind(current, session);
          try {
            response = await this.app.request(message.method, { ...params, model, cwd: '/work', environments: [environment], approvalPolicy: 'on-request', sandbox: 'workspace-write', ...(mcp ? { config: mcp.config } : {}) });
            if (!response.thread?.id || !this.matchesEnvironment(response.thread, current)) throw Error('Native thread environment mismatch');
            await this.verifyCodexModel(response, model);
            current.nativeThreadId = response.thread.id; current.nativeModel = model; await this.store.save(current);
            mcp?.activate(response.thread.id, response.thread.sessionId);
            if (mcp) {
              await mcp.waitObserved();
              if (session.closed || this.owners.get(current.allocationId) !== session) throw Error('Native transition owner changed');
              mcp.ready();
            }
          } catch (error) { mcp?.revoke(); throw error; }
          if (!response.thread?.id || !this.matchesEnvironment(response.thread, current)) throw Error('Native thread environment mismatch');
          current.nativeThreadId = response.thread.id; current.nativeModel = model; current.nativeState = 'bound'; await this.store.save(current);
        } else {
          const model = ['turn/start', 'thread/resume'].includes(message.method) ? await this.effectiveCodexModel(current, params.model) : undefined;
          if (message.method === 'thread/resume') await this.registerEnvironment(current);

          if (message.method === 'turn/start') {
            if (this.activeTurns.has(current.nativeThreadId) || current.turnState === 'unknown') throw Error('Turn already active or outcome unknown');
            await this.assertMutationAllowed(session);
            mutation = await this.beginMutation(session, message.method, operation);
            current.turnState = 'unknown'; await this.store.save(current);
            const lease = this.briqTransport?.reserveTurn(current, session, mutation.id);
            this.pendingTurns.set(current.nativeThreadId, { session, intent: mutation.id, mutation, lease, allocationId: current.allocationId, environmentId: current.execEnvironmentId, turnId: null, closed: false });
          }
          if (message.method === 'thread/resume') {
            response = await this.resumeNative(current, { session, params, model });
          } else {
            response = await this.app.request(message.method, { ...params, ...(model ? { model } : {}), ...(message.method === 'turn/start' ? { environments: [environment] } : {}) });
          }
          if (message.method === 'thread/read' && (response.thread?.id !== current.nativeThreadId || !this.matchesEnvironment(response.thread, current))) throw Error('Read thread environment mismatch');
          if (message.method === 'turn/start') {
            if (!response.turn?.id) throw Error('Missing turn binding');
            const pending = this.pendingTurns.get(current.nativeThreadId);
            if (!pending || pending.session !== session || pending.turnId && pending.turnId !== response.turn.id) throw Error('Native turn correlation mismatch');
            if (['completed', 'interrupted', 'failed'].includes(response.turn.status) || this.finishedTurns.get(current.nativeThreadId) === response.turn.id || pending.closed) {
              this.observeTurn({ method: 'turn/completed', params: { threadId: current.nativeThreadId, turn: response.turn } });
            } else this.observeTurn({ method: 'turn/started', params: { threadId: current.nativeThreadId, turn: response.turn } });
            const loaded = await this.app.request('thread/read', { threadId: current.nativeThreadId, includeTurns: false });
            if (loaded.thread?.id !== current.nativeThreadId || !this.matchesEnvironment(loaded.thread, current) || loaded.thread.model !== model) throw Error('Turn environment/model mismatch');
            current.nativeModel = model; current.turnState = 'bound'; current.nativeTurnId = response.turn.id; await this.store.save(current);
            this.pendingTurns.delete(current.nativeThreadId);
          }
        }
      });
      response = this.publicResult(response);
      if (mutation) await this.deliverMutation(mutation, { id, result: response });
      else if (!session.closed) await session.send({ id, result: response });
    } catch (cause) {
      if (mutation?.method === 'turn/start') {
        for (const [nativeId, scope] of this.questionTurns) if (scope.mutation === mutation) this.closeQuestionTurn(nativeId);
        for (const [nativeId, pendingTurn] of this.pendingTurns) if (pendingTurn.intent === mutation.id) {
          pendingTurn.closed = true; this.briqTransport?.closeTurn?.(nativeId); this.pendingTurns.delete(nativeId);
        }
      }
      const pending = cause instanceof SandboxOperationPending || Boolean(mutation?.operation);
      if (mutation) {
        mutation.quarantined = true; this.mutations.delete(mutation.id); session.mutations.delete(mutation);
        if (mutation.operation?.record.state === 'started') {
          mutation.operation.record = { ...mutation.operation.record, state: 'uncertain' };
          await this.store.saveOperation(session.threadId, mutation.operation.record);
        }
      }
      if (!session.closed) await session.send(pending ? error(id, 'Sandbox operation outcome requires reconciliation', true) : error(id));
    }
  }
  publicResult(value) {
    if (Array.isArray(value)) return value.map(item => this.publicResult(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['config', 'mcpServers', 'mcp_servers', 'http_headers'].includes(key) && !key.startsWith('mcp_servers.')).map(([key, item]) => [key, this.publicResult(item)]));
  }
  matchesEnvironment(thread, binding) {
    return Array.isArray(thread.environments) && thread.environments.length === 1 &&
      thread.environments[0].environmentId === binding.execEnvironmentId && thread.environments[0].cwd === '/work';
  }
  async deliver(message) {
    this.observeTurn(message);
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
    if (message.id !== undefined) {
      if (message.method === elicitationMethod) {
        const form = toolElicitation(message.params), scope = this.questionTurns.get(threadId);
        const nativeKey = JSON.stringify([typeof message.id, message.id]);
        const target = candidates.find(({ session, binding }) => form && session.initialized && scope?.session === session &&
          this.questionTurnLive(threadId, message.params.turnId, scope, session, binding));
        if (!target || !['string', 'number'].includes(typeof message.id) || typeof message.id === 'number' && !Number.isSafeInteger(message.id) || this.seenQuestions.has(nativeKey)) {
          this.app.notify({ id: message.id, error: { code: -32600, message: 'Unbound server request denied' } }); return;
        }
        this.seenQuestions.add(nativeKey);
        const id = `elicitation-${++this.sequence}`;
        this.approvals.set(id, { method: elicitationMethod, session: target.session, nativeId: message.id, threadId, turnId: message.params.turnId,
          environmentId: target.binding.execEnvironmentId, allocationId: target.binding.allocationId, providerInstanceId: target.session.providerInstanceId,
          scope, original: form.original });
        try {
          if (await target.session.send({ ...message, id, params: form.params }) === false) throw Error('Approval delivery unknown');
        } catch {
          this.approvals.delete(id); this.app.notify({ id: message.id, result: { action: 'cancel' } });
        }
        return;
      }
      if (message.method === questionMethod) {
        const ids = questionIds(message.params), scope = this.questionTurns.get(threadId);
        const nativeKey = JSON.stringify([typeof message.id, message.id]);
        const target = candidates.find(({ session, binding }) => ids && session.initialized && scope?.session === session &&
          this.questionTurnLive(threadId, message.params.turnId, scope, session, binding));
        if (!target || !['string', 'number'].includes(typeof message.id) || typeof message.id === 'number' && !Number.isSafeInteger(message.id) || this.seenQuestions.has(nativeKey)) {
          this.app.notify({ id: message.id, error: { code: -32600, message: 'Unbound server request denied' } }); return;
        }
        this.seenQuestions.add(nativeKey);
        const id = `question-${++this.sequence}`;
        this.approvals.set(id, { method: questionMethod, session: target.session, nativeId: message.id, threadId, turnId: message.params.turnId,
          environmentId: target.binding.execEnvironmentId, allocationId: target.binding.allocationId, providerInstanceId: target.session.providerInstanceId, scope, questionIds: ids });
        try {
          if (await target.session.send({ ...message, id }) === false) throw Error('Question delivery unknown');
        } catch {
          this.approvals.delete(id);
          this.app.notify({ id: message.id, error: { code: -32600, message: 'User input delivery unavailable' } });
        }
        return;
      }
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
      if (notifications.has(message.method)) await Promise.allSettled(candidates.map(({ session }) => session.send(this.publicResult(message))));
    }
  }
  disconnect(session) {
    session.closed = true;
    if (this.owners.get(session.allocationId) === session) {
      this.owners.delete(session.allocationId);
      this.briqTransport?.revokeOwner?.(session.allocationId, session);
      for (const pending of this.pendingTurns.values()) if (pending.session === session) pending.closed = true;
    }
    void this.claude?.disconnect(session).catch(() => {});
    for (const mutation of session.mutations) { mutation.quarantined = true; this.mutations.delete(mutation.id); }
    session.mutations.clear();
    this.sessions.delete(session);
    for (const [threadId, scope] of this.questionTurns) if (scope.session === session) this.questionTurns.delete(threadId);
    for (const [id, approval] of this.approvals) if (approval.session === session) {
      this.approvals.delete(id); this.app.notify(approval.method === questionMethod
        ? { id: approval.nativeId, error: { code: -32600, message: 'User input owner disconnected' } }
        : { id: approval.nativeId, result: approval.method === elicitationMethod ? { action: 'cancel' } : { decision: 'cancel' } });
    }
  }
  providerVersion(provider) { return provider === 'codex' ? this.app.version ?? null : null; }
  async ownerRequest(method, params) {
    if (!['account/read', 'account/login/start', 'account/login/cancel', 'account/logout'].includes(method)) throw Error('Unsupported connection operation');
    if (method === 'account/login/start' && (params?.type !== 'chatgptDeviceCode' || Object.keys(params).some(key => !['type'].includes(key)))) throw Error('Only native ChatGPT sign-in supported');
    const response = await this.app.request(method, params);
    if (method === 'account/read') return { account: response.account ? { type: response.account.type, email: response.account.email, planType: response.account.planType } : null, requiresOpenaiAuth: response.requiresOpenaiAuth };
    return response;
  }
}
