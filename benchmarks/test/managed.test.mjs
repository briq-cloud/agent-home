import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  managedFixtures,
  prepareManaged,
  gradeManaged,
  factorialArms,
  discoveryArms,
  fixtureHash,
} from "../managed/fixtures.mjs";
import { ManagedMeter, mockManagedFetcher } from "../managed/meter.mjs";
import {
  runManaged,
  selectArms,
  settledTotal,
  settleManaged,
  continueManaged,
} from "../managed/run.mjs";
import {
  preflightManagedRuntime,
  startManagedRuntime,
  managedApiRequest,
} from "../managed/runtime.mjs";

async function directory(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const profiles = [
  { id: "bench-haiku", model: "anthropic/fixed", canonical: "anthropic/fixed-v1" },
  { id: "bench-cheap", model: "vendor/cheap", canonical: "vendor/cheap-v1" },
];
test("versioned public contracts explicitly cover every grader behavior category", () => {
  const invoice = managedFixtures.find((fixture) => fixture.id === "invoice-rollup");
  const requests = managedFixtures.find((fixture) => fixture.id === "coalesced-requests");
  const invoiceContract = invoice.files["docs/contract.md"];
  for (const clause of [
    "kind is exactly 'sale' or 'refund'",
    "^[+-]?[0-9]+(?:\\.[0-9]{1,2})?$",
    "9007199254740991",
    "positive 0",
    "all whitespace",
    "first row",
    "Skip duplicate rows before reading",
    "number 1 differs from string '1'",
    "refund of a negative amount",
    "retained invalid kind or amount throws TypeError",
  ])
    assert.ok(invoiceContract.includes(clause), `missing public invoice rule: ${clause}`);
  const requestsContract = requests.files["docs/contract.md"];
  for (const clause of [
    "Map equality",
    "exactly one Promise",
    "both fulfillment and rejection evict",
    "Synchronous loader throws become rejected Promises",
    "asynchronous rejection preserve",
    "after one",
    "maxAttempts = 3",
    "positive",
    "no string coercion",
    "RangeError before calling fn",
    "including the initial call",
    "make no later calls",
    "exact last thrown/rejected object",
  ])
    assert.ok(requestsContract.includes(clause), `missing public request rule: ${clause}`);
  for (const fixture of managedFixtures) {
    assert.equal(fixture.version, 2);
    assert.ok(fixture.files["docs/contract.md"].includes("version 2"));
    assert.notEqual(fixtureHash(fixture), fixtureHash({ ...fixture, version: 1 }));
  }
});
for (const fixture of managedFixtures)
  for (const fixed of [false, true])
    test(`${fixture.id}: separate deterministic grader ${fixed ? "accepts reference" : "rejects source bugs"}`, async (t) => {
      const root = await directory(t, "managed-fixture-");
      await prepareManaged(root, fixture);
      if (fixed) {
        for (const [file, content] of Object.entries(fixture.reference))
          await writeFile(join(root, file), content);
        await writeFile(join(root, "CHANGELOG.md"), "Implemented contract fixes.\n");
      }
      assert.equal((await gradeManaged(root, fixture.id, 23)).pass, fixed);
      assert.ok(!Object.keys(fixture.files).some((file) => /gold|grader|reference/.test(file)));
    });

test("discovery is baseline plus one factor, with a complete optional factorial registry", () => {
  assert.equal(factorialArms.length, 16);
  assert.equal(new Set(factorialArms.map(({ id, ...flags }) => JSON.stringify(flags))).size, 16);
  assert.deepEqual(
    selectArms().map((arm) => arm.id),
    discoveryArms,
  );
  for (const arm of selectArms().slice(1))
    assert.equal([arm.auto, arm.context, arm.memory, arm.delegation].filter(Boolean).length, 1);
  assert.equal(selectArms("factorial").length, 16);
  assert.throws(() => selectArms("baseline,baseline"));
  assert.throws(() => selectArms("invented"));
  assert.equal(settledTotal([{ costUsd: 0.01 }, { costUsd: 0.02 }]), 0.03);
  for (const costUsd of [null, undefined, -1, "0.01"])
    assert.equal(settledTotal([{ costUsd }]), null);
});

test("shared meter pins each profile and includes settled typed routing and execution cost", async (t) => {
  const upstream = mockManagedFetcher(profiles),
    seen = [];
  const meter = new ManagedMeter({
    key: "private-provider-key",
    profiles,
    budgetUsd: 2,
    fetcher: async (url, options) => {
      if (url.endsWith("/messages")) seen.push(JSON.parse(options.body));
      const response = await upstream(url, options);
      if (url.includes("/generation?")) {
        const value = await response.json();
        value.data.total_cost = 0.002;
        return Response.json(value);
      }
      if (url.endsWith("/decisions")) {
        const value = await response.json();
        value.usage.cost = 0.0001;
        return Response.json(value);
      }
      return response;
    },
  });
  const url = await meter.start();
  t.after(() => meter.close());
  meter.begin({ trialId: "trial", arm: "auto-only" });
  const decision = await fetch(url + "/api/alpha/decisions", {
    method: "POST",
    headers: { authorization: `Bearer ${meter.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "cloudflare/clef-flash",
      questions: {
        type: { type: "choice" },
        route: { type: "choice", criteria: { "bench-cheap": "cheap", abstain: "unknown" } },
      },
      state: {},
    }),
  });
  assert.equal(decision.status, 200);
  await decision.text();
  const execution = await fetch(url + "/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${meter.tokens["bench-cheap"]}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "untrusted", max_tokens: 100000 }),
  });
  assert.equal(execution.status, 200);
  await execution.text();
  await meter.settle();
  const bill = await meter.end();
  assert.equal(bill.costUsd, 0.0021);
  assert.equal(seen[0].model, "vendor/cheap");
  assert.equal(seen[0].max_tokens, 2048);
  assert.deepEqual(
    meter.records.map((record) => record.kind),
    ["routing", "execution"],
  );
  assert.ok(meter.records.every((record) => record.managedRequestId));
  assert.ok(meter.records[0].decisionFrozenAt);
  assert.ok(!JSON.stringify(bill).includes("private-provider-key"));
});

test("missing typed decision charge stops subsequent execution instead of implying free routing", async (t) => {
  let paidCalls = 0;
  const meter = new ManagedMeter({
    key: "secret",
    profiles,
    fetcher: async () => {
      paidCalls++;
      return Response.json({ model: "cloudflare/clef-flash", usage: {}, answers: {} });
    },
  });
  const url = await meter.start();
  t.after(() => meter.close());
  meter.begin({ trialId: "unknown" });
  await (
    await fetch(url + "/api/alpha/decisions", {
      method: "POST",
      headers: { authorization: `Bearer ${meter.token}` },
      body: JSON.stringify({
        model: "cloudflare/clef-flash",
        questions: { route: { type: "choice" } },
      }),
    })
  ).text();
  const rejected = await fetch(url + "/v1/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${meter.tokens[profiles[0].id]}` },
    body: JSON.stringify({ model: profiles[0].model }),
  });
  assert.equal(rejected.status, 429);
  assert.equal(paidCalls, 1);
  assert.equal((await meter.end()).costUsd, null);
  assert.throws(() => meter.begin({ trialId: "next" }));
});

test("all discovery arms traverse production task/context/memory/routing/delegation and the same external acceptance", async (t) => {
  const root = await directory(t, "managed-discovery-");
  const result = await runManaged({ mode: "mock", root });
  assert.equal(result.trials.length, 10);
  assert.equal(result.stopped, null);
  assert.equal(result.totalCostUsd, 0);
  for (const fixture of managedFixtures) {
    const rows = result.trials.filter((trial) => trial.fixtureId === fixture.id);
    assert.equal(new Set(rows.map((trial) => trial.acceptanceSha256)).size, 1);
    for (const trial of rows) {
      assert.equal(trial.grade.pass, true);
      assert.equal(trial.taskStatus, "succeeded");
      assert.equal(trial.verification.status, "passed");
      assert.equal(trial.backendReportedCostMicros, null);
      assert.equal(trial.featuresExercised, true);
      assert.equal(trial.graderUnchanged, true);
      assert.equal(trial.modelsPinned, true);
      assert.ok(trial.generations.some((record) => record.kind === "execution"));
      assert.equal(trial.featureEvidence.context.injected, trial.arm === "context-only");
      assert.equal(trial.featureEvidence.memory.injected, trial.arm === "memory-only");
      assert.equal(trial.featureEvidence.auto.dispatched, trial.arm === "auto-only");
      assert.equal(
        trial.featureEvidence.delegation.childAttempts,
        trial.arm === "delegation-only" ? 1 : 0,
      );
      if (trial.arm === "delegation-only")
        assert.equal(trial.generations.filter((record) => record.kind === "execution").length, 2);
      if (trial.arm === "auto-only")
        assert.ok(
          trial.generations.some(
            (record) => record.kind === "routing" && record.answers.type.type === "choice",
          ),
        );
    }
  }
  assert.ok(!JSON.stringify(result).includes("mock-provider-no-real-key"));
  await assert.rejects(runManaged({ mode: "mock", root }), /results already exist/);
});

test("billing-only resume deduplicates request updates, preserves grades/routes/timing, and never dispatches work", async (t) => {
  const root = await directory(t, "managed-settle-");
  const original = {
    arms: [{ id: "auto-only" }],
    trials: [
      {
        id: "trial",
        arm: "auto-only",
        phase: "complete",
        totalMs: 1234,
        taskStatus: "succeeded",
        grade: { pass: true },
        route: { source: "decision", cli: "chosen" },
        featuresExercised: true,
        graderUnchanged: true,
        generations: [],
      },
    ],
    stopped: "unknown cost",
  };
  await writeFile(join(root, "results.json"), JSON.stringify(original));
  const routing = {
    managedRequestId: "routing",
    trialId: "trial",
    kind: "routing",
    costUsd: 0.001,
  };
  const generation = {
    managedRequestId: "execution",
    trialId: "trial",
    kind: "execution",
    model: "vendor/fixed",
    generationId: "gen-late",
    costUsd: null,
  };
  await writeFile(
    join(root, "meter.jsonl"),
    [routing, generation, generation].map(JSON.stringify).join("\n") + "\n",
  );
  const urls = [];
  const reconciled = await settleManaged(root, {
    key: "secret",
    fetcher: async (url) => {
      urls.push(url);
      return Response.json({
        data: {
          total_cost: 0.02,
          model: "vendor/fixed",
          provider_name: "mock-provider",
          native_tokens_prompt: 12,
          native_tokens_completion: 7,
          native_tokens_cached: 3,
        },
      });
    },
  });
  assert.deepEqual(urls, ["https://openrouter.ai/api/v1/generation?id=gen-late"]);
  assert.equal(reconciled.totalCostUsd, 0.021);
  assert.equal(reconciled.trials[0].generations.length, 2);
  assert.equal(reconciled.trials[0].totalMs, 1234);
  assert.deepEqual(reconciled.trials[0].route, original.trials[0].route);
  assert.equal(reconciled.trials[0].grade.pass, true);
  assert.equal(reconciled.trials[0].modelsPinned, true);
  assert.equal(reconciled.trials[0].comparisonEligible, true);
  const observed = reconciled.trials[0].generations.find((record) => record.kind === "execution");
  assert.equal(observed.provider, "mock-provider");
  assert.deepEqual(observed.nativeTokens, { input: 12, output: 7, cached: 3 });
  assert.equal(reconciled.resume.newPaidRequests, 0);
  assert.equal(reconciled.resume.mayExecute, false);
  const again = await settleManaged(root, {
    key: "secret",
    fetcher: async () => {
      assert.fail("settled requests must not be repeated");
    },
  });
  assert.equal(again.totalCostUsd, 0.021);
});

test("ledger canonical identities match frozen model pins without accepting other revisions", async (t) => {
  const root = await directory(t, "managed-model-canonical-");
  const base = {
    arms: [{ id: "baseline" }],
    profiles: [{ id: "pin", model: "vendor/alias", canonical: "vendor/exact-20261007" }],
    trials: [
      {
        id: "case",
        arm: "baseline",
        phase: "complete",
        taskStatus: "succeeded",
        grade: { pass: true },
        featuresExercised: true,
        graderUnchanged: true,
        generations: [
          {
            managedRequestId: "known",
            trialId: "case",
            kind: "execution",
            profile: "pin",
            model: "vendor/alias",
            actualModel: "vendor/exact-20261007",
            costUsd: 0.01,
          },
        ],
      },
    ],
  };
  await writeFile(join(root, "results.json"), JSON.stringify(base));
  const settled = await settleManaged(root, {
    fetcher: async () => assert.fail("no billing needed"),
  });
  assert.equal(settled.trials[0].modelsPinned, true);
  assert.equal(settled.trials[0].comparisonEligible, true);
  settled.trials[0].generations[0].actualModel = "vendor/exact-20261008";
  await writeFile(join(root, "results.json"), JSON.stringify(settled));
  const changed = await settleManaged(root, {
    fetcher: async () => assert.fail("no billing needed"),
  });
  assert.equal(changed.trials[0].modelsPinned, false);
  assert.equal(changed.trials[0].comparisonEligible, false);
  changed.trials[0].generations[0].actualModel = "vendor/alias";
  await writeFile(join(root, "results.json"), JSON.stringify(changed));
  assert.equal(
    (await settleManaged(root, { fetcher: async () => assert.fail("no billing needed") })).trials[0]
      .modelsPinned,
    false,
  );
});

test("local polling retries transport resets while uncertain mutations and HTTP errors never replay", async () => {
  let calls = 0;
  const fetcher = async (_url, options) => {
    calls++;
    assert.equal(options.headers.connection, "close");
    if (calls < 3) throw Object.assign(new Error("closed"), { cause: { code: "UND_ERR_SOCKET" } });
    return Response.json({ ok: true });
  };
  assert.deepEqual(
    await managedApiRequest("http://127.0.0.1", "fake", "GET", "/tasks", undefined, {
      fetcher,
      retryDelayMs: 0,
    }),
    { ok: true },
  );
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    managedApiRequest(
      "http://127.0.0.1",
      "fake",
      "POST",
      "/tasks",
      {},
      { fetcher, retryDelayMs: 0 },
    ),
    /UND_ERR_SOCKET/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    managedApiRequest("http://127.0.0.1", "fake", "GET", "/tasks", undefined, {
      fetcher: async () => {
        calls++;
        return Response.json({ error: "denied" }, { status: 403 });
      },
      retryDelayMs: 0,
    }),
    /403/,
  );
  assert.equal(calls, 1);
});

