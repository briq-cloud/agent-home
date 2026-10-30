import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import type { BatchObject } from '@openrouter/sdk/models';
import {
  BatchSubmissionUnknownError,
  TextBatchAdapter,
  type BatchClient,
  type BatchInput,
} from '../src/scheduling/batch.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-home-batch-'));
  directories.push(directory);
  return { directory, dbPath: join(directory, 'private', 'batch.sqlite') };
}

function input(overrides: Partial<BatchInput> = {}): BatchInput {
  return {
    idempotencyKey: 'transform-1',
    operation: 'summarize',
    items: [{ id: 'doc-1', text: 'A small input document.' }],
    model: 'vendor/example-model',
    allowPaid: true,
    budgetEstimateUsd: 0.01,
    ...overrides,
  };
}

function batch(
  id: string,
  status: string,
  results: unknown = null,
  error: string | null = null,
  usage: unknown = null,
): BatchObject {
  return {
    id,
    status,
    results,
    error: error ? { message: error } : null,
    requestCounts: { total: 1, completed: 0, failed: 0 },
    usage,
  } as unknown as BatchObject;
}

function client(options: {
  create?: (request: Parameters<BatchClient['batch']['createBatches']>[0]) => Promise<BatchObject>;
  get?: (id: string) => Promise<BatchObject>;
  onKey?: () => void;
}): BatchClient {
  return {
    batch: {
      createBatches: async (request) => (options.create ? options.create(request) : batch('provider-1', 'validating')),
      getBatches: async ({ id }) => (options.get ? options.get(id) : batch(id, 'in_progress')),
    },
  };
}

function makeAdapter(
  dbPath: string,
  fake: BatchClient,
  getApiKey: () => string | Promise<string> = () => 'synthetic-key',
) {
  return new TextBatchAdapter({
    dbPath,
    getApiKey,
    maxEstimatedUsd: 0.05,
    clientFactory: () => fake,
    timeoutMs: 100,
  });
}

test('requires explicit paid consent, caller estimate, and bounded text-only request before creating a job', async () => {
  const { dbPath } = await fixture();
  let apiCalls = 0;
  const adapter = makeAdapter(
    dbPath,
    client({
      create: async () => {
        apiCalls++;
        return batch('nope', 'validating');
      },
    }),
  );
  try {
    await assert.rejects(adapter.submit(input({ allowPaid: false as true })), /allowPaid/);
    await assert.rejects(adapter.submit(input({ budgetEstimateUsd: 0.06 })), /not a hard billing cap/);
    await assert.rejects(
      adapter.submit(input({ operation: 'decide' as BatchInput['operation'] })),
      /operation must be/,
    );
    await assert.rejects(adapter.submit(input({ model: 'openrouter/auto' })), /moving model aliases/);
    await assert.rejects(adapter.submit(input({ model: 42 as unknown as string })), /bounded provider\/model slug/);
    await assert.rejects(
      adapter.submit(input({ items: Array.from({ length: 17 }, (_, i) => ({ id: `id-${i}`, text: 'x' })) })),
      /1-16/,
    );
    await assert.rejects(
      adapter.submit(
        input({
          items: [
            { id: 'dup', text: 'a' },
            { id: 'dup', text: 'b' },
          ],
        }),
      ),
      /unique/,
    );
    assert.equal(apiCalls, 0);
    assert.equal((adapter.db.prepare('SELECT count(*) AS count FROM batch_jobs').get() as { count: number }).count, 0);
  } finally {
    adapter.close();
  }
});

