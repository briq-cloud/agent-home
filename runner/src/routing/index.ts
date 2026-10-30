import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const TASK_TYPES = {
  lookup: 'Read existing source, retrieve facts and summarize evidence.',
  change: 'Implement a bounded coding change with tests.',
  debug: 'Diagnose bugs, state and integration failures.',
  plan: 'Decompose a project and reason about architecture and dependencies.',
  review: 'Review code for correctness, regressions and risks.',
} as const;
export type TaskType = keyof typeof TASK_TYPES;
export type Binding = {
  id: string;
  cli: string;
  harness: string;
  provider: string;
  billing: 'subscription' | 'use';
  signedIn: boolean | null;
  model?: string;
  canonical?: string;
  compatibility: 'verified' | 'unknown';
  context?: number;
  tools?: boolean;
  modalities?: string[];
  healthy?: boolean;
  quotaBlocked?: boolean;
  endpointTag?: string;
};
export type Availability = { checkedAt: string; bindings: Binding[] };
export type Route = {
  cli: string;
  model?: string;
  routeId?: string;
  type?: TaskType;
  source: 'pinned' | 'explicit' | 'subscription' | 'default' | 'decision';
  reason?: string;
  decisionCostUsd?: number;
  decisionModel?: string;
  candidates?: Portfolio[];
};
export type Selection = {
  task: string;
  explicit?: { cli: string; model?: string };
  pinned?: { cli: string; model?: string };
  allowedRouteIds?: string[];
  allowPaidApi?: boolean;
  maxEstimatedUsd?: number;
  decisionBudgetUsd?: number;
  deadlineUtc?: string;
  minContext?: number;
  inputTokens?: number;
  outputTokens?: number;
  modality?: string;
  requireTools?: boolean;
};
export type Evidence = {
  model: string;
  canonical: string;
  observedAt: string;
  source: string;
  configuration: string | null;
  indexVersion: null;
  intelligence: number | null;
  scores: Partial<Record<TaskType, number | null>>;
};
export type Performance = {
  source: string;
  checkedAt: string;
  endpointTag: string | null;
  aggregation: string;
  endpointCount: number;
  tokensPerSecond: number | null;
  firstTokenMs: number | null;
  tailFirstTokenP90Ms: number | null;
};
export type Candidate = {
  id: string;
  cli: string;
  model: string;
  canonical: string;
  billing: Binding['billing'];
  estimatedRequestUsd: number | null;
  intelligence: number | null;
  taskQualityPrior: number | null;
  evidence: Evidence | null;
  performance: Performance | null;
};
export type Portfolio = { type: TaskType; candidates: Candidate[] };
export type DecisionRequest = {
  decisionsRequest: {
    model: string;
    state: { task: string; portfolios: Portfolio[] };
    questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }>;
  };
};
/** Structurally matches sdk.alpha.decisions.create; callers own SDK/key creation. */
export type DecisionClient = {
  alpha: {
    decisions: {
      create(
        request: DecisionRequest,
        options: {
          timeoutMs: number;
          retries: { strategy: 'none' };
        },
      ): Promise<unknown>;
    };
  };
};
export type RoutingOptions = {
  stateDir: string;
  availability: () => Promise<Availability>;
  openRouterKey: () => string | undefined | Promise<string | undefined>;
  decisionClient?: (key: string) => DecisionClient;
  dynamic?: boolean;
  defaultRouteId?: string;
  /** Only the application without an operator-selected default enables pool fallback. */
  autoFallback?: boolean;
  chooser?: string;
  fetcher?: typeof fetch;
  now?: () => number;
};
type Model = {
  id: string;
  canonical: string;
  context: number | null;
  tools: boolean;
  modalities: string[];
  inputPrice: number | null;
  outputPrice: number | null;
  requestPrice: number | null;
  expires: string | null;
};
type Catalog = { models: Model[] };
type Snapshot<T> = { version: 1; checkedAt: string; data: T };
type Obj = Record<string, unknown>;
const DAY = 86_400_000;
const object = (x: unknown): Obj => (x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
const numeric = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const number = (x: unknown): number | null => (numeric(x) ? x : null);
const price = (x: unknown): number | null => (x === undefined || x === null || x === '' ? null : number(Number(x)));
const string = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 ? x : null);
const array = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const strings = (x: unknown): string[] => array(x).filter((s): s is string => typeof s === 'string');
export const fresh = (date: string, now: number, age: number): boolean => {
  const then = Date.parse(date);
  return Number.isFinite(then) && then <= now && now - then < age;
};
const median = (xs: (number | null)[]): number | null => {
  const values = xs.filter(numeric).sort((a, b) => a - b),
    i = Math.floor(values.length / 2);
  return !values.length ? null : values.length % 2 ? values[i]! : (values[i - 1]! + values[i]!) / 2;
};