test("host startup failure preserves exit diagnostics without invoking a model", async (t) => {
  const root = await directory(t, "managed-host-exit-");
  const entry = join(root, "exit.mjs"),
    workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(entry, "process.exit(23);\n");
  await assert.rejects(
    startManagedRuntime({
      root: join(root, "host"),
      workspace,
      profiles,
      arm: factorialArms[0],
      meter: { token: "fake", tokens: {} },
      relayUrl: "http://127.0.0.1:1",
      fixtureId: "invoice-rollup",
      entryPath: entry,
      startupMs: 1000,
    }),
    /exit=23/,
  );
  const lifecycle = JSON.parse(
    await readFile(join(root, "host", "private-lifecycle.json"), "utf8"),
  );
  assert.equal(lifecycle.exitCode, 23);
  assert.equal(lifecycle.ready, false);
  assert.equal(lifecycle.signal, null);
});

test("resume leaves missing generation IDs, unknown decision charges and incomplete intents unknown", async (t) => {
  const root = await directory(t, "managed-missing-bill-");
  await writeFile(
    join(root, "results.json"),
    JSON.stringify({
      arms: [{ id: "baseline" }],
      trials: [{ id: "intent", arm: "baseline", phase: "intent-recorded", generations: [] }],
      stopped: "interrupted",
    }),
  );
  const result = await settleManaged(root, {
    key: "secret",
    fetcher: async () => {
      assert.fail("no IDs to reconcile");
    },
  });
  assert.equal(result.totalCostUsd, null);
  assert.equal(result.trials[0].costUsd, null);
  const saved = JSON.parse(await readFile(join(root, "results.json"), "utf8"));
  saved.trials[0].phase = "complete";
  await writeFile(join(root, "results.json"), JSON.stringify(saved));
  await writeFile(
    join(root, "meter.jsonl"),
    JSON.stringify({
      managedRequestId: "unknown-decision",
      trialId: "intent",
      kind: "routing",
      costUsd: null,
    }) + "\n",
  );
  assert.equal(
    (
      await settleManaged(root, {
        key: "secret",
        fetcher: async () => assert.fail("routing without authoritative charge is not fabricated"),
      })
    ).totalCostUsd,
    null,
  );
});