test('persists intent and provider ID before polling; restart resumes only that ID and bounds results', async () => {
  const { dbPath } = await fixture();
  let createRequest: Parameters<BatchClient['batch']['createBatches']>[0] | undefined;
  const polledIds: string[] = [];
  let pollCount = 0;
  let keyCalls = 0;
  const fake = client({
    create: async (request) => {
      createRequest = request;
      return batch('provider-abc', 'validating');
    },
    get: async (id) => {
      polledIds.push(id);
      pollCount++;
      if (pollCount === 1) return batch(id, 'in_progress');
      return batch(id, 'completed', [
        {
          customId: 'doc-1',
          error: null,
          response: { body: { choices: [{ message: { content: 'Short summary.' } }], usage: { cost: 0.0002 } } },
        },
      ]);
    },
  });
  const adapter = new TextBatchAdapter({
    dbPath,
    maxEstimatedUsd: 0.05,
    timeoutMs: 100,
    getApiKey: () => {
      keyCalls++;
      return 'do-not-store-this-synthetic-key';
    },
    clientFactory: (getKey) => ({
      batch: {
        createBatches: async (request) => {
          await getKey();
          return fake.batch.createBatches(request);
        },
        getBatches: async (request, options) => fake.batch.getBatches(request, options),
      },
    }),
  });
  const submitted = await adapter.submit(input());
  assert.equal(submitted.state, 'submitted');
  assert.equal(submitted.providerBatchId, 'provider-abc');
  assert.equal(createRequest?.batchSubmitBody.endpoint, '/v1/chat/completions');
  assert.equal(createRequest?.batchSubmitBody.completionWindow, '24h');
  assert.equal(createRequest?.batchSubmitBody.requests.length, 1);
  assert.equal(createRequest?.batchSubmitBody.requests[0]?.body.max_tokens, 512);
  assert.equal(keyCalls, 1);
  assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
  const dbBytes = await readFile(dbPath);
  assert.equal(dbBytes.includes(Buffer.from('do-not-store-this-synthetic-key')), false);

  const localId = submitted.localId;
  adapter.close();
  const reopened = makeAdapter(dbPath, fake);
  try {
    assert.equal(reopened.read(localId)?.providerBatchId, 'provider-abc');
    const firstPoll = await reopened.poll(localId);
    assert.equal(firstPoll.state, 'submitted');
    assert.equal(firstPoll.providerBatchId, 'provider-abc');
    const done = await reopened.poll(localId);
    assert.equal(done.state, 'completed');
    assert.deepEqual(done.results, [{ id: 'doc-1', text: 'Short summary.', costUsd: 0.0002 }]);
    assert.equal(done.results?.[0]?.costUsd, 0.0002);
    assert.equal(done.totalCostUsd, 0.0002);
    assert.equal(done.costSource, 'result-usage.cost');
    assert.equal(done.costNote, 'caller estimate only; actual provider charges may be higher');
    assert.deepEqual(polledIds, ['provider-abc', 'provider-abc']);
    assert.equal((await reopened.poll(localId)).state, 'completed', 'terminal state is served locally');
    assert.equal(polledIds.length, 2);
  } finally {
    reopened.close();
  }
});

test('ambiguous POST failure becomes submission_unknown and restart never blindly resubmits', async () => {
  const { dbPath } = await fixture();
  let creates = 0;
  let gets = 0;
  const fake = client({
    create: async () => {
      creates++;
      throw new Error('socket disconnected, token do-not-leak-key-239 and Authorization: Bearer another-secret-key');
    },
    get: async (id) => {
      gets++;
      return batch(id, 'completed', []);
    },
  });
  const adapter = makeAdapter(dbPath, fake);
  let localId = '';
  try {
    await assert.rejects(adapter.submit(input()), (error: unknown) => {
      assert.ok(error instanceof BatchSubmissionUnknownError);
      assert.equal(error.message.includes('do-not-leak-key-239'), false);
      assert.equal(error.message.includes('another-secret-key'), false);
      localId = error.localId;
      return /outcome is unknown/.test(error.message);
    });
    assert.equal(adapter.read(localId)?.state, 'submission_unknown');
    assert.equal(adapter.read(localId)?.error?.includes('do-not-leak-key-239'), false);
    assert.equal(adapter.read(localId)?.error?.includes('another-secret-key'), false);
    assert.equal(
      adapter.read(localId)?.error,
      'provider submission failed; outcome is unknown; do not resubmit this job automatically',
    );
  } finally {
    adapter.close();
  }

  const reopened = makeAdapter(dbPath, fake);
  try {
    assert.equal(reopened.read(localId)?.state, 'submission_unknown');
    await assert.rejects(reopened.poll(localId), /automatic resubmission is disabled/);
    assert.equal(creates, 1);
    assert.equal(gets, 0);
  } finally {
    reopened.close();
  }
});

test('provider batch IDs are bounded before they can be persisted or polled', async () => {
  const { dbPath } = await fixture();
  const adapter = makeAdapter(dbPath, client({ create: async () => batch('x'.repeat(129), 'validating') }));
  try {
    await assert.rejects(adapter.submit(input()), (error: unknown) => {
      assert.ok(error instanceof BatchSubmissionUnknownError);
      const job = adapter.read(error.localId);
      assert.equal(job?.state, 'submission_unknown');
      assert.equal(job?.providerBatchId, undefined);
      assert.equal(adapter.pending()[0]?.providerBatchId, undefined);
      return true;
    });
  } finally {
    adapter.close();
  }
});

