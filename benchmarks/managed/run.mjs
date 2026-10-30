import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  managedFixtures,
  factorialArms,
  discoveryArms,
  prepareManaged,
  fixtureHash,
} from "./fixtures.mjs";
import { ManagedMeter, mockManagedFetcher, decisionModels } from "./meter.mjs";
import { startManagedRuntime, preflightManagedRuntime } from "./runtime.mjs";
import { providerKey } from "../live.mjs";
const exec = promisify(execFile),
  here = fileURLToPath(new URL(".", import.meta.url));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const continuationAuthority = Symbol("validated continuation");
const defaultLimits = {
  timeoutMs: 180_000,
  perTrialUsd: 0.2,
  maxCallsPerTrial: 20,
  maxOutputTokens: 4096,
};
const coreSources = [
  "src/orchestration/engine.ts",
  "src/orchestration/delegation.ts",
  "src/context/store.ts",
  "src/routing/index.ts",
  "src/app/services.ts",
];
async function sourceSnapshot(runnerSource) {
  const files = [
    "fixtures.mjs",
    "grade-worker.mjs",
    "meter.mjs",
    "entry.mjs",
    "runtime.mjs",
    "run.mjs",
    "mock-agent.mjs",
    "../meter.mjs",
  ];
  const snapshot = Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, hash(await readFile(join(here, file)))])),
  );
  for (const file of coreSources)
    snapshot[`runner/${file}`] = hash(await readFile(join(runnerSource, file)));
  return snapshot;
}
function validLimits(value) {
  return (
    value &&
    Object.keys(value).sort().join() === Object.keys(defaultLimits).sort().join() &&
    Number.isSafeInteger(value.timeoutMs) &&
    value.timeoutMs >= 1000 &&
    value.timeoutMs <= 300_000 &&
    Number.isFinite(value.perTrialUsd) &&
    value.perTrialUsd > 0 &&
    value.maxCallsPerTrial === 20 &&
    value.maxOutputTokens === 4096
  );
}
function refreshEligibility(trial, profiles = []) {
  const execution = (trial.generations ?? []).filter((record) => record.kind === "execution");
  trial.modelsPinned =
    execution.length > 0 &&
    execution.every((record) => {
      if (typeof record.model !== "string" || typeof record.actualModel !== "string") return false;
      const profile = profiles.find(
        (profile) =>
          profile.model === record.model && (!record.profile || profile.id === record.profile),
      );
      return (
        (!profiles.length || !!profile) &&
        record.actualModel === (profile?.canonical ?? record.model)
      );
    });
  trial.comparisonEligible =
    trial.taskStatus === "succeeded" &&
    !!trial.grade?.pass &&
    !!trial.featuresExercised &&
    !!trial.graderUnchanged &&
    trial.modelsPinned &&
    trial.costUsd !== null;
}
export const managedProfiles = [
  { id: "bench-haiku", model: "anthropic/claude-haiku-5.5" },
  { id: "bench-deepseek", model: "deepseek/deepseek-v4.1-flash-1017" },
];
export function selectArms(value) {
  const ids =
    value === "factorial"
      ? factorialArms.map((arm) => arm.id)
      : value
        ? value.split(",")
        : discoveryArms;
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !factorialArms.some((arm) => arm.id === id))
  )
    throw Error("invalid managed arm filter");
  return ids.map((id) => factorialArms.find((arm) => arm.id === id));
}
export function settledTotal(records) {
  return records.some((record) => !Number.isFinite(record.costUsd) || record.costUsd < 0)
    ? null
    : records.reduce((sum, record) => sum + record.costUsd, 0);
}
async function externalGrade(workspace, fixture, seed) {
  try {
    const result = await exec(
      process.execPath,
      [join(here, "grade-worker.mjs"), workspace, fixture.id, String(seed)],
      { timeout: 5000, maxBuffer: 16_384, env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" } },
    );
    return JSON.parse(result.stdout);
  } catch {
    return { pass: false, reason: "external-acceptance-failed-or-timed-out" };
  }
}
async function promptEvidence(runtime, task, output) {
  try {
    const session = await runtime.api("GET", `/artifacts/home/${task.sessionRef}`),
      ref = JSON.parse(session.content);
    const name = /^[A-Za-z0-9._-]{1,128}$/.test(ref.id) ? ref.id : hash(ref.id);
    const lines = (
      await readFile(join(runtime.stateDir, "sessions", ref.cli, `${name}.jsonl`), "utf8")
    )
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const prompt = lines
      .filter((line) => line.params?.update?.sessionUpdate === "user_message_chunk")
      .map((line) => line.params.update.content?.text ?? "")
      .join("\n");
    return {
      prompt,
      route: ref.route,
      verification: output?.verification?.status ?? "unavailable",
    };
  } catch {
    return { prompt: "", route: null, verification: "unavailable" };
  }
}
export function summarizeManaged(result) {
  return result.arms.map((arm) => {
    const trials = result.trials.filter((trial) => trial.arm === arm.id),
      accepted = trials.filter(
        (trial) => trial.grade?.pass && trial.taskStatus === "succeeded",
      ).length;
    const costUsd =
      trials.length && trials.every((trial) => trial.costUsd !== null && trial.phase === "complete")
        ? trials.reduce((sum, trial) => sum + trial.costUsd, 0)
        : null;
    return {
      arm: arm.id,
      attempts: trials.length,
      accepted,
      costUsd,
      costPerAcceptedUsd: accepted && costUsd !== null ? costUsd / accepted : null,
      exercised: trials.filter((trial) => trial.featuresExercised).length,
      totalMs: trials.reduce((sum, trial) => sum + (trial.totalMs ?? 0), 0),
    };
  });
}

export async function runManaged({
  mode = "mock",
  root = resolve(process.env.BENCH_RESULTS ?? join(here, "results", `${mode}-${Date.now()}`)),
  armFilter = process.env.BENCH_ARMS,
  taskFilter = process.env.BENCH_TASK_IDS,
  budgetUsd = Number(process.env.BENCH_BUDGET_USD ?? 2),
  timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 180_000),
  chooser = process.env.BENCH_CHOOSER ?? decisionModels[0],
  fixtureOffset = Number(process.env.BENCH_FIXTURE_OFFSET ?? 0),
  continuation,
} = {}) {
  if (continuation && continuation[continuationAuthority] !== true)
    throw Error("unvalidated continuation");
  const limits = continuation?.limits ?? {
    ...defaultLimits,
    timeoutMs,
    perTrialUsd: Number(process.env.BENCH_PER_TRIAL_USD ?? 0.2),
  };
  if (
    !["mock", "live"].includes(mode) ||
    !decisionModels.includes(chooser) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 300_000 ||
    !validLimits(limits) ||
    !Number.isSafeInteger(fixtureOffset) ||
    fixtureOffset < 0 ||
    fixtureOffset > 1000
  )
    throw Error("invalid managed benchmark options");
  const arms = selectArms(armFilter),
    requested = taskFilter?.split(","),
    fixtures = requested
      ? managedFixtures.filter((fixture) => requested.includes(fixture.id))
      : managedFixtures;
  if (!fixtures.length || (requested && fixtures.length !== requested.length))
    throw Error("invalid managed fixture filter");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await readFile(join(root, "results.json"));
    if (!continuation)
      throw Error(
        "results already exist; use settle or validated continue, never repeat paid trials",
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const runnerSource = resolve(process.env.BENCH_RUNNER_SOURCE ?? join(here, "../../runner"));
  const preflightPath = join(
    root,
    continuation ? `preflight-continuation-${continuation.id}.json` : "preflight.json",
  );
  let preflight;
  try {
    preflight = await preflightManagedRuntime({
      mode,
      runnerSource,
      profileHome: join(root, "preflight-api-profile"),
    });
    await writeFile(preflightPath, JSON.stringify(preflight, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch (error) {
    await writeFile(
      preflightPath,
      JSON.stringify({ status: "failed", error: error.message, modelCalls: 0 }, null, 2) + "\n",
      { mode: 0o600 },
    );
    throw error;
  }
  const key =
    continuation?.key ?? (mode === "live" ? await providerKey() : "mock-provider-no-real-key");
  let profiles = managedProfiles.map((profile) => ({
    ...profile,
    canonical: `${profile.model}-mock-canonical`,
  }));
  if (mode === "live") {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("model catalog unavailable");
    const catalog = await response.json();
    profiles = profiles.map((profile) => {
      const card = catalog.data.find((candidate) => candidate.id === profile.model);
      if (!card?.canonical_slug) throw Error("fixed execution model unavailable");
      return { ...profile, canonical: card.canonical_slug };
    });
    await writeFile(
      join(
        root,
        continuation
          ? `model-snapshot-continuation-${continuation.id}.json`
          : "model-snapshot.json",
      ),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          profiles: profiles.map((profile) => ({
            ...profile,
            catalog: catalog.data.find((card) => card.id === profile.model),
          })),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  if (continuation && JSON.stringify(profiles) !== JSON.stringify(continuation.result.profiles))
    throw Error("continuation model canonical identity changed");
  const sourceHashes = await sourceSnapshot(runnerSource);
  if (continuation && JSON.stringify(sourceHashes) !== JSON.stringify(continuation.currentHashes))
    throw Error("continuation source changed during admission");
  const graderBefore = hash(await readFile(join(here, "grade-worker.mjs"))),
    fixtureBefore = hash(await readFile(join(here, "fixtures.mjs")));
  const result = continuation?.result ?? {
    protocol: "managed-production-v1",
    mode,
    startedAt: new Date().toISOString(),
    budgetTargetUsd: budgetUsd,
    accounting:
      "All root/child/native retry execution generations + typed decision response usage.cost. Unknown costs stop new work. Admission target is not a hard provider spend cap.",
    arms,
    profiles,
    chooser,
    fixtureOffset,
    limits,
    sourceHashes,
    preflight,
    fixtures: fixtures.map((fixture) => ({
      id: fixture.id,
      version: fixture.version,
      sha256: fixtureHash(fixture),
    })),
    trials: [],
    stopped: null,
    limitations: [
      "Discovery is one attempt per case/arm, not statistical evidence or a neutral model ranking.",
      "Curated context is a source-injection upper bound, not retrieval quality.",
      "Memory facts are also available in every baseline workspace.",
      "Delegation is optional; no delegation claim when no child executes.",
      "Graders/gold stay outside source workspaces, but same-UID agents are not OS-isolated and can potentially inspect or modify external files.",
      "Provider cache state is not reset; mock runs prove plumbing only.",
    ],
  };
  const priorMetadata = [...(result.metadata ?? [])];
  if (continuation) {
    result.limits ??= limits;
    result.continuations ??= [];
    result.continuations.push({
      protocol: "managed-continuation-v1",
      id: continuation.id,
      startedAt: new Date().toISOString(),
      originalRunSha256: result.sourceHashes["run.mjs"],
      continuationRunSha256: sourceHashes["run.mjs"],
      sourceHashes,
      priorCostUsd: result.totalCostUsd,
      skippedTrialIds: result.trials.map((trial) => trial.id),
      originalBudgetUsd: budgetUsd,
      limits,
      legacyLimitsAttested: continuation.legacyLimitsAttested,
      originalRunSource: continuation.originalRunSource,
      preflight,
      previousStopped: result.stopped,
      previousFinishedAt: result.finishedAt,
      billingReconciliation: result.resume,
    });
    result.resume = {
      mode: "execution-continuation",
      protocol: "managed-continuation-v1",
      continuationId: continuation.id,
      observedAt: new Date().toISOString(),
      mayExecute: true,
      skippedTrialIds: result.trials.map((trial) => trial.id),
    };
    result.stopped = null;
  }
  const save = () =>
    writeFile(
      join(root, "results.json"),
      JSON.stringify({ ...result, summary: summarizeManaged(result) }, null, 2) + "\n",
      { mode: 0o600 },
    );
  const meter = new ManagedMeter({
    key,
    profiles,
    chooser,
    budgetUsd,
    perTrialUsd: limits.perTrialUsd,
    maxCallsPerTrial: limits.maxCallsPerTrial,
    maxOutputTokens: limits.maxOutputTokens,
    ...(mode === "mock" ? { fetcher: mockManagedFetcher(profiles) } : {}),
    onRecord: (record) =>
      appendFileSync(join(root, "meter.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 }),
  });
  if (continuation)
    meter.records.push(...structuredClone(result.trials.flatMap((trial) => trial.generations)));
  const relayUrl = await meter.start();
  let activeRuntime;
  const interrupt = async () => {
    result.stopped = "interrupted; settle existing generations only";
    await activeRuntime?.close();
    await save();
  };
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, interrupt);
  try {
    await save();
    for (let fi = 0; fi < fixtures.length && !result.stopped; fi++)
      for (let ai = 0; ai < arms.length && !result.stopped; ai++) {
        const fixture = fixtures[fi],
          arm = arms[(ai + fi + fixtureOffset) % arms.length],
          trialId = `${fixture.id}-${arm.id}`,
          trialRoot = join(root, trialId),
          workspace = join(trialRoot, "workspace"),
          seed = 17 + fi + fixtureOffset;
        if (result.trials.some((trial) => trial.id === trialId)) continue;
        const acceptance = {
          commands: [
            {
              argv: [
                process.execPath,
                join(here, "grade-worker.mjs"),
                workspace,
                fixture.id,
                String(seed),
              ],
              timeoutMs: 5000,
            },
          ],
          artifacts: [{ path: "CHANGELOG.md" }],
        };
        const trial = {
          id: trialId,
          rootTaskId: `bench-${randomUUID()}`,
          fixtureId: fixture.id,
          fixtureSha256: fixtureHash(fixture),
          fixtureVersion: fixture.version,
          arm: arm.id,
          order: result.trials.length,
          acceptanceSha256: hash(
            JSON.stringify({ fixtureId: fixture.id, seed, graderBefore, fixtureBefore }),
          ),
          phase: "intent-recorded",
          recordedAt: new Date().toISOString(),
          costUsd: null,
          generations: [],
          grade: { pass: false, reason: "not-executed" },
        };
        result.trials.push(trial);
        await save(); // Checkpoint intent before infrastructure or any paid request.
        if (meter.blocked || meter.spent + 0.2 > budgetUsd) {
          result.stopped = "remaining admission allowance exhausted";
          trial.phase = "not-admitted";
          await save();
          break;
        }
        const ledgerStart = meter.records.length,
          started = performance.now();
        let runtime,
          task,
          output,
          evidence,
          tasks = [];
        try {
          await mkdir(workspace, { recursive: true, mode: 0o700 });
          await prepareManaged(workspace, fixture);
          meter.begin({ trialId, fixtureId: fixture.id, arm: arm.id });
          trial.phase = "infrastructure-starting";
          await save();
          runtime = activeRuntime = await startManagedRuntime({
            root: trialRoot,
            workspace,
            arm,
            profiles,
            meter,
            relayUrl,
            fixtureId: fixture.id,
            mode,
            runnerSource,
          });
          const revision = fixtureHash(fixture);
          await runtime.api("PUT", "/projects/home", { root: workspace, revision });
          if (arm.memory) {
            const source = await runtime.api("PUT", "/context/source", {
              project: "home",
              revision,
              path: fixture.memory.source,
              content: fixture.files[fixture.memory.source],
            });
            await runtime.api("PUT", "/memories", {
              project: "home",
              key: "operator-policy",
              text: fixture.memory.text,
              source: { path: source.path, hash: source.hash, revision },
            });
          }
          trial.phase = "submitting";
          await save();
          await runtime.api("POST", "/tasks", {
            id: trial.rootTaskId,
            projectId: "home",
            prompt: `Work only inside this project. Do not access credentials, other folders, or the network.\n${fixture.prompt}`,
            route: arm.auto
              ? { mode: "auto" }
              : { mode: "explicit", agentId: profiles[0].id, model: profiles[0].model },
            maxAttempts: 1,
            maxRuntimeMs: timeoutMs,
            deadline: Date.now() + timeoutMs,
            allowPaidApi: true,
            maxEstimatedUsd: 0.2,
            decisionBudgetUsd: 0.01,
            acceptance,
            ...(arm.context || arm.memory
              ? {
                  context: {
                    revision,
                    ...(arm.context ? { paths: fixture.refs } : {}),
                    ...(arm.memory ? { memoryQuery: fixture.memory.query } : {}),
                  },
                }
              : {}),
          });
          trial.phase = "executing";
          await save();
          const deadline = Date.now() + timeoutMs + 5000;
          while (Date.now() < deadline) {
            tasks = (await runtime.api("GET", "/tasks?projectId=home")).tasks;
            task = tasks.find((value) => value.id === trial.rootTaskId);
            for (const running of tasks.filter((value) => value.status === "running")) {
              const pending = (await runtime.api("GET", `/tasks/${running.id}/permissions`))
                .permissions;
              for (const permission of pending) {
                const option = permission.params?.options?.find(
                  (value) => value.kind === "allow_once",
                );
                if (!option) throw Error("benchmark permission has no bounded allow_once option");
                await runtime.api(
                  "POST",
                  `/tasks/${running.id}/permissions/${permission.requestId}`,
                  { optionId: option.optionId },
                );
                trial.permissionAnswers = (trial.permissionAnswers ?? 0) + 1;
              }
            }
            if (task && !["queued", "running"].includes(task.status)) break;
            await pause(100);
          }
          if (!task || ["queued", "running"].includes(task.status)) {
            await runtime.api("POST", `/tasks/${trial.rootTaskId}/cancel`, {});
            throw Error("managed trial deadline");
          }
          trial.totalMs = performance.now() - started;
          trial.taskStatus = task.status;
          trial.attempts = task.attempts;
          trial.backendReportedCostMicros = task.costMicros;
          if (task.outputRef)
            output = JSON.parse(
              (await runtime.api("GET", `/artifacts/home/${task.outputRef}`)).content,
            );
          evidence = await promptEvidence(runtime, task, output);
          trial.route = evidence.route;
          trial.verification = output?.verification ?? { status: "unavailable" };
          trial.taskTree = tasks.map(({ id, parentId, status, attempts, route }) => ({
            id,
            parentId,
            status,
            attempts,
            route,
          }));
        } catch (error) {
          trial.error = error.message.slice(0, 300);
          trial.totalMs ??= performance.now() - started;
        } finally {
          await runtime?.close();
          activeRuntime = undefined;
          await meter.end();
        }
        trial.grade = await externalGrade(workspace, fixture, seed);
        trial.graderUnchanged =
          graderBefore === hash(await readFile(join(here, "grade-worker.mjs"))) &&
          fixtureBefore === hash(await readFile(join(here, "fixtures.mjs")));
        if (!trial.graderUnchanged) {
          trial.grade = { pass: false, reason: "grader-or-gold-changed" };
          result.stopped = "grader integrity changed";
        }
        const prompt = evidence?.prompt ?? "",
          children = tasks.filter((value) => value.parentId === trial.rootTaskId);
        trial.featureEvidence = {
          context: {
            requested: arm.context,
            injected: fixture.refs.every((path) => prompt.includes(hash(fixture.files[path]))),
          },
          memory: {
            requested: arm.memory,
            injected:
              prompt.includes(fixture.memory.text) && /"sourceCurrent"\s*:\s*true/.test(prompt),
          },
          auto: { requested: arm.auto, dispatched: evidence?.route?.source === "decision" },
          delegation: {
            enabled: arm.delegation,
            childAttempts: children.reduce((sum, child) => sum + child.attempts, 0),
            children: children.length,
          },
        };
        trial.featuresExercised =
          (!arm.context || trial.featureEvidence.context.injected) &&
          (!arm.memory || trial.featureEvidence.memory.injected) &&
          (!arm.auto || trial.featureEvidence.auto.dispatched) &&
          (!arm.delegation || trial.featureEvidence.delegation.childAttempts > 0);
        const accounting = performance.now();
        await meter.settle();
        trial.generations = meter.records.slice(ledgerStart);
        trial.costUsd = settledTotal(trial.generations);
        trial.accountingWaitMs = performance.now() - accounting;
        trial.telemetryIncomplete =
          !!task?.attempts && !trial.generations.some((record) => record.kind === "execution");
        if (trial.telemetryIncomplete) trial.costUsd = null;
        trial.phase = !runtime ? "infrastructure-failed" : "complete";
        trial.costProvenance =
          mode === "mock"
            ? "synthetic-provider-ledger-no-model-calls"
            : "execution-generation-total_cost-plus-typed-decision-usage.cost";
        refreshEligibility(trial, profiles);
        if (trial.costUsd === null)
          result.stopped = "unknown total cost; settle existing generation IDs only";
        if (!runtime) result.stopped ??= "infrastructure failed; no automatic trial replay";
        await save();
        console.log(
          JSON.stringify({
            trial: trialId,
            pass: trial.grade.pass,
            status: trial.taskStatus,
            featuresExercised: trial.featuresExercised,
            costUsd: trial.costUsd,
            stopped: result.stopped,
          }),
        );
      }
    result.finishedAt = new Date().toISOString();
    result.metadata = [...priorMetadata, ...meter.metadata];
    result.totalCostUsd = result.trials.some((trial) => trial.telemetryIncomplete)
      ? null
      : settledTotal(meter.records);
    result.summary = summarizeManaged(result);
    await save();
    return { root, ...result };
  } finally {
    for (const signal of ["SIGTERM", "SIGINT"]) process.removeListener(signal, interrupt);
    await activeRuntime?.close();
    await meter.close();
  }
}

/** Billing-only recovery. It never starts a runner, chooses a route or repeats a
 * completed/uncertain trial. Missing request IDs remain unknown and blocked. */
export async function settleManaged(root, { fetcher = fetch, key, save = true } = {}) {
  const result = JSON.parse(await readFile(join(root, "results.json"), "utf8"));
  const records = new Map(
    result.trials
      .flatMap((trial) => trial.generations ?? [])
      .filter((record) => record.managedRequestId)
      .map((record) => [record.managedRequestId, record]),
  );
  let ledger = "";
  try {
    ledger = await readFile(join(root, "meter.jsonl"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let untracked = false;
  for (const line of ledger.split("\n").filter(Boolean)) {
    const record = JSON.parse(line);
    if (!record.managedRequestId) {
      untracked = true;
      continue;
    }
    const previous = records.get(record.managedRequestId);
    records.set(
      record.managedRequestId,
      previous && Number.isFinite(previous.costUsd) && record.costUsd === null
        ? { ...record, ...previous }
        : record,
    );
  }
  for (const record of records.values())
    if (
      record.kind === "execution" &&
      record.generationId?.startsWith("gen-") &&
      (record.costUsd === null || typeof record.actualModel !== "string")
    ) {
      try {
        const response = await fetcher(
          `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(record.generationId)}`,
          { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) },
        );
        const value = (await response.json()).data;
        if (
          response.ok &&
          typeof value?.total_cost === "number" &&
          Number.isFinite(value.total_cost) &&
          value.total_cost >= 0
        ) {
          if (record.costUsd === null) record.costUsd = value.total_cost;
          record.costSource = "openrouter-generation-total_cost";
          record.provider = value.provider_name;
          record.actualModel = value.model;
          record.providerMs = value.generation_time;
          record.nativeTokens = {
            input: value.native_tokens_prompt,
            output: value.native_tokens_completion,
            cached: value.native_tokens_cached,
          };
        }
      } catch {
        /* Missing billing stays unknown, never zero. */
      }
    }
  for (const trial of result.trials) {
    trial.generations = [...records.values()].filter((record) => record.trialId === trial.id);
    trial.costUsd =
      trial.telemetryIncomplete ||
      untracked ||
      !["complete", "infrastructure-failed", "not-admitted"].includes(trial.phase)
        ? null
        : settledTotal(trial.generations);
    refreshEligibility(trial, result.profiles);
  }
  result.resume = {
    mode: "billing-only",
    observedAt: new Date().toISOString(),
    newPaidRequests: 0,
    mayExecute: false,
  };
  const trialIds = new Set(result.trials.map((trial) => trial.id));
  const orphanedRecords = [...records.values()].some((record) => !trialIds.has(record.trialId));
  result.reconciliation = { untrackedRecords: untracked, orphanedRecords };
  result.totalCostUsd =
    untracked || orphanedRecords || result.trials.some((trial) => trial.costUsd === null)
      ? null
      : settledTotal([...records.values()]);
  result.summary = summarizeManaged(result);
  if (save)
    await writeFile(join(root, "results.json"), JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
  return result;
}

/** Continue only never-started plan entries. A settled terminal attempt is never
 * replayed, including failures. Old source identities remain the authority;
 * only this resume driver may differ, with its original bytes attested. */
export async function continueManaged(
  root,
  {
    key,
    fetcher = fetch,
    originalRunSource = process.env.BENCH_ORIGINAL_RUN_SOURCE,
    legacyLimits = process.env.BENCH_LEGACY_LIMITS_JSON
      ? JSON.parse(process.env.BENCH_LEGACY_LIMITS_JSON)
      : undefined,
  } = {},
) {
  root = resolve(root);
  const lockPath = join(root, "continuation.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(() => {
    throw Error("continuation lock exists; inspect the existing process before removing it");
  });
  try {
    const original = JSON.parse(await readFile(join(root, "results.json"), "utf8"));
    if (
      original.protocol !== "managed-production-v1" ||
      !["mock", "live"].includes(original.mode) ||
      !Number.isFinite(original.budgetTargetUsd) ||
      original.budgetTargetUsd <= 0 ||
      !decisionModels.includes(original.chooser)
    )
      throw Error("invalid original continuation plan");
    if (
      process.env.BENCH_BUDGET_USD !== undefined &&
      Number(process.env.BENCH_BUDGET_USD) !== original.budgetTargetUsd
    )
      throw Error("original continuation budget is immutable");
    if (process.env.BENCH_CHOOSER !== undefined && process.env.BENCH_CHOOSER !== original.chooser)
      throw Error("original continuation chooser is immutable");
    const arms = selectArms(original.arms?.map((arm) => arm.id).join(","));
    if (JSON.stringify(arms) !== JSON.stringify(original.arms))
      throw Error("original continuation arm plan changed");
    if (
      process.env.BENCH_ARMS &&
      JSON.stringify(selectArms(process.env.BENCH_ARMS)) !== JSON.stringify(arms)
    )
      throw Error("original continuation arm plan is immutable");
    const fixtures = original.fixtures?.map((saved) =>
      managedFixtures.find((fixture) => fixture.id === saved.id),
    );
    if (
      !fixtures?.length ||
      fixtures.some(
        (fixture, index) =>
          !fixture ||
          fixture.version !== original.fixtures[index].version ||
          fixtureHash(fixture) !== original.fixtures[index].sha256,
      ) ||
      new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length
    )
      throw Error("original continuation fixture identity changed");
    if (
      process.env.BENCH_TASK_IDS &&
      process.env.BENCH_TASK_IDS !== fixtures.map((fixture) => fixture.id).join(",")
    )
      throw Error("original continuation fixture plan is immutable");
    const profileIdentities = original.profiles?.map(({ id, model }) => ({ id, model }));
    if (
      JSON.stringify(profileIdentities) !== JSON.stringify(managedProfiles) ||
      original.profiles.some(
        (profile) => typeof profile.canonical !== "string" || !profile.canonical,
      )
    )
      throw Error("original continuation model plan changed");
    const runnerSource = resolve(process.env.BENCH_RUNNER_SOURCE ?? join(here, "../../runner"));
    const currentHashes = await sourceSnapshot(runnerSource);
    if (
      !original.sourceHashes ||
      Object.keys(currentHashes).sort().join() !== Object.keys(original.sourceHashes).sort().join()
    )
      throw Error("original continuation source manifest changed");
    for (const [file, digest] of Object.entries(currentHashes)) {
      if (file !== "run.mjs" && digest !== original.sourceHashes[file])
        throw Error(`continuation source identity changed: ${file}`);
    }
    if (
      currentHashes["run.mjs"] !== original.sourceHashes["run.mjs"] &&
      (!originalRunSource ||
        hash(await readFile(originalRunSource)) !== original.sourceHashes["run.mjs"])
    )
      throw Error("changed continuation driver requires matching original run.mjs bytes");
    const limits = original.limits ?? legacyLimits;
    if (!validLimits(limits))
      throw Error(
        "continuation requires explicit valid original limits (legacy attestation when absent)",
      );
    if (
      original.limits &&
      legacyLimits &&
      JSON.stringify(original.limits) !== JSON.stringify(legacyLimits)
    )
      throw Error("original continuation limits are immutable");
    if (
      (process.env.BENCH_TIMEOUT_MS !== undefined &&
        Number(process.env.BENCH_TIMEOUT_MS) !== limits.timeoutMs) ||
      (process.env.BENCH_PER_TRIAL_USD !== undefined &&
        Number(process.env.BENCH_PER_TRIAL_USD) !== limits.perTrialUsd)
    )
      throw Error("original continuation limits are immutable");
    const fixtureOffset = original.fixtureOffset ?? 0;
    if (
      !Number.isSafeInteger(fixtureOffset) ||
      fixtureOffset < 0 ||
      fixtureOffset > 1000 ||
      (process.env.BENCH_FIXTURE_OFFSET !== undefined &&
        Number(process.env.BENCH_FIXTURE_OFFSET) !== fixtureOffset)
    )
      throw Error("original continuation fixture offset is immutable");
    const planned = fixtures.flatMap((fixture, fi) =>
      arms.map((_, ai) => ({
        fixture,
        arm: arms[(ai + fi + fixtureOffset) % arms.length],
        seed: 17 + fi + fixtureOffset,
      })),
    );
    if (
      !Array.isArray(original.trials) ||
      original.trials.length > planned.length ||
      /interrupted|integrity changed|infrastructure failed/.test(original.stopped ?? "")
    )
      throw Error("uncertain or interrupted experiment cannot continue");
    for (let index = 0; index < original.trials.length; index++) {
      const trial = original.trials[index],
        { fixture, arm, seed } = planned[index];
      if (
        trial.id !== `${fixture.id}-${arm.id}` ||
        trial.fixtureId !== fixture.id ||
        trial.fixtureSha256 !== fixtureHash(fixture) ||
        trial.fixtureVersion !== fixture.version ||
        trial.arm !== arm.id ||
        trial.order !== index ||
        trial.acceptanceSha256 !==
          hash(
            JSON.stringify({
              fixtureId: fixture.id,
              seed,
              graderBefore: currentHashes["grade-worker.mjs"],
              fixtureBefore: currentHashes["fixtures.mjs"],
            }),
          )
      )
        throw Error("original continuation trial identity changed");
      if (
        trial.phase !== "complete" ||
        !["succeeded", "failed", "cancelled", "blocked"].includes(trial.taskStatus) ||
        trial.telemetryIncomplete ||
        !trial.graderUnchanged
      )
        throw Error("uncertain or infrastructure attempt cannot continue");
    }
    const billingKey =
      key ?? (original.mode === "live" ? await providerKey() : "mock-provider-no-real-key");
    const result = await settleManaged(root, { key: billingKey, fetcher });
    if (result.totalCostUsd === null || result.trials.some((trial) => trial.costUsd === null))
      throw Error("unknown costs block continuation; reconcile existing IDs only");
    const records = result.trials.flatMap((trial) => trial.generations);
    if (
      new Set(records.map((record) => record.managedRequestId)).size !== records.length ||
      records.some(
        (record) =>
          !record.managedRequestId || !Number.isFinite(record.costUsd) || record.costUsd < 0,
      )
    )
      throw Error("untracked or duplicate accounting blocks continuation");
    return await runManaged({
      mode: result.mode,
      root,
      armFilter: arms.map((arm) => arm.id).join(","),
      taskFilter: fixtures.map((fixture) => fixture.id).join(","),
      budgetUsd: result.budgetTargetUsd,
      timeoutMs: limits.timeoutMs,
      chooser: result.chooser,
      fixtureOffset,
      continuation: {
        [continuationAuthority]: true,
        id: randomUUID(),
        key: billingKey,
        result,
        limits,
        legacyLimitsAttested: !original.limits,
        originalRunSource,
        currentHashes,
      },
    });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURLSafe(process.argv[1])) {
  const mode = process.argv[2] ?? "mock";
  if (mode === "settle") {
    const result = await settleManaged(resolve(process.env.BENCH_RESULTS), {
      key: await providerKey(),
    });
    console.log(
      JSON.stringify({
        totalCostUsd: result.totalCostUsd,
        resume: result.resume,
        summary: result.summary,
      }),
    );
  } else if (mode === "continue") {
    const result = await continueManaged(resolve(process.env.BENCH_RESULTS));
    console.log(JSON.stringify({ totalCostUsd: result.totalCostUsd, summary: result.summary }));
  } else await runManaged({ mode });
}
function pathToFileURLSafe(path) {
  return new URL(resolve(path), "file:").href;
}