export function normalizeCatalog(raw: unknown): Catalog {
  const data = array(object(raw).data);
  if (!data.length) throw new Error('invalid catalog');
  const models = data.flatMap((item): Model[] => {
    const m = object(item),
      id = string(m.id),
      canonical = string(m.canonical_slug),
      p = object(m.pricing);
    if (!id || !canonical) return [];
    return [
      {
        id,
        canonical,
        context: number(m.context_length),
        tools: strings(m.supported_parameters).includes('tools'),
        modalities: strings(object(m.architecture).input_modalities),
        inputPrice: price(p.prompt),
        outputPrice: price(p.completion),
        requestPrice: p.request === undefined ? 0 : price(p.request),
        expires: string(m.expiration_date),
      },
    ];
  });
  if (!models.length) throw new Error('catalog has no exact canonical models');
  return { models };
}
export function normalizeEvidence(raw: unknown, catalog: Catalog): Evidence[] {
  const body = object(raw),
    meta = object(body.meta),
    observedAt = string(meta.as_of);
  if (!Array.isArray(body.data) || !observedAt || !Number.isFinite(Date.parse(observedAt)))
    throw new Error('invalid benchmark feed');
  return body.data.flatMap((item): Evidence[] => {
    const row = object(item);
    if (row.source !== 'artificial-analysis') return [];
    return catalog.models
      .filter((m) => m.canonical === row.model_permaslug)
      .map((m) => ({
        model: m.id,
        canonical: m.canonical,
        observedAt,
        source: string(meta.citation) ?? 'https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis',
        configuration: string(row.display_name),
        indexVersion: null,
        intelligence: number(row.intelligence_index),
        scores: {
          lookup: null,
          change: number(row.coding_index),
          debug: null,
          plan: number(row.agentic_index),
          review: null,
        },
      }));
  });
}
export function normalizePerformance(
  raw: unknown,
  model: string,
  endpointTag: string | undefined,
  checkedAt: string,
): Performance {
  const data = object(object(raw).data);
  if (data.id !== model || !Array.isArray(data.endpoints)) throw new Error('invalid endpoint feed');
  const endpoints = data.endpoints.map(object).filter((e) => e.status === 0 && (!endpointTag || e.tag === endpointTag));
  return {
    source: `https://openrouter.ai/api/v1/models/${model}/endpoints`,
    checkedAt,
    endpointTag: endpointTag ?? null,
    aggregation: endpointTag
      ? 'selected endpoint'
      : 'unweighted median of active provider percentiles; not selected-provider performance',
    endpointCount: endpoints.length,
    tokensPerSecond: median(endpoints.map((e) => number(object(e.throughput_last_30m).p50))),
    firstTokenMs: median(endpoints.map((e) => number(object(e.latency_last_30m).p50))),
    tailFirstTokenP90Ms: median(endpoints.map((e) => number(object(e.latency_last_30m).p90))),
  };
}
/** At most five complementary candidates; unknown metrics never become zero. */
export function portfolio(type: TaskType, candidates: Candidate[]): Portfolio {
  const selected: Candidate[] = [];
  const pick = (metric: (c: Candidate) => number | null, descending = false) => {
    const ranked = candidates
      .filter((c) => numeric(metric(c)))
      .sort((a, b) => (descending ? -1 : 1) * (metric(a)! - metric(b)!) || a.id.localeCompare(b.id));
    if (ranked[0] && !selected.includes(ranked[0])) selected.push(ranked[0]);
  };
  pick((c) => c.taskQualityPrior, true);
  pick((c) => c.intelligence, true);
  pick((c) => (c.billing === 'subscription' ? 0 : null));
  pick((c) => c.estimatedRequestUsd);
  pick((c) => c.performance?.tokensPerSecond ?? null, true);
  for (const c of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) if (!selected.includes(c)) selected.push(c);
  return { type, candidates: selected.slice(0, 5) };
}