test('idempotency coalesces concurrent duplicate submissions and rejects a reused key with changed intent', async () => {
  const { dbPath } = await fixture();
  let release!: (value: BatchObject) => void;
  let createCalls = 0;
  const result = new Promise<BatchObject>((resolve) => {
    release = resolve;
  });
  const adapter = makeAdapter(
    dbPath,
    client({
      create: async () => {
        createCalls++;
        return result;
      },
    }),
  );
  try {
    const first = adapter.submit(input());
    const duplicate = await adapter.submit(input());
    assert.equal(createCalls, 1);
    assert.equal(duplicate.state, 'submitting');
    await assert.rejects(
      adapter.submit(input({ items: [{ id: 'doc-1', text: 'changed payload' }] })),
      /different batch intent/,
    );
    assert.equal(createCalls, 1);
    release(batch('provider-idem', 'validating'));
    const submitted = await first;
    assert.equal(submitted.state, 'submitted');
    assert.equal(adapter.list({ limit: 1 })[0]?.localId, submitted.localId);
  } finally {
    adapter.close();
  }
});

test('restart converts orphaned submitting intent to unknown and never polls without a provider ID', async () => {
  const { dbPath } = await fixture();
  await mkdir(dirname(dbPath), { recursive: true });
  const seed = new DatabaseSync(dbPath);
  seed.exec(`CREATE TABLE batch_jobs (
    local_id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,state TEXT NOT NULL,provider_id TEXT,provider_status TEXT,
    intent_json TEXT NOT NULL,results_json TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
  )`);
  seed
    .prepare(
      `INSERT INTO batch_jobs(local_id,idempotency_key,state,intent_json,created_at,updated_at) VALUES ('crashed','transform-1','submitting',?,1,1)`,
    )
    .run(
      JSON.stringify({
        operation: 'summarize',
        items: [{ id: 'doc-1', text: 'A small input document.' }],
        model: 'vendor/example-model',
        allowPaid: true,
        budgetEstimateUsd: 0.01,
      }),
    );
  seed.close();
  let getCalls = 0;
  const adapter = makeAdapter(
    dbPath,
    client({
      get: async (id) => {
        getCalls++;
        return batch(id, 'validating');
      },
    }),
  );
  try {
    assert.equal(adapter.read('crashed')?.state, 'submission_unknown');
    await assert.rejects(adapter.poll('crashed'), /automatic resubmission is disabled/);
    assert.equal(getCalls, 0);
  } finally {
    adapter.close();
  }
});

test('rejects output beyond per-result bound and keeps the provider job resumable', async () => {
  const { dbPath } = await fixture();
  const fake = client({
    get: async (id) =>
      batch(id, 'completed', [
        {
          customId: 'doc-1',
          error: null,
          response: { body: { choices: [{ message: { content: 'x'.repeat(4_097) } }], usage: { cost: 0.001 } } },
        },
      ]),
  });
  const adapter = makeAdapter(dbPath, fake);
  try {
    const submitted = await adapter.submit(input());
    await assert.rejects(adapter.poll(submitted.localId), /exceeds per-item output limit/);
    assert.equal(adapter.read(submitted.localId)?.state, 'submitted');
    assert.equal(adapter.read(submitted.localId)?.providerBatchId, 'provider-1');
  } finally {
    adapter.close();
  }
});

test('validates exact result IDs and does not claim unknown request costs are zero', async () => {
  const { directory } = await fixture();
  const cases: Array<{ name: string; results: unknown; expectedError: RegExp }> = [
    {
      name: 'missing',
      results: [{ customId: 'doc-1', error: null, response: { body: { choices: [{ message: { content: 'x' } }] } } }],
      expectedError: /requested item count/,
    },
    {
      name: 'duplicate',
      results: [
        { customId: 'doc-1', error: null, response: { body: { choices: [{ message: { content: 'x' } }] } } },
        { customId: 'doc-1', error: null, response: { body: { choices: [{ message: { content: 'y' } }] } } },
      ],
      expectedError: /duplicate/,
    },
    {
      name: 'unexpected',
      results: [
        { customId: 'doc-1', error: null, response: { body: { choices: [{ message: { content: 'x' } }] } } },
        { customId: 'outside', error: null, response: { body: { choices: [{ message: { content: 'y' } }] } } },
      ],
      expectedError: /unexpected/,
    },
  ];
  for (const scenario of cases) {
    const dbPath = join(directory, `${scenario.name}.sqlite`);
    const fake = client({ get: async (id) => batch(id, 'completed', scenario.results) });
    const adapter = makeAdapter(dbPath, fake);
    try {
      const submitted = await adapter.submit(
        input({
          items: [
            { id: 'doc-1', text: 'a' },
            { id: 'doc-2', text: 'b' },
          ],
        }),
      );
      await assert.rejects(adapter.poll(submitted.localId), scenario.expectedError);
      assert.equal(adapter.read(submitted.localId)?.state, 'submitted');
    } finally {
      adapter.close();
    }
  }

  const dbPath = join(directory, 'unknown-cost.sqlite');
  const noCost = client({
    get: async (id) =>
      batch(id, 'completed', [
        {
          customId: 'doc-1',
          error: null,
          response: { body: { choices: [{ message: { content: 'ok' } }], usage: { cost: Number.NaN } } },
        },
      ]),
  });
  const adapter = makeAdapter(dbPath, noCost);
  try {
    const submitted = await adapter.submit(input());
    const done = await adapter.poll(submitted.localId);
    assert.equal(done.results?.[0]?.costUsd, null);
    assert.equal(done.totalCostUsd, null);
    assert.equal(done.costSource, null);
  } finally {
    adapter.close();
  }
});

