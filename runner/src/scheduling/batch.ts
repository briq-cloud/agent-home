import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { OpenRouter } from '@openrouter/sdk';
import type { BatchObject } from '@openrouter/sdk/models';
import type { RequestOptions } from '@openrouter/sdk/lib/sdks.js';

/** Narrow, injectable surface for the official OpenRouter batch endpoint. */
export interface BatchClient {
  batch: {
    createBatches(
      request: {
        batchSubmitBody: {
          endpoint: '/v1/chat/completions';
          model: string;
          completionWindow: '24h';
          requests: Array<{ customId: string; body: Record<string, unknown> }>;
        };
      },
      options?: RequestOptions,
    ): Promise<BatchObject>;
    getBatches(request: { id: string }, options?: RequestOptions): Promise<BatchObject>;
  };
}

export type BatchInput = {
  /** Caller-generated idempotency key, reused only for an identical normalized intent. */
  idempotencyKey: string;
  /** Fixed offline transformations only; no general decision/prompt endpoint. */
  operation: 'summarize' | 'extract' | 'rewrite';
  /** Text inputs only. Never used for CLI/ACP traffic, tool use, or agent decisions. */
  items: Array<{ id: string; text: string }>;
  model: string;
  /** Explicit paid-use consent for this particular batch. */
  allowPaid: true;
  /** Caller-provided estimate; provider charges can exceed it. */
  budgetEstimateUsd: number;
};

export type BatchJobState =
  | 'submitting'
  | 'submission_unknown'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';
export type BatchTextResult = { id: string; text?: string; error?: string; costUsd: number | null };
export type BatchCostSource = 'batch-usage.cost' | 'result-usage.cost' | null;
export type BatchJob = {
  localId: string;
  providerBatchId?: string;
  state: BatchJobState;
  providerStatus?: string;
  model: string;
  budgetEstimateUsd: number;
  /** Actual cost only when every result supplies a valid finite cost. */
  totalCostUsd: number | null;
  costSource: BatchCostSource;
  results?: BatchTextResult[];
  error?: string;
  createdAt: number;
  costNote: 'caller estimate only; actual provider charges may be higher';
};

export type BatchAdapterOptions = {
  dbPath: string;
  /** Reads the existing home API key only when an API call is needed. The result is never persisted. */
  getApiKey: () => string | Promise<string>;
  /** Caller-selected estimate ceiling. This does not cap actual provider billing. */
  maxEstimatedUsd: number;
  clientFactory?: (getApiKey: () => Promise<string>) => BatchClient;
  now?: () => number;
  timeoutMs?: number;
};

const MAX_ITEMS = 16;
const MAX_ID_CHARS = 80;
const MAX_TEXT_CHARS = 8_000;
const MAX_TOTAL_INPUT_CHARS = 48_000;
const MAX_OUTPUT_TOKENS = 512;
const MAX_RESULT_CHARS = 4_096;
const MAX_TOTAL_RESULT_CHARS = 16 * MAX_RESULT_CHARS;
const MAX_PENDING_JOBS = 16;
const TERMINAL = new Set(['completed', 'failed', 'expired', 'cancelled']);
const COST_NOTE = 'caller estimate only; actual provider charges may be higher' as const;
const GENERIC_SUBMISSION_ERROR =
  'provider submission failed; outcome is unknown; do not resubmit this job automatically';
const GENERIC_POLL_ERROR = 'provider polling failed; the saved provider ID remains available for retry';
const GENERIC_BATCH_ERROR = 'provider batch ended in a failed state; inspect the provider dashboard for details';
const GENERIC_ITEM_ERROR = 'provider reported an error for this request';
const KNOWN_PROVIDER_STATUSES = new Set([
  'validating',
  'in_progress',
  'finalizing',
  'completed',
  'failed',
  'expired',
  'cancelling',
  'cancelled',
]);

function officialClient(getApiKey: () => Promise<string>): BatchClient {
  return new OpenRouter({
    apiKey: getApiKey,
    serverURL: 'https://openrouter.ai/api/v1',
    appTitle: 'Agent Home opt-in text batch',
    retryConfig: { strategy: 'none' },
  }) as unknown as BatchClient;
}

/**
 * Explicit, bounded OpenRouter batch adapter for offline text transformations.
 * Persisted job rows contain prompt intent and provider batch IDs, never API keys.
 */
