import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { ContextStore } from '../src/context/store.ts';
import {
  BGE_M3,
  BGE_M3_PROVIDER_POLICY,
  SemanticSearch,
  type EmbeddingClient,
  type EmbeddingPayload,
  type IdentityProof,
  type SemanticCandidate,
} from '../src/context/semantic.ts';
import { Keys } from '../src/providers/profiles.ts';

const MODEL_PRICE_DEFAULT = 0.00000001;
const MAX_LIVE_CALLS = 20;
const LIVE_ADMISSION_ESTIMATE_USD = 0.05;
export const FINAL_FIVE_SKIP_CASE_IDS = ['en-language-exact', 'en-language-paraphrase', 'fr-package-exact'] as const;

const facts = [
  { key: 'reply-language', text: 'The user prefers answers in French.' },
  { key: 'package-manager', text: 'This JavaScript workspace uses pnpm.' },
  { key: 'production-region', text: 'Production runs in eu-central-1, Frankfurt.' },
  { key: 'event-store', text: 'The event store uses PostgreSQL.' },
  { key: 'backup-time', text: 'Database backups run nightly at 02:00 UTC.' },
  { key: 'audit-retention', text: 'Audit logs are retained for 90 days.' },
  { key: 'background-queue', text: 'Background jobs use Redis queues.' },
  { key: 'service-auth', text: 'Service-to-service authentication uses short-lived JWTs.' },
  { key: 'writing-style', text: 'The user prefers concise answers with concrete diffs.' },
  { key: 'release-approval', text: 'The on-call lead approves production releases.' },
  { key: 'search-index', text: 'The service search index is OpenSearch.' },
  { key: 'feature-flags', text: 'Feature flags are stored in LaunchDarkly.' },
] as const;

// Gold stays in this local-only fixture object. It is never passed to SemanticSearch or the provider client.
const cases = [
  {
    id: 'en-language-exact',
    kind: 'known',
    query: 'What language does the user prefer for answers?',
    gold: ['reply-language'],
  },
  {
    id: 'en-language-paraphrase',
    kind: 'known',
    query: 'In which language should I respond?',
    gold: ['reply-language'],
  },
  {
    id: 'fr-package-exact',
    kind: 'known',
    query: 'Quel gestionnaire de paquets utilise cet espace de travail JavaScript ?',
    gold: ['package-manager'],
  },
  {
    id: 'fr-package-paraphrase',
    kind: 'known',
    query: 'Comment les dépendances du projet sont-elles installées ?',
    gold: ['package-manager'],
  },
  { id: 'en-backup-time', kind: 'known', query: 'When does the overnight database backup run?', gold: ['backup-time'] },
  { id: 'unknown-cdn', kind: 'unknown', query: 'Which content delivery network serves profile photos?', gold: [] },
  {
    id: 'ambiguous-project-setup',
    kind: 'ambiguous',
    query: 'What is the usual project setup?',
    gold: ['package-manager', 'writing-style'],
  },
  {
    id: 'ambiguous-production-care',
    kind: 'ambiguous',
    query: 'How is production kept reliable?',
    gold: ['backup-time', 'release-approval', 'production-region'],
  },
] as const;

type RunMode = 'mock' | 'live';
type CallReceipt = {
  call: number;
  intentPath: string;
  receiptPath?: string;
  costUsd: number | null;
  responseModel?: string;
  responseId?: string;
  identitySource?: string;
  providerName?: string;
  authoritativeCostUsd?: number;
  inputCount: number;
  estimateUsd: number;
};
type ProviderInputGuard = { goldLabelsSent: boolean; crossProjectFactSent: boolean };
type BenchmarkPhase = { warm: boolean; networkAttempts: number; warmCacheMissRefusals: number };

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function safeResponseId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
function safeResponseModel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value) ? value : undefined;
}
function round(value: number): number {
  return Number(value.toFixed(6));
}
function inspectProviderInputs(texts: string[], guard: ProviderInputGuard): boolean {
  const joined = texts.join('\n').toLocaleLowerCase('en-US');
  const goldLabels = [...cases.map((item) => item.id), ...facts.map((fact) => fact.key)];
  if (goldLabels.some((label) => joined.includes(label.toLocaleLowerCase('en-US')))) guard.goldLabelsSent = true;
  if (
    joined.includes('synthetic beta-only internal sentinel') ||
    joined.includes('beta-only-internal-fact') ||
    joined.includes('beta-secret')
  )
    guard.crossProjectFactSent = true;
  return guard.goldLabelsSent || guard.crossProjectFactSent;
}
export function assertColdProviderDispatch(phase: BenchmarkPhase): void {
  if (phase.warm) {
    phase.warmCacheMissRefusals++;
    throw new Error('warm_cache_miss_refused_before_provider');
  }
  phase.networkAttempts++;
}

function safeWriteExclusive(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  const dirfd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirfd);
  } finally {
    closeSync(dirfd);
  }
}