test('poll errors and provider result errors never expose raw provider strings', async () => {
  const { directory } = await fixture();
  const pollErrorAdapter = makeAdapter(
    join(directory, 'poll-error.sqlite'),
    client({
      get: async () => {
        throw new Error('echo raw-key-99 and Bearer bearer-secret-77');
      },
    }),
  );
  try {
    const job = await pollErrorAdapter.submit(input());
    await assert.rejects(pollErrorAdapter.poll(job.localId), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /provider polling failed/);
      assert.equal(error.message.includes('raw-key-99'), false);
      assert.equal(error.message.includes('bearer-secret-77'), false);
      return true;
    });
  } finally {
    pollErrorAdapter.close();
  }

  const providerErrorAdapter = makeAdapter(
    join(directory, 'provider-error.sqlite'),
    client({
      get: async (id) => batch(id, 'failed', null, 'echo provider-secret-55'),
    }),
  );
  try {
    const job = await providerErrorAdapter.submit(input());
    const failed = await providerErrorAdapter.poll(job.localId);
    assert.equal(failed.error, 'provider batch ended in a failed state; inspect the provider dashboard for details');
    assert.equal(failed.error?.includes('provider-secret-55'), false);
  } finally {
    providerErrorAdapter.close();
  }

  const itemErrorAdapter = makeAdapter(
    join(directory, 'item-error.sqlite'),
    client({
      get: async (id) =>
        batch(id, 'completed', [{ customId: 'doc-1', error: { message: 'echo item-secret-11' }, response: null }]),
    }),
  );
  try {
    const job = await itemErrorAdapter.submit(input());
    const complete = await itemErrorAdapter.poll(job.localId);
    assert.equal(complete.results?.[0]?.error, 'provider reported an error for this request');
    assert.equal(complete.results?.[0]?.costUsd, null);
    assert.equal(complete.totalCostUsd, null);
    assert.equal(complete.results?.[0]?.error?.includes('item-secret-11'), false);
  } finally {
    itemErrorAdapter.close();
  }
});

test('top-level batch usage cost is authoritative when per-item cost details are absent', async () => {
  const { dbPath, directory } = await fixture();
  const fake = client({
    get: async (id) =>
      batch(
        id,
        'completed',
        [
          { customId: 'doc-1', error: null, response: { body: { choices: [{ message: { content: 'first' } }] } } },
          { customId: 'doc-2', error: { message: 'provider-specific failure text' }, response: null },
        ],
        null,
        { promptTokens: 20, completionTokens: 4, totalTokens: 24, cost: 0.000031, isByok: false },
      ),
  });
  const adapter = makeAdapter(dbPath, fake);
  try {
    const submitted = await adapter.submit(
      input({
        items: [
          { id: 'doc-1', text: 'a' },
          { id: 'doc-2', text: 'b' },
        ],
      }),
    );
    const completed = await adapter.poll(submitted.localId);
    assert.deepEqual(
      completed.results?.map((result) => result.costUsd),
      [null, null],
    );
    assert.equal(completed.totalCostUsd, 0.000031);
    assert.equal(completed.costSource, 'batch-usage.cost');
  } finally {
    adapter.close();
  }

  const fallbackAdapter = makeAdapter(
    join(directory, 'result-cost-sum.sqlite'),
    client({
      get: async (id) =>
        batch(id, 'completed', [
          {
            customId: 'doc-1',
            error: null,
            response: { body: { choices: [{ message: { content: 'first' } }], usage: { cost: 0.0002 } } },
          },
          {
            customId: 'doc-2',
            error: null,
            response: { body: { choices: [{ message: { content: 'second' } }], usage: { cost: 0.0003 } } },
          },
        ]),
    }),
  );
  try {
    const submitted = await fallbackAdapter.submit(
      input({
        items: [
          { id: 'doc-1', text: 'a' },
          { id: 'doc-2', text: 'b' },
        ],
      }),
    );
    const completed = await fallbackAdapter.poll(submitted.localId);
    assert.equal(completed.totalCostUsd, 0.0005);
    assert.equal(completed.costSource, 'result-usage.cost');
  } finally {
    fallbackAdapter.close();
  }
});

