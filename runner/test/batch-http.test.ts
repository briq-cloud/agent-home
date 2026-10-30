import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { Application } from '../src/app/services.ts';
import { configuration } from '../src/app/config.ts';
import { Hub } from '../src/acp/hub.ts';
import { Keys } from '../src/providers/profiles.ts';
import type { BatchClient } from '../src/scheduling/batch.ts';

test('batch HTTP keeps explicit consent, idempotency and resumed background polling across an app restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'batch-app-'));
  const config = configuration({ RUNNER_CWD: root, RUNNER_STATE: join(root, 'state'), RUNNER_BATCH: '1' });
  const keys = new Keys({ keysFile: join(root, 'keys.json'), profilesFile: join(root, 'profiles.json'), logins: root });
  let creates = 0,
    polls = 0;
  const fake: BatchClient = {
    batch: {
      createBatches: async () => {
        creates++;
        return { id: 'batch_fixture', status: 'validating' } as any;
      },
      getBatches: async ({ id }) => {
        polls++;
        return {
          id,
          status: 'completed',
          results: [
            {
              customId: 'doc',
              response: {
                body: {
                  choices: [{ message: { content: 'A synthetic summary.' } }],
                  usage: { cost: 0.0001 },
                },
              },
            },
          ],
        } as any;
      },
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
      batchClientFactory: () => fake,
    });
  const request = async (app: Application, method: string, path: string, input: Record<string, unknown> = {}) => {
    let code = 0,
      result: any;
    const response = {
      writeHead: (status: number) => {
        code = status;
      },
      end: (body: string) => {
        result = JSON.parse(body);
      },
    };
    await app.http(
      { method } as IncomingMessage,
      response as unknown as ServerResponse,
      new URL(path, 'http://localhost'),
      async () => input,
    );
    return { code, result };
  };
  let app = make();
  try {
    const input = {
      idempotencyKey: 'single-owner-request',
      operation: 'summarize',
      model: 'anthropic/claude-haiku-5.5',
      allowPaid: true,
      budgetEstimateUsd: 0.01,
      items: [{ id: 'doc', text: 'Synthetic fixture content.' }],
    };
    assert.equal(
      (await request(app, 'POST', '/text-batches', input)).code,
      400,
      'a missing key cannot create an uncertain provider submission',
    );
    assert.equal(app.batches!.list().length, 0);
    assert.equal(creates, 0);
    keys.putKey('openrouter', 'synthetic-test-key');
    assert.equal((await request(app, 'POST', '/text-batches', { ...input, allowPaid: false })).code, 400);
    const first = await request(app, 'POST', '/text-batches', input);
    assert.equal(first.code, 202);
    const repeat = await request(app, 'POST', '/text-batches', input);
    assert.equal(repeat.result.localId, first.result.localId);
    assert.equal(creates, 1);
    const stopping = app.stop();
    assert.equal(app.stop(), stopping);
    await stopping;
    app = make();
    const until = Date.now() + 2000;
    while (app.batches!.read(first.result.localId)?.state !== 'completed' && Date.now() < until) await sleep(5);
    const finished = await request(app, 'GET', `/text-batches/${first.result.localId}`);
    assert.equal(finished.result.state, 'completed');
    assert.equal(finished.result.totalCostUsd, 0.0001);
    assert.equal(polls, 1);
    assert.equal(creates, 1, 'restart polls the stored ID without repeating paid submission');
    assert.equal(JSON.stringify(finished).includes('synthetic-test-key'), false);
  } finally {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
