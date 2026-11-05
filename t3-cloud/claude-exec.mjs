import { canonicalJson, digest, identifier } from './allocations.mjs';

const terminal = new Set(['exited', 'timed_out', 'stopped']);
export class ClaudeRemoteExec {
  constructor({ store, ledger, cloud }) { Object.assign(this, { store, ledger, cloud }); this.active = new Map(); }
  async binding(owner) {
    const binding = await this.store.load(owner.threadId);
    if (owner.closed || binding?.state !== 'ready' || binding.allocationId !== owner.allocationId ||
      binding.briqId !== owner.briqId || binding.claudeNativeSessionId !== owner.nativeId) throw Error('Claude allocation revoked');
    return binding;
  }
  async stop(owner) {
    owner.closed = true;
    const pending = [...this.active.values()].filter(value => value.owner === owner);
    // Launch acknowledgements may arrive after cancellation; each launcher then stops its exact handle.
    await Promise.all(pending.map(async value => {
      if (!value.record.execId) { await value.done; if (!value.terminal) throw Error('Claude execution handle unknown'); return; }
      await this.stopHandle(value);
    }));
    for (const record of await this.ledger.listOperations(owner.threadId)) {
      if (record.method !== 'claude/exec' || record.nativeId !== owner.nativeId || record.state === 'completed' || record.terminalConfirmed) continue;
      if (!record.execId || record.allocationId !== owner.allocationId) throw Error('Claude execution handle unknown');
      await this.stopHandle({ owner, record });
      await this.ledger.saveOperation(owner.threadId, record);
    }
  }
  async stopHandle(value) {
    const result = await this.cloud.execStop(value.owner.briqId, value.record.execId);
    if (result.exec?.id !== value.record.execId || result.exec?.briqId !== value.owner.briqId || !terminal.has(result.exec.state))
      throw Error('Claude execution termination unknown');
    value.terminal = true; value.record.terminalConfirmed = true;
  }
  async execute(owner, key, input) {
    identifier(key);
    if (!input || Object.keys(input).some(name => !['command', 'timeout', 'description'].includes(name)) ||
      typeof input.command !== 'string' || input.command.length < 1 || Buffer.byteLength(input.command) > 65536 ||
      input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 512) ||
      input.timeout !== undefined && (!Number.isInteger(input.timeout) || input.timeout < 1 || input.timeout > 120000)) throw Error('Invalid remote shell request');
    await this.binding(owner);
    const requestHash = digest(canonicalJson({ provider: 'claudeAgent', allocationId: owner.allocationId,
      threadId: owner.threadId, nativeId: owner.nativeId, turnId: owner.turnId, input }));
    return this.ledger.serialized(`exec-${digest(owner.threadId)}`, async () => {
      const previous = await this.ledger.loadOperation(owner.threadId, key);
      if (previous) {
        if (previous.requestHash !== requestHash) throw Error('Claude execution payload conflict');
        if (previous.state === 'completed') { await this.binding(owner); return previous.result; }
        throw Error('Claude execution outcome unknown; no launch replay');
      }
      // An uncertain prior side effect blocks new execution, including after a process restart.
      if ((await this.ledger.listOperations(owner.threadId)).some(value => value.method === 'claude/exec' && value.state !== 'completed'))
        throw Error('Claude execution requires reconciliation');
      await this.binding(owner);
      const record = { version: 1, key, provider: 'claudeAgent', method: 'claude/exec', allocationId: owner.allocationId,
        threadId: owner.threadId, nativeId: owner.nativeId, turnId: owner.turnId, requestHash, state: 'started' };
      await this.ledger.saveOperation(owner.threadId, record);
      let finish;
      const value = { owner, record, done: new Promise(resolve => { finish = resolve; }) };
      this.active.set(`${owner.allocationId}:${key}`, value);
      try {
        // The destination comes only from the authenticated allocation, never tool arguments.
        const launched = await this.cloud.execAsync(owner.briqId, input.command, input.timeout ?? 120000);
        if (typeof launched.exec?.id !== 'string' || launched.exec.briqId !== owner.briqId) throw Error('Claude execution handle unknown');
        identifier(launched.exec.id); record.execId = launched.exec.id;
        await this.ledger.saveOperation(owner.threadId, record);
        if (owner.closed) { await this.stopHandle(value); throw Error('Claude query cancelled'); }
        let result = launched;
        for (let reads = 0; result.exec.state === 'running' && reads < 6; reads++) {
          await this.binding(owner);
          result = await this.cloud.execStatus(owner.briqId, record.execId);
          if (result.exec?.id !== record.execId || result.exec.briqId !== owner.briqId) throw Error('Claude execution identity mismatch');
        }
        if (!terminal.has(result.exec.state)) { await this.stopHandle(value); throw Error('Claude execution outcome unknown'); }
        value.terminal = true;
        await this.binding(owner);
        // Tail/truncation is explicit; never represent partial output or a nonzero exit as success.
        if (!result.exec.output || !Number.isInteger(result.exec.exitCode) && result.exec.state === 'exited') throw Error('Execution output unavailable');
        const stdout = result.exec.output.stdout;
        const stderr = result.exec.output.stderr;
        if (typeof stdout !== 'string' || typeof stderr !== 'string') throw Error('Invalid execution output');
        const output = { state: result.exec.state, exitCode: result.exec.exitCode,
          stdout: stdout.slice(0, 65536), stderr: stderr.slice(0, 65536),
          truncated: Boolean(result.exec.output.stdoutBytes > Buffer.byteLength(stdout) || result.exec.output.stderrBytes > Buffer.byteLength(stderr) || stdout.length > 65536 || stderr.length > 65536) };
        record.state = 'completed'; record.result = output; record.resultHash = digest(canonicalJson(output));
        await this.ledger.saveOperation(owner.threadId, record);
        return output;
      } catch {
        // A known handle stays owned even when status transport or the allocation is revoked.
        if (record.execId && !value.terminal) {
          try { await this.stopHandle(value); } catch { /* Keep terminalConfirmed false and quarantine. */ }
        }
        // A rejected or lost launch response is not evidence that the command did not run.
        record.state = 'unknown'; await this.ledger.saveOperation(owner.threadId, record);
        throw Error('Claude execution quarantined; reconcile exact handle before continuing');
      } finally { this.active.delete(`${owner.allocationId}:${key}`); finish(); }
    });
  }
}
