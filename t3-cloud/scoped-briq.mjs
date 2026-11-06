import { randomUUID } from 'node:crypto';
import { canonicalJson, digest, identifier, providerInstanceId } from './allocations.mjs';

const string = { type: 'string', minLength: 1, maxLength: 65536 };
const id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' };
const object = properties => ({ type: 'object', properties, additionalProperties: false });
const required = (properties, names) => ({ ...object(properties), required: names });
export const scopedBriqTools = [
  ['briq_catalog', object({ recipe: { enum: ['sandbox', 'postgres', 'redis'] } })],
  ['briq_docs', object({})], ['briq_list', object({})],
  ['briq_run', required({ recipe: { enum: ['sandbox', 'postgres', 'redis'] }, env: { type: 'object', additionalProperties: string } }, ['recipe'])],
  ...['status', 'logs', 'start', 'stop', 'destroy'].map(name => [`briq_${name}`, required({ id }, ['id'])]),
  ['briq_exec', required({ id, command: string, timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 } }, ['id', 'command'])],
  ...['result', 'stop'].map(name => [`briq_exec_${name}`, required({ id, execId: id }, ['id', 'execId'])]),
  ['briq_files_put', required({ id, path: string, content: string }, ['id', 'path', 'content'])],
  ['briq_files_get', required({ id, path: string }, ['id', 'path'])],
].map(([name, inputSchema]) => ({ name, inputSchema, ...(name === 'briq_catalog' ? { annotations: { readOnlyHint: true } } : {}), description: `${name}: allocation-owned resources only. Workspace files and shell use the workspace tool.` }));
const schemas = new Map(scopedBriqTools.map(tool => [tool.name, tool.inputSchema]));
const mutations = new Set(['briq_run', 'briq_exec', 'briq_exec_stop', 'briq_files_put', 'briq_start', 'briq_stop', 'briq_destroy']);
const terminalExec = new Set(['exited', 'timed_out', 'stopped']);
function validate(schema, value) {
  if (schema.enum && !schema.enum.includes(value)) throw Error('Unsupported scoped Briq input');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 32) throw Error('Invalid scoped Briq input');
    for (const key of schema.required ?? []) if (!(key in value)) throw Error('Missing scoped Briq input');
    for (const [key, entry] of Object.entries(value)) {
      const field = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : schema.additionalProperties;
      if (!field || typeof field !== 'object') throw Error('Unsupported scoped Briq input');
      validate(field, entry);
    }
  }
  if (schema.type === 'string' && (typeof value !== 'string' || value.includes('\0') || value.length < (schema.minLength ?? 0) || Buffer.byteLength(value) > (schema.maxLength ?? 128) || schema.pattern && !new RegExp(schema.pattern).test(value))) throw Error('Invalid scoped Briq string');
  if (schema.type === 'integer' && (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum)) throw Error('Invalid scoped Briq number');
}
function project(briq) {
  return Object.fromEntries(['id', 'name', 'state', 'image', 'size', 'internalHost', 'ports'].filter(key => briq[key] !== undefined).map(key => [key, briq[key]]));
}
function projectExec(exec) {
  if (!exec || !['running', 'exited', 'timed_out', 'stopped'].includes(exec.state)) throw Error('Unknown exec outcome');
  return { id: exec.id, briqId: exec.briqId, state: exec.state, exitCode: exec.exitCode ?? null,
    ...(exec.output ? { output: { stdout: String(exec.output.stdout ?? '').slice(0, 65536), stderr: String(exec.output.stderr ?? '').slice(0, 65536),
      truncated: Boolean(exec.output.stdoutBytes > 65536 || exec.output.stderrBytes > 65536 || String(exec.output.stdout ?? '').length > 65536 || String(exec.output.stderr ?? '').length > 65536) } } : {}) };
}
function resourceMatch(row, record) {
  if (!row || row.id !== record.id || row.name !== record.name || row.stackId !== record.stackId) throw Error('Scoped Briq identity mismatch');
  return row;
}

