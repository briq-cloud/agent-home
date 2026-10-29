import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OpenRouter } from "@openrouter/sdk";
import { providerKey } from "../live.mjs";
import { mediumTasks } from "../medium.mjs";
import { shortlist, observations, TASK_TYPES, decide } from "./policy.mjs";
import { refresh } from "./refresh.mjs";
import { fetchAnalysis, importOpenRouterBenchmarks } from "./evidence.mjs";
import { refreshPerformance, performancePrior } from "./performance.mjs";
// The inventory contains only route metadata and key-provider names, never credentials.
export async function plan(dir) {
  const load = async (name) => JSON.parse(await readFile(`${dir}/${name}.json`, "utf8"));
  const inventory = await load("inventory"),
    catalog = await refresh(`${dir}/catalog.json`);
  let evidence = [],
    history = [];
  try {
    evidence = await load("evidence");
  } catch {}
  if (process.env.BENCH_KEYS_FILE && !process.env.ARTIFICIAL_ANALYSIS_API_KEY) {
    let feed;
    try {
      feed = await load("openrouter-benchmarks");
    } catch {}
    if (!feed?.checkedAt || Date.now() - Date.parse(feed.checkedAt) > 86_400_000) {
      const key = await providerKey();
      const r = await fetch("https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis", {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw Error(`benchmark feed HTTP ${r.status}`);
      feed = { ...(await r.json()), checkedAt: new Date().toISOString() };
      await writeFile(`${dir}/openrouter-benchmarks.json`, JSON.stringify(feed, null, 2), {
        mode: 0o600,
      });
    }
    evidence = importOpenRouterBenchmarks(feed, catalog);
    await writeFile(`${dir}/evidence.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  if (process.env.ARTIFICIAL_ANALYSIS_API_KEY) {
    evidence = await fetchAnalysis(process.env.ARTIFICIAL_ANALYSIS_API_KEY, await load("aliases"));
    await writeFile(`${dir}/evidence.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  try {
    history = observations(await load("comparison"));
  } catch {}
  let performance = [];
  if (process.env.BENCH_KEYS_FILE) {
    const snapshots = await refreshPerformance(
      `${dir}/performance.json`,
      await providerKey(),
      inventory.routes.map((r) => r.model),
    );
    performance = inventory.routes.flatMap((r) => {
      const p = performancePrior(
        snapshots.find((p) => p.model === r.model),
        r.endpointTag,
      );
      return p ? [{ model: r.model, ...p }] : [];
    });
  }
  const portfolios = Object.keys(TASK_TYPES).map((type) =>
    shortlist({ catalog, inventory, evidence, history, performance, type }),
  );
  await writeFile(`${dir}/portfolios.json`, JSON.stringify(portfolios, null, 2), { mode: 0o600 });
  let decision = null;
  if (process.env.ROUTE_TASK || process.env.ROUTE_TASK_ID) {
    const fixture =
      process.env.ROUTE_TASK_ID && mediumTasks.find((t) => t.id === process.env.ROUTE_TASK_ID);
    if (process.env.ROUTE_TASK_ID && !fixture) throw Error("unknown fixture task");
    const apiKey = await providerKey(); // requires BENCH_PAID=1, like all paid experiments
    const sdk = new OpenRouter({
      apiKey,
      serverURL: "https://openrouter.ai",
      retryConfig: { strategy: "none" },
    });
    decision = await decide({ sdk, task: fixture?.prompt ?? process.env.ROUTE_TASK, portfolios });
    if (fixture) decision.taskId = fixture.id;
    await writeFile(`${dir}/decision.json`, JSON.stringify(decision, null, 2), { mode: 0o600 });
  }
  console.log(
    JSON.stringify({
      shortlists: portfolios.map((p) => ({
        type: p.type,
        candidates: p.candidates.map((c) => c.model),
        rejected: p.rejected,
      })),
      decision,
    }),
  );
  return { portfolios, decision };
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href)
  await plan(resolve(process.argv[2] ?? "results/routing"));
