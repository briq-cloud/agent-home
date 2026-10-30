import assert from "node:assert/strict";
import { test } from "node:test";
import { buildManagedReport, managedReportHtml } from "../managed/report.mjs";

test("public managed report keeps costs and canonical facts without exposing private inputs", () => {
  const trial = {
    id: "case-baseline",
    fixtureId: "case",
    arm: "baseline",
    phase: "complete",
    taskStatus: "succeeded",
    grade: { pass: true },
    featuresExercised: true,
    graderUnchanged: true,
    costUsd: 0.02,
    totalMs: 1200,
    prompt: "PRIVATE-PROMPT",
    output: "PRIVATE-OUTPUT",
    generations: [
      {
        kind: "execution",
        generationId: "PRIVATE-GENERATION",
        model: "vendor/model",
        actualModel: "vendor/model-20261007",
        provider: "vendor",
        costUsd: 0.02,
        authorization: "PRIVATE-TOKEN",
      },
    ],
  };
  const result = {
    totalCostUsd: 0.02,
    arms: [{ id: "baseline" }],
    profiles: [{ model: "vendor/model", canonical: "vendor/model-20261007" }],
    sourceHashes: { "entry.mjs": "a".repeat(64), token: "PRIVATE-KEY" },
    privateConfig: "PRIVATE-CONFIG",
    trials: [trial],
  };
  const report = buildManagedReport(
    [
      {
        id: "measured",
        role: "original-corrected",
        result,
        provenance: { resultsSha256: "b".repeat(64) },
      },
    ],
    "2026-10-30T00:00:00Z",
  );
  assert.equal(report.accounting.settledManagedCostUsd, 0.02);
  assert.equal(report.accounting.acceptedCorrectedTasks, 1);
  assert.equal(report.experiments[0].trials[0].modelsPinned, true);
  assert.equal(report.experiments[0].trials[0].comparisonEligible, true);
  assert.ok(!JSON.stringify(report).includes("PRIVATE-"));
  assert.ok(!managedReportHtml(report).includes("PRIVATE-"));
  for (const role of ["functional", "invalid-contract"]) {
    assert.equal(
      buildManagedReport([{ id: role, role, result }]).experiments[0].trials[0].comparisonEligible,
      false,
    );
  }
  assert.equal(
    buildManagedReport([{ id: "functional", role: "functional", result }]).experiments[0].trials[0]
      .featuresExercised,
    null,
  );
  trial.generations[0].actualModel = "vendor/model";
  assert.equal(
    buildManagedReport([{ id: "alias", role: "original-corrected", result }]).experiments[0]
      .trials[0].modelsPinned,
    false,
  );
});

test("external file pass never upgrades missing task observations or invalid contracts", () => {
  const inconclusive = {
    id: "memory",
    fixtureId: "case",
    arm: "memory-only",
    phase: "complete",
    grade: { pass: true },
    error: "PRIVATE-ERROR",
    costUsd: 0.03,
    featuresExercised: false,
  };
  const result = {
    totalCostUsd: 0.03,
    arms: [{ id: "memory-only", memory: true }],
    trials: [inconclusive],
  };
  const report = buildManagedReport([
    { id: "partial", role: "original-corrected", result },
    { id: "invalid", role: "invalid-contract", result },
  ]);
  assert.equal(report.accounting.settledManagedCostUsd, 0.06);
  assert.equal(report.accounting.inconclusiveCorrectedCostUsd, 0.03);
  assert.equal(report.accounting.invalidContractCostUsd, 0.03);
  assert.equal(report.accounting.acceptedCorrectedTasks, 0);
  assert.equal(report.experiments[0].trials[0].featuresExercised, null);
  assert.equal(report.experiments[0].trials[0].classification, "inconclusive");
  assert.equal(report.experiments[1].trials[0].classification, "invalid-contract");
  assert.ok(!JSON.stringify(report).includes("PRIVATE-ERROR"));
  result.totalCostUsd = null;
  assert.equal(
    buildManagedReport([{ id: "unknown", role: "remaining-revised", result }]).accounting
      .settledManagedCostUsd,
    null,
  );
});
