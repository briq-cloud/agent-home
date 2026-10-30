import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouter } from '@openrouter/sdk';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Routing, normalizeCatalog, normalizeEvidence, normalizePerformance, portfolio } from '../src/routing/index.ts';
import type { Binding, Candidate, DecisionClient, RoutingOptions } from '../src/routing/index.ts';

const START = Date.parse('2026-10-30T10:00:00Z');
const binding = (extra: Partial<Binding> = {}): Binding => ({
  id: 'included',
  cli: 'claude',
  harness: 'claude',
  provider: 'anthropic',
  billing: 'subscription',
  signedIn: true,
  compatibility: 'verified',
  model: 'vendor/exact',
  canonical: 'vendor/exact-20261001',
  ...extra,
});
const catalog = {
  data: [
    {
      id: 'vendor/exact',
      canonical_slug: 'vendor/exact-20261001',
      context_length: 100000,
      architecture: { input_modalities: ['text'] },
      supported_parameters: ['tools'],
      pricing: { prompt: '0.000001', completion: '0.000002' },
    },
  ],
};
const evidence = {
  meta: { as_of: new Date(START).toISOString(), citation: 'primary benchmark source' },
  data: [
    {
      source: 'artificial-analysis',
      model_permaslug: 'vendor/exact-20261001',
      display_name: 'Exact (high)',
      intelligence_index: 50,
      coding_index: 60,
      agentic_index: 40,
    },
  ],
};
const endpoint = {
  data: {
    id: 'vendor/exact',
    endpoints: [
      { tag: 'a', status: 0, latency_last_30m: { p50: 100, p90: 300 }, throughput_last_30m: { p50: 20 } },
      { tag: 'b', status: 0, latency_last_30m: { p50: 200, p90: 400 }, throughput_last_30m: { p50: 40 } },
    ],
  },
};
async function setup(t: TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), 'model-routing-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let now = START,
    bindings = [binding()],
    metadataFails = false,
    decisions = 0;
  const requests: string[] = [];
  let result: unknown = {
    model: 'cloudflare/clef-flash',
    usage: { cost: 0.001 },
    answers: { type: { choice: 'change' }, route: { choice: 'included' } },
  };
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (metadataFails) return new Response('{}', { status: 503 });
    return Response.json(url.endsWith('/endpoints') ? endpoint : url.includes('/benchmarks') ? evidence : catalog);
  };
  const decisionClient: RoutingOptions['decisionClient'] = () => ({
    alpha: {
      decisions: {
        async create() {
          decisions++;
          return result;
        },
      },
    },
  });
  const options: RoutingOptions = {
    stateDir,
    availability: async () => ({ checkedAt: new Date(now).toISOString(), bindings }),
    openRouterKey: () => 'secret-test-key',
    decisionClient,
    dynamic: true,
    fetcher,
    now: () => now,
  };
  return {
    stateDir,
    options,
    requests,
    decisionClient,
    now: (value: number) => {
      now = value;
    },
    bindings: (value: Binding[]) => {
      bindings = value;
    },
    failMetadata: () => {
      metadataFails = true;
    },
    result: (value: unknown) => {
      result = value;
    },
    decisions: () => decisions,
  };
}

