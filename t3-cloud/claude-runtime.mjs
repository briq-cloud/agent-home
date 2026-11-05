import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { canonicalJson, digest, identifier } from './allocations.mjs';
import { ClaudeRemoteExec } from './claude-exec.mjs';
import { scopedBriqTools } from './scoped-briq.mjs';
import { providerRequestId } from './scoped-mcp-transport.mjs';

// Integrated/native recovery and subscription gates have not passed. No environment variable overrides this.
export const CLAUDE_CLOUD_ENABLED = false;
const deniedTools = ['Bash','Read','Write','Edit','MultiEdit','Glob','Grep','NotebookEdit','Agent','Task','TaskOutput','TaskStop','EnterWorktree','ExitWorktree','Skill','CronCreate','CronDelete','CronList','WebFetch','WebSearch','Computer','ToolSearch'];
const methods = new Set(['claude/allocate','claude/open','claude/offer','claude/model','claude/pending','claude/receipt','claude/adopt','claude/interrupt','claude/close']);
const fields = { 'claude/allocate': [], 'claude/open': ['nativeId','key','model'], 'claude/offer': ['nativeId','key','text'],
  'claude/pending': ['nativeId'], 'claude/receipt': ['nativeId','key'], 'claude/adopt': ['nativeId','key','resultHash','eventSequence'],
  'claude/model': ['nativeId','model'], 'claude/interrupt': ['nativeId'], 'claude/close': ['nativeId'] };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const modelName = value => typeof value === 'string' && /^claude-[a-zA-Z0-9._-]{1,100}$/.test(value);

