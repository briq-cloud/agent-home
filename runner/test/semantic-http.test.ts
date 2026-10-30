import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Application } from '../src/app/services.ts';
import { configuration } from '../src/app/config.ts';
import { Hub } from '../src/acp/hub.ts';
import { Keys } from '../src/providers/profiles.ts';
import { BGE_M3, type EmbeddingClient, type EmbeddingPayload } from '../src/context/semantic.ts';

function vectorResponse(input: string[]): EmbeddingPayload {
  return {
    id: 'synthetic-embedding-receipt',
    model: BGE_M3.canonical,
    data: input.map((_, index) => ({ index, embedding: [1, ...Array<number>(1023).fill(0)] })),
    usage: { cost: 0.000001, totalTokens: 15 },
  };
}
async function request(
  app: Application,
  method: string,
  path: string,
  body: () => Promise<Record<string, unknown>> = async () => ({}),
) {
  let code = 0,
    result: any;
  const response = {
    writeHead: (status: number) => {
      code = status;
    },
    end: (value: string) => {
      result = JSON.parse(value);
    },
  };
  assert.equal(
    await app.http(
      { method } as IncomingMessage,
      response as unknown as ServerResponse,
      new URL(path, 'http://localhost'),
      body,
    ),
    true,
  );
  return { code, result };
}
function fixture(t: TestContext, extra: { env?: NodeJS.ProcessEnv; client?: EmbeddingClient; key?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'semantic-http-'));
  const config = configuration({
    RUNNER_CWD: root,
    RUNNER_STATE: join(root, 'state'),
    RUNNER_DYNAMIC_ROUTING: '0',
    RUNNER_SEMANTIC_MEMORY: '1',
    ...extra.env,
  });
  const keys = new Keys({ keysFile: join(root, 'keys.json'), profilesFile: join(root, 'profiles.json'), logins: root });
  if (extra.key !== false) keys.putKey('openrouter', 'synthetic-http-key');
  let calls = 0;
  const payloads: string[][] = [];
  const client: EmbeddingClient = {
    generate: async (input, options) => {
      calls++;
      payloads.push(input.input);
      assert.equal(input.model, BGE_M3.canonical);
      assert.equal(options.retries.strategy, 'none');
      return extra.client ? extra.client.generate(input, options) : vectorResponse(input.input);
    },
  };
  const make = () =>
    new Application({
      config,
      keys,
      hub: new Hub({ clis: [], env: {}, cwd: root, stateDir: config.stateDir, maxTurns: 2 }),
      table: () => [],
      signedIn: async () => false,
      authEnv: {},
      semanticClientFactory: (key) => {
        assert.equal(key, 'synthetic-http-key');
        return client;
      },
    });
  let app = make();
  const seed = (project = 'home', key = 'current', text = 'Alpha current project fact') => {
    const directory = project === 'home' ? root : join(root, project);
    mkdirSync(directory, { recursive: true });
    app.projects.put({ id: project, root: directory, revision: 'r1' });
    app.context.setProjectRevision(project, 'r1');
    const source = app.context.putSource({ project, revision: 'r1', path: `${key}.md`, content: text });
    app.context.putMemory({ project, key, text, source });
    return source;
  };
  t.after(async () => {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    config,
    keys,
    seed,
    calls: () => calls,
    payloads,
    get app() {
      return app;
    },
    restart: async () => {
      await app.stop();
      app = make();
    },
    search: (input: Record<string, unknown> = {}) =>
      request(app, 'POST', '/memories/search', async () => ({
        projectId: 'home',
        revision: 'r1',
        query: 'Alpha fact',
        allowPaid: true,
        budgetEstimateUsd: 0.01,
        idempotencyKey: 'one-search',
        ...input,
      })),
  };
}

test('semantic configuration is opt-in, requires memory, and bounds the estimate ceiling', () => {
  assert.equal(configuration({}).semanticMemory, false);
  assert.equal(configuration({}).semanticMemoryMaxEstimatedUsd, 0.01);
  assert.equal(configuration({ RUNNER_SEMANTIC_MEMORY_MAX_ESTIMATED_USD: '0.1' }).semanticMemoryMaxEstimatedUsd, 0.1);
  assert.throws(() => configuration({ RUNNER_MEMORY: '0', RUNNER_SEMANTIC_MEMORY: '1' }), /requires RUNNER_MEMORY/);
  for (const value of ['0', '-1', 'NaN', '0.10001'])
    assert.throws(() => configuration({ RUNNER_SEMANTIC_MEMORY_MAX_ESTIMATED_USD: value }));
});

