import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const MINIMUM_SAMPLES = 10;
const MAX_BYTES = 512 * 1024;
const MAX_EVENTS = 2000;
const MAX_AGE_MS = 7 * 86_400_000;
const categories = new Set(['lookup', 'change', 'debug', 'plan', 'review']);
const object = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const knownModel = (v: unknown): string | null => typeof v === 'string' && !/^(?:auto|default)$|\/auto$/i.test(v) ? label(v) : null;
const label = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(v) ? v : null;
export type ObservationContext = { taskId?: string; model?: string; provider?: string; taskCategory?: string; endpointIdentity?: string };
export type Dimensions = { cli: string; harness: string; provider: string | null; model: string | null; taskCategory: string | null; endpointIdentity: string | null };
type Usage = { input: number | null; output: number | null };
type Cost = { amount: number; currency: string };
export type Started = Dimensions & { version: 1; kind: 'start'; turnId: string; sessionId: string; taskId: string | null; at: number; queueMs: number; dispatched: boolean };
export type Ended = { version: 1; kind: 'end'; turnId: string; at: number; elapsedMs: number | null; ttftMs: number | null; generationMs: number | null;
  outcome: 'completed' | 'cancelled' | 'error'; error: 'quota' | 'provider' | null;
  tokens: Usage; tokenSource: 'reported_session_delta' | 'unknown'; cumulative: Usage;
  cost: (Cost & { source: 'reported'; interpretation: 'notional_cli_cost' }) | null; cumulativeCost: Cost | null; tokensPerSecond: number | null };
type Verified = { version: 1; kind: 'verification'; turnId: string; at: number; status: 'PASS' | 'FAIL' | 'UNKNOWN' };
type Health = { version: 1; kind: 'health'; cli: string; at: number; cooldownUntil: number | null; nearQuota: boolean };
export type ObservationEvent = Started | Ended | Verified | Health;
export type RouteObservation = Dimensions & { samples: number; ttftSamples: number; completed: number; errors: number; cancelled: number; interrupted: number;
  ttftMs: { p50: number; p95: number } | null; elapsedMs: { p50: number; p95: number } | null;
  tokensPerSecond: { p50: number; p95: number } | null; verification: { pass: number; fail: number; unknown: number } };
const quantiles = (values: number[]) => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return { p50: values[Math.ceil(values.length * 0.5) - 1]!, p95: values[Math.ceil(values.length * 0.95) - 1]! };
};
const usage = (v: unknown): Usage => ({ input: count(object(v).inputTokens), output: count(object(v).outputTokens) });
const cost = (v: unknown): Cost | null => finite(object(v).amount) && /^[A-Z]{3}$/.test(object(v).currency) ? { amount: object(v).amount, currency: object(v).currency } : null;
const delta = (now: number | null, before: number | null) => now !== null && before !== null && now >= before ? now - before : null;
export const dimensionsKey = (d: Dimensions): string => JSON.stringify([d.cli, d.harness, d.provider, d.model, d.taskCategory, d.endpointIdentity]);

/** Fingerprint only a public configured endpoint. Credential/query-bearing URLs stay unknown. */
export function endpointFingerprint(value: unknown, pin?: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return 'endpoint-' + createHash('sha256').update(JSON.stringify([url.href, label(pin)])).digest('hex').slice(0, 32);
  } catch { return null; }
}

