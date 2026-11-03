import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PerformanceLedger, MINIMUM_SAMPLES, endpointFingerprint, type Dimensions } from '../src/telemetry/performance.ts';
import { compareObservedAccounts, type Binding } from '../src/routing/index.ts';
import { configuration } from '../src/app/config.ts';
const dims: Dimensions = { cli: 'account-one', harness: 'claude', provider: 'anthropic', model: 'exact-model', taskCategory: 'change', endpointIdentity: 'endpoint-one' };
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'performance-')); let now = 1000;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new PerformanceLedger(dir, () => now);
  return { dir, ledger, time: (value: number) => { now = value; }, now: () => now };
}
test('explicit reported counters, observed timings and verifier results remain separate', t => {
  const f = fixture(t);
  const turn = f.ledger.begin(dims, 'session-one', { taskId: 'task-one', taskCategory: 'change' }, 25, true, true);
  turn.text(1100); turn.text(1300); turn.updateCost({ amount: 0.01, currency: 'USD' });
  f.time(1400); f.ledger.finish(turn, turn.end(f.now(), 'completed', { inputTokens: 10, outputTokens: 4 }));
  let row = f.ledger.report().recent[0]!;
  assert.equal(row.elapsedMs, 400); assert.equal(row.ttftMs, 100); assert.equal(row.tokensPerSecond, 20);
  assert.equal(row.cost?.interpretation, 'notional_cli_cost'); assert.equal(row.verification, 'UNKNOWN');
  f.ledger.verify(dims.cli, 'session-one', 'task-one', 'FAIL');
  assert.equal(f.ledger.report().recent[0]!.verification, 'FAIL');
  const next = f.ledger.begin(dims, 'session-one', { taskCategory: 'change' }, 0, false, true);
  next.text(1450); f.time(1500); f.ledger.finish(next, next.end(f.now(), 'completed', { inputTokens: 15, outputTokens: 7 }));
  row = f.ledger.report().recent[0]!;
  assert.deepEqual(row.tokens, { input: 5, output: 3 }); assert.equal(row.tokensPerSecond, null, 'one chunk has no generation window');
  assert.equal(row.cost, null, 'missing cost is unknown');
});
test('missing, reset, invalid counters and context occupancy never become billed usage', t => {
  const f = fixture(t);
  const turn = f.ledger.begin(dims, 'session', {}, 0, false, true);
  turn.text(1200); turn.text(1300); f.time(1400);
  f.ledger.finish(turn, turn.end(f.now(), 'completed', { used: 1000, size: 32000, outputTokens: 10 }));
  assert.deepEqual(f.ledger.report().recent[0]!.tokens, { input: null, output: null });
  assert.equal(f.ledger.report().recent[0]!.tokensPerSecond, null, 'no valid starting baseline');
  const next = f.ledger.begin(dims, 'session', {}, 0, false, false);
  next.updateCost({ amount: 4, currency: 'USD' }); f.time(1500);
  f.ledger.finish(next, next.end(f.now(), 'error', { inputTokens: NaN, outputTokens: 2 }, 'provider'));
  assert.deepEqual(f.ledger.report().recent[0]!.tokens, { input: null, output: null });
  assert.equal(f.ledger.report().recent[0]!.cost, null, 'profile adapter cost stays unknown');
});
test('bounded metadata index recovers completed versus interrupted turns without body or error copies', t => {
  const f = fixture(t);
  const turn = f.ledger.begin(dims, 'session', { taskCategory: 'change', taskId: 'task' }, 0, true, true);
  f.time(1100); f.ledger.finish(turn, turn.end(f.now(), 'error', {}, 'provider'));
  f.ledger.begin(dims, 'pending', { taskCategory: 'change' }, 0, true, true);
  assert.equal(f.ledger.report().inFlight, 1);
  appendFileSync(join(f.dir, 'observations/turns.jsonl'), JSON.stringify({ version: 1, kind: 'end', turnId: turn.started.turnId, at: 1100, elapsedMs: 100, outcome: 'error', error: 'PRIVATE-ERROR-BODY', prompt: 'PRIVATE-PROMPT', tokens: {}, cumulative: {} }) + '\n');
  const recovered = new PerformanceLedger(f.dir, f.now);
  assert.equal(recovered.report().inFlight, 0);
  assert.equal(recovered.report().recent[0]!.outcome, 'interrupted');
  assert.equal(JSON.stringify(recovered.report()).includes('PRIVATE-'), false);
  assert.equal(recovered.report().recent[1]!.outcome, 'error');
  for (let i = 0; i < 2500; i++) {
    const turn = f.ledger.begin(dims, 'session-' + i, {}, 0, true, true);
    f.ledger.finish(turn, turn.end(f.now(), 'completed', {}));
  }
  const report = new PerformanceLedger(f.dir, f.now).report();
  assert.equal(report.recent.length, 100); assert.ok(report.routes[0]!.samples <= 1000);
  const files = readdirSync(join(f.dir, 'observations'));
  assert.ok(files.length <= 2);
  for (const file of files) { assert.ok(statSync(join(f.dir, 'observations', file)).size <= report.retention.maximumFileBytes); assert.equal(statSync(join(f.dir, 'observations', file)).mode & 0o777, 0o600); }
  f.time(8 * 86_400_000); assert.equal(recovered.report().recent.length, 0);
});
test('operator opt-in defaults off; empirical latency requires exact known dimensions and ten samples', t => {
  const f = fixture(t), b: Binding = { id: 'one', cli: 'account-one', harness: 'claude', provider: 'anthropic', billing: 'subscription', signedIn: true, model: 'exact-model', endpointIdentity: 'endpoint-one', compatibility: 'verified', subscriptionAccount: { enabled: true, priority: 1 }, inflight: 0, nearQuota: false };
  const other = { ...b, id: 'two', cli: 'account-two' };
  assert.equal(configuration({}).empiricalRouting, false);
  for (const [cli, ttft] of [[b.cli, 100], [other.cli, 20]] as const) for (let i = 0; i < MINIMUM_SAMPLES; i++) {
    const start = f.now(), turn = f.ledger.begin({ ...dims, cli }, 'session-' + cli + i, { taskCategory: 'change' }, 0, true, true);
    turn.text(start + ttft); f.time(start + 200); f.ledger.finish(turn, turn.end(f.now(), 'completed', {}));
  }
  const rows = f.ledger.report().routes;
  assert.ok(compareObservedAccounts(b, other, 'change', rows) > 0);
  assert.equal(compareObservedAccounts(b, other, undefined, rows), 0);
  assert.equal(compareObservedAccounts({ ...b, model: undefined }, { ...other, model: undefined }, 'change', rows), 0);
  assert.equal(compareObservedAccounts(b, { ...other, subscriptionAccount: { enabled: true, priority: 2 } }, 'change', rows), 0);
  assert.equal(compareObservedAccounts(b, other, 'review', rows), 0);
  assert.equal(compareObservedAccounts({ ...b, endpointIdentity: 'endpoint-two' }, { ...other, endpointIdentity: 'endpoint-two' }, 'change', rows), 0, 'history for a different endpoint is ineligible');
  assert.equal(compareObservedAccounts({ ...b, endpointIdentity: undefined }, { ...other, endpointIdentity: undefined }, 'change', rows), 0, 'unknown historical endpoint cannot rank');
  assert.equal(endpointFingerprint('https://api.example.test/v1'), endpointFingerprint('https://api.example.test/v1'));
  assert.notEqual(endpointFingerprint('https://api.example.test/v1'), endpointFingerprint('https://other.example.test/v1'));
  assert.equal(endpointFingerprint('https://api.example.test/?key=private'), null);
  assert.equal(compareObservedAccounts(b, other, 'change', rows.map(r => ({ ...r, ttftSamples: 9 }))), 0);
  assert.ok(compareObservedAccounts({ ...b, inflight: 1 }, other, 'change', rows) > 0);
  assert.ok(compareObservedAccounts({ ...b, nearQuota: true }, other, 'change', rows) > 0);
});


test('historical observations group by exact endpoint identity across recovery', t => {
  const f = fixture(t);
  for (const endpointIdentity of ['endpoint-old', 'endpoint-new']) {
    const turn = f.ledger.begin({ ...dims, endpointIdentity }, 'session-' + endpointIdentity, { taskCategory: 'change' }, 0, true, true);
    turn.text(f.now() + 1); f.time(f.now() + 2);
    f.ledger.finish(turn, turn.end(f.now(), 'completed', {}));
  }
  const recovered = new PerformanceLedger(f.dir, f.now).report();
  assert.equal(recovered.routes.length, 2);
  assert.deepEqual(recovered.routes.map(route => route.endpointIdentity), ['endpoint-old', 'endpoint-new']);
  assert.equal(recovered.routes[0]!.ttftSamples, 1);
  assert.equal(recovered.routes[1]!.ttftSamples, 1);
});
