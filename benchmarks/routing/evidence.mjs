// Explicit ID/version/effort joins only: never match model names approximately.
export function importOpenRouterBenchmarks(body, catalog) {
  if (!Array.isArray(body.data) || !body.meta?.as_of) throw Error("invalid benchmark feed");
  return body.data.flatMap((row) => {
    if (row.source !== "artificial-analysis") return [];
    // model_permaslug is a versioned OpenRouter ID, not its marketing name or alias.
    return catalog.models
      .filter((m) => m.canonical === row.model_permaslug)
      .map((m) => ({
        model: m.id,
        canonical: m.canonical,
        observedAt: body.meta.as_of,
        source: body.meta.citation ?? "Artificial Analysis via OpenRouter benchmarks",
        sourceUrl: "https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis",
        feedVersion: body.meta.version,
        indexVersion: null,
        configuration: row.display_name,
        intelligence: row.intelligence_index ?? null,
        scores: {
          lookup: null,
          change: row.coding_index ?? null,
          debug: null,
          review: null,
          plan: row.agentic_index ?? null,
        },
        tokensPerSecond: null,
        firstTokenSeconds: null,
        caveat:
          "Feed does not expose index version or complete evaluation configuration. Prior only; not equivalent to this harness.",
      }));
  });
}
export function importAnalysis(body, aliases, observedAt = new Date().toISOString()) {
  if (!Array.isArray(body.data) || !body.intelligence_index_version)
    throw Error("invalid evaluation feed");
  return body.data.flatMap((m) => {
    const alias = aliases[m.slug];
    if (!alias?.model || !alias.canonical || !alias.configuration) return [];
    const e = m.evaluations ?? {},
      coding = e.artificial_analysis_coding_index ?? null;
    return [
      {
        ...alias,
        observedAt,
        source: `https://artificialanalysis.ai/data-api/docs/reference; intelligence index v${body.intelligence_index_version}; ${m.slug}`,
        intelligence: e.artificial_analysis_intelligence_index ?? null,
        indexVersion: body.intelligence_index_version,
        scores: {
          lookup: null,
          change: coding,
          debug: coding,
          review: coding,
          plan: e.artificial_analysis_agentic_index ?? null,
        },
        tokensPerSecond: m.performance?.median_output_tokens_per_second ?? null,
        firstTokenSeconds: m.performance?.median_time_to_first_token_seconds ?? null,
        caveat: "External prior; benchmark effort/harness may differ from execution profile.",
      },
    ];
  });
}
export async function fetchAnalysis(key, aliases, fetcher = fetch) {
  const data = [];
  let version;
  for (let page = 1; page <= 20; page++) {
    const r = await fetcher(
      `https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`,
      {
        headers: { "x-api-key": key },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) throw Error(`evaluation feed HTTP ${r.status}`);
    const body = await r.json();
    if (version && version !== body.intelligence_index_version)
      throw Error("index changed during pagination");
    version = body.intelligence_index_version;
    data.push(...importAnalysis(body, aliases));
    if (!body.pagination?.has_more) return data;
  }
  throw Error("evaluation pagination exceeded bound");
}
