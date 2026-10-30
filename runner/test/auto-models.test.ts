import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareAutoProfiles,
  CURATED_AUTO_MODELS,
  DEFAULT_AUTO_PROFILE,
  AUTO_POOL_SOURCE,
} from '../src/providers/auto-models.ts';
import type { Profile } from '../src/providers/profiles.ts';

function catalog() {
  return {
    data: CURATED_AUTO_MODELS.map(({ model }) => ({
      id: model as string,
      canonical_slug: `${model}-canonical`,
      context_length: 100_000,
      architecture: { input_modalities: ['text'] },
      supported_parameters: ['tools'],
      pricing: { prompt: '0.000001', completion: '0.000002' },
    })),
  };
}
function keys(initial: Profile[] = []) {
  let profiles = structuredClone(initial);
  const writes: Profile[] = [];
  return {
    profiles: () => structuredClone(profiles),
    writes,
    putProfile(profile: Profile) {
      writes.push(profile);
      profiles = [...profiles.filter((existing) => existing.name !== profile.name), profile];
    },
  };
}
const fetchCatalog =
  (body: unknown): typeof fetch =>
  async () =>
    Response.json(body);

test('Save Auto creates only the four exact curated Claude profiles from public catalog metadata', async () => {
  const store = keys();
  let called = 0;
  const fetcher: typeof fetch = async (url, options) => {
    called++;
    assert.equal(url, 'https://openrouter.ai/api/v1/models');
    assert.equal(options?.method, 'GET');
    assert.equal(options?.headers, undefined, 'metadata request must not receive a provider key');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options?.redirect, 'error');
    return Response.json(catalog());
  };
  const result = await prepareAutoProfiles({ keys: store, claudeAvailable: true, fetcher });
  assert.equal(called, 1);
  assert.deepEqual(result.unavailable, []);
  assert.equal(result.source, AUTO_POOL_SOURCE);
  assert.equal(DEFAULT_AUTO_PROFILE, 'openrouter-claude-haiku');
  assert.deepEqual(
    result.created.map((profile) => profile.model),
    ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash-1017', 'z-ai/glm-5.3'],
  );
  assert.deepEqual(
    result.created.map((profile) => profile.name),
    ['openrouter-claude-sonnet', 'openrouter-claude-haiku', 'openrouter-claude-deepseek', 'openrouter-claude-glm'],
  );
  assert.ok(
    result.created.every(
      (profile) =>
        profile.provider === 'openrouter' &&
        profile.harness === 'claude' &&
        profile.autoEligible === true &&
        profile.canonical === `${profile.model}-canonical`,
    ),
  );
});

test('existing user profiles, changed canonical pins and existing defaults are never overwritten', async () => {
  const initial: Profile[] = [
    {
      name: 'openrouter-claude-sonnet',
      provider: 'openrouter',
      harness: 'claude',
      model: 'operator/custom-model',
      canonical: 'operator/pinned-version',
      autoEligible: false,
    },
    { name: 'openrouter-claude', provider: 'openrouter', harness: 'claude', model: 'openrouter/auto' },
  ];
  const store = keys(initial);
  const first = await prepareAutoProfiles({ keys: store, claudeAvailable: true, fetcher: fetchCatalog(catalog()) });
  assert.equal(first.created.length, 3);
  assert.equal(store.writes.length, 3);
  for (const profile of initial)
    assert.deepEqual(
      store.profiles().find((saved) => saved.name === profile.name),
      profile,
    );
  const second = await prepareAutoProfiles({
    keys: store,
    claudeAvailable: true,
    fetcher: async () => {
      throw Error('must not refetch complete pool');
    },
  });
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.unavailable, []);
  assert.equal(store.writes.length, 3);
});