async function loadNativeSdk() {
  const directory = '/opt/t3/node_modules/@anthropic-ai/claude-agent-sdk';
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (pkg.version !== '0.3.276' || manifest.version !== '2.1.276') throw Error('Pinned Claude SDK required');
  const binary = '/usr/local/bin/claude';
  const platform = manifest.platforms[`${process.platform}-${process.arch}`];
  if (!platform || createHash('sha256').update(await readFile(binary)).digest('hex') !== platform.checksum) throw Error('Pinned Claude CLI required');
  // Do not trust non-managed disableAllHooks: existing administrative hooks can still run.
  const managed = JSON.parse(await readFile('/etc/claude-code/managed-settings.json', 'utf8'));
  const expected = { disableAllHooks: true, disableAgentView: true, disableRemoteControl: true,
    env: { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' } };
  if (canonicalJson(managed) !== canonicalJson(expected)) throw Error('Controlled Claude managed policy required');
  const sdk = await import(pathToFileURL(join(directory, 'sdk.mjs')));
  const require = createRequire(join(directory, 'sdk.mjs'));
  return { ...sdk, z: require('zod').z, binary };
}
export class ClaudeCredentialOwner {
  constructor() { this.current = null; this.quarantined = false; }
  acquire(identity) {
    if (this.current || this.quarantined) throw Error('Central Claude credential owner busy');
    this.current = identity;
    return () => { if (this.current === identity && !this.quarantined) this.current = null; };
  }
  quarantine() { this.quarantined = true; }
}
export function createScopedClaudeMcpServer(sdk, owner, scopedBriq) {
  const server = sdk.createSdkMcpServer({ name: 'briq', version: '1', tools: [], alwaysLoad: true });
  for (const tool of scopedBriqTools) server.instance.registerTool(tool.name, {
    description: tool.description, inputSchema: sdk.z.fromJSONSchema(tool.inputSchema).strict(),
    _meta: { 'anthropic/alwaysLoad': true },
  }, async (input, extra) => {
    if (!owner.turnId || owner.closed) throw Error('Claude turn unavailable');
    try {
      const requestId = digest(canonicalJson([owner.openRecord.key, owner.turnId, providerRequestId(extra?.requestId)]));
      const result = await scopedBriq.call(owner, requestId, tool.name, input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch { return { isError: true, content: [{ type: 'text', text: 'Briq operation unavailable; reconcile pending operations before retrying.' }] }; }
  });
  return server;
}
export class ClaudeRuntime {
  constructor({ store, ledger, cloud, scopedBriq, directory, enabled = CLAUDE_CLOUD_ENABLED, loadSdk = loadNativeSdk, spawnProcess = spawn, closeTimeoutMs = 10000, credentials = new ClaudeCredentialOwner(), nativeHome, nativeConfigDirectory }) {
    Object.assign(this, { store, ledger, scopedBriq, directory, enabled, loadSdk, spawnProcess, closeTimeoutMs, credentials, nativeHome, nativeConfigDirectory });
    this.executor = new ClaudeRemoteExec({ store, ledger, cloud }); this.owner = null; this.quarantined = false;
  }
  async binding(session) {
    const value = await this.store.load(session.threadId);
    if (session.closed || value?.state !== 'ready' || value.allocationId !== session.allocationId || !value.briqId)
      throw Error('Claude allocation revoked');
    return value;
  }
  async receive(session, message) {
    if (!this.enabled || this.quarantined && !['claude/pending','claude/receipt','claude/adopt'].includes(message.method) || !methods.has(message.method) || !['number','string'].includes(typeof message.id)) throw Error('Claude cloud execution is unavailable');
    const params = message.params ?? {};
    if (!params || Array.isArray(params) || typeof params !== 'object' || Object.keys(params).some(key => !fields[message.method].includes(key))) throw Error('Invalid Claude request');
    let binding = await this.binding(session);
    if (message.method === 'claude/allocate') {
      return this.store.serialized(binding.threadId, async () => {
        binding = await this.binding(session);
        if (!binding.claudeNativeSessionId) { binding.claudeNativeSessionId = randomUUID(); await this.store.save(binding); }
        return { nativeId: binding.claudeNativeSessionId };
      });
    }
    if (!binding.claudeNativeSessionId || params.nativeId !== binding.claudeNativeSessionId) throw Error('Claude native identity mismatch');
    if (message.method === 'claude/pending') return { results: (await this.ledger.listOperations(binding.threadId))
      .filter(record => record.method === 'claude/offer' && (record.state === 'result-pending' || record.state === 'adopted' && this.owner?.turnRecord?.key === record.key && this.owner.nativeId === params.nativeId) && record.nativeId === params.nativeId && record.allocationId === binding.allocationId)
      .map(record => ({ key: record.key.slice(5), nativeId: record.nativeId, resultHash: record.resultHash })) };
    if (message.method === 'claude/receipt' || message.method === 'claude/adopt') return this.reconcile(session, binding, message.method, params);
    if (message.method === 'claude/open') return this.open(session, binding, params);
    const owner = this.owner;
    if (!owner || owner.session !== session || owner.nativeId !== params.nativeId || owner.closed) throw Error('Claude session unavailable');
    if (message.method === 'claude/interrupt' || message.method === 'claude/close') {
      await this.closeOwner(owner); return {};
    }
    // Cancellation stays outside this lock. Concurrent offers and model changes may not
    // pass the idle check together while the first request is writing its journal.
    return this.ledger.serialized(`query-${owner.threadId}`, async () => {
      await this.binding(session);
      if (owner.closed || this.owner !== owner) throw Error('Claude session unavailable');
      if (message.method === 'claude/model') {
        if (!modelName(params.model) || owner.turnId) throw Error('Claude model change unavailable during turn');
        await owner.query.setModel(params.model); return {};
      }
      if (!uuid(params.key) || typeof params.text !== 'string' || !params.text.trim() || params.text.trimStart().startsWith('/') || Buffer.byteLength(params.text) > 1048576)
        throw Error('Claude prompt unavailable');
      const key = `turn-${params.key}`;
      const requestHash = digest(canonicalJson({ nativeId: owner.nativeId, allocationId: owner.allocationId, text: params.text }));
      const existing = await this.ledger.loadOperation(binding.threadId, key);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.allocationId !== binding.allocationId || existing.nativeId !== owner.nativeId)
          throw Error('Claude prompt payload conflict');
        // The original intent can be observed, never enqueued again, including after a lost acknowledgement.
        return { key: params.key, state: existing.state };
      }
      if (owner.turnId) throw Error('Claude previous result requires adoption');
      const record = { version: 1, key, provider: 'claudeAgent', method: 'claude/offer', allocationId: binding.allocationId,
        threadId: binding.threadId, nativeId: owner.nativeId, requestHash, state: 'started' };
      await this.ledger.saveOperation(binding.threadId, record);
      await this.binding(session);
      if (owner.closed) throw Error('Claude prompt outcome unknown');
      owner.turnId = key; owner.turnRecord = record;
      const waiter = owner.waiter; owner.waiter = null;
      const prompt = { type: 'user', uuid: params.key, message: { role: 'user', content: params.text }, parent_tool_use_id: null, session_id: owner.nativeId };
      if (waiter) waiter({ value: prompt, done: false }); else owner.prompts.push(prompt);
      return { key: params.key, state: 'started' };
    });
  }
  async reconcile(session, binding, method, params) {
    if (!uuid(params.key)) throw Error('Invalid Claude receipt');
    return this.ledger.serialized(`query-${binding.threadId}`, async () => {
      binding = await this.binding(session);
      const record = await this.ledger.loadOperation(binding.threadId, `turn-${params.key}`);
      if (!record || record.nativeId !== params.nativeId || record.allocationId !== binding.allocationId ||
        !['result-pending','adopted'].includes(record.state)) throw Error('Claude result requires reconciliation');
      if (method === 'claude/receipt') return { key: params.key, result: record.result, resultHash: record.resultHash };
      if (params.resultHash !== record.resultHash || !Number.isSafeInteger(params.eventSequence) || params.eventSequence < 1)
        throw Error('Claude adoption does not match result');
      if (record.state === 'adopted' && record.adoption.eventSequence !== params.eventSequence) throw Error('Conflicting Claude adoption');
      await this.ledger.saveOperation(binding.threadId, { ...record, state: 'adopted', adoption: { eventSequence: params.eventSequence } });
      // Revocation owns this exact allocation-store lock. Never overwrite a
      // revoked binding with the ready snapshot read before the journal write.
      await this.store.serialized(binding.threadId, async () => {
        const current = await this.binding(session);
        current.claudeHasTurns = true; await this.store.save(current);
      });
      const owner = this.owner;
      if (owner?.nativeId === params.nativeId && owner.turnRecord?.key === record.key) {
        owner.turnId = null;
        if (owner.closed) {
          await owner.closing;
          // closeOwner retains a known-ended owner while its canonical result is
          // unadopted. Only that state can be released by a durable receipt.
          if (this.owner === owner && owner.terminated && !this.credentials.quarantined) await this.releaseOwner(owner);
        } else owner.turnRecord = null;
      }
      return {};
    });
  }
  async open(session, binding, params) {
    identifier(params.key);
    if (!modelName(params.model) || this.owner || this.quarantined) throw Error('Central Claude credential owner busy');
    // Reserve synchronously before any I/O, including for other allocated threads.
    const owner = { session, allocationId: binding.allocationId, threadId: binding.threadId, briqId: binding.briqId,
      nativeId: binding.claudeNativeSessionId, turnId: null, turnRecord: null, closed: false, prompts: [], waiter: null, toolSequence: 0 };
    owner.releaseCredentials = this.credentials.acquire(owner);
    owner.startupDone = new Promise(resolve => { owner.finishStartup = resolve; });
    this.owner = owner;
    let failed = false;
    try {
      if ((await this.ledger.listOperations(binding.threadId)).some(value => !['completed','adopted'].includes(value.state))) throw Error('Claude operation requires reconciliation');
      const key = `open-${params.key}`;
      if (await this.ledger.loadOperation(binding.threadId, key)) throw Error('Claude query open already attempted');
      owner.openRecord = { version: 1, key, provider: 'claudeAgent', method: 'claude/open', allocationId: binding.allocationId,
        threadId: binding.threadId, nativeId: owner.nativeId, state: 'started' };
      await this.ledger.saveOperation(binding.threadId, owner.openRecord);
      if (!this.scopedBriq) throw Error('Scoped Briq tools required');
      const guidance = await readFile(new URL('./skills/briq/SKILL.md', import.meta.url), 'utf8');
      if (!guidance.trim() || Buffer.byteLength(guidance) > 65536) throw Error('Packaged Briq guidance unavailable');
      const sdk = await this.loadSdk();
      if (owner.closed) throw Error('Claude query cancelled during startup');
      const cwd = join(this.directory, 'sessions', owner.nativeId);
      const home = this.nativeHome ?? join(this.directory, 'home');
      await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(home, { recursive: true, mode: 0o700 });
      const server = sdk.createSdkMcpServer({ name: 'workspace', version: '1', tools: [sdk.tool('bash',
        'Execute a shell command in this thread sandbox.', { command: sdk.z.string(), timeout: sdk.z.number().optional(), description: sdk.z.string().optional() }, async input => {
          if (!owner.turnId) throw Error('Claude turn unavailable');
          const result = await this.executor.execute(owner, `${owner.turnId}-tool-${++owner.toolSequence}`, input);
          return { isError: result.state !== 'exited' || result.exitCode !== 0 || result.truncated,
            content: [{ type: 'text', text: JSON.stringify(result) }] };
        })] });
      const briqServer = createScopedClaudeMcpServer(sdk, owner, this.scopedBriq);
      const prompts = { [Symbol.asyncIterator]() { return this; }, next: () => owner.closed ? Promise.resolve({ done: true }) :
        owner.prompts.length ? Promise.resolve({ value: owner.prompts.shift(), done: false }) : new Promise(resolve => { owner.waiter = resolve; }) };
      await this.binding(session);
      if (owner.closed) throw Error('Claude query cancelled during startup');
      owner.query = sdk.query({ prompt: prompts, options: {
        pathToClaudeCodeExecutable: sdk.binary, cwd, model: params.model,
        ...(binding.claudeHasTurns ? { resume: owner.nativeId } : { sessionId: owner.nativeId }),
        env: { HOME: home, CLAUDE_CONFIG_DIR: this.nativeConfigDirectory ?? join(home, '.claude'), PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
          DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        tools: [], disallowedTools: deniedTools, allowedTools: ['mcp__workspace__bash', ...scopedBriqTools.map(tool => `mcp__briq__${tool.name}`)],
        toolAliases: { Bash: 'mcp__workspace__bash' }, mcpServers: { workspace: server, briq: briqServer }, strictMcpConfig: true,
        settingSources: [], skills: [], plugins: [], agents: {}, permissionMode: 'dontAsk',
        settings: { disableAllHooks: true }, managedSettings: { disableAllHooks: true, disableAgentView: true, disableRemoteControl: true },
        systemPrompt: `Use only the workspace MCP shell for repository files, commands and tests. The workspace is remote. Native local tools, delegation and background work are unavailable. Briq MCP tools manage only this allocation’s recorded descendants.\n\n${guidance}`,
        stderr: () => {},
        spawnClaudeCodeProcess: options => {
          if (owner.child) throw Error('Only one Claude process is permitted');
          const child = this.spawnProcess(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe','pipe','pipe'] });
          owner.child = child;
          owner.processExit = new Promise((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', () => reject(Error('Claude process lifetime unknown'))); });
          owner.processExit.catch(() => {});
          return child;
        },
      } });
      owner.pump = this.pump(owner).catch(error => {
        if (error?.code !== 'CLAUDE_DELIVERY_LOST') this.quarantined = true;
        session.close(); void this.closeOwner(owner).catch(() => {});
      });
      return { nativeId: owner.nativeId };
    } catch { failed = true; this.quarantined = true; }
    finally { owner.finishStartup(); }
    if (failed) { await this.closeOwner(owner).catch(() => {}); throw Error('Claude query outcome unknown'); }
  }
  async pump(owner) {
    for await (const event of owner.query) {
      await this.binding(owner.session);
      if (owner.closed || !event || event.session_id !== owner.nativeId || !uuid(event.uuid) ||
        Buffer.byteLength(JSON.stringify(event)) > 1048576 ||
        !['assistant','user','result','stream_event','tool_progress','tool_use_summary','system'].includes(event.type) ||
        (event.type === 'system' && !['init','status','prompt_lifecycle'].includes(event.subtype)) ||
        (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null)) throw Error('Claude event rejected');
      // Native auth/control/delegation messages never cross this bridge. Every turn
      // event is bound to the currently journalled prompt, not a child-provided id.
      const key = owner.turnId?.slice(5) ?? null;
      if (!key && !(event.type === 'system' && ['init','status'].includes(event.subtype))) throw Error('Claude event outside turn');
      let resultHash;
      if (event.type === 'result') {
        if (!owner.turnRecord || owner.turnRecord.state !== 'started' || !event.user_message_uuids?.includes(key) && event.user_message_uuid !== key)
          throw Error('Claude result identity mismatch');
        resultHash = digest(canonicalJson(event));
        owner.turnRecord = { ...owner.turnRecord, state: 'result-pending', result: event, resultHash };
        await this.ledger.saveOperation(owner.threadId, owner.turnRecord);
        // A websocket write is not durable T3 adoption. Keep the turn reserved.
      }
      try { if (await owner.session.send({ method: 'claude/event', params: { nativeId: owner.nativeId,
        threadId: owner.threadId, key, event, ...(resultHash ? { resultHash } : {}) } }) === false) throw Object.assign(Error('Claude event undelivered'), { code: 'CLAUDE_DELIVERY_LOST' }); }
      catch { throw Object.assign(Error('Claude event undelivered'), { code: 'CLAUDE_DELIVERY_LOST' }); }
    }
    if (!owner.closed) throw Error('Claude query ended unexpectedly');
  }
  async closeOwner(owner) {
    if (owner.closing) return owner.closing;
    owner.closed = true; owner.waiter?.({ done: true }); owner.waiter = null;
    // Bound the entire disposal, not just the final process-exit wait. A stuck
    // SDK disposer or remote stop must retain the credential-owner quarantine.
    const dispose = (async () => {
      await owner.startupDone;
      await this.executor.stop(owner);
      owner.query?.close();
      if (owner.query) await owner.query[Symbol.asyncDispose]();
      if (owner.processExit) await owner.processExit;
      owner.terminated = true;
      if (!owner.turnId) await this.releaseOwner(owner);
    })();
    const timeout = new Promise((_, reject) => { owner.exitTimer = setTimeout(() => reject(Error('Claude lifetime unknown')), this.closeTimeoutMs); });
    owner.closing = Promise.race([dispose, timeout]).catch(() => { this.quarantined = true; this.credentials.quarantine(); throw Error('Claude process or execution termination unknown'); })
      .finally(() => clearTimeout(owner.exitTimer));
    return owner.closing;
  }
  async releaseOwner(owner) {
    if (!owner.terminated || owner.turnId || this.credentials.quarantined) throw Error('Claude owner requires reconciliation');
    if (owner.openRecord) { owner.openRecord.state = 'completed'; await this.ledger.saveOperation(owner.threadId, owner.openRecord); }
    owner.turnRecord = null;
    owner.releaseCredentials();
    if (this.owner === owner) this.owner = null;
  }
  async disconnect(session) { if (this.owner?.session === session) await this.closeOwner(this.owner); }
  async close() { if (this.owner) await this.closeOwner(this.owner); }
}
