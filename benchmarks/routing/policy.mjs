// Ranking is arithmetic over evidence. Semantic task/route choices use a decision model.
export const DAY = 86_400_000;
export const TASK_TYPES = {
  lookup: "Read existing source, retrieve facts and summarize evidence.",
  change: "Implement a bounded coding change with tests.",
  debug: "Diagnose bugs, concurrency, state and integration failures.",
  plan: "Decompose a large project and reason about architecture and dependencies.",
  review: "Review code for correctness, regressions and risks.",
};
const valid = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
export const fresh = (date, now, age = DAY) => {
  const t = Date.parse(date);
  return Number.isFinite(t) && t <= now && now - t < age;
};
export function normalizeCatalog(body, fetchedAt = new Date().toISOString()) {
  if (!Array.isArray(body.data) || !body.data.length) throw Error("invalid catalog");
  return {
    fetchedAt,
    source: "https://openrouter.ai/api/v1/models",
    models: body.data.map((m) => ({
      id: m.id,
      canonical: m.canonical_slug,
      context: m.context_length,
      modalities: m.architecture?.input_modalities ?? [],
      tools: m.supported_parameters?.includes("tools") ?? false,
      inputUsdPerToken: m.pricing?.prompt == null ? null : Number(m.pricing.prompt),
      outputUsdPerToken: m.pricing?.completion == null ? null : Number(m.pricing.completion),
      requestUsd: m.pricing?.request == null ? 0 : Number(m.pricing.request),
      cachedInputUsdPerToken:
        m.pricing?.input_cache_read == null ? null : Number(m.pricing.input_cache_read),
      expires: m.expiration_date ?? null,
    })),
  };
}
export function observations(comparison, type = "change") {
  return comparison.profiles.flatMap((p) => {
    const runs = comparison.runs.filter((r) => r.profile === p.id);
    if (!runs.length) return [];
    return [
      {
        model: p.model,
        canonical: p.canonical,
        type,
        observedAt: comparison.finishedAt ?? comparison.startedAt,
        harness: "claude",
        provider: "openrouter",
        attempts: runs.length,
        accepted: runs.filter((r) => r.grade.pass && !r.error).length,
        costUsd: runs.every((r) => valid(r.costUsd))
          ? runs.reduce((n, r) => n + r.costUsd, 0)
          : null,
        totalSeconds: runs.reduce((n, r) => n + r.totalMs / 1000, 0),
        source: "local held-out acceptance checks; one attempt per task; not intelligence",
      },
    ];
  });
}
export function shortlist({
  catalog,
  inventory,
  evidence = [],
  history = [],
  type,
  now = Date.now(),
  limit = 5,
  minContext = 16000,
  modality = "text",
  inputTokens = 10000,
  outputTokens = 2000,
  maxEstimatedUsd = 1,
  minSamples = 10,
}) {
  if (!Object.hasOwn(TASK_TYPES, type)) throw Error("unknown task type");
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw Error("limit must be 1..5");
  const rejected = [],
    rows = [];
  for (const route of inventory.routes) {
    const cli = inventory.clis.find((c) => c.name === route.cli);
    const m = catalog.models.find(
      (m) => m.id === route.model && (!route.canonical || route.canonical === m.canonical),
    );
    let reason;
    if (!fresh(catalog.fetchedAt, now)) reason = "catalog stale; retain existing session route";
    else if (!fresh(inventory.checkedAt, now, 60_000)) reason = "availability stale";
    else if (cli?.signedIn !== true) reason = "CLI unavailable or sign-in unknown";
    else if (route.billing !== "subscription" && !inventory.keyProviders.includes(route.provider))
      reason = "provider key missing";
    else if (route.compatibility !== "verified") reason = "harness/model needs compatibility probe";
    else if (route.quotaBlocked || route.healthy === false) reason = "quota or health blocked";
    else if (!m) reason = "exact model version not in catalog";
    else if (
      !m.tools ||
      !m.modalities.includes(modality) ||
      !valid(m.context) ||
      m.context < minContext
    )
      reason = "required capabilities missing";
    else if (m.expires && Date.parse(m.expires) <= now) reason = "model retired";
    else if (
      route.billing !== "subscription" &&
      ![m.inputUsdPerToken, m.outputUsdPerToken, m.requestUsd].every(valid)
    )
      reason = "price unknown";
    const estimate =
      route.billing === "subscription"
        ? null
        : m && inputTokens * m.inputUsdPerToken + outputTokens * m.outputUsdPerToken + m.requestUsd;
    if (!reason && estimate !== null && estimate > maxEstimatedUsd)
      reason = "estimated request budget exceeded";
    if (reason) {
      rejected.push({ route: route.id, reason });
      continue;
    }
    const h = history.find(
      (h) =>
        h.model === m.id &&
        h.canonical === m.canonical &&
        h.type === type &&
        h.harness === route.harness &&
        h.provider === route.provider &&
        fresh(h.observedAt, now, 30 * DAY),
    );
    const e = evidence.find(
      (e) => e.model === m.id && e.canonical === m.canonical && fresh(e.observedAt, now, 7 * DAY),
    );
    const proven = h?.attempts >= minSamples;
    const quality = e?.scores?.[type] ?? null;
    // Missing intelligence never becomes an invented zero. Trials remain visibly sparse.
    rows.push({
      id: route.id,
      model: m.id,
      cli: route.cli,
      harness: route.harness,
      provider: route.provider,
      billing: route.billing,
      estimatedRequestUsd: estimate,
      intelligence: e?.intelligence ?? null,
      intelligenceSource: e?.source ?? null,
      intelligenceConfiguration: e?.configuration ?? null,
      taskQualityPrior: quality,
      attempts: h?.attempts ?? 0,
      accepted: h?.accepted ?? 0,
      proven,
      observedCostPerAcceptedUsd: h?.accepted && valid(h.costUsd) ? h.costUsd / h.accepted : null,
      observedMeanTaskSeconds: h?.attempts ? h.totalSeconds / h.attempts : null,
      priorTokensPerSecond: e?.tokensPerSecond ?? null,
      priorFirstTokenSeconds: e?.firstTokenSeconds ?? null,
      confidence: proven ? "measured" : h ? "sparse" : "unmeasured",
    });
  }
  const chosen = [],
    slots = {};
  const pick = (slot, value, direction = 1) => {
    const sorted = rows
      .filter((r) => valid(value(r)))
      .sort((a, b) => direction * (value(a) - value(b)) || a.id.localeCompare(b.id));
    if (sorted.length) {
      slots[slot] = sorted[0].id;
      if (!chosen.includes(sorted[0])) chosen.push(sorted[0]);
    }
  };
  // A diverse portfolio, not a weighted scalar that hides quality/cost tradeoffs.
  pick("taskQuality", (r) => r.taskQualityPrior, -1);
  pick("intelligence", (r) => r.intelligence, -1);
  pick("includedPlan", (r) => (r.billing === "subscription" ? 0 : null));
  pick("cheapest", (r) => r.estimatedRequestUsd);
  pick("fastestObserved", (r) => (r.proven ? r.observedMeanTaskSeconds : null));
  pick("fastestPrior", (r) => r.priorTokensPerSecond, -1);
  for (const r of [...rows].sort(
    (a, b) => (b.intelligence ?? -1) - (a.intelligence ?? -1) || a.id.localeCompare(b.id),
  ))
    if (!chosen.includes(r)) chosen.push(r);
  const candidates = chosen.slice(0, limit);
  return {
    type,
    generatedAt: new Date(now).toISOString(),
    snapshotAt: catalog.fetchedAt,
    slots: Object.fromEntries(
      Object.entries(slots).filter(([, id]) => candidates.some((r) => r.id === id)),
    ),
    candidates,
    rejected,
    note: "Shortlist only. Decision model selects a route; dispatcher must revalidate availability. Subscription quota cost is unknown, not free. Request estimate excludes retries/tools/thinking and is not task cost.",
  };
}
export async function decide({ sdk, task, portfolios, chooser = "cloudflare/clef-flash" }) {
  const options = { abstain: "Insufficient evidence or no suitable route. Keep current route." };
  for (const p of portfolios)
    for (const c of p.candidates) options[c.id] = `${c.model} through ${c.cli}; ${c.billing}`;
  if (Object.keys(options).length === 1) return { type: "abstain", route: "abstain", costUsd: 0 };
  const response = await sdk.alpha.decisions.create(
    {
      decisionsRequest: {
        model: chooser,
        state: { task, portfolios },
        questions: {
          type: {
            type: "choice",
            instructions: "Classify this task. Abstain if unclear.",
            criteria: { ...TASK_TYPES, abstain: "Task unclear" },
          },
          route: {
            type: "choice",
            instructions:
              "Choose an available route in the classified task's portfolio. Prefer lower total cost only when quality evidence supports it. Sparse tests are not proof. Abstain if uncertain.",
            criteria: options,
          },
        },
      },
    },
    { timeoutMs: 15000, retries: { strategy: "none" } },
  );
  const type = response.answers?.type?.choice,
    route = response.answers?.route?.choice;
  if (!valid(response.usage?.cost)) throw Error("decision cost unknown; stop paid routing");
  if (type === "abstain" || route === "abstain")
    return { type: "abstain", route: "abstain", costUsd: response.usage.cost };
  const candidate = portfolios.find((p) => p.type === type)?.candidates.find((c) => c.id === route);
  if (!candidate)
    return {
      type: "abstain",
      route: "abstain",
      reason: "invalid or cross-portfolio choice",
      costUsd: response.usage.cost,
    };
  return {
    type,
    route,
    model: candidate.model,
    cli: candidate.cli,
    costUsd: response.usage.cost,
    decisionModel: response.model,
    dispatch: "new isolated ACP session; no in-session model swap",
  };
}
