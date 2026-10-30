import { mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ManagedMeter, mockManagedFetcher } from "./meter.mjs";
import { startManagedRuntime, preflightManagedRuntime } from "./runtime.mjs";
import { managedProfiles, settledTotal, settleManaged } from "./run.mjs";
import { providerKey } from "../live.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const exec = promisify(execFile);
export function refreshFunctionalResult(result) {
  const trial = result.trials[0],
    profiles = result.profiles;
  const child = trial.taskTree?.find((task) => task.parentId === trial.rootTaskId);
  const roots = trial.generations.filter(
      (record) => record.kind === "execution" && record.profile === profiles[0].id,
    ),
    children = trial.generations.filter(
      (record) => record.kind === "execution" && record.profile === profiles[1].id,
    );
  const exact = (records, profile) =>
    records.length > 0 && records.every((record) => record.actualModel === profile.canonical);
  trial.functionalProof = {
    rootSucceeded: trial.taskStatus === "succeeded",
    childSucceeded: child?.status === "succeeded",
    childAttempts: child?.attempts ?? 0,
    rootModelPinned: exact(roots, profiles[0]),
    childModelPinned: exact(children, profiles[1]),
    distinctProviders:
      roots.length > 0 &&
      children.length > 0 &&
      roots.every(
        (root) =>
          typeof root.provider === "string" &&
          children.every(
            (child) => typeof child.provider === "string" && root.provider !== child.provider,
          ),
      ),
  };
  trial.functionalPass =
    !trial.error &&
    trial.grade.pass &&
    Object.entries(trial.functionalProof).every(([key, value]) =>
      key === "childAttempts" ? value === 1 : value === true,
    ) &&
    trial.costUsd !== null;
  return result;
}
export async function runFunctionalProbe({
  mode = "mock",
  root,
  runnerSource = resolve(process.env.BENCH_RUNNER_SOURCE ?? join(here, "../../runner")),
} = {}) {
  if (!["mock", "live"].includes(mode) || !root) throw Error("functional mode/root required");
  root = resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await readFile(join(root, "results.json"));
    throw Error("functional result exists; never repeat an uncertain or completed probe");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const workspace = join(root, "workspace"),
    deadlineMs = 120_000;
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await preflightManagedRuntime({
    mode,
    runnerSource,
    profileHome: join(root, "preflight-api-profile"),
  });
  const key = mode === "live" ? await providerKey() : "mock-no-real-key";
  let profiles = managedProfiles.map((profile) => ({
    ...profile,
    canonical: `${profile.model}-mock-canonical`,
  }));
  if (mode === "live") {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("functional model inventory unavailable");
    const catalog = await response.json();
    profiles = profiles.map((profile) => {
      const card = catalog.data.find((card) => card.id === profile.model);
      if (!card?.canonical_slug) throw Error("functional canonical unavailable");
      return { ...profile, canonical: card.canonical_slug };
    });
  }
  await writeFile(
    join(workspace, "README.md"),
    "# Explicit delegation functional probe\nThe coordinator writes only root.txt with exact UTF-8 bytes root:alpha followed by one newline. A delegated child writes only child.txt with exact bytes child:beta followed by one newline. The coordinator must wait for the child before writing. No other folders or network access.\n",
  );
  const trial = {
    id: "forced-cross-provider-delegation",
    fixtureId: "two-file-functional",
    arm: "forced-delegation",
    rootTaskId: `bench-${randomUUID()}`,
    phase: "intent-recorded",
    recordedAt: new Date().toISOString(),
    costUsd: null,
    generations: [],
    grade: { pass: false, reason: "not-executed" },
  };
  const result = {
    protocol: "managed-functional-v1",
    mode,
    purpose:
      "Forced cross-provider delegation functional check only; no quality, speed, model ranking or savings comparison.",
    budgetTargetUsd: 0.15,
    profiles,
    arms: [{ id: "forced-delegation", delegation: true }],
    trials: [trial],
    sourceHashes: Object.fromEntries(
      await Promise.all(
        ["functional.mjs", "functional-grade.mjs", "entry.mjs", "runtime.mjs", "meter.mjs"].map(
          async (file) => [file, hash(await readFile(join(here, file)))],
        ),
      ),
    ),
    totalCostUsd: null,
    stopped: null,
  };
  const save = () =>
    writeFile(join(root, "results.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  await save();
  const meter = new ManagedMeter({
    key,
    profiles,
    budgetUsd: 0.15,
    perTrialUsd: 0.15,
    maxCallsPerTrial: 20,
    maxOutputTokens: 2048,
    unsettledCallAllowanceUsd: 0.03,
    ...(mode === "mock" ? { fetcher: mockManagedFetcher(profiles) } : {}),
    onRecord: (record) =>
      appendFileSync(join(root, "meter.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 }),
  });
  const relayUrl = await meter.start();
  let runtime,
    tasks = [],
    task;
  const started = performance.now();
  try {
    meter.begin({ trialId: trial.id, arm: trial.arm });
    trial.phase = "infrastructure-starting";
    await save();
    runtime = await startManagedRuntime({
      root: join(root, "host"),
      workspace,
      arm: { delegation: true },
      profiles,
      meter,
      relayUrl,
      fixtureId: "functional",
      mode,
      runnerSource,
      maxOutputTokens: 2048,
    });
    const prompt = `DELEGATION FUNCTIONAL PROBE. This is an explicit tool/lifecycle check, not an optimization task. Use home_task_spawn with agentId "bench-deepseek" and prompt "DELEGATION FUNCTIONAL CHILD: Write only child.txt with exact content child:beta followed by one newline. Do not modify root.txt or other files. Do not use network or other folders. Return done." Call home_task_wait on the returned task ID so the child runs while you yield; then call home_task_result to read its result. Do not write child.txt yourself. After the child succeeds, write only root.txt with exact content root:alpha followed by one newline. Report the child task ID. If these MCP tools are unavailable, stop and report that; do not simulate delegation.`;
    trial.phase = "submitting";
    await save();
    await runtime.api("POST", "/tasks", {
      id: trial.rootTaskId,
      projectId: "home",
      prompt,
      route: { mode: "explicit", agentId: profiles[0].id, model: profiles[0].model },
      maxAttempts: 1,
      maxRuntimeMs: deadlineMs,
      deadline: Date.now() + deadlineMs,
      allowPaidApi: true,
      maxEstimatedUsd: 0.15,
      acceptance: {
        commands: [
          {
            argv: [process.execPath, join(here, "functional-grade.mjs"), workspace],
            timeoutMs: 5000,
          },
        ],
        artifacts: [{ path: "root.txt" }, { path: "child.txt" }],
      },
    });
    trial.phase = "executing";
    await save();
    const deadline = Date.now() + deadlineMs + 5000;
    while (Date.now() < deadline) {
      tasks = (await runtime.api("GET", "/tasks?projectId=home")).tasks;
      task = tasks.find((task) => task.id === trial.rootTaskId);
      for (const running of tasks.filter((task) => task.status === "running")) {
        const permissions = (await runtime.api("GET", `/tasks/${running.id}/permissions`))
          .permissions;
        for (const permission of permissions) {
          const option = permission.params?.options?.find((option) => option.kind === "allow_once");
          if (!option) throw Error("no bounded permission option");
          await runtime.api("POST", `/tasks/${running.id}/permissions/${permission.requestId}`, {
            optionId: option.optionId,
          });
        }
      }
      if (task && !["queued", "running"].includes(task.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!task || ["queued", "running"].includes(task.status)) throw Error("functional deadline");
    trial.taskStatus = task.status;
    if (task.outputRef)
      trial.verification = JSON.parse(
        (await runtime.api("GET", `/artifacts/home/${task.outputRef}`)).content,
      ).verification;
    trial.taskTree = [];
    for (const task of tasks) {
      let actualRoute = null;
      if (task.sessionRef)
        actualRoute = JSON.parse(
          (await runtime.api("GET", `/artifacts/home/${task.sessionRef}`)).content,
        ).route;
      trial.taskTree.push({
        id: task.id,
        parentId: task.parentId,
        status: task.status,
        attempts: task.attempts,
        requestedRoute: task.route,
        actualRoute,
      });
    }
  } catch (error) {
    trial.error = error.message.slice(0, 300);
  } finally {
    await runtime?.close();
    await meter.end();
  }
  trial.totalMs = performance.now() - started;
  try {
    const grade = await exec(process.execPath, [join(here, "functional-grade.mjs"), workspace], {
      timeout: 5000,
      env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
    });
    trial.grade = JSON.parse(grade.stdout);
  } catch {
    trial.grade = { pass: false, reason: "exact-two-file-acceptance" };
  }
  await meter.settle();
  trial.generations = meter.records;
  trial.costUsd = result.totalCostUsd = settledTotal(meter.records);
  trial.phase = runtime ? "complete" : "infrastructure-failed";
  refreshFunctionalResult(result);
  result.stopped =
    trial.costUsd === null ? "unknown cost; billing-only settle required; never rerun probe" : null;
  await save();
  await meter.close();
  console.log(
    JSON.stringify({
      functionalPass: trial.functionalPass,
      proof: trial.functionalProof,
      costUsd: trial.costUsd,
      stopped: result.stopped,
    }),
  );
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "settle") {
    const root = resolve(process.env.BENCH_RESULTS);
    const result = refreshFunctionalResult(await settleManaged(root, { key: await providerKey() }));
    await writeFile(join(root, "results.json"), JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        functionalPass: result.trials[0].functionalPass,
        proof: result.trials[0].functionalProof,
        costUsd: result.totalCostUsd,
      }),
    );
  } else
    await runFunctionalProbe({ mode: process.argv[2] ?? "mock", root: process.env.BENCH_RESULTS });
}