export class Routing {
  private readonly options: RoutingOptions;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  constructor(options: RoutingOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetch;
  }
  private async json(url: string, key?: string): Promise<unknown> {
    const response = await this.fetcher(url, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`routing metadata HTTP ${response.status}`);
    return response.json();
  }
  /** Versioned, atomic, private cache. Stale data is never returned after failed refresh. */
  private async cached(name: string, age: number, load: () => Promise<unknown>): Promise<Snapshot<unknown>> {
    const pending = this.inFlight.get(name);
    if (pending) return pending as Promise<Snapshot<unknown>>;
    const operation = (async (): Promise<Snapshot<unknown>> => {
      const dir = join(this.options.stateDir, 'routing'),
        path = join(dir, `${name}.json`);
      try {
        const parsed = object(JSON.parse(await readFile(path, 'utf8')));
        if (parsed.version === 1 && typeof parsed.checkedAt === 'string' && fresh(parsed.checkedAt, this.now(), age))
          return parsed as Snapshot<unknown>;
      } catch {
        /* Missing/corrupt files are refreshed, never treated as evidence. */
      }
      const data = await load();
      const snapshot: Snapshot<unknown> = { version: 1, checkedAt: new Date(this.now()).toISOString(), data };
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
      return snapshot;
    })();
    this.inFlight.set(name, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(name);
    }
  }
  private eligible(binding: Binding, request: Selection): boolean {
    return (
      !!binding.id &&
      binding.id !== 'abstain' &&
      !!binding.cli &&
      binding.signedIn === true &&
      binding.compatibility === 'verified' &&
      binding.healthy !== false &&
      !binding.quotaBlocked &&
      (!request.allowedRouteIds || request.allowedRouteIds.includes(binding.id)) &&
      (binding.billing === 'subscription' || request.allowPaidApi === true) &&
      (request.minContext === undefined || (numeric(binding.context) && binding.context >= request.minContext)) &&
      (request.requireTools !== true || binding.tools !== false) &&
      (!request.modality || binding.modalities === undefined || binding.modalities.includes(request.modality))
    );
  }
  private async inventory(request: Selection): Promise<Binding[]> {
    const available = await this.options.availability();
    if (!fresh(available.checkedAt, this.now(), 60_000)) throw new Error('routing availability stale');
    const ids = new Set<string>();
    return available.bindings.filter((b) => {
      if (ids.has(b.id)) return false;
      ids.add(b.id);
      return this.eligible(b, request);
    });
  }
  private async fallback(request: Selection, reason: string, decisionCostUsd?: number): Promise<Route> {
    const eligible = await this.inventory(request);
    const preferred = eligible.find((b) => b.id === this.options.defaultRouteId);
    let binding =
      (preferred?.billing === 'subscription' ? preferred : undefined) ??
      eligible.find((b) => b.billing === 'subscription') ??
      preferred;
    if (binding?.billing === 'use') {
      try {
        await this.apiBudget(binding, request);
      } catch (error) {
        if (!this.options.autoFallback) throw error;
        binding = undefined;
      }
    }
    if (!binding && this.options.autoFallback) {
      // Canonical metadata is supplied only for operator-approved Auto profiles.
      // Legacy provider/auto aliases and unapproved profiles cannot enter this path.
      const priced = await Promise.all(
        eligible
          .filter(
            (candidate) =>
              candidate.billing === 'use' &&
              candidate.provider === 'openrouter' &&
              !!candidate.model &&
              !!candidate.canonical,
          )
          .map(async (candidate) => {
            try {
              return { binding: candidate, estimate: await this.apiBudget(candidate, request) };
            } catch {
              return null;
            }
          }),
      );
      binding = priced
        .filter((item): item is { binding: Binding; estimate: number } => item !== null)
        .sort((a, b) => a.estimate - b.estimate || a.binding.id.localeCompare(b.binding.id))[0]?.binding;
      if (binding) reason += '; lowest priced approved Auto pool fallback';
    }
    if (!binding) throw new Error('no eligible configured route');
    return {
      cli: binding.cli,
      model: binding.model,
      routeId: binding.id,
      source: binding.billing === 'subscription' ? 'subscription' : 'default',
      reason,
      decisionCostUsd,
    };
  }
  private async apiBudget(binding: Binding, request: Selection): Promise<number> {
    if (
      binding.provider !== 'openrouter' ||
      !request.allowPaidApi ||
      !numeric(request.maxEstimatedUsd) ||
      !binding.model ||
      !binding.canonical
    )
      throw new Error('paid route requires opt-in, known model and request budget');
    const snapshot = await this.cached('catalog', DAY, async () => {
      const raw = await this.json('https://openrouter.ai/api/v1/models');
      normalizeCatalog(raw);
      return raw;
    });
    const model = normalizeCatalog(snapshot.data).models.find(
      (m) => m.id === binding.model && m.canonical === binding.canonical,
    );
    if (!model || !numeric(model.inputPrice) || !numeric(model.outputPrice) || !numeric(model.requestPrice))
      throw new Error('paid route price unknown');
    if (model.expires && Date.parse(model.expires) <= this.now()) throw new Error('paid model retired');
    const estimate =
      (request.inputTokens ?? 10_000) * model.inputPrice +
      (request.outputTokens ?? 2_000) * model.outputPrice +
      model.requestPrice;
    if (estimate > request.maxEstimatedUsd) throw new Error('estimated request budget exceeded');
    return estimate;
  }
  async select(request: Selection): Promise<Route> {
    if (request.pinned) return { ...request.pinned, source: 'pinned' };
    for (const n of [
      request.minContext,
      request.inputTokens,
      request.outputTokens,
      request.maxEstimatedUsd,
      request.decisionBudgetUsd,
    ])
      if (n !== undefined && !numeric(n)) throw new Error('routing limits must be finite nonnegative numbers');
    if (
      request.deadlineUtc &&
      (!Number.isFinite(Date.parse(request.deadlineUtc)) || Date.parse(request.deadlineUtc) <= this.now())
    )
      throw new Error('routing deadline elapsed or invalid');
    const eligible = await this.inventory(request);
    if (request.explicit) {
      const binding = eligible.find(
        (b) =>
          b.cli === request.explicit!.cli &&
          (request.explicit!.model === undefined || b.model === request.explicit!.model),
      );
      if (!binding) throw new Error('explicit route unavailable or disallowed');
      if (binding.billing === 'use' && request.maxEstimatedUsd !== undefined) await this.apiBudget(binding, request);
      return {
        cli: binding.cli,
        model: request.explicit.model ?? binding.model,
        routeId: binding.id,
        source: 'explicit',
        ...(binding.billing === 'use' && request.maxEstimatedUsd === undefined
          ? { reason: 'unpriced explicit route; cost unknown' }
          : {}),
      };
    }
    if (!this.options.dynamic) return this.fallback(request, 'dynamic routing disabled');
    const key = await this.options.openRouterKey();
    if (!key || !this.options.decisionClient || !numeric(request.decisionBudgetUsd) || request.decisionBudgetUsd <= 0)
      return this.fallback(request, 'dynamic routing requires a key, decision client and explicit decision budget');
    // Included subscriptions are always considered before metered execution routes.
    const included = eligible.filter((b) => b.billing === 'subscription');
    const bindings = included.length ? included : eligible;
    let portfolios: Portfolio[];
    try {
      const catalogSnapshot = await this.cached('catalog', DAY, async () => {
        const raw = await this.json('https://openrouter.ai/api/v1/models');
        normalizeCatalog(raw);
        return raw;
      });
      const catalog = normalizeCatalog(catalogSnapshot.data);
      const evidenceSnapshot = await this.cached('intelligence', DAY, async () => {
        const raw = await this.json('https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis', key);
        normalizeEvidence(raw, catalog);
        return raw;
      });
      const evidence = normalizeEvidence(evidenceSnapshot.data, catalog).filter((e) =>
        fresh(e.observedAt, this.now(), 7 * DAY),
      );
      const candidates: Candidate[] = [];
      // Bound endpoint metadata requests as well as decision prompt size.
      await Promise.all(
        bindings.slice(0, 20).map(async (b) => {
          if (b.billing === 'use' && b.provider !== 'openrouter') return;
          const m = catalog.models.find((m) => m.id === b.model && m.canonical === b.canonical);
          if (
            !m ||
            (m.expires && Date.parse(m.expires) <= this.now()) ||
            m.context === null ||
            m.context < (request.minContext ?? 16_000) ||
            !m.modalities.includes(request.modality ?? 'text') ||
            (request.requireTools !== false && !m.tools)
          )
            return;
          const estimate =
            b.billing === 'subscription'
              ? null
              : [m.inputPrice, m.outputPrice, m.requestPrice].every(numeric)
                ? (request.inputTokens ?? 10_000) * m.inputPrice! +
                  (request.outputTokens ?? 2_000) * m.outputPrice! +
                  m.requestPrice!
                : null;
          if (
            b.billing === 'use' &&
            (estimate === null || !numeric(request.maxEstimatedUsd) || estimate > request.maxEstimatedUsd)
          )
            return;
          let performance: Performance | null = null;
          try {
            const id = Buffer.from(m.id).toString('base64url');
            const snapshot = await this.cached(`performance-${id}`, 300_000, async () => {
              const url = `https://openrouter.ai/api/v1/models/${m.id.split('/').map(encodeURIComponent).join('/')}/endpoints`;
              const raw = await this.json(url, key);
              normalizePerformance(raw, m.id, b.endpointTag, new Date(this.now()).toISOString());
              return raw;
            });
            performance = normalizePerformance(snapshot.data, m.id, b.endpointTag, snapshot.checkedAt);
          } catch {
            /* Missing/stale performance is unknown, never a stale speed prior. */
          }
          const e = evidence.find((e) => e.model === m.id && e.canonical === m.canonical) ?? null;
          candidates.push({
            id: b.id,
            cli: b.cli,
            model: m.id,
            canonical: m.canonical,
            billing: b.billing,
            estimatedRequestUsd: estimate,
            intelligence: e?.intelligence ?? null,
            taskQualityPrior: null,
            evidence: e,
            performance,
          });
        }),
      );
      portfolios = (Object.keys(TASK_TYPES) as TaskType[]).map((type) =>
        portfolio(
          type,
          candidates.map((c) => ({ ...c, taskQualityPrior: c.evidence?.scores[type] ?? null })),
        ),
      );
    } catch {
      return this.fallback(request, 'fresh routing metadata unavailable');
    }
    if (!portfolios.some((p) => p.candidates.length))
      return this.fallback(request, 'no exact eligible dynamic candidates');
    const criteria: Record<string, string> = { abstain: 'Insufficient evidence. Keep deterministic route.' };
    for (const p of portfolios)
      for (const c of p.candidates) criteria[c.id] = `${c.model} through ${c.cli}; ${c.billing}`;
    let raw: unknown;
    try {
      raw = await this.options.decisionClient(key).alpha.decisions.create(
        {
          decisionsRequest: {
            model: this.options.chooser ?? 'cloudflare/clef-flash',
            state: { task: request.task, portfolios },
            questions: {
              type: {
                type: 'choice',
                instructions: 'Classify the task; abstain if unclear.',
                criteria: { ...TASK_TYPES, abstain: 'Task unclear' },
              },
              route: {
                type: 'choice',
                instructions:
                  'Choose only within the classified task portfolio. Unknown evidence is unknown. Prefer quality-supported low total cost. Abstain if uncertain.',
                criteria,
              },
            },
          },
        },
        {
          timeoutMs: Math.min(
            15_000,
            request.deadlineUtc ? Math.max(1, Date.parse(request.deadlineUtc) - this.now()) : 15_000,
          ),
          retries: { strategy: 'none' },
        },
      );
    } catch {
      return this.fallback(request, 'decision unavailable; no automatic inference retry');
    }
    const response = object(raw),
      usage = object(response.usage),
      answers = object(response.answers);
    if (!numeric(usage.cost))
      return this.fallback({ ...request, allowPaidApi: false }, 'decision cost unknown; metered execution disabled');
    if (usage.cost > request.decisionBudgetUsd)
      return this.fallback({ ...request, allowPaidApi: false }, 'decision exceeded its admission budget', usage.cost);
    const type = string(object(answers.type).choice),
      routeId = string(object(answers.route).choice);
    const choice = portfolios.find((p) => p.type === type)?.candidates.find((c) => c.id === routeId);
    if (!choice) return this.fallback(request, 'decision abstained or selected an invalid portfolio route', usage.cost);
    // Decisions are hints. Dispatch must re-read live account availability.
    if (request.deadlineUtc && Date.parse(request.deadlineUtc) <= this.now())
      throw new Error('routing deadline elapsed');
    const current = (await this.inventory(request)).find(
      (b) => b.id === choice.id && b.cli === choice.cli && b.model === choice.model && b.canonical === choice.canonical,
    );
    if (!current) return this.fallback(request, 'selected route changed before dispatch', usage.cost);
    return {
      cli: choice.cli,
      model: choice.model,
      routeId: choice.id,
      type: type as TaskType,
      source: 'decision',
      decisionCostUsd: usage.cost,
      decisionModel: string(response.model) ?? undefined,
      candidates: portfolios,
    };
  }
}
