import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fchmodSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Local single-user durable queue. SQLite WAL + BEGIN IMMEDIATE serialize claims
 * across processes; user_version migrations and foreign keys protect the graph.
 * Times/durations are integer milliseconds, costs are integer micro-units chosen
 * by the caller. Supply a monotonic-in-practice wall clock (Date.now by default).
 *
 * Attempts are at-least-once: an expired lease can be retried up to maxAttempts.
 * Fencing prevents stale DB writes, NOT duplicate external effects. Executors
 * must use downstream idempotency keys or reconcile effects before retrying.
 * Failure retries require retryAt or retryTask; automatic lease recovery also
 * requires retryOnLeaseExpiry and remaining maxAttempts (default 1). Parents
 * describe lineage; only dependencies gate work.
 * Failed/cancelled/blocked prerequisites permanently block queued dependents.
 *
 * Store prompt/input/output/error references, never credential values, environment
 * variables, or provider configuration. Message text must likewise be secret-free;
 * this trusted local API cannot detect secrets in caller-provided strings.
 * Lease methods return the resulting task, or null for a stale/expired fence.
 * Budget/deadline enforcement can turn an accepted heartbeat/completion into
 * failure. Cost reports are cumulative for the current attempt, making repeated
 * heartbeats idempotent. costMicros is null while any attempt has no cost report;
 * knownCostMicros is the observed lower bound used for budget enforcement. Caps
 * cannot preempt external spending; an executor must check before paid calls.
 * Runtime is elapsed wall time across all attempts, capped at each lease expiry
 * when a worker disappears. Progress refs let a running
 * executor persist session/permission visibility; waiting does not waive leases.
 * claimNext enforces eligibility only; worker concurrency caps belong to the engine.
 */
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
export interface TaskRoute {
  mode: 'explicit' | 'auto';
  agentId?: string;
  provider?: string;
  model?: string;
  reason?: string;
}
export interface NewTask {
  id?: string;
  projectId: string;
  parentId?: string;
  dependencyIds?: string[];
  promptRef: string;
  inputRefs?: string[];
  route: TaskRoute;
  maxAttempts?: number;
  retryOnLeaseExpiry?: boolean;
  maxCostMicros?: number;
  maxRuntimeMs?: number;
  deadline?: number;
  notBefore?: number;
}
export interface Task {
  id: string;
  projectId: string;
  parentId: string | null;
  dependencyIds: string[];
  promptRef: string;
  inputRefs: string[];
  route: TaskRoute;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  retryOnLeaseExpiry: boolean;
  maxCostMicros: number | null;
  maxRuntimeMs: number | null;
  costMicros: number | null;
  knownCostMicros: number;
  runtimeMs: number;
  deadline: number | null;
  notBefore: number;
  workerId: string | null;
  leaseToken: number;
  leaseExpiresAt: number | null;
  startedAt: number | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  outputRef: string | null;
  errorRef: string | null;
  failureReason: string | null;
  sessionRef: string | null;
  permissionRef: string | null;
}
export interface AttemptUsage {
  costMicros?: number;
}
export interface AttemptProgress extends AttemptUsage {
  sessionRef?: string | null;
  permissionRef?: string | null;
}
export interface NewMessage {
  id?: string;
  projectId: string;
  taskId?: string;
  sender: string;
  recipient: string;
  text: string;
  idempotencyKey: string;
}
export interface TaskMessage {
  id: string;
  projectId: string;
  taskId: string | null;
  sender: string;
  recipient: string;
  text: string;
  idempotencyKey: string;
  createdAt: number;
  acknowledgedAt: number | null;
}
type Row = Record<string, unknown>;
const terminal = new Set<TaskStatus>(['succeeded', 'failed', 'cancelled', 'blocked']);
export const TASK_STORE_LIMITS = Object.freeze({
  batch: 100,
  dependencies: 256,
  inputRefs: 128,
  page: 1000,
  defaultPage: 100,
  idCharacters: 256,
  referenceCharacters: 4096,
  messageCharacters: 16_384,
});

