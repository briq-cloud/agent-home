import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { OpenRouter } from "@openrouter/sdk";
import { providerKey } from "./live.mjs";
import { mediumTasks } from "./medium.mjs";
const exec = promisify(execFile),
  here = fileURLToPath(new URL(".", import.meta.url));
export const profiles = [
  { id: "haiku", model: "anthropic/claude-haiku-5.5" },
  { id: "deepseek", model: "deepseek/deepseek-v4.1-flash-1017" },
  { id: "glm", model: "z-ai/glm-5.3" },
];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export async function compareModels() {
  const key = await providerKey(),
    root = resolve(process.env.BENCH_RESULTS ?? join(here, "results", `models-${Date.now()}`));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const catalog = await (
    await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15000) })
  ).json();
  const cards = profiles.map((p) => {
    const m = catalog.data.find((m) => m.id === p.model);
    if (!m) throw Error("catalog model missing");
    return {
      ...p,
      canonical: m.canonical_slug,
      context: m.context_length,
      pricing: m.pricing,
      description: m.description?.slice(0, 450),
    };
  });
  const result = {
    startedAt: new Date().toISOString(),
    budgetTargetUsd: Number(process.env.BENCH_COMPARISON_BUDGET_USD ?? 2),
    protocol:
      "Same Claude ACP harness; baseline context; 180s and 24 generation requests per task; 8192 output tokens per request. Profiles, not intrinsic model intelligence.",
    profiles: cards,
    tasks: mediumTasks.map((t) => ({
      id: t.id,
      prompt: t.prompt,
      files: Object.keys(t.files).length,
      sourceBytes: Object.values(t.files).reduce((n, s) => n + Buffer.byteLength(s), 0),
    })),
    routing: [],
    runs: [],
    spentUsd: 0,
    stopped: null,
  };
  const save = async () =>
    writeFile(join(root, "comparison.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  const sdk = new OpenRouter({
    apiKey: key,
    serverURL: "https://openrouter.ai",
    retryConfig: { strategy: "none" },
  });
  // Freeze prospective choices before executing any task. No observed task outcomes are supplied.
  for (const chooser of ["cloudflare/clef-flash", "typesafe/jev-1.14-20261014"])
    for (const task of mediumTasks) {
      const started = performance.now();
      try {
        const reply = await sdk.alpha.decisions.create(
          {
            decisionsRequest: {
              model: chooser,
              state: {
                task: task.prompt,
                limits: { seconds: 180, outputTokensPerRequest: 8192 },
                profiles: cards.map(({ id, model, context, pricing, description }) => ({
                  id,
                  model,
                  context,
                  pricing: {
                    inputPerToken: pricing.prompt,
                    outputPerToken: pricing.completion,
                    cachedInputPerToken: pricing.input_cache_read,
                  },
                  description,
                  vendorDescriptionNotMeasured: true,
                })),
                measuredQualityHistory: "No prior measured results for these larger tasks.",
              },
              questions: {
                route: {
                  type: "choice",
                  instructions:
                    "Select the execution profile likely to complete this task correctly at lowest total cost within the limits. Use abstain if the evidence does not distinguish the profiles. Vendor descriptions are claims, not measured task quality.",
                  criteria: {
                    haiku: "Claude Haiku 5.5 through the Claude ACP harness and Anthropic backend.",
                    deepseek:
                      "DeepSeek V4.1 Flash through the same Claude ACP harness and OpenRouter compatibility endpoint.",
                    glm: "GLM 5.3 through the same Claude ACP harness and OpenRouter compatibility endpoint.",
                    abstain:
                      "Insufficient evidence to select a model; deterministic fallback is haiku.",
                  },
                },
              },
            },
          },
          { timeoutMs: 15000, retries: { strategy: "none" } },
        );
        const choice = reply.answers?.route,
          cost = reply.usage?.cost;
        if (
          choice?.type !== "choice" ||
          !["haiku", "deepseek", "glm", "abstain"].includes(choice.choice) ||
          typeof cost !== "number" ||
          cost < 0
        )
          throw Error("invalid decision");
        result.spentUsd += cost;
        result.routing.push({
          chooser,
          actualModel: reply.model,
          taskId: task.id,
          choice: choice.choice,
          probabilities: choice.probabilities,
          costUsd: cost,
          ms: performance.now() - started,
          recordedAt: new Date().toISOString(),
        });
      } catch {
        result.stopped = "decision measurement incomplete";
        await save();
        throw Error(result.stopped);
      }
    }
  result.routingFrozenAt = new Date().toISOString();
  await save();
  await writeFile(
    join(root, "routing-frozen.json"),
    JSON.stringify(
      { routingFrozenAt: result.routingFrozenAt, routing: result.routing, profiles: cards },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  // Latin-square order: each profile occurs first, second and third once.
  for (let ti = 0; ti < mediumTasks.length && !result.stopped; ti++)
    for (let mi = 0; mi < profiles.length; mi++) {
      const profile = profiles[(mi + ti) % profiles.length],
        task = mediumTasks[ti],
        remaining = result.budgetTargetUsd - result.spentUsd;
      if (remaining < 0.25) {
        result.stopped = "remaining budget below admission allowance";
        break;
      }
      const runRoot = join(root, `${task.id}-${profile.id}`);
      let childError = null;
      try {
        await exec(process.execPath, ["cli.mjs", "live"], {
          cwd: here,
          env: {
            ...process.env,
            BENCH_RESULTS: runRoot,
            BENCH_MODEL: profile.model,
            BENCH_SUITE: "medium",
            BENCH_TASK_IDS: task.id,
            BENCH_ARMS: "baseline",
            BENCH_BUDGET_USD: String(remaining),
          },
          timeout: 400000,
          maxBuffer: 1000000,
        });
      } catch (e) {
        childError = e.killed ? "runner-timeout" : "runner-exit";
      }
      let measured;
      try {
        measured = JSON.parse(await readFile(join(runRoot, "results.json"), "utf8")).records[0];
      } catch {
        result.stopped = "execution measurement unavailable";
        await save();
        break;
      }
      if (!measured) {
        result.stopped = "execution measurement unavailable";
        await save();
        break;
      }
      result.runs.push({
        profile: profile.id,
        requestedModel: profile.model,
        order: result.runs.length,
        childError,
        ...measured,
      });
      if (measured.costUsd === null) {
        result.stopped = "unknown execution cost";
        await save();
        break;
      }
      result.spentUsd += measured.costUsd;
      await save();
      console.log(
        JSON.stringify({
          task: task.id,
          profile: profile.id,
          pass: measured.grade.pass,
          error: measured.error,
          costUsd: measured.costUsd,
          seconds: measured.totalMs / 1000,
          spentUsd: result.spentUsd,
        }),
      );
    }
  result.finishedAt = new Date().toISOString();
  await save();
  await writeComparisonReport(root, result);
  console.log(
    JSON.stringify({
      root,
      completed: result.runs.length,
      spentUsd: result.spentUsd,
      stopped: result.stopped,
    }),
  );
  if (result.stopped || result.runs.length !== 9) process.exitCode = 1;
  return result;
}
export function profileSummary(result) {
  return result.profiles.map((profile) => {
    const rows = result.runs.filter((r) => r.profile === profile.id),
      passed = rows.filter((r) => r.grade.pass && !r.error).length;
    const costUsd =
      !rows.length || rows.some((r) => r.costUsd === null)
        ? null
        : rows.reduce((n, r) => n + r.costUsd, 0);
    return {
      profile: profile.id,
      attempts: rows.length,
      passed,
      costUsd,
      costPerAcceptedUsd: passed && costUsd !== null ? costUsd / passed : null,
      totalMs: rows.reduce((n, r) => n + r.totalMs, 0),
    };
  });
}
export async function writeComparisonReport(root, result) {
  const summaryRows = profileSummary(result)
    .map(
      (s) =>
        `<tr><td>${esc(s.profile)}</td><td>${s.passed}/${s.attempts}</td><td>${s.costUsd === null ? "unknown" : "$" + s.costUsd.toFixed(6)}</td><td>${s.costPerAcceptedUsd === null ? "undefined" : "$" + s.costPerAcceptedUsd.toFixed(6)}</td><td>${(s.totalMs / 1000).toFixed(1)} s</td></tr>`,
    )
    .join("");
  const rows = result.runs
    .map(
      (r) =>
        `<tr><td>${esc(r.taskId)}</td><td>${esc(r.profile)}</td><td>${r.grade.pass && !r.error ? "PASS" : "FAIL"}</td><td>${r.costUsd === null ? "unknown" : "$" + r.costUsd.toFixed(6)}</td><td>${(r.totalMs / 1000).toFixed(1)} s</td><td>${r.toolCalls ?? "—"}</td><td>${esc(r.error ?? r.grade.reason ?? "")}</td></tr>`,
    )
    .join("");
  const routing = result.routing
    .map((d) => {
      const chosen = d.choice === "abstain" ? "haiku" : d.choice,
        r = result.runs.find((r) => r.taskId === d.taskId && r.profile === chosen),
        passing = result.runs
          .filter((r) => r.taskId === d.taskId && r.grade.pass && !r.error && r.costUsd !== null)
          .sort((a, b) => a.costUsd - b.costUsd);
      return `<tr><td>${esc(d.chooser)}</td><td>${esc(d.taskId)}</td><td>${esc(d.choice)}</td><td>${r ? (r.grade.pass && !r.error ? "PASS" : "FAIL") : "not measured"}</td><td>${r?.costUsd != null ? "$" + (r.costUsd + d.costUsd).toFixed(6) : "unknown"}</td><td>${passing[0] ? esc(passing[0].profile) : "none measured"}</td></tr>`;
    })
    .join("");
  await writeFile(
    join(root, "report.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Larger tasks — model comparison</title><style>body{font:16px/1.6 system-ui;background:#f4f3ed;color:#20382d;max-width:1150px;margin:40px auto;padding:20px}table{border-collapse:collapse;width:100%;background:#fffef9}td,th{padding:11px;border-bottom:1px solid #d8dfd4;text-align:left}section{overflow:auto}code{font-size:13px}small{color:#52695b}</style><h1>Larger tasks: three execution profiles</h1><p>${result.runs.length}/9 executions. Total measured inference: $${result.spentUsd.toFixed(6)}. Stop: ${esc(result.stopped ?? "completed")}.</p><p>Same Claude ACP harness, baseline context, 180 seconds and 24 generation requests per task, 8192 output tokens per request. One attempt each, fresh sessions/workspaces, Latin-square model order. These are model/harness/provider profiles, not a neutral ranking of model intelligence. Compatibility failures and budget limits can affect results.</p><section><table><tr><th>Profile</th><th>Accepted</th><th>All attempt costs</th><th>Cost per accepted task</th><th>All task time</th></tr>${summaryRows}</table></section><h2>Per-task observations</h2><section><table><tr><th>Task</th><th>Profile</th><th>Acceptance</th><th>Cost</th><th>Task time</th><th>Tool calls</th><th>Failure</th></tr>${rows}</table></section><h2>Prospective routing choices, replayed after execution</h2><p>Choices were frozen at ${esc(result.routingFrozenAt)} before any larger-task execution. Only task and catalog metadata were provided. Abstention uses the fixed Haiku fallback. No outcomes were supplied to the classifier. Costs below include each decision call. The cheapest passing profile is an observed single-attempt oracle, not a guarantee.</p><section><table><tr><th>Decision model</th><th>Task</th><th>Choice</th><th>Observed outcome</th><th>Execution + decision cost</th><th>Cheapest passing profile</th></tr>${routing}</table></section><p><a href="comparison.json">Raw results</a> · <a href="routing-frozen.json">Frozen routing decisions</a></p><p>Provider-cache state was not reset. Reported task time includes admission waits if reservations reach the budget; billing reconciliation after execution is excluded. Unknown costs remain unknown. Acceptance checks run outside the agent workspace. No general chat-model judge was used.</p></html>`,
  );
}
if (import.meta.url === new URL(process.argv[1], "file:").href) await compareModels();