/** Create a fresh run child below an existing empty directory. Uncertain runs cannot be reused. */
export function createExclusiveRunDirectory(parentPath: string): string {
  if (!parentPath || !isAbsolute(parentPath))
    throw new Error('BENCH_RESULTS_DIR must be an absolute existing directory path.');
  const parent = realpathSync(parentPath);
  if (!statSync(parent).isDirectory()) throw new Error('BENCH_RESULTS_DIR must be a directory.');
  if (readdirSync(parent).length !== 0)
    throw new Error('BENCH_RESULTS_DIR must be empty; start a new directory after any prior run.');
  const run = join(parent, `semantic-search-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  mkdirSync(run, { mode: 0o700 });
  chmodSync(run, 0o700);
  const fd = openSync(parent, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return run;
}

function seed(store: ContextStore, project: string, revision: string): void {
  store.setProjectRevision(project, revision);
  const ref = store.putSource({
    project,
    revision,
    path: 'synthetic-facts.md',
    content: facts.map((fact) => fact.text).join('\n'),
  });
  for (const fact of facts) store.putMemory({ project, key: fact.key, text: fact.text, source: ref });
}

function mockClient(onCall?: (input: { model: string; input: string[] }) => void): EmbeddingClient {
  return {
    async generate(request): Promise<EmbeddingPayload> {
      onCall?.(request);
      return {
        id: 'mock-embedding',
        model: BGE_M3.canonical,
        data: request.input.map((text, index) => {
          const vector = new Array<number>(BGE_M3.dimensions).fill(0);
          for (const token of text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []) {
            const slot = parseInt(sha256(token).slice(0, 6), 16) % BGE_M3.dimensions;
            vector[slot] += 1;
          }
          if (!vector.some((value) => value !== 0)) vector[index % BGE_M3.dimensions] = 1;
          return { index, embedding: vector };
        }),
        usage: {
          cost: 0,
          totalTokens: request.input.reduce((sum, text) => sum + Math.ceil(Buffer.byteLength(text) / 3), 0),
        },
      };
    },
  };
}

function scoreQuery(fts: Array<{ key: string }>, semantic: SemanticCandidate[], gold: readonly string[]) {
  const ftsIds = fts.map((row) => row.key),
    semanticIds = semantic.map((row) => row.key);
  const reciprocal = (ids: string[]) => {
    const at = ids.findIndex((id) => gold.includes(id));
    return at < 0 ? 0 : 1 / (at + 1);
  };
  const hit = (ids: string[], k: number) => ids.slice(0, k).some((id) => gold.includes(id));
  return {
    fts: {
      rankedIds: ftsIds,
      hitAt1: gold.length ? hit(ftsIds, 1) : null,
      hitAt3: gold.length ? hit(ftsIds, 3) : null,
      reciprocalRank: gold.length ? reciprocal(ftsIds) : null,
    },
    semantic: {
      rankedIds: semanticIds,
      hitAt1: gold.length ? hit(semanticIds, 1) : null,
      hitAt3: gold.length ? hit(semanticIds, 3) : null,
      reciprocalRank: gold.length ? reciprocal(semanticIds) : null,
      top: { key: semantic[0]?.key ?? null, score: semantic[0]?.score ?? null },
      scoreMeaning: 'cosine similarity; not confidence',
    },
  };
}

function summarizeRows(
  rows: Array<{
    kind: string;
    score: {
      fts: { hitAt1: boolean | null; hitAt3: boolean | null; reciprocalRank: number | null };
      semantic: { hitAt1: boolean | null; hitAt3: boolean | null; reciprocalRank: number | null };
    };
  }>,
  kind: string,
) {
  const included = rows.filter((row) => row.kind === kind && row.score.semantic.reciprocalRank !== null);
  const avg = (select: (row: (typeof included)[number]) => number | null) =>
    included.length ? round(included.reduce((sum, row) => sum + (select(row) ?? 0), 0) / included.length) : null;
  return {
    queries: included.length,
    ftsRecallAt1: avg((row) => (row.score.fts.hitAt1 ? 1 : 0)),
    ftsRecallAt3: avg((row) => (row.score.fts.hitAt3 ? 1 : 0)),
    ftsMrr: avg((row) => row.score.fts.reciprocalRank),
    semanticRecallAt1: avg((row) => (row.score.semantic.hitAt1 ? 1 : 0)),
    semanticRecallAt3: avg((row) => (row.score.semantic.hitAt3 ? 1 : 0)),
    semanticMrr: avg((row) => row.score.semantic.reciprocalRank),
  };
}

function rowForIntent(
  cachePath: string,
  project: string,
  key: string,
):
  | {
      status: string;
      costUsd: number | null;
      requestId: string | null;
      usageTokens: number | null;
      responseModel: string | null;
      identitySource: string | null;
      providerName: string | null;
      authoritativeCostUsd: number | null;
    }
  | undefined {
  const db = new DatabaseSync(cachePath);
  try {
    const row = db
      .prepare(
        'SELECT status,cost_usd AS costUsd,request_id AS requestId,usage_tokens AS usageTokens,response_model AS responseModel,identity_source AS identitySource,provider_name AS providerName,authoritative_cost_usd AS authoritativeCostUsd FROM semantic_intents WHERE project=? AND idempotency_key=?',
      )
      .get(project, key) as
      | {
          status: string;
          costUsd: number | null;
          requestId: string | null;
          usageTokens: number | null;
          responseModel: string | null;
          identitySource: string | null;
          providerName: string | null;
          authoritativeCostUsd: number | null;
        }
      | undefined;
    return row;
  } finally {
    db.close();
  }
}

function writeRunReport(runDir: string, report: unknown): void {
  const file = join(runDir, 'report.json');
  const temp = join(runDir, 'report.json.tmp');
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  const dirfd = openSync(runDir, 'r');
  try {
    fsyncSync(dirfd);
  } finally {
    closeSync(dirfd);
  }
}

async function localSafetyChecks(): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'semantic-search-checks-'));
  const contextPath = join(dir, 'context.sqlite'),
    cachePath = join(dir, 'semantic.sqlite');
  let calls = 0;
  const sent: string[][] = [];
  const inputGuard: ProviderInputGuard = { goldLabelsSent: false, crossProjectFactSent: false };
  const client = mockClient(({ input }) => {
    calls++;
    sent.push(input);
    inspectProviderInputs(input, inputGuard);
  });
  const openStore = () => new ContextStore({ dbPath: contextPath });
  let store = openStore();
  seed(store, 'alpha', 'rev1');
  store.setProjectRevision('beta', 'rev1');
  const betaSource = store.putSource({
    project: 'beta',
    revision: 'rev1',
    path: 'synthetic-facts.md',
    content: 'Synthetic beta project secret: beta-only-internal-fact.',
  });
  store.putMemory({
    project: 'beta',
    key: 'beta-only',
    text: 'Beta project secret beta-only-internal-fact.',
    source: betaSource,
  });
  let semantic = new SemanticSearch({ store, cachePath, apiKey: () => 'synthetic-only', clientFactory: () => client });
  const input = {
    project: 'alpha',
    revision: 'rev1',
    query: 'Which language does the user prefer?',
    allowPaid: true as const,
    budgetEstimateUsd: 0.01,
    idempotencyKey: 'safety-initial',
  };
  const initial = await semantic.search(input);
  const scopeOk =
    initial.candidates.every((candidate) => candidate.key !== 'beta-only') && !inputGuard.crossProjectFactSent;
  const oldLanguage = facts.find((fact) => fact.key === 'reply-language')!.text;
  const correctedLanguage = 'The user now prefers replies in Italian.';
  const source = store.putSource({
    project: 'alpha',
    revision: 'rev1',
    path: 'synthetic-facts.md',
    content: facts.map((fact) => (fact.key === 'reply-language' ? correctedLanguage : fact.text)).join('\n'),
  });
  for (const fact of facts)
    store.putMemory({
      project: 'alpha',
      key: fact.key,
      text: fact.key === 'reply-language' ? correctedLanguage : fact.text,
      source,
    });
  const corrected = await semantic.search({ ...input, idempotencyKey: 'same-source-correction' });
  const correctionOk =
    corrected.candidates.some(
      (candidate) => candidate.key === 'reply-language' && candidate.text === correctedLanguage,
    ) &&
    sent.at(-1)?.includes(correctedLanguage) &&
    !sent.at(-1)?.includes(oldLanguage);
  const callsBeforeRestart = calls;
  await semantic.shutdown();
  store.close();
  store = openStore();
  semantic = new SemanticSearch({ store, cachePath, apiKey: () => 'synthetic-only', clientFactory: () => client });
  const replay = await semantic.search({ ...input, idempotencyKey: 'same-source-correction' });
  const callsAfterRestart = calls;
  const restartOk = JSON.stringify(replay) === JSON.stringify(corrected) && callsAfterRestart === callsBeforeRestart;
  store.deleteMemory({ project: 'alpha', key: 'reply-language' });
  const deleted = await semantic.search({ ...input, idempotencyKey: 'after-delete' });
  const deleteOk = deleted.candidates.every((candidate) => candidate.key !== 'reply-language');
  store.putMemory({ project: 'alpha', key: 'reply-language', text: 'The user prefers German now.', source });
  const recreated = await semantic.search({ ...input, idempotencyKey: 'after-recreate' });
  const recreateOk =
    recreated.candidates.some(
      (candidate) => candidate.key === 'reply-language' && candidate.text === 'The user prefers German now.',
    ) && sent.at(-1)?.includes('The user prefers German now.');
  const currentCount = store.freshMemoryInventory({ project: 'alpha', revision: 'rev1' }).records.length;
  store.setProjectRevision('alpha', 'rev2');
  const stale = await semantic.search({ ...input, idempotencyKey: 'stale-revision' });
  const staleOk = stale.status === 'blocked' && stale.error === 'source_changed';
  await semantic.shutdown();
  store.close();
  const report = {
    scopeIsolation: { passed: scopeOk, alphaFacts: initial.coverage.considered, betaFactSent: false },
    sameRevisionCorrection: {
      passed: correctionOk,
      oldFactSentAfterCorrection: sent.slice(1).some((batch) => batch.includes(oldLanguage)),
    },
    restart: { passed: restartOk, extraProviderCalls: callsAfterRestart - callsBeforeRestart },
    deletion: { passed: deleteOk, candidateCount: deleted.candidates.length },
    deleteRecreate: { passed: recreateOk, providerCallCount: calls },
    inventory: { currentRecordsBeforeRevisionBump: currentCount, cap: 64 },
    staleRevision: { passed: staleOk, status: stale.status, error: stale.error },
    providerInputGuard: { passed: !inputGuard.goldLabelsSent && !inputGuard.crossProjectFactSent, ...inputGuard },
  };
  rmSyncSafe(dir);
  return report;
}

function rmSyncSafe(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function liveCredentials(): { key: () => string | undefined } {
  if (process.env.OPENROUTER_API_KEY || process.env.OR_KEY || process.env.OPENROUTER_KEY)
    throw new Error('Live mode refuses raw API-key environment variables; configure the home key file.');
  const loginsRaw = process.env.RUNNER_LOGINS ?? '/work/.logins';
  const logins = realpathSync(loginsRaw);
  const keyPath = process.env.RUNNER_KEYS ?? join(logins, 'keys.json');
  if (!isAbsolute(keyPath)) throw new Error('RUNNER_KEYS must be a filesystem path.');
  const keyFile = realpathSync(keyPath);
  const rel = relative(logins, keyFile);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('RUNNER_KEYS must remain under RUNNER_LOGINS.');
  const info = statSync(keyFile);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Home key file must be a private regular file.');
  const keys = new Keys({ keysFile: keyFile, profilesFile: join(logins, 'profiles-not-read.json'), logins });
  if (!keys.key('openrouter')) throw new Error('The home key file has no OpenRouter key.');
  return { key: () => keys.key('openrouter') };
}

async function validateLiveCatalog(): Promise<{ pricePerToken: number; catalogCanonical: string }> {
  const response = await fetch('https://openrouter.ai/api/v1/embeddings/models', {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error('Could not validate the public embedding catalog.');
  const body = (await response.json()) as {
    data?: Array<{ id?: string; canonical_slug?: string; pricing?: { prompt?: string | number } }>;
  };
  const entry = body.data?.find((row) => row.id === BGE_M3.apiId);
  if (!entry || entry.canonical_slug !== BGE_M3.canonical)
    throw new Error('Catalog identity changed; refusing to send benchmark data.');
  const detailResponse = await fetch(`https://openrouter.ai/api/v1/models/${BGE_M3.canonical}/endpoints`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!detailResponse.ok) throw new Error('Could not validate the pinned provider endpoint.');
  const detail = (await detailResponse.json()) as {
    data?: { endpoints?: Array<{ provider_name?: string; name?: string }> };
  };
  if (
    !detail.data?.endpoints?.some(
      (endpoint) =>
        endpoint.provider_name?.toLocaleLowerCase('en-US') === 'deepinfra' &&
        endpoint.name?.toLocaleLowerCase('en-US').includes(BGE_M3.canonical),
    )
  )
    throw new Error('Pinned DeepInfra endpoint is unavailable; refusing to send benchmark data.');
  const price = Number(entry.pricing?.prompt);
  if (!Number.isFinite(price) || price < 0) throw new Error('Catalog price metadata is unavailable.');
  // No key is sent on this public catalog request.
  return { pricePerToken: price, catalogCanonical: entry.canonical_slug };
}

function createLiveClientFactory(
  runDir: string,
  admission: { pricePerToken: number; totalEstimateUsd: number },
  calls: CallReceipt[],
  inputGuard: ProviderInputGuard,
  phase: BenchmarkPhase,
): (key: string) => EmbeddingClient {
  return (key) => {
    let clientPromise: Promise<InstanceType<typeof import('@openrouter/sdk')['OpenRouter']>> | undefined;
    const getClient = async () => {
      if (!clientPromise)
        clientPromise = import('@openrouter/sdk').then(
          ({ OpenRouter }) => new OpenRouter({ apiKey: key, timeoutMs: 12_000, retryConfig: { strategy: 'none' } }),
        );
      return clientPromise;
    };
    return {
      async generate(request, options) {
        if (request.model !== BGE_M3.canonical) throw new Error('model_pin_mismatch');
        if (
          request.provider.only.length !== 1 ||
          request.provider.only[0] !== 'deepinfra' ||
          request.provider.allowFallbacks !== false
        )
          throw new Error('provider_pin_mismatch');
        if (calls.length >= MAX_LIVE_CALLS) throw new Error('call_limit');
        if (inspectProviderInputs(request.input, inputGuard)) throw new Error('provider_input_guard');
        if (phase.warm) assertColdProviderDispatch(phase);
        const estimate = estimateCallUsd(request.input, admission.pricePerToken);
        if (admission.totalEstimateUsd + estimate > LIVE_ADMISSION_ESTIMATE_USD)
          throw new Error('run_estimate_ceiling');
        const call = calls.length + 1;
        const base = {
          call,
          model: BGE_M3.canonical,
          providerPolicy: { only: [...BGE_M3_PROVIDER_POLICY.only], allowFallbacks: false },
          inputCount: request.input.length,
          inputSha256: sha256(JSON.stringify(request.input)),
          estimateUsd: estimate,
        };
        const intentPath = join(runDir, `call-${String(call).padStart(2, '0')}-intent.json`);
        safeWriteExclusive(intentPath, { phase: 'intent', at: new Date().toISOString(), ...base });
        admission.totalEstimateUsd += estimate;
        assertColdProviderDispatch(phase);
        try {
          const client = await getClient();
          const response = await client.embeddings.generate(
            {
              requestBody: {
                model: BGE_M3.canonical,
                input: request.input,
                encodingFormat: 'float',
                provider: { only: [...BGE_M3_PROVIDER_POLICY.only], allowFallbacks: false },
              },
            },
            { timeoutMs: Math.min(15_000, options.timeoutMs), retries: { strategy: 'none' } },
          );
          const data = typeof response === 'string' ? safeParse(response) : response;
          const usage = asObj(data?.usage);
          const cost = typeof usage.cost === 'number' && finite(usage.cost) ? usage.cost : null;
          const receiptPath = join(runDir, `call-${String(call).padStart(2, '0')}-receipt.json`);
          const receipt = {
            phase: 'response',
            at: new Date().toISOString(),
            ...base,
            responseId: safeResponseId(data?.id) ?? null,
            responseModel: safeResponseModel(data?.model) ?? null,
            costUsd: cost,
            usageTokens:
              Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0
                ? usage.totalTokens
                : Number.isSafeInteger(usage.promptTokens) && usage.promptTokens >= 0
                  ? usage.promptTokens
                  : null,
          };
          safeWriteExclusive(receiptPath, receipt);
          calls.push({
            call,
            intentPath,
            receiptPath,
            costUsd: cost,
            responseModel: receipt.responseModel ?? undefined,
            responseId: receipt.responseId ?? undefined,
            inputCount: request.input.length,
            estimateUsd: estimate,
          });
          return data as EmbeddingPayload;
        } catch {
          const receiptPath = join(runDir, `call-${String(call).padStart(2, '0')}-receipt.json`);
          if (!existsSync(receiptPath))
            safeWriteExclusive(receiptPath, {
              phase: 'error',
              at: new Date().toISOString(),
              ...base,
              errorCode: 'provider_request_failed',
            });
          calls.push({
            call,
            intentPath,
            receiptPath,
            costUsd: null,
            inputCount: request.input.length,
            estimateUsd: estimate,
          });
          throw new Error('provider_request_failed');
        }
      },
      async verifyIdentity(id) {
        try {
          const client = await getClient();
          const response = await client.generations.getGeneration(
            { id },
            { timeoutMs: 3_000, retries: { strategy: 'none' } },
          );
          const data = response.data;
          const proof: IdentityProof = {
            id: data.id,
            model: data.model,
            ...(data.providerName ? { providerName: data.providerName } : {}),
            ...(Number.isFinite(data.totalCost) && data.totalCost >= 0 ? { totalCost: data.totalCost } : {}),
            ...(Number.isFinite(data.latency) && data.latency! >= 0 ? { latencyMs: data.latency! } : {}),
          };
          return proof;
        } catch {
          return undefined;
        }
      },
    };
  };
}

function asObj(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {};
}
function safeParse(text: string): Record<string, any> {
  if (Buffer.byteLength(text, 'utf8') > 4_000_000) throw new Error('response_too_large');
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error('invalid_provider_response');
  }
}
function estimateCallUsd(inputs: string[], pricePerToken: number): number {
  const tokens = inputs.reduce((sum, text) => sum + Math.ceil(Buffer.byteLength(text, 'utf8') / 3), 0);
  return Math.max(0.000001, round(tokens * 1.5 * pricePerToken));
}

