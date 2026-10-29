import { test } from "node:test";
import assert from "node:assert/strict";
import { profileSummary } from "../compare-models.mjs";
test("failed attempts remain in accepted-task cost; unmeasured is not free", () => {
  const rows = profileSummary({
    profiles: [{ id: "a" }, { id: "b" }, { id: "unmeasured" }],
    runs: [
      { profile: "a", grade: { pass: true }, error: null, costUsd: 0.1, totalMs: 5 },
      { profile: "a", grade: { pass: false }, error: null, costUsd: 0.2, totalMs: 7 },
      { profile: "b", grade: { pass: false }, error: "timeout", costUsd: null, totalMs: 9 },
    ],
  });
  assert.equal(rows[0].passed, 1);
  assert.ok(Math.abs(rows[0].costPerAcceptedUsd - 0.3) < 1e-12);
  assert.equal(rows[0].totalMs, 12);
  assert.equal(rows[1].costUsd, null);
  assert.equal(rows[1].costPerAcceptedUsd, null);
  assert.equal(rows[2].costUsd, null);
  assert.equal(rows[2].attempts, 0);
});
