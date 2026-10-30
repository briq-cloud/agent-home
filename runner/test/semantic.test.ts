import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createEmbeddingsRequestBodyToJSON } from '../node_modules/@openrouter/sdk/esm/models/operations/createembeddings.js';
import { ContextStore } from '../src/context/store.ts';
import {
  BGE_M3,
  BGE_M3_PROVIDER_POLICY,
  SemanticSearch,
  type EmbeddingClient,
  type EmbeddingPayload,
  type IdentityProof,
  type SemanticSearchInput,
} from '../src/context/semantic.ts';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function setup(
  options: {
    dbPath?: string;
    cachePath?: string;
    client?: EmbeddingClient;
    key?: string;
    maxBudgetEstimateUsd?: number;
  } = {},
) {
  const store = new ContextStore({ dbPath: options.dbPath, now: () => 10_000 });
  store.setProjectRevision('p', 'r1');
  const ref = store.putSource({
    project: 'p',
    revision: 'r1',
    path: 'facts.md',
    content: 'User supplied durable facts.',
  });
  store.putMemory({ project: 'p', key: 'language', text: 'The user prefers French responses.', source: ref });
  store.putMemory({ project: 'p', key: 'tooling', text: 'The project uses pnpm.', source: ref });
  let calls = 0;
  const client = options.client ?? {
    async generate({ input }): Promise<EmbeddingPayload> {
      calls++;
      return {
        id: 'req-1',
        model: BGE_M3.canonical,
        data: input.map((text, index) => ({ index, embedding: vectorFor(text) })),
        usage: { cost: 0.000001, promptTokens: 12, totalTokens: 12 },
      };
    },
  };
  const semantic = new SemanticSearch({
    store,
    cachePath: options.cachePath,
    apiKey: () => options.key ?? 'test-key',
    clientFactory: () => client,
    now: () => 10_000,
    maxBudgetEstimateUsd: options.maxBudgetEstimateUsd,
  });
  const input = (overrides: Partial<SemanticSearchInput> = {}): SemanticSearchInput => ({
    project: 'p',
    revision: 'r1',
    query: 'French language preference',
    allowPaid: true,
    budgetEstimateUsd: 0.01,
    idempotencyKey: 'search-1',
    ...overrides,
  });
  return {
    store,
    semantic,
    input,
    calls: () => calls,
    setCalls: (n: number) => {
      calls = n;
    },
  };
}
function vectorFor(text: string): number[] {
  const v = new Array<number>(BGE_M3.dimensions).fill(0);
  v[/french|français|language preference/i.test(text) ? 0 : 1] = 1;
  return v;
}
function responseFor(input: string[], update: Partial<EmbeddingPayload> = {}): EmbeddingPayload {
  return {
    model: BGE_M3.canonical,
    data: input.map((text, index) => ({ index, embedding: vectorFor(text) })),
    ...update,
  };
}

