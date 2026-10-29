import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionCases } from "../decision-cases.mjs";
import { scoreAnswers } from "../decisions.mjs";
test("labels are balanced across development and held-out sets", () => {
  assert.equal(decisionCases.length, 24);
  for (const split of ["development", "held-out"])
    for (const kind of ["lookup", "change", "plan"])
      assert.equal(
        decisionCases.filter((c) => c.split === split && c.expected.kind === kind).length,
        4,
      );
});
test("typed decisions reject missing and malformed answers instead of guessing defaults", () => {
  assert.deepEqual(scoreAnswers({}, { kind: "lookup", route: "efficient" }), {
    valid: false,
    pass: false,
  });
  const answer = {
    kind: { type: "choice", choice: "lookup" },
    route: { type: "choice", choice: "efficient" },
  };
  assert.equal(scoreAnswers(answer, { kind: "lookup", route: "efficient" }).pass, true);
  assert.equal(scoreAnswers(answer, { kind: "change", route: "efficient" }).pass, false);
});
