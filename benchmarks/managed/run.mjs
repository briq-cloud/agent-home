import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
} = {}) {
  if (
    !["mock", "live"].includes(mode) ||
    !decisionModels.includes(chooser) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 300_000
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
    throw Error("results already exist; settle-only resume never repeats paid trials");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const runnerSource = resolve(process.env.BENCH_RUNNER_SOURCE ?? join(here, "../../runner"));
  let preflight;
  try {
    preflight = await preflightManagedRuntime({
      mode,
      runnerSource,
      profileHome: join(root, "preflight-api-profile"),
    });
    await writeFile(join(root, "preflight.json"), JSON.stringify(preflight, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch (error) {
    await writeFile(
      join(root, "preflight.json"),
      JSON.stringify({ status: "failed", error: error.message, modelCalls: 0 }, null, 2) + "\n",
      { mode: 0o600 },
    );
    throw error;
  }
  const key = mode === "live" ? await providerKey() : "mock-provider-no-real-key";
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
      join(root, "model-snapshot.json"),
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
  const sourcePaths = [
    "fixtures.mjs",
    "grade-worker.mjs",
    "meter.mjs",
    "entry.mjs",
    "runtime.mjs",
    "run.mjs",
    "mock-agent.mjs",
    "../meter.mjs",
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (file) => [file, hash(await readFile(join(here, file)))]),
    ),
  );
  for (const file of [
    "src/orchestration/engine.ts",
    "src/orchestration/delegation.ts",
    "src/context/store.ts",
    "src/routing/index.ts",
    "src/app/services.ts",
  ])
    sourceHashes[`runner/${file}`] = hash(await readFile(join(runnerSource, file)));
  const graderBefore = hash(await readFile(join(here, "grade-worker.mjs"))),
    fixtureBefore = hash(await readFile(join(here, "fixtures.mjs")));
  const result = {
    protocol: "managed-production-v1",
    mode,
    startedAt: new Date().toISOString(),
    budgetTargetUsd: budgetUsd,
    accounting:
      "All root/child/native retry execution generations + typed decision response usage.cost. Unknown costs stop new work. Admission target is not a hard provider spend cap.",
    arms,
    profiles,
    chooser,
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
    perTrialUsd: Number(process.env.BENCH_PER_TRIAL_USD ?? 0.2),
    maxCallsPerTrial: 20,
    maxOutputTokens: 4096,
    ...(mode === "mock" ? { fetcher: mockManagedFetcher(profiles) } : {}),
    onRecord: (record) =>
      appendFileSync(join(root, "meter.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 }),
  });
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
          arm = arms[(ai + fi) % arms.length],
          trialId = `${fixture.id}-${arm.id}`,
          trialRoot = join(root, trialId),
          workspace = join(trialRoot, "workspace"),
          seed = 17 + fi;
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
        trial.modelsPinned = trial.generations
          .filter((record) => record.kind === "execution")
          .every((record) => record.actualModel === record.model);
        trial.phase = !runtime ? "infrastructure-failed" : "complete";
        trial.costProvenance =
          mode === "mock"
            ? "synthetic-provider-ledger-no-model-calls"
            : "execution-generation-total_cost-plus-typed-decision-usage.cost";
        trial.comparisonEligible =
          trial.taskStatus === "succeeded" &&
          trial.grade.pass &&
          trial.featuresExercised &&
          trial.graderUnchanged &&
          trial.modelsPinned &&
          trial.costUsd !== null;
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
    result.metadata = meter.metadata;
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
      record.costUsd === null &&
      record.kind === "execution" &&
      record.generationId?.startsWith("gen-")
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
          record.costUsd = value.total_cost;
          record.costSource = "openrouter-generation-total_cost";
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
  }
  result.resume = {
    mode: "billing-only",
    observedAt: new Date().toISOString(),
    newPaidRequests: 0,
    mayExecute: false,
  };
  result.totalCostUsd =
    untracked || result.trials.some((trial) => trial.costUsd === null)
      ? null
      : settledTotal([...records.values()]);
  result.summary = summarizeManaged(result);
  if (save)
    await writeFile(join(root, "results.json"), JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
  return result;
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
  } else await runManaged({ mode });
}
function pathToFileURLSafe(path) {
  return new URL(resolve(path), "file:").href;
}
