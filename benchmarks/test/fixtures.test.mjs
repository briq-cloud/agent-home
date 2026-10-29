import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  smokeTasks as tasks,
  prepare,
  grade,
  contextPack,
  mockAnswers,
  mockFixes,
} from "../fixtures.mjs";
for (const task of tasks)
  test(`acceptance rejects broken ${task.id} and accepts its fix`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-grader-"));
    try {
      await prepare(dir, task);
      assert.equal((await grade(dir, task, "wrong")).pass, false);
      if (mockFixes[task.id]) {
        const [f, s] = mockFixes[task.id];
        await writeFile(join(dir, f), s);
      }
      assert.equal((await grade(dir, task, mockAnswers[task.id] ?? "fixed")).pass, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
test("stale pack is rejected and replaced with current source, not its old answer", async () => {
  const task = tasks.find((t) => t.id === "source-refresh"),
    dir = await mkdtemp(join(tmpdir(), "bench-pack-"));
  try {
    await prepare(dir, task);
    const pack = await contextPack(dir, task);
    assert.equal(pack.cacheState, "rejected-stale");
    assert.match(pack.text, /192 MB/);
    assert.doesNotMatch(pack.text, /64 MB/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