export class TextBatchAdapter {
  readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly clientFactory: (getApiKey: () => Promise<string>) => BatchClient;
  private readonly options: BatchAdapterOptions;
  private readonly activePolls = new Map<string, Promise<BatchJob>>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private closing = false;
  private closed = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: BatchAdapterOptions) {
    this.options = options;
    if (!Number.isFinite(options.maxEstimatedUsd) || options.maxEstimatedUsd < 0)
      throw new RangeError('maxEstimatedUsd must be a finite non-negative number');
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
      throw new RangeError('timeoutMs must be an integer between 1 and 30000');
    mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
    const privateFd = openSync(options.dbPath, 'a', 0o600);
    closeSync(privateFd);
    chmodSync(options.dbPath, 0o600);
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batch_jobs (
        local_id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        state TEXT NOT NULL,
        provider_id TEXT,
        provider_status TEXT,
        intent_json TEXT NOT NULL,
        results_json TEXT,
        total_cost_usd REAL,
        cost_source TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = this.db.prepare('PRAGMA table_info(batch_jobs)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'total_cost_usd'))
      this.db.exec('ALTER TABLE batch_jobs ADD COLUMN total_cost_usd REAL');
    if (!columns.some((column) => column.name === 'cost_source'))
      this.db.exec('ALTER TABLE batch_jobs ADD COLUMN cost_source TEXT');
    if (!columns.some((column) => column.name === 'idempotency_key'))
      this.db.exec('ALTER TABLE batch_jobs ADD COLUMN idempotency_key TEXT');
    this.db.exec(`UPDATE batch_jobs SET idempotency_key='legacy:'||local_id WHERE idempotency_key IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS batch_jobs_idempotency_key ON batch_jobs(idempotency_key);`);
    // If the process died during POST, the server may have accepted the job. Never retry blindly.
    this.db
      .prepare(
        `UPDATE batch_jobs SET state='submission_unknown', error='process stopped before provider ID was recorded', updated_at=? WHERE state='submitting'`,
      )
      .run((options.now ?? Date.now)());
    this.now = options.now ?? Date.now;
    this.timeoutMs = timeoutMs;
    this.clientFactory = options.clientFactory ?? officialClient;
  }

  close(): void {
    if (this.closed) return;
    if (this.activeOperations.size > 0)
      throw new Error('batch adapter has operations in flight; await shutdown() before closing');
    this.closing = true;
    this.db.close();
    this.closed = true;
  }

  /** Stop accepting work, await bounded provider requests, then close durable state. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.closed) return Promise.resolve();
    this.closing = true;
    this.shutdownPromise = Promise.allSettled([...this.activeOperations]).then(() => this.close());
    return this.shutdownPromise;
  }

  submit(input: BatchInput): Promise<BatchJob> {
    if (this.closing || this.closed) return Promise.reject(new Error('batch adapter is shutting down'));
    return this.track(this.submitOnce(input));
  }

  private async submitOnce(input: BatchInput): Promise<BatchJob> {
    validateInput(input, this.options.maxEstimatedUsd);
    const normalizedIntent = normalizedIntentJson(input);
    const localId = randomUUID();
    const createdAt = this.now();
    let reusable: BatchJob | undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.findByKey(input.idempotencyKey);
      if (prior) {
        reusable = this.reuseOrConflict(prior, normalizedIntent);
      } else {
        const pending = this.db
          .prepare(
            `SELECT count(*) AS count FROM batch_jobs WHERE state IN ('submitting','submission_unknown','submitted')`,
          )
          .get() as { count: number };
        if (pending.count >= MAX_PENDING_JOBS)
          throw new RangeError(`at most ${MAX_PENDING_JOBS} unsettled batch jobs are allowed`);
        const inserted = this.db
          .prepare(`INSERT INTO batch_jobs(local_id,idempotency_key,state,intent_json,created_at,updated_at)
          VALUES (?,?, 'submitting',?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
          .run(localId, input.idempotencyKey, normalizedIntent, createdAt, createdAt);
        if (Number(inserted.changes) === 0) {
          const concurrent = this.findByKey(input.idempotencyKey);
          if (!concurrent) throw new Error('idempotent batch reservation failed');
          reusable = this.reuseOrConflict(concurrent, normalizedIntent);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* Preserve the reservation failure. */
      }
      throw error;
    }
    if (reusable) return reusable;
    try {
      const client = this.makeClient();
      const providerBatch = await client.batch.createBatches(
        {
          batchSubmitBody: {
            endpoint: '/v1/chat/completions',
            model: input.model,
            completionWindow: '24h',
            requests: input.items.map((item) => ({
              customId: item.id,
              body: {
                model: input.model,
                messages: [
                  { role: 'system', content: transformationPrompt(input.operation) },
                  { role: 'user', content: item.text },
                ],
                max_tokens: MAX_OUTPUT_TOKENS,
              },
            })),
          },
        },
        this.requestOptions(),
      );
      if (!validProviderId(providerBatch.id)) throw new Error('invalid provider batch ID');
      // Persist the provider ID before any GET/poll is possible.
      this.db
        .prepare(
          `UPDATE batch_jobs SET state='submitted',provider_id=?,provider_status=?,updated_at=? WHERE local_id=?`,
        )
        .run(providerBatch.id, safeProviderStatus(providerBatch.status), this.now(), localId);
      return this.read(localId)!;
    } catch {
      this.db
        .prepare(`UPDATE batch_jobs SET state='submission_unknown',error=?,updated_at=? WHERE local_id=?`)
        .run(GENERIC_SUBMISSION_ERROR, this.now(), localId);
      throw new BatchSubmissionUnknownError(localId);
    }
  }

  /** Read durable local state; it never contacts the provider. */
  read(localId: string): BatchJob | undefined {
    const row = this.db
      .prepare(
        `SELECT local_id,state,provider_id,provider_status,intent_json,results_json,total_cost_usd,cost_source,error,created_at FROM batch_jobs WHERE local_id=?`,
      )
      .get(localId) as
      | {
          local_id: string;
          state: BatchJobState;
          provider_id: string | null;
          provider_status: string | null;
          intent_json: string;
          results_json: string | null;
          total_cost_usd: number | null;
          cost_source: BatchCostSource;
          error: string | null;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    const intent = JSON.parse(row.intent_json) as BatchInput;
    return {
      localId: row.local_id,
      ...(row.provider_id ? { providerBatchId: row.provider_id } : {}),
      state: row.state,
      ...(row.provider_status ? { providerStatus: safeProviderStatus(row.provider_status) } : {}),
      model: intent.model,
      budgetEstimateUsd: intent.budgetEstimateUsd,
      totalCostUsd: row.total_cost_usd,
      costSource: row.cost_source,
      ...(row.results_json ? { results: JSON.parse(row.results_json) as BatchTextResult[] } : {}),
      ...(row.state === 'submission_unknown' ? { error: GENERIC_SUBMISSION_ERROR } : {}),
      ...(row.state === 'failed' ? { error: GENERIC_BATCH_ERROR } : {}),
      createdAt: row.created_at,
      costNote: COST_NOTE,
    };
  }

  /** Polls only the already-recorded provider ID. Unknown submission state is never resubmitted. */
  poll(localId: string): Promise<BatchJob> {
    if (this.closing || this.closed) return Promise.reject(new Error('batch adapter is shutting down'));
    const prior = this.activePolls.get(localId);
    if (prior) return prior;
    const pending = this.track(this.pollOnce(localId));
    this.activePolls.set(localId, pending);
    void pending
      .finally(() => {
        if (this.activePolls.get(localId) === pending) this.activePolls.delete(localId);
      })
      .catch(() => undefined);
    return pending;
  }

  private async pollOnce(localId: string): Promise<BatchJob> {
    const job = this.read(localId);
    if (!job) throw new Error('batch job not found');
    if (job.state === 'submission_unknown')
      throw new Error('provider submission is unknown; automatic resubmission is disabled');
    if (job.state === 'submitting') throw new Error('provider ID is not yet available');
    if (TERMINAL.has(job.state)) return job;
    if (!job.providerBatchId || !validProviderId(job.providerBatchId))
      throw new Error('submitted job is missing a valid provider ID');

    let providerBatch: BatchObject;
    try {
      providerBatch = await this.makeClient().batch.getBatches({ id: job.providerBatchId }, this.requestOptions());
    } catch {
      throw new Error(GENERIC_POLL_ERROR);
    }
    if (providerBatch.id !== job.providerBatchId) throw new Error('provider returned a mismatched batch ID');
    const state = normalizeState(providerBatch.status);
    let results: BatchTextResult[] | undefined;
    let totalCostUsd: number | null = null;
    let costSource: BatchCostSource = null;
    if (state === 'completed') {
      const intent = this.db.prepare('SELECT intent_json FROM batch_jobs WHERE local_id=?').get(localId) as {
        intent_json: string;
      };
      results = parseResults(providerBatch, (JSON.parse(intent.intent_json) as BatchInput).items);
      const providerTotal = usageCost(providerBatch.usage);
      if (providerTotal !== null) {
        totalCostUsd = providerTotal;
        costSource = 'batch-usage.cost';
      } else {
        const fallback = totalCost(results);
        totalCostUsd = fallback.total;
        costSource = fallback.source;
      }
    }
    if (
      results &&
      results.reduce((sum, result) => sum + (result.text?.length ?? 0) + (result.error?.length ?? 0), 0) >
        MAX_TOTAL_RESULT_CHARS
    )
      throw new RangeError('batch result exceeds total output limit');
    const error = state === 'failed' ? GENERIC_BATCH_ERROR : undefined;
    this.db
      .prepare(
        `UPDATE batch_jobs SET state=?,provider_status=?,results_json=?,total_cost_usd=?,cost_source=?,error=?,updated_at=? WHERE local_id=? AND state='submitted'`,
      )
      .run(
        state,
        safeProviderStatus(providerBatch.status),
        results ? JSON.stringify(results) : null,
        totalCostUsd,
        costSource,
        error ?? null,
        this.now(),
        localId,
      );
    return this.read(localId)!;
  }

  /** Bounded inspection API for local jobs; provider is never contacted. */
  list(options: { limit?: number; offset?: number } = {}): BatchJob[] {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('job list limit must be 1-100');
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
      throw new RangeError('job list offset must be 0-100000');
    const rows = this.db
      .prepare('SELECT local_id FROM batch_jobs ORDER BY created_at DESC,local_id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Array<{ local_id: string }>;
    return rows.map((row) => this.read(row.local_id)!).filter(Boolean);
  }

  /** Current unsettled local work; includes ambiguous submissions for operator inspection. */
  pending(): BatchJob[] {
    const rows = this.db
      .prepare(`SELECT local_id FROM batch_jobs WHERE state IN ('submitting','submission_unknown','submitted')
      ORDER BY created_at,local_id LIMIT ?`)
      .all(MAX_PENDING_JOBS) as Array<{ local_id: string }>;
    return rows.map((row) => this.read(row.local_id)!).filter(Boolean);
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    let tracked: Promise<T>;
    tracked = operation.finally(() => this.activeOperations.delete(tracked));
    this.activeOperations.add(tracked);
    return tracked;
  }

  private findByKey(key: string): { local_id: string; intent_json: string } | undefined {
    return this.db.prepare('SELECT local_id,intent_json FROM batch_jobs WHERE idempotency_key=?').get(key) as
      | { local_id: string; intent_json: string }
      | undefined;
  }

  private reuseOrConflict(prior: { local_id: string; intent_json: string }, intent: string): BatchJob {
    if (prior.intent_json !== intent) throw new Error('idempotency key was already used for a different batch intent');
    const existing = this.read(prior.local_id);
    if (!existing) throw new Error('idempotent batch record is unavailable');
    return existing;
  }

  private makeClient(): BatchClient {
    return this.clientFactory(async () => {
      const apiKey = await this.options.getApiKey();
      if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('OpenRouter API key unavailable');
      return apiKey;
    });
  }

  private requestOptions(): RequestOptions {
    return { timeoutMs: this.timeoutMs, retries: { strategy: 'none' } };
  }
}

export class BatchSubmissionUnknownError extends Error {
  readonly localId: string;
  constructor(localId: string) {
    super(`${GENERIC_SUBMISSION_ERROR} (local job ${localId})`);
    this.name = 'BatchSubmissionUnknownError';
    this.localId = localId;
  }
}

function validateInput(input: BatchInput, maxEstimate: number): void {
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(input.idempotencyKey))
    throw new Error('idempotencyKey must contain 1-80 safe characters');
  if (input.allowPaid !== true) throw new Error('explicit allowPaid: true is required');
  if (
    !Number.isFinite(input.budgetEstimateUsd) ||
    input.budgetEstimateUsd <= 0 ||
    input.budgetEstimateUsd > maxEstimate
  )
    throw new RangeError(
      `budget estimate must be greater than $0 and no more than $${maxEstimate}; it is not a hard billing cap`,
    );
  if (
    typeof input.model !== 'string' ||
    input.model.length > 160 ||
    !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(input.model)
  )
    throw new Error('model must be a bounded provider/model slug');
  if (isMovingAlias(input.model)) throw new Error('moving model aliases are not allowed; select a pinned model slug');
  if (input.operation !== 'summarize' && input.operation !== 'extract' && input.operation !== 'rewrite')
    throw new Error('operation must be summarize, extract, or rewrite');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_ITEMS)
    throw new RangeError(`batch must contain 1-${MAX_ITEMS} text items`);
  let total = 0;
  const ids = new Set<string>();
  for (const item of input.items) {
    if (!item || typeof item.id !== 'string' || item.id.length < 1 || item.id.length > MAX_ID_CHARS || ids.has(item.id))
      throw new Error('each item needs a unique 1-80 character ID');
    if (typeof item.text !== 'string' || item.text.length < 1 || item.text.length > MAX_TEXT_CHARS)
      throw new RangeError(`each text item must contain 1-${MAX_TEXT_CHARS} characters`);
    ids.add(item.id);
    total += item.text.length;
  }
  if (total > MAX_TOTAL_INPUT_CHARS) throw new RangeError(`batch input exceeds ${MAX_TOTAL_INPUT_CHARS} characters`);
}

