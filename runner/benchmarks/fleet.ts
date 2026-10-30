import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { TaskStore } from '../src/tasks/index.ts';
import { ContextStore } from '../src/context/store.ts';
import { Engine } from '../src/orchestration/engine.ts';

// Fixed-latency fake native transport. This measures scheduler throughput only.
const samples: Array<Record<string, number>> = [];
for (const slots of [2, 4, 8]) {
  for (let repetition = 0; repetition < 3; repetition++) {
    const root = mkdtempSync(join(tmpdir(), 'fleet-benchmark-'));
    const tasks = new TaskStore(':memory:');
    const context = new ContextStore();
    let active = 0,
      maxActive = 0;
    const hub = {
      has: () => true,
      newSession: async () => ({ sessionId: randomUUID() }),
      loadSession: async () => ({}),
      prompt: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await sleep(75);
          return { stopReason: 'end_turn' };
        } finally {
          active--;
        }
      },
      notify: () => {},
      detach: () => {},
      forward: async () => ({}),
    };
    const engine = new Engine({
      tasks,
      context,
      hub,
      maxConcurrent: slots,
      pollMs: 5,
      projectRoot: (id) => join(root, id),
      routing: { select: async () => ({ cli: 'mock', source: 'explicit' }) },
    });
    try {
      for (const id of ['p1', 'p2', 'p3', 'p4']) mkdirSync(join(root, id));
      const jobs = ['p1', 'p2', 'p3', 'p4'].map((projectId) =>
        engine.submit({
          projectId,
          prompt: 'Fixed latency scheduling fixture.',
          route: { mode: 'explicit', agentId: 'mock' },
        }),
      );
      const started = performance.now();
      engine.start();
      const finished = await Promise.all(jobs.map((task) => engine.wait(task.id)));
      assert.ok(finished.every((task) => task.status === 'succeeded' && task.costMicros === null));
      assert.equal(maxActive, slots / 2);
      samples.push({
        slots,
        repetition,
        jobs: jobs.length,
        simulatedPromptMs: 75,
        maxActivePrompts: maxActive,
        makespanMs: performance.now() - started,
      });
    } finally {
      await engine.stop();
      tasks.close();
      context.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}
const report = {
  kind: 'fleet-scheduler-throughput',
  recordedAt: new Date().toISOString(),
  node: process.version,
  sqlite: process.versions.sqlite,
  modelCalls: 0,
  paidCalls: 0,
  engineSha256: createHash('sha256')
    .update(readFileSync(new URL('../src/orchestration/engine.ts', import.meta.url)))
    .digest('hex'),
  samples,
  limitations: [
    'Fixed-latency mock transport, not measured model latency or cost.',
    'Independent nonoverlapping project roots; no same-project parallel writes.',
    'One reserved child slot per coordinator. No OS sandbox or provider throughput guarantee.',
  ],
};
const destination = resolve(process.argv[2] ?? 'fleet-results.json');
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(
  JSON.stringify({
    report: destination,
    jobs: 36,
    paidCalls: 0,
    meansMs: Object.fromEntries(
      [2, 4, 8].map((slots) => [
        slots,
        samples.filter((s) => s.slots === slots).reduce((sum, s) => sum + s.makespanMs!, 0) / 3,
      ]),
    ),
  }),
);
