/** Free deterministic selector check: no CLI process, native session, or model request. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Routing, type Binding } from '../src/routing/index.ts';

export async function checkAccountPool() {
  const root = await mkdtemp(join(tmpdir(), 'account-pool-check-'));
  const a: Binding = {
    id: 'a',
    cli: 'claude-account-a',
    harness: 'claude',
    provider: 'claude',
    billing: 'subscription',
    signedIn: true,
    compatibility: 'verified',
    subscriptionAccount: { enabled: true, priority: 0 },
    quotaBlocked: true,
  };
  const b: Binding = {
    ...a,
    id: 'b',
    cli: 'claude-account-b',
    subscriptionAccount: { enabled: true, priority: 1 },
    quotaBlocked: false,
  };
  const api: Binding = { ...b, id: 'api', cli: 'api', billing: 'use', subscriptionAccount: undefined };
  let bindings = [a, b, api],
    metadataRequests = 0,
    decisionRequests = 0;
  const routing = new Routing({
    stateDir: root,
    dynamic: true,
    availability: async () => ({ checkedAt: new Date().toISOString(), bindings }),
    openRouterKey: () => 'fixture-key',
    fetcher: async () => {
      metadataRequests++;
      throw Error('unexpected metadata request');
    },
    decisionClient: () => ({
      alpha: {
        decisions: {
          create: async () => {
            decisionRequests++;
            throw Error('unexpected model request');
          },
        },
      },
    }),
  });
  const observations: Array<{ case: string; result: string; elapsedMs: number }> = [];
  const check = async (
    name: string,
    expected: string,
    request: any = { task: 'bounded work', decisionBudgetUsd: 0.01 },
  ) => {
    const started = performance.now();
    const route = await routing.select(request);
    assert.equal(route.cli, expected);
    observations.push({ case: name, result: route.cli, elapsedMs: performance.now() - started });
  };
  try {
    await check('known-exhausted A selects B', b.cli);
    bindings = [{ ...a, quotaBlocked: false }, b, api];
    await check('observed reset restores A', a.cli);
    bindings = [{ ...a, quotaBlocked: false, subscriptionAccount: { enabled: false, priority: 0 } }, b, api];
    await check('disabled A selects B', b.cli);
    bindings = [{ ...a, signedIn: null }, { ...b, signedIn: null }, api];
    const started = performance.now();
    await assert.rejects(routing.select({ task: 'unavailable', decisionBudgetUsd: 0.01 }), /no eligible/);
    observations.push({
      case: 'all subscriptions unavailable; metered route not opted in',
      result: 'refused',
      elapsedMs: performance.now() - started,
    });
    await check('existing pinned session remains A', a.cli, { task: 'continue', pinned: { cli: a.cli } });
    assert.equal(metadataRequests, 0);
    assert.equal(decisionRequests, 0);
    return {
      version: 1,
      kind: 'deterministic-account-pool-check',
      node: process.version,
      observations,
      requests: { native: 0, model: decisionRequests, metadata: metadataRequests },
      scope: 'Mock availability and selector correctness only; no live quota, latency, or savings claim',
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await checkAccountPool(), null, 2));
