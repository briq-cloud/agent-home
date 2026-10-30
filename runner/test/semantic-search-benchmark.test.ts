import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertColdProviderDispatch,
  createExclusiveRunDirectory,
  FINAL_FIVE_SKIP_CASE_IDS,
  runSemanticSearchBenchmark,
} from '../benchmarks/semantic-search.ts';

test('mock semantic benchmark covers multilingual known, unknown, ambiguous, and lifecycle cases without a model call', async () => {
  const report = await runSemanticSearchBenchmark({ mode: 'mock' });
  assert.equal(report.mode, 'mock');
  assert.equal(report.model, 'deterministic-mock-only');
  assert.equal(report.caseCount, 8);
  const paid = report.paid as { calls: number; actualCostSum: number };
  assert.equal(paid.calls, 0);
  assert.equal(paid.actualCostSum, 0);
  const known = report.known as { count: number };
  const ambiguous = report.ambiguous as { count: number };
  const unknown = report.unknown as { count: number };
  assert.equal(known.count, 5);
  assert.equal(ambiguous.count, 2);
  assert.equal(unknown.count, 1);
  const warm = report.warmCache as {
    count: number;
    passed: number;
    rows: Array<{
      passed: boolean;
      costUsd: number;
      usageTokens: number;
      providerAttemptsDelta: number;
      cache: { queryHit: boolean; factMisses: number };
    }>;
  };
  assert.equal(warm.count, 8);
  assert.equal(warm.passed, 8);
  for (const row of warm.rows) {
    assert.equal(row.passed, true);
    assert.equal(row.costUsd, 0);
    assert.equal(row.usageTokens, 0);
    assert.equal(row.providerAttemptsDelta, 0);
    assert.equal(row.cache.queryHit, true);
    assert.equal(row.cache.factMisses, 0);
  }
  const dispatch = report.providerDispatch as { networkAttempts: number; warmCacheMissRefusals: number };
  assert.equal(dispatch.networkAttempts, 8);
  assert.equal(dispatch.warmCacheMissRefusals, 0);
  const guard = report.providerInputGuard as {
    passed: boolean;
    goldLabelsSent: boolean;
    crossProjectFactSent: boolean;
  };
  assert.deepEqual(guard, {
    passed: true,
    goldLabelsSent: false,
    crossProjectFactSent: false,
    source: 'gold labels and cross-project sentinels are checked against every embeddings input',
  });
  const safety = report.safetyChecks as Record<
    string,
    { passed?: boolean; extraProviderCalls?: number; betaFactSent?: boolean }
  >;
  for (const check of Object.values(safety)) if (typeof check.passed === 'boolean') assert.equal(check.passed, true);
  assert.equal(safety.restart?.extraProviderCalls, 0);
  assert.equal(safety.scopeIsolation?.betaFactSent, false);
});

test('warm cache guard refuses a provider dispatch before counting a request', () => {
  const phase = { warm: true, networkAttempts: 0, warmCacheMissRefusals: 0 };
  assert.throws(() => assertColdProviderDispatch(phase), /warm_cache_miss_refused_before_provider/);
  assert.deepEqual(phase, { warm: true, networkAttempts: 0, warmCacheMissRefusals: 1 });
});

test('final-five benchmark selection omits exactly the three previously billed cases', async () => {
  const report = await runSemanticSearchBenchmark({ mode: 'mock', skipCaseIds: [...FINAL_FIVE_SKIP_CASE_IDS] });
  assert.equal(report.caseCount, 5);
  assert.deepEqual(report.skippedCaseIds, FINAL_FIVE_SKIP_CASE_IDS);
  assert.equal((report.paid as { calls: number }).calls, 0);
  assert.equal((report.warmCache as { count: number }).count, 5);
});

test('live run directory is private, exclusive, and refuses reuse', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'semantic-live-dir-'));
  try {
    const runDir = createExclusiveRunDirectory(parent);
    assert.equal((await stat(runDir)).mode & 0o777, 0o700);
    assert.throws(() => createExclusiveRunDirectory(parent), /must be empty/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
