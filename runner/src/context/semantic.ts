import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { OpenRouter } from '@openrouter/sdk';
import type { ContextStore, FreshMemoryInventory, MemoryRecord } from './store.ts';

/** Versioned API identity from OpenRouter's embeddings catalog (Oct 30, 2026). */
export const BGE_M3 = Object.freeze({ apiId: 'baai/bge-m3', canonical: 'baai/bge-m3-20251117', dimensions: 1024 });
const MAX_FACTS = 64;
const MAX_INPUT_BYTES = 4096;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHED_VECTORS = 1024;
const MAX_GLOBAL_CACHED_VECTORS = 4096;
const MAX_INFLIGHT_SEARCHES = 16;
const MAX_DURABLE_INTENTS = 1024;
// Intent history is deliberately not pruned: at capacity, further searches are refused so keys cannot be reused.
export const DEFAULT_BUDGET_ESTIMATE_CEILING_USD = 0.01;

export type EmbeddingPayload = {
  id?: string;
  model: string;
  data: Array<{ index?: number; embedding: number[] | string }>;
  usage?: { cost?: number; promptTokens?: number; totalTokens?: number };
};
export interface EmbeddingClient {
  generate(input: { model: string; input: string[] }, options: { timeoutMs: number; retries: { strategy: 'none' } }): Promise<EmbeddingPayload>;
}
export type SemanticSearchInput = {
  project: string;
  revision: string;
  query: string;
  allowPaid: true;
  /** Caller-provided admission estimate, not an actual-cost cap. Defaults to a $0.01 ceiling. */
  budgetEstimateUsd: number;
  idempotencyKey: string;
};
export type SemanticCandidate = {
  key: string;
  text: string;
  version: number;
  score: number;
  scoreMeaning: 'cosine similarity; not confidence';
  source: { path: string; hash: string; revision: string };
  trust: 'untrusted';
};
export type SemanticSearchResult = {
  status: 'complete' | 'blocked' | 'denied';
  project: string;
  revision: string;
  model: { apiId: string; canonical: string };
  candidates: SemanticCandidate[];
  coverage: { totalFreshInventory: number; considered: number; truncated: boolean };
  cache: { queryHit: boolean; factHits: number; factMisses: number };
  request: { id?: string; costUsd: number | null; usageTokens: number | null; estimateUsd: number };
  error?: 'missing_key' | 'budget_ceiling' | 'intent_capacity' | 'prior_intent_unknown' | 'prior_intent_conflict' | 'source_changed' | 'provider_failed' | 'invalid_response';
};
export type SemanticSearchOptions = {
  store: ContextStore;
  cachePath?: string;
  apiKey: () => string | undefined;
  model?: typeof BGE_M3;
  clientFactory?: (apiKey: string) => EmbeddingClient;
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxBudgetEstimateUsd?: number;
};

type VectorRow = { dimension: number; vector: Uint8Array; expires_at: number };
type IntentRow = { intent_hash: string; status: string; request_id: string | null; cost_usd: number | null; usage_tokens: number | null; result_json: string | null };
type VectorSlot = { kind: 'query' | 'fact'; key: string };
type VectorWrite = VectorSlot & { vector: number[] };

