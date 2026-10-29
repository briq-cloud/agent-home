import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { mediumTasks } from "../medium.mjs";
import { shortlist } from "./policy.mjs";
const exec = promisify(execFile);
// Explicit experiment: only trusted benchmark fixtures, no arbitrary project execution.
export async function executeRoute({ dir, taskId, run = exec, fetcher = fetch }) {
  if (process.env.BENCH_PAID !== "1") throw Error("BENCH_PAID=1 required");
  if (!mediumTasks.some((t) => t.id === taskId)) throw Error("select a medium fixture task ID");
  const load = async (name) => JSON.parse(await readFile(join(dir, name + ".json"), "utf8"));
  const [decision, catalog, inventory] = await Promise.all([
    load("decision"),
    load("catalog"),
    load("inventory"),
  ]);
  if (decision.route === "abstain") throw Error("abstention cannot dispatch");
  if (decision.taskId !== taskId) throw Error("decision does not match fixture");
  if (!process.env.RUNNER_TOKEN_FILE)
    throw Error("RUNNER_TOKEN_FILE required for live availability check");
  const origin = new URL(process.env.ROUTING_RUNNER_URL ?? "http://127.0.0.1:8090");
  if (origin.hostname !== "127.0.0.1" || origin.protocol !== "http:")
    throw Error("runner inventory must use loopback");
  const token = (await readFile(process.env.RUNNER_TOKEN_FILE, "utf8")).trim();
  const get = async (path) => {
    const r = await fetcher(new URL(path, origin), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw Error("runner metadata unavailable");
    return r.json();
  };
  const [status, keys] = await Promise.all([get("/status"), get("/keys")]);
  inventory.clis = status.clis.map(({ name, signedIn }) => ({ name, signedIn }));
  inventory.keyProviders = keys.providers.filter((p) => p.set).map((p) => p.id);
  inventory.checkedAt = new Date().toISOString();
  // Revalidate the chosen binding, without reranking a different five-model portfolio.
  inventory.routes = inventory.routes.filter((r) => r.id === decision.route);
  const eligible = shortlist({ catalog, inventory, type: decision.type }).candidates.find(
    (c) => c.id === decision.route,
  );
  if (
    !eligible ||
    eligible.model !== decision.model ||
    eligible.harness !== "claude" ||
    eligible.provider !== "openrouter"
  )
    throw Error("route no longer eligible or not supported by this experiment");
  const root = join(dir, `dispatch-${Date.now()}`);
  await writeFile(
    join(dir, "dispatch.json"),
    JSON.stringify({ taskId, decision, revalidatedAt: inventory.checkedAt, root }, null, 2),
    { mode: 0o600 },
  );
  // cli.mjs starts a fresh ACP runner with isolated settings and the selected API-key model.
  await run(process.execPath, ["cli.mjs", "live"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      BENCH_RESULTS: root,
      BENCH_MODEL: decision.model,
      BENCH_SUITE: "medium",
      BENCH_TASK_IDS: taskId,
      BENCH_ARMS: "baseline",
      BENCH_BUDGET_USD: "0.25",
    },
    timeout: 400000,
    maxBuffer: 1000000,
  });
  const result = JSON.parse(await readFile(join(root, "results.json"), "utf8"));
  console.log(
    JSON.stringify({
      taskId,
      route: decision.route,
      model: decision.model,
      records: result.records.map((r) => ({
        pass: r.grade.pass,
        error: r.error,
        costUsd: r.costUsd,
      })),
    }),
  );
  return result;
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href)
  await executeRoute({
    dir: resolve(process.argv[2] ?? "results/routing"),
    taskId: process.argv[3],
  });