test("native preflight resolves production cliEnv executable paths without invoking a vendor", async (t) => {
  const root = await directory(t, "managed-preflight-");
  const bin = join(root, "bin"),
    home = join(root, "profile"),
    marker = join(root, "must-not-run");
  await mkdir(bin);
  await mkdir(home);
  const claude = join(bin, "claude");
  await writeFile(claude, `#!/bin/sh\nprintf ran > '${marker}'\nexit 99\n`);
  await chmod(claude, 0o755);
  const result = await preflightManagedRuntime({ mode: "live", path: bin, profileHome: home });
  assert.equal(result.productionHelper, "cliEnv");
  assert.equal(result.nativeExecutable, claude);
  assert.equal(result.executableChecks, true);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.authReads, 0);
  await assert.rejects(readFile(marker), /ENOENT/);
  await chmod(claude, 0o644);
  await assert.rejects(
    preflightManagedRuntime({ mode: "live", path: bin, profileHome: home }),
    /Claude native executable/,
  );
  await rm(claude);
  await mkdir(claude);
  await assert.rejects(
    preflightManagedRuntime({ mode: "live", path: bin, profileHome: home }),
    /executable file/,
  );
});

test("failed live preflight precedes key access, trial intents, and paid ledger creation", async (t) => {
  const root = await directory(t, "managed-preflight-fail-");
  const bin = join(root, "empty-bin");
  await mkdir(bin);
  const priorPath = process.env.PATH,
    priorPaid = process.env.BENCH_PAID;
  process.env.PATH = bin;
  delete process.env.BENCH_PAID;
  try {
    await assert.rejects(
      runManaged({ mode: "live", root, armFilter: "baseline", taskFilter: "invoice-rollup" }),
      /Claude native executable/,
    );
    const preflight = JSON.parse(await readFile(join(root, "preflight.json"), "utf8"));
    assert.equal(preflight.status, "failed");
    assert.equal(preflight.modelCalls, 0);
    await assert.rejects(readFile(join(root, "results.json")), /ENOENT/);
    await assert.rejects(readFile(join(root, "meter.jsonl")), /ENOENT/);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorPaid === undefined) delete process.env.BENCH_PAID;
    else process.env.BENCH_PAID = priorPaid;
  }
});

