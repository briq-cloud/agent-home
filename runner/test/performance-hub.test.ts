import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Hub, type Peer } from '../src/acp/hub.ts';

test('Hub measures existing ACP turns, retains metadata on restart and releases inflight on error/cancel', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'performance-hub-'));
  let now = Date.now();
  const options = { clis: [{ name: 'mock', acp: [process.execPath, fileURLToPath(new URL('./mock-agent.ts', import.meta.url))] }], cwd: dir, stateDir: dir,
    env: { PATH: process.env.PATH ?? '' }, maxTurns: 1, now: () => now };
  let hub = new Hub(options);
  t.after(async () => { await hub.remove('mock'); rmSync(dir, { recursive: true, force: true }); });
  let entered!: () => void, released!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { released = resolve; });
  const peer: Peer = { send: message => { if (message.method === 'session/update') now += 10; }, ask: async (_method, params) => {
    entered(); await gate; return { jsonrpc: '2.0', id: 1, result: { outcome: { outcome: 'selected', optionId: 'deny' } } };
  } };
  const created = await hub.newSession('mock', { cwd: dir, mcpServers: [] }, peer) as { sessionId: string };
  const prompt = (text: string) => hub.prompt('mock', { sessionId: created.sessionId, prompt: [{ type: 'text', text }] }, peer, { taskId: 'metadata-task', taskCategory: 'change', model: 'configured-exact' });
  await prompt('hello');
  assert.equal(hub.observations.report().recent[0]!.tokens.output, 10);
  assert.equal(hub.observations.report().recent[0]!.verification, 'UNKNOWN');
  hub.recordVerification('mock', created.sessionId, 'metadata-task', 'PASS');
  assert.equal(hub.observations.report().recent[0]!.verification, 'PASS');
  const paused = prompt('ask'); await waiting;
  assert.equal(hub.observedHealth('mock').inflight, 1);
  released(); await paused;
  assert.equal(hub.observedHealth('mock').inflight, 0);
  assert.equal(hub.observations.report().routes[0]!.completed, 2, 'a denied permission does not cause rerouting/replay');
  await prompt('cancelled');
  assert.equal(hub.observedHealth('mock').inflight, 0);
  assert.equal(hub.observations.report().recent[0]!.outcome, 'cancelled');
  await assert.rejects(prompt('approval-refused'), /approval rejected/);
  assert.equal(hub.observedHealth('mock').inflight, 0);
  assert.equal(hub.observations.report().recent[0]!.error, 'provider');
  assert.equal(hub.observations.report().recent.length, 4, 'refused approval is observed once, never retried');
  await assert.rejects(prompt('limit'), /usage limit/);
  assert.equal(hub.observedHealth('mock').inflight, 0);
  assert.equal(hub.observations.report().recent[0]!.error, 'quota');
  const ledger = readFileSync(join(dir, 'observations/turns.jsonl'), 'utf8');
  assert.equal(ledger.includes('private-fixture-detail'), false, 'approval error details are excluded');
  assert.equal(ledger.includes('usage limit'), false, 'raw errors are excluded');
  assert.equal(ledger.includes('outcome: deny'), false, 'response text is excluded');
  await hub.remove('mock'); hub = new Hub(options);
  assert.equal(hub.observations.report().recent.length, 5);
  assert.equal(hub.observations.report().inFlight, 0);
  assert.ok(hub.observedHealth('mock').cooldownUntil, 'reported quota cooldown persists');
});


test('an unavailable optional metadata directory cannot prevent actual Hub inference', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'performance-hub-unavailable-'));
  // Deterministic EEXIST/ENOTDIR even when tests run as root: this cannot be a directory.
  writeFileSync(join(dir, 'observations'), 'occupied', { mode: 0o600 });
  const hub = new Hub({ clis: [{ name: 'mock', acp: [process.execPath, fileURLToPath(new URL('./mock-agent.ts', import.meta.url))] }],
    cwd: dir, stateDir: dir, env: { PATH: process.env.PATH ?? '' }, maxTurns: 1 });
  t.after(async () => { await hub.remove('mock'); rmSync(dir, { recursive: true, force: true }); });
  const peer: Peer = { send: () => {}, ask: async () => { throw Error('No permissions expected'); } };
  const created = await hub.newSession('mock', { cwd: dir, mcpServers: [] }, peer) as { sessionId: string };
  const response = await hub.prompt('mock', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hello' }] }, peer) as any;
  assert.equal(response.stopReason, 'end_turn');
  const report = hub.observations.report();
  assert.equal(report.recent[0]!.outcome, 'completed');
  assert.equal(report.inFlight, 0);
  assert.ok(report.persistenceErrors > 0);
  assert.equal(hub.observedHealth('mock').inflight, 0);
});