test('disabled semantic search creates no cache/client and refuses before reading a body', async (t) => {
  const h = fixture(t, { env: { RUNNER_SEMANTIC_MEMORY: '0' } });
  assert.equal(h.app.semantic, undefined);
  assert.equal(existsSync(join(h.config.stateDir, 'semantic.sqlite')), false);
  const features = await request(h.app, 'GET', '/features');
  assert.equal(features.result.semanticMemory, false);
  const denied = await request(h.app, 'POST', '/memories/search', async () => {
    throw Error('body must not be read');
  });
  assert.deepEqual(denied, { code: 403, result: { status: 'denied', error: 'semantic_memory_disabled' } });
  assert.equal(h.calls(), 0);
});

test('strict consent, bounds and registered/current revision guards precede semantic work', async (t) => {
  const h = fixture(t);
  h.seed();
  let moduleCalls = 0;
  const search = h.app.semantic!.search.bind(h.app.semantic);
  h.app.semantic!.search = (input) => {
    moduleCalls++;
    return search(input);
  };
  for (const input of [
    { allowPaid: false },
    { allowPaid: undefined },
    { budgetEstimateUsd: 0 },
    { budgetEstimateUsd: 0.2 },
    { idempotencyKey: 'not allowed' },
    { query: '' },
    { query: '😀'.repeat(2048) },
    { apiKey: 'PRIVATE-UNEXPECTED-INPUT' },
  ]) {
    const denied = await h.search(input);
    assert.deepEqual(denied, { code: 400, result: { status: 'denied', error: 'invalid_request' } });
  }
  for (const input of [{ projectId: 'unknown' }, { revision: 'old' }])
    assert.deepEqual(await h.search(input), {
      code: 400,
      result: { status: 'denied', error: 'invalid_project_or_revision' },
    });
  h.app.context.setProjectRevision('home', 'different-revision');
  assert.equal((await h.search()).code, 400);
  assert.equal(moduleCalls, 0);
  assert.equal(h.calls(), 0);
});

test('semantic HTTP returns only fresh scoped citations and preserves receipts/cache across app restart', async (t) => {
  const h = fixture(t);
  h.seed();
  h.seed('foreign', 'foreign', 'Private other project fact');
  const stale = h.seed('home', 'stale', 'Alpha obsolete fact');
  h.app.context.putSource({ project: 'home', revision: 'r1', path: stale.path, content: 'Corrected policy' });
  const features = await request(h.app, 'GET', '/features');
  assert.equal(features.result.semanticMemory, true);
  assert.equal(features.result.semanticMemoryMaxEstimatedUsd, 0.01);
  const first = await h.search();
  assert.equal(first.code, 200);
  assert.equal(first.result.status, 'complete');
  assert.deepEqual(
    first.result.candidates.map((candidate: any) => candidate.key),
    ['current'],
  );
  assert.equal(first.result.candidates[0].trust, 'untrusted');
  assert.equal(first.result.candidates[0].scoreMeaning, 'cosine similarity; not confidence');
  assert.equal(first.result.request.costUsd, 0.000001);
  assert.equal(
    h.payloads.flat().some((text) => /obsolete|Private other/.test(text)),
    false,
  );
  assert.equal((await h.search()).result.request.id, first.result.request.id);
  assert.equal(h.calls(), 1);
  assert.equal(statSync(join(h.config.stateDir, 'semantic.sqlite')).mode & 0o777, 0o600);
  await h.restart();
  assert.deepEqual((await h.search()).result, first.result);
  assert.equal(h.calls(), 1, 'exact replay after restart cannot make another provider request');
  const warm = await h.search({ idempotencyKey: 'warm-search' });
  assert.equal(warm.code, 200);
  assert.equal(warm.result.cache.queryHit, true);
  assert.equal(warm.result.request.costUsd, 0);
  assert.equal(h.calls(), 1);
  const conflict = await h.search({ query: 'different intent' });
  assert.equal(conflict.code, 409);
  assert.equal(conflict.result.error, 'prior_intent_conflict');
  assert.equal(JSON.stringify([first, warm, conflict]).includes('synthetic-http-key'), false);
});