test('static subscription selection needs no key, metadata or decision call', async (t) => {
  const h = await setup(t);
  const route = await new Routing({
    ...h.options,
    dynamic: false,
    openRouterKey: () => {
      throw Error('must not read key');
    },
  }).select({ task: 'work' });
  assert.equal(route.cli, 'claude');
  assert.equal(route.source, 'subscription');
  assert.equal(h.requests.length, 0);
  assert.equal(h.decisions(), 0);
});
test('pinned sessions and explicit routes bypass classification', async (t) => {
  const h = await setup(t),
    routing = new Routing(h.options);
  assert.deepEqual(await routing.select({ task: '', pinned: { cli: 'original', model: 'native' } }), {
    cli: 'original',
    model: 'native',
    source: 'pinned',
  });
  const route = await routing.select({ task: 'work', explicit: { cli: 'claude' } });
  assert.equal(route.source, 'explicit');
  assert.equal(h.decisions(), 0);
  assert.equal(h.requests.length, 0);
});
test('dynamic opt-in also requires explicit decision budget', async (t) => {
  const h = await setup(t);
  const route = await new Routing(h.options).select({ task: 'work' });
  assert.equal(route.source, 'subscription');
  assert.equal(h.requests.length, 0);
  assert.equal(h.decisions(), 0);
});
test('fresh exact models are selected through typed decision client', async (t) => {
  const h = await setup(t);
  const route = await new Routing(h.options).select({ task: 'Implement tests', decisionBudgetUsd: 0.01 });
  assert.equal(route.source, 'decision');
  assert.equal(route.type, 'change');
  assert.equal(route.decisionCostUsd, 0.001);
  assert.equal(route.candidates?.length, 5);
  const change = route.candidates?.find((p) => p.type === 'change')?.candidates[0];
  assert.equal(change?.intelligence, 50);
  assert.equal(change?.taskQualityPrior, 60);
  assert.equal(change?.estimatedRequestUsd, null);
  assert.equal(change?.evidence?.indexVersion, null);
  assert.equal(change?.performance?.tokensPerSecond, 30);
  assert.match(change?.performance?.aggregation ?? '', /unweighted/);
  const text = await readFile(join(h.stateDir, 'routing', 'catalog.json'), 'utf8');
  assert.ok(!text.includes('secret-test-key'));
});
test('subscription-first excludes metered alternatives, even with paid opt-in', async (t) => {
  const h = await setup(t);
  h.bindings([binding(), binding({ id: 'paid', cli: 'openrouter-claude', billing: 'use', provider: 'openrouter' })]);
  let observed: unknown;
  const client: DecisionClient = {
    alpha: {
      decisions: {
        async create(request) {
          observed = request;
          return {
            usage: { cost: 0 },
            answers: { type: { choice: 'change' }, route: { choice: 'included' } },
          };
        },
      },
    },
  };
  await new Routing({ ...h.options, decisionClient: () => client }).select({
    task: 'work',
    decisionBudgetUsd: 0.01,
    allowPaidApi: true,
    maxEstimatedUsd: 1,
  });
  assert.ok(!JSON.stringify(observed).includes('openrouter-claude'));
});
test('daily catalog/intelligence and five minute performance caches survive instances', async (t) => {
  const h = await setup(t),
    request = { task: 'work', decisionBudgetUsd: 0.01 };
  await new Routing(h.options).select(request);
  assert.equal(h.requests.length, 3);
  await new Routing(h.options).select(request);
  assert.equal(h.requests.length, 3);
  h.now(START + 300001);
  await new Routing(h.options).select(request);
  assert.equal(h.requests.length, 4);
  assert.ok(h.requests[3]?.endsWith('/endpoints'));
  h.now(START + 86400001);
  await new Routing(h.options).select(request);
  assert.equal(h.requests.length, 7);
  assert.ok(!(await readdir(join(h.stateDir, 'routing'))).some((p) => p.endsWith('.tmp')));
});
test('stale failed metadata retains disk snapshot but closes dynamic routing', async (t) => {
  const h = await setup(t),
    routing = new Routing(h.options),
    request = { task: 'work', decisionBudgetUsd: 0.01 };
  await routing.select(request);
  const old = await readFile(join(h.stateDir, 'routing', 'catalog.json'), 'utf8');
  h.now(START + 86400001);
  h.failMetadata();
  const route = await routing.select(request);
  assert.equal(route.source, 'subscription');
  assert.equal(h.decisions(), 1);
  assert.equal(await readFile(join(h.stateDir, 'routing', 'catalog.json'), 'utf8'), old);
});
test('exact canonical mismatch never inherits benchmark evidence or dynamic eligibility', async (t) => {
  const h = await setup(t);
  h.bindings([binding({ canonical: 'vendor/another-version' })]);
  const route = await new Routing(h.options).select({ task: 'work', decisionBudgetUsd: 0.01 });
  assert.equal(route.source, 'subscription');
  assert.equal(h.decisions(), 0);
  assert.deepEqual(
    normalizeEvidence(
      { ...evidence, data: [{ ...evidence.data[0], model_permaslug: 'vendor/another-version' }] },
      normalizeCatalog(catalog),
    ),
    [],
  );
});
test('unknown metrics remain null; endpoint pin does not borrow a different provider speed', () => {
  const speed = normalizePerformance(endpoint, 'vendor/exact', 'missing', new Date(START).toISOString());
  assert.equal(speed.endpointCount, 0);
  assert.equal(speed.tokensPerSecond, null);
  const e = normalizeEvidence(
    { ...evidence, data: [{ ...evidence.data[0], intelligence_index: undefined }] },
    normalizeCatalog(catalog),
  )[0];
  assert.equal(e?.intelligence, null);
  assert.equal(e?.scores.review, null);
});
test('unknown sign-in, quota blocks, restrictions and stale availability are rejected', async (t) => {
  const h = await setup(t);
  for (const extra of [{ signedIn: null }, { quotaBlocked: true }, { healthy: false }] as Partial<Binding>[]) {
    h.bindings([binding(extra)]);
    await assert.rejects(new Routing({ ...h.options, dynamic: false }).select({ task: 'work' }), /no eligible/);
  }
  h.bindings([binding()]);
  await assert.rejects(new Routing(h.options).select({ task: 'work', allowedRouteIds: [] }), /no eligible/);
  await assert.rejects(
    new Routing({
      ...h.options,
      availability: async () => ({ checkedAt: new Date(START - 60001).toISOString(), bindings: [binding()] }),
    }).select({ task: 'work' }),
    /stale/,
  );
});
test('paid defaults require opt-in and enforce known request estimate', async (t) => {
  const h = await setup(t);
  h.bindings([binding({ id: 'paid', cli: 'openrouter-claude', billing: 'use', provider: 'openrouter' })]);
  const routing = new Routing({ ...h.options, dynamic: false, defaultRouteId: 'paid' });
  await assert.rejects(routing.select({ task: 'work', maxEstimatedUsd: 1 }), /no eligible/);
  await assert.rejects(routing.select({ task: 'work', allowPaidApi: true, maxEstimatedUsd: 0.001 }), /budget/);
  assert.equal((await routing.select({ task: 'work', allowPaidApi: true, maxEstimatedUsd: 1 })).source, 'default');
});
test('unknown decision cost cannot silently fall through to a paid default', async (t) => {
  const h = await setup(t);
  h.bindings([binding({ id: 'paid', cli: 'openrouter-claude', billing: 'use', provider: 'openrouter' })]);
  h.result({ usage: {}, answers: { type: { choice: 'change' }, route: { choice: 'paid' } } });
  await assert.rejects(
    new Routing({ ...h.options, defaultRouteId: 'paid' }).select({
      task: 'work',
      allowPaidApi: true,
      maxEstimatedUsd: 1,
      decisionBudgetUsd: 0.01,
    }),
    /no eligible/,
  );
});
test('invalid decision choices abstain and revalidation prevents a changed profile dispatch', async (t) => {
  const h = await setup(t),
    routing = new Routing(h.options);
  h.result({ usage: { cost: 0.001 }, answers: { type: { choice: 'invented' }, route: { choice: 'included' } } });
  assert.equal((await routing.select({ task: 'work', decisionBudgetUsd: 0.01 })).source, 'subscription');
  const client: DecisionClient = {
    alpha: {
      decisions: {
        async create() {
          h.bindings([binding({ model: 'changed' })]);
          return { usage: { cost: 0.001 }, answers: { type: { choice: 'change' }, route: { choice: 'included' } } };
        },
      },
    },
  };
  const route = await new Routing({ ...h.options, decisionClient: () => client }).select({
    task: 'work',
    decisionBudgetUsd: 0.01,
  });
  assert.equal(route.source, 'subscription');
  assert.equal(route.model, 'changed');
  assert.match(route.reason ?? '', /changed/);
});
test('expired deadlines, unknown hard context requirements and negative limits fail', async (t) => {
  const h = await setup(t),
    routing = new Routing(h.options);
  await assert.rejects(routing.select({ task: 'work', deadlineUtc: new Date(START).toISOString() }), /deadline/);
  await assert.rejects(routing.select({ task: 'work', minContext: 100 }), /no eligible/);
  await assert.rejects(routing.select({ task: 'work', outputTokens: -1 }), /finite/);
});
test('each task portfolio is capped at five even with many complementary candidates', () => {
  const candidates: Candidate[] = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    cli: 'claude',
    model: String(i),
    canonical: String(i),
    billing: 'subscription',
    intelligence: null,
    estimatedRequestUsd: null,
    taskQualityPrior: null,
    evidence: null,
    performance: null,
  }));
  assert.equal(portfolio('change', candidates).candidates.length, 5);
});
test('corrupt cache cannot become evidence', async (t) => {
  const h = await setup(t),
    routing = new Routing(h.options);
  await routing.select({ task: 'work', decisionBudgetUsd: 0.01 });
  await writeFile(join(h.stateDir, 'routing', 'catalog.json'), '{corrupt');
  h.failMetadata();
  const route = await routing.select({ task: 'work', decisionBudgetUsd: 0.01 });
  assert.equal(route.source, 'subscription');
  assert.equal(h.decisions(), 1);
});

