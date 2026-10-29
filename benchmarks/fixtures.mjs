import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const retry = `export async function retry(fn, maxAttempts = 3) {
  for (let i = 0; i <= maxAttempts; i++) {
    try { return await fn(); } catch (e) { if (i === maxAttempts) throw e; }
  }
}\n`;
export const tasks = [
  {
    id: "lookup-config",
    prompt:
      "Find the current timeout setting, its default and its unit. Return JSON with setting, default, unit, source. Do not edit files.",
    files: {
      "docs/config.md":
        "# Current configuration\nrequestTimeoutMs defaults to 2500. Its unit is milliseconds.\n",
      "docs/obsolete.md":
        "# Obsolete, version 1 only\nrequestTimeoutSeconds defaults to 30 seconds.\n",
    },
    refs: ["docs/config.md"],
    check: async (_dir, answer) => {
      const a = jsonAnswer(answer);
      assert.equal(a.setting, "requestTimeoutMs");
      assert.equal(a.default, 2500);
      assert.equal(a.unit, "milliseconds");
      assert.match(a.source, /(?:^|\/)docs\/config\.md(?:$|[ (#:])/);
    },
  },
  {
    id: "trace-config",
    prompt:
      "Which configuration property supplies the delay to waitRetry? Return JSON with setting (the property name, not its value or function name) and sources (relative file paths defining and passing the property). Do not edit files.",
    files: {
      "src/config.mjs": "export const config = { retryDelayMs: 125 };\n",
      "src/app.mjs":
        "import {config} from './config.mjs';\nimport {waitRetry} from './retry.mjs';\nexport const start = () => waitRetry(config.retryDelayMs);\n",
      "src/retry.mjs":
        "export const waitRetry = delay => new Promise(r => setTimeout(r, delay));\n",
    },
    refs: ["src/config.mjs", "src/app.mjs", "src/retry.mjs"],
    check: async (dir, answer) => {
      const a = jsonAnswer(answer);
      a.sources = a.sources.map((s) => (s.startsWith(dir + "/") ? s.slice(dir.length + 1) : s));
      assert.equal(a.setting, "retryDelayMs");
      for (const f of ["src/config.mjs", "src/app.mjs"]) assert.ok(a.sources.includes(f));
    },
  },
  {
    id: "empty-input",
    prompt:
      "Fix src/sum.mjs so sum([]) returns zero. Preserve non-empty behavior. Edit the file; do not only describe the fix.",
    files: {
      "src/sum.mjs": "export const sum = values => values.reduce((a, b) => a + b);\n",
      "docs/contract.md":
        "sum accepts an array of numbers and returns their sum. The empty sum is zero.\n",
    },
    refs: ["src/sum.mjs", "docs/contract.md"],
    check: async (dir) => {
      const { sum } = await load(dir, "src/sum.mjs");
      for (const [v, n] of [
        [[], 0],
        [[3], 3],
        [[-4, 2], -2],
        [[1, 2, 3], 6],
      ])
        assert.equal(sum(v), n);
    },
  },
  {
    id: "retry-boundary",
    prompt:
      "Fix src/retry.mjs. maxAttempts includes the initial attempt and is always a positive integer. Preserve immediate success and rethrow the last error.",
    files: {
      "src/retry.mjs": retry,
      "docs/retries.md":
        "retry(fn, maxAttempts) makes at most maxAttempts calls. maxAttempts includes the initial call.\n",
    },
    refs: ["src/retry.mjs", "docs/retries.md"],
    check: async (dir) => {
      const { retry } = await load(dir, "src/retry.mjs");
      for (const n of [1, 2, 4]) {
        let count = 0;
        const e = new Error("last");
        await assert.rejects(
          retry(async () => {
            count++;
            throw e;
          }, n),
          (x) => x === e,
        );
        assert.equal(count, n);
      }
      let count = 0;
      assert.equal(
        await retry(async () => {
          count++;
          return 7;
        }, 3),
        7,
      );
      assert.equal(count, 1);
      let attempts = 0;
      assert.equal(
        await retry(async () => {
          if (++attempts === 1) throw Error();
          return 9;
        }, 2),
        9,
      );
    },
  },
  {
    id: "rename-option",
    prompt:
      "Update readOptions in src/options.mjs to support timeoutMs. Preserve the legacy timeout alias. When both are present, timeoutMs takes precedence, including zero. Keep the default.",
    files: {
      "src/options.mjs":
        "export const readOptions = input => ({ timeoutMs: input.timeout ?? 1000 });\n",
      "docs/options.md":
        "timeoutMs is the new option. timeout is its legacy alias. New takes precedence. Default: 1000. Zero is valid.\n",
    },
    refs: ["src/options.mjs", "docs/options.md"],
    check: async (dir) => {
      const { readOptions } = await load(dir, "src/options.mjs");
      for (const [v, n] of [
        [{}, 1000],
        [{ timeout: 20 }, 20],
        [{ timeoutMs: 30 }, 30],
        [{ timeout: 20, timeoutMs: 30 }, 30],
        [{ timeout: 20, timeoutMs: 0 }, 0],
      ])
        assert.equal(readOptions(v).timeoutMs, n);
    },
  },
  {
    id: "source-refresh",
    prompt:
      "Find the current storage limit. Return JSON with limitMb and source. Use current project facts. Do not edit files.",
    files: {
      REVISION: "v2\n",
      "docs/storage.md": "Current storage limit: 192 MB.\n",
      "cache/context.json": JSON.stringify({
        revision: "v1",
        refs: ["docs/storage.md"],
        text: "Storage limit: 64 MB.",
      }),
    },
    refs: ["docs/storage.md"],
    check: async (_dir, answer) => {
      const a = jsonAnswer(answer);
      assert.equal(a.limitMb, 192);
      assert.match(a.source, /(?:^|\/)docs\/storage\.md(?:$|[ (#:])/);
    },
  },
];
function jsonAnswer(text) {
  const match = text.match(/\{[\s\S]*\}/);
  assert.ok(match, "JSON answer missing");
  return JSON.parse(match[0]);
}
async function load(dir, file) {
  return import(pathToFileURL(join(dir, file)).href + "?check=" + randomUUID());
}
export async function prepare(dir, task) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [file, text] of Object.entries(task.files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), text);
  }
  await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module", private: true }));
}
export async function contextPack(dir, task) {
  // Curated retrieval upper bound: refs are fixture metadata, not a production search algorithm.
  let cacheState = "absent";
  try {
    const old = JSON.parse(await readFile(join(dir, "cache/context.json"), "utf8"));
    cacheState =
      old.revision === (await readFile(join(dir, "REVISION"), "utf8")).trim()
        ? "current"
        : "rejected-stale";
  } catch {}
  const sections = await Promise.all(
    task.refs.map(async (f) => `Source: ${f}\n${await readFile(join(dir, f), "utf8")}`),
  );
  return { text: sections.join("\n"), cacheState, selection: "manifest-oracle-retrieval" };
}
export async function grade(dir, task, answer) {
  try {
    await task.check(dir, answer);
    if (["lookup-config", "trace-config", "source-refresh"].includes(task.id))
      for (const [f, text] of Object.entries(task.files))
        assert.equal(await readFile(join(dir, f), "utf8"), text);
    return { pass: true };
  } catch {
    return { pass: false, reason: "acceptance-check-failed" };
  }
}
export const mockAnswers = {
  "lookup-config": JSON.stringify({
    setting: "requestTimeoutMs",
    default: 2500,
    unit: "milliseconds",
    source: "docs/config.md",
  }),
  "trace-config": JSON.stringify({
    setting: "retryDelayMs",
    sources: ["src/config.mjs", "src/app.mjs"],
  }),
  "source-refresh": JSON.stringify({ limitMb: 192, source: "docs/storage.md" }),
};
export const mockFixes = {
  "empty-input": ["src/sum.mjs", "export const sum = values => values.reduce((a,b)=>a+b,0);\n"],
  "retry-boundary": [
    "src/retry.mjs",
    retry
      .replace("i <= maxAttempts", "i < maxAttempts")
      .replace("i === maxAttempts", "i === maxAttempts - 1"),
  ],
  "rename-option": [
    "src/options.mjs",
    "export const readOptions = input => ({timeoutMs: input.timeoutMs ?? input.timeout ?? 1000});\n",
  ],
};