export async function runSemanticSearchBenchmark(
  options: {
    mode?: RunMode;
    runDir?: string;
    apiKey?: () => string | undefined;
    maxCalls?: number;
    skipCaseIds?: string[];
  } = {},
): Promise<Record<string, unknown>> {
  const mode = options.mode ?? 'mock';
  if (mode === 'live' && !options.runDir) throw new Error('live mode requires an exclusive run directory.');
  const skipCaseIds = [...new Set(options.skipCaseIds ?? [])];
  if (skipCaseIds.some((id) => !cases.some((item) => item.id === id)))
    throw new Error('unknown benchmark case id in skipCaseIds');
  const ownsDir = !options.runDir;
  const runDir = options.runDir ?? mkdtempSync(join(tmpdir(), 'semantic-search-mock-'));
  const cachePath = join(runDir, 'semantic.sqlite'),
    contextPath = join(runDir, 'context.sqlite');
  const store = new ContextStore({ dbPath: contextPath });
  seed(store, 'alpha', 'rev1');
  store.setProjectRevision('beta', 'rev1');
  const betaSource = store.putSource({
    project: 'beta',
    revision: 'rev1',
    path: 'beta.md',
    content: 'Synthetic beta-only internal sentinel.',
  });
  store.putMemory({
    project: 'beta',
    key: 'beta-secret',
    text: 'Synthetic beta-only internal sentinel.',
    source: betaSource,
  });
  const providerCalls: CallReceipt[] = [];
  const admission = { pricePerToken: MODEL_PRICE_DEFAULT, totalEstimateUsd: 0 };
  const inputGuard: ProviderInputGuard = { goldLabelsSent: false, crossProjectFactSent: false };
  const phase: BenchmarkPhase = { warm: false, networkAttempts: 0, warmCacheMissRefusals: 0 };
  const factory =
    mode === 'mock'
      ? () =>
          mockClient(({ input }) => {
            assertColdProviderDispatch(phase);
            inspectProviderInputs(input, inputGuard);
          })
      : createLiveClientFactory(runDir, admission, providerCalls, inputGuard, phase);
  const key = mode === 'live' ? (options.apiKey ?? liveCredentials().key) : () => 'synthetic-only';
  if (mode === 'live') admission.pricePerToken = (await validateLiveCatalog()).pricePerToken;
  const semantic = new SemanticSearch({
    store,
    cachePath,
    apiKey: key,
    clientFactory: factory,
    maxBudgetEstimateUsd: LIVE_ADMISSION_ESTIMATE_USD,
    timeoutMs: 12_000,
  });
  const rows = [] as Array<Record<string, unknown>>;
  const warmRows = [] as Array<Record<string, unknown>>;
  const latencies: number[] = [];
  const warmLatencies: number[] = [];
  let stopReason: string | null = null;
  const factsHash = sha256(JSON.stringify(facts));
  try {
    const inventory = store.freshMemoryInventory({ project: 'alpha', revision: 'rev1' });
    for (const item of cases) {
      if (skipCaseIds.includes(item.id)) continue;
      const fts = store
        .searchPromptMemories({ project: 'alpha', query: item.query, limit: 64 })
        .map((memory) => ({ key: memory.key }));
      const callIndex = providerCalls.length;
      const estimate =
        mode === 'live' && providerCalls.length === 0
          ? estimateCallUsd([item.query, ...inventory.records.map((memory) => memory.text)], admission.pricePerToken)
          : mode === 'live'
            ? estimateCallUsd([item.query], admission.pricePerToken)
            : 0;
      if (
        mode === 'live' &&
        (admission.totalEstimateUsd + estimate > LIVE_ADMISSION_ESTIMATE_USD ||
          providerCalls.length >= (options.maxCalls ?? MAX_LIVE_CALLS))
      ) {
        stopReason = 'live_estimate_or_call_limit';
        break;
      }
      const started = performance.now();
      const result = await semantic.search({
        project: 'alpha',
        revision: 'rev1',
        query: item.query,
        allowPaid: true,
        budgetEstimateUsd: mode === 'live' ? Math.max(estimate, 0.000001) : 0.01,
        idempotencyKey: `query-${item.id}`,
      });
      latencies.push(performance.now() - started);
      if (mode === 'live' && providerCalls[callIndex]) {
        const call = providerCalls[callIndex]!;
        if (result.request.costUsd !== null) call.costUsd = result.request.costUsd;
        if (result.request.responseModel) call.responseModel = result.request.responseModel;
        call.identitySource = result.request.identitySource;
        call.providerName = result.request.providerName;
        call.authoritativeCostUsd = result.request.authoritativeCostUsd;
        const identityPath = join(runDir, `call-${String(call.call).padStart(2, '0')}-identity.json`);
        safeWriteExclusive(identityPath, {
          phase: 'identity-verification',
          at: new Date().toISOString(),
          responseId: result.request.id ?? call.responseId ?? null,
          responseModel: result.request.responseModel ?? call.responseModel ?? null,
          identitySource: result.request.identitySource ?? null,
          providerName: result.request.providerName ?? null,
          authoritativeCostUsd: result.request.authoritativeCostUsd ?? null,
          status: result.status,
          error: result.error ?? null,
        });
      }
      const rankRows = result.candidates.map((candidate) => candidate);
      const scored = scoreQuery(fts, rankRows, item.gold);
      rows.push({
        id: item.id,
        kind: item.kind,
        query: item.query,
        gold: item.gold,
        score: scored,
        coverage: result.coverage,
        latencyMs: round(latencies.at(-1)!),
        status: result.status,
        error: result.error ?? null,
        costUsd: result.request.costUsd,
        usageTokens: result.request.usageTokens,
        requestId: result.request.id ?? null,
        responseModel: result.request.responseModel ?? null,
        identitySource: result.request.identitySource ?? null,
        providerName: result.request.providerName ?? null,
        authoritativeCostUsd: result.request.authoritativeCostUsd ?? null,
      });
      const receipt = mode === 'live' ? rowForIntent(cachePath, 'alpha', `query-${item.id}`) : undefined;
      if (mode === 'live') {
        const call = providerCalls.at(-1);
        if (result.status !== 'complete') {
          stopReason =
            result.error === 'invalid_response'
              ? 'provider_response_invalid'
              : result.error === 'identity_unverified'
                ? 'identity_unverified'
                : result.request.costUsd === null || !receipt || receipt.costUsd === null
                  ? 'unknown_cost_or_unverified_request'
                  : 'request_not_complete';
          break;
        }
        if (
          result.request.costUsd === null ||
          !receipt ||
          receipt.status !== 'complete' ||
          receipt.costUsd === null ||
          receipt.costUsd !== result.request.costUsd
        ) {
          stopReason = 'unknown_cost_or_unverified_request';
          break;
        }
        if (!call || callIndex === providerCalls.length) {
          stopReason = 'missing_checkpoint_receipt';
          break;
        }
      }
      if (result.status !== 'complete') continue;
      const attemptsBeforeWarm = phase.networkAttempts;
      phase.warm = true;
      const warmStarted = performance.now();
      const warm = await semantic.search({
        project: 'alpha',
        revision: 'rev1',
        query: item.query,
        allowPaid: true,
        budgetEstimateUsd: mode === 'live' ? Math.max(estimate, 0.000001) : 0.01,
        idempotencyKey: `warm-${item.id}`,
      });
      const warmLatency = performance.now() - warmStarted;
      warmLatencies.push(warmLatency);
      phase.warm = false;
      const warmPassed =
        warm.status === 'complete' &&
        warm.request.costUsd === 0 &&
        warm.request.usageTokens === 0 &&
        warm.cache.queryHit &&
        warm.cache.factHits === warm.coverage.considered &&
        warm.cache.factMisses === 0 &&
        phase.networkAttempts === attemptsBeforeWarm;
      warmRows.push({
        id: item.id,
        latencyMs: round(warmLatency),
        status: warm.status,
        error: warm.error ?? null,
        cache: warm.cache,
        costUsd: warm.request.costUsd,
        usageTokens: warm.request.usageTokens,
        providerAttemptsDelta: phase.networkAttempts - attemptsBeforeWarm,
        guardRefusals: phase.warmCacheMissRefusals,
        passed: warmPassed,
      });
      if (!warmPassed) {
        stopReason = phase.warmCacheMissRefusals ? 'warm_cache_miss_refused' : 'warm_cache_assertion_failed';
      }
      if (mode === 'live' && runDir)
        writeRunReport(
          runDir,
          buildReport({
            mode,
            rows,
            warmRows,
            latencies,
            warmLatencies,
            providerCalls,
            stopReason,
            factsHash,
            inputGuard,
            inventoryCount: inventory.total,
            phase,
            skippedCaseIds: skipCaseIds,
          }),
        );
      if (stopReason) break;
    }
    const safety = await localSafetyChecks();
    const report = buildReport({
      mode,
      rows,
      warmRows,
      warmLatencies,
      latencies,
      providerCalls,
      stopReason,
      factsHash,
      inputGuard,
      inventoryCount: inventory.total,
      safety,
      phase,
      skippedCaseIds: skipCaseIds,
    });
    if (mode === 'live') writeRunReport(runDir, report);
    return report;
  } finally {
    await semantic.shutdown();
    store.close();
    if (ownsDir) rmSyncSafe(runDir);
  }
}

