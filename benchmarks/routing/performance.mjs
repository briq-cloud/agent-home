import { readFile, writeFile } from "node:fs/promises";
import { fresh } from "./policy.mjs";
const numeric = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
export function endpointPerformance(body, model, checkedAt = new Date().toISOString()) {
  if (body.data?.id !== model || !Array.isArray(body.data?.endpoints))
    throw Error("invalid endpoint feed");
  return {
    model,
    checkedAt,
    source: `https://openrouter.ai/api/v1/models/${model}/endpoints`,
    endpoints: body.data.endpoints.map((e) => ({
      tag: e.tag,
      provider: e.provider_name,
      status: e.status,
      quantization: e.quantization,
      context: e.context_length,
      tools: e.supported_parameters?.includes("tools") ?? false,
      pricing: e.pricing,
      latencyMs: e.latency_last_30m ?? null,
      throughputTokensPerSecond: e.throughput_last_30m ?? null,
      uptime1dPercent: e.uptime_last_1d ?? null,
      uptime5mPercent: e.uptime_last_5m ?? null,
    })),
  };
}
const median = (xs) => {
  const a = xs.filter(numeric).sort((a, b) => a - b),
    i = Math.floor(a.length / 2);
  return !a.length ? null : a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};
export function performancePrior(snapshot, endpointTag, now = Date.now()) {
  if (!snapshot || !fresh(snapshot.checkedAt, now, 300000)) return null;
  const endpoints = snapshot.endpoints.filter(
    (e) => e.status === 0 && (endpointTag ? e.tag === endpointTag : true),
  );
  return {
    source: snapshot.source,
    checkedAt: snapshot.checkedAt,
    endpointTag: endpointTag ?? null,
    aggregation: endpointTag
      ? "selected endpoint"
      : "unweighted median of provider percentiles; not a traffic-weighted model average",
    endpointCount: endpoints.length,
    tokensPerSecond: median(endpoints.map((e) => e.throughputTokensPerSecond?.p50)),
    firstTokenMs: median(endpoints.map((e) => e.latencyMs?.p50)),
    tailFirstTokenP90Ms: median(endpoints.map((e) => e.latencyMs?.p90)),
    uptime1dPercent: median(endpoints.map((e) => e.uptime1dPercent)),
  };
}
export async function refreshPerformance(path, key, models, fetcher = fetch) {
  let old = [];
  try {
    old = JSON.parse(await readFile(path, "utf8"));
  } catch {}
  const ids = [...new Set(models)];
  if (ids.length > 20) throw Error("limit performance refresh to 20 candidate models");
  const snapshots = [];
  for (const model of ids) {
    const cached = old.find((s) => s.model === model);
    if (cached && fresh(cached.checkedAt, Date.now(), 300000)) {
      snapshots.push(cached);
      continue;
    }
    try {
      const r = await fetcher(
        `https://openrouter.ai/api/v1/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`,
        {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!r.ok) throw Error("endpoint feed unavailable");
      snapshots.push(endpointPerformance(await r.json(), model));
    } catch {
      if (cached) snapshots.push(cached);
    }
  }
  await writeFile(path, JSON.stringify(snapshots, null, 2), { mode: 0o600 });
  return snapshots;
}