test("isolated actual host forwards production cliEnv native resolution and excludes provider key environment", async (t) => {
  const root = await directory(t, "managed-entry-env-");
  const bin = join(root, "bin"),
    workspace = join(root, "workspace"),
    marker = join(root, "must-not-run");
  await mkdir(bin);
  await mkdir(workspace);
  const claude = join(bin, "claude");
  await writeFile(claude, `#!/bin/sh\nprintf ran > '${marker}'\nexit 99\n`);
  await chmod(claude, 0o755);
  const meter = new ManagedMeter({
    key: "fake-provider-key",
    profiles,
    fetcher: mockManagedFetcher(profiles),
  });
  const relayUrl = await meter.start();
  t.after(() => meter.close());
  const priorPath = process.env.PATH,
    priorKey = process.env.OPENROUTER_API_KEY;
  process.env.PATH = bin;
  process.env.OPENROUTER_API_KEY = "must-not-inherit-provider-key";
  let runtime;
  try {
    runtime = await startManagedRuntime({
      root: join(root, "host"),
      workspace,
      arm: factorialArms[0],
      profiles,
      meter,
      relayUrl,
      fixtureId: "invoice-rollup",
      mode: "mock",
    });
    const accepted = await runtime.api("POST", "/tasks", {
      projectId: "home",
      prompt: "__BENCH_REPORT_NATIVE_ENV__",
      route: { mode: "explicit", agentId: profiles[0].id, model: profiles[0].model },
      allowPaidApi: true,
      maxEstimatedUsd: 0.2,
      maxRuntimeMs: 5000,
    });
    let task;
    for (let i = 0; i < 100; i++) {
      task = await runtime.api("GET", `/tasks/${accepted.task.id}`);
      if (!["queued", "running"].includes(task.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(task.status, "succeeded");
    const output = JSON.parse(
      (await runtime.api("GET", `/artifacts/home/${task.outputRef}`)).content,
    );
    assert.deepEqual(JSON.parse(output.text), {
      nativeExecutable: claude,
      providerKeyInherited: false,
    });
    assert.equal(meter.records.length, 0);
    await assert.rejects(readFile(marker), /ENOENT/);
  } finally {
    await runtime?.close();
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorKey;
  }
});

test("validated execution continuation skips completed attempts, preserves frozen failures and includes past spend", async (t) => {
  const seedRoot = await directory(t, "managed-continuation-seed-");
  const finished = await runManaged({
    mode: "mock",
    root: seedRoot,
    armFilter: "baseline,context-only",
    taskFilter: "invoice-rollup",
  });
  const paused = structuredClone(finished);
  delete paused.root;
  paused.trials = paused.trials.slice(0, 1);
  paused.trials[0].generations.forEach((record, index) => {
    record.costUsd = index ? 0 : 0.05;
  });
  paused.trials[0].costUsd = 0.05;
  paused.totalCostUsd = 0.05;
  paused.stopped = "unknown total cost; settle existing generation IDs only";
  const writePaused = async (name, mutate = () => {}) => {
    const root = await directory(t, `managed-continue-${name}-`);
    const snapshot = structuredClone(paused);
    mutate(snapshot);
    await writeFile(join(root, "results.json"), JSON.stringify(snapshot));
    await writeFile(
      join(root, "meter.jsonl"),
      snapshot.trials
        .flatMap((trial) => trial.generations)
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    return { root, snapshot };
  };
  const noBilling = async () =>
    assert.fail("known observations must not request new billing or decisions");
  const { root, snapshot } = await writePaused("known-failure", (result) => {
    result.trials[0].taskStatus = "failed";
    result.trials[0].grade = { pass: false, reason: "frozen-failure" };
    result.trials[0].comparisonEligible = false;
  });
  const frozen = JSON.parse(JSON.stringify(snapshot.trials[0]));
  const continued = await continueManaged(root, { fetcher: noBilling });
  assert.equal(continued.trials.length, 2);
  assert.deepEqual(continued.trials[0], frozen);
  assert.equal(continued.trials[1].taskStatus, "succeeded");
  assert.equal(continued.totalCostUsd, 0.05);
  assert.equal(continued.continuations[0].priorCostUsd, 0.05);
  assert.deepEqual(continued.continuations[0].skippedTrialIds, [frozen.id]);
  assert.equal(continued.budgetTargetUsd, finished.budgetTargetUsd);
  assert.equal(
    new Set(
      continued.trials.flatMap((trial) =>
        trial.generations.map((record) => record.managedRequestId),
      ),
    ).size,
    2,
  );

  const allowance = await writePaused("past-budget", (result) => {
    result.trials[0].generations[0].costUsd = 1.85;
    result.trials[0].costUsd = result.totalCostUsd = 1.85;
  });
  const stopped = await continueManaged(allowance.root, { fetcher: noBilling });
  assert.equal(stopped.stopped, "remaining admission allowance exhausted");
  assert.equal(stopped.trials[1].phase, "not-admitted");
  assert.equal(stopped.totalCostUsd, 1.85);
  assert.equal(stopped.trials.flatMap((trial) => trial.generations).length, 1);

  for (const [name, mutate, expected] of [
    [
      "unknown",
      (result) => {
        const record = result.trials[0].generations[0];
        record.costUsd = null;
        record.generationId = null;
      },
      /unknown costs/,
    ],
    [
      "profile",
      (result) => {
        result.profiles[0].model = "changed/model";
      },
      /model plan changed/,
    ],
    [
      "canonical",
      (result) => {
        result.profiles[0].canonical = "changed-version";
      },
      /canonical identity changed/,
    ],
    [
      "fixture",
      (result) => {
        result.fixtures[0].sha256 = "changed";
      },
      /fixture identity changed/,
    ],
    [
      "grader",
      (result) => {
        result.sourceHashes["grade-worker.mjs"] = "changed";
      },
      /source identity changed/,
    ],
    [
      "entry",
      (result) => {
        result.sourceHashes["entry.mjs"] = "changed";
      },
      /source identity changed/,
    ],
    [
      "runtime",
      (result) => {
        result.sourceHashes["runtime.mjs"] = "changed";
      },
      /source identity changed/,
    ],
    [
      "runner-core",
      (result) => {
        result.sourceHashes["runner/src/orchestration/engine.ts"] = "changed";
      },
      /source identity changed/,
    ],
    [
      "intent",
      (result) => {
        result.trials[0].phase = "intent-recorded";
      },
      /uncertain or infrastructure/,
    ],
    [
      "infrastructure",
      (result) => {
        result.trials[0].phase = "infrastructure-failed";
      },
      /uncertain or infrastructure/,
    ],
    [
      "interrupted",
      (result) => {
        result.stopped = "interrupted; settle existing generations only";
      },
      /uncertain or interrupted/,
    ],
  ]) {
    const attempt = await writePaused(name, mutate);
    await assert.rejects(continueManaged(attempt.root, { fetcher: noBilling }), expected, name);
    await assert.rejects(
      readFile(join(attempt.root, "invoice-rollup-context-only", "private-runtime.json")),
      /ENOENT/,
    );
  }

  const originalBytes = "// preserved original driver bytes; never executed\n";
  const originalSha = createHash("sha256").update(originalBytes).digest("hex");
  const legacy = await writePaused("driver-exception", (result) => {
    result.sourceHashes["run.mjs"] = originalSha;
    delete result.limits;
  });
  const originalPath = join(legacy.root, "original-run.mjs");
  await writeFile(originalPath, originalBytes);
  await assert.rejects(
    continueManaged(legacy.root, { fetcher: noBilling }),
    /matching original run.mjs bytes/,
  );
  await assert.rejects(
    continueManaged(legacy.root, { fetcher: noBilling, originalRunSource: originalPath }),
    /explicit valid original limits/,
  );
  const migrated = await continueManaged(legacy.root, {
    fetcher: noBilling,
    originalRunSource: originalPath,
    legacyLimits: finished.limits,
  });
  assert.equal(migrated.trials.length, 2);
  assert.equal(migrated.sourceHashes["run.mjs"], originalSha);
  assert.equal(migrated.continuations[0].originalRunSha256, originalSha);
  assert.notEqual(migrated.continuations[0].continuationRunSha256, originalSha);
  assert.equal(migrated.continuations[0].legacyLimitsAttested, true);
  assert.deepEqual(migrated.limits, finished.limits);
});