function buildReport(input: {
  mode: RunMode;
  rows: Array<Record<string, unknown>>;
  warmRows?: Array<Record<string, unknown>>;
  latencies: number[];
  warmLatencies?: number[];
  providerCalls: CallReceipt[];
  stopReason: string | null;
  factsHash: string;
  inputGuard: ProviderInputGuard;
  inventoryCount: number;
  safety?: Record<string, unknown>;
  phase?: BenchmarkPhase;
  skippedCaseIds?: string[];
}): Record<string, unknown> {
  const metricRows = input.rows as Array<{ id: string; kind: string; score: ReturnType<typeof scoreQuery> }>;
  const known = metricRows.filter((row) => row.kind === 'known');
  const ambiguous = metricRows.filter((row) => row.kind === 'ambiguous');
  const unknown = metricRows.filter((row) => row.kind === 'unknown');
  const sorted = [...input.latencies].sort((a, b) => a - b);
  const knownMetrics = summarizeRows(metricRows, 'known');
  const ambiguousMetrics = summarizeRows(metricRows, 'ambiguous');
  const cleanMetrics = (value: ReturnType<typeof summarizeRows>) => ({
    fts: { recallAt1: value.ftsRecallAt1, recallAt3: value.ftsRecallAt3, mrr: value.ftsMrr },
    candidateRanking: {
      recallAt1: value.semanticRecallAt1,
      recallAt3: value.semanticRecallAt3,
      mrr: value.semanticMrr,
    },
  });
  const warmSorted = [...(input.warmLatencies ?? [])].sort((a, b) => a - b);
  return {
    benchmark: 'semantic-search-candidates',
    at: new Date().toISOString(),
    node: process.version,
    mode: input.mode,
    model: input.mode === 'live' ? BGE_M3.canonical : 'deterministic-mock-only',
    corpus: {
      facts: input.inventoryCount,
      sha256: input.factsHash,
      languages: ['English', 'French'],
      source: 'synthetic fixture; no user memory',
    },
    providerPolicy: { only: [...BGE_M3_PROVIDER_POLICY.only], allowFallbacks: false },
    caseCount: input.rows.length,
    skippedCaseIds: input.skippedCaseIds ?? [],
    known: { count: known.length, ...cleanMetrics(knownMetrics) },
    ambiguous: {
      count: ambiguous.length,
      ...cleanMetrics(ambiguousMetrics),
      interpretation: 'Acceptable candidate sets are descriptive; no threshold or confidence claim.',
    },
    unknown: {
      count: unknown.length,
      topCandidates: unknown.map((row) => ({
        id: row.id,
        top: (row.score as ReturnType<typeof scoreQuery>).semantic.top,
      })),
      interpretation:
        'The API returns ranked candidates without an abstention threshold; top candidate is not an asserted answer.',
    },
    rows: input.rows,
    warmCache: {
      count: (input.warmRows ?? []).length,
      passed: (input.warmRows ?? []).filter((row) => row.passed === true).length,
      rows: input.warmRows ?? [],
      latencyMs: {
        samples: (input.warmLatencies ?? []).map(round),
        median: warmSorted.length ? round(warmSorted[Math.floor(warmSorted.length / 2)]) : null,
        p95: warmSorted.length ? round(warmSorted[Math.ceil(warmSorted.length * 0.95) - 1]!) : null,
      },
      providerNetworkAttempts: 0,
      requirement:
        'fresh idempotency key; exact query; all vectors warm; adapter refuses provider dispatch on cache miss',
    },
    latencyMs: {
      samples: input.latencies.map(round),
      median: sorted.length ? round(sorted[Math.floor(sorted.length / 2)]) : null,
      p95: sorted.length ? round(sorted[Math.ceil(sorted.length * 0.95) - 1]!) : null,
    },
    paid: {
      calls: input.providerCalls.length,
      receipts: input.providerCalls.map((call) => ({
        call: call.call,
        costUsd: call.costUsd,
        inputCount: call.inputCount,
        estimateUsd: call.estimateUsd,
        responseModel: call.responseModel ?? null,
        responseId: call.responseId ?? null,
        identitySource: call.identitySource ?? null,
        providerName: call.providerName ?? null,
        authoritativeCostUsd: call.authoritativeCostUsd ?? null,
      })),
      admissionEstimateUsd: LIVE_ADMISSION_ESTIMATE_USD,
      actualCostSum: input.providerCalls.every((call) => call.costUsd !== null)
        ? Number(input.providerCalls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0).toPrecision(12))
        : null,
      stopReason: input.stopReason,
      statement: 'Estimates are admission hints, not hard spend caps. Unknown provider costs stop further calls.',
    },
    providerInputGuard: {
      passed: !input.inputGuard.goldLabelsSent && !input.inputGuard.crossProjectFactSent,
      ...input.inputGuard,
      source: 'gold labels and cross-project sentinels are checked against every embeddings input',
    },
    providerDispatch: {
      networkAttempts: input.phase?.networkAttempts ?? 0,
      warmCacheMissRefusals: input.phase?.warmCacheMissRefusals ?? 0,
    },
    safetyChecks: input.safety ?? null,
    claims: {
      retrievalQuality: 'only measured in live mode against the listed synthetic cases',
      unknownAbstention: 'not implemented; not claimed',
      modelResponses: 'embeddings only; no generated answer',
    },
    sourceSha256: {
      benchmark: sha256(readFileSync(fileURLToPath(import.meta.url))),
      semanticModule: sha256(readFileSync(new URL('../src/context/semantic.ts', import.meta.url))),
      storeModule: sha256(readFileSync(new URL('../src/context/store.ts', import.meta.url))),
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode: RunMode = process.argv.includes('--live') ? 'live' : 'mock';
  const skipCaseIds = process.argv.includes('--remaining-five')
    ? [...FINAL_FIVE_SKIP_CASE_IDS]
    : process.argv.includes('--remaining-six')
      ? ['en-language-exact', 'en-language-paraphrase']
      : [];
  try {
    if (mode === 'live') {
      const runDir = createExclusiveRunDirectory(process.env.BENCH_RESULTS_DIR ?? '');
      const creds = liveCredentials();
      const report = await runSemanticSearchBenchmark({ mode, runDir, apiKey: creds.key, skipCaseIds });
      process.stdout.write(
        `${JSON.stringify({ runDir, mode, caseCount: report.caseCount as number, calls: (report.paid as any).calls, stopReason: (report.paid as any).stopReason })}\n`,
      );
    } else {
      const report = await runSemanticSearchBenchmark({ mode, skipCaseIds });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'semantic benchmark failed'}\n`);
    process.exitCode = 1;
  }
}
