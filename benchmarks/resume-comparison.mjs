import assert from "node:assert/strict";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { providerKey } from "./live.mjs";
import { mediumTasks } from "./medium.mjs";
import { profiles, writeComparisonReport } from "./compare-models.mjs";

const exec = promisify(execFile),
  here = fileURLToPath(new URL(".", import.meta.url));
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const known = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
async function backup(path) {
  try {
    await copyFile(path, path + ".provisional", 1);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
/** Accounting only. Never issues a completion, repeats a task, or turns missing billing into zero. */
export async function reconcileRecords(
  records,
  { key, fetcher = fetch, now = () => new Date().toISOString() },
) {
  for (const record of records) {
    if (known(record.costUsd)) continue;
    assert(
      Array.isArray(record.generations) && record.generations.length,
      "missing generation ledger",
    );
    for (const generation of record.generations) {
      if (known(generation.costUsd)) continue;
      assert(
        typeof generation.generationId === "string" && generation.generationId.startsWith("gen-"),
        "missing generation ID",
      );
      const response = await fetcher(
        "https://openrouter.ai/api/v1/generation?id=" + encodeURIComponent(generation.generationId),
        { headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(5000) },
      );
      if ([401, 402, 403].includes(response.status))
        throw Error("billing lookup unauthorized or unavailable");
      const data = (await response.json()).data;
      if (!response.ok || !known(data?.total_cost)) continue;
      Object.assign(generation, {
        costUsd: data.total_cost,
        costSource: "openrouter-generation-total_cost",
        provider: data.provider_name,
        actualModel: data.model,
        lateBillingReconciledAt: now(),
      });
    }
    record.costUsd = record.generations.every((g) => known(g.costUsd))
      ? record.generations.reduce((n, g) => n + g.costUsd, 0)
      : null;
    record.billingPending = record.costUsd === null;
    if (!record.billingPending) record.billingFinalizedAt = now();
  }
  return records.every((record) => known(record.costUsd));
}

export async function resumeComparison({
  root: requestedRoot,
  key: providedKey,
  fetcher = fetch,
  executeTrial = exec,
} = {}) {
  const root = resolve(requestedRoot ?? process.env.BENCH_RESULTS ?? ""),
    key = providedKey ?? (await providerKey());
  assert(
    requestedRoot ?? process.env.BENCH_RESULTS,
    "BENCH_RESULTS must identify the existing comparison",
  );
  const path = join(root, "comparison.json"),
    result = await json(path),
    frozen = await json(join(root, "routing-frozen.json"));
  assert.equal(result.routingFrozenAt, frozen.routingFrozenAt);
  assert.deepEqual(result.routing, frozen.routing, "frozen decisions changed");
  assert.deepEqual(result.profiles, frozen.profiles, "frozen profiles changed");
  assert.deepEqual(
    result.profiles.map((p) => ({ id: p.id, model: p.model })),
    profiles,
    "profile matrix changed",
  );
  assert.deepEqual(
    result.tasks,
    mediumTasks.map((t) => ({
      id: t.id,
      prompt: t.prompt,
      files: Object.keys(t.files).length,
      sourceBytes: Object.values(t.files).reduce((n, s) => n + Buffer.byteLength(s), 0),
    })),
    "task suite changed",
  );
  const catalogResponse = await fetcher("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(15000),
  });
  assert(catalogResponse.ok, "catalog unavailable");
  const catalog = await catalogResponse.json();
  for (const p of result.profiles)
    assert.equal(
      catalog.data.find((m) => m.id === p.model)?.canonical_slug,
      p.canonical,
      "model version changed",
    );
  assert(known(result.budgetTargetUsd) && result.budgetTargetUsd > 0, "invalid original budget");
  assert(
    result.routing.every((d) => known(d.costUsd)),
    "decision cost unknown",
  );
  assert(!result.untrackedTrial, "untracked interrupted trial requires manual reconciliation");
  await backup(path);
  const save = async () => {
    result.spentUsd =
      result.routing.reduce((n, d) => n + d.costUsd, 0) +
      result.runs.reduce((n, r) => n + (known(r.costUsd) ? r.costUsd : 0), 0);
    result.unknownCosts =
      result.runs.filter((r) => !known(r.costUsd)).length + (result.untrackedTrial ? 1 : 0);
    await writeFile(path, JSON.stringify(result, null, 2), { mode: 0o600 });
    await writeComparisonReport(root, result);
  };
  const seen = new Set();
  for (const run of result.runs) {
    const id = run.taskId + "|" + run.profile;
    assert(!seen.has(id), "duplicate prior execution");
    seen.add(id);
    if (known(run.costUsd)) continue;
    const runPath = join(root, run.taskId + "-" + run.profile, "results.json"),
      measured = await json(runPath);
    assert.equal(measured.records.length, 1);
    const record = measured.records[0];
    assert.equal(record.taskId, run.taskId);
    assert.equal(record.arm, "baseline");
    await backup(runPath);
    await reconcileRecords([record], { key, fetcher });
    Object.assign(run, record);
    await writeFile(runPath, JSON.stringify(measured, null, 2), { mode: 0o600 });
  }
  await save();
  assert(result.unknownCosts === 0, "billing is still pending; no more paid work admitted");
  result.stopped = null;
  result.resumedAt = new Date().toISOString();
  await save();
  for (let ti = 0; ti < mediumTasks.length && !result.stopped; ti++)
    for (let mi = 0; mi < profiles.length; mi++) {
      const task = mediumTasks[ti],
        profile = profiles[(mi + ti) % profiles.length],
        id = task.id + "|" + profile.id;
      if (seen.has(id)) continue;
      const remaining = result.budgetTargetUsd - result.spentUsd;
      if (remaining < 0.25) {
        result.stopped = "remaining budget below admission allowance";
        break;
      }
      const runRoot = join(root, task.id + "-" + profile.id);
      let childError = null;
      // Refuse an untracked trial directory: it may contain a charge-bearing interrupted attempt.
      try {
        await readFile(join(runRoot, "model-snapshot.json"));
        throw Error("untracked existing trial; reconcile manually");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      try {
        await executeTrial(process.execPath, ["cli.mjs", "live"], {
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
      } catch (error) {
        childError = error.killed ? "runner-timeout" : "runner-exit";
      }
      let measured;
      try {
        measured = await json(join(runRoot, "results.json"));
      } catch {
        result.stopped = "execution measurement unavailable";
        result.untrackedTrial = { taskId: task.id, profile: profile.id, childError, costUsd: null };
        await save();
        return result;
      }
      assert.equal(measured.records.length, 1);
      const record = measured.records[0];
      assert.equal(record.taskId, task.id);
      assert.equal(record.arm, "baseline");
      if (!known(record.costUsd)) await reconcileRecords([record], { key, fetcher });
      result.runs.push({
        profile: profile.id,
        requestedModel: profile.model,
        order: result.runs.length,
        childError,
        ...record,
      });
      seen.add(id);
      if (!known(record.costUsd)) result.stopped = "unknown execution cost";
      await save();
      console.log(
        JSON.stringify({
          task: task.id,
          profile: profile.id,
          pass: record.grade.pass,
          error: record.error,
          costUsd: record.costUsd,
          spentUsd: result.spentUsd,
        }),
      );
      if (result.stopped) break;
    }
  result.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      completed: result.runs.length,
      spentUsd: result.spentUsd,
      unknownCosts: result.unknownCosts,
      stopped: result.stopped,
    }),
  );
  return result;
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const r = await resumeComparison();
  if (r.stopped || r.runs.length !== 9) process.exitCode = 1;
}
