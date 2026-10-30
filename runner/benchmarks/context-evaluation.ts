import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ContextStore } from '../src/context/store.ts';

/**
 * Deterministic held-out behavior check for the current ContextStore.
 * This does not call a model and does not measure answer quality or token savings.
 */
export function runContextEvaluation(): Record<string, unknown> {
  let now = Date.UTC(2026, 9, 30, 10, 0, 0);
  const store = new ContextStore({ now: () => now, maxRecallBytes: 8_192 });
  const started = performance.now();
  const observations: Array<Record<string, unknown>> = [];
  const project = 'heldout-alpha';
  store.setProjectRevision(project, 'rev-1');

  const source = (path: string, text: string) =>
    store.putSource({ project, revision: 'rev-1', path, content: text });
  const memory = (key: string, text: string, ref: ReturnType<typeof source>, expiresAt?: number) =>
    store.putMemory({ project, key, text, source: ref, ...(expiresAt === undefined ? {} : { expiresAt }) });
  const record = (id: string, observed: unknown, expectation: string, result: 'supported' | 'limitation' | 'guarded') => {
    observations.push({ id, observed, expectation, result });
  };

  try {
    const db = source('architecture.md', 'The event store uses PostgreSQL for durable records.');
    memory('database-choice', 'The event store uses PostgreSQL.', db);
    const exact = store.searchMemories({ project, query: 'PostgreSQL event store' });
    record('lexical-recall', { count: exact.length, text: exact[0]?.text ?? null }, 'Exact keyword query retrieves the stored fact.', exact.length ? 'supported' : 'limitation');

    const paraphrase = store.searchMemories({ project, query: 'Which database persists events?' });
    record('paraphrase-recall', { count: paraphrase.length }, 'A semantic/paraphrase query would retrieve PostgreSQL; current FTS retrieval is lexical.', paraphrase.length ? 'supported' : 'limitation');

    const revSource = source('ops.md', 'The deployment uses region eu-west-1.');
    memory('deployment-region', 'Deployment region is eu-west-1.', revSource);
    store.setProjectRevision(project, 'rev-2');
    const stale = store.searchMemories({ project, query: 'eu-west-1 deployment' });
    const promptStale = store.searchPromptMemories({ project, query: 'eu-west-1 deployment' });
    record('stale-revision', {
      inspectableCount: stale.length,
      promptContextCount: promptStale.length,
      sourceCurrent: stale[0]?.sourceCurrent ?? null,
      inspectableText: stale[0]?.text ?? null,
    }, 'Stale memory remains inspectable through the API but is excluded from prompt-context retrieval.',
    stale.length === 1 && stale[0]?.sourceCurrent === false && promptStale.length === 0 ? 'guarded' : 'limitation');

    store.setProjectRevision(project, 'rev-1');
    const beforeCorrection = source('preferences.md', 'Use pnpm for JavaScript projects.');
    memory('package-manager', 'Use pnpm for JavaScript projects.', beforeCorrection);
    const afterCorrection = source('preferences.md', 'Use bun for JavaScript projects.');
    const corrected = memory('package-manager', 'Use bun for JavaScript projects.', afterCorrection);
    const oldFact = store.searchMemories({ project, query: 'pnpm JavaScript projects' });
    const newFact = store.searchMemories({ project, query: 'bun JavaScript projects' });
    record('contradiction-replacement', {
      version: corrected.version,
      oldValueMatches: oldFact.length,
      newValueMatches: newFact.length,
      text: newFact[0]?.text ?? null,
    }, 'Same project/key correction increments version and removes the previous indexed value.', corrected.version === 2 && oldFact.length === 0 && newFact.length === 1 ? 'supported' : 'limitation');

    const otherProject = 'heldout-beta';
    store.setProjectRevision(otherProject, 'rev-1');
    const betaSource = store.putSource({ project: otherProject, revision: 'rev-1', path: 'private.md', content: 'LANTERN-SKY-731 belongs only to beta.' });
    store.putMemory({ project: otherProject, key: 'private-marker', text: 'LANTERN-SKY-731 belongs only to beta.', source: betaSource });
    const isolated = store.searchMemories({ project, query: 'LANTERN-SKY-731' });
    record('project-isolation', { alphaResultCount: isolated.length }, 'A memory in another project must not be returned.', isolated.length === 0 ? 'supported' : 'limitation');

    const expiringSource = source('temporary.md', 'A temporary rollout ends at noon.');
    memory('temporary-rollout', 'Temporary rollout ends at noon.', expiringSource, now + 1_000);
    const beforeExpiry = store.searchMemories({ project, query: 'temporary rollout noon' }).length;
    now += 1_001;
    const afterExpiry = store.searchMemories({ project, query: 'temporary rollout noon' }).length;
    record('expiry', { beforeExpiry, afterExpiry }, 'Future expiry is searchable before its deadline and absent after.', beforeExpiry === 1 && afterExpiry === 0 ? 'supported' : 'limitation');

    const trustSource = source('review.md', 'A user supplied an unverified note about a migration.');
    memory('review-note', 'The migration note says to verify before applying.', trustSource);
    const trust = store.searchMemories({ project, query: 'migration note verify' })[0];
    record('untrusted-memory', {
      trust: trust?.trust ?? null,
      sourceReferenceVerified: trust?.sourceReferenceVerified ?? null,
      sourceCurrent: trust?.sourceCurrent ?? null,
    }, 'Stored memory remains explicitly untrusted; verified source reference means only that the artifact exists.', trust?.trust === 'untrusted' && trust.sourceReferenceVerified && trust.sourceCurrent ? 'guarded' : 'limitation');

    const storePath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/context/store.ts');
    const report = {
      kind: 'agent-home-context-store-heldout-evaluation',
      recordedAt: new Date().toISOString(),
      node: process.version,
      sqlite: process.versions.sqlite ?? null,
      sourceHash: createHash('sha256').update(readFileSync(storePath)).digest('hex'),
      cases: observations,
      durationMs: Number((performance.now() - started).toFixed(3)),
      calls: { model: 0, paid: 0, network: 0 },
      interpretation: {
        supported: observations.filter((x) => x.result === 'supported').length,
        guarded: observations.filter((x) => x.result === 'guarded').length,
        limitations: observations.filter((x) => x.result === 'limitation').length,
      },
      limits: [
        'Fixture-only deterministic behavior check; not a model-quality benchmark.',
        'Lexical recall is not semantic/paraphrase recall; no embeddings or query rewriting used.',
        'General memory search preserves stale rows for inspection; prompt-context search excludes them before result limits are applied.',
        'The trust flag is a handling label, not truth verification; sourceReferenceVerified checks source row identity only.',
        'Token estimates are byte-based approximations, not provider tokenizer measurements.',
      ],
    };
    return report;
  } finally {
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(runContextEvaluation(), null, 2)}\n`);
}