test('search returns current, project-scoped citations and only similarity scores', async () => {
  const { store, semantic, input, calls } = setup();
  try {
    store.setProjectRevision('other', 'r1');
    const otherSource = store.putSource({
      project: 'other',
      revision: 'r1',
      path: 'facts.md',
      content: 'Other project facts.',
    });
    store.putMemory({
      project: 'other',
      key: 'other-only',
      text: 'Private fact from another project.',
      source: otherSource,
    });
    const result = await semantic.search(input());
    assert.equal(result.status, 'complete');
    assert.equal(result.candidates[0]?.key, 'language');
    const storedSource = store.getSource({ project: 'p', revision: 'r1', path: 'facts.md' });
    assert.ok(storedSource);
    assert.deepEqual(result.candidates[0]?.source, { path: 'facts.md', hash: storedSource.hash, revision: 'r1' });
    assert.equal(result.candidates[0]?.scoreMeaning, 'cosine similarity; not confidence');
    assert.equal(result.candidates[0]?.trust, 'untrusted');
    assert.equal(result.request.costUsd, 0.000001);
    assert.equal(calls(), 1);
    const other = await semantic.search(input({ project: 'other', revision: 'r1', idempotencyKey: 'other' }));
    assert.equal(other.candidates.length, 1);
    assert.equal(other.candidates[0]?.key, 'other-only');
    assert.equal(
      other.candidates.some((candidate) => candidate.key === 'language'),
      false,
    );
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('warm vectors avoid further paid calls; cache stays scoped to project and revision', async () => {
  const { store, semantic, input, calls } = setup();
  try {
    const first = await semantic.search(input());
    const second = await semantic.search(input({ idempotencyKey: 'search-2' }));
    assert.equal(first.status, 'complete');
    assert.equal(second.status, 'complete');
    assert.equal(calls(), 1);
    assert.equal(second.cache.queryHit, true);
    assert.equal(second.cache.factHits, 2);
    store.setProjectRevision('p', 'r2');
    const stale = await semantic.search(input({ revision: 'r1', idempotencyKey: 'stale' }));
    assert.equal(stale.status, 'blocked');
    assert.equal(stale.error, 'source_changed');
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('provider policy is sent to the client and partitions cache and idempotency identity', async () => {
  let seenProvider: unknown;
  const dir = await mkdtemp(join(tmpdir(), 'semantic-provider-policy-'));
  tempDirs.push(dir);
  const cachePath = join(dir, 'semantic.sqlite');
  const client: EmbeddingClient = {
    async generate({ input, provider }) {
      seenProvider = provider;
      return responseFor(input);
    },
  };
  const { store, input } = setup({ cachePath, client });
  const semantic = new SemanticSearch({ store, cachePath, apiKey: () => 'test', clientFactory: () => client });
  try {
    const request = input();
    const result = await semantic.search(request);
    assert.equal(result.status, 'complete');
    assert.deepEqual(seenProvider, { only: ['deepinfra'], allowFallbacks: false });
    assert.deepEqual(result.model.providerPolicy, { only: ['deepinfra'], allowFallbacks: false });
    const expectedIntentHash = createHash('sha256')
      .update(
        JSON.stringify([
          request.project,
          request.revision,
          request.query,
          BGE_M3.canonical,
          BGE_M3_PROVIDER_POLICY.only,
          BGE_M3_PROVIDER_POLICY.allowFallbacks,
          request.allowPaid,
          request.budgetEstimateUsd,
        ]),
      )
      .digest('hex');
    const db = new DatabaseSync(cachePath);
    const intent = db
      .prepare('SELECT intent_hash FROM semantic_intents WHERE project=? AND idempotency_key=?')
      .get(request.project, request.idempotencyKey) as { intent_hash: string };
    const vectors = db.prepare('SELECT DISTINCT model FROM semantic_vectors').all() as Array<{ model: string }>;
    assert.equal(intent.intent_hash, expectedIntentHash);
    assert.ok(vectors.length > 0);
    assert.ok(vectors.every((row) => row.model === `${BGE_M3.canonical}|provider:deepinfra|fallbacks:false`));
    db.close();
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('installed OpenRouter embeddings SDK encodes provider pin using documented wire keys', () => {
  const encoded = JSON.parse(
    createEmbeddingsRequestBodyToJSON({
      model: BGE_M3.canonical,
      input: ['synthetic'],
      provider: { only: ['deepinfra'], allowFallbacks: false },
    }),
  ) as Record<string, unknown>;
  assert.deepEqual(encoded, {
    model: BGE_M3.canonical,
    input: ['synthetic'],
    provider: { only: ['deepinfra'], allow_fallbacks: false },
  });
  // The SDK's generated outbound serializer remaps this provider field after the call input is validated.
  assert.deepEqual(encoded.provider, { only: ['deepinfra'], allow_fallbacks: false });
});

test('fact cache key includes exact text even when a deleted key is recreated at version one', async () => {
  const seen: string[][] = [];
  let calls = 0;
  const client: EmbeddingClient = {
    async generate({ input }) {
      seen.push(input);
      calls++;
      return responseFor(input);
    },
  };
  const { store, semantic, input } = setup({ client });
  try {
    await semantic.search(input());
    const source = store.getSource({ project: 'p', revision: 'r1', path: 'facts.md' });
    assert.ok(source);
    store.deleteMemory({ project: 'p', key: 'language' });
    store.putMemory({ project: 'p', key: 'language', text: 'The user prefers Italian responses.', source });
    const next = await semantic.search(input({ idempotencyKey: 'corrected' }));
    assert.equal(calls, 2);
    assert.equal(next.candidates.find((c) => c.key === 'language')?.text, 'The user prefers Italian responses.');
    assert.ok(seen[1]?.includes('The user prefers Italian responses.'));
    assert.equal(seen[1]?.includes('The user prefers French responses.'), false);
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('query cache preserves exact case and bytes instead of folding distinct strings together', async () => {
  let calls = 0;
  const client: EmbeddingClient = {
    async generate({ input }) {
      calls++;
      return responseFor(input);
    },
  };
  const { store, semantic, input } = setup({ client });
  try {
    await semantic.search(input({ query: 'US' }));
    const lower = await semantic.search(input({ query: 'us', idempotencyKey: 'lower' }));
    assert.equal(lower.cache.queryHit, false);
    assert.equal(calls, 2);
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('private SQLite vector cache and completed idempotency result survive reopen with TTL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'semantic-cache-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'context.sqlite');
  const cachePath = join(dir, 'semantic.sqlite');
  let clock = 1000,
    calls = 0;
  const firstStore = new ContextStore({ dbPath, now: () => clock });
  firstStore.setProjectRevision('p', 'r');
  const source = firstStore.putSource({ project: 'p', revision: 'r', path: 'facts', content: 'facts' });
  firstStore.putMemory({ project: 'p', key: 'one', text: 'French is preferred.', source });
  const clientFactory = () => ({
    async generate({ input }: { input: string[] }) {
      calls++;
      return responseFor(input, { usage: { cost: 0.000001, totalTokens: 12 }, id: 'persistent-request' });
    },
  });
  const input = {
    project: 'p',
    revision: 'r',
    query: 'French preference',
    allowPaid: true as const,
    budgetEstimateUsd: 0.01,
    idempotencyKey: 'first',
  };
  const first = new SemanticSearch({
    store: firstStore,
    cachePath,
    apiKey: () => 'test',
    clientFactory,
    now: () => clock,
    cacheTtlMs: 60_000,
  });
  let original;
  try {
    original = await first.search(input);
    assert.equal(original.status, 'complete');
  } finally {
    await first.shutdown();
    firstStore.close();
  }
  const reopened = new ContextStore({ dbPath, now: () => clock });
  const second = new SemanticSearch({
    store: reopened,
    cachePath,
    apiKey: () => 'test',
    clientFactory,
    now: () => clock,
    cacheTtlMs: 60_000,
  });
  try {
    assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
    const warm = await second.search({ ...input, idempotencyKey: 'warm' });
    assert.equal(warm.cache.queryHit, true);
    assert.equal(calls, 1);
    assert.equal(warm.request.costUsd, 0);
    assert.equal(warm.request.usageTokens, 0);
    clock += 60_001;
    const replay = await second.search(input);
    assert.equal(replay.request.costUsd, 0.000001);
    assert.equal(replay.request.id, 'persistent-request');
    assert.equal(calls, 1);
    assert.deepEqual(replay, original);
    const expired = await second.search({ ...input, idempotencyKey: 'expired' });
    assert.equal(expired.cache.queryHit, false);
    assert.equal(calls, 2);
  } finally {
    await second.shutdown();
    reopened.close();
  }
});

test('completed idempotent result refuses to return facts after their source is corrected', async () => {
  let calls = 0;
  const client: EmbeddingClient = {
    async generate({ input }) {
      calls++;
      return responseFor(input);
    },
  };
  const { store, semantic, input } = setup({ client });
  try {
    const first = await semantic.search(input());
    assert.equal(first.status, 'complete');
    const corrected = store.putSource({
      project: 'p',
      revision: 'r1',
      path: 'facts.md',
      content: 'Corrected source snapshot.',
    });
    store.putMemory({ project: 'p', key: 'language', text: 'The user prefers Italian responses.', source: corrected });
    const replay = await semantic.search(input());
    assert.equal(replay.status, 'blocked');
    assert.equal(replay.error, 'source_changed');
    assert.equal(replay.candidates.length, 0);
    assert.equal(calls, 1);
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('fresh inventory is capped and reports truncation without claiming full coverage', async () => {
  const store = new ContextStore({ now: () => 1000 });
  store.setProjectRevision('p', 'r');
  const source = store.putSource({ project: 'p', revision: 'r', path: 'facts', content: 'source' });
  for (let i = 0; i < 66; i++)
    store.putMemory({ project: 'p', key: `fact-${String(i).padStart(2, '0')}`, text: `fact number ${i}`, source });
  let received = 0;
  const semantic = new SemanticSearch({
    store,
    apiKey: () => 'test',
    now: () => 1000,
    maxBudgetEstimateUsd: 0.1,
    clientFactory: () => ({
      async generate({ input }) {
        received = input.length;
        return responseFor(input);
      },
    }),
  });
  try {
    const result = await semantic.search({
      project: 'p',
      revision: 'r',
      query: 'fact query',
      allowPaid: true,
      budgetEstimateUsd: 0.1,
      idempotencyKey: 'cap',
    });
    assert.equal(result.coverage.totalFreshInventory, 66);
    assert.equal(result.coverage.considered, 64);
    assert.equal(result.coverage.truncated, true);
    assert.equal(result.candidates.length, 64);
    assert.equal(received, 65);
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('oversize memory facts are excluded with visible truncation rather than embedded', async () => {
  const store = new ContextStore({ maxMemoryBytes: 8192 });
  store.setProjectRevision('p', 'r');
  const source = store.putSource({ project: 'p', revision: 'r', path: 'facts', content: 'facts' });
  store.putMemory({ project: 'p', key: 'huge', text: 'x'.repeat(5000), source });
  let calls = 0;
  const semantic = new SemanticSearch({
    store,
    apiKey: () => 'test',
    clientFactory: () => ({
      async generate() {
        calls++;
        return responseFor([]);
      },
    }),
  });
  try {
    const result = await semantic.search({
      project: 'p',
      revision: 'r',
      query: 'query',
      allowPaid: true,
      budgetEstimateUsd: 0.01,
      idempotencyKey: 'oversize',
    });
    assert.equal(result.coverage.totalFreshInventory, 1);
    assert.equal(result.coverage.considered, 0);
    assert.equal(result.coverage.truncated, true);
    assert.equal(calls, 0);
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('empty searches still reserve idempotency keys and reject conflicting reuse', async () => {
  const { store, semantic, input, calls } = setup();
  try {
    store.deleteMemory({ project: 'p', key: 'language' });
    store.deleteMemory({ project: 'p', key: 'tooling' });
    const first = await semantic.search(input({ query: 'empty A' }));
    assert.equal(first.status, 'complete');
    assert.equal(first.candidates.length, 0);
    const conflict = await semantic.search(input({ query: 'empty B' }));
    assert.equal(conflict.status, 'blocked');
    assert.equal(conflict.error, 'prior_intent_conflict');
    assert.equal(calls(), 0);
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('at most sixteen searches are admitted and durable unknown intents are never pruned', async () => {
  let resolve!: (value: EmbeddingPayload) => void;
  let calls = 0;
  const client: EmbeddingClient = {
    generate: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  const { store, semantic, input } = setup({ client });
  try {
    const searches = Array.from({ length: 16 }, (_, i) => semantic.search(input({ idempotencyKey: `queued-${i}` })));
    await assert.rejects(semantic.search(input({ idempotencyKey: 'over-limit' })), /concurrency limit/);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 1);
    resolve(
      responseFor(['French language preference', 'The user prefers French responses.', 'The project uses pnpm.']),
    );
    const results = await Promise.all(searches);
    assert.ok(results.every((x) => x.status === 'complete'));
  } finally {
    await semantic.shutdown();
    store.close();
  }

  const dir = await mkdtemp(join(tmpdir(), 'semantic-cap-'));
  tempDirs.push(dir);
  const cachePath = join(dir, 'semantic.sqlite');
  const cap = setup({ cachePath });
  try {
    const db = new DatabaseSync(cachePath);
    db.exec('BEGIN IMMEDIATE;');
    const insert = db.prepare(
      'INSERT INTO semantic_intents(project,idempotency_key,intent_hash,status,created_at) VALUES (?,?,?,?,?)',
    );
    for (let i = 0; i < 1024; i++) insert.run('other', `reserved-${i}`, 'hash', 'unknown', i);
    db.exec('COMMIT;');
    db.close();
    const refused = await cap.semantic.search(cap.input({ idempotencyKey: 'over-capacity' }));
    assert.equal(refused.status, 'blocked');
    assert.equal(refused.error, 'intent_capacity');
    assert.equal(cap.calls(), 0);
    const verifyDb = new DatabaseSync(cachePath);
    const count = verifyDb.prepare('SELECT COUNT(*) AS n FROM semantic_intents').get() as { n: number };
    assert.equal(count.n, 1024);
    verifyDb.close();
  } finally {
    await cap.semantic.shutdown();
    cap.store.close();
  }
});

test('same-key concurrent searches coalesce and shutdown waits for the request', async () => {
  let resolve!: (value: EmbeddingPayload) => void;
  let calls = 0;
  const client: EmbeddingClient = {
    generate: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  const { store, semantic, input } = setup({ client });
  try {
    const a = semantic.search(input());
    const b = semantic.search(input());
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 1);
    let stopped = false;
    const stop = semantic.shutdown().then(() => {
      stopped = true;
    });
    await assert.rejects(semantic.search(input({ idempotencyKey: 'after-shutdown' })), /shutting down/);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(stopped, false);
    resolve(
      responseFor(['French language preference', 'The user prefers French responses.', 'The project uses pnpm.']),
    );
    assert.equal((await a).status, 'complete');
    assert.equal((await b).status, 'complete');
    await stop;
    assert.equal(stopped, true);
  } finally {
    store.close();
  }
});

test('shutdown rejects distinct queued searches before they can submit', async () => {
  let resolve!: (value: EmbeddingPayload) => void;
  let calls = 0;
  const client: EmbeddingClient = {
    generate: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  const { store, semantic, input } = setup({ client });
  try {
    const active = semantic.search(input({ idempotencyKey: 'active' }));
    const queued = Array.from({ length: 4 }, (_, i) =>
      semantic.search(input({ idempotencyKey: `queued-shutdown-${i}` })),
    );
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 1);
    const stop = semantic.shutdown();
    resolve(
      responseFor(['French language preference', 'The user prefers French responses.', 'The project uses pnpm.']),
    );
    assert.equal((await active).status, 'complete');
    const settled = await Promise.allSettled(queued);
    assert.ok(settled.every((x) => x.status === 'rejected' && /shutting down/.test(String(x.reason))));
    await stop;
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test('same in-flight idempotency key rejects a different query without another provider call', async () => {
  let resolve!: (value: EmbeddingPayload) => void;
  let calls = 0;
  const client: EmbeddingClient = {
    generate: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  const { store, semantic, input } = setup({ client });
  try {
    const pending = semantic.search(input());
    await new Promise((r) => setTimeout(r, 5));
    await assert.rejects(semantic.search(input({ query: 'different question' })), /idempotency key conflicts/);
    assert.equal(calls, 1);
    resolve(
      responseFor(['French language preference', 'The user prefers French responses.', 'The project uses pnpm.']),
    );
    assert.equal((await pending).status, 'complete');
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('source correction during provider wait discards candidates and blocks replay', async () => {
  let resolve!: (value: EmbeddingPayload) => void;
  const client: EmbeddingClient = {
    generate: () =>
      new Promise((r) => {
        resolve = r;
      }),
  };
  const { store, semantic, input, calls } = setup({ client });
  try {
    const pending = semantic.search(input());
    await new Promise((r) => setTimeout(r, 10));
    const corrected = store.putSource({
      project: 'p',
      revision: 'r1',
      path: 'facts.md',
      content: 'User corrected the preference to English.',
    });
    store.putMemory({ project: 'p', key: 'language', text: 'The user prefers English responses.', source: corrected });
    resolve(
      responseFor(['French language preference', 'The user prefers French responses.', 'The project uses pnpm.']),
    );
    const result = await pending;
    assert.equal(result.status, 'blocked');
    assert.equal(result.error, 'source_changed');
    assert.equal(result.candidates.length, 0);
    assert.equal(calls(), 0); // injected client counter is not used
    const again = await semantic.search(input());
    assert.equal(again.status, 'blocked');
    assert.equal(again.error, 'prior_intent_unknown');
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('ambiguous provider failure persists an intent and never blindly resubmits after reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'semantic-intent-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'context.sqlite');
  const cachePath = join(dir, 'semantic.sqlite');
  let calls = 0;
  const firstStore = new ContextStore({ dbPath, now: () => 1000 });
  firstStore.setProjectRevision('p', 'r');
  const ref = firstStore.putSource({ project: 'p', revision: 'r', path: 'a', content: 'fact' });
  firstStore.putMemory({ project: 'p', key: 'k', text: 'Fact text', source: ref });
  const first = new SemanticSearch({
    store: firstStore,
    cachePath,
    apiKey: () => 'test',
    now: () => 1000,
    clientFactory: () => ({
      async generate() {
        calls++;
        throw new Error('echo test-key raw details');
      },
    }),
  });
  const input = {
    project: 'p',
    revision: 'r',
    query: 'query fact',
    allowPaid: true as const,
    budgetEstimateUsd: 0.01,
    idempotencyKey: 'ambiguous',
  };
  try {
    const failed = await first.search(input);
    assert.equal(failed.error, 'provider_failed');
    assert.equal(failed.status, 'blocked');
    assert.equal(JSON.stringify(failed).includes('test-key'), false);
  } finally {
    await first.shutdown();
    firstStore.close();
  }
  const reopened = new ContextStore({ dbPath, now: () => 1000 });
  const second = new SemanticSearch({
    store: reopened,
    cachePath,
    apiKey: () => 'test',
    now: () => 1000,
    clientFactory: () => ({
      async generate() {
        calls++;
        return responseFor(['query fact', 'Fact text']);
      },
    }),
  });
  try {
    const blocked = await second.search(input);
    assert.equal(blocked.error, 'prior_intent_unknown');
    assert.equal(calls, 1);
  } finally {
    await second.shutdown();
    reopened.close();
  }
});

test('provider alias is accepted only when the same response id verifies the pinned model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'semantic-identity-'));
  tempDirs.push(dir);
  const cachePath = join(dir, 'semantic.sqlite');
  let verifyCalls = 0;
  let generated = 0;
  const client: EmbeddingClient = {
    async generate({ input }) {
      generated++;
      return responseFor(input, {
        id: 'alias-request',
        model: 'parasail-bge-m3',
        usage: { cost: 0.0000005, totalTokens: 11 },
      });
    },
    async verifyIdentity(id) {
      verifyCalls++;
      return { id, model: BGE_M3.canonical, providerName: 'DeepInfra', totalCost: 0.00000009, latencyMs: 297 };
    },
  };
  const { store, input } = setup({ cachePath, client });
  const semantic = new SemanticSearch({ store, cachePath, apiKey: () => 'test', clientFactory: () => client });
  try {
    const result = await semantic.search(input());
    assert.equal(result.status, 'complete');
    assert.equal(result.request.id, 'alias-request');
    assert.equal(result.request.responseModel, 'parasail-bge-m3');
    assert.equal(result.request.identitySource, 'generation_metadata');
    assert.equal(result.request.providerName, 'DeepInfra');
    assert.equal(result.request.costUsd, 0.00000009);
    assert.equal(result.request.authoritativeCostUsd, 0.00000009);
    assert.equal(verifyCalls, 1);
    assert.equal(generated, 1);
    const db = new DatabaseSync(cachePath);
    const row = db
      .prepare(
        'SELECT status,response_model,identity_source,provider_name,authoritative_cost_usd,cost_usd FROM semantic_intents WHERE idempotency_key=?',
      )
      .get('search-1') as Record<string, unknown>;
    assert.deepEqual(
      { ...row },
      {
        status: 'complete',
        response_model: 'parasail-bge-m3',
        identity_source: 'generation_metadata',
        provider_name: 'DeepInfra',
        authoritative_cost_usd: 0.00000009,
        cost_usd: 0.00000009,
      },
    );
    db.close();
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('identity metadata must match both request id and pinned canonical model', async () => {
  const proofs: IdentityProof[] = [
    { id: 'other-request', model: BGE_M3.canonical, providerName: 'DeepInfra', totalCost: 0.00000009 },
    { id: 'alias-request', model: 'parasail-bge-m3', providerName: 'Parasail', totalCost: 0.00000009 },
    { id: 'alias-request', model: BGE_M3.canonical, providerName: 'Parasail', totalCost: 0.00000009 },
  ];
  for (const [i, proof] of proofs.entries()) {
    const dir = await mkdtemp(join(tmpdir(), 'semantic-identity-reject-'));
    tempDirs.push(dir);
    const cachePath = join(dir, 'semantic.sqlite');
    let generated = 0;
    let verified = 0;
    const client: EmbeddingClient = {
      async generate({ input }) {
        generated++;
        return responseFor(input, {
          id: 'alias-request',
          model: 'provider-private-alias',
          usage: { cost: 0.000001, totalTokens: 8 },
        });
      },
      async verifyIdentity() {
        verified++;
        return proof;
      },
    };
    const { store, input } = setup({ cachePath, client });
    const semantic = new SemanticSearch({ store, cachePath, apiKey: () => 'test', clientFactory: () => client });
    try {
      const result = await semantic.search(input({ idempotencyKey: `mismatch-${i}` }));
      assert.equal(result.status, 'blocked');
      assert.equal(result.error, 'identity_unverified');
      assert.equal(result.request.costUsd, i === 0 ? 0.000001 : 0.00000009);
      assert.equal(result.request.identitySource, i === 0 ? undefined : 'generation_metadata');
      assert.equal(verified, 1);
      assert.equal(generated, 1);
      const replay = await semantic.search(input({ idempotencyKey: `mismatch-${i}` }));
      assert.equal(replay.error, 'prior_intent_unknown');
      assert.equal(generated, 1);
      const db = new DatabaseSync(cachePath);
      const row = db
        .prepare(
          'SELECT status,safe_error,response_model,identity_source,authoritative_cost_usd FROM semantic_intents WHERE idempotency_key=?',
        )
        .get(`mismatch-${i}`) as Record<string, unknown>;
      assert.equal(row.status, 'unknown');
      assert.equal(row.safe_error, 'identity_unverified');
      assert.equal(row.response_model, 'provider-private-alias');
      db.close();
    } finally {
      await semantic.shutdown();
      store.close();
    }
  }
});

test('metadata verification times out safely and preserves the provider receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'semantic-identity-timeout-'));
  tempDirs.push(dir);
  const cachePath = join(dir, 'semantic.sqlite');
  const client: EmbeddingClient = {
    async generate({ input }) {
      return responseFor(input, {
        id: 'timeout-request',
        model: 'provider-alias',
        usage: { cost: 0.000002, totalTokens: 9 },
      });
    },
    verifyIdentity: () => new Promise<IdentityProof>(() => {}),
  };
  const { store, input } = setup({ cachePath, client });
  const semantic = new SemanticSearch({ store, cachePath, apiKey: () => 'test', clientFactory: () => client });
  try {
    const result = await semantic.search(input());
    assert.equal(result.status, 'blocked');
    assert.equal(result.error, 'identity_unverified');
    assert.equal(result.request.costUsd, 0.000002);
    const db = new DatabaseSync(cachePath);
    const row = db
      .prepare('SELECT status,safe_error,cost_usd,response_model FROM semantic_intents WHERE idempotency_key=?')
      .get('search-1') as Record<string, unknown>;
    assert.deepEqual(
      { ...row },
      { status: 'unknown', safe_error: 'identity_unverified', cost_usd: 0.000002, response_model: 'provider-alias' },
    );
    db.close();
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('source changes during identity verification discard vectors and shutdown waits for verification', async () => {
  let resolveProof!: (proof: IdentityProof) => void;
  let verifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    verifyStarted = resolve;
  });
  const client: EmbeddingClient = {
    async generate({ input }) {
      return responseFor(input, {
        id: 'source-check-request',
        model: 'provider-alias',
        usage: { cost: 0.000003, totalTokens: 9 },
      });
    },
    verifyIdentity: (id) => {
      verifyStarted();
      return new Promise((resolve) => {
        resolveProof = resolve;
      });
    },
  };
  const { store, semantic, input } = setup({ client });
  try {
    const pending = semantic.search(input());
    await started;
    let shutdownDone = false;
    const shutdown = semantic.shutdown().then(() => {
      shutdownDone = true;
    });
    const changed = store.putSource({
      project: 'p',
      revision: 'r1',
      path: 'facts.md',
      content: 'Changed while metadata was being checked.',
    });
    store.putMemory({ project: 'p', key: 'language', text: 'The user prefers Italian responses.', source: changed });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shutdownDone, false);
    resolveProof({
      id: 'source-check-request',
      model: BGE_M3.canonical,
      providerName: 'DeepInfra',
      totalCost: 0.0000003,
    });
    const result = await pending;
    assert.equal(result.status, 'blocked');
    assert.equal(result.error, 'source_changed');
    assert.equal(result.request.costUsd, 0.0000003);
    await shutdown;
    assert.equal(shutdownDone, true);
    const replay = await semantic.search(input({ idempotencyKey: 'after-shutdown' })).catch((error) => error);
    assert.match(String(replay), /shutting down/);
  } finally {
    store.close();
  }
});

test('canonical response identity does not perform an extra metadata request', async () => {
  let verificationCalls = 0;
  const client: EmbeddingClient = {
    async generate({ input }) {
      return responseFor(input, { id: 'canonical-request' });
    },
    async verifyIdentity() {
      verificationCalls++;
      return undefined;
    },
  };
  const { store, semantic, input } = setup({ client });
  try {
    const result = await semantic.search(input());
    assert.equal(result.status, 'complete');
    assert.equal(result.request.identitySource, 'response_model');
    assert.equal(verificationCalls, 0);
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('malformed model/index/vector responses are rejected with bounded safe status', async () => {
  const invalids: Partial<EmbeddingPayload>[] = [
    {
      data: [
        { index: 0, embedding: vectorFor('q') },
        { index: 0, embedding: vectorFor('f1') },
        { index: 2, embedding: vectorFor('f2') },
      ],
    },
    {
      data: [
        { index: 0, embedding: new Array(1024).fill(Number.NaN) },
        { index: 1, embedding: vectorFor('f1') },
        { index: 2, embedding: vectorFor('f2') },
      ],
    },
    {
      data: [
        { index: 0, embedding: new Array(1024).fill(0) },
        { index: 1, embedding: vectorFor('f1') },
        { index: 2, embedding: vectorFor('f2') },
      ],
    },
    {
      data: [
        { index: 0, embedding: new Array(1023).fill(1) },
        { index: 1, embedding: vectorFor('f1') },
        { index: 2, embedding: vectorFor('f2') },
      ],
    },
  ];
  for (const [i, update] of invalids.entries()) {
    const dir = await mkdtemp(join(tmpdir(), 'semantic-receipt-'));
    tempDirs.push(dir);
    const cachePath = join(dir, 'semantic.sqlite');
    const { store, input } = setup({ cachePath });
    const semantic = new SemanticSearch({
      store,
      cachePath,
      apiKey: () => 'secret',
      clientFactory: () => ({
        async generate({ input }) {
          return responseFor(input, { ...update, usage: { cost: 0.00001, totalTokens: 7 } });
        },
      }),
    });
    try {
      const result = await semantic.search(input({ idempotencyKey: `invalid-${i}` }));
      assert.equal(result.status, 'blocked');
      assert.equal(result.error, 'invalid_response');
      const receiptDb = new DatabaseSync(cachePath);
      const receipt = receiptDb
        .prepare('SELECT status,cost_usd FROM semantic_intents WHERE project=? AND idempotency_key=?')
        .get('p', `invalid-${i}`) as { status: string; cost_usd: number | null };
      assert.equal(receipt.status, 'unknown');
      assert.equal(receipt.cost_usd, 0.00001);
      receiptDb.close();
    } finally {
      await semantic.shutdown();
      store.close();
    }
  }
});

test('paid search requires explicit approval, a bounded estimate, and available key', async () => {
  const { store, input } = setup({ key: '' });
  const semantic = new SemanticSearch({
    store,
    apiKey: () => undefined,
    clientFactory: () => {
      throw new Error('must not call');
    },
  });
  try {
    assert.throws(() => semantic.search(input({ allowPaid: false as true })), /allowPaid/);
    const over = await semantic.search(input({ budgetEstimateUsd: 0.01001, idempotencyKey: 'over-budget' }));
    assert.equal(over.status, 'denied');
    assert.equal(over.error, 'budget_ceiling');
    const denied = await semantic.search(input({ idempotencyKey: 'missing-key' }));
    assert.equal(denied.status, 'denied');
    assert.equal(denied.error, 'missing_key');
  } finally {
    await semantic.shutdown();
    store.close();
  }
});

test('invalid timeout, TTL, and configured budget ceilings are rejected', () => {
  const store = new ContextStore();
  try {
    assert.throws(() => new SemanticSearch({ store, apiKey: () => undefined, timeoutMs: Number.NaN }), /timeoutMs/);
    assert.throws(() => new SemanticSearch({ store, apiKey: () => undefined, cacheTtlMs: Number.NaN }), /cacheTtlMs/);
    assert.throws(
      () => new SemanticSearch({ store, apiKey: () => undefined, maxBudgetEstimateUsd: 0.11 }),
      /at most \$0.10/,
    );
  } finally {
    store.close();
  }
});