test('missing Claude harness performs no network or profile mutation', async () => {
  const store = keys();
  const result = await prepareAutoProfiles({
    keys: store,
    claudeAvailable: false,
    fetcher: async () => {
      throw Error('must not fetch');
    },
  });
  assert.equal(result.unavailable.length, 4);
  assert.ok(result.unavailable.every((row) => /harness unavailable/.test(row.reason)));
  assert.deepEqual(result.created, []);
  assert.deepEqual(store.writes, []);
});

test('absent exact IDs are skipped without fuzzy matching a similar model alias', async () => {
  const body = catalog();
  body.data[2]!.id = 'deepseek/deepseek-flash';
  const store = keys(),
    result = await prepareAutoProfiles({ keys: store, claudeAvailable: true, fetcher: fetchCatalog(body) });
  assert.equal(result.created.length, 3);
  assert.deepEqual(
    result.unavailable.map((item) => item.model),
    ['deepseek/deepseek-v4.1-flash-1017'],
  );
  assert.match(result.unavailable[0]!.reason, /exact model absent/);
});

test('tool/context/price/canonical metadata must establish eligibility before profiles are persisted', async () => {
  const mutations: ((row: Record<string, unknown>) => void)[] = [
    (row) => {
      row.supported_parameters = [];
    },
    (row) => {
      row.context_length = 4_000;
    },
    (row) => {
      row.pricing = { prompt: '0', completion: '0.1' };
    },
    (row) => {
      row.pricing = { prompt: 'NaN', completion: '0.1' };
    },
    (row) => {
      row.canonical_slug = '';
    },
    (row) => {
      row.architecture = { input_modalities: ['image'] };
    },
    (row) => {
      row.expiration_date = '2020-01-01T00:00:00Z';
    },
  ];
  for (const mutate of mutations) {
    const body = catalog();
    for (const row of body.data) mutate(row);
    const store = keys(),
      result = await prepareAutoProfiles({ keys: store, claudeAvailable: true, fetcher: fetchCatalog(body) });
    assert.equal(result.created.length, 0);
    assert.equal(result.unavailable.length, 4);
    assert.equal(store.writes.length, 0);
  }
});

test('request timeout, HTTP failure and malformed catalog fail closed and preserve existing defaults', async () => {
  const initial: Profile[] = [
    { name: 'openrouter-claude', provider: 'openrouter', harness: 'claude', model: 'operator/default' },
  ];
  const fetchers: (typeof fetch)[] = [
    async () => {
      throw new DOMException('timeout', 'TimeoutError');
    },
    async () => new Response('{}', { status: 503 }),
    async () => Response.json({ data: {} }),
    async () => new Response('not json'),
  ];
  for (const fetcher of fetchers) {
    const store = keys(initial),
      result = await prepareAutoProfiles({ keys: store, claudeAvailable: true, fetcher });
    assert.deepEqual(store.profiles(), initial);
    assert.equal(store.writes.length, 0);
    assert.equal(result.created.length, 0);
    assert.equal(result.unavailable.length, 4);
  }
});

test('a manual profile written during catalog refresh wins over automatic preparation', async () => {
  const store = keys();
  const manual: Profile = {
    name: 'openrouter-claude-haiku',
    provider: 'openrouter',
    harness: 'claude',
    model: 'operator/choice',
  };
  const result = await prepareAutoProfiles({
    keys: store,
    claudeAvailable: true,
    fetcher: async () => {
      store.putProfile(manual);
      return Response.json(catalog());
    },
  });
  assert.equal(result.created.length, 3);
  assert.deepEqual(
    store.profiles().find((profile) => profile.name === manual.name),
    manual,
  );
});

test('ambiguous exact catalog entries are rejected rather than choosing an arbitrary canonical version', async () => {
  const body = catalog();
  body.data.push({ ...body.data[0]!, canonical_slug: 'another-canonical-version' });
  const result = await prepareAutoProfiles({ keys: keys(), claudeAvailable: true, fetcher: fetchCatalog(body) });
  assert.equal(result.created.length, 3);
  assert.match(result.unavailable[0]!.reason, /ambiguous/);
});