function normalizedIntentJson(input: BatchInput): string {
  return JSON.stringify({
    operation: input.operation,
    items: input.items.map(({ id, text }) => ({ id, text })),
    model: input.model,
    allowPaid: true,
    budgetEstimateUsd: input.budgetEstimateUsd,
  });
}

function transformationPrompt(operation: BatchInput['operation']): string {
  if (operation === 'summarize')
    return 'Summarize the provided text accurately and concisely. Do not add facts or use tools.';
  if (operation === 'extract')
    return 'Extract the key facts stated in the provided text. Do not infer missing facts or use tools.';
  return 'Rewrite the provided text for clarity while preserving its meaning. Do not add facts or use tools.';
}

function normalizeState(providerStatus: string): BatchJobState {
  if (
    providerStatus === 'completed' ||
    providerStatus === 'failed' ||
    providerStatus === 'expired' ||
    providerStatus === 'cancelled'
  )
    return providerStatus;
  return 'submitted';
}

function parseResults(batch: BatchObject, expectedItems: BatchInput['items']): BatchTextResult[] {
  if (
    !Array.isArray(batch.results) ||
    batch.results.length > MAX_ITEMS ||
    batch.results.length !== expectedItems.length
  )
    throw new Error('provider results do not match requested item count');
  const expected = new Set(expectedItems.map((item) => item.id));
  const seen = new Set<string>();
  const results: BatchTextResult[] = [];
  for (const result of batch.results) {
    if (typeof result.customId !== 'string' || !expected.has(result.customId) || seen.has(result.customId))
      throw new Error('provider results contain a missing, duplicate, or unexpected item ID');
    seen.add(result.customId);
    const costUsd = resultCost(result.response?.body);
    if (result.error) {
      results.push({ id: result.customId, error: GENERIC_ITEM_ERROR, costUsd });
      continue;
    }
    const body = result.response?.body as unknown as
      | { choices?: Array<{ message?: { content?: unknown } }> }
      | undefined;
    const textValue = body?.choices?.[0]?.message?.content;
    if (typeof textValue !== 'string') {
      results.push({ id: result.customId, error: GENERIC_ITEM_ERROR, costUsd });
      continue;
    }
    if (textValue.length > MAX_RESULT_CHARS) throw new RangeError('provider result exceeds per-item output limit');
    results.push({ id: result.customId, text: textValue, costUsd });
  }
  if (seen.size !== expected.size) throw new Error('provider results omitted one or more requested items');
  return results;
}

function resultCost(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const usage = (body as { usage?: unknown }).usage;
  return usageCost(usage);
}

function usageCost(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const cost = (usage as { cost?: unknown }).cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function totalCost(results: BatchTextResult[]): { total: number | null; source: BatchCostSource } {
  if (results.some((result) => result.costUsd === null)) return { total: null, source: null };
  const total = results.reduce((sum, result) => sum + result.costUsd!, 0);
  return Number.isFinite(total) ? { total, source: 'result-usage.cost' } : { total: null, source: null };
}

function validProviderId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function safeProviderStatus(value: string): string {
  return KNOWN_PROVIDER_STATUSES.has(value) ? value : 'unknown';
}

function isMovingAlias(model: string): boolean {
  const moving = new Set(['auto', 'latest', 'current', 'default', 'stable', 'recommended']);
  return model
    .toLowerCase()
    .split(/[./:_-]+/)
    .some((part) => moving.has(part));
}
