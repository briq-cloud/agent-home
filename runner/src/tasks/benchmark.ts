/** Local storage microbenchmark only. No models, agents, network, or paid calls.
 * Run: node src/tasks/benchmark.ts /absolute/path/report.json
 * Numbers depend on the host filesystem and are not model-performance claims.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TaskStore, type Task } from './index.ts';

const reportPath = process.argv[2];
if (!reportPath) throw new Error('Usage: node src/tasks/benchmark.ts /absolute/path/report.json');
const directory = mkdtempSync(join(tmpdir(), 'agent-home-task-bench-'));
const databasePath = join(directory, 'tasks.sqlite');
let now = 1_000;
let store: TaskStore | undefined;
const samples: Record<string, number[]> = {};
function measure<T>(name: string, operation: () => T): T {
  const started = performance.now();
  const result = operation();
  (samples[name] ??= []).push(performance.now() - started);
  return result;
}
try {
  store = measure('openAndMigrate', () => new TaskStore(databasePath, { now: () => now }));
  for (let i = 0; i < 100; i++) {
    measure('createTask', () =>
      store!.createTask({
        id: `task-${i}`,
        projectId: 'benchmark',
        promptRef: `prompts/${i}`,
        route: { mode: 'explicit', agentId: 'local-benchmark-no-execution' },
      }),
    );
  }
  for (let i = 0; i < 100; i++) {
    const task = measure('claimNext', () =>
      store!.claimNext({ projectId: 'benchmark', workerId: 'local-benchmark', leaseMs: 10_000 }),
    )!;
    assert.ok(task);
    measure('heartbeat', () => store!.heartbeat(task.id, task.leaseToken, 10_000, { costMicros: 0 }));
    const result = measure('complete', () =>
      store!.complete(task.id, task.leaseToken, { outputRef: `outputs/${i}`, costMicros: 0 }),
    );
    assert.equal(result?.status, 'succeeded');
    const input = {
      projectId: 'benchmark',
      taskId: task.id,
      sender: 'benchmark',
      recipient: 'benchmark-reader',
      text: 'Local durability benchmark message',
      idempotencyKey: `message-${i}`,
    };
    const message = measure('sendMessage', () => store!.sendMessage(input));
    const duplicate = measure('deduplicateMessage', () => store!.sendMessage(input));
    assert.equal(message.id, duplicate.id);
    measure('acknowledgeMessage', () => store!.acknowledgeMessage(message.id, 'benchmark-reader'));
  }
  for (let i = 0; i < 25; i++) {
    store.close();
    store = measure('reopen', () => new TaskStore(databasePath, { now: () => now }));
    assert.equal(store.listTasks({ status: 'succeeded', limit: 1000 }).length, 100);
  }
  for (let i = 0; i < 25; i++) {
    const task: Task = store.createTask({
      id: `recovery-${i}`,
      projectId: 'recovery',
      promptRef: `prompts/recovery-${i}`,
      route: { mode: 'auto' },
      maxAttempts: 2,
    });
    const claimed: Task = store.claimNext({ projectId: 'recovery', workerId: 'vanishing-worker', leaseMs: 100 })!;
    assert.equal(claimed.id, task.id);
    now += 100;
    measure('recoverExpiredLease', () => store!.recover());
    assert.equal(store.getTask(task.id)?.status, 'failed');
    assert.equal(store.getTask(task.id)?.costMicros, null);
    assert.equal(store.complete(task.id, claimed.leaseToken), null);
  }
  assert.equal(store.listMessages({ projectId: 'benchmark', limit: 1000 }).length, 100);
  assert.equal(store.listMessages({ projectId: 'benchmark', unacknowledgedOnly: true, limit: 1000 }).length, 0);
  store.close();
  store = undefined;
  const metrics = Object.fromEntries(
    Object.entries(samples).map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const totalMs = values.reduce((sum, value) => sum + value, 0);
      return [
        name,
        {
          samples: values.length,
          totalMs,
          meanMs: totalMs / values.length,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
          minMs: sorted[0],
          maxMs: sorted.at(-1),
        },
      ];
    }),
  );
  const sources = ['index.ts', 'benchmark.ts'].map((name) => ({
    name,
    sha256: createHash('sha256')
      .update(readFileSync(new URL(name, import.meta.url)))
      .digest('hex'),
  }));
  const report = {
    kind: 'local-task-store-durability',
    recordedAt: new Date().toISOString(),
    node: process.version,
    sqlite: process.versions.sqlite,
    platform: process.platform,
    arch: process.arch,
    sources,
    configuration: {
      journalMode: 'WAL',
      synchronous: 'FULL',
      databaseFileMode: '0600',
      taskSamples: 100,
      messageSamples: 100,
      reopenSamples: 25,
      leaseRecoverySamples: 25,
      modelCalls: 0,
      paidCalls: 0,
    },
    verified: {
      succeededTasks: 100,
      recoveredFailedTasks: 25,
      unknownCostPreserved: true,
      staleCompletionsRejected: true,
      messages: 100,
      duplicateMessagesCreated: 0,
      unacknowledgedMessages: 0,
    },
    closedDatabaseBytes: statSync(databasePath).size,
    metrics,
    limitations: [
      'Host-local SQLite filesystem timing only; not model performance.',
      'Single-process timings; cross-process contention is covered by task tests.',
      'No assertion of exactly-once external effects.',
    ],
  };
  writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ reportPath: resolve(reportPath), taskSamples: 100, messageSamples: 100, paidCalls: 0 }));
} finally {
  store?.close();
  rmSync(directory, { recursive: true, force: true });
}