function nonempty(
  value: unknown,
  name: string,
  max: number = TASK_STORE_LIMITS.referenceCharacters,
): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`${name} must be a nonempty string without NUL (max ${max} characters)`);
  }
}
function page(options: { limit?: number; offset?: number }): [number, number] {
  const limit = integer(options.limit ?? TASK_STORE_LIMITS.defaultPage, 'limit', 1);
  if (limit > TASK_STORE_LIMITS.page) throw new Error(`limit exceeds ${TASK_STORE_LIMITS.page}`);
  return [limit, integer(options.offset ?? 0, 'offset')];
}
function integer(value: number, name: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`);
  return value;
}

export class TaskStore {
  private db: DatabaseSync;
  private now: () => number;

  constructor(path: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    // Create privately before SQLite opens; SQLite's WAL/SHM inherit DB permissions.
    // Caller owns directory creation (prefer 0700). Existing DBs are tightened too.
    if (path !== ':memory:') {
      const descriptor = openSync(path, 'a', 0o600);
      try {
        fchmodSync(descriptor, 0o600);
      } finally {
        closeSync(descriptor);
      }
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        'PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;',
      );
      this.transaction(() => {
        const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
        if (version > 1) throw new Error(`Unsupported task database schema ${version}`);
        if (version === 0) {
          this.db.exec(`
            CREATE TABLE tasks (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT REFERENCES tasks(id),
              prompt_ref TEXT NOT NULL, input_refs TEXT NOT NULL, route TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','blocked')),
              attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
              retry_on_lease_expiry INTEGER NOT NULL DEFAULT 0,
              max_cost_micros INTEGER, max_runtime_ms INTEGER, cost_micros INTEGER NOT NULL DEFAULT 0,
              runtime_ms INTEGER NOT NULL DEFAULT 0, attempt_cost_micros INTEGER,
              unpriced_attempts INTEGER NOT NULL DEFAULT 0,
              deadline INTEGER, not_before INTEGER NOT NULL, worker_id TEXT,
              lease_token INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER, started_at INTEGER,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
              output_ref TEXT, error_ref TEXT, failure_reason TEXT, session_ref TEXT, permission_ref TEXT
            );
            CREATE TABLE task_dependencies (
              task_id TEXT NOT NULL REFERENCES tasks(id), dependency_id TEXT NOT NULL REFERENCES tasks(id),
              PRIMARY KEY(task_id, dependency_id), CHECK(task_id <> dependency_id)
            );
            CREATE INDEX tasks_claim ON tasks(status, not_before, created_at);
            CREATE INDEX tasks_project ON tasks(project_id, created_at);
            CREATE INDEX dependencies_reverse ON task_dependencies(dependency_id);
            CREATE TABLE task_messages (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT REFERENCES tasks(id),
              sender TEXT NOT NULL, recipient TEXT NOT NULL, text TEXT NOT NULL,
              idempotency_key TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER
            );
            CREATE UNIQUE INDEX message_idempotency ON task_messages(project_id, IFNULL(task_id, ''), sender, idempotency_key);
            CREATE INDEX messages_inbox ON task_messages(project_id, recipient, acknowledged_at, created_at);
            PRAGMA user_version = 1;
          `);
        }
      });
      if (path !== ':memory:') {
        for (const suffix of ['-wal', '-shm']) {
          try {
            chmodSync(path + suffix, 0o600);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }
      // Additive index is safe for pre-existing v1 databases; no row schema change.
      this.db.exec('CREATE INDEX IF NOT EXISTS tasks_children ON tasks(project_id, parent_id)');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private time(): number {
    return integer(this.now(), 'clock');
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  }

  private task(row: Row): Task {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      parentId: row.parent_id as string | null,
      dependencyIds: this.db
        .prepare('SELECT dependency_id FROM task_dependencies WHERE task_id = ? ORDER BY dependency_id')
        .all(row.id as string)
        .map((r) => r.dependency_id as string),
      promptRef: row.prompt_ref as string,
      inputRefs: JSON.parse(row.input_refs as string),
      route: JSON.parse(row.route as string),
      status: row.status as TaskStatus,
      attempts: row.attempts as number,
      maxAttempts: row.max_attempts as number,
      retryOnLeaseExpiry: row.retry_on_lease_expiry === 1,
      maxCostMicros: row.max_cost_micros as number | null,
      maxRuntimeMs: row.max_runtime_ms as number | null,
      costMicros: (row.unpriced_attempts as number) > 0 ? null : (row.cost_micros as number),
      knownCostMicros: row.cost_micros as number,
      runtimeMs: this.runtime(row, this.time()),
      deadline: row.deadline as number | null,
      notBefore: row.not_before as number,
      workerId: row.worker_id as string | null,
      leaseToken: row.lease_token as number,
      leaseExpiresAt: row.lease_expires_at as number | null,
      startedAt: row.started_at as number | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      finishedAt: row.finished_at as number | null,
      outputRef: row.output_ref as string | null,
      errorRef: row.error_ref as string | null,
      failureReason: row.failure_reason as string | null,
      sessionRef: row.session_ref as string | null,
      permissionRef: row.permission_ref as string | null,
    };
  }

  getTask(id: string): Task | null {
    const row = this.row(id);
    return row ? this.task(row) : null;
  }

  /** Includes terminal children and is independent of list pagination. */
  countChildren(projectId: string, parentId: string): number {
    return Number(
      this.db
        .prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND parent_id = ?')
        .get(projectId, parentId)!.count,
    );
  }

  listTasks(options: { projectId?: string; status?: TaskStatus; limit?: number; offset?: number } = {}): Task[] {
    const [limit, offset] = page(options);
    return this.db
      .prepare(`SELECT * FROM tasks WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR status = ?)
      ORDER BY created_at, id LIMIT ? OFFSET ?`)
      .all(
        options.projectId ?? null,
        options.projectId ?? null,
        options.status ?? null,
        options.status ?? null,
        limit,
        offset,
      )
      .map((row) => this.task(row));
  }

  createTask(input: NewTask): Task {
    return this.createTasks([input])[0]!;
  }

  /** Batch supports forward references. Every reference must exist in the same project. */
  createTasks(inputs: NewTask[]): Task[] {
    if (!Array.isArray(inputs)) throw new Error('tasks must be an array');
    if (inputs.length > TASK_STORE_LIMITS.batch) throw new Error(`Task batch exceeds ${TASK_STORE_LIMITS.batch}`);
    return this.transaction(() => {
      const now = this.time();
      for (const input of inputs) if (input.id !== undefined) nonempty(input.id, 'id', TASK_STORE_LIMITS.idCharacters);
      const prepared = inputs.map((input) => ({ ...input, id: input.id ?? randomUUID() }));
      const batch = new Map(prepared.map((input) => [input.id, input]));
      if (batch.size !== prepared.length) throw new Error('Duplicate task ID');
      for (const input of prepared) {
        nonempty(input.id, 'id', TASK_STORE_LIMITS.idCharacters);
        nonempty(input.projectId, 'projectId', TASK_STORE_LIMITS.idCharacters);
        nonempty(input.promptRef, 'promptRef');
        if (this.row(input.id)) throw new Error(`Task already exists: ${input.id}`);
        if (!input.route || !['explicit', 'auto'].includes(input.route.mode))
          throw new Error('route.mode must be explicit or auto');
        // Whitelist route fields so callers cannot accidentally persist an auth/config object.
        for (const field of ['agentId', 'provider', 'model', 'reason'] as const) {
          if (input.route[field] !== undefined) nonempty(input.route[field], `route.${field}`);
        }
        if (input.inputRefs !== undefined && !Array.isArray(input.inputRefs))
          throw new Error('inputRefs must be an array');
        if (input.dependencyIds !== undefined && !Array.isArray(input.dependencyIds))
          throw new Error('dependencyIds must be an array');
        if ((input.inputRefs?.length ?? 0) > TASK_STORE_LIMITS.inputRefs) throw new Error('Too many inputRefs');
        if ((input.dependencyIds?.length ?? 0) > TASK_STORE_LIMITS.dependencies)
          throw new Error('Too many dependencies');
        for (const ref of input.inputRefs ?? []) nonempty(ref, 'inputRef');
        integer(input.maxAttempts ?? 1, 'maxAttempts', 1);
        if (input.retryOnLeaseExpiry !== undefined && typeof input.retryOnLeaseExpiry !== 'boolean')
          throw new Error('retryOnLeaseExpiry must be boolean');
        for (const [key, value] of Object.entries({
          maxCostMicros: input.maxCostMicros,
          maxRuntimeMs: input.maxRuntimeMs,
          deadline: input.deadline,
          notBefore: input.notBefore,
        })) {
          if (value !== undefined) integer(value, key);
        }
        const deps = input.dependencyIds ?? [];
        if (new Set(deps).size !== deps.length) throw new Error('Duplicate dependency');
        for (const ref of [...deps, ...(input.parentId === undefined ? [] : [input.parentId])]) {
          nonempty(ref, 'task reference', TASK_STORE_LIMITS.idCharacters);
          const target = batch.get(ref) ?? this.getTask(ref);
          if (!target || target.projectId !== input.projectId)
            throw new Error(`Unknown or cross-project task reference: ${ref}`);
          if (ref === input.id) throw new Error('Task cannot reference itself');
        }
      }
      const visited = new Set<string>();
      const visiting = new Set<string>();
      const visit = (id: string): void => {
        if (visiting.has(id)) throw new Error('Cyclic task references');
        if (visited.has(id)) return;
        const input = batch.get(id);
        if (!input) return; // Existing records cannot reference this new batch.
        visiting.add(id);
        for (const ref of [...(input.dependencyIds ?? []), ...(input.parentId ? [input.parentId] : [])]) visit(ref);
        visiting.delete(id);
        visited.add(id);
      };
      prepared.forEach((input) => visit(input.id));
      // Deferred FKs permit forward parent/dependency references within the batch.
      this.db.exec('PRAGMA defer_foreign_keys = ON');
      const insert = this.db.prepare(`INSERT INTO tasks
        (id, project_id, parent_id, prompt_ref, input_refs, route, status, max_attempts, retry_on_lease_expiry, max_cost_micros, max_runtime_ms,
          deadline, not_before, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const input of prepared) {
        const { mode, agentId, provider, model, reason } = input.route;
        insert.run(
          input.id,
          input.projectId,
          input.parentId ?? null,
          input.promptRef,
          JSON.stringify(input.inputRefs ?? []),
          JSON.stringify({ mode, agentId, provider, model, reason }),
          input.maxAttempts ?? 1,
          input.retryOnLeaseExpiry ? 1 : 0,
          input.maxCostMicros ?? null,
          input.maxRuntimeMs ?? null,
          input.deadline ?? null,
          input.notBefore ?? now,
          now,
          now,
        );
      }
      const depInsert = this.db.prepare('INSERT INTO task_dependencies(task_id, dependency_id) VALUES (?, ?)');
      for (const input of prepared) for (const dep of input.dependencyIds ?? []) depInsert.run(input.id, dep);
      this.maintain(now);
      return prepared.map((input) => this.getTask(input.id)!);
    });
  }

  private runtime(row: Row, now: number): number {
    return integer(
      (row.runtime_ms as number) +
        (row.status === 'running'
          ? Math.max(0, Math.min(now, row.lease_expires_at as number) - (row.started_at as number))
          : 0),
      'runtimeMs',
    );
  }

  private exhausted(row: Row, now: number, forClaim = false): string | null {
    if (row.deadline !== null && (row.deadline as number) <= now) return 'deadline_exceeded';
    if (
      row.max_cost_micros !== null &&
      ((row.cost_micros as number) > (row.max_cost_micros as number) ||
        (forClaim && row.cost_micros === row.max_cost_micros))
    )
      return 'cost_budget_exceeded';
    const runtime = this.runtime(row, now);
    if (
      row.max_runtime_ms !== null &&
      (runtime > (row.max_runtime_ms as number) || (forClaim && runtime === row.max_runtime_ms))
    )
      return 'runtime_budget_exceeded';
    return null;
  }

  private settle(
    row: Row,
    status: TaskStatus,
    now: number,
    reason: string | null,
    options: { retryAt?: number; outputRef?: string; errorRef?: string } = {},
  ): void {
    this.db
      .prepare(`UPDATE tasks SET status = ?, runtime_ms = ?, worker_id = NULL, lease_expires_at = NULL,
      started_at = NULL, updated_at = ?, finished_at = ?, failure_reason = ?, not_before = ?, output_ref = ?, error_ref = ? WHERE id = ?`)
      .run(
        status,
        this.runtime(row, now),
        now,
        terminal.has(status) ? now : null,
        reason,
        options.retryAt ?? (row.not_before as number),
        options.outputRef ?? null,
        options.errorRef ?? null,
        row.id as string,
      );
  }

  private maintain(now: number): void {
    for (const row of this.db.prepare("SELECT * FROM tasks WHERE status IN ('queued','running')").all()) {
      const limit = this.exhausted(row, now, row.status === 'queued');
      if (limit) this.settle(row, 'failed', now, limit);
      else if (row.status === 'running' && (row.lease_expires_at as number) <= now) {
        const retryLimit = this.exhausted(row, now, true);
        const retry =
          row.retry_on_lease_expiry === 1 && (row.attempts as number) < (row.max_attempts as number) && !retryLimit;
        this.settle(row, retry ? 'queued' : 'failed', now, retryLimit ?? 'lease_expired', { retryAt: now });
      }
    }
    // Iterate to a fixed point so terminal prerequisites block an entire chain.
    const block =
      this.db.prepare(`UPDATE tasks SET status = 'blocked', failure_reason = 'dependency_failed', updated_at = ?, finished_at = ?
      WHERE status = 'queued' AND id IN (SELECT d.task_id FROM task_dependencies d JOIN tasks p ON p.id = d.dependency_id
        WHERE p.status IN ('failed','cancelled','blocked'))`);
    while (block.run(now, now).changes > 0) {
      /* propagate */
    }
  }

  /** Invoke on startup and periodically even when no worker is claiming. */
  recover(): void {
    this.transaction(() => this.maintain(this.time()));
  }

  claimNext(options: { workerId: string; leaseMs: number; projectId?: string; taskId?: string }): Task | null {
    nonempty(options.workerId, 'workerId', TASK_STORE_LIMITS.idCharacters);
    integer(options.leaseMs, 'leaseMs', 1);
    return this.transaction(() => {
      const now = this.time();
      integer(now + options.leaseMs, 'lease expiry');
      this.maintain(now);
      const row = this.db
        .prepare(`SELECT t.* FROM tasks t WHERE t.status = 'queued' AND t.not_before <= ?
        AND t.attempts < t.max_attempts AND (? IS NULL OR t.project_id = ?)
        AND (? IS NULL OR t.id = ?)
        AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id = d.dependency_id
          WHERE d.task_id = t.id AND p.status <> 'succeeded') ORDER BY t.created_at, t.id LIMIT 1`)
        .get(now, options.projectId ?? null, options.projectId ?? null, options.taskId ?? null, options.taskId ?? null);
      if (!row) return null;
      this.db
        .prepare(`UPDATE tasks SET status = 'running', attempts = attempts + 1, lease_token = lease_token + 1,
        worker_id = ?, lease_expires_at = ?, started_at = ?, updated_at = ?, attempt_cost_micros = NULL,
        unpriced_attempts = unpriced_attempts + 1,
        failure_reason = NULL, error_ref = NULL, finished_at = NULL WHERE id = ?`)
        .run(options.workerId, now + options.leaseMs, now, now, row.id as string);
      return this.getTask(row.id as string);
    });
  }

  private fenced(id: string, token: number, now: number, usage: AttemptProgress): Row | null {
    integer(token, 'leaseToken', 1);
    const row = this.row(id);
    if (!row || row.status !== 'running' || row.lease_token !== token || (row.lease_expires_at as number) <= now)
      return null;
    if (usage.costMicros !== undefined) {
      integer(usage.costMicros, 'costMicros');
      if (row.attempt_cost_micros !== null && usage.costMicros < (row.attempt_cost_micros as number))
        throw new Error('Attempt cost cannot decrease');
      const total = integer(
        (row.cost_micros as number) + usage.costMicros - ((row.attempt_cost_micros as number) ?? 0),
        'total cost',
      );
      this.db
        .prepare(
          'UPDATE tasks SET cost_micros = ?, attempt_cost_micros = ?, unpriced_attempts = unpriced_attempts - ? WHERE id = ?',
        )
        .run(total, usage.costMicros, row.attempt_cost_micros === null ? 1 : 0, id);
      row.cost_micros = total;
      row.attempt_cost_micros = usage.costMicros;
    }
    for (const key of ['sessionRef', 'permissionRef'] as const) {
      if (usage[key] !== undefined) {
        if (usage[key] !== null) nonempty(usage[key], key);
        const column = key === 'sessionRef' ? 'session_ref' : 'permission_ref';
        this.db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(usage[key]!, id);
        row[column] = usage[key]!;
      }
    }
    return row;
  }

  heartbeat(id: string, token: number, leaseMs: number, usage: AttemptProgress = {}): Task | null {
    integer(leaseMs, 'leaseMs', 1);
    return this.transaction(() => {
      const now = this.time();
      integer(now + leaseMs, 'lease expiry');
      const row = this.fenced(id, token, now, usage);
      if (!row) return null;
      const limit = this.exhausted(row, now);
      if (limit) {
        this.settle(row, 'failed', now, limit);
        this.maintain(now);
      } else
        this.db
          .prepare('UPDATE tasks SET lease_expires_at = MAX(lease_expires_at, ?), updated_at = ? WHERE id = ?')
          .run(now + leaseMs, now, id);
      return this.getTask(id);
    });
  }

  complete(id: string, token: number, options: AttemptUsage & { outputRef?: string } = {}): Task | null {
    if (options.outputRef !== undefined) nonempty(options.outputRef, 'outputRef');
    return this.transaction(() => {
      const now = this.time();
      const row = this.fenced(id, token, now, options);
      if (!row) return null;
      const limit = this.exhausted(row, now);
      this.settle(row, limit ? 'failed' : 'succeeded', now, limit, {
        outputRef: limit ? undefined : options.outputRef,
      });
      this.maintain(now);
      return this.getTask(id);
    });
  }

  fail(id: string, token: number, options: AttemptUsage & { errorRef?: string; retryAt?: number } = {}): Task | null {
    if (options.errorRef !== undefined) nonempty(options.errorRef, 'errorRef');
    if (options.retryAt !== undefined) integer(options.retryAt, 'retryAt');
    return this.transaction(() => {
      const now = this.time();
      const row = this.fenced(id, token, now, options);
      if (!row) return null;
      const limit = this.exhausted(row, now, true);
      const retry = options.retryAt !== undefined && (row.attempts as number) < (row.max_attempts as number) && !limit;
      this.settle(row, retry ? 'queued' : 'failed', now, limit ?? 'attempt_failed', options);
      this.maintain(now);
      return this.getTask(id);
    });
  }

  /** Explicit retry of a failed task; never resets attempts, budgets, or blocked descendants. */
  retryTask(id: string, notBefore?: number): Task | null {
    if (notBefore !== undefined) integer(notBefore, 'notBefore');
    return this.transaction(() => {
      const now = this.time();
      const row = this.row(id);
      if (
        !row ||
        row.status !== 'failed' ||
        (row.attempts as number) >= (row.max_attempts as number) ||
        this.exhausted(row, now, true)
      )
        return null;
      this.settle(row, 'queued', now, null, { retryAt: notBefore ?? now });
      this.maintain(now);
      return this.getTask(id);
    });
  }

  cancel(id: string): Task | null {
    return this.transaction(() => {
      const now = this.time();
      const row = this.row(id);
      if (!row) return null;
      if (!terminal.has(row.status as TaskStatus)) this.settle(row, 'cancelled', now, 'cancelled');
      this.maintain(now);
      return this.getTask(id);
    });
  }

  private message(row: Row): TaskMessage {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      taskId: row.task_id as string | null,
      sender: row.sender as string,
      recipient: row.recipient as string,
      text: row.text as string,
      idempotencyKey: row.idempotency_key as string,
      createdAt: row.created_at as number,
      acknowledgedAt: row.acknowledged_at as number | null,
    };
  }

  /** Idempotency scope is (project, task-or-project, sender, key); conflicts reject. */
  sendMessage(input: NewMessage): TaskMessage {
    for (const key of ['projectId', 'sender', 'recipient', 'idempotencyKey'] as const)
      nonempty(input[key], key, TASK_STORE_LIMITS.idCharacters);
    nonempty(input.text, 'text', TASK_STORE_LIMITS.messageCharacters);
    if (input.id !== undefined) nonempty(input.id, 'id', TASK_STORE_LIMITS.idCharacters);
    return this.transaction(() => {
      if (input.taskId !== undefined) {
        nonempty(input.taskId, 'taskId', TASK_STORE_LIMITS.idCharacters);
        const task = this.row(input.taskId);
        if (!task || task.project_id !== input.projectId) throw new Error('Unknown or cross-project message task');
      }
      const existing = this.db
        .prepare(
          `SELECT * FROM task_messages WHERE project_id = ? AND task_id IS ? AND sender = ? AND idempotency_key = ?`,
        )
        .get(input.projectId, input.taskId ?? null, input.sender, input.idempotencyKey);
      if (existing) {
        if (
          existing.recipient !== input.recipient ||
          existing.text !== input.text ||
          (input.id !== undefined && existing.id !== input.id)
        ) {
          throw new Error('Message idempotency key reused with different content');
        }
        return this.message(existing);
      }
      const id = input.id ?? randomUUID();
      this.db
        .prepare(`INSERT INTO task_messages(id, project_id, task_id, sender, recipient, text, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          input.projectId,
          input.taskId ?? null,
          input.sender,
          input.recipient,
          input.text,
          input.idempotencyKey,
          this.time(),
        );
      return this.message(this.db.prepare('SELECT * FROM task_messages WHERE id = ?').get(id)!);
    });
  }

  /** Omit taskId for all project messages; null selects only project-scoped messages. */
  listMessages(options: {
    projectId: string;
    taskId?: string | null;
    recipient?: string;
    unacknowledgedOnly?: boolean;
    limit?: number;
    offset?: number;
  }): TaskMessage[] {
    const [limit, offset] = page(options);
    return this.db
      .prepare(`SELECT * FROM task_messages WHERE project_id = ? AND (? = 1 OR task_id IS ?)
      AND (? IS NULL OR recipient = ?) AND (? = 0 OR acknowledged_at IS NULL) ORDER BY created_at, id LIMIT ? OFFSET ?`)
      .all(
        options.projectId,
        options.taskId === undefined ? 1 : 0,
        options.taskId ?? null,
        options.recipient ?? null,
        options.recipient ?? null,
        options.unacknowledgedOnly ? 1 : 0,
        limit,
        offset,
      )
      .map((row) => this.message(row));
  }

  /** Recipient identity is checked for accidental misrouting, not authentication. */
  acknowledgeMessage(id: string, recipient: string): TaskMessage | null {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM task_messages WHERE id = ? AND recipient = ?').get(id, recipient);
      if (!row) return null;
      this.db
        .prepare('UPDATE task_messages SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?')
        .run(this.time(), id);
      return this.message(this.db.prepare('SELECT * FROM task_messages WHERE id = ?').get(id)!);
    });
  }
}