/** One measured turn. Counters are explicit ACP session totals, never context-window occupancy. */
export class TurnObservation {
  readonly started: Started;
  private first: number | null = null;
  private ambiguous = false;
  private last: number | null = null;
  private reportedCost: Cost | null = null;
  private readonly baseline: Usage;
  private readonly baselineCost: Cost | null;
  private readonly allowCost: boolean;
  constructor(started: Started, baseline: Usage, baselineCost: Cost | null, allowCost: boolean) {
    this.started = started; this.baseline = baseline; this.baselineCost = baselineCost; this.allowCost = allowCost;
  }
  overlap(): void { this.ambiguous = true; this.first = null; this.last = null; this.reportedCost = null; }
  text(at: number): void { if (!this.ambiguous) { this.first ??= at; this.last = at; } }
  updateCost(value: unknown): void { if (this.allowCost && !this.ambiguous) this.reportedCost = cost(value); }
  end(at: number, outcome: Ended['outcome'], result: unknown, error: Ended['error'] = null): Ended {
    const cumulative = this.ambiguous ? { input: null, output: null } : usage(result), tokens = { input: delta(cumulative.input, this.baseline.input), output: delta(cumulative.output, this.baseline.output) };
    const generationMs = this.first !== null && this.last !== null && this.first >= this.started.at && this.last <= at && this.last > this.first ? this.last - this.first : null;
    const currentCost = this.reportedCost;
    const costDelta = currentCost && this.baselineCost && currentCost.currency === this.baselineCost.currency && currentCost.amount >= this.baselineCost.amount
      ? { amount: currentCost.amount - this.baselineCost.amount, currency: currentCost.currency, source: 'reported' as const, interpretation: 'notional_cli_cost' as const } : null;
    return { version: 1, kind: 'end', turnId: this.started.turnId, at, elapsedMs: at >= this.started.at ? at - this.started.at : null,
      ttftMs: this.first !== null && this.first >= this.started.at && at >= this.first ? this.first - this.started.at : null, generationMs,
      outcome, error, tokens, tokenSource: tokens.input !== null || tokens.output !== null ? 'reported_session_delta' : 'unknown', cumulative,
      cost: costDelta, cumulativeCost: currentCost, tokensPerSecond: tokens.output !== null && generationMs !== null ? tokens.output / (generationMs / 1000) : null };
  }
}