/** Explicit, paid, embeddings-only candidate search. It does not produce answers or inject prompts. */
export class SemanticSearch {
  private readonly store: ContextStore;
  private readonly db: DatabaseSync;
  private readonly apiKey: () => string | undefined;
  private readonly model: typeof BGE_M3;
  private readonly clientFactory: (key: string) => EmbeddingClient;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxBudgetEstimateUsd: number;
  private readonly active = new Set<Promise<unknown>>();
  private readonly byIdempotency = new Map<string, { intentHash: string; promise: Promise<SemanticSearchResult> }>();
  private readonly projectTails = new Map<string, Promise<void>>();
  private closing = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: SemanticSearchOptions) {
    this.store = options.store;
    this.apiKey = options.apiKey;
    this.model = options.model ?? BGE_M3;
    if (this.model.apiId !== BGE_M3.apiId || this.model.canonical !== BGE_M3.canonical || this.model.dimensions !== 1024)
      throw new Error('semantic model is not the pinned BGE-M3 catalog identity');
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
      throw new Error('timeoutMs must be a positive finite value');
    if (options.cacheTtlMs !== undefined && (!Number.isFinite(options.cacheTtlMs) || options.cacheTtlMs <= 0))
      throw new Error('cacheTtlMs must be a positive finite value');
    this.maxBudgetEstimateUsd = options.maxBudgetEstimateUsd ?? DEFAULT_BUDGET_ESTIMATE_CEILING_USD;
    if (!Number.isFinite(this.maxBudgetEstimateUsd) || this.maxBudgetEstimateUsd <= 0 || this.maxBudgetEstimateUsd > 0.1)
      throw new Error('maxBudgetEstimateUsd must be positive and at most $0.10');
    const dbPath = options.cachePath ?? ':memory:';
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      try { chmodSync(dbPath, 0o600); }
      catch (error) { this.db.close(); throw error; }
    }
    this.clientFactory = options.clientFactory ?? ((key) => {
      const client = new OpenRouter({ apiKey: key, retryConfig: { strategy: 'none' } }).embeddings;
      return { generate: async (req, opts) => {
        const response = await client.generate({ requestBody: { ...req, model: this.model.canonical, encodingFormat: 'float' } }, opts);
        if (typeof response === 'string') {
          if (Buffer.byteLength(response,'utf8') > 4_000_000) throw new Error('response exceeds bound');
          return JSON.parse(response) as EmbeddingPayload;
        }
        return response as EmbeddingPayload;
      } };
    });
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.max(1, Math.min(15_000, Math.floor(options.timeoutMs ?? 12_000)));
    this.cacheTtlMs = Math.max(60_000, Math.min(90 * 24 * 60 * 60 * 1000, Math.floor(options.cacheTtlMs ?? DEFAULT_TTL_MS)));
    // Separate private database: FULL durability for intents without slowing source/artifact writes.
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const versionRow = this.db.prepare('PRAGMA user_version').get() as {user_version:number};
      if (versionRow.user_version > 1) throw new Error(`semantic cache schema ${versionRow.user_version} is newer than supported schema 1`);
      this.db.exec('BEGIN IMMEDIATE;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS semantic_vectors (
        project TEXT NOT NULL, revision TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL,
        cache_key TEXT NOT NULL, dimension INTEGER NOT NULL, vector BLOB NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(project,revision,model,kind,cache_key)
      );
      CREATE INDEX IF NOT EXISTS semantic_vectors_expiry ON semantic_vectors(project,expires_at,created_at);
      CREATE TABLE IF NOT EXISTS semantic_intents (
        project TEXT NOT NULL, idempotency_key TEXT NOT NULL, intent_hash TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, request_id TEXT, cost_usd REAL,
        usage_tokens INTEGER, safe_error TEXT, result_json TEXT,
        PRIMARY KEY(project,idempotency_key)
      );`);
      const columns = this.db.prepare('PRAGMA table_info(semantic_intents)').all() as Array<{name:string}>;
      if (!columns.some((column) => column.name === 'result_json')) this.db.exec('ALTER TABLE semantic_intents ADD COLUMN result_json TEXT;');
      this.db.exec('PRAGMA user_version = 1;');
      this.db.exec('COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* Keep the schema error. */ }
      this.db.close();
      throw error;
    }
  }

  search(input: SemanticSearchInput): Promise<SemanticSearchResult> {
    if (this.closing) return Promise.reject(new Error('semantic search is shutting down'));
    validateInput(input);
    const hash = intentHash(input, this.model);
    const key = `${input.project}\0${input.idempotencyKey}`;
    const prior = this.byIdempotency.get(key);
    if (prior) return prior.intentHash === hash ? prior.promise : Promise.reject(new Error('idempotency key conflicts with an in-flight request'));
    if (this.active.size >= MAX_INFLIGHT_SEARCHES) return Promise.reject(new Error('semantic search concurrency limit reached'));
    const operation = this.withProjectLock(input.project, async () => this.searchLocked(input, hash));
    const entry = { intentHash: hash, promise: operation };
    this.byIdempotency.set(key, entry);
    this.active.add(operation);
    operation.finally(() => {
      this.active.delete(operation);
      if (this.byIdempotency.get(key) === entry) this.byIdempotency.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = Promise.allSettled([...this.active]).then(() => { this.db.close(); });
    return this.shutdownPromise;
  }

  private async searchLocked(input: SemanticSearchInput, intent: string): Promise<SemanticSearchResult> {
    const { store } = this;
    const base = (status: SemanticSearchResult['status'], error?: SemanticSearchResult['error']): SemanticSearchResult => ({
      status, project: input.project, revision: input.revision,
      model: { apiId: this.model.apiId, canonical: this.model.canonical }, candidates: [],
      coverage: { totalFreshInventory: 0, considered: 0, truncated: false },
      cache: { queryHit: false, factHits: 0, factMisses: 0 },
      request: { costUsd: null, usageTokens: null, estimateUsd: input.budgetEstimateUsd },
      ...(error ? { error } : {}),
    });
    if (input.allowPaid !== true || !Number.isFinite(input.budgetEstimateUsd) || input.budgetEstimateUsd <= 0)
      return base('denied');
    let inventory: FreshMemoryInventory;
    try { inventory = store.freshMemoryInventory({ project: input.project, revision: input.revision, limit: MAX_FACTS, maxRecordBytes: MAX_INPUT_BYTES }); }
    catch { return base('blocked', 'source_changed'); }
    const result = base('complete');
    result.coverage = { totalFreshInventory: inventory.total, considered: inventory.records.length, truncated: inventory.truncated };

    const existing = this.db.prepare('SELECT intent_hash,status,request_id,cost_usd,usage_tokens,result_json FROM semantic_intents WHERE project=? AND idempotency_key=?')
      .get(input.project, input.idempotencyKey) as IntentRow | undefined;
    if (existing && existing.intent_hash !== intent) return base('blocked', 'prior_intent_conflict');
    if (existing) {
      if (existing.status !== 'complete' || !existing.result_json) return base('blocked', 'prior_intent_unknown');
      const saved = parseSavedResult(existing.result_json);
      if (!saved) return base('blocked', 'prior_intent_unknown');
      if (saved.project !== input.project || saved.revision !== input.revision) return base('blocked', 'source_changed');
      if (saved.coverage.totalFreshInventory !== inventory.total || saved.coverage.truncated !== inventory.truncated)
        return { ...base('blocked', 'source_changed'), coverage: result.coverage };
      if (!matchesSavedInventory(saved, inventory.records)) return { ...base('blocked', 'source_changed'), coverage: result.coverage };
      return saved;
    }
    if (input.budgetEstimateUsd > this.maxBudgetEstimateUsd) return base('denied', 'budget_ceiling');
    if (!inventory.records.length) {
      result.request.costUsd = 0;
      result.request.usageTokens = 0;
      return this.saveCompletedIntent(input, intent, result) ? result : base('blocked', 'intent_capacity');
    }

    const modelKey = this.model.canonical;
    const qKey = hashText(input.query);
    let qVector = this.getVector(input.project, input.revision, modelKey, 'query', qKey);
    const cacheTouches: VectorSlot[] = [];
    if (qVector) cacheTouches.push({ kind:'query',key:qKey });
    result.cache.queryHit = qVector !== undefined;
    const factVectors: Array<number[] | undefined> = inventory.records.map((m) => this.getVector(input.project, input.revision, modelKey, 'fact', memoryKey(m)));
    inventory.records.forEach((memory,index) => { if (factVectors[index]) cacheTouches.push({kind:'fact',key:memoryKey(memory)}); });
    result.cache.factHits = factVectors.filter(Boolean).length;
    result.cache.factMisses = factVectors.length - result.cache.factHits;
    const missingTexts: string[] = [];
    const missingSlots: Array<{ kind: 'query' | 'fact'; key: string; recordIndex: number }> = [];
    const cacheWrites: VectorWrite[] = [];
    if (!qVector) { missingTexts.push(input.query); missingSlots.push({ kind: 'query', key: qKey, recordIndex: -1 }); }
    inventory.records.forEach((m, i) => { if (!factVectors[i]) { missingTexts.push(m.text); missingSlots.push({ kind: 'fact', key: memoryKey(m), recordIndex: i }); } });

    let requestId: string | undefined;
    let costUsd: number | null = null;
    let usageTokens: number | null = null;
    if (missingTexts.length) {
      let apiKey: string | undefined;
      try { apiKey = this.apiKey(); } catch { return base('denied', 'missing_key'); }
      if (!apiKey) return base('denied', 'missing_key');
      if (!this.reserveIntent(input, intent)) return base('blocked', 'intent_capacity');
      let response: EmbeddingPayload;
        try {
          response = await this.clientFactory(apiKey).generate({
            model: this.model.canonical,
            input: missingTexts,
          }, { timeoutMs: this.timeoutMs, retries: { strategy: 'none' } });
        } catch {
          this.updateIntent(input, 'unknown', undefined, null, null, 'provider_failed');
          return { ...base('blocked', 'provider_failed'), coverage: result.coverage, cache: result.cache };
        }
        const receipt = safeReceipt(response);
        requestId = receipt.id;
        costUsd = receipt.costUsd;
        usageTokens = receipt.usageTokens;
        // Persist the provider receipt before validating the vector payload or writing any vectors.
        this.updateIntent(input, 'received', requestId, costUsd, usageTokens, null);
        let parsed: ReturnType<typeof validateResponse>;
        try { parsed = validateResponse(response, missingTexts.length, this.model); }
        catch {
          this.updateIntent(input, 'unknown', requestId, costUsd, usageTokens, 'invalid_response');
          return { ...base('blocked', 'invalid_response'), coverage: result.coverage, cache: result.cache,
            request: { id: requestId, costUsd, usageTokens, estimateUsd: input.budgetEstimateUsd } };
        }
        requestId = parsed.id ?? requestId;
        costUsd = parsed.costUsd ?? costUsd;
        usageTokens = parsed.usageTokens ?? usageTokens;
        // Recheck scope and source hashes after the provider await, before caching or returning vectors.
        let fresh: FreshMemoryInventory;
        try { fresh = store.freshMemoryInventory({ project: input.project, revision: input.revision, limit: MAX_FACTS }); }
        catch {
          this.updateIntent(input, 'unknown', requestId, costUsd, usageTokens, 'source_changed');
          return { ...base('blocked', 'source_changed'), coverage: result.coverage, cache: result.cache,
            request: { id: requestId, costUsd, usageTokens, estimateUsd: input.budgetEstimateUsd } };
        }
        if (!sameInventory(inventory.records, fresh.records)) {
          this.updateIntent(input, 'unknown', requestId, costUsd, usageTokens, 'source_changed');
          return { ...base('blocked', 'source_changed'), coverage: result.coverage, cache: result.cache,
            request: { id: requestId, costUsd, usageTokens, estimateUsd: input.budgetEstimateUsd } };
        }
        for (let i = 0; i < parsed.vectors.length; i++) {
          const slot = missingSlots[i]!;
          cacheWrites.push({kind:slot.kind,key:slot.key,vector:parsed.vectors[i]!});
          if (slot.kind === 'query') qVector = parsed.vectors[i]!;
          else factVectors[slot.recordIndex] = parsed.vectors[i]!;
        }
    }
    // A project may have changed between initial inventory and a cache-only return too.
    let fresh: FreshMemoryInventory;
    try { fresh = store.freshMemoryInventory({ project: input.project, revision: input.revision, limit: MAX_FACTS, maxRecordBytes: MAX_INPUT_BYTES }); }
    catch { return { ...base('blocked', 'source_changed'), coverage: result.coverage }; }
    if (!sameInventory(inventory.records, fresh.records)) return { ...base('blocked', 'source_changed'), coverage: result.coverage, cache: result.cache };
    if (!qVector || factVectors.some((v) => !v)) return base('blocked', 'invalid_response');
    result.request = missingTexts.length
      ? { id: requestId, costUsd, usageTokens, estimateUsd: input.budgetEstimateUsd }
      : { costUsd: 0, usageTokens: 0, estimateUsd: input.budgetEstimateUsd };
    result.candidates = inventory.records.map((m, i) => ({
      key: m.key, text: m.text, version: m.version, score: cosine(qVector!, factVectors[i]!),
      scoreMeaning: 'cosine similarity; not confidence' as const, source: { ...m.source }, trust: 'untrusted' as const,
    })).sort((a,b) => b.score - a.score || a.key.localeCompare(b.key));
    try { this.updateCache(input.project,input.revision,modelKey,cacheTouches,cacheWrites); }
    catch { return { ...base('blocked', 'provider_failed'), coverage:result.coverage,cache:result.cache,request:result.request }; }
    return this.saveCompletedIntent(input, intent, result) ? result : base('blocked', 'intent_capacity');
  }

  private getVector(project: string, revision: string, model: string, kind: string, key: string): number[] | undefined {
    const row = this.db.prepare(`SELECT dimension,vector,expires_at FROM semantic_vectors WHERE project=? AND revision=? AND model=? AND kind=? AND cache_key=?`)
      .get(project, revision, model, kind, key) as VectorRow | undefined;
    if (!row) return undefined;
    if (row.expires_at <= this.now() || row.dimension !== this.model.dimensions) {
      this.db.prepare('DELETE FROM semantic_vectors WHERE project=? AND revision=? AND model=? AND kind=? AND cache_key=?').run(project,revision,model,kind,key);
      return undefined;
    }
    let vector: number[];
    try { vector = decodeVector(row.vector, row.dimension); }
    catch {
      this.db.prepare('DELETE FROM semantic_vectors WHERE project=? AND revision=? AND model=? AND kind=? AND cache_key=?').run(project,revision,model,kind,key);
      return undefined;
    }
    return vector;
  }

  private updateCache(project: string, revision: string, model: string, touches: VectorSlot[], writes: VectorWrite[]): void {
    if (!touches.length && !writes.length) return;
    const now = this.now(), expires = now + this.cacheTtlMs;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const touch = this.db.prepare(`UPDATE semantic_vectors SET expires_at=? WHERE project=? AND revision=? AND model=? AND kind=? AND cache_key=?`);
      for (const item of touches) touch.run(expires,project,revision,model,item.kind,item.key);
      const put = this.db.prepare(`INSERT OR REPLACE INTO semantic_vectors(project,revision,model,kind,cache_key,dimension,vector,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const item of writes) put.run(project,revision,model,item.kind,item.key,item.vector.length,
        new Uint8Array(Buffer.from(new Float64Array(item.vector).buffer)),now,expires);
      this.db.prepare('DELETE FROM semantic_vectors WHERE expires_at<=?').run(now);
      this.db.prepare('DELETE FROM semantic_vectors WHERE rowid IN (SELECT rowid FROM semantic_vectors WHERE project=? ORDER BY created_at DESC LIMIT -1 OFFSET ?)')
        .run(project,MAX_CACHED_VECTORS);
      this.db.prepare('DELETE FROM semantic_vectors WHERE rowid IN (SELECT rowid FROM semantic_vectors ORDER BY created_at DESC LIMIT -1 OFFSET ?)')
        .run(MAX_GLOBAL_CACHED_VECTORS);
      this.db.exec('COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* Preserve cache transaction failure. */ }
      throw error;
    }
  }

  private updateIntent(input: SemanticSearchInput, status: string, requestId?: string, cost: number | null = null, tokens: number | null = null, error: string | null = null): void {
    this.db.prepare(`UPDATE semantic_intents SET status=?,request_id=?,cost_usd=?,usage_tokens=?,safe_error=?,result_json=? WHERE project=? AND idempotency_key=?`)
      .run(status,requestId ?? null,cost,tokens,error,null,input.project,input.idempotencyKey);
  }

  private reserveIntent(input: SemanticSearchInput, intent: string): boolean {
    try {
      this.db.exec('BEGIN IMMEDIATE;');
      const row = this.db.prepare('SELECT COUNT(*) AS total FROM semantic_intents').get() as {total:number};
      if (row.total >= MAX_DURABLE_INTENTS) { this.db.exec('ROLLBACK;'); return false; }
      this.db.prepare(`INSERT INTO semantic_intents(project,idempotency_key,intent_hash,status,created_at)
        VALUES (?,?,?,'intent',?)`).run(input.project,input.idempotencyKey,intent,this.now());
      this.db.exec('COMMIT;');
      return true;
    } catch {
      try { this.db.exec('ROLLBACK;'); } catch { /* Preserve the safe failure result. */ }
      return false;
    }
  }

  private saveCompletedIntent(input: SemanticSearchInput, intent: string, result: SemanticSearchResult): boolean {
    const existing = this.db.prepare('SELECT intent_hash FROM semantic_intents WHERE project=? AND idempotency_key=?')
      .get(input.project,input.idempotencyKey) as {intent_hash:string}|undefined;
    if (existing && existing.intent_hash !== intent) return false;
    if (!existing && !this.reserveIntent(input,intent)) return false;
    this.db.prepare(`UPDATE semantic_intents SET status='complete',request_id=?,cost_usd=?,usage_tokens=?,safe_error=NULL,result_json=? WHERE project=? AND idempotency_key=?`)
      .run(result.request.id ?? null,result.request.costUsd,result.request.usageTokens,JSON.stringify(result),input.project,input.idempotencyKey);
    return true;
  }

  private async withProjectLock<T>(project: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.projectTails.get(project) ?? Promise.resolve();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => barrier);
    this.projectTails.set(project, tail);
    await previous;
    if (this.closing) {
      release();
      if (this.projectTails.get(project) === tail) this.projectTails.delete(project);
      throw new Error('semantic search is shutting down');
    }
    try { return await fn(); }
    finally { release(); if (this.projectTails.get(project) === tail) this.projectTails.delete(project); }
  }
}

