import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileRecords, resumeComparison } from "../resume-comparison.mjs";
import { profiles } from "../compare-models.mjs";
import { mediumTasks } from "../medium.mjs";

test("late billing is accounting only, idempotent, and preserves observed task time and acceptance", async () => {
  const records = [
    {
      costUsd: null,
      totalMs: 123,
      grade: { pass: true },
      generations: [
        { generationId: "gen-late", costUsd: null },
        { generationId: "gen-known", costUsd: 0.02 },
      ],
    },
  ];
  let calls = 0;
  const options = {
    key: "fixture-only",
    fetcher: async (url, init) => {
      calls++;
      assert.match(url, /\/generation\?id=gen-late$/);
      assert.equal(init.headers.authorization, "Bearer fixture-only");
      return Response.json({
        data: { total_cost: 0.01, model: "fixture/model", provider_name: "fixture" },
      });
    },
  };
  assert.equal(await reconcileRecords(records, options), true);
  assert.equal(records[0].costUsd, 0.03);
  assert.equal(records[0].totalMs, 123);
  assert.equal(records[0].grade.pass, true);
  assert.equal(await reconcileRecords(records, options), true);
  assert.equal(calls, 1);
});
test("missing or invalid billing never becomes a zero-cost execution", async () => {
  for (const response of [
    new Response("{}", { status: 404 }),
    Response.json({ data: { total_cost: -1 } }),
    Response.json({ data: { total_cost: "0.01" } }),
  ]) {
    const record = { costUsd: null, generations: [{ generationId: "gen-pending", costUsd: null }] };
    assert.equal(
      await reconcileRecords([record], { key: "fixture", fetcher: async () => response }),
      false,
    );
    assert.equal(record.costUsd, null);
    assert.equal(record.billingPending, true);
  }
  await assert.rejects(
    reconcileRecords(
      [{ costUsd: null, generations: [{ generationId: "gen-pending", costUsd: null }] }],
      { key: "fixture", fetcher: async () => new Response("{}", { status: 401 }) },
    ),
    /unauthorized/,
  );
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bench-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cards = profiles.map((p) => ({ ...p, canonical: p.model + "-pinned" }));
  const routing = [
    { chooser: "fixture-decision", taskId: mediumTasks[0].id, choice: "haiku", costUsd: 0.001 },
  ];
  const record = {
    taskId: mediumTasks[0].id,
    arm: "baseline",
    grade: { pass: true },
    error: null,
    totalMs: 100,
    costUsd: null,
    generations: [{ generationId: "gen-late", costUsd: null }],
  };
  const result = {
    profiles: cards,
    tasks: mediumTasks.map((t) => ({
      id: t.id,
      prompt: t.prompt,
      files: Object.keys(t.files).length,
      sourceBytes: Object.values(t.files).reduce((n, s) => n + Buffer.byteLength(s), 0),
    })),
    routing,
    routingFrozenAt: "2026-10-30T00:00:00Z",
    budgetTargetUsd: 2,
    spentUsd: 0.001,
    stopped: "unknown execution cost",
    runs: [{ profile: "haiku", ...record }],
  };
  const save = (path, data) => writeFile(path, JSON.stringify(data), { mode: 0o600 });
  await save(join(root, "comparison.json"), result);
  await save(join(root, "routing-frozen.json"), {
    profiles: cards,
    routing,
    routingFrozenAt: result.routingFrozenAt,
  });
  const dir = join(root, record.taskId + "-haiku");
  await mkdir(dir);
  await save(join(dir, "results.json"), { records: [record] });
  const requests = [],
    executions = [];
  const fetcher = async (url) => {
    requests.push(url);
    return url.includes("/generation?")
      ? Response.json({ data: { total_cost: 0.02 } })
      : Response.json({ data: cards.map((p) => ({ id: p.model, canonical_slug: p.canonical })) });
  };
  const executeTrial = async (_cmd, _args, { env }) => {
    executions.push({ task: env.BENCH_TASK_IDS, model: env.BENCH_MODEL });
    await mkdir(env.BENCH_RESULTS);
    await save(join(env.BENCH_RESULTS, "model-snapshot.json"), { id: env.BENCH_MODEL });
    await save(join(env.BENCH_RESULTS, "results.json"), {
      records: [
        {
          taskId: env.BENCH_TASK_IDS,
          arm: "baseline",
          grade: { pass: true },
          error: null,
          totalMs: 100,
          costUsd: 0.02,
          generations: [],
        },
      ],
    });
  };
  return { root, result, save, requests, executions, fetcher, executeTrial };
}
test("resume preserves frozen decisions, reconciles existing work and runs each remaining trial once", async (t) => {
  const h = await fixture(t);
  const result = await resumeComparison({ ...h, key: "fixture" });
  assert.equal(result.runs.length, 9);
  assert.equal(h.executions.length, 8);
  assert.equal(result.unknownCosts, 0);
  assert(Math.abs(result.spentUsd - 0.181) < 1e-9);
  assert.equal(result.stopped, null);
  assert.deepEqual(result.routing, h.result.routing);
  assert.equal(
    h.executions.filter((e) => e.task === mediumTasks[0].id && e.model === profiles[0].model)
      .length,
    0,
  );
  await resumeComparison({ ...h, key: "fixture" });
  assert.equal(h.executions.length, 8);
  assert(h.requests.every((url) => !url.includes("/decisions") && !url.includes("/messages")));
  assert.equal(
    JSON.parse(await readFile(join(h.root, "comparison.json.provisional"), "utf8")).runs.length,
    1,
  );
});
test("resume admits no new work while a prior cost is missing", async (t) => {
  const h = await fixture(t),
    real = h.fetcher;
  await assert.rejects(
    resumeComparison({
      ...h,
      key: "fixture",
      fetcher: async (url) =>
        url.includes("/generation?") ? new Response("{}", { status: 404 }) : real(url),
    }),
    /billing is still pending/,
  );
  assert.equal(h.executions.length, 0);
});
test("changed model versions or frozen choices fail before paid work", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    resumeComparison({ ...h, key: "fixture", fetcher: async () => Response.json({ data: [] }) }),
    /model version changed/,
  );
  h.result.routing[0].choice = "glm";
  await h.save(join(h.root, "comparison.json"), h.result);
  await assert.rejects(resumeComparison({ ...h, key: "fixture" }), /frozen decisions changed/);
  assert.equal(h.executions.length, 0);
});