/** Bounded metadata index of the same events appended to session logs. No prompt-log scans or second database. */
export class PerformanceLedger {
  private events: ObservationEvent[] = [];
  private readonly live = new Set<string>();
  private readonly file: string;
  private bytes = 0;
  private persistenceErrors = 0;
  private readonly now: () => number;
  constructor(stateDir: string, now: () => number = Date.now) {
    this.now = now;
    const dir = join(stateDir, 'observations'); this.file = join(dir, 'turns.jsonl');
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { this.persistenceErrors++; }
    for (const file of [this.file + '.previous', this.file]) {
      let fd: number | undefined;
      try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) throw Error();
        const size = stat.size, buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
        readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        let lines = buffer.toString('utf8').split('\n'); if (size > MAX_BYTES) lines = lines.slice(1);
        for (const line of lines) { try { const e = this.parse(JSON.parse(line)); if (e) this.events.push(e); } catch {} }
        if (file === this.file) this.bytes = size;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.persistenceErrors++; }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    this.events = this.events.filter(e => e.at >= this.now() - MAX_AGE_MS).slice(-MAX_EVENTS);
  }

  private parse(v: unknown): ObservationEvent | null {
    const e = object(v);
    if (e.version !== 1 || !finite(e.at) || e.at > this.now() + 60_000) return null;
    if (e.kind === 'health' && label(e.cli) && typeof e.nearQuota === 'boolean' && (e.cooldownUntil === null || finite(e.cooldownUntil)))
      return { version: 1, kind: 'health', cli: e.cli, at: e.at, nearQuota: e.nearQuota, cooldownUntil: e.cooldownUntil };
    if (typeof e.turnId !== 'string' || !/^[a-f0-9-]{36}$/.test(e.turnId)) return null;
    if (e.kind === 'start' && label(e.cli) && label(e.harness) && label(e.sessionId) && finite(e.queueMs))
      return { version: 1, kind: 'start', turnId: e.turnId, sessionId: e.sessionId, taskId: label(e.taskId), at: e.at, queueMs: e.queueMs, dispatched: e.dispatched === true,
        cli: e.cli, harness: e.harness, provider: label(e.provider), model: knownModel(e.model), endpointIdentity: label(e.endpointIdentity), taskCategory: categories.has(e.taskCategory) ? e.taskCategory : null };
    if (e.kind === 'verification' && ['PASS', 'FAIL', 'UNKNOWN'].includes(e.status)) return { version: 1, kind: 'verification', turnId: e.turnId, at: e.at, status: e.status };
    if (e.kind === 'end' && (e.elapsedMs === null || finite(e.elapsedMs)) && ['completed', 'cancelled', 'error'].includes(e.outcome)) {
      const tokens = { input: count(object(e.tokens).input), output: count(object(e.tokens).output) };
      const cumulative = { input: count(object(e.cumulative).input), output: count(object(e.cumulative).output) };
      const c = cost(e.cost);
      return { version: 1, kind: 'end', turnId: e.turnId, at: e.at, elapsedMs: e.elapsedMs, ttftMs: finite(e.ttftMs) ? e.ttftMs : null,
        generationMs: finite(e.generationMs) && e.generationMs > 0 ? e.generationMs : null, outcome: e.outcome, error: ['quota', 'provider'].includes(e.error) ? e.error : null,
        tokens, cumulative, tokenSource: tokens.input !== null || tokens.output !== null ? 'reported_session_delta' : 'unknown',
        cost: c ? { ...c, source: 'reported', interpretation: 'notional_cli_cost' } : null, cumulativeCost: cost(e.cumulativeCost),
        tokensPerSecond: finite(e.generationMs) && e.generationMs > 0 && tokens.output !== null ? tokens.output / (e.generationMs / 1000) : null };
    }
    return null;
  }
  record(event: ObservationEvent): void {
    const safe = this.parse(event); if (!safe) return;
    const line = JSON.stringify(safe) + '\n';
    try {
      if (this.bytes + Buffer.byteLength(line) > MAX_BYTES) { renameSync(this.file, this.file + '.previous'); this.bytes = 0; }
      const fd = openSync(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) throw Error();
        appendFileSync(fd, line); this.bytes += Buffer.byteLength(line);
      } finally { closeSync(fd); }
    } catch { this.persistenceErrors++; }
    this.events.push(safe); this.events = this.events.filter(e => e.at >= this.now() - MAX_AGE_MS).slice(-MAX_EVENTS);
  }
  begin(d: Dimensions, sessionId: string, context: ObservationContext, queueMs: number, fresh: boolean, allowCost: boolean, dispatched = true): TurnObservation {
    const earlier = [...this.events].reverse().find(e => e.kind === 'start' && e.dispatched && e.cli === d.cli && e.sessionId === sessionId) as Started | undefined;
    const prior = earlier && this.events.find(e => e.kind === 'end' && e.turnId === earlier.turnId) as Ended | undefined;
    const start: Started = { version: 1, kind: 'start', turnId: randomUUID(), sessionId: label(sessionId) ?? createHash('sha256').update(sessionId).digest('hex'), taskId: label(context.taskId), at: this.now(), queueMs, dispatched,
      cli: label(d.cli) ?? 'unknown', harness: label(d.harness) ?? 'unknown', provider: label(d.provider), model: knownModel(d.model), endpointIdentity: label(context.endpointIdentity ?? d.endpointIdentity), taskCategory: categories.has(context.taskCategory ?? '') ? context.taskCategory! : null };
    this.record(start); this.live.add(start.turnId);
    return new TurnObservation(start, fresh ? { input: 0, output: 0 } : prior?.cumulative ?? { input: null, output: null }, fresh ? { amount: 0, currency: 'USD' } : prior?.cumulativeCost ?? null, allowCost);
  }
  finish(turn: TurnObservation, event: Ended): void { try { this.record(event); } finally { this.live.delete(turn.started.turnId); } }
  verify(cli: string, sessionId: string, taskId: string, status: 'PASS' | 'FAIL' | 'UNKNOWN'): Verified | undefined {
    const start = [...this.events].reverse().find(e => e.kind === 'start' && e.cli === cli && e.sessionId === sessionId && e.taskId === taskId) as Started | undefined;
    if (!start) return;
    const event: Verified = { version: 1, kind: 'verification', turnId: start.turnId, at: this.now(), status }; this.record(event); return event;
  }
  health(): Map<string, Health> { const out = new Map<string, Health>(); for (const e of this.events) if (e.kind === 'health' && e.at >= this.now() - MAX_AGE_MS) out.set(e.cli, e); return out; }
  report() {
    this.events = this.events.filter(e => e.at >= this.now() - MAX_AGE_MS);
    const end = new Map<string, Ended>(), verification = new Map<string, Verified>();
    for (const e of this.events) { if (e.kind === 'end') end.set(e.turnId, e); if (e.kind === 'verification') verification.set(e.turnId, e); }
    const recent = this.events.filter((e): e is Started => e.kind === 'start').map(start => {
      const done = end.get(start.turnId), quality = verification.get(start.turnId)?.status ?? 'UNKNOWN';
      const { kind: _, ...metadata } = start;
      return { ...metadata, outcome: done?.outcome ?? (this.live.has(start.turnId) ? 'inflight' : 'interrupted'),
        elapsedMs: done?.elapsedMs ?? null, ttftMs: done?.ttftMs ?? null, tokens: done?.tokens ?? { input: null, output: null },
        tokenSource: done?.tokenSource ?? 'unknown', cost: done?.cost ?? null, tokensPerSecond: done?.tokensPerSecond ?? null,
        timingSource: done?.elapsedMs !== null && done?.elapsedMs !== undefined ? 'measured' as const : 'unknown' as const, modelSource: start.model ? 'configured' as const : 'unknown' as const, verification: quality, error: done?.error ?? null };
    });
    const grouped = new Map<string, typeof recent>();
    for (const e of recent) { const key = dimensionsKey(e); const group = grouped.get(key) ?? []; group.push(e); grouped.set(key, group); }
    const routes: RouteObservation[] = [...grouped.values()].map(group => {
      const first = group[0]!, completed = group.filter(e => e.outcome === 'completed');
      return { cli: first.cli, harness: first.harness, provider: first.provider, model: first.model, taskCategory: first.taskCategory, endpointIdentity: first.endpointIdentity,
        samples: group.length, ttftSamples: completed.filter(e => finite(e.ttftMs)).length, completed: completed.length, errors: group.filter(e => e.outcome === 'error').length,
        cancelled: group.filter(e => e.outcome === 'cancelled').length, interrupted: group.filter(e => e.outcome === 'interrupted').length,
        ttftMs: quantiles(completed.map(e => e.ttftMs).filter(finite)), elapsedMs: quantiles(completed.map(e => e.elapsedMs).filter(finite)),
        tokensPerSecond: quantiles(completed.map(e => e.tokensPerSecond).filter(finite)),
        verification: { pass: group.filter(e => e.verification === 'PASS').length, fail: group.filter(e => e.verification === 'FAIL').length, unknown: group.filter(e => e.verification === 'UNKNOWN').length } };
    });
    return { version: 1 as const, checkedAt: new Date(this.now()).toISOString(), minimumSamples: MINIMUM_SAMPLES,
      retention: { maximumEvents: MAX_EVENTS, maximumFileBytes: MAX_BYTES, files: 2, maximumAgeDays: 7, recentTurns: 100 },
      provenance: { timing: 'measured', tokens: 'reported_session_delta_or_unknown', cost: 'reported_notional_cli_cost_or_unknown', quality: 'deterministic_verifier_only' },
      routes, recent: recent.slice(-100).reverse(), inFlight: this.live.size, persistenceErrors: this.persistenceErrors };
  }
}
