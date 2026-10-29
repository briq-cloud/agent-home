import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shortlist, DAY, decide } from "../routing/policy.mjs";
import { refresh } from "../routing/refresh.mjs";
import { importAnalysis, importOpenRouterBenchmarks } from "../routing/evidence.mjs";
const now = Date.parse("2026-10-30T00:00:00Z"),
  date = new Date(now).toISOString();
function setup() {
  const models = ["cheap", "smart", "fast", "included", "extra", "unknown"].map((id, i) => ({
    id,
    canonical: id + "-v1",
    context: 64000,
    modalities: ["text"],
    tools: true,
    inputUsdPerToken: (i + 1) / 1e6,
    outputUsdPerToken: (i + 1) / 1e6,
    requestUsd: 0,
  }));
  return {
    now,
    type: "change",
    catalog: { fetchedAt: date, models },
    inventory: {
      checkedAt: date,
      clis: [{ name: "claude", signedIn: true }],
      keyProviders: ["openrouter"],
      routes: models.map((m) => ({
        id: m.id,
        model: m.id,
        canonical: m.canonical,
        cli: "claude",
        harness: "claude",
        provider: "openrouter",
        billing: m.id === "included" ? "subscription" : "use",
        compatibility: "verified",
      })),
    },
    evidence: [
      {
        model: "smart",
        canonical: "smart-v1",
        intelligence: 50,
        scores: { change: 80 },
        observedAt: date,
        source: "test",
      },
      {
        model: "fast",
        canonical: "fast-v1",
        intelligence: 30,
        tokensPerSecond: 200,
        observedAt: date,
      },
    ],
  };
}
test("portfolio keeps cost, quality, speed and included-plan alternatives without invented scores", () => {
  const p = shortlist(setup());
  assert.equal(p.candidates.length, 5);
  for (const id of ["cheap", "smart", "fast", "included"])
    assert(p.candidates.some((c) => c.id === id));
  assert.equal(p.candidates.find((c) => c.id === "included").estimatedRequestUsd, null);
  assert.equal(p.candidates.find((c) => c.id === "cheap").intelligence, null);
});
test("availability, key removal, stale inventory and catalog, and compatibility fail closed", () => {
  for (const mutate of [
    (a) => (a.inventory.clis[0].signedIn = null),
    (a) => (a.inventory.checkedAt = new Date(now - 60001).toISOString()),
    (a) => (a.catalog.fetchedAt = new Date(now - DAY).toISOString()),
    (a) => a.inventory.routes.forEach((r) => (r.compatibility = "unknown")),
  ]) {
    const a = setup();
    mutate(a);
    assert.equal(shortlist(a).candidates.length, 0);
  }
  const a = setup();
  a.inventory.keyProviders = [];
  assert.deepEqual(
    shortlist(a).candidates.map((c) => c.id),
    ["included"],
  );
});
test("new versions do not inherit old intelligence or sparse performance guarantees", () => {
  const a = setup();
  a.catalog.models[1].canonical = "smart-v2";
  a.inventory.routes[1].canonical = "smart-v2";
  a.history = [
    {
      model: "cheap",
      canonical: "cheap-v1",
      type: "change",
      harness: "claude",
      provider: "openrouter",
      observedAt: date,
      attempts: 3,
      accepted: 2,
      costUsd: 0.06,
      totalSeconds: 30,
    },
  ];
  const p = shortlist(a);
  assert.equal(p.candidates.find((c) => c.id === "smart").intelligence, null);
  assert.equal(p.candidates.find((c) => c.id === "cheap").proven, false);
  assert.equal(p.candidates.find((c) => c.id === "cheap").observedCostPerAcceptedUsd, 0.03);
  assert.equal(p.slots.fastestObserved, undefined);
});
test("decision cannot select outside classified portfolio and unknown cost stops routing", async () => {
  const sdk = (answer) => ({ alpha: { decisions: { create: async () => answer } } });
  const portfolios = [shortlist(setup())];
  const answer = {
    answers: { type: { choice: "plan" }, route: { choice: "cheap" } },
    usage: { cost: 0.00001 },
  };
  assert.equal((await decide({ sdk: sdk(answer), task: "x", portfolios })).route, "abstain");
  answer.answers.type.choice = "change";
  assert.equal((await decide({ sdk: sdk(answer), task: "x", portfolios })).model, "cheap");
  answer.usage.cost = null;
  await assert.rejects(decide({ sdk: sdk(answer), task: "x", portfolios }), /cost unknown/);
});
test("daily refresh caches successes and retains last good data on failed refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-")),
    path = join(dir, "catalog.json");
  try {
    const old = { fetchedAt: new Date(now - 2 * DAY).toISOString(), models: [{ id: "old" }] };
    await writeFile(path, JSON.stringify(old));
    const bad = async () => {
      throw Error("offline");
    };
    const retained = await refresh(path, { now, fetcher: bad });
    assert.equal(retained.fetchedAt, old.fetchedAt);
    assert.deepEqual(JSON.parse(await readFile(path)), old);
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({
          data: [{ id: "new", pricing: { prompt: "0.001", completion: "0.002" } }],
        }),
      };
    };
    assert.equal((await refresh(path, { now, fetcher })).models[0].id, "new");
    await refresh(path, { now: now + 1000, fetcher });
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("external intelligence requires explicit version and effort joins", () => {
  const body = {
    intelligence_index_version: 5,
    data: [{ slug: "x", evaluations: { artificial_analysis_intelligence_index: 50 } }],
  };
  assert.deepEqual(importAnalysis(body, {}), []);
  assert.deepEqual(importAnalysis(body, { x: { model: "x", canonical: "x-v1" } }), []);
  const [e] = importAnalysis(
    body,
    { x: { model: "x", canonical: "x-v1", configuration: "max effort" } },
    date,
  );
  assert.equal(e.intelligence, 50);
  assert.equal(e.scores.change, null);
});
test("OpenRouter benchmark joins preserve source date, missing values and exact versions", () => {
  const a = setup(),
    body = {
      meta: { as_of: date, version: "v1", citation: "AA via OpenRouter" },
      data: [
        {
          source: "artificial-analysis",
          model_permaslug: "smart-v1",
          display_name: "Smart (max)",
          intelligence_index: 45,
          coding_index: null,
        },
      ],
    };
  const [e] = importOpenRouterBenchmarks(body, a.catalog);
  assert.equal(e.model, "smart");
  assert.equal(e.observedAt, date);
  assert.equal(e.scores.change, null);
  body.data[0].model_permaslug = "smart-v2";
  assert.deepEqual(importOpenRouterBenchmarks(body, a.catalog), []);
});
