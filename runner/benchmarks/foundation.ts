import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ContextStore, runMemoryAcceptanceBenchmark } from '../src/context/store.ts';
import { TaskStore } from '../src/tasks/index.ts';
import { Engine } from '../src/orchestration/engine.ts';
import type { Peer } from '../src/acp/hub.ts';
import { nextEligible } from '../src/scheduling/offpeak.ts';

const root = mkdtempSync(join(tmpdir(), 'agent-home-foundation-'));
const tasks = new TaskStore(join(root, 'tasks.sqlite'));
const context = new ContextStore({ dbPath: join(root, 'context.sqlite') });
const version = 'fixture-v1',
  project = 'fixture';
context.setProjectRevision(project, version);
writeFileSync(join(root, 'source.txt'), 'Configuration precedence: flag, environment, file, default.\n');
const source = await context.readSourceFile({ project, revision: version, root, path: 'source.txt' });
context.putMemory({ project, key: 'precedence', text: 'Flags take precedence over environment values.', source });
let sessionCount = 0;
const prompts: string[] = [];
const fakeHub = {
  has: () => true,
  newSession: async () => {
    sessionCount++;
    return { sessionId: randomUUID() };
  },
  loadSession: async () => ({}),
  prompt: async (_cli: string, params: any, peer: Peer) => {
    prompts.push(params.prompt[0].text);
    peer.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'checked' } },
      },
    });
    return { stopReason: 'end_turn' };
  },
  notify: () => {},
  detach: () => {},
  forward: async () => ({}),
};
const engine = new Engine({
  tasks,
  context,
  hub: fakeHub,
  routing: { select: async () => ({ cli: 'mock', source: 'explicit' }) },
  projectRoot: () => root,
});
const samples: Array<{
  arm: string;
  totalMs: number;
  runs: number;
  outputArtifacts: number;
  unknownCosts: number;
  promptBytes: number;
}> = [];
try {
  engine.start();
  for (const arm of ['baseline', 'context-and-memory']) {
    const started = performance.now(),
      offset = prompts.length;
    const jobs = Array.from({ length: 20 }, (_, i) =>
      engine.submit({
        projectId: project,
        prompt: `Check configuration case ${i}.`,
        route: { mode: 'explicit', agentId: 'mock' },
        ...(arm === 'context-and-memory'
          ? { context: { revision: version, paths: ['source.txt'], memoryQuery: 'Flags' } }
          : {}),
      }),
    );
    const finished = await Promise.all(jobs.map((task) => engine.wait(task.id)));
    assert(finished.every((t) => t.status === 'succeeded' && t.outputRef && t.costMicros === null));
    if (arm === 'context-and-memory')
      assert(prompts.slice(offset).every((p) => p.includes(source.hash) && p.includes('Flags take precedence')));
    samples.push({
      arm,
      totalMs: performance.now() - started,
      runs: jobs.length,
      outputArtifacts: finished.filter((t) => t.outputRef).length,
      unknownCosts: finished.filter((t) => t.costMicros === null).length,
      promptBytes: prompts.slice(offset).reduce((n, p) => n + Buffer.byteLength(p), 0),
    });
  }
  const memory = await runMemoryAcceptanceBenchmark();
  assert(memory.every((c) => c.passed));
  const scheduling = nextEligible({
    now: '2026-10-30T12:00:00Z',
    deadline: '2026-10-31T00:00:00Z',
    enabled: true,
    policy: { flexibleDeadline: true, userWindows: [{ start: '22:00', end: '24:00' }] },
  });
  assert(
    scheduling.status === 'eligible' &&
      scheduling.notBefore === '2026-10-30T22:00:00.000Z' &&
      scheduling.discount.status === 'unknown',
  );
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const sources = Object.fromEntries(
    [
      'src/orchestration/engine.ts',
      'src/tasks/index.ts',
      'src/context/store.ts',
      'src/routing/index.ts',
      'src/scheduling/offpeak.ts',
    ].map((p) => [
      p,
      createHash('sha256')
        .update(readFileSync(join(base, p)))
        .digest('hex'),
    ]),
  );
  const report = {
    kind: 'local-foundation-acceptance-and-overhead',
    recordedAt: new Date().toISOString(),
    node: process.version,
    sqlite: process.versions.sqlite,
    sourceHashes: sources,
    modelCalls: 0,
    paidCalls: 0,
    sessions: sessionCount,
    samples,
    memory,
    scheduling,
    limitations: [
      'Fake model transport; these timings measure application/storage overhead only.',
      'No inference quality, cache-hit, token-savings or cost-reduction claim.',
      'Source/memory tokenEstimate uses bytes/4; it is not a provider tokenizer.',
    ],
  };
  const destination = resolve(process.argv[2] ?? 'foundation-results.json');
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ report: destination, tasks: 40, memoryChecks: memory.length, paidCalls: 0 }));
} finally {
  await engine.stop();
  tasks.close();
  context.close();
  rmSync(root, { recursive: true, force: true });
}