test('timeout bounds and pending/list limits cap work; completed jobs free a slot', async () => {
  const { dbPath } = await fixture();
  assert.throws(
    () => new TextBatchAdapter({ dbPath, maxEstimatedUsd: 0.05, timeoutMs: 30_001, getApiKey: () => 'unused' }),
    /timeoutMs/,
  );
  let created = 0;
  const fake = client({
    create: async () => {
      created++;
      return batch(`provider-${created}`, 'validating');
    },
    get: async (id) =>
      batch(id, 'completed', [
        {
          customId: 'doc-1',
          error: null,
          response: { body: { choices: [{ message: { content: 'done' } }], usage: { cost: 0.001 } } },
        },
      ]),
  });
  const adapter = makeAdapter(dbPath, fake);
  try {
    const jobs: string[] = [];
    for (let index = 0; index < 16; index++) {
      const submitted = await adapter.submit(input({ idempotencyKey: `slot-${index}` }));
      jobs.push(submitted.localId);
    }
    assert.equal(adapter.pending().length, 16);
    assert.throws(() => adapter.list({ limit: 101 }), /1-100/);
    assert.throws(() => adapter.list({ offset: -1 }), /0-100000/);
    await assert.rejects(adapter.submit(input({ idempotencyKey: 'slot-overflow' })), /16 unsettled/);
    await adapter.poll(jobs[0]!);
    assert.equal(adapter.pending().length, 15);
    assert.equal((await adapter.submit(input({ idempotencyKey: 'slot-after-complete' }))).state, 'submitted');
  } finally {
    adapter.close();
  }
});

test('concurrent polls use one provider GET and cannot overwrite a terminal result', async () => {
  const { dbPath } = await fixture();
  let release!: (value: BatchObject) => void;
  let getCalls = 0;
  const waitForPoll = new Promise<BatchObject>((resolve) => {
    release = resolve;
  });
  const fake = client({
    get: async (id) => {
      getCalls++;
      return waitForPoll.then(() =>
        batch(id, 'completed', [
          {
            customId: 'doc-1',
            error: null,
            response: { body: { choices: [{ message: { content: 'done' } }], usage: { cost: 0.001 } } },
          },
        ]),
      );
    },
  });
  const adapter = makeAdapter(dbPath, fake);
  try {
    const job = await adapter.submit(input());
    const first = adapter.poll(job.localId);
    const second = adapter.poll(job.localId);
    assert.equal(getCalls, 1);
    release(batch('provider-1', 'completed'));
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.state, 'completed');
    assert.equal(two.state, 'completed');
    assert.equal(getCalls, 1);
    assert.equal(adapter.read(job.localId)?.state, 'completed');
  } finally {
    adapter.close();
  }
});

test('shutdown rejects new work, waits for an in-flight submit to persist its provider ID, and coalesces callers', async () => {
  const { dbPath } = await fixture();
  let release!: (value: BatchObject) => void;
  let createCalls = 0;
  const waiting = new Promise<BatchObject>((resolve) => {
    release = resolve;
  });
  const fake = client({
    create: async () => {
      createCalls++;
      return waiting;
    },
  });
  const adapter = makeAdapter(dbPath, fake);
  const submitting = adapter.submit(input());
  const localId = adapter.list({ limit: 1 })[0]!.localId;
  assert.throws(() => adapter.close(), /operations in flight/);
  assert.equal(adapter.read(localId)?.state, 'submitting');

  const shutdown = adapter.shutdown();
  assert.equal(adapter.shutdown(), shutdown);
  await assert.rejects(adapter.submit(input({ idempotencyKey: 'after-shutdown' })), /shutting down/);
  await assert.rejects(adapter.poll(localId), /shutting down/);
  assert.equal(createCalls, 1);

  release(batch('provider-shutdown', 'validating'));
  const completedSubmit = await submitting;
  assert.equal(completedSubmit.providerBatchId, 'provider-shutdown');
  await shutdown;

  const reopened = makeAdapter(dbPath, fake);
  try {
    const persisted = reopened.read(localId);
    assert.equal(persisted?.state, 'submitted');
    assert.equal(persisted?.providerBatchId, 'provider-shutdown');
    assert.equal(createCalls, 1, 'restart does not resubmit the completed POST');
  } finally {
    reopened.close();
  }
});