// All authorization, admission and revocation use the allocation store's existing lock.
// Started/unknown operations survive restarts and block further mutations; no retry creates ownership.
export class ScopedBriq {
  constructor({ store, cloud }) { Object.assign(this, { store, cloud }); }
  async binding(identity) {
    const binding = await this.store.load(identity.threadId);
    identity.validate?.();
    const provider = providerInstanceId(identity.providerInstanceId);
    if (typeof identity.validate !== 'function' || !['codex', 'claudeAgent'].includes(identity.providerInstanceId) || !identity.turnId || providerInstanceId(binding?.providerInstanceId) !== provider || identity.closed || binding?.state !== 'ready' || binding.allocationId !== identity.allocationId ||
      !identity.nativeId || (provider === 'codex' ? binding.claudeNativeSessionId || binding.nativeThreadId !== identity.nativeId : binding.nativeThreadId || binding.claudeNativeSessionId !== identity.nativeId)) throw Error('Scoped Briq allocation unavailable');
    return binding;
  }
  async records(binding) {
    return (await this.store.listOperations(binding.threadId)).filter(row => row.method === 'briq/scoped' && row.allocationId === binding.allocationId);
  }
  async call(identity, requestId, name, input = {}) {
    // Immutable per-request snapshot supplied by the authenticated native owner.
    identity.validate?.();
    const schema = schemas.get(name);
    if (!schema || !['string', 'number'].includes(typeof requestId) || String(requestId).length > 128) throw Error('Unknown scoped Briq request');
    validate(schema, input);
    if (input.path !== undefined && (!input.path.startsWith('/') || input.path.startsWith('//') || input.path.split('/').includes('..'))) throw Error('Invalid remote file path');
    if (input.env) for (const [key, value] of Object.entries(input.env)) {
      if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || /\$|\{\{|\}\}/.test(value)) throw Error('Only literal environment values are supported');
    }
    return this.store.serialized(identity.threadId, async () => {
      const binding = await this.binding(identity);
      const rows = await this.records(binding);
      identity.validate();
      const key = `briq-${digest(canonicalJson([identity.providerInstanceId, identity.allocationId, identity.nativeId, identity.turnId, requestId]))}`;
      const requestHash = digest(canonicalJson({ name, input, providerInstanceId: identity.providerInstanceId, nativeId: identity.nativeId, turnId: identity.turnId, allocationId: binding.allocationId }));
      const prior = rows.find(row => row.key === key);
      if (prior) {
        if (prior.requestHash !== requestHash) throw Error('Scoped Briq request conflict');
        if (prior.state !== 'completed') throw Error('Scoped Briq outcome unknown; reconciliation required');
        return prior.result;
      }
      const mutation = mutations.has(name);
      if (mutation && rows.some(row => row.state !== 'completed')) throw Error('Scoped Briq mutation requires reconciliation');
      let resource;
      if (input.id) {
        if (input.id === binding.briqId) throw Error('Workspace resource is protected; use workspace tools');
        resource = rows.find(row => row.state === 'completed' && row.resource?.id === input.id && (row.resource.state !== 'destroyed' || name === 'briq_status'))?.resource;
        if (!resource) throw Error('Resource is outside this allocation');
      }
      const record = { version: 1, method: 'briq/scoped', key, allocationId: binding.allocationId,
        threadId: binding.threadId, providerInstanceId: identity.providerInstanceId, nativeId: identity.nativeId, turnId: identity.turnId, requestId, requestHash, state: 'started', tool: name };
      if (name === 'briq_run') {
        const nonce = randomUUID().replaceAll('-', '');
        if (!/^t3-[a-f0-9]{24}$/.test(binding.stack) || !binding.rootStackId) throw Error('Allocation namespace requires reconciliation');
        identifier(binding.rootStackId);
        record.intent = { stack: binding.stack, stackId: binding.rootStackId, name: `r-${nonce.slice(0, 16)}`, recipe: input.recipe };
      }
      if (name === 'briq_destroy') record.destroy = { resourceId: resource.id, sourceKey: rows.find(row => row.resource === resource).key, state: 'started' };
      identity.validate();
      if (mutation) await this.store.saveOperation(binding.threadId, record);
      try {
        identity.validate();
        const result = await this.perform(binding, rows, resource, record, name, input, identity.validate);
        if (mutation) { record.state = 'completed'; record.result = result; await this.store.saveOperation(binding.threadId, record); }
        return result;
      } catch {
        if (mutation) { record.state = 'unknown'; await this.store.saveOperation(binding.threadId, record); }
        throw Error('Scoped Briq operation unavailable; uncertain mutations require reconciliation');
      }
    });
  }
  async perform(binding, rows, resource, record, name, input, validate) {
    // Status and receipt persistence can yield while the native turn closes.
    // Recheck the captured lease synchronously at every actual cloud dispatch.
    const run = (args, options) => {
      validate();
      return this.cloud.run(args, { ...options, env: this.cloud.env }, validate);
    };
    if (name === 'briq_docs') return { text: 'Use briq_catalog for sandbox, postgres and redis. briq_run creates recorded descendants. Only their returned IDs work with status/logs/exec/files/start/stop/destroy. Use workspace tools for the protected thread workspace. Uncertain mutations require operator reconciliation; never repeat a create.' };
    if (name === 'briq_catalog') {
      // Project a fixed recipe set; never advertise unrestricted cloud administration.
      const result = await run(['catalog', ...(input.recipe ? [input.recipe] : [])]);
      const recipes = input.recipe ? [result] : result;
      if (!Array.isArray(recipes)) throw Error('Invalid catalog');
      return { recipes: recipes.filter(row => ['sandbox', 'postgres', 'redis'].includes(row.name)).map(row => ({ name: row.name, description: row.description })) };
    }
    if (name === 'briq_run') {
      const args = ['run', input.recipe, '--name', record.intent.name, '--stack', record.intent.stack, '--no-wait'];
      if (input.env && Object.keys(input.env).length) args.push('--env', ...Object.entries(input.env).map(([key, value]) => `${key}=${value}`));
      const response = await run(args);
      const row = response.briqs?.[0];
      if (response.briqs?.length !== 1 || row?.name !== record.intent.name || row.id === binding.briqId || row.stackId !== record.intent.stackId) throw Error('Invalid create result');
      identifier(row.id); identifier(row.stackId);
      // The create receipt AND an authoritative lookup under the generated stack must agree.
      record.resource = { id: row.id, name: row.name, stackId: row.stackId, state: 'unverified' };
      await this.store.saveOperation(binding.threadId, record);
      const listed = await run(['list', '--stack', record.intent.stack]);
      if (!Array.isArray(listed.briqs)) throw Error('Invalid stack result');
      const exact = listed.briqs.filter(value => value.id === row.id || value.name === record.intent.name);
      if (exact.length !== 1) throw Error('Ambiguous create result');
      resourceMatch(exact[0], record.resource);
      record.resource.state = 'live';
      await this.store.saveOperation(binding.threadId, record);
      // Recipe outputs can contain generated credentials. Keep them available only in this tool receipt.
      const outputs = response.outputs ?? {};
      if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs) || Object.keys(outputs).length > 32 || Object.entries(outputs).some(([key, value]) => !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || Buffer.byteLength(value) > 16384)) throw Error('Invalid recipe outputs');
      return { briqs: [project(row)], outputs };
    }
    if (name === 'briq_list') {
      const briqs = [];
      for (const row of rows.filter(row => row.resource?.state === 'live' && row.state === 'completed')) {
        const response = await run(['status', row.resource.id]);
        briqs.push(project(resourceMatch(response.briq, row.resource)));
      }
      return { briqs };
    }
    const response = await run(['status', resource.id]);
    resourceMatch(response.briq, resource);
    if (name === 'briq_status') {
      if (response.briq.state === 'destroyed') await this.reconcileDestroyed(binding, rows, resource, response.briq);
      return { briq: project(response.briq) };
    }
    if (name === 'briq_logs') {
      const result = await run(['logs', resource.id, '--limit', '100']);
      if (!Array.isArray(result.lines)) throw Error('Invalid logs');
      return { lines: result.lines.slice(0, 100).map(row => ({ ts: row.ts, line: String(row.line).slice(0, 4096) })) };
    }
    if (name === 'briq_exec') {
      const result = await run(['exec', '--async', '--clear-env', '--timeout', String(input.timeoutMs ?? 120000), resource.id, '--', '/bin/sh', '-c', input.command]);
      identifier(result.exec?.id);
      if (result.exec.briqId !== resource.id) throw Error('Invalid exec identity');
      projectExec(result.exec);
      record.exec = { id: result.exec.id, briqId: resource.id };
      await this.store.saveOperation(binding.threadId, record);
      return { exec: projectExec(result.exec) };
    }
    if (name === 'briq_exec_result' || name === 'briq_exec_stop') {
      const launch = rows.find(row => row.exec?.id === input.execId && row.exec.briqId === resource.id);
      if (!launch) throw Error('Unknown scoped exec');
      const result = await run([name === 'briq_exec_result' ? 'exec-result' : 'exec-stop', resource.id, input.execId], { execResult: true });
      if (result.exec?.id !== input.execId || result.exec.briqId !== resource.id || !['running', ...terminalExec].includes(result.exec.state) || name === 'briq_exec_stop' && !terminalExec.has(result.exec.state)) {
        launch.state = 'unknown'; await this.store.saveOperation(binding.threadId, launch);
        throw Error('Invalid exec result');
      }
      if (terminalExec.has(result.exec.state)) { launch.exec.terminal = true; await this.store.saveOperation(binding.threadId, launch); }
      return { exec: projectExec(result.exec) };
    }
    if (name === 'briq_files_put' || name === 'briq_files_get') {
      const result = await run([name === 'briq_files_put' ? 'files-put' : 'files-get', resource.id, input.path], name === 'briq_files_put' ? { stdin: input.content } : {});
      if (result.path !== input.path) throw Error('Invalid file response');
      if (name === 'briq_files_get') {
        if (typeof result.contentBase64 !== 'string' || result.contentBase64.length > 1048576 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.contentBase64)) throw Error('Invalid file content');
        return { path: result.path, contentBase64: result.contentBase64 };
      }
      if (!Number.isInteger(result.bytes) || result.bytes !== Buffer.byteLength(input.content)) throw Error('Invalid file receipt');
      return { path: result.path, bytes: result.bytes, sha256: result.sha256, verified: result.verified === true };
    }
    const action = name.slice(5);
    const result = await run([action, resource.id]);
    resourceMatch(result.briq, resource);
    if (action === 'destroy') {
      if (result.briq.state !== 'destroyed') {
        record.destroy.state = 'pending';
        throw Error('Destroy outcome requires read-only reconciliation');
      }
      await this.reconcileDestroyed(binding, [...rows, record], resource, result.briq);
    }
    return { briq: project(result.briq) };
  }
  async reconcileDestroyed(binding, rows, resource, receipt) {
    resourceMatch(receipt, resource);
    if (receipt.state !== 'destroyed') throw Error('Destroy is not terminal');
    const source = rows.find(row => row.resource?.id === resource.id);
    if (!source) throw Error('Unknown destroy ownership');
    const pending = rows.filter(row => row.destroy?.resourceId === resource.id && row.state !== 'completed');
    const before = structuredClone(source), previous = pending.map(row => structuredClone(row));
    try {
      const candidate = structuredClone(source);
      candidate.resource.state = 'destroyed';
      if (candidate.cleanup?.action === 'destroy') candidate.cleanup.state = 'completed';
      await this.store.saveOperation(binding.threadId, candidate);
      Object.assign(source, candidate);
      for (const operation of pending) {
        const completed = { ...structuredClone(operation), state: 'completed', destroy: { ...operation.destroy, state: 'completed' }, result: { briq: project(receipt) } };
        await this.store.saveOperation(binding.threadId, completed);
        Object.assign(operation, completed);
      }
    } catch {
      const unknown = { ...before, cleanup: { action: 'destroy', state: 'unknown' } };
      Object.assign(source, unknown);
      try { await this.store.saveOperation(binding.threadId, unknown); } catch { /* Keep earlier durable exact intent. */ }
      for (let index = 0; index < pending.length; index++) {
        const uncertain = { ...previous[index], state: 'unknown', destroy: { ...previous[index].destroy, state: 'unknown' } };
        Object.assign(pending[index], uncertain);
        try { await this.store.saveOperation(binding.threadId, uncertain); } catch { /* Keep earlier durable exact intent. */ }
      }
      throw Error('Destroy receipt requires reconciliation');
    }
  }
  async reconcileCleanup(binding) {
    // Called under the allocation lock. Only exact pending destroy receipts may settle;
    // this path never initiates a cleanup mutation or adopts an unrecorded resource.
    const rows = await this.records(binding), failures = [];
    const pendingDestroy = new Set(rows.filter(row => row.destroy && row.state !== 'completed').map(row => row.destroy.resourceId));
    for (const row of rows.filter(row => row.resource && (pendingDestroy.has(row.resource.id) || row.cleanup?.action === 'destroy' && row.cleanup.state !== 'completed'))) {
      try {
        if (row.resource.id === binding.briqId) throw Error('Protected workspace reconciliation rejected');
        const status = await this.cloud.run(['status', row.resource.id], { env: this.cloud.env });
        resourceMatch(status.briq, row.resource);
        await this.reconcileDestroyed(binding, rows, row.resource, status.briq);
      } catch { failures.push(Error('Previous scoped destroy requires reconciliation')); }
    }
    if (failures.length) throw new AggregateError(failures, 'Scoped Briq destroy requires reconciliation');
  }
  async cleanup(binding) {
    // Called under the allocation lock after state=revoked is durable. Never touch the root.
    const failures = [];
    try { await this.reconcileCleanup(binding); } catch { failures.push(Error('Previous scoped cleanup requires reconciliation')); }
    const rows = await this.records(binding);
    const pendingDestroy = new Set(rows.filter(row => row.destroy && row.state !== 'completed').map(row => row.destroy.resourceId));
    const unresolved = new Set(rows.filter(row => row.cleanup && row.cleanup.state !== 'completed' || row.resource && pendingDestroy.has(row.resource.id)));
    for (const row of unresolved) failures.push(Error('Previous scoped cleanup requires reconciliation'));
    const attempt = async (row, action, operation) => {
      const before = structuredClone(row);
      const candidate = { ...structuredClone(row), cleanup: { action, state: 'started' } };
      try {
        await this.store.saveOperation(binding.threadId, candidate);
        await operation(candidate);
        candidate.cleanup.state = 'completed'; await this.store.saveOperation(binding.threadId, candidate);
        Object.assign(row, candidate);
      } catch {
        const unknown = { ...before, cleanup: { action, state: 'unknown' } };
        Object.assign(row, unknown);
        try { await this.store.saveOperation(binding.threadId, unknown); } catch { /* Retain previous durable intent; continue other exact handles. */ }
        failures.push(Error(`Scoped ${action} cleanup requires reconciliation`));
      }
    };
    for (const row of rows.filter(row => row.exec && !row.exec.terminal && !unresolved.has(row))) {
      await attempt(row, 'exec-stop', async candidate => {
        const result = await this.cloud.run(['exec-stop', row.exec.briqId, row.exec.id], { env: this.cloud.env, execResult: true });
        if (result.exec?.id !== row.exec.id || result.exec.briqId !== row.exec.briqId || !terminalExec.has(result.exec.state)) throw Error('Invalid cleanup receipt');
        candidate.exec.terminal = true;
      });
    }
    for (const row of rows.filter(row => row.resource?.state === 'live' && !unresolved.has(row))) {
      await attempt(row, 'destroy', async candidate => {
        if (row.resource.id === binding.briqId) throw Error('Protected workspace cleanup rejected');
        const status = await this.cloud.run(['status', row.resource.id], { env: this.cloud.env });
        resourceMatch(status.briq, row.resource);
        if (status.briq.state === 'destroyed') { candidate.resource.state = 'destroyed'; return; }
        const result = await this.cloud.run(['destroy', row.resource.id], { env: this.cloud.env });
        resourceMatch(result.briq, row.resource);
        if (result.briq.state !== 'destroyed') throw Error('Destroy is not terminal');
        candidate.resource.state = 'destroyed';
      });
    }
    if (rows.some(row => row.state !== 'completed')) failures.push(Error('Scoped Briq unknown outcome requires reconciliation'));
    if (failures.length) throw new AggregateError(failures, 'Scoped Briq cleanup requires reconciliation');
  }
}
