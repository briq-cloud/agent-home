import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFunctionalProbe, refreshFunctionalResult } from "../managed/functional.mjs";

test("forced delegation functional check traverses production MCP and exact root/child profile ledgers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "managed-functional-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runFunctionalProbe({ mode: "mock", root });
  const trial = result.trials[0];
  assert.equal(trial.functionalPass, true);
  assert.equal(trial.grade.pass, true);
  assert.equal(result.totalCostUsd, 0);
  assert.equal(trial.taskTree.length, 2);
  assert.equal(trial.taskTree.find((task) => task.parentId).actualRoute.cli, "bench-deepseek");
  assert.equal(trial.generations.length, 2);
  assert.equal(trial.functionalProof.distinctProviders, true);
  await assert.rejects(runFunctionalProbe({ mode: "mock", root }), /never repeat/);
  const unmeasured = structuredClone(result);
  unmeasured.trials[0].generations.find(
    (record) => record.profile === "bench-deepseek",
  ).actualModel = "deepseek/unpinned";
  assert.equal(refreshFunctionalResult(unmeasured).trials[0].functionalPass, false);
  assert.equal(unmeasured.trials[0].grade.pass, true);
});
