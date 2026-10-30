import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const benchmark = await import('../benchmarks/memory-retrieval.mjs') as Record<string, any>;

function vector(text: string): number[] {
  const t = text.toLowerCase();
  return [
    Number(/frankfurt|eu-central|where.*production/.test(t)),
    Number(/pnpm|javascript|dependencies/.test(t)),
    Number(/postgres|database|event records|persists/.test(t)),
    Number(/audit|90 days|history/.test(t)),
    Number(/backup|snapshot|02:00|night/.test(t)),
    Number(/redis|queue|background jobs/.test(t)),
    Number(/jwt|token|service-to-service/.test(t)),
    Number(/on-call|sign off|approved|release/.test(t)),
    0.01,
  ];
}

test('benchmark fixture sends only fresh same-project facts to providers', async () => {
  const sent: string[] = [];
  const embeddingClient = {
    async generate({ requestBody }: any) {
      sent.push(...requestBody.input);
      return {
        model: 'baai/bge-base-en-v1.5', provider: 'mock',
        data: requestBody.input.map((text: string, index: number) => ({ index, embedding: vector(text) })),
        usage: { prompt_tokens: 500, cost: 0.0000025 },
      };
    },
  };
  const decisionClient = {
    async create(request: any) {
      const json = JSON.stringify(request);
      sent.push(json);
      const queries = request.decisionsRequest.state.queries;
      const map: Record<string, string> = { d1: 'region', d2: 'package-manager', d3: 'database', d4: 'abstain', h1: 'backup', h2: 'retention', h3: 'auth', h4: 'release', h5: 'abstain', h6: 'abstain' };
      return {
        model: 'cloudflare/clef-flash', provider: 'mock', usage: { cost: 0.000001 },
        answers: Object.fromEntries(queries.map((q: any) => [q.id, { choice: map[q.id], probabilities: { [map[q.id]]: 0.98 } }])),
      };
    },
  };
  const report = await benchmark.runMemoryRetrievalBenchmark({ embeddingClient, decisionClient, live: false });
  const serialized = sent.join('\n');
  assert.equal(report.fixture.freshCorpusFacts, 8);
  assert.equal(report.fixture.staleOrOtherProjectSentToProvider, false);
  assert.equal(serialized.includes('old beta analytics store used Cassandra'), false);
  assert.equal(serialized.includes('Beta-only analytics uses Snowflake'), false);
  assert.equal(report.arms.typedDecision.heldout.knownAnswerAccuracy, 1);
  assert.equal(report.arms.typedDecision.heldout.unknownFalsePositiveRate, 0);
  assert.equal(report.arms.embeddings.actualCostUsd, 0.0000025);
});

test('typed decision request keeps gold labels outside provider state', async () => {
  let captured: any;
  await benchmark.runMemoryRetrievalBenchmark({
    decisionClient: { async create(request: any) { captured = request; return { answers: {} }; } },
  });
  const request = JSON.stringify(captured);
  assert.equal(request.includes('"gold"'), false);
  assert.equal(request.includes('"split"'), false);
  assert.equal(request.includes('heldout'), false);
  assert.deepEqual(Object.keys(captured.decisionsRequest.state.queries[0]).sort(), ['id', 'query']);
});

test('unknown embedding cost blocks a second paid call in live mode', async () => {
  let decisions = 0;
  const receipts: any[] = [];
  const report = await benchmark.runMemoryRetrievalBenchmark({
    live: true,
    onPaidCall: (event: any) => receipts.push(event),
    embeddingClient: { async generate({ requestBody }: any) { return { model: 'baai/bge-base-en-v1.5', id: 'gen-abcdefgh1234', data: requestBody.input.map((text: string, index: number) => ({ index, embedding: vector(text) })), usage: { prompt_tokens: 200 } }; } },
    decisionClient: { async create() { decisions++; return {}; } },
  });
  assert.equal(decisions, 0);
  assert.equal(report.arms.typedDecision.skipped, true);
  assert.deepEqual(receipts.map((x) => x.phase), ['intent', 'response']);
});

test('resolved embedding cost is reconciled before the typed-choice call', async () => {
  const order: string[] = [];
  const report = await benchmark.runMemoryRetrievalBenchmark({
    live: true,
    onPaidCall: (event: any) => order.push(event.phase),
    metadata: { reconcileGenerationCost: async () => { order.push('cost_reconciled'); return 0.000003; } },
    embeddingClient: { async generate({ requestBody }: any) { return { id: 'gen-abcdefgh1234', model: 'baai/bge-base-en-v1.5', data: requestBody.input.map((text: string, index: number) => ({ index, embedding: vector(text) })), usage: { promptTokens: 150 } }; } },
    decisionClient: { async create() { order.push('decision'); return { answers: {}, usage: { cost: 0 } }; } },
  });
  assert.equal(report.arms.embeddings.actualCostUsd, 0.000003);
  assert.ok(order.indexOf('cost_reconciled') < order.indexOf('decision'));
});