function validateInput(input: SemanticSearchInput): void {
  for (const [name, value] of Object.entries({ project: input.project, revision: input.revision, query: input.query, idempotencyKey: input.idempotencyKey })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  }
  if (Buffer.byteLength(input.project,'utf8') > 256 || Buffer.byteLength(input.revision,'utf8') > 256)
    throw new RangeError('project and revision are limited to 256 bytes each');
  if (Buffer.byteLength(input.query, 'utf8') > MAX_INPUT_BYTES) throw new RangeError('query exceeds 4096 byte limit');
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(input.idempotencyKey)) throw new Error('invalid idempotencyKey');
  if (!Number.isFinite(input.budgetEstimateUsd) || input.budgetEstimateUsd <= 0) throw new Error('budgetEstimateUsd must be positive');
  if (input.allowPaid !== true) throw new Error('allowPaid must be explicitly true');
}
function intentHash(input: SemanticSearchInput, model: typeof BGE_M3): string {
  return hashText(JSON.stringify([input.project,input.revision,input.query,model.canonical,input.allowPaid,input.budgetEstimateUsd]));
}
function memoryKey(m: MemoryRecord): string { return hashText(JSON.stringify([m.key,m.version,hashText(m.text),m.source.revision,m.source.path,m.source.hash])); }
function hashText(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function safeId(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 && value.length <= 160 ? value : undefined; }
function safeReceipt(response: unknown): { id?: string; costUsd: number | null; usageTokens: number | null } {
  if (!response || typeof response !== 'object') return { costUsd:null,usageTokens:null };
  const value = response as {id?:unknown;usage?:{cost?:unknown;totalTokens?:unknown;promptTokens?:unknown}};
  const cost=value.usage?.cost, tokens=value.usage?.totalTokens ?? value.usage?.promptTokens;
  return { id:safeId(value.id),costUsd:typeof cost==='number'&&Number.isFinite(cost)&&cost>=0?cost:null,
    usageTokens:typeof tokens==='number'&&Number.isSafeInteger(tokens)&&tokens>=0?tokens:null };
}
function validateResponse(response: EmbeddingPayload, count: number, model: typeof BGE_M3): { vectors: number[][]; id?: string; costUsd: number | null; usageTokens: number | null } {
  if (!response || typeof response !== 'object' || typeof response.model !== 'string') throw new Error('invalid');
  const identity = response.model.toLocaleLowerCase('en-US');
  if (![model.apiId,model.canonical].some((x) => x.toLocaleLowerCase('en-US') === identity)) throw new Error('identity');
  if (!Array.isArray(response.data) || response.data.length !== count) throw new Error('count');
  const vectors: Array<number[] | undefined> = new Array(count);
  for (const row of response.data) {
    if (!Number.isInteger(row.index) || row.index! < 0 || row.index! >= count || vectors[row.index!]) throw new Error('index');
    if (!Array.isArray(row.embedding) || row.embedding.length !== model.dimensions || !row.embedding.every(Number.isFinite)) throw new Error('vector');
    const vector = row.embedding as number[];
    const norm = Math.sqrt(vector.reduce((a,b) => a + b*b,0));
    if (!Number.isFinite(norm) || norm <= 0) throw new Error('norm');
    vectors[row.index!] = vector.map((x) => x / norm);
  }
  if (vectors.some((v) => !v)) throw new Error('missing');
  const cost = response.usage?.cost;
  const token = response.usage?.totalTokens ?? response.usage?.promptTokens;
  return { vectors: vectors as number[][], id: safeId(response.id), costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    usageTokens: typeof token === 'number' && Number.isSafeInteger(token) && token >= 0 ? token : null };
}
function decodeVector(blob: Uint8Array, dim: number): number[] {
  if (blob.byteLength !== dim * 8) throw new Error('cached vector size mismatch');
  const bytes = Buffer.from(blob);
  const values = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const vector = [...values];
  if (vector.some((x) => !Number.isFinite(x)) || !Number.isFinite(Math.hypot(...vector)) || Math.hypot(...vector) === 0)
    throw new Error('invalid cached vector');
  return vector;
}
function cosine(a: number[], b: number[]): number { return a.reduce((sum,x,i) => sum + x*b[i]!,0); }
function sameInventory(a: MemoryRecord[], b: MemoryRecord[]): boolean {
  return a.length === b.length && a.every((x,i) => {
    const y=b[i]!; return x.project===y.project && x.key===y.key && x.text===y.text && x.version===y.version && x.source.hash===y.source.hash && x.source.path===y.source.path && x.source.revision===y.source.revision;
  });
}
function parseSavedResult(json: string): SemanticSearchResult | undefined {
  try {
    const value = JSON.parse(json) as SemanticSearchResult;
    if (value.status !== 'complete' || typeof value.project !== 'string' || typeof value.revision !== 'string' ||
        !Array.isArray(value.candidates) || value.candidates.length > MAX_FACTS ||
        !value.coverage || !value.cache || !value.request || value.model?.canonical !== BGE_M3.canonical ||
        value.candidates.some((c) => !c || typeof c.key !== 'string' || typeof c.text !== 'string' ||
          !Number.isFinite(c.score) || c.trust !== 'untrusted' || c.scoreMeaning !== 'cosine similarity; not confidence' ||
          !c.source || typeof c.source.path !== 'string' || typeof c.source.hash !== 'string' || typeof c.source.revision !== 'string')) return undefined;
    return value;
  } catch { return undefined; }
}
function matchesSavedInventory(result: SemanticSearchResult, inventory: MemoryRecord[]): boolean {
  if (result.candidates.length !== inventory.length || result.coverage.considered !== inventory.length) return false;
  const byKey = new Map(inventory.map((memory) => [memory.key,memory]));
  return result.candidates.every((candidate) => {
    const memory = byKey.get(candidate.key);
    return !!memory && candidate.text===memory.text && candidate.version===memory.version &&
      candidate.source.path===memory.source.path && candidate.source.hash===memory.source.hash && candidate.source.revision===memory.source.revision;
  });
}
