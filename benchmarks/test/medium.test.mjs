import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mediumTasks } from "../medium.mjs";
import { prepare, grade, suites } from "../fixtures.mjs";
for (const task of mediumTasks)
  for (const fixed of [false, true])
    test(`${task.id}: ${fixed ? "reference passes" : "broken project fails"}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "medium-fixture-"));
      try {
        await prepare(dir, task);
        if (fixed)
          for (const [f, s] of Object.entries(task.mockFiles)) await writeFile(join(dir, f), s);
        const result = await grade(dir, task, "Applied changes");
        assert.equal(result.pass, fixed, JSON.stringify(result));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
test("medium projects have separate graders and current context references", () => {
  assert.equal(suites.medium.tasks.length, 3);
  for (const task of mediumTasks) {
    assert.ok(Object.keys(task.files).length >= 6);
    assert.ok(task.refs.every((f) => f in task.files));
    assert.ok(!task.refs.some((f) => f.includes("reference") || f.includes("grader")));
  }
});
