import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderMutations } from '../src/app/provider-mutations.ts';

function barrier() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    release: () => resolve(),
  };
}
test('provider rotation keeps persisted config and runtime on one generation across async teardown', async () => {
  const mutations = new ProviderMutations(),
    teardown = barrier(),
    entered = barrier();
  let persisted = 'original',
    runtime = 'original';
  const order: string[] = [];
  const first = mutations.run(async () => {
    persisted = 'first';
    const next = persisted;
    entered.release();
    await teardown.promise;
    runtime = next;
    order.push('first');
  });
  await entered.promise;
  const second = mutations.run(() => {
    persisted = 'second';
    runtime = persisted;
    order.push('second');
  });
  let observed: string[] | undefined;
  const inventory = mutations.run(() => {
    observed = [persisted, runtime];
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persisted, 'first', 'second key/profile write must wait for the first reload');
  assert.equal(observed, undefined, 'inventory must not observe partially replaced runtime');
  teardown.release();
  await Promise.all([first, second, inventory]);
  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(observed, ['second', 'second']);
});
test('rejected provider mutations do not poison later writes or inventory reads', async () => {
  const mutations = new ProviderMutations();
  const failed = mutations.run(async () => {
    throw Error('catalog unavailable');
  });
  const following = mutations.run(() => 'new provider generation');
  await assert.rejects(failed, /catalog unavailable/);
  assert.equal(await following, 'new provider generation');
  await mutations.run(() => {});
});
test('preparation and reload share one mutation boundary without internal reacquisition', async () => {
  const mutations = new ProviderMutations(),
    steps: string[] = [];
  const prepare = async () => {
    steps.push('prepare');
    await Promise.resolve();
  };
  const reload = async () => {
    steps.push('reload');
    await Promise.resolve();
  };
  await mutations.run(async () => {
    await prepare();
    await reload();
  });
  await mutations.run(async () => {
    steps.push('manual update');
    await reload();
  });
  assert.deepEqual(steps, ['prepare', 'reload', 'manual update', 'reload']);
});

test('a snapshot queued before a newer mutation cannot read its half-applied runtime', async () => {
  const mutations = new ProviderMutations(),
    teardown = barrier();
  let persisted = 'original',
    runtime = 'original';
  const snapshot = mutations.run(() => ({ persisted, runtime }));
  const change = mutations.run(async () => {
    persisted = 'next';
    await teardown.promise;
    runtime = 'next';
  });
  const observed = await snapshot;
  assert.deepEqual(observed, { persisted: 'original', runtime: 'original' });
  teardown.release();
  await change;
  assert.deepEqual(await mutations.run(() => ({ persisted, runtime })), { persisted: 'next', runtime: 'next' });
});