test('embedding data.index restores out-of-order vectors deterministically', async () => {
  const normal = { generate: async ({ requestBody }: any) => ({
    model: 'baai/bge-base-en-v1.5', data: requestBody.input.map((text: string, index: number) => ({ index, embedding: vector(text) })),
  }) };
  const reversed = { generate: async ({ requestBody }: any) => ({
    model: 'BAAI/bge-base-en-v1.5', data: requestBody.input.map((text: string, index: number) => ({ index, embedding: vector(text) })).reverse(),
  }) };
  const a = await benchmark.runMemoryRetrievalBenchmark({ embeddingClient: normal });
  const b = await benchmark.runMemoryRetrievalBenchmark({ embeddingClient: reversed });
  assert.deepEqual(a.arms.embeddings.heldout, b.arms.embeddings.heldout);
  assert.deepEqual(a.arms.embeddings.rows.map((x: any) => x.chosen), b.arms.embeddings.rows.map((x: any) => x.chosen));
  assert.equal(b.arms.embeddings.responseIdentity, 'BAAI/bge-base-en-v1.5');
});

test('FTS timing excludes a deliberately slow provider call', async () => {
  const report = await benchmark.runMemoryRetrievalBenchmark({
    embeddingClient: { async generate({ requestBody }: any) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { model: 'baai/bge-base-en-v1.5', data: requestBody.input.map((text: string, index: number) => ({ index, embedding: vector(text) })), usage: { cost: 0.000001 } };
    } },
  });
  assert.ok(report.arms.embeddings.latencyMs >= 70);
  assert.ok(report.arms.fts.latencyMs < 70);
});

test('private receipt is durable before invalid paid response validation and prevents replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-bench-'));
  const recorder = benchmark.createLiveMeterRecorder(directory);
  try {
    await assert.rejects(() => benchmark.runMemoryRetrievalBenchmark({
      live: true, onPaidCall: recorder,
      embeddingClient: { async generate() { return { id: 'gen-abcdefgh1234', model: 'wrong/model', usage: { cost: 0.0002, promptTokens: 44 }, data: [] }; } },
    }), /catalog identity/);
  } finally { recorder.close(); }
  const receiptPath = join(directory, 'memory-retrieval-meter.jsonl');
  const lines = readFileSync(receiptPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((x: any) => x.phase), ['intent', 'response']);
  assert.equal(lines[1].responseId, 'gen-abcdefgh1234');
  assert.equal(lines[1].usageCostUsd, 0.0002);
  assert.equal(lines[1].usageTokens, 44);
  assert.equal(readFileSync(receiptPath, 'utf8').includes('Production is deployed'), false);
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  assert.throws(() => benchmark.createLiveMeterRecorder(directory));
  rmSync(directory, { recursive: true, force: true });
});

test('non-finite embedding vector values are rejected', async () => {
  await assert.rejects(() => benchmark.runMemoryRetrievalBenchmark({
    embeddingClient: { async generate({ requestBody }: any) {
      return { model: 'baai/bge-base-en-v1.5', data: requestBody.input.map((_: string, index: number) => ({ index, embedding: [Number.NaN, 1] })) };
    } },
  }), /invalid values/);
});

test('confirmation benchmark uses twelve new held-out queries and fixed thresholds for three repeats', async () => {
  const decisionRequests: any[] = [];
  const embeddingClient = { async generate({ requestBody }: any) {
    return { model: 'BAAI/bge-base-en-v1.5', data: requestBody.input.map((text: string, index: number) => ({ index, embedding: vector(text) })), usage: { promptTokens: 300, cost: 0.000001 } };
  } };
  const decisionClient = { async create(request: any) {
    decisionRequests.push(request);
    return { model: 'cloudflare/clef-flash', usage: { cost: 0.0001 }, answers: {} };
  } };
  const report = await benchmark.runMemoryRetrievalConfirmation({ embeddingClient, decisionClient, repetitions: 3 });
  assert.equal(report.queries.total, 12);
  assert.equal(report.queries.repetitionsCompleted, 3);
  assert.equal(report.thresholds.heldoutTuning, false);
  assert.equal(report.thresholds.bgeTopCosine, 0.5576353937357739);
  assert.equal(report.thresholds.clefConfidence, 0.8498);
  assert.equal(report.arms.fts5Bm25Or.queryExpansion, false);
  assert.equal(report.arms.fts5Bm25Or.threshold.method, 'maximize exact-choice accuracy on original development queries only');
  assert.equal(decisionRequests.length, 3);
  for (const request of decisionRequests) {
    const state = request.decisionsRequest.state;
    assert.equal(state.queries.length, 12);
    assert.equal(state.queries[0].gold, undefined);
    assert.equal(state.queries[0].kind, undefined);
    assert.equal(JSON.stringify(state).includes('Beta-only analytics uses Snowflake'), false);
    assert.equal(JSON.stringify(state).includes('old beta analytics store used Cassandra'), false);
  }
});

test('confirmation stops before Clef when a live BGE charge is unresolved', async () => {
  let decisionCalls = 0;
  const report = await benchmark.runMemoryRetrievalConfirmation({
    live: true, repetitions: 3, onPaidCall: () => {},
    embeddingClient: { async generate({ requestBody }: any) {
      return { id: 'gen-emb-abcdefgh', model: 'BAAI/bge-base-en-v1.5', data: requestBody.input.map((text: string, index: number) => ({ index, embedding: vector(text) })), usage: { promptTokens: 300 } };
    } },
    decisionClient: { async create() { decisionCalls++; return { answers: {} }; } },
  });
  assert.equal(decisionCalls, 0);
  assert.match(report.stopReason, /cost unknown/);
  assert.equal(report.queries.repetitionsCompleted, 0);
  assert.equal(report.arms.embeddings.repetitions, 1);
});
