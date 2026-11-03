// Offline comparison of synthetic availability snapshots. No network, processes, inference or credentials.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Routing, type Binding } from '../src/routing/index.ts';
const stateDir = mkdtempSync(join(tmpdir(), 'observed-routing-'));
const base: Binding = { id: 'first', cli: 'first', harness: 'claude', provider: 'claude', billing: 'subscription', signedIn: true,
  compatibility: 'verified', subscriptionAccount: { enabled: true, priority: 1 }, inflight: 2, nearQuota: false };
let changed = 0, gated = 0, comparisons = 0;
try {
  for (let i = 0; i < 20; i++) {
    const bindings = [{ ...base, ...(i % 4 === 1 ? { quotaBlocked: true } : {}) },
      { ...base, id: 'second', cli: 'second', inflight: 0, ...(i % 4 === 2 ? { signedIn: false } : {}), ...(i % 4 === 3 ? { subscriptionAccount: { enabled: true, priority: 2 } } : {}) }];
    const options = { stateDir, availability: async () => ({ checkedAt: new Date().toISOString(), bindings }), openRouterKey: () => undefined, dynamic: false };
    const prior = await new Routing(options).select({ task: 'offline synthetic task' });
    const observed = await new Routing({ ...options, empiricalRouting: true }).select({ task: 'offline synthetic task' });
    comparisons++; if (prior.cli !== observed.cli) changed++;
    if ((i % 4 === 1 && observed.cli === 'second') || (i % 4 === 2 && observed.cli === 'first') || (i % 4 === 3 && observed.cli === 'first')) gated++;
  }
  process.stdout.write(JSON.stringify({ comparisons, changedByObservedLoad: changed, expectedHardGateOrPriorityCases: gated, expectedHardGateOrPriorityTotal: 15,
    inferenceCalls: 0, paidCalls: 0, costUsd: 0, interpretation: 'Synthetic ordering comparison only; no production latency, savings or quality claim.' }) + '\n');
} finally { rmSync(stateDir, { recursive: true, force: true }); }