test('decision interface accepts the installed official OpenRouter SDK without making a call', () => {
  const client: DecisionClient = new OpenRouter({ apiKey: 'not-used', retryConfig: { strategy: 'none' } });
  assert.equal(typeof client.alpha.decisions.create, 'function');
});

test('explicit unpriced non-OpenRouter route requires paid opt-in and rejects price caps', async (t) => {
  const h = await setup(t);
  h.bindings([
    binding({
      id: 'gemini',
      cli: 'gemini',
      provider: 'google',
      billing: 'use',
      model: undefined,
      canonical: undefined,
    }),
  ]);
  const routing = new Routing(h.options);
  await assert.rejects(routing.select({ task: 'work', explicit: { cli: 'gemini' } }), /unavailable or disallowed/);
  const route = await routing.select({ task: 'work', explicit: { cli: 'gemini' }, allowPaidApi: true });
  assert.equal(route.source, 'explicit');
  assert.equal(route.reason, 'unpriced explicit route; cost unknown');
  assert.equal(h.requests.length, 0);
  assert.equal(h.decisions(), 0);
  await assert.rejects(
    routing.select({ task: 'work', explicit: { cli: 'gemini' }, allowPaidApi: true, maxEstimatedUsd: 1 }),
    /paid route requires/,
  );
});