test('missing keys and estimates are denied; provider exceptions become fixed safe blocked results', async (t) => {
  const noKey = fixture(t, { key: false });
  noKey.seed();
  const missing = await noKey.search();
  assert.equal(missing.code, 400);
  assert.equal(missing.result.error, 'missing_key');
  assert.equal(noKey.calls(), 0);
  const h = fixture(t, {
    client: {
      generate: async () => {
        throw Error('PRIVATE-PROVIDER-DIAGNOSTIC synthetic-http-key');
      },
    },
  });
  h.seed();
  const over = await h.search({ budgetEstimateUsd: 0.02 });
  assert.equal(over.code, 400);
  assert.equal(over.result.error, 'budget_ceiling');
  assert.equal(h.calls(), 0);
  const blocked = await h.search();
  assert.equal(blocked.code, 409);
  assert.equal(blocked.result.error, 'provider_failed');
  assert.ok(!JSON.stringify(blocked).includes('PRIVATE-PROVIDER-DIAGNOSTIC'));
  assert.ok(!JSON.stringify(blocked).includes('synthetic-http-key'));
});

test('shutdown cancels engine immediately, waits admitted semantic work, and rejects requests before/after body', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = fixture(t, {
    client: {
      generate: async ({ input }) => {
        await gate;
        return vectorResponse(input);
      },
    },
  });
  h.seed();
  const active = h.search();
  while (!h.calls()) await new Promise((resolve) => setImmediate(resolve));
  let engineStopped = false,
    contextClosed = false;
  const engineStop = h.app.engine.stop.bind(h.app.engine),
    contextClose = h.app.context.close.bind(h.app.context);
  h.app.engine.stop = () => {
    engineStopped = true;
    return engineStop();
  };
  h.app.context.close = () => {
    contextClosed = true;
    contextClose();
  };
  let finishBody!: (value: Record<string, unknown>) => void;
  const delayedBody = request(
    h.app,
    'POST',
    '/memories/search',
    () =>
      new Promise((resolve) => {
        finishBody = resolve;
      }),
  );
  const stopping = h.app.stop();
  assert.equal(h.app.stop(), stopping);
  assert.equal(engineStopped, true);
  assert.equal(contextClosed, false);
  assert.deepEqual(
    await request(h.app, 'POST', '/memories/search', async () => {
      throw Error('must not read');
    }),
    { code: 503, result: { status: 'blocked', error: 'runner_stopping' } },
  );
  finishBody({});
  assert.equal((await delayedBody).code, 503);
  assert.equal(h.calls(), 1);
  release();
  assert.equal((await active).code, 200);
  await stopping;
  assert.equal(contextClosed, true);
});

test('HTTP idempotency coalesces identical searches and maps live conflicts to a fixed safe blocked response', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = fixture(t, {
    client: {
      generate: async ({ input }) => {
        await gate;
        return vectorResponse(input);
      },
    },
  });
  h.seed();
  const first = h.search(),
    repeat = h.search();
  while (!h.calls()) await new Promise((resolve) => setImmediate(resolve));
  const conflict = await h.search({ query: 'Conflicting query' });
  assert.deepEqual(conflict, { code: 409, result: { status: 'blocked', error: 'semantic_search_unavailable' } });
  assert.equal(h.calls(), 1);
  release();
  assert.deepEqual(await repeat, await first);
  assert.equal(h.calls(), 1);
});

test('source correction during HTTP search blocks stale candidates while retaining the provider receipt and forbidding replay', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = fixture(t, {
    client: {
      generate: async ({ input }) => {
        await gate;
        return vectorResponse(input);
      },
    },
  });
  const source = h.seed();
  const pending = h.search();
  while (!h.calls()) await new Promise((resolve) => setImmediate(resolve));
  h.app.context.putSource({
    project: 'home',
    revision: 'r1',
    path: source.path,
    content: 'Corrected source while provider was pending',
  });
  release();
  const stale = await pending;
  assert.equal(stale.code, 409);
  assert.equal(stale.result.error, 'source_changed');
  assert.deepEqual(stale.result.candidates, []);
  assert.equal(stale.result.request.costUsd, 0.000001);
  const replay = await h.search();
  assert.equal(replay.code, 409);
  assert.equal(replay.result.error, 'prior_intent_unknown');
  assert.equal(h.calls(), 1);
});
