import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TaskStore } from '../src/tasks/index.ts';
import { ContextStore } from '../src/context/store.ts';
import { Engine } from '../src/orchestration/engine.ts';

const root = mkdtempSync(join(tmpdir(), 'task-view-benchmark-'));
const tasks = new TaskStore(':memory:');
const context = new ContextStore();
let nativeCalls = 0,
  artifactReads = 0;
const unexpected = async () => {
  nativeCalls++;
  throw Error('No model call is permitted');
};
const engine = new Engine({
  tasks,
  context,
  projectRoot: (id) => join(root, id),
  routing: { select: unexpected },
  hub: {
    has: () => true,
    newSession: unexpected,
    loadSession: unexpected,
    prompt: unexpected,
    notify: () => {},
    detach: () => {},
    forward: unexpected,
  },
});
try {
  for (const id of ['alpha', 'beta']) mkdirSync(join(root, id));
  const notBefore = Date.now() + 86_400_000;
  for (let offset = 0; offset < 1000; offset += 100)
    engine.submitBatch(
      Array.from({ length: 100 }, (_, index) => ({
        id: randomUUID(),
        projectId: (offset + index) % 2 ? 'alpha' : 'beta',
        prompt: `Repair request state for case ${offset + index}\n${'Fixture detail. '.repeat(100)}`,
        route: { mode: 'explicit' as const, agentId: 'mock' },
        notBefore,
      })),
    );
  // Projection must remain usable without reading any instruction artifacts.
  context.readArtifact = () => {
    artifactReads++;
    throw Error('Unexpected prompt read');
  };
  const samples: number[] = [];
  let payloadBytes = 0;
  for (let repetition = 0; repetition < 50; repetition++) {
    const started = performance.now();
    const page = engine.projectTasks(tasks.listTasks({ projectId: 'alpha', limit: 100, offset: 100 }));
    assert.equal(page.length, 100);
    assert.ok(
      page.every(
        (task) =>
          task.projectId === 'alpha' &&
          task.title?.startsWith('Repair request state') &&
          task.waitReason?.code === 'scheduled' &&
          task.waitReason.until === notBefore,
      ),
    );
    payloadBytes = Buffer.byteLength(JSON.stringify(page));
    samples.push(performance.now() - started);
  }
  assert.equal(artifactReads, 0);
  assert.equal(nativeCalls, 0);
  samples.sort((a, b) => a - b);
  const report = {
    kind: 'bounded-task-view',
    recordedAt: new Date().toISOString(),
    node: process.version,
    sqlite: process.versions.sqlite,
    storedTasks: 1000,
    projectTasks: 500,
    pageTasks: 100,
    repetitions: 50,
    payloadBytes,
    artifactReads,
    modelCalls: nativeCalls,
    paidCalls: 0,
    medianMs: samples[25],
    p95Ms: samples[47],
    samplesMs: samples,
    engineSha256: createHash('sha256')
      .update(readFileSync(new URL('../src/orchestration/engine.ts', import.meta.url)))
      .digest('hex'),
    limitations: [
      'In-memory SQLite on the local host; no production latency or model-cost claim.',
      'Scheduled tasks only. Live permission, workspace and cancellation states are covered by regression tests.',
    ],
  };
  const destination = resolve(process.argv[2] ?? 'task-view-results.json');
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      report: destination,
      storedTasks: report.storedTasks,
      medianMs: report.medianMs,
      p95Ms: report.p95Ms,
      artifactReads,
      paidCalls: 0,
    }),
  );
} finally {
  await engine.stop();
  tasks.close();
  context.close();
  rmSync(root, { recursive: true, force: true });
}
