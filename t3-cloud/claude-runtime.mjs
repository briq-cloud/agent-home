import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { canonicalJson, digest, identifier, providerInstanceId, providerMetadata } from './allocations.mjs';
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
const unknownMetadata = () => ({ models: [], authStatus: 'unknown' });
export function claudeInitializationMetadata(init) {
  const account = init?.account;
  const authenticated = account?.apiProvider === 'firstParty' && typeof account.subscriptionType === 'string' && account.subscriptionType.trim() &&
    typeof account.tokenSource === 'string' && account.tokenSource.trim() && account.tokenSource !== 'none' &&
    (account.apiKeySource === undefined || account.apiKeySource === 'none');
  if (!authenticated || !Array.isArray(init.models) || init.models.length > 256) return unknownMetadata();
  const slugs = [...new Set(init.models.map(row => row?.resolvedModel ?? row?.value).filter(modelName))];
  if (!slugs.length || slugs.length > 256) return unknownMetadata();
  return providerMetadata({ models: slugs.map(slug => ({ slug })), authStatus: 'authenticated' });
}
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
      const turnId = owner.turnId, openRecord = owner.openRecord, turnRecord = owner.turnRecord;
      const identity = Object.freeze({ providerInstanceId: 'claudeAgent', threadId: owner.threadId, allocationId: owner.allocationId,
        nativeId: owner.nativeId, turnId, validate: () => {
          if (owner.closed || owner.session?.closed || owner.openRecord !== openRecord || owner.turnRecord !== turnRecord ||
              owner.turnId !== turnId || turnRecord?.state !== 'started') throw Error('Claude turn unavailable');
        } });
      identity.validate();
      const requestId = digest(canonicalJson([turnId, providerRequestId(extra?.requestId)]));
      const result = await scopedBriq.call(identity, requestId, tool.name, input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch { return { isError: true, content: [{ type: 'text', text: 'Briq operation unavailable; reconcile pending operations before retrying.' }] }; }
  });
  return server;
}
export class ClaudeRuntime {
  constructor({ store, ledger, cloud, scopedBriq, directory, enabled = CLAUDE_CLOUD_ENABLED, loadSdk = loadNativeSdk, spawnProcess = spawn, closeTimeoutMs = 10000, credentials = new ClaudeCredentialOwner(), nativeHome, nativeConfigDirectory, capabilityMetadata }) {
    Object.assign(this, { store, ledger, scopedBriq, directory, enabled, loadSdk, spawnProcess, closeTimeoutMs, credentials, nativeHome, nativeConfigDirectory, capabilityMetadata });
    this.executor = new ClaudeRemoteExec({ store, ledger, cloud }); this.owner = null; this.quarantined = false;
  }
  async binding(session) {
    const value = await this.store.load(session.threadId);
    if (session.closed || value?.state !== 'ready' || value.allocationId !== session.allocationId || !value.briqId || providerInstanceId(value.providerInstanceId) !== 'claudeAgent' ||
      session.providerInstanceId !== undefined && session.providerInstanceId !== 'claudeAgent')
      throw Error('Claude allocation revoked');
    return value;
  }
  nativeEnvironment(home) {
    return { HOME: home, CLAUDE_CONFIG_DIR: this.nativeConfigDirectory ?? join(home, '.claude'), PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_CODE_AUTO_CONNECT_IDE: '0', CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1' };
  }
  spawnOwned(owner, options) {
    if (owner.closed || owner.spawnAttempted) throw Error('Only one active Claude process is permitted');
    owner.spawnAttempted = true;
    const child = this.spawnProcess(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe','pipe','pipe'] });
    owner.child = child;
    owner.processExit = new Promise(resolve => {
      const exited = () => { owner.processTerminated = true; resolve(); };
      child.once('exit', exited); child.once('close', exited);
      child.on('error', () => {}); // Only an actual exit/close settles lifetime.
    });
    return child;
  }
  async bounded(operation, timeoutMs, message) {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async disposeNative(owner) {
    owner.closed = true; owner.waiter?.({ done: true }); owner.waiter = null; owner.abort?.abort();
    let closeError;
    try { owner.query?.close(); } catch (error) { closeError = error; }
    if (owner.child && !owner.processTerminated) owner.child.kill('SIGTERM');
    await Promise.all([owner.query ? owner.query[Symbol.asyncDispose]() : undefined, owner.processExit]);
    if (closeError || owner.spawnAttempted && !owner.child) throw Error('Claude process lifetime unknown');
  }
  async capabilities(session) {
    if (!this.enabled) throw Error('Claude cloud execution is unavailable');
    const binding = await this.binding(session);
    let metadata;
    if (this.quarantined || this.credentials.quarantined) metadata = unknownMetadata();
    else if (this.capabilityMetadata) {
      try { metadata = providerMetadata(await this.capabilityMetadata(binding)); } catch { metadata = unknownMetadata(); }
    }
    else if (this.owner) metadata = !this.owner.closed && this.owner.metadata ? this.owner.metadata : unknownMetadata();
    else {
      if (!this.metadataPromise) {
        const owner = { session, allocationId: binding.allocationId, threadId: binding.threadId, closed: false, abort: new AbortController() };
        try { owner.releaseCredentials = this.credentials.acquire(owner); }
        catch { return unknownMetadata(); }
        this.metadataOwner = owner;
        this.metadataPromise = this.probeMetadata(owner).finally(() => { this.metadataPromise = null; this.metadataOwner = null; });
      }
      metadata = await this.metadataPromise;
    }
    await this.binding(session);
    return providerMetadata(metadata);
  }
  async probeMetadata(owner) {
    let metadata = unknownMetadata();
    const probe = (async () => {
      const sdk = await this.loadSdk();
      const home = this.nativeHome ?? join(this.directory, 'home'); const cwd = join(this.directory, 'metadata');
      await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(cwd, { recursive: true, mode: 0o700 });
      if (owner.closed) throw Error('Metadata cancelled');
      const prompt = { [Symbol.asyncIterator]() { return this; }, next: () => owner.closed ? Promise.resolve({ done: true }) : new Promise(resolve => { owner.waiter = resolve; }) };
      owner.query = sdk.query({ prompt, options: { pathToClaudeCodeExecutable: sdk.binary, cwd, persistSession: false, abortController: owner.abort,
        env: this.nativeEnvironment(home), tools: [], allowedTools: [], disallowedTools: deniedTools, mcpServers: {}, strictMcpConfig: true,
        settingSources: [], skills: [], plugins: [], agents: {}, permissionMode: 'dontAsk', settings: { disableAllHooks: true },
        managedSettings: { disableAllHooks: true, disableAgentView: true, disableRemoteControl: true }, stderr: () => {},
        spawnClaudeCodeProcess: options => this.spawnOwned(owner, options) } });
      const init = await owner.query.initializationResult();
      if (owner.closed || !owner.child) throw Error('Metadata process unavailable');
      metadata = claudeInitializationMetadata(init);
    })();
    try { await this.bounded(probe, this.closeTimeoutMs, 'Claude metadata unavailable'); }
    catch { metadata = unknownMetadata(); }
    owner.closed = true; owner.waiter?.({ done: true }); owner.waiter = null;
    try {
      // A delayed loader is prevented from spawning by owner.closed. If a Query
      // already exists, dispose it and prove that exact captured child ended.
      await this.bounded(this.disposeNative(owner), this.closeTimeoutMs, 'Claude metadata lifetime unknown');
      owner.releaseCredentials();
    } catch { this.quarantined = true; this.credentials.quarantine(); metadata = unknownMetadata(); }
    return metadata;
  }
  async requireMetadata(session, model) {
    const metadata = await this.capabilities(session);
    if (metadata.authStatus !== 'authenticated' || !metadata.models.length) throw Error('Claude authentication unavailable');
    if (model !== undefined && !metadata.models.some(row => row.slug === model)) throw Error('Claude model is not admitted');
    return metadata;
  }
  async receive(session, message) {
    if (!this.enabled || this.quarantined && !['claude/allocate','claude/pending','claude/receipt','claude/adopt','claude/interrupt','claude/close'].includes(message.method) || !methods.has(message.method) || !['number','string'].includes(typeof message.id)) throw Error('Claude cloud execution is unavailable');
    const params = message.params ?? {};
    if (!params || Array.isArray(params) || typeof params !== 'object' || Object.keys(params).some(key => !fields[message.method].includes(key))) throw Error('Invalid Claude request');
    let binding = await this.binding(session);
    if (message.method === 'claude/allocate') {
      if (binding.claudeNativeSessionId) return { nativeId: binding.claudeNativeSessionId };
      await this.requireMetadata(session);
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
    if (message.method === 'claude/open') { await this.requireMetadata(session, params.model); return this.open(session, binding, params); }
    const owner = this.owner;
    if (!owner || owner.session !== session || owner.nativeId !== params.nativeId) throw Error('Claude session unavailable');
    if (message.method === 'claude/interrupt' || message.method === 'claude/close') {
      await this.closeOwner(owner); return {};
    }
    if (owner.closed) throw Error('Claude session unavailable');
    // Cancellation stays outside this lock. Concurrent offers and model changes may not
    // pass the idle check together while the first request is writing its journal.
    return this.ledger.serialized(`query-${owner.threadId}`, async () => {
      await this.binding(session);
      await this.requireMetadata(session, message.method === 'claude/model' ? params.model : owner.model);
      if (owner.closed || this.owner !== owner) throw Error('Claude session unavailable');
      if (message.method === 'claude/model') {
        if (!modelName(params.model) || owner.turnId) throw Error('Claude model change unavailable during turn');
        await owner.query.setModel(params.model); owner.model = params.model; return {};
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
    if (!modelName(params.model) || this.owner || this.metadataOwner || this.quarantined) throw Error('Central Claude credential owner busy');
    // Reserve synchronously before any I/O, including for other allocated threads.
    const owner = { session, allocationId: binding.allocationId, threadId: binding.threadId, briqId: binding.briqId,
      providerInstanceId: 'claudeAgent', nativeId: binding.claudeNativeSessionId, model: params.model, turnId: null, turnRecord: null, closed: false, prompts: [], waiter: null, toolSequence: 0 };
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
        env: this.nativeEnvironment(home),
        tools: [], disallowedTools: deniedTools, allowedTools: ['mcp__workspace__bash', ...scopedBriqTools.map(tool => `mcp__briq__${tool.name}`)],
        toolAliases: { Bash: 'mcp__workspace__bash' }, mcpServers: { workspace: server, briq: briqServer }, strictMcpConfig: true,
        settingSources: [], skills: [], plugins: [], agents: {}, permissionMode: 'dontAsk',
        settings: { disableAllHooks: true }, managedSettings: { disableAllHooks: true, disableAgentView: true, disableRemoteControl: true },
        systemPrompt: `Use only the workspace MCP shell for repository files, commands and tests. The workspace is remote. Native local tools, delegation and background work are unavailable. Briq MCP tools manage only this allocation’s recorded descendants.\n\n${guidance}`,
        stderr: () => {},
        spawnClaudeCodeProcess: options => this.spawnOwned(owner, options),
      } });
      owner.metadata = this.capabilityMetadata ? providerMetadata(await this.capabilityMetadata(binding)) :
        claudeInitializationMetadata(await this.bounded(owner.query.initializationResult(), this.closeTimeoutMs, 'Claude initialization unavailable'));
      if (owner.closed || owner.metadata.authStatus !== 'authenticated' || !owner.metadata.models.some(row => row.slug === params.model)) throw Error('Claude model/authentication unavailable');
      await this.binding(session);
      owner.pump = this.pump(owner).catch(async error => {
        if (!owner.revoked && error?.code !== 'CLAUDE_DELIVERY_LOST') {
          try {
            const current = await this.store.load(owner.threadId);
            if (current?.state === 'revoked' && current.allocationId === owner.allocationId) owner.revoked = true;
            else this.quarantined = true;
          } catch { this.quarantined = true; }
        }
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
      const results = await Promise.allSettled([this.executor.stop(owner), this.disposeNative(owner)]);
      if (results.some(result => result.status === 'rejected')) throw Error('Claude termination unknown');
      owner.terminated = true;
      if (!owner.turnId || owner.revoked) await this.releaseOwner(owner);
    })();
    const timeout = new Promise((_, reject) => { owner.exitTimer = setTimeout(() => reject(Error('Claude lifetime unknown')), this.closeTimeoutMs); });
    owner.closing = Promise.race([dispose, timeout]).catch(() => { this.quarantined = true; this.credentials.quarantine(); throw Error('Claude process or execution termination unknown'); })
      .finally(() => clearTimeout(owner.exitTimer));
    return owner.closing;
  }
  async releaseOwner(owner) {
    if (!owner.terminated || (owner.turnId && !owner.revoked) || this.credentials.quarantined) throw Error('Claude owner requires reconciliation');
    if (owner.revoked && owner.turnId) {
      const record = await this.ledger.loadOperation(owner.threadId, owner.turnId);
      if (!record || record.nativeId !== owner.nativeId || record.allocationId !== owner.allocationId || record.threadId !== owner.threadId || record.method !== 'claude/offer') throw Error('Revoked turn requires reconciliation');
      // Termination is not adoption or proof of a prompt's result. Keep the exact
      // started/result-pending record, with a separate terminal owner disposition.
      record.ownerDisposition = 'revoked-terminated';
      await this.ledger.saveOperation(owner.threadId, record);
    }
    if (owner.openRecord) {
      owner.openRecord.state = 'completed';
      if (owner.revoked) owner.openRecord.ownerDisposition = 'revoked-terminated';
      await this.ledger.saveOperation(owner.threadId, owner.openRecord);
    }
    owner.turnRecord = null;
    owner.releaseCredentials();
    if (this.owner === owner) this.owner = null;
  }
  async disconnect(session) {
    if (this.metadataOwner?.session === session) {
      this.metadataOwner.closed = true; this.metadataOwner.waiter?.({ done: true }); this.metadataOwner.abort?.abort();
      await this.metadataPromise;
    }
    if (this.owner?.session === session) await this.closeOwner(this.owner);
  }
  quarantineRevocation(binding) {
    if (binding.state !== 'revoked' || providerInstanceId(binding.providerInstanceId) !== 'claudeAgent') throw Error('Invalid native cleanup identity');
    // Durable uncertainty survives restart. No process/control request is replayed.
    this.quarantined = true; this.credentials.quarantine();
  }
  async revoke(binding) {
    const owner = this.owner; const metadataOwner = this.metadataOwner;
    const operations = [];
    if (owner?.allocationId === binding.allocationId && owner.threadId === binding.threadId) {
      owner.revoked = true;
      operations.push((async () => {
        await this.closeOwner(owner);
        // A normal close may already have completed while awaiting adoption.
        if (this.owner === owner) await this.releaseOwner(owner);
      })());
    }
    if (metadataOwner?.allocationId === binding.allocationId && metadataOwner.threadId === binding.threadId) {
      metadataOwner.closed = true; metadataOwner.waiter?.({ done: true }); metadataOwner.waiter = null; metadataOwner.abort?.abort();
      operations.push(this.metadataPromise);
    }
    const results = await Promise.allSettled(operations);
    if (!operations.length && (await this.ledger.listOperations(binding.threadId)).some(record =>
      record.method === 'claude/open' && record.allocationId === binding.allocationId && record.state !== 'completed')) {
      this.quarantined = true; this.credentials.quarantine();
      throw Error('Claude revocation lifetime unknown');
    }
    const retained = this.credentials.current;
    const exactRetained = retained?.allocationId === binding.allocationId && retained.threadId === binding.threadId;
    if (results.some(result => result.status === 'rejected') || this.credentials.quarantined && (operations.length || exactRetained)) throw Error('Claude revocation lifetime unknown');
  }
  async close() {
    if (this.metadataOwner) { this.metadataOwner.closed = true; this.metadataOwner.waiter?.({ done: true }); this.metadataOwner.abort?.abort(); }
    await this.metadataPromise;
    if (this.owner) await this.closeOwner(this.owner);
    if (this.credentials.quarantined) throw Error('Claude process lifetime requires reconciliation');
  }
}
